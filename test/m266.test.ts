/**
 * **增量 266：工作副本搬进会话工作区**（`AC-310`，`CR-010` → `CR-011`；`TASK-266`）。
 *
 * 立案的现场（真机读数，不是推测）：
 *   · 会话工作区 `…/packages/dsh-software-dev-office` 的挂载是 **`rw`**（`findmnt` 现盘）；
 *   · 修前的副本根 `…/packages/.sdo-worktrees/`（工作区的**兄弟目录**）落在 `/home` 的 **`ro`** 挂载上
 *     ⇒ 副本建得出来、文件写不进去，于是"各写各的副本"这条隔离口径等于没落地；
 *   · 真因**不是**宿主不支持隔离，而是**落点在会话工作区之外**（宿主按工作区给写权限）。
 *
 * 本卡把落点搬进仓库内：`<仓库>/.worktrees/<卡>`，靠忽略表（`.gitignore` + 该仓库的 `info/exclude`）
 * 保住 `AC-310` 要保的那件事（副本不进索引），并把 `node_modules` **软链**进去（不拷贝：650 MB × N
 * 不可接受），这样副本里才真能跑 `tsc` 与测试。合并成功后副本由 `removeWorktree` 删掉；合并失败/冲突
 * 则**原样保留现场**（与 `AC-305` 的"冲突不得自动解决、现场保留"同一条口径）。
 *
 * 本文件守的是**四种双态**（每条都在下面有反例/正例两格）：
 *   M266-01 缺省根在仓库内、副本**真可写**、主仓库索引仍干净；非白名单的仓库内根照旧被拒；
 *   M266-02 副本里 `node_modules` 是**软链**（同 inode ⇒ 不是拷贝），且不会被提交进副本分支；
 *   M266-03 软链的三条前提各有一条"跳过并给理由"的格（跳过 ≠ 静默产出不可用的副本）；
 *   M266-04 **态 A（合并成功）**：副本目录消失、分支已删、只剩主工作树；
 *   M266-05 **态 B（合并冲突）**：副本目录与分支都在、主工作树已还原；
 *   M266-06 合并后副本里仍有**未提交的活** ⇒ 不许被顺手抹掉（`--force` 只对"已合并且干净"生效）；
 *   M266-07 项目侧声明（`.gitignore` 收录 `.worktrees/`）—— 这是"落点在仓库内还不进索引"的那一半。
 *
 * ⚠️ **写作约束（别改回去）**：`m189` 的读散文棘轮按「文件 + 读散文站点数」**按身份**登记，
 * 新文件不在那张表里 ⇒ 本文件**不许**出现内联中文判据或中文断言消息（否则会多出一个未登记的站点）。
 * 中文一律写在**注释**里，断言消息用英文。
 *
 * 演练一律在临时仓库里做（`node_modules/.sdo-test/m266/`，整树被 `.gitignore` 忽略）：不碰真仓库、
 * 不碰真台账、不碰 `.sdo/`。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

import {
  commitWorktree,
  createWorktree,
  isInsideRepo,
  isUnderWorktreeRoot,
  listWorktrees,
  mergeWorktree,
  removeWorktree,
  repoTopOf,
  worktreeRootOf,
} from '../src/integration/worktree.js'

/** 编译后本文件落在 `lib/test/`，仓库根是上两级。 */
const REPO = fileURLToPath(new URL('../../', import.meta.url))
/** 夹具根（本仓惯例：`node_modules/.sdo-test/<mNNN>`；它整树被忽略，不会污染真仓库）。 */
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m266/', import.meta.url))

const BODY = 'line1\nline2\nline3\nline4\nline5\nline6\n'

/** 夹具里的一次 git 调用（**不抛**：失败也要能被断言成事实）。 */
function git(cwd: string, args: readonly string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: String(out ?? '') }
  } catch (error) {
    const failed = error as { stdout?: unknown; stderr?: unknown }
    return { ok: false, out: String(failed.stderr ?? failed.stdout ?? String(error)) }
  }
}

let seq = 0
function makeRepo(): string {
  const dir = join(BASE, `r${String(++seq)}`)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 'sdo'])
  git(dir, ['config', 'user.email', 'sdo@localhost'])
  writeFileSync(join(dir, 'base.txt'), BODY, 'utf8')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
  // 返回**物理**路径：`git rev-parse --show-toplevel` 会把符号链接解开（`node_modules` 在副本里就是软链），
  // 而本夹具根正落在 `node_modules/.sdo-test/` 下 ⇒ 不折算就会出现"同一个仓库两个字符串"的假红。
  return realpathSync(dir)
}

/**
 * 给夹具装一份 `node_modules`。`ignore: true` ⇒ 连 `.gitignore` 一起提交（模拟真实仓库）；
 * `ignore: false` ⇒ 留成**未跟踪也未忽略**的样子（用来守"没被忽略就不建链"那一格）。
 */
function addDeps(dir: string, ignore: boolean): string {
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n', 'utf8')
  if (ignore) {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.worktrees/\n', 'utf8')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'deps + ignore'])
  }
  return dir
}

after(() => {
  // 夹具整树留在 `node_modules/.sdo-test/` 里（已被忽略）；这里不删，跑完还能人工翻现场
})

before(() => {
  // 上一次失败留下的副本目录会让 `createWorktree` 报 `exists`（那是它的正确行为）⇒ 每轮先清场地
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
})

test('M266-01 the default root is <repo>/.worktrees and the copy is really writable while the index stays clean', () => {
  const repo = makeRepo()
  assert.equal(worktreeRootOf(repo), join(repo, '.worktrees'), 'default root must be <repo>/.worktrees (AC-310)')
  const created = createWorktree({ repoRoot: repo, taskId: 'TASK-26601' })
  assert.equal(created.ok, true, `create must succeed: ${JSON.stringify(created).slice(0, 240)}`)
  if (!created.ok) return
  const path = created.ref.path
  assert.equal(path, join(repo, '.worktrees', 'task-26601'), 'the copy must land inside the repo, under .worktrees/')
  // 验收要的不是"目录建出来了"，而是"文件写得进去"：写一条、读回来
  const probe = join(path, 'writable-probe.txt')
  writeFileSync(probe, 'probe\n', 'utf8')
  assert.equal(readFileSync(probe, 'utf8'), 'probe\n', 'the copy must accept writes (write then read back)')
  // "落点在 rw 挂载上"的机械读数：与仓库同一文件系统（不依赖 findmnt 的输出格式）
  assert.equal(statSync(path).dev, statSync(repo).dev, 'the copy must sit on the same filesystem as the repo')
  // 索引仍干净：这个夹具没写 .gitignore，靠建副本时补的 info/exclude 兜住
  assert.equal(git(repo, ['status', '--porcelain']).out.trim(), '', 'main worktree status must stay clean')
  // 落点搬进仓库内是本卡的目的；但"仓库内"不再等于"放行" —— 非副本根下面的仓库内路径照旧拒绝
  assert.equal(isInsideRepo(repo, path), true, 'sanity: the new default root is inside the repo')
  assert.equal(isUnderWorktreeRoot(repo, path), true, 'sanity: it is under the ignored worktree root')
  const legacy = createWorktree({ repoRoot: repo, taskId: 'TASK-26602', root: join(repo, '.sdo', 'drafts', 'worktrees') })
  assert.equal(legacy.ok, false, 'an in-repo root outside .worktrees/ must still be rejected')
  if (legacy.ok) return
  assert.equal(legacy.code, 'inside-repo')
})

test('M266-02 the copy gets node_modules as a symlink (same inode) and the link never enters the copy branch', () => {
  const repo = makeRepo()
  addDeps(repo, true)
  const created = createWorktree({ repoRoot: repo, taskId: 'TASK-26603' })
  assert.equal(created.ok, true, `create must succeed: ${JSON.stringify(created).slice(0, 240)}`)
  if (!created.ok) return
  const path = created.ref.path
  assert.equal(created.ref.deps.linked, true, `deps must be linked: ${JSON.stringify(created.ref.deps)}`)
  const dest = join(path, 'node_modules')
  assert.equal(lstatSync(dest).isSymbolicLink(), true, 'node_modules in the copy must be a symlink, not a copy')
  assert.equal(realpathSync(dest), realpathSync(join(repo, 'node_modules')), 'the link must point at the main tree')
  // 同 inode ⇒ 确实是同一份字节（拷贝会分叉 inode）
  const copied = join(dest, 'pkg', 'index.js')
  const original = join(repo, 'node_modules', 'pkg', 'index.js')
  assert.equal(statSync(copied).ino, statSync(original).ino, 'same inode means the dependency bytes are not duplicated')
  // 链接不许进索引：提交副本里的工作时，变更清单里只能有那个真实文件
  writeFileSync(join(path, 'feature.txt'), 'f\n', 'utf8')
  const commit = commitWorktree({ path, message: 'TASK-26603 work' })
  assert.equal(commit.ok, true, `commit must succeed: ${JSON.stringify(commit).slice(0, 200)}`)
  if (!commit.ok) return
  assert.deepEqual(commit.files, ['feature.txt'], 'the node_modules symlink must not be committed')
})

test('M266-03 deps linking skips with a readable reason (absent / not ignored) instead of a silently unusable copy', () => {
  // ① 主树没有 node_modules ⇒ 跳过，理由 absent（不是"建成功就算可用"）
  const bare = makeRepo()
  const missing = createWorktree({ repoRoot: bare, taskId: 'TASK-26604' })
  assert.equal(missing.ok, true, `create must still succeed without deps: ${JSON.stringify(missing).slice(0, 200)}`)
  if (!missing.ok) return
  assert.equal(missing.ref.deps.linked, false, 'no node_modules in the main tree => nothing to link')
  assert.equal(missing.ref.deps.reason, 'absent')
  // ② 有 node_modules，但它**没被忽略** ⇒ 跳过并点名 not-ignored（建链会把副本分支弄脏）
  const leaky = makeRepo()
  addDeps(leaky, false)
  const skipped = createWorktree({ repoRoot: leaky, taskId: 'TASK-26605' })
  assert.equal(skipped.ok, true, `create must still succeed: ${JSON.stringify(skipped).slice(0, 200)}`)
  if (!skipped.ok) return
  assert.equal(skipped.ref.deps.linked, false, 'an un-ignored node_modules must not be linked')
  assert.equal(skipped.ref.deps.reason, 'not-ignored')
  assert.equal(existsSync(join(skipped.ref.path, 'node_modules')), false, 'no symlink may be created in that case')
})

test('M266-04 state A (merge succeeds): the copy disappears, the branch is deleted, only the main worktree remains', () => {
  const repo = makeRepo()
  addDeps(repo, true)
  const created = createWorktree({ repoRoot: repo, taskId: 'TASK-26606' })
  assert.equal(created.ok, true, `create must succeed: ${JSON.stringify(created).slice(0, 240)}`)
  if (!created.ok) return
  const path = created.ref.path
  writeFileSync(join(path, 'merged.txt'), 'merged\n', 'utf8')
  const commit = commitWorktree({ path, message: 'TASK-26606 work' })
  assert.equal(commit.ok && commit.committed, true, 'the copy work must be committed before merging')
  const merged = mergeWorktree({ repoRoot: repo, taskId: 'TASK-26606' })
  assert.equal(merged.ok, true, `merge must succeed: ${JSON.stringify(merged).slice(0, 240)}`)
  if (!merged.ok) return
  assert.equal(merged.kind, 'merged')
  assert.deepEqual(merged.changedFiles, ['merged.txt'], 'the merge must hand back the changed files')
  assert.equal(existsSync(join(repo, 'merged.txt')), true, 'the file must really be on the main tree')
  const removed = removeWorktree({ repoRoot: repo, taskId: 'TASK-26606', base: 'main' })
  assert.equal(
    removed.ok,
    true,
    `removal after a merge must succeed even with the deps symlink in place: ${JSON.stringify(removed).slice(0, 240)}`,
  )
  assert.equal(existsSync(path), false, 'state A: the copy directory must be gone')
  assert.deepEqual(listWorktrees(repo).map((entry) => entry.path), [repoTopOf(repo)], 'only the main worktree may remain')
  assert.equal(git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/sdo/task-26606']).ok, false, 'the branch must be gone too')
})

test('M266-05 state B (merge conflicts): the copy directory and the branch survive, the main tree is restored', () => {
  const repo = makeRepo()
  const created = createWorktree({ repoRoot: repo, taskId: 'TASK-26607' })
  assert.equal(created.ok, true, `create must succeed: ${JSON.stringify(created).slice(0, 240)}`)
  if (!created.ok) return
  const path = created.ref.path
  // 两边改**同一行**（真冲突）
  writeFileSync(join(path, 'base.txt'), 'line1\nline2\nline3-by-copy\nline4\nline5\nline6\n', 'utf8')
  const commit = commitWorktree({ path, message: 'copy edits line 3' })
  assert.equal(commit.ok, true, 'commit in the copy must succeed')
  writeFileSync(join(repo, 'base.txt'), 'line1\nline2\nline3-by-main\nline4\nline5\nline6\n', 'utf8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'main edits line 3'])

  const merged = mergeWorktree({ repoRoot: repo, taskId: 'TASK-26607' })
  assert.equal(merged.ok, false, 'a real conflict must be reported as such (never auto-resolved)')
  if (merged.ok) return
  assert.equal(merged.kind, 'conflict')
  assert.deepEqual(merged.conflictFiles, ['base.txt'], 'the conflicting file must be named')
  // 态 B：现场必须完整
  assert.equal(existsSync(path), true, 'state B: the copy directory must be kept')
  assert.equal(git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/sdo/task-26607']).ok, true, 'state B: the branch must be kept')
  assert.equal(git(repo, ['status', '--porcelain']).out.trim(), '', 'the main tree must be restored (merge --abort)')
  // 默认清场**不许**碰现场：未合并的分支 ⇒ 拒
  const guarded = removeWorktree({ repoRoot: repo, taskId: 'TASK-26607' })
  assert.equal(guarded.ok, false, 'a non-forced removal must refuse an unmerged branch')
  if (guarded.ok) return
  assert.equal(guarded.code, 'unmerged')
  assert.equal(existsSync(path), true, 'the scene must still be there after the refusal')
})

test('M266-06 uncommitted work in the copy keeps the scene alive even right after a successful merge', () => {
  const repo = makeRepo()
  addDeps(repo, true)
  const created = createWorktree({ repoRoot: repo, taskId: 'TASK-26608' })
  assert.equal(created.ok, true, `create must succeed: ${JSON.stringify(created).slice(0, 240)}`)
  if (!created.ok) return
  const path = created.ref.path
  writeFileSync(join(path, 'done.txt'), 'done\n', 'utf8')
  const commit = commitWorktree({ path, message: 'TASK-26608 work' })
  assert.equal(commit.ok, true, 'commit must succeed')
  const merged = mergeWorktree({ repoRoot: repo, taskId: 'TASK-26608' })
  assert.equal(merged.ok, true, `merge must succeed: ${JSON.stringify(merged).slice(0, 240)}`)
  if (!merged.ok) return
  // 合并之后副本里又冒出**未提交**的活：这时不许删（`--force` 只对"已合并且干净"生效）
  writeFileSync(join(path, 'left-behind.txt'), 'keep me\n', 'utf8')
  const kept = removeWorktree({ repoRoot: repo, taskId: 'TASK-26608', base: 'main' })
  assert.equal(kept.ok, false, 'uncommitted work must block the default removal')
  if (kept.ok) return
  assert.equal(kept.code, 'failed')
  assert.equal(existsSync(join(path, 'left-behind.txt')), true, 'the uncommitted file must survive')
  // 只有**显式 force**（`drop` 那一路）才允许清场
  const forced = removeWorktree({ repoRoot: repo, taskId: 'TASK-26608', base: 'main', force: true })
  assert.equal(forced.ok, true, `explicit force may clear it: ${JSON.stringify(forced).slice(0, 200)}`)
  assert.equal(existsSync(path), false, 'after an explicit force the copy is gone')
})

test('M266-07 the project declares .worktrees/ in .gitignore (the invariants ADR-025 gave are kept by the ignore table)', () => {
  const text = readFileSync(join(REPO, '.gitignore'), 'utf8')
  const lines = text.split('\n').map((line) => line.trim())
  assert.equal(lines.includes('.worktrees/'), true, 'the project .gitignore must declare .worktrees/')
  assert.equal(lines.includes('.sdo/'), true, 'sanity: .sdo/ is still ignored (the copy must not land there)')
  assert.equal(worktreeRootOf(REPO), join(REPO, '.worktrees'), 'this repo resolves its copy root to <repo>/.worktrees')
})
