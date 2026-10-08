/**
 * 第一轮整仓评审 §2 第 3 条（评审员"读码成立、未构造'签后重签'的端到端场景"）：**`frozenSeq` 取第一条
 * `design/confirmed`**。我用"签 → 认领 → 改契约再签"把它定住了：
 *
 * ```text
 * 契约 CT-001 确认于 seq 50 ｜ 卡 TASK-001 认领于 seq 60 ｜ 改契约后**重签**于 seq 120
 *   · claim 关（认领那一刻）   ⇒ 两条实现同结论（认领序号 > 所有既有确认序号）
 *   · 门禁 C-43/C-84（**事后**拿那次认领的序号复核已完成卡）
 *       旧实现 `.find` = 50 < 60  ⇒ 无 gap（**卡在契约变更前动工，查不出来**）
 *       取最新 = 120 ≥ 60        ⇒ 点名（要放过历史卡就走门禁注释里写明的**豁免**）
 * ```
 *
 * 修法：`frozenSeq` 取**最新**一条确认。方向是**收紧**，所以同时钉住"没重签时不许误报"与"豁免仍然有效"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { CHECKERS } from '../src/domain/gates.js'
import { claimGaps, frozenSeq, writeConstructionProfile } from '../src/domain/construction.js'
import type { ConstructionProfile } from '../src/domain/construction.js'
import type { GateContext } from '../src/domain/gates.js'
import type { Contract, TaskCard } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm66')
let store: SdoStore
let journal: Journal

function writeCard(id: string, requirements: string[], role: string, status: TaskCard['status']): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: role as TaskCard['role'], size: 'small', revision: 1,
    status, owner: 'sub-dev', requirements, evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
}

function writeContract(id: string, requires: string[]): void {
  const contract: Contract = {
    id, name: id, kind: 'http', producer: '对账系统', consumer: '业务方', schema: 'GET /diff → 差异清单',
    failureSemantics: { timeout: '5s 后重试一次', retry: '幂等重试', idempotency: '按批次幂等' },
    requires, at: '2026-01-01T00:00:00.000Z',
  }
  store.writeYaml(['contracts', `${id}.yml`], { contract })
}

function profile(exempt: ConstructionProfile['exempt'] = []): ConstructionProfile {
  const value: ConstructionProfile = {
    version: 1, decidedAt: '2026-01-01T00:00:00.000Z', decidedBy: 'office',
    packages: ['contract-first'], scope: ['TASK-001'], derivedFrom: ['reqKind=functional(REQ-001)'],
    reason: '接口先行', exempt, history: [],
  }
  writeConstructionProfile(store, value)
  return value
}

/** 门禁侧实际报出来的、与 CT-001 冻结有关的那几行（其余 done 侧 gap 与本条无关，不参与断言）。 */
function gateFreezeLines(): string[] {
  const ctx = { workspace: BASE, store, journal, requirements: [] } as unknown as GateContext
  const result = CHECKERS['construction.packages-satisfied']?.(ctx)
  return String(result?.detail ?? '').split('；').filter((line) => line.includes('CT-001'))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  mkdirSync(join(BASE, '.sdo', 'contracts'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
  store.writeYaml(['requirements', 'REQ-001.yml'], {
    requirement: {
      id: 'REQ-001', title: 'r', statement: '系统须导出', kind: 'functional', priority: 'must',
      sourceStakeholder: 'STK-01', rationale: 'r', status: 'baselined', revision: 1,
      acceptance: [], modelDimensions: {}, evidence: [], createdAt: '', updatedAt: '',
    },
  })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M66-01 §2 第 3 条：契约"签后重签"晚于认领 ⇒ 门禁复核必须点名（旧实现取第一条 ⇒ 查不出来）', () => {
  writeCard('TASK-001', ['REQ-001'], 'developer', 'done')
  writeContract('CT-001', ['REQ-001'])
  profile()
  journal.append('design/confirmed', { target: 'CT-001', basis: '评审通过', by: 'cockpit' })
  const frozenAt = journal.read().events.length
  journal.append('task/claimed', { id: 'TASK-001', owner: 'sub-dev', sessionId: 'child-1', expectedRevision: 1 })
  const claimSeq = journal.read().events.length

  // ① 只有"认领之前那次确认"时：门禁不许拿 CT-001 说事（这一半是防误报）
  assert.deepEqual(gateFreezeLines(), [], `没有重签时不许误报：${gateFreezeLines().join(' | ')}`)

  // ② 改契约后**重签**（认领之后）⇒ 门禁复核必须点名
  journal.append('contract/updated', { id: 'CT-001', revision: 2 })
  journal.append('design/confirmed', { target: 'CT-001', basis: '改了接口再签一次', by: 'cockpit' })
  const refrozen = frozenSeq(journal, 'CT-001')
  assert.equal(refrozen, journal.read().events.length, '冻结序号必须取**最新**那条确认')
  assert.ok((refrozen ?? 0) >= claimSeq, '前置：重签确实晚于那次认领')
  void frozenAt
  const lines = gateFreezeLines()
  assert.equal(lines.length, 1, `重签晚于认领必须点名（旧实现这里一行都不报）：${lines.join(' | ')}`)
  assert.match(lines[0] ?? '', /冻结|CT-001/u)
})

test('M66-02 §2 第 3 条：认领关（claim 关）语义不变 —— 认领前签过就过，重签不追溯已完成的认领动作', () => {
  writeCard('TASK-001', ['REQ-001'], 'developer', 'ready')
  writeContract('CT-001', ['REQ-001'])
  const withPackage = profile()
  journal.append('design/confirmed', { target: 'CT-001', basis: '评审通过', by: 'cockpit' })
  const thisClaimSeq = journal.read().events.length + 1
  const card = store.readYaml<{ task: TaskCard }>('tasks', 'TASK-001.yml')?.task
  assert.ok(card !== undefined)
  assert.deepEqual(claimGaps(store, journal, card, thisClaimSeq, withPackage), [])
})

test('M66-03 §2 第 3 条：历史卡走**豁免**这条路仍然有效（收紧不等于把老项目卡死）', () => {
  writeCard('TASK-001', ['REQ-001'], 'developer', 'done')
  writeContract('CT-001', ['REQ-001'])
  profile([{ task: 'TASK-001', check: 'contract-not-frozen', why: '历史卡：契约在本卡完成后才修订并重签' }])
  journal.append('design/confirmed', { target: 'CT-001', basis: '评审通过', by: 'cockpit' })
  journal.append('task/claimed', { id: 'TASK-001', owner: 'sub-dev', sessionId: 'child-1', expectedRevision: 1 })
  journal.append('contract/updated', { id: 'CT-001', revision: 2 })
  journal.append('design/confirmed', { target: 'CT-001', basis: '改了接口再签一次', by: 'cockpit' })
  assert.deepEqual(gateFreezeLines(), [], `写了豁免就不该再报这条：${gateFreezeLines().join(' | ')}`)
})
