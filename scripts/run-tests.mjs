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
 *
 * **新增守卫格的接线点就是这里**（`TASK-263` 记一笔）：新守卫 = 新的 `test/mNNN.test.ts`，
 * 编译成 `lib/test/mNNN.test.js` 后**被本脚本按目录自动发现**，运行器不需要为它加一行；
 * 本文件只负责"跑哪些文件"，**不替**守卫判绿（`M145-02`：子进程输出原样透传，不许自拼"全绿"）。
 * 两个随包脚本的口径差别也写在这里，免得下次又猜：
 *   · `scripts/check-number-provenance.mjs`（数字必须带口径）的**载体是项目数据**
 *     （`.sdo/reviews/verified.yml`）⇒ 载体缺失时它打印 `carrier: absent` 并 exit 0，
 *     守卫格跟着走"没有台账就不判红"那一支（插件包被单独 checkout 时全量照样可跑）；
 *   · `scripts/refresh-prose-gap.mjs` 有 `--write`，**全量里只许跑检查模式**（写盘会改 `test/m189.test.ts`）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
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

/**
 * **`--only=<名字>`：只跑一个（或几个，逗号分隔）文件** —— 给守卫用（`M266-09`）。
 *
 * 为什么这个开关必须有：收尾那道「真账跳过读数」如果只拿**源码文本**去守（"脚本里出现过
 * `describeRealLedgerSkip` 这个词"），正是本仓反复判红的「锚在构建处、不在使用处」假绿 ——
 * 已经见 `REV-097` #1 与 `m80`。要让守卫**真跑一次**，就必须能跑子集（跑全量要几分钟）。
 * 缺省（不带这个开关）行为**一字不变**：还是整目录。
 *
 * 匹配面：文件名（`m242.test.js`）或去掉扩展名的卡号（`m242`），只认 `lib/test/` 下真实存在的条目。
 */
const only = argOf('only')
const selected = only === undefined
  ? entries
  : entries.filter((name) => only.split(',').map((item) => item.trim()).includes(name)
    || only.split(',').map((item) => item.trim()).includes(name.replace(pattern, '')))
if (selected.length === 0) {
  console.error(`[run-tests] ✗ --only=${String(only)} 没有匹配到任何测试文件（可选：${entries.slice(0, 5).join(' / ')} …）`)
  process.exit(1)
}

const files = selected.map((name) => join('lib', 'test', name))
const scope = only === undefined ? '' : `（--only=${String(only)}）`
console.log(`[run-tests] node --test ${files.length} 个文件${scope}（${selected[0]} … ${selected[selected.length - 1]}）`)
/* ————————————————————————————————————————————————————————————————————————————————
 * **`TASK-266`：把「真账守卫跳过了几条」这道读数接到收尾（`DEF-153` / `TASK-227` 的落点）**
 *
 * `test/support/real-ledger.ts` 里计数器与三种状态的可读串早就写好了，但 `realLedgerSkipCount()`
 * 此前**全仓零调用** ⇒ 干净检出里"全绿"到底是"跑过了"还是"一条都没跑"，读者仍然分不清（CI 上这两件事
 * 的含义天差地别）。这里把最后一米接上，三条都不许省：
 *   · **stdio 仍然继承**（`M145-03` / `TC-140` 的口径：跳过条数与逐条理由必须人眼可见；`M145-02`：
 *     运行器不许自拼"全绿"）。**不**把 stdout 改成管道再转写 —— 那既多一层失真，也把"看得见的进度"押后；
 *   · 计数走**第二份 reporter**：同一轮再挂一个 `tap` 写到夹具区的临时文件，只为读 `# skipped N`
 *     这行机器可读的汇总（人看的那份一字不变）。两份 reporter 是 Node 自带能力，不是这里发明的；
 *     这两个标志必须排在**位置参数（测试文件）之前**：`node` 把 `--test` 之后的位置参数当文件列表，
 *     写在文件后面的 reporter 标志会被**静默忽略**（现盘实测，见 `spawn` 处注释）—— 那会让整道读数空转；
 *   · 状态串用**产品自己的**纯函数 `describeRealLedgerSkip`（不在这里另写一份口径 —— `DEF-044`：
 *     同一概念两处判据必然分叉）。
 * ———————————————————————————————————————————————————————————————————————————————— */

/**
 * 一行收尾读数。**读不到就说读不到，绝不折成零**（`REV-134` 必修；`REV-136` 在台账上现形过一次）。
 *
 * `skipped === undefined` ⇒ 这一轮**没拿到** TAP 汇总行（报告没建起来，或 reporter 没生效）。旧口径
 * 在这条分支上返回 `0`，于是真账上出现过 `ℹ skipped 1` 与 `… 0 guard(s) skipped this run` 并排的假读数；
 * **零必须是读出来的零**。两支都落进同一句 `reading unavailable`，只是理由不同。
 */
async function realLedgerReading(skipped) {
  const tail = `runner-reported skipped: ${skipped === undefined ? 'unknown' : String(skipped)}`
  if (skipped === undefined) {
    // 落点本身也印出来：只写"读不到"会把"哪份报告没读到"留给读者猜
    return `[real-ledger] reading unavailable (no "# skipped N" line in the TAP report: ${TAP_REPORT}); ${tail}`
  }
  try {
    const helper = await import(new URL('../lib/test/support/real-ledger.js', import.meta.url).href)
    return helper.describeRealLedgerSkip(skipped, helper.hasRealLedger())
  } catch (error) {
    return `[real-ledger] reading unavailable (${String(error?.message ?? error).slice(0, 120)}); ${tail}`
  }
}

/**
 * 从 TAP 报告里取跳过条数：只认**汇总行**（顶格 `# skipped N`，兼容 `ℹ skipped N` 形状）。
 *
 * **取不到返回 `undefined`**（不是 `0`）—— 这就是上面那句"零必须是读出来的零"的落点。顶格锚定是必要的：
 * TAP 里逐条的跳过理由以缩进注释出现（`# SKIP reason`），不该被当成计数；取最大值是防"同一份报告里
 * 出现多份汇总"时取小值把真跳过数压低。
 */
function skippedFrom(output) {
  const matches = [...String(output).matchAll(/^(?:#|ℹ)\s*skipped\s+(\d+)\s*$/gmu)]
  if (matches.length === 0) return undefined
  return Math.max(...matches.map((match) => Number(match[1])))
}

/** 机器可读那份 reporter 的落点（夹具区内 + 跑前清掉，免得读到上一轮的读数）。 */
const TAP_REPORT = join(FIXTURE_ROOT, '.run-tests-report.tap')
rmSync(TAP_REPORT, { force: true })

const child = spawn(process.execPath, [
  // ⚠️ **顺序是判据，不是风格**：reporter 标志必须排在位置参数（测试文件）**之前**。`node` 把 `--test`
  // 之后的位置参数收进文件列表，而**写在文件后面**的 `--test-reporter*` 会被**静默忽略** ⇒ TAP 落点
  // 根本不生成 ⇒ 收尾读数退回"读不到"（旧口径则退回假的 `0`）。现盘实测对照（`REV-134` 必修）：
  //   · `node --test-reporter=tap --test-reporter-destination=X --test a.test.js` ⇒ X 生成，真 TAP；
  //   · `node --test a.test.js --test-reporter=tap --test-reporter-destination=X` ⇒ 仍打 spec，X 不生成。
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=tap', `--test-reporter-destination=${TAP_REPORT}`,
  '--test', ...files,
], {
  cwd: root,
  // **继承**下来：跳过条数与逐条理由照旧人眼可见（`M145-03`）
  stdio: 'inherit',
  env: {
    ...process.env,
    // **`GIT_CEILING_DIRECTORIES`**：夹具内的 git 不许向上爬到真实仓库（`DEF-219` 的根因就在这一步）
    GIT_CEILING_DIRECTORIES: FIXTURE_ROOT,
    // 让夹具内的 git 连"全局/系统配置"都读不到：身份与行尾等行为只由夹具自己决定
    GIT_CONFIG_NOSYSTEM: '1',
  },
})
child.on('exit', (code) => {
  releaseLock()
  let tap = ''
  try {
    tap = readFileSync(TAP_REPORT, 'utf8')
  } catch {
    tap = ''
  }
  try {
    rmSync(TAP_REPORT, { force: true })
  } catch {
    /* 删不掉不影响读数 */
  }
  realLedgerReading(skippedFrom(tap))
    .then((line) => {
      console.log(line)
      process.exit(code ?? 1)
    })
    .catch(() => process.exit(code ?? 1))
})
child.on('error', (error) => {
  releaseLock()
  console.error(`[run-tests] ✗ 起不了子进程：${String(error?.message ?? error)}`)
  process.exit(1)
})
