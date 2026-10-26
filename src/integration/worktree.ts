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
 * 五条硬边界（写在这里，免得下一个调用点各猜一套）：
 *   ① 副本根缺省在**仓库内**的 `.worktrees/`（`<repo>/.worktrees/<task-id>`，`AC-310`）。
 *      修前它在仓库**父目录**下（`<repo>/../.sdo-worktrees/`）—— 那个落点在本机落在 `/home` 的
 *      `ro` 挂载上：副本建得出来、写不进去（宿主的沙箱按**会话工作区**放行，落点在工作区外就一律拒），
 *      隔离等于零。搬进仓库内不会污染索引：根名同时进项目的 `.gitignore`，建副本时还往该仓库的
 *      `info/exclude` 补一行（**本地**忽略：不改工作树、不进提交、不进 `git diff`）；
 *   ② 显式给的根仍要过 `inside-repo` 这道闸（`ADR-025` 明写"不是 .sdo 下"）：在仓库内、又不在
 *      被忽略的副本根下的写法照样拒绝；两道理由并列，旧写法的下场不变 ——
 *      不在仓库内 ⇒ 结构上不可能进索引；`inside-repo` 是**拒绝**码，把 `.sdo/drafts/worktrees/`
 *      这类旧写法挡在门外（`ADR-025` 明写"不是 .sdo 下"）；
 *   ③ 工作副本里**未提交**的改动不会被 `git merge` 带走 ⇒ 合并前必须先 `commitWorktree`
 *      （子代理写完文件不提交，合并出来是**零变更**——这是最容易静默出错的一步，故单列一个函数）；
 *   ④ 合回的目标必须是**分支**：detached HEAD 下没有"主干"可言，`mergeWorktree` 会拒绝而不是猜一个；
 *   ⑤ 合并成功 ⇒ 副本必须清掉（`AC-310` 落点三，`removeWorktree` 在"分支已合进主干"这一支里带
 *      `--force`）；合并失败/冲突 ⇒ 副本目录与分支**原样保留**（与 `AC-305`「冲突不得自动解决、
 *      现场保留」同一条口径）。
 *
 * git 调用的失败一律返回 `ok: false` + 可读原因（与 `src/infra/git.ts` 的 `readDirtyWorktree`
 * 同一套失败口径）：**绝不假装合并成功**。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * 副本根目录名（**仓库内**的 `.worktrees`，靠忽略表不进索引）。
 *
 * 修前叫 `.sdo-worktrees` 且落在仓库**父目录**下（`AC-310` 搬进仓库内，理由见 {@link worktreeRootOf}）。
 */
export const WORKTREE_ROOT_NAME = '.worktrees'

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

/**
 * 副本根：**仓库内**的 `.worktrees`（`AC-310` 的落点）。
 *
 * 为什么从仓库**父目录**搬进来：父目录那个落点在本机是 `/home` 的 `ro` 挂载 —— 副本建得出来、
 * 却写不进任何文件（宿主的写权限按**会话工作区**给），于是"各写各的副本"这条口径等于没落地。
 * 为什么不放 `.sdo/`（它也可写）：① `M220-10` 在量 `.sdo/` 的体积（现盘 56 MB），副本进去会把
 * 那个读数搅乱；② 台账读取扫 `LEDGER_TRUTH_DIRS`，副本会被当成台账读进去；③ 备份/脱敏的边界以
 * `.sdo/` 为单位 ⇒ 副本落进去就被卷进那两条链路。这三条都不适用于 `.worktrees/`。
 */
export function worktreeRootOf(repoRoot: string): string {
  return join(resolve(repoRoot), WORKTREE_ROOT_NAME)
}

/** 该路径是否落在**被忽略的副本根**下（`<repo>/.worktrees/…`）。 */
export function isUnderWorktreeRoot(repoRoot: string, path: string): boolean {
  const rel = relative(resolve(worktreeRootOf(repoRoot)), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 该路径是否落在仓库内（`true` ⇒ 除非它同时在 {@link isUnderWorktreeRoot} 之下，否则拒绝：会进索引）。 */
export function isInsideRepo(repoRoot: string, path: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface WorktreeRef {
  taskId: string
  /** 副本目录（缺省落在 **`<repo>/.worktrees/<卡>`**，被忽略表挡在索引之外；`AC-310`）。 */
  path: string
  branch: string
  /** 基底（分支名或提交 sha） */
  base: string
  /** 建副本那一刻的头部提交 */
  head: string
  /** `node_modules` 软链的结果（{@link linkWorktreeDeps}）：副本**能不能构建**看这一项，不看"建成功" */
  deps: WorktreeDeps
}

export interface WorktreeCreateInput {
  /** 主仓库工作树（`git rev-parse --show-toplevel` 的发现口径由本模块自己做） */
  repoRoot: string
  taskId: string
  /** 副本根（缺省 {@link worktreeRootOf}）；在仓库内的根必须落在被忽略的副本根之下 */
  root?: string | undefined
  /** 基底分支/提交（缺省 = 仓库当前 HEAD） */
  base?: string | undefined
}

/** `node_modules` 软链的结果（**不拷贝**：现盘 650 MB × N 不可接受）。 */
export interface WorktreeDeps {
  linked: boolean
  /** `linked: true` ⇒ `''`；否则是跳过的理由（回执要能照着办） */
  reason: '' | 'absent' | 'present' | 'not-ignored' | 'failed'
  detail: string
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
 * 让"仓库内的副本根"不进索引：往该仓库的 `info/exclude` 补一行（**本地**忽略）。
 *
 * 为什么建副本时还要写这一处 —— 项目的 `.gitignore` 只对**本仓**生效；落点搬进仓库内之后，
 * 任何一个没写这条的仓库都会在 `git status` 里看见 `.worktrees/`，而"哪些文件被改了"正是本模块
 * 唯一的读数。`info/exclude` 不进版本控制、不改工作树、不进 `git diff` —— 它是 git 给"本地忽略"
 * 留的那一格。写不进去只影响这道保险，副本本身照样可用 ⇒ 失败不判死，理由带出去。
 */
function ensureLocalIgnore(repoRoot: string, pattern: string): { ok: boolean; detail: string } {
  const query = git(repoRoot, ['rev-parse', '--git-path', 'info/exclude'])
  if (!query.ok) return { ok: false, detail: `定位 info/exclude 失败：${query.stderr.trim()}` }
  const file = resolve(repoRoot, query.stdout.trim())
  const line = pattern
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (current.split('\n').some((item) => item.trim() === line)) return { ok: true, detail: `${line} 已在 info/exclude` }
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${line}\n`, 'utf8')
    return { ok: true, detail: `${line} 已写入 info/exclude` }
  } catch (error) {
    return { ok: false, detail: `写 info/exclude 失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 把主树的 `node_modules` **软链**进副本（**不拷贝**：现盘 650 MB × N 不可接受）。
 *
 * 三条前提，任一不成立就**跳过**并如实给理由（跳过 ≠ 失败：副本照样建得出来，只是"副本里能不能
 * 构建"这件事没被保证 —— 调用方要照实报，不许把"建成功"当成"可用"）：
 *   ① 主树里有 `node_modules`；
 *   ② 副本里还没有（重跑/复用的情况不覆盖）；
 *   ③ 它在主仓库里是**被忽略**的 —— 否则一次 `commitWorktree` 会把这条链接提交进副本分支，
 *      合并后主树凭空多一个 `node_modules` 链接。
 *
 * 建好之后还要往该仓库的 `info/exclude` 补一行**裸的** `node_modules`：项目的 `.gitignore` 里那条
 * 通常写作 `node_modules/`（带斜杠 ⇒ 只匹配**目录**），而这里的链接不是目录 ⇒ 光靠它挡不住
 * `git add -A`（实测：不带这一行时，副本提交里就多了一条 `node_modules`）。只写本地忽略表，
 * 不改项目文件、不影响已被跟踪的路径。
 */
export function linkWorktreeDeps(repoRoot: string, worktreePath: string): WorktreeDeps {
  const source = join(resolve(repoRoot), 'node_modules')
  const target = join(resolve(worktreePath), 'node_modules')
  if (!existsSync(source)) return { linked: false, reason: 'absent', detail: `主树没有 node_modules：${source}` }
  if (existsSync(target)) return { linked: false, reason: 'present', detail: `副本里已有 node_modules：${target}` }
  if (!git(repoRoot, ['check-ignore', '-q', 'node_modules']).ok) {
    return { linked: false, reason: 'not-ignored', detail: `node_modules 未被主仓库忽略 ⇒ 不建链接（会进索引）：${source}` }
  }
  try {
    symlinkSync(source, target, 'dir')
    ensureLocalIgnore(repoRoot, 'node_modules')
    return { linked: true, reason: '', detail: `${target} → ${source}` }
  } catch (error) {
    return { linked: false, reason: 'failed', detail: `建软链失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * **建工作副本**：`git worktree add <path> -b sdo/<task-id> <base>`，随后把 `node_modules` 软链进去。
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
  const insideRepo = isInsideRepo(repoRoot, path)
  if (insideRepo && !isUnderWorktreeRoot(repoRoot, path)) {
    // **`ADR-025`**：副本不许落进主仓库索引。`AC-310` 之后缺省根就在仓库内（`<repo>/.worktrees/`），
    // 它靠忽略表（`.gitignore` + `info/exclude`）留在索引之外；除此之外的仓库内路径一律拒绝 ——
    // `.sdo/drafts/worktrees/` 那种旧写法在这里被挡下：落进去 `git status` 就被副本自己的文件污染，
    // "这次合并改了哪些文件"再也读不准。
    return {
      ok: false,
      code: 'inside-repo',
      detail: `副本路径落在主仓库内、且不在被忽略的副本根下（会进索引）：${path}；仓库内的副本只许放在 ${worktreeRootOf(repoRoot)}`,
      ref: { taskId: id, path, branch: `${WORKTREE_BRANCH_PREFIX}${id}`, base: '', head: '', deps: { linked: false, reason: 'absent', detail: '未建副本' } },
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
  // 仓库内的根先登记进本地忽略表（在 `worktree add` 之前写：add 之后 `git status` 就已经能看见它）
  if (insideRepo) ensureLocalIgnore(repoRoot, `${WORKTREE_ROOT_NAME}/`)
  const add = git(repoRoot, ['worktree', 'add', path, '-b', branch, resolvedBase])
  if (!add.ok) return { ok: false, code: 'failed', detail: `git worktree add 失败：${add.stderr.trim() || add.stdout.trim()}` }
  const head = git(path, ['rev-parse', 'HEAD'])
  const deps = linkWorktreeDeps(repoRoot, path)
  return {
    ok: true,
    ref: { taskId: id, path, branch, base: resolvedBase, head: head.ok ? head.stdout.trim() : '', deps },
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
  | { ok: true; path: string; branchDeleted: boolean; detail: string; ignored: string[] }
  | { ok: false; code: WorktreeRemoveCode; detail: string; path: string }

/**
 * **移除工作副本**：合并成功后清场（`AC-310` 落点三）；`drop` 的卡用 `force` 清场。
 *
 * 双态口径（与 `AC-305` 的"冲突不自动解决、现场保留"同一条）：
 *   · 分支**已合进主干**且副本里没有未提交的活 ⇒ 删（这一步带 `--force`，理由见函数内的实测注释）；
 *   · 分支**没合进主干**（含冲突未解决）或副本里**还有未提交文件** ⇒ 保留现场并如实报原因。
 * 两种"不许删"的情形都必须红 —— 删了等于毁掉现场。
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
  const branchPresent = branchExists(repoRoot, branch)
  const merged = branchPresent && base !== '' ? git(repoRoot, ['merge-base', '--is-ancestor', branch, base]).ok : false
  if (!force && branchPresent && base !== '' && !merged) {
    return {
      ok: false,
      code: 'unmerged',
      detail: `分支未合并进 ${base}（冲突未解决或工作还没合并）⇒ 现场必须保留：${branch}`,
      path,
    }
  }
  // **合并成功 ⇒ 副本必须清掉**（`AC-310` 落点三）。带 `--force` 是实测出来的需要，不是图省事：
  // 副本里那条 `node_modules` 软链即便被忽略，`git worktree remove` 仍报"包含修改或未跟踪的文件"
  // 并拒绝（现盘读数）⇒ 不带 `--force`，装好依赖的副本就删不掉、永远堆在 `.worktrees/` 里。
  // 但 `--force` 不许顺手抹掉**没提交的活**：那一步先看 `pendingWorkOf`，非空就保留现场、如实报。
  // `--force` 会顺手抹掉**被忽略**的产物（`lib/`、`node_modules` 链接）—— 那些可重建、不拦清场，
  // 但**必须清点着说出来**（`TASK-266`）：否则读者无法区分"只删了个空副本"与"删掉了一整棵构建产物"。
  const pending = pendingWorkOf(path)
  const dirty = pending.ok && pending.files.length > 0
  const swept = pending.ok ? pending.ignored : []
  const forced = force || (merged && !dirty)
  let remove = git(repoRoot, ['worktree', 'remove', ...(forced ? ['--force'] : []), path])
  if (!remove.ok && !forced && merged && !dirty) {
    remove = git(repoRoot, ['worktree', 'remove', '--force', path])
  }
  if (!remove.ok) {
    const why = dirty ? `（副本里还有 ${String(pending.files.length)} 个未提交文件 ⇒ 现场保留）` : ''
    return { ok: false, code: 'failed', detail: `git worktree remove 失败${why}：${remove.stderr.trim() || remove.stdout.trim()}`, path }
  }
  let branchDeleted = false
  if (branchExists(repoRoot, branch)) {
    // 合并过的分支与 `force` 路径都可以删；删不掉不算失败（副本已经清了），但如实回报
    branchDeleted = git(repoRoot, ['branch', '-D', branch]).ok
  }
  // 被忽略的产物：列前几个（全量可能上千条），条数照实说
  const sweptNote = swept.length === 0
    ? ''
    : `，连带清掉 ${String(swept.length)} 个被忽略的产物（${swept.slice(0, 3).join(' / ')}${swept.length > 3 ? ' …' : ''}）`
  return { ok: true, path, branchDeleted, ignored: swept, detail: `副本已移除${branchDeleted ? '，分支已删' : ''}${sweptNote}` }
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
 *
 * **被忽略的产物单独清点（`TASK-266`）**：缺省 `git status` 对忽略面**一个字都不说**，而副本里
 * 恰恰总有几样被忽略的东西 —— `lib/`（构建产物）与建副本时软链进来的 `node_modules`。它们
 * **不该拦住清场**（都是可重建的），但**也不许装作不存在**：清场那一步带 `--force`，读者有权知道
 * `--force` 抹掉的是什么。所以这里把两类分开报：{@link PendingWork.files} 是真·没提交的活
 * （非空 ⇒ 保留现场），{@link PendingWork.ignored} 是被忽略的产物（只清点、不拦、如实写进回执）。
 *
 * `--ignored=matching` 是刻意的：裸 `--ignored` 会把 `node_modules/` 里几万个文件逐条列出
 * （一次调用几十 MB 输出），`matching` 只报**被忽略的那个目录本身**（实测一条 `!! node_modules/`）。
 */
export interface PendingWork {
  ok: boolean
  /** 真·没提交的活（改过的 + 未跟踪的）：非空 ⇒ 清场必须保留现场。 */
  files: string[]
  /** 被忽略的产物（`lib/` / `node_modules` 链接…）：只清点，不拦清场。 */
  ignored: string[]
  detail: string
}

export function pendingWorkOf(path: string): PendingWork {
  const inside = git(path, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') return { ok: false, files: [], ignored: [], detail: `不是 git 工作树：${path}` }
  const run = git(path, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching'])
  if (!run.ok) return { ok: false, files: [], ignored: [], detail: `读状态失败：${run.stderr.trim()}` }
  // porcelain 每条是 `XY <path>`（改名条目会多一段旧路径）⇒ 取状态码之后的路径段。
  // `!!` = 被忽略；其余（`??` / ` M` / `A ` …）= 真·没提交的活。
  const files: string[] = []
  const ignored: string[] = []
  for (const entry of splitZ(run.stdout)) {
    const name = entry.slice(3).trim()
    if (name === '') continue
    if (entry.startsWith('!!')) ignored.push(name)
    else files.push(name)
  }
  const detail = files.length === 0
    ? `${String(ignored.length)} 个被忽略的产物（可重建）`
    : `${String(files.length)} 个未提交文件${ignored.length === 0 ? '' : ` + ${String(ignored.length)} 个被忽略的产物`}`
  return { ok: true, files, ignored, detail }
}
