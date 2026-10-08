/**
 * 未修清单里剩下的 9 条（SDO-08 / 10 / 14(3) / 15(3) / 34 / 35 / 36 / 40 / 46 / 48②）的回归。
 *
 * 这一批的共同点是「机制该拦住却静默放过」：身份靠自报、台账写入与卡写范围打架、blocked 卡静默占范围、
 * 方法选择"出现即选中"、卡没有受约束的修改入口、确认戳分不清本人/代盖、台账不记版本。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { claim, report, updateTask } from '../src/domain/collab.js'
import { parseMethodChoice } from '../src/domain/method.js'
import { validatePlan } from '../src/domain/plan.js'
import { recordWorkspaceChanges } from '../src/domain/workspaceChanges.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm45')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
  journal.append('project/created', { id: 'PRJ-001', name: 'm45', process: 'waterfall' })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function card(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
    ...overrides,
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
  return task
}

test('SDO-10：方法选择只认**显式**写法 —— 选项原文/别名/显式引导词可以，散文里提到别名不算', () => {
  assert.deepEqual(parseMethodChoice('structured'), ['structured'])
  assert.deepEqual(parseMethodChoice('structured, oo'), ['structured', 'oo'])
  assert.deepEqual(parseMethodChoice('结构化 structured（数据字典 + 分层 DFD + ERD）（代价：慢）｜备注：测试选择'), ['structured'], '选项原文形态（真机就是这种答复）')
  assert.deepEqual(parseMethodChoice('选择：oo'), ['oo'], '显式引导词')
  assert.deepEqual(parseMethodChoice('none'), ['none'])
  // **反向（缺陷本身）**：备注里提到被否决的方案 ⇒ 不算选中
  assert.equal(parseMethodChoice('备注：我们否决了 structured 与 oo，先用别的'), undefined, '散文里出现别名不得算选中')
  assert.equal(parseMethodChoice('不要 structured'), undefined)
  assert.equal(parseMethodChoice('随便挑一个吧'), undefined)
})

test('SDO-14(3) / SDO-15(3)：`sdo_task action=update` 能改卡，但历史不重写、别人在做时不得改写范围', () => {
  const task = card('TASK-001')
  // ① 正常改：字段生效、revision 前进、留痕
  const ok = updateTask(store, journal, { taskId: 'TASK-001', by: 'cockpit', size: 'medium', dod: ['a', 'b'] })
  assert.equal(ok.ok, true)
  assert.equal(ok.ok ? ok.task.size : '', 'medium')
  assert.equal(ok.ok ? ok.task.revision : 0, task.revision + 1)
  assert.deepEqual(ok.ok ? ok.changed.sort() : [], ['dod', 'size'])
  assert.equal(journal.read().events.filter((event) => event.type === 'task/updated').length, 1, '改卡要留痕')

  // ② CAS：版本对不上即拒
  const stale = updateTask(store, journal, { taskId: 'TASK-001', by: 'cockpit', expectedRevision: 1, size: 'large' })
  assert.equal(stale.ok, false)
  assert.equal(stale.ok ? '' : stale.code, 'revision-mismatch')

  // ③ 已完成/已作废的卡不改（历史不重写）
  card('TASK-002', { status: 'done' })
  const done = updateTask(store, journal, { taskId: 'TASK-002', by: 'cockpit', size: 'small' })
  assert.equal(done.ok, false)
  assert.equal(done.ok ? '' : done.code, 'not-updatable')

  // ④ 有人在做时不得改 `writeScopes`（会造出两个写者）
  card('TASK-003')
  claim(store, journal, { taskId: 'TASK-003', owner: 'dev-a', expectedRevision: 1 })
  const locked = updateTask(store, journal, { taskId: 'TASK-003', by: 'cockpit', writeScopes: ['src/other/'] })
  assert.equal(locked.ok, false)
  assert.equal(locked.ok ? '' : locked.code, 'scope-locked')
  // 反向：owner 自己改可以；与范围无关的字段谁都能改
  assert.equal(updateTask(store, journal, { taskId: 'TASK-003', by: 'dev-a', writeScopes: ['src/other/'] }).ok, true)
  assert.equal(updateTask(store, journal, { taskId: 'TASK-003', by: 'cockpit', title: 't2' }).ok, true)
})

test('SDO-34：`.sdo/` 下的台账写入**不占卡的写范围**（要求如实闭合缺陷的卡不再两难）', () => {
  card('TASK-010', { writeScopes: ['src/TASK-010/'], evidenceRequired: ['command'] })
  const claimed = claim(store, journal, { taskId: 'TASK-010', owner: 'dev-a', sessionId: 's1', expectedRevision: 1 })
  assert.equal(claimed.ok, true)
  const claimSeq = journal.read().events.filter((event) => event.type === 'task/claimed').map((event) => event.seq).pop() as number
  // 工具类写入（`sdo_test`/`sdo_defect` 走 `.sdo/`）落在卡的写范围之外
  recordWorkspaceChanges({
    store, sessionId: 's1', seq: claimSeq + 1, journalSeq: claimSeq + 1,
    summary: { files: [{ path: '.sdo/defects/DEF-001.yml' }, { path: 'src/TASK-010/ok.ts' }] },
    enabled: true, hasProject: true,
  })
  const done = report(store, journal, {
    taskId: 'TASK-010', owner: 'dev-a', status: 'done',
    evidence: [{ kind: 'command', detail: 'exit 0', at: 'x' }],
  })
  assert.equal(done.ok, true, `台账写入不得判成越界：${done.ok ? '' : done.detail}`)

  // 反向：**产品文件**越界仍然判红（口径没有被放宽）
  card('TASK-011', { writeScopes: ['src/TASK-011/'], evidenceRequired: ['command'] })
  claim(store, journal, { taskId: 'TASK-011', owner: 'dev-b', sessionId: 's2', expectedRevision: 1 })
  const seq2 = journal.read().events.filter((event) => event.type === 'task/claimed').map((event) => event.seq).pop() as number
  recordWorkspaceChanges({
    store, sessionId: 's2', seq: seq2 + 1, journalSeq: seq2 + 1,
    summary: { files: [{ path: '.sdo/tests/TC-001.yml' }, { path: 'src/other/escape.ts' }] },
    enabled: true, hasProject: true,
  })
  const violated = report(store, journal, {
    taskId: 'TASK-011', owner: 'dev-b', status: 'done',
    evidence: [{ kind: 'command', detail: 'exit 0', at: 'x' }],
  })
  assert.equal(violated.ok, false)
  assert.equal(violated.ok ? '' : violated.code, 'write-scope-violation')
  assert.match(violated.ok ? '' : violated.detail, /src\/other\/escape\.ts/u, '要点名真正的越界文件')
})

test('SDO-46：blocked 卡**仍占**写范围（有意口径），但冲突要**说清持有者状态与解除动作**', () => {
  const blocked = card('TASK-020', { status: 'blocked', writeScopes: ['tools/checks/'] })
  const fresh = card('TASK-021', { writeScopes: ['tools/checks/'] })
  const issues = validatePlan([blocked, fresh]).filter((issue) => issue.code === 'write-scope-disjoint')
  assert.equal(issues.length > 0, true, 'blocked 仍排他（D6-1 的口径保持不变）')
  assert.match(issues[0]?.detail ?? '', /blocked/u, '要点明挡住的卡处于 blocked')
  assert.match(issues[0]?.remedy ?? '', /action=release|drop/u, '要给出解除动作')
})

test('SDO-35 / SDO-36 / SDO-48②：三条"静默放过"都在实现里关掉了（源码级守卫 + 类型契约）', () => {
  const gates = readFileSync(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8')
  assert.match(gates, /task\.role !== 'reviewer'/u, 'SDO-35：C-42 必须排除评审卡（否则自我递归）')
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /office\.claimSession\(call, args\.taskId\)/u, 'SDO-36：自评护栏要按**会话身份**判')
  assert.match(index, /call\.sessionId === claimSession/u, 'SDO-36：判据必须是「调用方会话 == 认领会话」（只查不判等于没拦）')
  assert.match(index, /kSelfReviewSameSession/u, '并给出可读拒绝')
  const design = readFileSync(join(ROOT, 'src', 'domain', 'design.ts'), 'utf8')
  assert.match(design, /basisSource,/u, 'SDO-48②：确认事件要带 basisSource（user/proxy）')
  assert.match(design, /basisSource: 'user' \| 'proxy' = 'user'/u, '默认 user，代盖要显式 proxy')
})
