/**
 * **增量 218：0.1.7 批3 —— 子代理并行写的隔离与合并 ＋ 子代理标识（`TASK-172`）**。
 *
 * 口径：`REQ-066` / `AC-303` / `AC-304` / `AC-305`、`ADR-025`（台账不自建仓库）、
 * `ADR-022` 裁决③（owner = `<角色>-<会话 uuid 前 8 位>`）、任务书
 * `docs/plan/2026-10-22-任务书-0.1.7批3-并行写隔离与子代理标识.md` §3 的七条守卫。
 *
 * 这张卡要挡住的退化方向（每条都在下面有**反例格**）：
 *   · 把"写范围相交"退回**一律拦下**（`DEF-128` 的另一个极端）⇒ 合法卡白等、逼人白拆卡；
 *   · 用**文件级锁**替代真三路合并 ⇒ 同文件不同区域被误判成冲突；
 *   · 合并冲突**自动解决**（`-X ours/theirs`）或冲突后把现场**删掉**；
 *   · 给 `.sdo/` **自建 git 仓库**（`ADR-025` 明禁）：台账随主仓库进 git、写入经工具串行；
 *   · `owner` 退回**槽位名**（`subagent:developer:1` 这种复用名）⇒ 一个 owner 指向两个会话；
 *   · 观测事件只活在 `evidence/child-tools.jsonl` 里 ⇒ 复用判据对新会话**结构性**拿不到证据
 *     （`DEF-165` ①：全台账含 `observ` 的事件计数＝0，于是每张卡都新起）。
 *
 * 演练**一律在临时目录/临时仓库**里做（`node_modules/.sdo-test/m218/`，已 gitignore）：
 * 不碰真仓库、不碰真台账。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { maskFingerprint } from '../src/domain/roles.js'
import {
  commitWorktree,
  createWorktree,
  isInsideRepo,
  isUnderWorktreeRoot,
  listWorktrees,
  mergeWorktree,
  removeWorktree,
  repoTopOf,
  safeTaskId,
  worktreeRootOf,
} from '../src/integration/worktree.js'
import {
  OWNER_SESSION_LENGTH,
  ownerFormOf,
  ownerOf,
  ownerRolesEqual,
  ownerSessionCollisions,
  ownerRoleOf,
} from '../src/domain/claimCoverage.js'
import { independenceAudit } from '../src/integration/orchestrator.js'
import { scopeIntersections, scopeHeldTasks } from '../src/domain/plan.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m218/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

/* —————————————————————————— 夹具 —————————————————————————— */

function card(id: string, status: TaskCard['status'], writeScopes: string[], overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes,
    role: 'developer',
    size: 'small',
    revision: 1,
    status,
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function writeCard(task: TaskCard): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${task.id}.yml`], { task })
}

/** 一次 `git` 调用（**演练只在临时仓库里做**）。 */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

/** 造一个**临时 git 仓库**（`main` 分支 + 一条基线提交）。 */
function makeRepo(dir: string, file = 'base.txt', body = 'line1\nline2\nline3\nline4\nline5\nline6\n'): string {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 'sdo'])
  git(dir, ['config', 'user.email', 'sdo@localhost'])
  writeFileSync(join(dir, file), body, 'utf8')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
  // 返回**物理**路径：夹具根落在 `node_modules/.sdo-test/` 下，而 `node_modules` 在副本里是软链
  // ⇒ `git rev-parse --show-toplevel` 会把它解开；两边不折算就会出现"同一仓库两个字符串"的假红。
  return realpathSync(dir)
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

/** 把"池里有一个已结算的可续聊子代理"造出来（R-1 的**前置**：池位）。 */
function poolChildOf(childSessionId: string, taskId: string): void {
  office.recordDispatchStarted(call, {
    taskId,
    provider: 'spawn',
    childSessionId,
    parentSessionId: 's1',
    tools: 3,
    role: 'developer',
    mode: 'continuable',
    maskHash: maskFingerprint('developer'),
  })
  office.journalFor(WORKSPACE).append('dispatch/finished', { task: taskId, childSessionId })
  writeCard(card(taskId, 'done', ['src/done/']))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M218 并行写隔离与子代理标识', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['并行写隔离与合并', '子代理标识'],
    scopeOut: ['给 .sdo 建 git 仓库'],
    metricsSuccess: ['同文件不同区域能干净合并', '冲突留现场'],
    glossary: { 工作副本: '主仓库的 git worktree，建在仓库之外' },
  })
  tools = []
  services = {}
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
  })
  services['tools'] = { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } }
  // 宿主桩：只有"派出去了"这一件事（复用走 `sendMessage`，新起走 `start`）
  services['subagents'] = {
    list: () => ['spawn'],
    start: async () => ({ id: 'child-oneshot-1' }),
    startContinuable: async () => ({ childId: 'child-fresh-1' }),
    sendMessage: async () => ({ messageId: 'msg-1' }),
    getProvider: () => ({ capabilities: { toolFilter: true } }),
    listDescendants: async () => [],
  }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/* —————————————————————— T3-01/T3-02/T3-03：写范围相交的三档 —————————————————————— */

test('M218-01 T3-01/02/03：相交只点名（照派）；独占窗口与写范围缺失才串行；目录边界按段判', () => {
  // **T3-02 目录边界**（表驱动）：`src/a` × `src/ab` 不相交；`src/` × `src/a.ts` 相交
  const table: { name: string; ready: string[]; holder: string[]; overlap: string[]; kind: string }[] = [
    { name: '同一条路径', ready: ['src/a.ts'], holder: ['src/a.ts'], overlap: ['src/a.ts'], kind: 'merge' },
    { name: '目录 × 其下文件', ready: ['src/a.ts'], holder: ['src/'], overlap: ['src/a.ts'], kind: 'merge' },
    // 重叠路径按 `scopeOverlaps(left, right)` 取 **left** 里那条：目录范围自己就是"重叠的那个路径"
    { name: '文件 × 其所在目录', ready: ['src/'], holder: ['src/a.ts'], overlap: ['src'], kind: 'merge' },
    // 裸前缀匹配会把这行判成"相交" ⇒ 守卫必须红（`src/a` 与 `src/ab` 是两个不同的路径）
    { name: '同名前缀但不是同一路径', ready: ['src/ab'], holder: ['src/a'], overlap: [], kind: '' },
    { name: '互为文件名前缀', ready: ['src/a.tsx'], holder: ['src/a.ts'], overlap: [], kind: '' },
    { name: '不相干的目录', ready: ['src/x/'], holder: ['src/y/'], overlap: [], kind: '' },
  ]
  for (const row of table) {
    const tasks = [card('TASK-H', 'in-progress', row.holder), card('TASK-N', 'ready', row.ready)]
    const rows = scopeIntersections(tasks)
    if (row.kind === '') {
      assert.deepEqual(rows, [], `${row.name}：不相交（裸前缀匹配会在这里假报）`)
      assert.deepEqual(scopeHeldTasks(tasks), [], `${row.name}：也不得挡住`)
      continue
    }
    assert.deepEqual(
      rows.map((item) => [item.task.id, item.holder.id, item.kind, item.overlap]),
      [['TASK-N', 'TASK-H', row.kind, row.overlap]],
      `${row.name}：相交要点名（卡 / 持有者 / 处置 / 重叠路径）`,
    )
    // **T3-01 反向守卫**：`merge` 那支**不许**被挡住（挡住了 = 过度保守，用户 2026-10-22 明否）
    assert.deepEqual(scopeHeldTasks(tasks), [], `${row.name}：merge 不相交 ⇒ 不挡`)
  }

  // **T3-03 两类串行**：① 独占窗口（任一方声明）② 写范围缺失/为空（fail-closed）
  const exclusiveByHolder = [card('TASK-H', 'in-progress', ['src/x.ts'], { exclusive: 'full-suite' }), card('TASK-N', 'ready', ['src/x.ts'])]
  const exclusiveByReady = [card('TASK-H', 'in-progress', ['src/x.ts']), card('TASK-N', 'ready', ['src/x.ts'], { exclusive: 'full-suite' })]
  for (const tasks of [exclusiveByHolder, exclusiveByReady]) {
    const held = scopeHeldTasks(tasks)
    assert.equal(held.length, 1, '任一方声明独占窗口 ⇒ 串行（两边都不许跑全量）')
    assert.equal(held[0]?.kind, 'exclusive-window')
    assert.deepEqual(held[0]?.overlap, ['src/x.ts'], '串行也要点名重叠路径（回执要能照着办）')
  }
  const unknownScope = [card('TASK-H', 'in-progress', ['src/y.ts']), card('TASK-N', 'ready', [])]
  const heldUnknown = scopeHeldTasks(unknownScope)
  assert.equal(heldUnknown.length, 1, '写范围为空 ⇒ 判不了 ⇒ 串行（空集 ≠ 不相交）')
  assert.equal(heldUnknown[0]?.kind, 'unknown-scope')
  assert.deepEqual(heldUnknown[0]?.overlap, [], '判不了就不编造路径')
})

/* —————————————————————— T3-04/T3-05：worktree 生命周期与合并 —————————————————————— */

test('M218-02 T3-04 worktree 生命周期：建 → 写 → 提交 → 合并 → 清场；且副本不进主仓库索引', () => {
  const repo = makeRepo(join(BASE, 'p2', 'repo'))
  const created = createWorktree({ repoRoot: repo, taskId: 'TASK-21801' })
  assert.equal(created.ok, true, `建副本必须成功：${JSON.stringify(created).slice(0, 200)}`)
  if (!created.ok) return
  const ref = created.ref
  assert.equal(safeTaskId('TASK-21801'), 'task-21801', '卡 id 折成安全形态（分支/目录名）')
  assert.equal(ref.branch, 'sdo/task-21801')
  // **ADR-025**：副本不进索引（`AC-310` 起缺省根搬进仓库内的 `.worktrees/`，靠忽略表做到这一点）
  assert.equal(worktreeRootOf(repo), join(repo, '.worktrees'), 'AC-310：缺省副本根搬到了仓库内的 .worktrees/')
  assert.equal(isInsideRepo(repo, ref.path), true, `AC-310 之后副本在仓库内：${ref.path}`)
  assert.equal(isUnderWorktreeRoot(repo, ref.path), true, `但它落在被忽略的副本根下：${ref.path}`)
  assert.equal(ref.path.startsWith(worktreeRootOf(repo)), true, '缺省副本根 = 仓库内的 .worktrees/')
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '', '主仓库 git status 必须干净（副本不污染索引）')

  // 写 → 提交（子代理"写完了"那一步：不提交 ⇒ 合并出来是零变更假绿）
  writeFileSync(join(ref.path, 'work-a.txt'), 'a\n', 'utf8')
  const pending = existsSync(join(ref.path, 'work-a.txt'))
  assert.equal(pending, true, '夹具前提：副本里确实写了文件')
  const commit = commitWorktree({ path: ref.path, message: 'TASK-21801 work' })
  assert.equal(commit.ok, true)
  if (!commit.ok) return
  assert.equal(commit.committed, true, '有改动就必须真提交')
  assert.deepEqual(commit.files, ['work-a.txt'], '提交要交出变更清单')

  // 合并（真三路）
  const merged = mergeWorktree({ repoRoot: repo, taskId: 'TASK-21801' })
  assert.equal(merged.ok, true, `合并必须成功：${JSON.stringify(merged).slice(0, 200)}`)
  if (!merged.ok) return
  assert.equal(merged.kind, 'merged')
  assert.deepEqual(merged.changedFiles, ['work-a.txt'], '合并要交出"这次带来哪些文件变更"')
  assert.notEqual(merged.commit, '', '合并提交要落地（不是"看起来做了"）')
  assert.equal(existsSync(join(repo, 'work-a.txt')), true, '主干上要真的出现那个文件')

  // 清场
  const removed = removeWorktree({ repoRoot: repo, taskId: 'TASK-21801' })
  assert.equal(removed.ok, true, `合并后清场必须成功：${JSON.stringify(removed).slice(0, 200)}`)
  assert.equal(existsSync(ref.path), false, '副本目录要消失')
  assert.deepEqual(listWorktrees(repo).map((entry) => entry.path), [repoTopOf(repo)], '只剩主工作树（没有 worktree 残留）')

  // 反向格：副本**不许**落在仓库内（`.sdo/drafts/worktrees/` 那种旧写法）
  const inside = createWorktree({ repoRoot: repo, taskId: 'TASK-21802', root: join(repo, '.sdo', 'drafts', 'worktrees') })
  assert.equal(inside.ok, false, '落在仓库内必须拒绝（会进索引）')
  if (inside.ok) return
  assert.equal(inside.code, 'inside-repo')
})

test('M218-03 T3-03b 同文件**不同区域**必须干净合并（不得误判成冲突）', () => {
  const repo = makeRepo(join(BASE, 'p3', 'repo'))
  const created = createWorktree({ repoRoot: repo, taskId: 'TASK-21803' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const worktree = created.ref.path
  // 副本改**第 1 行**
  writeFileSync(join(worktree, 'base.txt'), 'line1-by-child\nline2\nline3\nline4\nline5\nline6\n', 'utf8')
  const commit = commitWorktree({ path: worktree, message: 'child edits line 1' })
  assert.equal(commit.ok, true)
  // 主干改**第 6 行**并提交（两边都改了同一个文件，但改的是不同区域）
  writeFileSync(join(repo, 'base.txt'), 'line1\nline2\nline3\nline4\nline5\nline6-by-main\n', 'utf8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'main edits line 6'])

  const merged = mergeWorktree({ repoRoot: repo, taskId: 'TASK-21803' })
  assert.equal(
    merged.ok,
    true,
    `同文件不同区域必须合得过去（判成冲突 = 用文件级锁替代了真三路合并）：${JSON.stringify(merged).slice(0, 300)}`,
  )
  if (!merged.ok) return
  assert.equal(merged.kind, 'merged')
  const content = readFileSync(join(repo, 'base.txt'), 'utf8')
  assert.match(content, /line1-by-child/u, '副本那一行的改动必须还在')
  assert.match(content, /line6-by-main/u, '主干那一行的改动必须还在')
})

test('M218-04 T3-05 冲突不自动解决：如实报出冲突文件 + 主工作树还原 + **现场必留**', () => {
  const repo = makeRepo(join(BASE, 'p4', 'repo'))
  const created = createWorktree({ repoRoot: repo, taskId: 'TASK-21804' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const worktree = created.ref.path
  // 两边改**同一行**（真冲突）
  writeFileSync(join(worktree, 'base.txt'), 'line1\nline2\nline3-by-child\nline4\nline5\nline6\n', 'utf8')
  const commit = commitWorktree({ path: worktree, message: 'child edits line 3' })
  assert.equal(commit.ok, true)
  writeFileSync(join(repo, 'base.txt'), 'line1\nline2\nline3-by-main\nline4\nline5\nline6\n', 'utf8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'main edits line 3'])

  const merged = mergeWorktree({ repoRoot: repo, taskId: 'TASK-21804' })
  assert.equal(merged.ok, false, '同一处竞争必须如实报冲突（不许自动解决）')
  if (merged.ok) return
  assert.equal(merged.kind, 'conflict')
  if (merged.kind !== 'conflict') return
  assert.deepEqual(merged.conflictFiles, ['base.txt'], '要点名冲突文件（不是"合并失败"四个字）')
  // 主工作树必须**还原**：冲突不许留在主干上（否则下一个会话读到半截现场）
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '', '主工作树必须干净（merge --abort 已还原）')
  assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false, '不许把"合并中"状态留在主干')
  assert.equal(readFileSync(join(repo, 'base.txt'), 'utf8').includes('line3-by-main'), true, '主干内容不许被改写')
  // **现场必留**：副本目录与分支都在
  assert.equal(existsSync(worktree), true, '冲突后副本现场必须保留（不许删）')
  assert.equal(git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/sdo/task-21804']).trim() !== '', true, '副本分支也必须留着')

  // 默认清场**不许**抹掉现场：未合并分支 ⇒ 拒
  const guarded = removeWorktree({ repoRoot: repo, taskId: 'TASK-21804' })
  assert.equal(guarded.ok, false, '未合并的分支不许被默认清场（现场必须留）')
  if (guarded.ok) return
  assert.equal(guarded.code, 'unmerged')
  assert.equal(existsSync(worktree), true, '拒了之后现场还在')
  // 只有**显式 force**（`drop` 那一路）才能删
  const forced = removeWorktree({ repoRoot: repo, taskId: 'TASK-21804', force: true })
  assert.equal(forced.ok, true, `显式 force 才允许清场：${JSON.stringify(forced).slice(0, 200)}`)
  assert.equal(existsSync(worktree), false)
})

/* —————————————————————— office 侧：建副本 → 合并 → 留事件 —————————————————————— */

test('M218-05 合并由插件在子代理侧完成并**留事件**（不需要驾驶舱代劳）；journal 只追加、.sdo 不自建仓库', () => {
  // 让工作区成为**临时 git 仓库**（演练不碰真仓库）
  git(WORKSPACE, ['init', '-q', '-b', 'main'])
  git(WORKSPACE, ['config', 'user.name', 'sdo'])
  git(WORKSPACE, ['config', 'user.email', 'sdo@localhost'])
  git(WORKSPACE, ['add', '-A'])
  git(WORKSPACE, ['commit', '-q', '-m', 'base'])
  const journalPath = join(WORKSPACE, '.sdo', 'journal.jsonl')
  const before = readFileSync(journalPath, 'utf8').split('\n').filter((line) => line.trim() !== '')

  // ① 建副本
  const prepared = office.prepareWorktree(call, 'TASK-21805')
  assert.equal(prepared.state, 'created', `派发时建副本：${JSON.stringify(prepared).slice(0, 200)}`)
  // 工作区根按 `git rev-parse --show-toplevel` 的**物理**形态取值（`WORKSPACE` 这条夹具路径在副本里会穿过软链）
  assert.equal(isInsideRepo(repoTopOf(WORKSPACE), prepared.path), true, 'AC-310 之后副本在仓库内（.worktrees/ 下）')
  assert.equal(isUnderWorktreeRoot(repoTopOf(WORKSPACE), prepared.path), true, '但它被忽略表挡在索引之外（ADR-025：不是 .sdo 下）')
  // ② 副本里写，完成时由**插件**提交 + 合并 + 清场，并留事件
  writeFileSync(join(prepared.path, 'feature-w.txt'), 'w\n', 'utf8')
  const finished = office.finishWorktree(call, { taskId: 'TASK-21805', message: 'sdo: merge TASK-21805 work' })
  assert.equal(finished.state, 'merged', `合并必须由插件执行：${JSON.stringify(finished).slice(0, 300)}`)
  if (finished.state !== 'merged') return
  assert.deepEqual(finished.changedFiles, ['feature-w.txt'], '回执要报"这次合并带来哪些文件变更"')
  assert.equal(existsSync(join(WORKSPACE, 'feature-w.txt')), true)
  assert.equal(office.worktreeFor(call, 'TASK-21805'), undefined, '合并成功后副本已清场（台账视为没有副本）')
  const types = new Set(office.journalFor(WORKSPACE).read().events.map((event) => String(event.type)))
  for (const type of ['worktree/created', 'worktree/merged', 'worktree/removed']) {
    assert.equal(types.has(type), true, `合并链路必须留事件 ${type}`)
  }

  // ③ 冲突：不自动解决、落事件、**保留现场**、且**不写任何卡状态**（调用方负责不落 done）
  writeCard(card('TASK-21806', 'in-progress', ['conf.txt'], { owner: 'developer-aaaa1111' }))
  writeFileSync(join(WORKSPACE, 'conf.txt'), 'one\ntwo\nthree\n', 'utf8')
  git(WORKSPACE, ['add', '-A'])
  git(WORKSPACE, ['commit', '-q', '-m', 'add conf'])
  const second = office.prepareWorktree(call, 'TASK-21806')
  assert.equal(second.state, 'created')
  writeFileSync(join(second.path, 'conf.txt'), 'one\nchild-change\nthree\n', 'utf8')
  writeFileSync(join(WORKSPACE, 'conf.txt'), 'one\nmain-change\nthree\n', 'utf8')
  git(WORKSPACE, ['add', '-A'])
  git(WORKSPACE, ['commit', '-q', '-m', 'main change'])
  const conflicted = office.finishWorktree(call, { taskId: 'TASK-21806' })
  assert.equal(conflicted.state, 'conflict', `同一处竞争必须报冲突：${JSON.stringify(conflicted).slice(0, 300)}`)
  if (conflicted.state !== 'conflict') return
  assert.deepEqual(conflicted.conflictFiles, ['conf.txt'])
  assert.equal(existsSync(second.path), true, '冲突后现场必须保留（供人工处置）')
  const conflictEvent = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'worktree/conflict')
  assert.equal(conflictEvent.length, 1, '冲突必须落一条事件')
  assert.deepEqual(conflictEvent[0]?.data['conflictFiles'], ['conf.txt'], '事件里要点名冲突文件')
  // 注意：`git status` 此刻**必然**有 `M .sdo/journal.jsonl`（台账随主仓库进 git，本格一直在写它 ——
  // 那正是 `ADR-025` 的口径）。所以这里判的是"**没有未解决的冲突**"与"主干内容没被改写"。
  assert.equal(git(WORKSPACE, ['diff', '--name-only', '--diff-filter=U']).trim(), '', '不许留下未解决的冲突（merge --abort 已还原）')
  assert.equal(existsSync(join(WORKSPACE, '.git', 'MERGE_HEAD')), false, '不许把"合并中"状态留在主干')
  assert.equal(readFileSync(join(WORKSPACE, 'conf.txt'), 'utf8'), 'one\nmain-change\nthree\n', '主干内容不许被冲突那一边改写')
  // 卡的状态不许被"合并失败"顺手改掉（冲突时零写盘，由 done 的回执拒绝）
  assert.equal(office.taskById(call, 'TASK-21806')?.status, 'in-progress', '冲突时不许改卡状态')

  // ④ `drop` 那一路：显式 force 才能清场
  const dropped = office.dropWorktree(call, 'TASK-21806', true)
  assert.equal(dropped.state, 'removed', `drop 要能清场：${JSON.stringify(dropped).slice(0, 200)}`)
  assert.equal(existsSync(second.path), false)

  // ⑤ **journal 仍是唯一真源**：只追加，前面每一行逐字不变（任何重写/压缩都是不许的）
  const after = readFileSync(journalPath, 'utf8').split('\n').filter((line) => line.trim() !== '')
  assert.ok(after.length > before.length, '这期间必须有新事件（否则本格没咬住）')
  assert.deepEqual(after.slice(0, before.length), before, 'journal 只许追加：已有行必须逐字不变')
  // ⑥ **`.sdo/` 不自建 git 仓库**（ADR-025）
  assert.equal(existsSync(join(WORKSPACE, '.sdo', '.git')), false, '.sdo 下不许有 .git（台账随主仓库进 git）')
  assert.equal(repoTopOf(join(WORKSPACE, '.sdo')), repoTopOf(WORKSPACE), '.sdo 属于主仓库，不是独立仓库')
})

/* —————————————————————— T3-06：owner 形态、唯一性、C-52 —————————————————————— */

test('M218-06 T3-06 owner = 角色-8位uuid；**一个 owner 只对应一个会话**（反例格：同 owner 两会话必红）', () => {
  // ① 形态（`ADR-022` 裁决③）
  const sessionA = 'e4d9fbaf-1111-4111-8111-111111111111'
  const sessionB = 'ebcd8a06-2222-4222-8222-222222222222'
  assert.equal(OWNER_SESSION_LENGTH, 8)
  assert.equal(ownerOf('developer', sessionA), 'developer-e4d9fbaf')
  assert.notEqual(ownerOf('developer', sessionA), ownerOf('developer', sessionB), '同角色不同会话 ⇒ owner 必须不同')
  assert.equal(ownerFormOf('developer-e4d9fbaf'), 'role-session', '新形态')
  assert.equal(ownerFormOf('subagent:developer:1'), 'subagent-slot', '历史形态读侧兼容（不迁移）')
  assert.equal(ownerFormOf('cockpit'), 'cockpit')
  assert.equal(ownerRoleOf('developer-e4d9fbaf'), 'developer')

  // ② 认领面：owner 由**本会话 uuid 现算**（不采信自报槽位名）
  writeCard(card('TASK-21807', 'ready', ['src/o1.ts']))
  office.noteSession(sessionA, WORKSPACE)
  const first = office.claimTask({ sessionId: sessionA, cwd: WORKSPACE } as unknown as OfficeCall, {
    taskId: 'TASK-21807',
    owner: 'developer',
    expectedRevision: 1,
  })
  assert.equal(first.ok, true, `夹具前提：新形态认领要成功（${JSON.stringify(first).slice(0, 200)}）`)
  assert.equal(first.task?.owner, 'developer-e4d9fbaf', '卡上的 owner 要落成「角色-8位uuid」')

  // ③ 反例格（`DEF-165` ② / `DEF-133`）：**同一个 owner 串被两个不同会话共用** ⇒ 必须拒
  //    真机形态：`subagent:developer:1` 同时指过 `e4d9fbaf` 与 `ebcd8a06`（槽位名被复用）。
  office.noteSession('s1', WORKSPACE)
  office.noteSession('s2', WORKSPACE)
  writeCard(card('TASK-21808', 'ready', ['src/o2.ts']))
  const legacyFirst = office.claimTask(call, { taskId: 'TASK-21808', owner: 'subagent:developer:1', expectedRevision: 1 })
  assert.equal(legacyFirst.ok, true, '历史形态在**同一个会话**里照旧可用（读侧兼容）')
  writeCard(card('TASK-21809', 'ready', ['src/o3.ts']))
  const clash = office.claimTask({ sessionId: 's2', cwd: WORKSPACE } as unknown as OfficeCall, {
    taskId: 'TASK-21809',
    owner: 'subagent:developer:1',
    expectedRevision: 1,
  })
  assert.equal(clash.ok, false, `同一 owner 串被第二个会话使用 ⇒ 必须拒（否则投递会同时唤醒两个人）；`)
  if (clash.ok) return
  assert.match(clash.detail, /subagent:developer:1/u, '要点名那个 owner 串')
  assert.match(clash.detail, /s1/u, '要点名它已经被哪个会话用过')
  assert.match(clash.detail, /角色-8位uuid|角色-8 位|角色/u, '要给出新形态这条可执行修法')
  assert.equal(office.taskById(call, 'TASK-21809')?.status, 'ready', '被拒的认领零写盘（卡状态不动）')
  assert.equal(office.taskById(call, 'TASK-21809')?.owner ?? '', '', '被拒的认领不许占 owner')
  const rejection = office.journalFor(WORKSPACE).read().events.filter(
    (event) => event.type === 'task/claim-rejected' && event.data['id'] === 'TASK-21809',
  )
  assert.equal(rejection.length, 1, '拒签要留追加式留痕')
  assert.equal(rejection[0]?.data['cause'], 'owner-collision', '原因要可数（不是一句人话）')

  // ④ 读数（可定位性）：一条 owner 对应一个会话时不出行；两个会话 ⇒ 出行并点名
  assert.deepEqual(ownerSessionCollisions([]), [])
  assert.deepEqual(
    ownerSessionCollisions([{ owner: 'developer-aaaa1111', sessionId: 'sess-x', taskId: 'TASK-1' }]),
    [],
    '一对一 ⇒ 不出行',
  )
  const collisions = ownerSessionCollisions([
    { owner: 'subagent:developer:1', sessionId: 'e4d9fbaf', taskId: 'TASK-1' },
    { owner: 'subagent:developer:1', sessionId: 'ebcd8a06', taskId: 'TASK-2' },
  ])
  assert.deepEqual(collisions, [{ owner: 'subagent:developer:1', sessions: ['e4d9fbaf', 'ebcd8a06'], taskIds: ['TASK-1', 'TASK-2'] }])
  // 两个门槛各有用途（同一份实现，`minSessions` 不同）：
  //   · **认领面用 1** —— 问"这个串被哪些会话用过"（于是第二次认领当场被拦，不用等两个会话都占下来）；
  //   · **回执/诊断用 2** —— 只报"已经脏了"的 owner。
  const users = office.ownerCollisions(call, 1).find((row) => row.owner === 'subagent:developer:1')
  assert.deepEqual(users?.sessions, ['s1'], '门槛 1：这个串被 s1 用过（第二次认领因此被拒）')
  assert.equal(
    office.ownerCollisions(call).some((row) => row.owner === 'subagent:developer:1'),
    false,
    '门槛 2：现盘**没有**"一 owner 多会话"的脏记录 —— 这正是本条守卫生效的读数',
  )
  // 反向格：**历史**已经脏了（老台账不迁移、也不许改写）⇒ 门槛 2 必须把它读出来（可见，而不是靠记忆）
  office.journalFor(WORKSPACE).append('task/claimed', { id: 'TASK-21815', owner: 'subagent:developer:1', sessionId: 'ebcd8a06' })
  const dirty = office.ownerCollisions(call).find((row) => row.owner === 'subagent:developer:1')
  assert.deepEqual(dirty?.sessions, ['ebcd8a06', 's1'], '历史脏数据必须可见（同一个 owner 串两个会话）')
})

test('M218-07 T3-06（连带）C-52 名字回退按**角色前缀**比较（口径 A1）', () => {
  // ① 口径本身
  assert.equal(ownerRolesEqual('developer-20af1d60', 'developer-ebcd8a06'), true, '同角色不同会话 ⇒ 判自评（保守方向）')
  assert.equal(ownerRolesEqual('developer-20af1d60', 'tester-ebcd8a06'), false, '换角色 ⇒ 独立')
  assert.equal(ownerRolesEqual('developer-20af1d60', 'developer-20af1d60'), true, '同名当然自评')
  assert.equal(ownerRolesEqual('dev-a', 'developer-20af1d60'), false, '认不出角色 ⇒ 退回逐字比较（不猜）')
  assert.equal(ownerRolesEqual('cockpit', 'office'), false, '两个流程侧角色不是同一个')

  // ② 行为面（`C-52`）：材料不全（评审没记会话 uuid）⇒ 名字回退，且按角色前缀判
  const tasks = [card('TASK-218031', 'done', ['src/c1.ts'], { owner: 'developer-bbbb2222' })]
  const review = { id: 'REV-218', taskId: 'TASK-218031', reviewer: 'developer-aaaa1111', verdict: 'pass' as const, findings: ['f'], at: '2026-10-22T00:00:00.000Z' }
  const selfReview = independenceAudit([review], tasks)
  assert.equal(selfReview.violations.length, 1, '同一角色的两个 uuid ⇒ 判自评（该红的必须红）')
  const crossRole = independenceAudit([{ ...review, id: 'REV-219', reviewer: 'tester-cccc3333' }], tasks)
  assert.equal(crossRole.violations.length, 0, '换角色 ⇒ 判独立（不许一律判自评）')
  // 反向（不得放宽）：材料齐时 **uuid 说了算**，名字根本不参与
  const bySession = independenceAudit([{ ...review, sessionId: 'sess-independent' }], tasks, new Map([['TASK-218031', ['sess-author']]]))
  assert.equal(bySession.violations.length, 0, '不同会话 + 记了 sessionId ⇒ 独立（哪怕名字同角色）')
})

/* —————————————————————— DEF-165 ①：观测落盘 + 复用判据 —————————————————————— */

test('M218-08 DEF-165① 观测**落事件**，且复用判据读得到它、回执写明「依据哪条观测」', async () => {
  const childSessionId = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000'
  // ① 观测落**两个**地方：证据原件 + **台账事件**（修前只有前者 ⇒ 复用判据结构性拿不到证据）
  office.noteChildFace(call, { childSessionId, tools: ['bash', 'edit', 'read'], violations: [], calls: [], callCount: 0 })
  const events = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'dispatch/observed')
  assert.equal(events.length, 1, '必须新增 `dispatch/observed` 事件（含 observ 的事件类型计数不许再是 0）')
  assert.equal(events[0]?.data['childSessionId'], childSessionId)
  assert.equal(events[0]?.data['toolCount'], 3, '被公告的工具数')
  assert.equal(events[0]?.data['deniedOutsideCount'], 0, '掩码外调用数')
  assert.equal(typeof events[0]?.data['observedAt'], 'string', '观测时刻')
  const observed = office.childObservations(call).find((row) => row.childSessionId === childSessionId)
  assert.ok(observed !== undefined)
  assert.ok(observed.seq > 0, '观测要带可引用的序号')

  // ② 池里有这个**已结算**的可续聊子会话 ⇒ R-1 判据必须读到刚才那条观测 ⇒ **允许复用**
  poolChildOf(childSessionId, 'TASK-21811')
  writeCard(card('TASK-21812', 'ready', ['src/r2.ts']))
  const admission = office.poolPlan(call, { reuseIdle: true })
  const entry = admission.dispatch.find((item) => item.task.id === 'TASK-21812')
  assert.equal(entry?.reuseChildId, childSessionId, '有观测证据 ⇒ 复用（修前这里永远是新起）')

  // ③ 回执面：同一角色连派两张卡，第二张要写清「复用 + 依据哪条观测」
  const receipt = await callTool('sdo_plan', { action: 'next', limit: 1 })
  assert.match(receipt, /复用/u, `回执必须写明复用：${receipt.slice(0, 400)}`)
  assert.match(receipt, /dispatch\/observed/u, '回执必须引用观测事件（依据哪条）')
  assert.match(receipt, new RegExp(`seq=\\s*${observed.seq}`, 'u'), `回执要写明观测的事件序号：${receipt.slice(0, 600)}`)
  // owner 也要按新形态印出来（`ADR-022` 裁决③）
  assert.match(receipt, new RegExp(`${ownerOf('developer', childSessionId)}`, 'u'), '回执要印「角色-8位uuid」')
  // 真源里那笔派发记的也是新形态 owner
  const started = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'dispatch/started').at(-1)
  assert.equal(started?.data['owner'], ownerOf('developer', childSessionId), 'dispatch/started.owner = 角色-8位uuid')
  assert.equal(started?.data['reused'], true, '复用要留痕')
})

test('M218-09 DEF-165① 反例：**没有**观测证据 ⇒ 不复用（强制新起），且原因点名"没有观测"', async () => {
  const childSessionId = 'bbbb2222-cccc-4ddd-8eee-ffff00001111'
  poolChildOf(childSessionId, 'TASK-21813')
  writeCard(card('TASK-21814', 'ready', ['src/r4.ts']))
  // 池视图：不可复用的空闲会话要**单列并给原因**（不占"可复用"位）
  const pool = office.poolView(call).find((row) => row.role === 'developer')
  assert.ok(pool !== undefined)
  assert.equal(pool.idle.some((child) => child.childSessionId === childSessionId), false, '没有观测 ⇒ 不许进"可复用"')
  assert.equal(
    pool.unusable.some((row) => row.childSessionId === childSessionId && /观测|observation/iu.test(row.reason)),
    true,
    `不可复用的原因要点名"没有观测证据"：${JSON.stringify(pool.unusable)}`,
  )
  const admission = office.poolPlan(call, { reuseIdle: true })
  const entry = admission.dispatch.find((item) => item.task.id === 'TASK-21814')
  assert.equal(entry?.reuseChildId, undefined, '没有证据 ⇒ 强制新起（R-1：观测不到就不复用）')
  const receipt = await callTool('sdo_plan', { action: 'next', limit: 1 })
  assert.match(receipt, /不复用/u, `回执必须写"不复用"：${receipt.slice(0, 400)}`)
  assert.match(receipt, /dispatch\/observed/u, '并说明依据面（没有任何可引用的观测）')
})

/* —————————————————————— 防回退（结构面） —————————————————————— */

test('M218-10 防回退：合并**不自动解决**、唯一出口不旁落、done 路径接上插件合并', () => {
  const worktree = readFileSync(join(ROOT, 'src', 'integration', 'worktree.ts'), 'utf8')
  // 只扫**代码行**（注释里引用 `-X ours/theirs` 是正当的：它正是在说"不许"）
  const code = worktree
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
    .join('\n')
  assert.equal(/-X\b|--theirs|--strategy=ours/u.test(code), false, '不许出现 -X/--theirs（自动解决冲突 = 掩盖现场）')
  assert.equal(/['"]init['"]/u.test(code), false, '.sdo 不自建 git 仓库（ADR-025）：本模块不许调 git init')
  assert.match(code, /'merge', '--no-ff', '--no-commit'/u, '合并必须是真三路（--no-ff）+ 留住"合并中"状态判冲突')
  assert.match(code, /'merge', '--abort'/u, '冲突后主工作树必须还原')
  assert.match(code, /'worktree', 'add'/u, '副本 = 主仓库的 git worktree')
  assert.match(code, /'worktree', 'remove'/u, '清场走 git worktree remove')

  // 派发面与认领面**同一份判定**（分叉就会出现"派得出来、认领不了"= DEF-067）
  const plan = readFileSync(join(ROOT, 'src', 'domain', 'plan.ts'), 'utf8')
  assert.match(plan, /export function scopeSerialKindOf\(/u, '串行判定要有唯一出口')
  assert.match(plan, /export function scopeIntersections\(/u, '相交分类要有唯一出口')
  const collab = readFileSync(join(ROOT, 'src', 'domain', 'collab.ts'), 'utf8')
  assert.match(collab, /scopeIntersections\(listTasks\(store\)\)/u, '认领面必须走同一份相交分类')
  assert.match(collab, /scopeSerialKindOf|row\.kind !== 'merge'/u, '认领面只对**串行**那两类拒签')

  // 合并由**插件**在完成路径上执行（不需要驾驶舱人工代劳）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /office\.finishWorktree\(call, \{ taskId: args\.id/u, '`done` 必须先合并后结算')
  assert.match(index, /office\.prepareWorktree\(call, task\.id\)/u, '派发时要建工作副本')
  assert.match(index, /office\.reuseEvidence\(call, outcome\.childSessionId\)/u, '回执要引用观测事件作为复用依据')

  // 语言包：两包都要有这批新文案（缺一条就会漏出键名）
  for (const name of ['zh-CN.yml', 'en.yml']) {
    const lang = readFileSync(join(ROOT, 'src', 'data', 'lang', name), 'utf8')
    for (const key of [
      'kWorktreeCreated',
      'kWorktreeMerged',
      'kWorktreeMergeConflict',
      'kWorktreeRemoved',
      'kReuseEvidence',
      'kOwnerCollision',
      'kDispatchScopeMergeLine',
      'kDispatchUnknownScopeLine',
    ]) {
      assert.match(lang, new RegExp(`${key}:`, 'u'), `${name} 缺 ${key}`)
    }
  }
})
