/**
 * **增量 198：卡的生命周期不可逆性（第十三批 §1.2 `DEF-118`）。**
 *
 * 真机事故：驾驶舱把校验器 `write-scope-empty` 的提示误读成"废卡证据"，对 **8 张已完成 reviewer 卡**
 * 连发 8 次 `drop` ⇒ 全部成功、零警告，卡面 status 被覆盖成 dropped；而 `TASK_ACTIONS` 里没有 undo
 * ⇒ **结构上只能向下、不能向上**。本文件钉四件事：
 *   ① 已完成卡（done / verified）**不许 drop**（拒并给两条确定出路）；
 *   ② 未落地卡可 drop，且**卡面 evidence 不被清空**（history 与 status 无关）；
 *   ③ `reopen`（done/verified → in-progress）必须带 reason + approvedBy，落 `task/reopened`；
 *   ④ `restore`（dropped → 上一状态）必须带 reason + approvedBy，落 `task/restored`；老 drop 事件没有
 *      `previousStatus` ⇒ 回 `ready` 并如实记来源。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { dropTaskChecked, reopenTask, restoreTask, writeTask } from '../src/domain/plan.js'
import type { TaskCard } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm198')
let store: SdoStore
let journal: Journal

function card(id: string, status: TaskCard['status'], over: Partial<TaskCard> = {}): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'small', revision: 1, status,
    requirements: [], evidence: [], createdAt: '', updatedAt: '', ...over,
  } as TaskCard
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M198-01 §1.2（`DEF-118`）已完成卡**不许 drop**：拒 + 两条确定出路；卡面 status / revision / evidence 一律不动', () => {
  const evidence = [{ kind: 'workspace-changes' as const, detail: '写了一个文件', at: '' }]
  for (const status of ['done', 'verified'] as const) {
    const id = `TASK-91${status === 'done' ? 1 : 2}`
    writeTask(store, card(id, status, { evidence }))
    const before = journal.read().events.length
    const outcome = dropTaskChecked(store, journal, id, '误读提示为废卡')
    assert.equal(outcome.ok, false, `${status} 卡不许 drop`)
    if (!outcome.ok) {
      assert.equal(outcome.code, 'settled', '拒绝码必须是 settled')
      assert.match(outcome.detail, /reopen/u, '出路 ① 必须点名 reopen')
      assert.match(outcome.detail, /update/u, '出路 ② 必须点名 update（补字段，不要抹掉完成态）')
    }
    assert.equal(journal.read().events.length, before, '被拒时**零写盘**（不落 task/dropped）')
    const after = store.readYaml<{ task: TaskCard }>('tasks', `${id}.yml`)?.task
    assert.equal(after?.status, status, '卡面状态不许被覆盖')
    assert.equal(after?.revision, 1, 'revision 不许动')
    assert.equal((after?.evidence ?? []).length, 1, 'evidence 不许丢')
  }
})

test('M198-02 §1.2（`DEF-118`）未落地卡可 drop：落 `task/dropped`（带 previousStatus）且**不清空 evidence**', () => {
  const evidence = [{ kind: 'command' as const, detail: 'node --test ⇒ 3 pass', at: '' }]
  writeTask(store, card('TASK-921', 'planned', { evidence }))
  const outcome = dropTaskChecked(store, journal, 'TASK-921', '建错了')
  assert.equal(outcome.ok, true, '未落地卡必须可 drop')
  if (outcome.ok) assert.equal(outcome.card.status, 'dropped')
  const event = journal.read().events.filter((item) => item.type === 'task/dropped').at(-1)
  assert.equal(event?.data['previousStatus'], 'planned', 'drop 事件必须记下来源状态（restore 要用）')
  const after = store.readYaml<{ task: TaskCard }>('tasks', 'TASK-921.yml')?.task
  assert.equal((after?.evidence ?? []).length, 1, '卡面 evidence 是历史事实，drop 不许清空')
})

test('M198-03 §1.2（`DEF-118`）`reopen`：done → in-progress，须 reason + approvedBy，落 `task/reopened`；缺一项即拒且零写盘', () => {
  writeTask(store, card('TASK-931', 'done'))
  // ① 缺 reason / 缺 approvedBy ⇒ 拒，且零写盘
  for (const input of [
    { taskId: 'TASK-931', reason: '', approvedBy: 'user' },
    { taskId: 'TASK-931', reason: '要补字段', approvedBy: '  ' },
  ]) {
    const before = journal.read().events.length
    const rejected = reopenTask(store, journal, input)
    assert.equal(rejected.ok, false, `缺字段必须拒：${JSON.stringify(input)}`)
    if (!rejected.ok) assert.equal(rejected.code, 'missing-approval')
    assert.equal(journal.read().events.length, before, '被拒时零写盘')
  }
  // ② 齐备 ⇒ 放行 + 落事件 + 回显前后状态
  const ok = reopenTask(store, journal, { taskId: 'TASK-931', reason: '补一个漏填字段', approvedBy: 'user' })
  assert.equal(ok.ok, true, '齐备时必须放行')
  if (ok.ok) {
    assert.equal(ok.from, 'done')
    assert.equal(ok.card.status, 'in-progress')
  }
  const event = journal.read().events.filter((item) => item.type === 'task/reopened').at(-1)
  assert.equal(event?.data['from'], 'done', '事件要记来源状态')
  assert.equal(event?.data['to'], 'in-progress', '事件要记目标状态')
  assert.equal(event?.data['approvedBy'], 'user', '事件要记署名批准人')
  // ③ 非落地卡不许 reopen（避免把"未落地"当成"重开历史"）
  writeTask(store, card('TASK-932', 'planned'))
  const bad = reopenTask(store, journal, { taskId: 'TASK-932', reason: 'x', approvedBy: 'user' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.code, 'bad-status')
})

test('M198-04 §1.2（`DEF-118`）`restore`：dropped → 上一状态（读 drop 事件的 previousStatus），缺 reason/approvedBy 即拒；老事件回 `ready`', () => {
  // ① 新事件：previousStatus=planned ⇒ restore 回 planned
  writeTask(store, card('TASK-941', 'planned'))
  assert.equal(dropTaskChecked(store, journal, 'TASK-941', '建错').ok, true)
  const ok = restoreTask(store, journal, { taskId: 'TASK-941', reason: '误 drop', approvedBy: 'user' })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.from, 'dropped')
    assert.equal(ok.card.status, 'planned', '必须回到 drop 之前的状态')
  }
  const event = journal.read().events.filter((item) => item.type === 'task/restored').at(-1)
  assert.equal(event?.data['to'], 'planned')
  assert.equal(event?.data['source'], 'drop-event')
  // ② 缺 approvedBy ⇒ 拒
  writeTask(store, card('TASK-942', 'dropped'))
  const rejected = restoreTask(store, journal, { taskId: 'TASK-942', reason: 'x', approvedBy: '' })
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.equal(rejected.code, 'missing-approval')
  // ③ 老 drop 事件（没有 previousStatus）⇒ 回 ready，并如实记来源
  writeTask(store, card('TASK-943', 'dropped'))
  journal.append('task/dropped', { id: 'TASK-943', reason: '老事件（无 previousStatus）' })
  const legacy = restoreTask(store, journal, { taskId: 'TASK-943', reason: '恢复', approvedBy: 'user' })
  assert.equal(legacy.ok, true)
  if (legacy.ok) assert.equal(legacy.card.status, 'ready', '老事件缺 previousStatus ⇒ 回 ready')
  const legacyEvent = journal.read().events.filter((item) => item.type === 'task/restored').at(-1)
  assert.equal(legacyEvent?.data['source'], 'fallback-ready')
  // ④ 非 dropped 卡不许 restore
  writeTask(store, card('TASK-944', 'ready'))
  const bad = restoreTask(store, journal, { taskId: 'TASK-944', reason: 'x', approvedBy: 'user' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.code, 'bad-status')
})
