/**
 * **增量 208：A2（`TC-161` / `REQ-062` / `DEF-149`）—— 覆盖率第三态：有边 ≠ 已核实。**
 *
 * 病根：`trace.coverage` 的 `uncoveredMust` 只判"有没有 `req-tc` 边"。`REQ-062`（评审独立性五项）
 * 一行未实现、`test/` 零命中，只要台账里有一条边就被算成"需求有用例覆盖"（假绿）。
 *
 * 口径（用户 2026-10-21 裁定 a：修读数，不实现 `REQ-062`）：
 *   第三态 = `must` 需求 + 有 `req-tc` 边 + **没有任何一条**「`status: pass` 且 `adoptedBy` 非空」的结果。
 *   两条反例必须同时成立：未采纳的 pass **不许**算核实；已采纳的 pass **必须**算核实。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { report } from '../src/domain/trace.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { GateCriterionResult, Requirement } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm208')
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's-m208', cwd: WORKSPACE } as unknown as OfficeCall

function store(): ReturnType<SoftwareDevOffice['storeFor']> {
  return office.storeFor(WORKSPACE)
}

function journal(): ReturnType<SoftwareDevOffice['journalFor']> {
  return office.journalFor(WORKSPACE)
}

/** 覆盖率判据（`trace.coverage` ⇒ C-41，挂在 G5）。 */
function coverage(): GateCriterionResult {
  const criterion = office.evaluate(call, 'G5').criteria.find((item) => item.id === 'C-41')
  assert.equal(criterion !== undefined, true, '前置：G5 必须声明 C-41（trace.coverage）')
  return criterion as GateCriterionResult
}

/** 从台账读回一条需求（真源形态，避免手搓对象漏字段）。 */
function requirement(id: string): Requirement {
  const read = store().readYaml<{ requirement: Requirement }>('requirements', `${id}.yml`)
  assert.ok(read?.requirement !== undefined, `前置：需求 ${id} 必须在台账里`)
  return read.requirement
}

/** 一条 must 需求 + 一条用例 + `req-tc` 边；返回 caseId。 */
function seed(requirement = 'REQ-001', priority = 'must'): string {
  store().writeYaml(['requirements', `${requirement}.yml`], {
    requirement: {
      id: requirement, title: requirement, statement: 's', priority,
      status: 'baselined', acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
    },
  })
  const testCase = recordTestCase(store(), journal(), { title: '夹具用例', kind: 'unit', requirement, steps: ['跑'], expected: '通过' })
  office.linkTrace(call, [{ from: requirement, to: testCase.id, kind: 'req-tc' }])
  return testCase.id
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-m208', WORKSPACE)
  office.init(call, { name: 'M208 覆盖率第三态', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M208-01 反例（未采纳不算核实）：用例 pass 但没有 `adoptedBy` ⇒ 第三态点名 `REQ←TC`，C-41 判红', () => {
  const caseId = seed()
  recordTestResult(store(), journal(), {
    caseId, status: 'pass', evidence: '自己跑的',
    executedBy: 'runner', oracle: { kind: 'acceptance', ref: 'REQ-001', criterion: 'AC-001' },
  })
  const data = report(store(), [requirement('REQ-001')])
  assert.deepEqual(data.registeredButUnverified, [{ requirementId: 'REQ-001', caseIds: [caseId] }], '未采纳的 pass 必须落进第三态')
  const criterion = coverage()
  assert.equal(criterion.ok, false, '有边没核实 ⇒ 覆盖率必须判红（否则 REQ-062 那种空实现照绿）')
  assert.match(criterion.detail, new RegExp(`REQ-001<-${caseId}`, 'u'), `点名必须是「需求←用例」：${criterion.detail}`)
})

test('M208-02 反例（已采纳必须算核实）：同一条用例的 pass 被独立采纳 ⇒ 第三态为空，C-41 判绿', () => {
  const caseId = seed()
  recordTestResult(store(), journal(), {
    caseId, status: 'pass', evidence: '跑过并被采纳',
    executedBy: 'runner', adoptedBy: 'reviewer', adoptedAt: '2026-10-21T00:00:00.000Z',
    oracle: { kind: 'acceptance', ref: 'REQ-001', criterion: 'AC-001' },
  })
  const data = report(store(), [requirement('REQ-001')])
  assert.deepEqual(data.registeredButUnverified, [], '已采纳的 pass 不许落进第三态')
  assert.equal(coverage().ok, true, `已核实的覆盖率必须判绿：${coverage().detail}`)
})

test('M208-03 三态互不遮蔽：根本没有 `req-tc` 边 ⇒ 仍按「缺用例」判红（第三态不许盖住它）', () => {
  store().writeYaml(['requirements', 'REQ-002.yml'], {
    requirement: {
      id: 'REQ-002', title: '没有用例', statement: 's', priority: 'must', status: 'baselined',
      acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
    },
  })
  const criterion = coverage()
  assert.equal(criterion.ok, false, '没有 req-tc 边的 must 需求必须判红')
  assert.match(criterion.detail, /REQ-002/u, `缺用例的那条要点名：${criterion.detail}`)
})
