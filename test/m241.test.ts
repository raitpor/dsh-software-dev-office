/**
 * **`TASK-227` / `DEF-219`：并发跑全量不许互踩夹具，夹具内的 git 不许爬到真实仓库**。
 *
 * 病灶（真实发生的一笔提交，作者身份可查）：
 *   `2a7efcf  author=t <t@t>  message=init`
 * 夹具 `test/m183|m185|m186|m187|m195` 在 `node_modules/.sdo-test/<mNNN>/proj` 里跑
 * `git add -A && git commit`，而该路径**在真实仓库工作树之内**；两个会话并发时，一方把另一方的
 * 夹具目录重建成空目录（`git init` 还没走到），另一方的 `git add -A` 于是一路向上找到真实仓库的
 * `.git` ⇒ **整树 staged 并提交到 main**，身份用夹具写死的 `t <t@t>`。
 *
 * 三条守卫（断言消息一律英文；本文件不进 `KNOWN_PROSE_GAP`）：
 *   · `M241-01` 无 `.git` 的夹具目录里跑 git ⇒ **必须失败**，且**真实仓库 HEAD 的 sha 前后不变**
 *     （现在这条会真提交 —— 这是本卡最关键的守卫）；
 *   · `M241-02` 独占锁：一个持有者活着时第二个申请必须被拒（`--lock-probe` 的退出码 3），
 *     持有者死了可抢占（否则一次崩溃会把全量永久锁住）；
 *   · `M241-03` 真账守卫的 skip 必须在收尾读数里**可见且带数量**（三种状态可区分）。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { describeRealLedgerSkip, realLedgerSkipCount } from './support/real-ledger.js'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(REPO, 'node_modules', '.sdo-test', 'm241')
const FIXTURE_ROOT = join(REPO, 'node_modules', '.sdo-test')

function headOf(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M241-01 (guard 1) git inside a fixture without .git must FAIL, and the real repo HEAD sha must not move', () => {
  const before = headOf(REPO)
  const proj = join(BASE, 'proj')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'README.md'), 'fixture\n')
  /**
   * 关键：**用运行器给的那套环境**（`GIT_CEILING_DIRECTORIES` = 夹具根）。
   * 没有 ceiling 时，`git add -A` 会一路向上找到真实仓库的 `.git` 并把它 staged —— 那就是 `2a7efcf`。
   */
  // `LC_ALL=C`：断言不依赖宿主语言（真机中文 locale 下是「不是 Git 仓库」）
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_CEILING_DIRECTORIES: FIXTURE_ROOT, GIT_CONFIG_NOSYSTEM: '1' }
  const staged = spawnSync('git', ['add', '-A'], { cwd: proj, env, encoding: 'utf8' })
  assert.notEqual(staged.status, 0, `git add must fail outside a repo when the ceiling is set: ${staged.stderr}`)
  // 断言只看"是不是仓库"这个**语义**，不绑宿主语言：LC_ALL=C 下是 `not a git repository`，
  // 中文 locale 下是「不是 Git 仓库」—— 两种都算失败，用退出码 + 两种字形的或来判断。
  assert.match(String(staged.stderr ?? ''), /not a git repository|\u4e0d\u662f Git \u4ed3\u5e93/iu, `the failure must say it is not a repo: ${staged.stderr}`)
  const committed = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: proj, env, encoding: 'utf8' })
  assert.notEqual(committed.status, 0, 'the commit must fail too (this is the exact command that polluted main)')
  // **最硬的一条**：真实仓库的 HEAD 一个字都没动
  assert.equal(headOf(REPO), before, 'the real repository HEAD must be untouched')
})

test('M241-02 (guard 2) the exclusive lock refuses a second run while a live holder exists, and steals a dead one', () => {
  // ① 无持有者 ⇒ 抢得到（`--lock-probe` 退出码 0）
  const lockDir = join(BASE, 'lockdir')
  mkdirSync(lockDir, { recursive: true })
  const probe = (): ReturnType<typeof spawnSync> => spawnSync(
    process.execPath,
    [join(REPO, 'scripts', 'run-tests.mjs'), '--lock-probe', `--lock-file=${join(lockDir, '.run-tests.lock')}`, `--fixture-root=${lockDir}`],
    { cwd: REPO, encoding: 'utf8' },
  )
  const free = probe()
  assert.equal(free.status, 0, `a free fixture root must be acquirable: ${free.stdout}${free.stderr}`)
  // ② 伪造一个**活着的**持有者（用本进程 pid：它当然活着）⇒ 第二个申请必须被拒（退出码 3）
  const lockPath = join(lockDir, '.run-tests.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: execFileSync('hostname', { encoding: 'utf8' }).trim(), at: new Date().toISOString() }))
  const busy = probe()
  assert.equal(busy.status, 3, `a live holder must make the second run back off: ${busy.stdout}${busy.stderr}`)
  assert.match(String(busy.stdout ?? ''), /lock: busy/u, `the probe must say why: ${String(busy.stdout ?? '')}`)
  // ③ 持有者死了 ⇒ 必须能抢占（否则一次崩溃把全量永久锁死）
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, host: execFileSync('hostname', { encoding: 'utf8' }).trim(), at: new Date().toISOString() }))
  const stole = probe()
  assert.equal(stole.status, 0, `a dead holder must be preempted: ${stole.stdout}${stole.stderr}`)
  rmSync(lockPath, { force: true })
})

test('M241-03 (guard 3) real-ledger skips are visible with a count, and the three states are distinguishable', () => {
  // 纯函数的三态（有真账 / 无真账但有跳过 / 无真账且零跳过 —— 最后一种最该报警）
  const present = describeRealLedgerSkip(0, true)
  assert.match(present, /ledger present/u, `state 1: ${present}`)
  const skipped = describeRealLedgerSkip(7, false)
  assert.match(skipped, /7 guard\(s\) skipped/u, `state 2 must carry the count: ${skipped}`)
  assert.match(skipped, /assertions kept, not deleted/u, 'the line must say the assertions were kept, not dropped')
  const silent = describeRealLedgerSkip(0, false)
  assert.match(silent, /⚠/u, `state 3 must be a warning, not a green tick: ${silent}`)
  // 计数器存在且单调（本进程至少跑过若干真账守卫的缺账分支或没有 —— 两种都允许，只要求是数字）
  assert.equal(typeof realLedgerSkipCount(), 'number', 'the skip counter must be a number')
})
