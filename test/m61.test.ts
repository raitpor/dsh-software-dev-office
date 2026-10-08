/**
 * 第二轮整体评审 §2.3（HIGH）：**派发汇报键塌陷** —— 同一 `(子会话, 报告落点)` 的**两笔结算**，
 * 第一笔送达后把整条键标成"已读"，第二笔结算于是**静默永不推送**（`pending` 由 2 变 0）。
 *
 * 可达路径（真实监听器就能走到）：`turn/end` 是结算信号，而**同一子会话同一张卡**可以结算多次 ——
 * 子代理是常驻/多轮时，第 2 轮结束时若没有新的 `dispatch/started`，`taskId` 仍是上一张卡，
 * 报告落点也仍是 `<卡>-<子会话前8位>.md`（按卡切的名，本来就**故意**允许同卡重复结算覆盖）；
 * 旧实现用 `${childSessionId}|${report}` 当"已读"键 ⇒ 第二笔与第一笔同键 ⇒ 被当成已送达。
 *
 * 修法：已读登记改用**结算事件自身的 journal `seq`**（结算的唯一身份），旧的无 `finishedSeq`
 * 登记退化成"一条键额度"（一笔旧登记只顶一笔结算），这样历史台账不会因为升级而重推、也不会再吞新结算。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm61')

let office: SoftwareDevOffice
let store: SdoStore
let journal: Journal
const call = { sessionId: 'cockpit', cwd: BASE }

const now = (): string => new Date().toISOString()

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('cockpit', BASE)
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 结算一笔（同一 child 的每一轮都用同一个 childSessionId / task ⇒ 报告落点自然相同）。 */
function settle(childSessionId: string, task: string, turn: number, report: string): void {
  office.noteDispatchFinished(call, {
    childSessionId, task, role: 'developer', turn, reason: 'completed', startedAt: now(), report: 'R'.repeat(500) + report,
  })
}

test('M61-01 §2.3：同一 (子会话, 报告落点) 的第二笔结算仍要推送（不许被第一笔的已读键吞掉）', () => {
  settle('child-1', 'TASK-001', 1, '第一轮报告')
  const first = office.pendingDispatchReports(call)
  assert.equal(first.length, 1, `前置：第一笔结算应在待推送里：${JSON.stringify(first.map((item) => item.report))}`)
  assert.equal(first[0]?.task, 'TASK-001')
  assert.equal(typeof first[0]?.seq, 'number', '结算要带上"它是哪一笔"的身份（journal seq）')

  office.markDispatchReported(call, [{ childSessionId: 'child-1', report: first[0]?.report ?? '', seq: first[0]?.seq ?? 0 }])
  assert.equal(office.pendingDispatchReports(call).length, 0, '送过就不再送（重启也不重推）')

  // 同一子会话、同一张卡的第 2 轮结算：报告落点与第一笔**完全相同**
  settle('child-1', 'TASK-001', 2, '第二轮报告')
  const finished = journal.read().events.filter((event) => event.type === 'dispatch/finished')
  assert.equal(finished.length, 2, '两笔结算两条台账')
  assert.equal(String(finished[0]?.data.report), String(finished[1]?.data.report), '前置：同卡同子会话 ⇒ 落点相同（本缺陷的触发条件）')

  const second = office.pendingDispatchReports(call)
  assert.equal(second.length, 1, '第二笔结算是**新的一笔**，不能被第一笔的已读登记吞掉（§2.3 的 pending 2→0）')
  assert.equal(second[0]?.seq, finished[1]?.seq, '待推送的必须是第二笔（按 seq 认身份）')

  // 标记第二笔后待推送清空（幂等：同一笔重复标记不会影响别的结算）
  office.markDispatchReported(call, [{ childSessionId: 'child-1', report: second[0]?.report ?? '', seq: second[0]?.seq ?? 0 }])
  assert.equal(office.pendingDispatchReports(call).length, 0)
})

test('M61-02 §2.3：报告落点不同（复用同一子会话做两张卡）本来就互不影响 —— 收紧后不许拦错', () => {
  settle('child-9', 'TASK-041', 1, 'TASK-041 的报告')
  settle('child-9', 'TASK-042', 2, 'TASK-042 的报告')
  const pending = office.pendingDispatchReports(call)
  assert.equal(pending.length, 2, '两张卡两份待推送')
  assert.notEqual(pending[0]?.report, pending[1]?.report)

  office.markDispatchReported(call, [{ childSessionId: 'child-9', report: pending[0]?.report ?? '', seq: pending[0]?.seq ?? 0 }])
  const rest = office.pendingDispatchReports(call)
  assert.equal(rest.length, 1, '标一笔只该消一笔')
  assert.equal(rest[0]?.task, 'TASK-042')
})

test('M61-03 §2.3：旧台账（登记里没有 finishedSeq）只顶**一笔**额度 —— 升级不重推、也不吞新结算', () => {
  // 模拟升级前的历史台账：一条无 finishedSeq 的已读登记
  journal.append('dispatch/reported', { childSessionId: 'child-1', report: 'evidence/child-reports/TASK-001-child-1.md' })

  settle('child-1', 'TASK-001', 1, '历史那一笔')
  assert.equal(office.pendingDispatchReports(call).length, 0, '旧登记要能顶掉当时的那一笔（否则升级后整批重推）')

  // 又来一笔**新的**结算（落点相同）：旧登记额度已用完 ⇒ 必须推送
  settle('child-1', 'TASK-001', 2, '新的一笔')
  const pending = office.pendingDispatchReports(call)
  assert.equal(pending.length, 1, '旧登记只顶一笔，不许把后来的新结算一并顶掉')
})
