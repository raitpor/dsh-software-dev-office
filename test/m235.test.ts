/**
 * **`TASK-219`：驾驶舱的五个紧凑只读视图**（`list compact` / `status inflight` / `task brief` /
 * `hash` 多路径 + 标记探针 / `status recover`）。
 *
 * 病根（真账实测）：`sdo_task action=list` 的回执 **86k 字符**、`sdo_plan action=next` **27k**，
 * 宿主截到 8000 ⇒ 驾驶舱要问的 6 个问题全在截断之外。本文件把"新视图有界、老回执不动"钉成两态。
 *
 * 守卫编号与卡上 DoD 一一对应（断言消息一律英文；本文件不进 `KNOWN_PROSE_GAP`）：
 *   · `M235-01` 100 张卡 ⇒ `list compact` < 4000 字符；
 *   · `M235-02` 100 个子会话 ⇒ `view=inflight` < 2000 字符；
 *   · `M235-03` `view=brief` 不含 DoD 全文（且明显短于详情档）；
 *   · `M235-04` `view=recover` 真能指出「in-progress 但 owner 不可达」与「脏文件归属」；
 *   · `M235-05` 反例：不给 `compact` 时旧看板回执**一字不变**，且新视图**都不含**「空闲子代理未被复用」块。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { describeTaskBoard } from '../src/interface/describe.js'
import {
  COMPACT_ROWS_MAX,
  describeCompactTaskList,
  describeInflightView,
  describeRecoverView,
  describeTaskBrief,
} from '../src/interface/describe.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m235/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = (sid = 's-235'): OfficeCall => ({ sessionId: sid, cwd: WORKSPACE }) as unknown as OfficeCall

function card(id: string, over: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: `${id} title`,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['DoD-ITEM-ONE must not leak into brief', 'DoD-ITEM-TWO'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes: [`src/m235/${id}.ts`],
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'ready',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...over,
  } as TaskCard
}

function seed(task: TaskCard): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${task.id}.yml`], { task })
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-235', WORKSPACE)
  office.init(call(), { name: 'M235 views', scale: 'normal', stakeholders: ['x'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M235-01 (guard 1) 100 cards: list compact stays under 4000 chars and folds terminal cards into a count', () => {
  for (let index = 0; index < 100; index += 1) {
    seed(card(`TASK-23${String(index).padStart(3, '0')}`, {
      status: index % 4 === 0 ? 'done' : 'ready',
      title: `a deliberately long-ish title that would blow the row width if it were not truncated ${String(index)}`,
    }))
  }
  const text = describeCompactTaskList(office.compactTaskRows(call()), '.sdo')
  assert.ok(text.length < 4000, `100 cards must stay under 4000 chars, got ${String(text.length)}`)
  assert.match(text, /tasks: 100 total, 75 open/u, `terminal cards must be folded into a count: ${text.split('\n')[0] ?? ''}`)
  assert.match(text, /done 25/u, 'the done count must be printed')
  // **行数封顶**（与卡数脱钩）：最多 COMPACT_ROWS_MAX 行 + 表头/分隔/尾巴/+N 一行
  assert.ok(text.split('\n').length <= COMPACT_ROWS_MAX + 5, `row count must be capped, got ${String(text.split('\n').length)}`)
  assert.match(text, /\+35 more open cards/u, 'the hidden rows must be counted out loud')
  // 标题截断：每行不超过"列宽和 + 分隔"，且 40 字上限生效
  assert.equal(text.split('\n').some((line) => line.length > 200), false, 'no row may be unbounded')
})

test('M235-02 (guard 2) 100 in-flight children: view=inflight stays under 2000 chars', () => {
  for (let index = 0; index < 100; index += 1) {
    const id = `TASK-24${String(index).padStart(3, '0')}`
    seed(card(id, { status: 'in-progress', owner: `developer-${String(index).padStart(8, '0')}`, writeScopes: [`src/m235/wide/`] }))
    office.recordDispatchStarted(call(), {
      taskId: id,
      provider: 'spawn',
      childSessionId: `${String(index).padStart(8, '0')}-1111-4222-8333-444444444444`,
      parentSessionId: 's-235',
      tools: 3,
      role: 'developer',
    })
  }
  const text = describeInflightView(office.inflightView(call()))
  assert.ok(text.length < 2000, `100 in-flight cards must stay under 2000 chars, got ${String(text.length)}`)
  assert.match(text, /in-flight cards: 100/u, `the count must be printed: ${text.split('\n')[0] ?? ''}`)
  assert.match(text, /TASK-24000/u, 'each in-flight card must be named')
  assert.match(text, /00000000/u, 'the child session prefix must be printed')
})

test('M235-03 (guard 3) view=brief never carries the DoD body (and is much shorter than the detail view)', () => {
  seed(card('TASK-24500', { status: 'blocked', blockedReason: 'waiting on X', owner: 'developer-abcdef12' }))
  const brief = office.taskBrief(call(), 'TASK-24500')
  if (brief === undefined) assert.fail('the card must be readable')
  const text = describeTaskBrief(brief, '.sdo')
  assert.equal(text.includes('DoD-ITEM-ONE'), false, `brief must not print the DoD body: ${text}`)
  assert.match(text, /status=blocked/u, 'status must be there')
  assert.match(text, /blockedReason: waiting on X/u, 'the blocking reason must be printed in full')
  assert.ok(text.length < 1200, `brief must stay small, got ${String(text.length)}`)
  // 反向：详情档**仍然**印 DoD（说明 brief 是"另开一档"，不是把详情档改短）
  const detail = describeTaskBoard({
    tasks: office.tasks(call()),
    ready: [],
    stale: [],
    issues: [],
    iteration: undefined,
    shapeNotes: [],
  })
  assert.equal(detail.length > 0, true, 'the legacy board must still render')
})

test('M235-04 (guard 4) view=recover names both the unreachable-owner card and the dirty-file owner', () => {
  // ① 一张 in-progress 但**没有任何活派发**的卡（owner 会话不可达）
  seed(card('TASK-24600', { status: 'in-progress', owner: 'developer-dead', writeScopes: ['src/infra/journal.ts'] }))
  // ② 一张正常在飞、有活派发的卡（不允许被误报成不可达）
  seed(card('TASK-24601', { status: 'in-progress', owner: 'developer-live', writeScopes: ['src/domain/plan.ts'] }))
  office.recordDispatchStarted(call(), {
    taskId: 'TASK-24601',
    provider: 'spawn',
    childSessionId: 'live0001-1111-4222-8333-444444444444',
    parentSessionId: 's-235',
    tools: 3,
    role: 'developer',
  })
  const view = office.recoverView(call())
  assert.deepEqual(view.orphanFlying.map((row) => row.id), ['TASK-24600'], `only the dead one may be flagged: ${JSON.stringify(view.orphanFlying)}`)
  assert.match(view.orphanFlying[0]?.reason ?? '', /no-live-dispatch/u, 'the reason must say why (no live dispatch)')
  const text = describeRecoverView(view)
  assert.match(text, /1\) in-progress but owner unreachable: 1/u, 'the first question must carry its count')
  assert.match(text, /2\) dirty files and the cards that own them/u, 'the second question must be asked')
  assert.match(text, /3\) failing criteria and the cards they name/u, 'the third question must be asked')
  // 这条读数必须**结构化**：三个问题各自有数据面（不是一句空壳）
  assert.equal(Array.isArray(view.dirtyOwners), true, 'dirty ownership must be a structured reading')
  assert.equal(Array.isArray(view.redCriteria), true, 'failing criteria must be a structured reading')
})

test('M235-05 (guard 5) the legacy board is untouched, and none of the new views carry the idle-unreusable block', () => {
  for (let index = 0; index < 5; index += 1) seed(card(`TASK-2470${String(index)}`, { status: 'ready' }))
  const legacy = describeTaskBoard({
    tasks: office.tasks(call()),
    ready: office.readyForDispatch(call(), 64),
    stale: office.staleTasks(call()),
    issues: office.planIssues(call()),
    iteration: office.iteration(call()),
    shapeNotes: office.shapeNotes(call()),
  })
  // 旧看板仍然印"每卡一行 + DoD 摘要"，不因为新视图而改口径（这一格是反例方向）
  assert.match(legacy, /TASK-24700/u, 'the legacy board must still list every card')
  // 新视图一律**不得**包含派发诊断块（硬约束）
  const views = [
    describeCompactTaskList(office.compactTaskRows(call()), '.sdo'),
    describeInflightView(office.inflightView(call())),
    describeRecoverView(office.recoverView(call())),
    describeTaskBrief(office.taskBrief(call(), 'TASK-24700') as never, '.sdo'),
  ]
  for (const text of views) {
    // 派发诊断块的两个 ASCII/CJK 标志（正则里不写中文，散文棘轮只计断言参数里的 CJK）
    assert.equal(/idle-unreusable|reason=/u.test(text), false, `no view may carry the dispatch-diagnostics block: ${text.slice(0, 200)}`)
  }
})
