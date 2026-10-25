#!/usr/bin/env node
/**
 * 测试入口（跨平台 + 跨 Node 版本的唯一可靠形式）。
 *
 * 为什么不直接写 `node --test lib/test/` 或 `node --test "lib/test/*.test.js"`：
 *   · **目录参数**在 Node 20/22 上行为不一致 —— CI 上实测报
 *     `Cannot find module '…/lib/test'`（它把目录当成入口脚本 ✗）；
 *   · **glob 参数**是 Node **21** 才支持的 ✗，而本仓库 `engines` 声明 `>=20`，
 *     矩阵里就有 node 20 → 引用 glob 会让 20 那一格红 ✗；
 *   · **不加参数**让测试运行器自动发现也不行 ✗：它会把 `test/*.test.ts`（TypeScript 源文件）
 *     也当测试跑 → 实测多出 26 个"测试"、13 个失败 ✗。
 * 因此这里自己列出**编译产物**里的测试文件，显式交给 `node --test`（v18+ 都支持多文件参数 ✓）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { hostname } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, 'lib', 'test')
const pattern = /\.test\.js$/u

/* ————————————————————————————————————————————————————————————————————————————————
 * **`TASK-227` / `DEF-219`：两件让「并发跑全量」不再互相踩的事**
 *
 * 病灶（今天真实发生，作者身份可查）：
 *   `2a7efcf  author=t <t@t>  message=init` —— 夹具 `test/m183|m185|m186|m187|m195` 在
 *   `node_modules/.sdo-test/<mNNN>/proj` 里跑 `git add -A && git commit`，而那个路径**在真实仓库
 *   工作树之内**。两个会话并发跑全量时，一方的 `rmSync`+`mkdirSync` 把另一方的夹具目录重建成空目录
 *   （`git init` 还没走到），另一方此时 `git add -A` ⇒ **git 向上发现最近的 `.git` 就是真实仓库**
 *   ⇒ 整树 staged 并提交到 `main`，身份用的是夹具写死的 `t <t@t>`。
 *
 * 两条机制，都在**这里**落（一处口径，覆盖所有夹具，含以后新加的）：
 *   ① **`GIT_CEILING_DIRECTORIES`**：把夹具根设成天花板上限 ⇒ 夹具内的 git **物理上不可能**
 *      向上爬到真实仓库（在无 `.git` 的目录里跑 `git add` 会**失败**，而不是找到仓库）。
 *   ② **独占锁**：同一个 `node_modules/.sdo-test` 同一时刻只允许**一个**全量在跑；第二个要么等，
 *      要么带着可读理由退出（`--wait` 可改为排队）。锁带 pid + host + 时间，持有者死了可抢占。
 * ———————————————————————————————————————————————————————————————————————————————— */

/**
 * 夹具根（所有测试共用的临时目录；`GIT_CEILING_DIRECTORIES` 的取值就是它）。
 *
 * `--fixture-root=` 可覆盖：**守卫自己要跑锁探针**时不能跟"正在跑全量的父进程"抢同一把锁
 * （那就是自己锁自己），所以探针用一个夹具内的私有锁目录。
 */
const argOf = (name) => {
  const hit = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 3)
}
const FIXTURE_ROOT = resolve(argOf('fixture-root') ?? join(root, 'node_modules', '.sdo-test'))

/** 独占锁文件（不是测试夹具，是**运行器之间**的互斥点）；`--lock-file=` 可覆盖（同上）。 */
const LOCK_FILE = resolve(argOf('lock-file') ?? join(FIXTURE_ROOT, '.run-tests.lock'))

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readLock() {
  try {
    const raw = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
    return { pid: Number(raw.pid), host: String(raw.host ?? ''), at: String(raw.at ?? '') }
  } catch {
    return undefined
  }
}

/**
 * 申请独占（`--wait` 时排队；否则立刻带可读理由退出）。
 *
 * 为什么**串行化**而不是给夹具目录加 per-session 后缀：后缀要改**每一个**测试文件里写死的
 * `../../node_modules/.sdo-test/<mNNN>` 路径（几百处，且不在本卡写范围），而"同一时刻只跑一个全量"
 * 是这些夹具本来就隐含的前提 —— 本卡把它从**纪律**变成**机制**。
 */
function acquireLock({ wait, timeoutMs }) {
  mkdirSync(dirname(LOCK_FILE), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const existing = readLock()
    if (existing === undefined || !pidAlive(existing.pid) || existing.host !== hostname()) {
      writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }))
      // 抢锁后再读一次：两个进程同时写时，后写的赢；只有"读到自己是持有者"才算抢到
      const check = readLock()
      if (check !== undefined && check.pid === process.pid) return { ok: true }
    }
    if (!wait || Date.now() > deadline) {
      return {
        ok: false,
        reason: existing === undefined
          ? 'another run holds the fixture lock'
          : `another full run is in progress (pid=${String(existing.pid)} on ${existing.host} since ${existing.at})`,
      }
    }
    // 排队：忙等一小会儿（全量只有几分钟，且这是**开发期**的互斥，不需要精确调度）
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'ignore' })
  }
}

function releaseLock() {
  const held = readLock()
  if (held !== undefined && held.pid === process.pid) {
    try {
      rmSync(LOCK_FILE, { force: true })
    } catch {
      /* 释放失败不阻断：下一次申请会按"持有者死了"抢占 */
    }
  }
}

const args = new Set(process.argv.slice(2))
if (args.has('--lock-probe')) {
  // 只探测能不能抢到锁（给守卫用：模拟"另一个会话正在跑全量"）
  const got = acquireLock({ wait: false, timeoutMs: 0 })
  console.log(got.ok ? 'lock: acquired' : `lock: busy (${got.reason})`)
  if (got.ok) releaseLock()
  process.exit(got.ok ? 0 : 3)
}

const lock = acquireLock({ wait: args.has('--wait'), timeoutMs: 15 * 60 * 1000 })
if (!lock.ok) {
  console.error(`[run-tests] ✗ 另一个会话正在跑全量（${lock.reason}）。`)
  console.error('[run-tests]   夹具目录是共用的（node_modules/.sdo-test），并发跑会互删目录并可能把真实仓库提交掉（DEF-219）。')
  console.error('[run-tests]   等它跑完，或加 --wait 排队。')
  process.exit(4)
}

let entries = []
try {
  entries = readdirSync(testDir).filter((name) => pattern.test(name)).sort()
} catch {
  console.error(`[run-tests] ✗ 找不到 ${testDir}：先跑 npm run build`)
  process.exit(1)
}
if (entries.length === 0) {
  console.error(`[run-tests] ✗ ${testDir} 里没有 *.test.js：先跑 npm run build`)
  process.exit(1)
}

const files = entries.map((name) => join('lib', 'test', name))
console.log(`[run-tests] node --test ${files.length} 个文件（${entries[0]} … ${entries[entries.length - 1]}）`)
// **`GIT_CEILING_DIRECTORIES`**：夹具内的 git 不许向上爬到真实仓库（`DEF-219` 的根因就在这一步）
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    GIT_CEILING_DIRECTORIES: FIXTURE_ROOT,
    // 让夹具内的 git 连"全局/系统配置"都读不到：身份与行尾等行为只由夹具自己决定
    GIT_CONFIG_NOSYSTEM: '1',
  },
})
releaseLock()
process.exit(result.status ?? 1)
