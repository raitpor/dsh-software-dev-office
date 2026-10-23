/**
 * **轻量 git：子代理的工作副本（主仓库的 worktree）与合并**（`REQ-066` / `TASK-172`，口径见 `ADR-025`）。
 *
 * 要解决的问题（`DEF-128` 的现场）：两个 developer 被同时派到写范围相交的活，各自在**同一棵工作树**里写，
 * 一个静默覆盖另一个；而且事后没有现场可查 —— 谁改的、改在哪、被谁覆盖，全靠猜。
 *
 * 所以口径不是"拦住相交"（git 对**同一文件的不同区域**本来就能干净合并 —— 一律拦下只会让人白拆卡），
 * 而是"各写各的副本、完成时合并"：
 *   · 副本 = **主仓库**的 `git worktree`（`git worktree add`），**不是** `.sdo/` 下的目录
 *     —— 台账不建第二层仓库（`ADR-025`），副本也不许落进主仓库索引（落进去 `git status` 就会被污染，
 *     而"哪些文件被改了"正是本模块唯一的读数）；
 *   · 合并 = **真三路合并**（`git merge --no-ff`）。同文件不同区域必须合得过去；把它判成冲突
 *     （例如用"文件级锁"替代真合并）算实现缺陷（`AC-305` 第二档）；
 *   · 冲突 = **不自动解决**：不传 `-X ours/theirs`、不跳过、不 `--continue`。报出冲突文件、
 *     把主工作树**还原**（`git merge --abort`）、**保留副本现场**（副本目录与分支都不动）交人工。
 *
 * 本模块与 `src/integration/dispatch.ts` 同一定位：**纯适配**（只调 git、只返回结构化事实）。
 * 它**不读台账、不写 journal** —— 「合并带来了哪些文件变更」「哪几个文件冲突」由调用方拿去落事件
 * （`AC-304` 要的那条事件带卡 id / 副本标识 / 变更文件清单，属于台账层；本模块把这三样现算好交出去）。
 * 这样切的好处：合并语义可以**脱离台账**独立暴力验证（临时仓库里造冲突即可），而落事件的位置只有一处。
 *
 * 三条硬边界（写在这里，免得下一个调用点各猜一套）：
 *   ① 副本根缺省是**仓库父目录**下的 `.sdo-worktrees/`（`<repo>/../.sdo-worktrees/<task-id>`）——
 *      不在仓库内 ⇒ 结构上不可能进索引；`inside-repo` 是**拒绝**码，把 `.sdo/drafts/worktrees/`
 *      这类旧写法挡在门外（`ADR-025` 明写"不是 .sdo 下"）；
 *   ② 工作副本里**未提交**的改动不会被 `git merge` 带走 ⇒ 合并前必须先 `commitWorktree`
 *      （子代理写完文件不提交，合并出来是**零变更**——这是最容易静默出错的一步，故单列一个函数）；
 *   ③ 合回的目标必须是**分支**：detached HEAD 下没有"主干"可言，`mergeWorktree` 会拒绝而不是猜一个。
 *
 * git 调用的失败一律返回 `ok: false` + 可读原因（与 `src/infra/git.ts` 的 `readDirtyWorktree`
 * 同一套失败口径）：**绝不假装合并成功**。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** 副本根目录名（仓库**父目录**下，不在仓库内）。 */
export const WORKTREE_ROOT_NAME = '.sdo-worktrees'

/** 分支前缀：`sdo/<task-id>`。 */
export const WORKTREE_BRANCH_PREFIX = 'sdo/'

/**
 * 提交身份（只用于**本模块自己造的那一次**提交，不写进仓库配置）。
 *
 * 为什么必须带：CI / 裸机上的仓库常常没配 `user.name`，`git commit` 会直接失败
 * ⇒ 合并"看起来做了"却没落地（宁可带一个显式身份，也不让结果依赖本机配置）。
 */
const IDENTITY = ['-c', 'user.name=sdo', '-c', 'user.email=sdo@localhost']

/** 一次 `git` 调用的结果（**不抛异常**：失败也是可判读的事实）。 */
interface GitRun {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: readonly string[]): GitRun {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // 交互式凭据提示在无终端时会挂死：一律关掉（本模块不该有网络动作）
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { ok: true, code: 0, stdout: String(stdout ?? ''), stderr: '' }
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: unknown; stderr?: unknown }
    return {
      ok: false,
      code: typeof failed.status === 'number' ? failed.status : 1,
      stdout: String(failed.stdout ?? ''),
      stderr: String(failed.stderr ?? (error instanceof Error ? error.message : String(error))),
    }
  }
}

/**
 * `-z` 形态的路径清单切分（**`DEF-084` 的教训**：默认出参受 `core.quotePath` 影响，非 ASCII
 * 文件名会被八进制转义 ⇒ 与写范围里的真名永不相等。`-z` 给原始字节，不做反转义）。
 */
function splitZ(text: string): string[] {
  return text
    .split('\0')
    .map((item) => item.replace(/\n$/u, ''))
    .filter((item) => item !== '')
}

/** 把卡 id 折成**分支名/目录名**安全形态（`TASK-172` ⇒ `task-172`）。 */
export function safeTaskId(taskId: string): string {
  return String(taskId ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+/u, '')
}

/** 仓库的 **top level**（`git rev-parse --show-toplevel`）；不是仓库 ⇒ `''`。 */
export function repoTopOf(dir: string): string {
  if (String(dir ?? '').trim() === '') return ''
  const run = git(dir, ['rev-parse', '--show-toplevel'])
  return run.ok ? run.stdout.trim() : ''
}

/** 副本根：**仓库父目录**下的 `.sdo-worktrees`（不在仓库内 ⇒ 不可能进索引）。 */
export function worktreeRootOf(repoRoot: string): string {
  return join(dirname(resolve(repoRoot)), WORKTREE_ROOT_NAME)
}

/** 该路径是否落在仓库内（`true` ⇒ 拒绝：会进索引）。 */
export function isInsideRepo(repoRoot: string, path: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface WorktreeRef {
  taskId: string
  /** 副本目录（**主仓库之外**）。 */
  path: string
  branch: string
  /** 基底（分支名或提交 sha） */
  base: string
  /** 建副本那一刻的头部提交 */
  head: string
}

export interface WorktreeCreateInput {
  /** 主仓库工作树（`git rev-parse --show-toplevel` 的发现口径由本模块自己做） */
  repoRoot: string
  taskId: string
  /** 副本根（缺省 {@link worktreeRootOf}）；给什么都不许落在仓库内 */
  root?: string | undefined
  /** 基底分支/提交（缺省 = 仓库当前 HEAD） */
  base?: string | undefined
}

export type WorktreeCreateCode = 'not-a-repo' | 'inside-repo' | 'exists' | 'branch-exists' | 'no-base' | 'failed'

export type WorktreeCreateOutcome =
  | { ok: true; ref: WorktreeRef }
  | { ok: false; code: WorktreeCreateCode; detail: string; ref?: WorktreeRef | undefined }

/** 分支是否已存在（`refs/heads/<name>`）。 */
function branchExists(repoRoot: string, branch: string): boolean {
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok
}

/** 当前分支名；detached HEAD ⇒ `''`。 */
function currentBranchOf(repoRoot: string): string {
  const run = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!run.ok) return ''
  const name = run.stdout.trim()
  return name === 'HEAD' ? '' : name
}

/**
 * **建工作副本**：`git worktree add <path> -b sdo/<task-id> <base>`。
 *
 * 只建副本，**不**替子代理写任何文件（写入路由是子代理自己的事）。
 */
export function createWorktree(input: WorktreeCreateInput): WorktreeCreateOutcome {
  const repoRoot = repoTopOf(input.repoRoot)
  if (repoRoot === '') {
    return { ok: false, code: 'not-a-repo', detail: `不是 git 仓库（或 git 不可用）：${input.repoRoot}` }
  }
  const id = safeTaskId(input.taskId)
  if (id === '') return { ok: false, code: 'failed', detail: '卡 id 折成安全形态后为空，无法命名副本' }
  const root = resolve(input.root ?? worktreeRootOf(repoRoot))
  const path = join(root, id)
  if (isInsideRepo(repoRoot, path)) {
    // **`ADR-025`**：副本不许落在主仓库内（`.sdo/drafts/worktrees/` 那种旧写法在这里被挡下）——
    // 落进去就会进索引：`git status` 被副本自己的文件污染，"这次合并改了哪些文件"再也读不准。
    return {
      ok: false,
      code: 'inside-repo',
      detail: `副本路径落在主仓库内（会进索引）：${path}；副本必须建在仓库之外（缺省 ${worktreeRootOf(repoRoot)}）`,
      ref: { taskId: id, path, branch: `${WORKTREE_BRANCH_PREFIX}${id}`, base: '', head: '' },
    }
  }
  const base = (input.base ?? '').trim() === '' ? '' : String(input.base).trim()
  const resolvedBase = base === '' ? (currentBranchOf(repoRoot) === '' ? 'HEAD' : currentBranchOf(repoRoot)) : base
  if (!git(repoRoot, ['rev-parse', '--verify', '--quiet', `${resolvedBase}^{commit}`]).ok) {
    return { ok: false, code: 'no-base', detail: `基底不可解析成提交：${resolvedBase}` }
  }
  const branch = `${WORKTREE_BRANCH_PREFIX}${id}`
  if (existsSync(path)) {
    return { ok: false, code: 'exists', detail: `副本目录已存在（现场未清理）：${path}` }
  }
  if (branchExists(repoRoot, branch)) {
    // 不自动删旧分支：那会把上一次冲突的现场抹掉（`AC-305` 第三档要"现场保留"）
    return { ok: false, code: 'branch-exists', detail: `分支已存在（上一次的现场还在）：${branch}` }
  }
  try {
    mkdirSync(root, { recursive: true })
  } catch (error) {
    return { ok: false, code: 'failed', detail: `副本根不可创建：${root}（${error instanceof Error ? error.message : String(error)}）` }
  }
  const add = git(repoRoot, ['worktree', 'add', path, '-b', branch, resolvedBase])
  if (!add.ok) return { ok: false, code: 'failed', detail: `git worktree add 失败：${add.stderr.trim() || add.stdout.trim()}` }
  const head = git(path, ['rev-parse', 'HEAD'])
  return {
    ok: true,
    ref: { taskId: id, path, branch, base: resolvedBase, head: head.ok ? head.stdout.trim() : '' },
  }
}

export interface WorktreeCommitInput {
  /** 副本目录 */
  path: string
  /** 提交信息（缺省按卡无关的固定串） */
  message?: string | undefined
}

export type WorktreeCommitOutcome =
  | { ok: true; committed: boolean; files: string[]; commit: string }
  | { ok: false; code: 'not-a-worktree' | 'failed'; detail: string }

/**
 * **把副本里未提交的工作收进副本分支**（子代理"写完了"那一步）。
 *
 * 为什么单独一步：`git merge` 只搬**提交**。子代理写完文件不提交，合并出来就是**零变更**
 * —— 而回执若只看"合并成功"就会报一条假绿（这是本链路最容易静默出错的地方）。
 * 返回 `committed: false` + 空清单 = "现场本来就干净"，那是**事实**，不是失败。
 */
export function commitWorktree(input: WorktreeCommitInput): WorktreeCommitOutcome {
  const path = resolve(input.path)
  const inside = git(path, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: false, code: 'not-a-worktree', detail: `不是 git 工作树：${path}` }
  }
  const add = git(path, ['add', '-A'])
  if (!add.ok) return { ok: false, code: 'failed', detail: `git add -A 失败：${add.stderr.trim()}` }
  const staged = git(path, ['diff', '--name-only', '-z', '--cached'])
  if (!staged.ok) return { ok: false, code: 'failed', detail: `读暂存清单失败：${staged.stderr.trim()}` }
  const files = splitZ(staged.stdout)
  const head = git(path, ['rev-parse', 'HEAD'])
  const head0 = head.ok ? head.stdout.trim() : ''
  if (files.length === 0) return { ok: true, committed: false, files: [], commit: head0 }
  const message = (input.message ?? '').trim() === '' ? 'sdo: worktree work' : String(input.message).trim()
  const commit = git(path, [...IDENTITY, 'commit', '-m', message])
  if (!commit.ok) return { ok: false, code: 'failed', detail: `git commit 失败：${commit.stderr.trim()}` }
  const after = git(path, ['rev-parse', 'HEAD'])
  return { ok: true, committed: true, files, commit: after.ok ? after.stdout.trim() : '' }
}

export interface WorktreeMergeInput {
  repoRoot: string
  taskId: string
  /** 副本根（缺省 {@link worktreeRootOf}）—— 只用来算缺省路径 */
  root?: string | undefined
  /** 合回哪个分支（缺省 = 仓库当前分支；detached HEAD 下拒绝） */
  base?: string | undefined
  /** 是否由本模块造合并提交（缺省 `true`；`false` ⇒ 停在"已暂存"状态由调用方提交） */
  commit?: boolean | undefined
  message?: string | undefined
}

export type WorktreeMergeOutcome =
  | {
    ok: true
    kind: 'merged' | 'already-merged'
    base: string
    branch: string
    worktreePath: string
    /** 这次合并**带来**的文件变更（`AC-304` 要的那份清单） */
    changedFiles: string[]
    /** 合并提交（`commit: false` 或 `already-merged` ⇒ `''`） */
    commit: string
  }
  | {
    ok: false
    kind: 'conflict'
    base: string
    branch: string
    worktreePath: string
    /** 冲突文件（**点名**，不是"合并失败"四个字） */
    conflictFiles: string[]
    detail: string
  }
  | { ok: false; kind: 'failed'; base: string; branch: string; worktreePath: string; detail: string }

/**
 * **把副本分支合并回主干**（真三路合并，冲突不自动解决）。
 *
 * 失败分两种，**不许混为一谈**（混了就没法给人可执行的下一步）：
 *   · `kind: 'conflict'` —— 两边真改了同一处；**已 `merge --abort` 还原主工作树**，
 *     副本目录与分支**原样保留**（现场），冲突文件清单交人工；
 *   · `kind: 'failed'` —— 压根没开始合并（分支不存在 / 主工作树脏 / 主干是 detached）。
 */
export function mergeWorktree(input: WorktreeMergeInput): WorktreeMergeOutcome {
  const repoRoot = repoTopOf(input.repoRoot)
  const id = safeTaskId(input.taskId)
  const branch = `${WORKTREE_BRANCH_PREFIX}${id}`
  const root = resolve(input.root ?? (repoRoot === '' ? '' : worktreeRootOf(repoRoot)))
  const worktreePath = id === '' ? '' : join(root, id)
  const fail = (detail: string): WorktreeMergeOutcome => ({ ok: false, kind: 'failed', base: '', branch, worktreePath, detail })
  if (repoRoot === '') return fail(`不是 git 仓库（或 git 不可用）：${input.repoRoot}`)
  if (id === '' || !branchExists(repoRoot, branch)) return fail(`副本分支不存在：${branch}`)
  const base = (input.base ?? '').trim() === '' ? currentBranchOf(repoRoot) : String(input.base).trim()
  if (base === '') return fail('合回主干需要主干分支；当前处于 detached HEAD，请显式给 base')
  if (base === branch) return fail(`不能把分支合回它自己：${branch}`)

  // 已经合过（分支是主干的祖先）⇒ 如实报 `already-merged`，**不**再造一个空合并提交
  if (git(repoRoot, ['merge-base', '--is-ancestor', branch, base]).ok) {
    return { ok: true, kind: 'already-merged', base, branch, worktreePath, changedFiles: [], commit: '' }
  }
  // `--no-ff --no-commit`：留住"合并中"状态好判冲突；**绝不**传 `-X ours/theirs`（`AC-305` 第三档）
  const merge = git(repoRoot, [...IDENTITY, 'merge', '--no-ff', '--no-commit', branch])
  if (!merge.ok) {
    const unmerged = git(repoRoot, ['diff', '--name-only', '-z', '--diff-filter=U'])
    const conflictFiles = splitZ(unmerged.stdout)
    const inProgress = git(repoRoot, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok
    if (conflictFiles.length > 0) {
      // **还原主工作树**：冲突不许留在主干上（留下 = 下一个派发会话读到半截现场）；
      // 副本目录/分支**不动** —— 现场在副本里，人工照 `worktreePath` 进去解决后重跑合并。
      const aborted = git(repoRoot, ['merge', '--abort'])
      return {
        ok: false,
        kind: 'conflict',
        base,
        branch,
        worktreePath,
        conflictFiles,
        detail: aborted.ok ? '合并冲突（主工作树已还原，副本现场保留）' : `合并冲突，且 git merge --abort 失败：${aborted.stderr.trim()}`,
      }
    }
    // 不是"同处竞争"的失败：主工作树脏 / 索引锁 / 分支不可合并……
    if (inProgress) git(repoRoot, ['merge', '--abort'])
    return fail(`git merge 失败（不是冲突）：${merge.stderr.trim() || merge.stdout.trim()}`)
  }
  const staged = git(repoRoot, ['diff', '--name-only', '-z', '--cached'])
  const changedFiles = splitZ(staged.stdout)
  if (input.commit === false) {
    return { ok: true, kind: 'merged', base, branch, worktreePath, changedFiles, commit: '' }
  }
  const message = (input.message ?? '').trim() === '' ? `sdo: merge ${branch} into ${base}` : String(input.message).trim()
  const commit = git(repoRoot, [...IDENTITY, 'commit', '-m', message])
  if (!commit.ok) return fail(`合并已暂存，但合并提交失败：${commit.stderr.trim()}`)
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  return {
    ok: true,
    kind: 'merged',
    base,
    branch,
    worktreePath,
    changedFiles,
    commit: head.ok ? head.stdout.trim() : '',
  }
}

export interface WorktreeRemoveInput {
  repoRoot: string
  taskId: string
  root?: string | undefined
  /** 合回的目标分支（缺省 = 当前分支）—— 用来判"这条分支合过没有" */
  base?: string | undefined
  /**
   * **强制移除**（`true` 给"卡被 `drop`"那一路用）：跳过"分支未合并"这条守卫。
   *
   * 冲突现场必须是**调用方显式**`force` 才可能被删的 —— 它不能是默认行为的副作用
   *（`AC-305` 第三档：冲突后副本被删掉 ⇒ 守卫判红）。
   */
  force?: boolean | undefined
}

export type WorktreeRemoveCode = 'not-a-repo' | 'absent' | 'unmerged' | 'failed'

export type WorktreeRemoveOutcome =
  | { ok: true; path: string; branchDeleted: boolean; detail: string }
  | { ok: false; code: WorktreeRemoveCode; detail: string; path: string }

/**
 * **移除工作副本**：合并成功后清场；`drop` 的卡用 `force` 清场。
 *
 * 两种"不许删"的情形必须红：① 分支**没合进主干**（含冲突未解决）—— 删了等于毁掉现场；
 * ② 副本里有**未提交改动**（`git worktree remove` 自己会拒，这里把原因翻成人话）。
 */
export function removeWorktree(input: WorktreeRemoveInput): WorktreeRemoveOutcome {
  const repoRoot = repoTopOf(input.repoRoot)
  const id = safeTaskId(input.taskId)
  if (repoRoot === '') return { ok: false, code: 'not-a-repo', detail: `不是 git 仓库（或 git 不可用）：${input.repoRoot}`, path: '' }
  const root = resolve(input.root ?? worktreeRootOf(repoRoot))
  const path = join(root, id)
  if (!existsSync(path)) return { ok: false, code: 'absent', detail: `副本目录不存在（可能已清理）：${path}`, path }
  const branch = `${WORKTREE_BRANCH_PREFIX}${id}`
  const base = (input.base ?? '').trim() === '' ? currentBranchOf(repoRoot) : String(input.base).trim()
  const force = input.force === true
  if (!force && branchExists(repoRoot, branch) && base !== '') {
    const merged = git(repoRoot, ['merge-base', '--is-ancestor', branch, base]).ok
    if (!merged) {
      return {
        ok: false,
        code: 'unmerged',
        detail: `分支未合并进 ${base}（冲突未解决或工作还没合并）⇒ 现场必须保留：${branch}`,
        path,
      }
    }
  }
  const remove = git(repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
  if (!remove.ok) {
    return { ok: false, code: 'failed', detail: `git worktree remove 失败：${remove.stderr.trim() || remove.stdout.trim()}`, path }
  }
  let branchDeleted = false
  if (branchExists(repoRoot, branch)) {
    // 合并过的分支与 `force` 路径都可以删；删不掉不算失败（副本已经清了），但如实回报
    branchDeleted = git(repoRoot, ['branch', '-D', branch]).ok
  }
  return { ok: true, path, branchDeleted, detail: `副本已移除${branchDeleted ? '，分支已删' : ''}` }
}

/** `git worktree list --porcelain` 的一行式投影（诊断/回执用）。 */
export interface WorktreeEntry {
  path: string
  head: string
  /** `detached` 时为 `''` */
  branch: string
}

export function listWorktrees(repoRoot: string): WorktreeEntry[] {
  const top = repoTopOf(repoRoot)
  if (top === '') return []
  const run = git(top, ['worktree', 'list', '--porcelain'])
  if (!run.ok) return []
  const out: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined
  for (const line of run.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current !== undefined) out.push(current)
      current = { path: line.slice('worktree '.length).trim(), head: '', branch: '' }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim()
    if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//u, '')
  }
  if (current !== undefined) out.push(current)
  return out
}

/**
 * **副本里还没提交的工作**（诊断面：合并前该先 `commitWorktree` 的那一步）。
 *
 * 读的是副本的**状态**而不是与基底的差异：`git status --porcelain -z` 同时覆盖
 * "改了没提交"与"新建未跟踪"两类 —— 这两类都不会被 `git merge` 带走，正是零变更假绿的来源。
 */
export function pendingWorkOf(path: string): { ok: boolean; files: string[]; detail: string } {
  const inside = git(path, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') return { ok: false, files: [], detail: `不是 git 工作树：${path}` }
  const run = git(path, ['status', '--porcelain', '-z', '--untracked-files=all'])
  if (!run.ok) return { ok: false, files: [], detail: `读状态失败：${run.stderr.trim()}` }
  // porcelain 每条是 `XY <path>`（改名条目会多一段旧路径）⇒ 取状态码之后的路径段
  const files = splitZ(run.stdout)
    .map((entry) => entry.slice(3).trim())
    .filter((entry) => entry !== '')
  return { ok: true, files, detail: `${files.length} 个未提交文件` }
}
