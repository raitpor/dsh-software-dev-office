/**
 * **增量 146：任一次子代理结算的报告残缺都要告警 —— 含被后续正常报告"遮住"的那一笔（DEF-045，§3E 族 5）**。
 *
 * 缺陷原文（C 组 re-verify）：`childReportHealth` 用 `.pop()` **只看最后一次结算**；真机台账 TASK-104 有
 * **两笔** `dispatch/finished`（`error`@01:14 落 **78B** 残片 / `completed`@04:12 落 **2599B**）⇒
 * `CHILD_REPORT_MIN_BYTES=400` 对那笔残片是**死判据**（永远不告警）。
 *
 * 修复后同一条真机探针 ⇒ `{"state":"short","bytes":78,"fragments":["error:78B"]}`。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { CHILD_REPORT_MIN_BYTES } from '../src/domain/dispatchReports.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m146/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')
let office: SoftwareDevOffice
let store: SdoStore
let journal: Journal
const call = { sessionId: 's-dev', cwd: WORKSPACE } as unknown as OfficeCall

/** 落一份报告正文并记一笔结算（同一张卡可以结算多次）。 */
const settle = (name: string, bytes: number, reason: string, task = 'TASK-900'): void => {
  // `SdoStore.writeText` 会给缺尾换行的文本补一个 `\n` ⇒ 补过之后再写才**恰好**是 `bytes` 字节
  const text = 'x'.repeat(Math.max(0, bytes - 1)) + '\n'
  store.writeText(['evidence', 'child-reports', name], text)
  journal.append('dispatch/finished', {
    childSessionId: 'child-1', task, role: 'developer', turn: 1, reason,
    startedAt: '2026-10-14T00:00:00.000Z', finishedAt: '2026-10-14T00:01:00.000Z', durationMs: 60000,
    report: `evidence/child-reports/${name}`,
  })
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, '.sdo'), { recursive: true })
  store = new SdoStore(join(WORKSPACE, '.sdo'))
  journal = new Journal(store)
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-dev', WORKSPACE)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M146-01 残片被后续正常报告遮住 ⇒ 仍要告警（红侧：`.pop()` 只看最后一笔 ⇒ 报 ok）', () => {
  settle('a.md', 78, 'error')
  settle('b.md', 2500, 'completed')
  const health = office.childReportHealth(call, 'TASK-900')
  assert.equal(health.state, 'short', `最早那笔残片必须被看见：${JSON.stringify(health)}`)
  assert.ok((health.bytes ?? 0) < 400, `报的应是**残片**自身的大小（可核对）：${String(health.bytes)}`)
  assert.match(health.report ?? '', /a\.md/u, '要点名是哪一笔（最早那份残片）')
  assert.equal((health.fragments ?? []).length, 1, '残缺清单要点名那一笔')
  assert.equal(health.fragments?.[0]?.reason, 'error', '要点名它是哪种结算（error/completed）')
})

test('M146-02 反例：只有一份正常报告 ⇒ ok 且没有残缺清单（不许修成"全告警"）', () => {
  settle('only.md', 2500, 'completed')
  const health = office.childReportHealth(call, 'TASK-900')
  assert.equal(health.state, 'ok')
  assert.equal(health.fragments, undefined, '全正常时不得出现残缺清单')
})

test('M146-03 多笔残缺逐笔点名（不是只报一笔）', () => {
  settle('a.md', 78, 'error')
  settle('b.md', 2500, 'completed')
  settle('c.md', 120, 'error')
  const health = office.childReportHealth(call, 'TASK-900')
  assert.equal((health.fragments ?? []).length, 2, `两笔残缺都要列：${JSON.stringify(health.fragments)}`)
  assert.equal(health.state, 'short')
})

test('M146-04 阈值边界仍咬人：399 ⇒ short / 400 ⇒ ok / 401 ⇒ ok（常量没被放宽）', () => {
  // `TC-107` 的子句③：阈值边界不许因为"修成逐笔遍历"而被顺手放宽（放宽 = 残片重新变成死判据）
  assert.equal(CHILD_REPORT_MIN_BYTES, 400, '阈值常量必须是 400 —— 放宽它等于把残片告警关掉')
  const cases: [string, number, 'ok' | 'short'][] = [
    ['TASK-901', 399, 'short'],
    ['TASK-902', 400, 'ok'],
    ['TASK-903', 401, 'ok'],
  ]
  for (const [task, bytes, want] of cases) {
    settle(`${task}.md`, bytes, 'completed', task)
    const health = office.childReportHealth(call, task)
    // 先自证夹具真的落在边界上：`bytes` 读数必须等于写进去的字节数（否则这条断言测的是别的东西）
    assert.equal(health.bytes, bytes, `夹具必须恰好 ${bytes} 字节（实际 ${String(health.bytes)}）`)
    assert.equal(health.state, want, `${bytes} 字节 ⇒ ${want}（实际 ${health.state}）`)
  }
})
