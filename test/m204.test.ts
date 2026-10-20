/**
 * **增量 204：红队处置必须有后果（`DEF-134`，0.1.6 收尾 T7）+ 红队 `off` 的工具面入口守卫。**
 *
 * 病根（驾驶舱 2026-10-20 现读）：`src/domain/issues.ts` 的 `disposeIssue` **只写** `disposition` +
 * `issue/closed`，不建风险项；而 `issueClosure` 判「`disposition !== 'none'` ⇒ 已闭环」⇒
 * **「转为风险」可以没有风险，门禁照样认闭环**（标签 ≠ 后果）。
 *
 * 本文件钉三格：
 *   ① `dispose=risk` 必须**真的**落一条风险项（`origin` = 议题 id，且 `title/level/probability/impact` 齐备）；
 *   ② 历史/手改形态（议题标了 risk 但没有风险项）⇒ `issueClosure` **必须判未闭环**并点名（不是只报"已处置"）；
 *   ③ `sdo_redteam action=off` 经**工具面**驱动 ⇒ 落 `redteam/mode(enabled=false)` 且回执说清"停用"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { Config } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { disposeIssue, issueClosure, readIssue, writeIssue } from '../src/domain/issues.js'
import { listRisks } from '../src/domain/risks.js'
import { apply } from '../src/index.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import type { RedTeamIssue } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm204')

function seedIssue(store: SdoStore, id: string, over: Partial<RedTeamIssue> = {}): RedTeamIssue {
  const issue: RedTeamIssue = {
    id,
    target: 'REQ-001',
    angles: ['redteam-stakeholder', 'redteam-abuse'],
    questionIds: [],
    status: 'open',
    disposition: 'none',
    note: '',
    at: '2026-10-20T00:00:00.000Z',
    ...over,
  }
  writeIssue(store, issue)
  return issue
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M204-01（`DEF-134`）`dispose=risk` 必须**真建一条风险项**：origin=议题 id、四字段齐备、闭环由它成立', () => {
  const store = new SdoStore(join(BASE, '.sdo'))
  const journal = new Journal(store)
  const issue = seedIssue(store, 'REQ-ISSUE-001')
  assert.deepEqual(listRisks(store), [], '前置：风险台账为空')

  const disposed = disposeIssue(store, journal, issue.id, 'risk', '转为风险：滥用面需要在设计里兜住')
  assert.ok(disposed !== undefined, '处置必须成功')
  // ① 后果：风险台账里**真的**多了一条，且 origin 指向该议题
  const risks = listRisks(store)
  assert.equal(risks.length, 1, `dispose=risk 必须建一条风险项（实际 ${risks.length} 条）`)
  const risk = risks[0] as (typeof risks)[number]
  assert.equal(risk.origin, issue.id, '风险的 origin 必须指向该议题（闭环判据靠它）')
  for (const field of ['title', 'level', 'probability', 'impact'] as const) {
    assert.equal(String(risk[field] ?? '').trim() === '', false, `风险项必须带 ${field}（DEF-134 的 DoD）`)
  }
  // ② 台账：`risk/logged` + `issue/closed`（后者带 riskId，审计看得出"这次处置建了哪条风险"）
  const events = journal.read().events
  assert.equal(events.filter((event) => event.type === 'risk/logged').length, 1, '必须落 risk/logged')
  const closed = events.find((event) => event.type === 'issue/closed')
  assert.equal(closed?.data['riskId'], risk.id, 'issue/closed 的载荷要带上新建的风险 id')
  // ③ 闭环：`issueClosure` 认它（因为风险项真的存在，不是因为标签）
  assert.equal(issueClosure(disposed as RedTeamIssue, [], risks).closed, true, '有风险项 ⇒ 闭环成立')
})

test('M204-02（`DEF-134`）历史/手改形态：议题标了 risk 但**没有风险项** ⇒ 必须判**未闭环**并点名（标签 ≠ 后果）', () => {
  const store = new SdoStore(join(BASE, '.sdo'))
  const journal = new Journal(store)
  // 手工写一个旧形态：disposition=risk、status=closed，却没有对应风险（真机上"直接改文件"就会这样）
  const legacy = seedIssue(store, 'REQ-ISSUE-002', { disposition: 'risk', status: 'closed', note: '转风险' })
  const closure = issueClosure(readIssue(store, legacy.id) as RedTeamIssue, [], [])
  assert.equal(closure.closed, false, '标了转为风险却没有风险项 ⇒ 不许认闭环')
  assert.match(closure.reason, /风险项/u, '理由必须点名"没有风险项"')
  assert.match(closure.reason, /REQ-ISSUE-002/u, '理由要点名是哪条议题')
  // 反例（同一条议题、真有一条 origin 指向它的风险）⇒ 闭环
  journal.append('risk/logged', { id: 'RISK-001', level: 'medium', title: 't' })
  store.writeYaml(['risks', 'RISK-001.yml'], {
    risk: {
      id: 'RISK-001', title: 't', level: 'medium', probability: 'medium', impact: 'i',
      mitigation: 'm', owner: 'o', status: 'open', origin: legacy.id, at: '',
    },
  })
  assert.equal(issueClosure(readIssue(store, legacy.id) as RedTeamIssue, [], listRisks(store)).closed, true, '有风险项就闭环')
  // 「回到需求」不受影响（这条路本来就有去向）
  const backToRequirement = seedIssue(store, 'REQ-ISSUE-003', { disposition: 'requirement', status: 'closed', note: '回到需求' })
  assert.equal(issueClosure(backToRequirement, [], []).closed, true, 'disposition=requirement 仍按闭环算')
})

test('M204-03（T7 附带）`sdo_redteam action=off` 经**工具面**驱动：落 `redteam/mode(enabled=false)` 且回执说清停用', async () => {
  const registered: ToolDefinition[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition): (() => void) => { registered.push(tool); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const store = new SdoStore(join(BASE, '.sdo'))
  const journal = new Journal(store)
  const tool = registered.find((item) => item.name === 'sdo_redteam')
  assert.ok(tool !== undefined, '工具面必须有 sdo_redteam')
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  assert.ok('action' in properties && 'reason' in properties, 'schema 必须有 action/reason（否则入参会被宿主过滤掉）')
  const exec = { agent: { id: 's1', session: { header: { id: 's1', cwd: BASE, delegationDepth: 0 } } } }
  const receipt = String(await tool.execute({ action: 'off', reason: '本轮不发散（T7 守卫）' }, exec as never))
  // ① 回执说清"停用"（不是只回一个空串或状态行）
  assert.match(receipt, /停用/u, `回执要说明已停用：${receipt}`)
  // ② 台账：`redteam/mode` 事件 + enabled=false + reason 入账（这是"入口真的被驱动"的证据）
  const modes = journal.read().events.filter((event) => event.type === 'redteam/mode')
  assert.equal(modes.length, 1, '必须落一条 redteam/mode')
  assert.equal(modes[0]?.data['enabled'], false, 'enabled 必须是 false')
  assert.equal(modes[0]?.data['reason'], '本轮不发散（T7 守卫）', 'reason 必须原样入账')
})
