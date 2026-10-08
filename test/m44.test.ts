/**
 * 用户要求（2026-10-06）：「**要真机测试才能交付**」——移植 MC 模组离线判据全绿、构建退出码 0，
 * 但交付 jar 装进游戏**启动即崩**；正常必须先跑过 `runServer` + `runClient`。其他系统同理。
 *
 * 本轮的机制：`sdo_deliver action=run` 记一条真机运行（目标 / 命令 / 结论 / 证据 / **被运行产物**），
 * 记录时**绑定产物 sha256**；`action=package` 只有在存在「通过 + 哈希与本次交付产物相等」的运行记录时
 * 才允许 `pass` 行，否则**全部降级为 `unverified`**（SDO-41 同款口径：绝不默认通过），
 * 交付门禁（G7 的 `delivery.manifest`）也据此判红。
 *
 * 为什么绑哈希是必须的：只记「我跑过」可以拿旧产物/别的产物充数 —— 那正是「离线绿、真机崩」的同一类
 * 观测点错位（SDO-33/49）。绑哈希后，"跑的是不是这一份"变成机械可判。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { deliveryCompleteness, listRuns, packageDelivery, recordRun, renderDelivery } from '../src/domain/records.js'
import type { AcceptanceRow } from '../src/domain/records.js'
import type { Requirement } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm44')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
  // 一个"交付产物"（文件名带扩展名，避免与目录混淆）
  writeFileSync(join(BASE, 'rpsideas-reboren-0.1.0.jar'), 'jar-bytes-v1', 'utf8')
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})


/** 一条带 AC-001 的 must 需求（交付门禁会查 AC 是否存在）。 */
function requirement(): Requirement {
  return {
    id: 'REQ-001', title: 'R', kind: 'functional', statement: 's', rationale: 'r', status: 'approved',
    priority: 'must', source: 'user', acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
  } as unknown as Requirement
}

function seedCase(): void {
  // **SDO-40 缺口三**：`pass` 行必须能追到「用例 → 通过结果」
  store.writeYaml(['tests', 'TC-001.yml'], { testCase: { id: 'TC-001', title: 't', kind: 'unit', requirement: 'REQ-001', steps: [], expected: 'e', at: '' } })
  store.writeYaml(['tests', 'results', 'TR-001.yml'], { result: { id: 'TR-001', caseId: 'TC-001', status: 'pass', evidence: 'e', at: '2026-10-06T00:00:00Z' } })
}

const rows = (): AcceptanceRow[] => [{ requirement: 'REQ-001', criterion: 'AC-001', evidence: 'e', verdict: 'pass' }]

function pack(extra: { runsRequired?: string[] } = {}): ReturnType<typeof packageDelivery> {
  return packageDelivery(store, journal, {
    workspace: BASE,
    by: 'cockpit',
    artifacts: [{ path: 'rpsideas-reboren-0.1.0.jar', kind: 'source' }],
    acceptance: rows(),
    rollbackPoint: 'git:abc',
    prototypeDir: 'prototype',
    ...extra,
  })
}

test('真机运行记录：目标/命令/证据缺一不可；给了产物就绑定 sha256', () => {
  assert.equal(recordRun(store, journal, { workspace: BASE, target: '', command: 'gradlew runServer', outcome: 'pass', evidence: 'logs/latest.log', by: 'h' }).ok, false)
  assert.equal(recordRun(store, journal, { workspace: BASE, target: 'server', command: '  ', outcome: 'pass', evidence: 'logs/latest.log', by: 'h' }).ok, false)
  assert.equal(recordRun(store, journal, { workspace: BASE, target: 'server', command: 'gradlew runServer', outcome: 'pass', evidence: '', by: 'h' }).ok, false)

  const recorded = recordRun(store, journal, {
    workspace: BASE, target: 'server', command: './gradlew runServer', outcome: 'pass',
    evidence: 'logs/latest.log', artifact: 'rpsideas-reboren-0.1.0.jar', exitCode: '0', by: 'human',
  })
  assert.equal(recorded.ok, true)
  assert.match(recorded.ok ? recorded.run.artifactSha256 : '', /^[0-9a-f]{64}$/u, '记录时必须绑定产物哈希')
  assert.equal(listRuns(store).length, 1, '真源里读得回来')
  assert.equal(journal.read().events.filter((item) => item.type === 'delivery/run-recorded').length, 1, '也要进 journal')
})

test('交付要求真机运行：没有记录 ⇒ 所有 pass 降级为 unverified，门禁判红，渲染显式告警', () => {
  const { manifest } = pack()
  assert.equal(manifest.acceptance[0]?.verdict, 'unverified', '没跑过就不许是 pass')
  assert.match(manifest.runGaps.join(' '), /没有任何真机运行记录/u)
  const completeness = deliveryCompleteness(store, [requirement()], 'prototype')
  assert.equal(completeness.ok, false)
  assert.match(completeness.problems.join(' '), /没有真机运行证据/u, '交付门禁必须拦')
  assert.match(renderDelivery(manifest, '# h'), /⚠️ \*\*没有真机运行记录\*\*/u)
  const event = journal.read().events.filter((item) => item.type === 'delivery/packaged').pop()
  assert.ok(Array.isArray(event?.data.runGaps) && (event?.data.runGaps as string[]).length > 0, '缺口要入账')
  assert.equal((event?.data.acceptanceRows as { verdict: string }[])[0]?.verdict, 'unverified', '入账的也是降级后的结论')
})

test('有绑定的通过运行 ⇒ pass 放行；**绑定到别的产物**（拿旧包跑）⇒ 不算数', () => {
  seedCase()
  // ① 先跑一次并绑定本次产物
  recordRun(store, journal, {
    workspace: BASE, target: 'server', command: './gradlew runServer', outcome: 'pass',
    evidence: 'logs/server.log', artifact: 'rpsideas-reboren-0.1.0.jar', by: 'human',
  })
  const ok = pack({ runsRequired: ['server'] })
  assert.equal(ok.manifest.acceptance[0]?.verdict, 'pass', '有绑定通过运行 ⇒ 允许 pass')
  assert.deepEqual(ok.manifest.runGaps, [])
  assert.equal(deliveryCompleteness(store, [requirement()], 'prototype').ok, true, '门禁应放行')

  // ② 换一个产物内容（哈希变了）⇒ 旧运行记录不再证明"这一份能跑"
  writeFileSync(join(BASE, 'rpsideas-reboren-0.1.0.jar'), 'jar-bytes-v2-改了东西', 'utf8')
  const stale = pack()
  assert.equal(stale.manifest.acceptance[0]?.verdict, 'unverified', '产物变了，旧运行记录不作数')
  assert.match(stale.manifest.runGaps.join(' '), /没有一条运行记录绑定到本次交付的产物/u)
})

test('`runsRequired`：声明的每个运行目标都要有通过记录（MC 模组 = server + client）', () => {
  seedCase()
  recordRun(store, journal, {
    workspace: BASE, target: 'server', command: './gradlew runServer', outcome: 'pass',
    evidence: 'logs/server.log', artifact: 'rpsideas-reboren-0.1.0.jar', by: 'human',
  })
  // 只跑了 server，却声明要求 server+client ⇒ 缺 client
  const gap = pack({ runsRequired: ['server', 'client'] })
  assert.deepEqual(gap.manifest.runGaps, ['缺少运行目标「client」的通过记录'])
  assert.equal(gap.manifest.acceptance[0]?.verdict, 'unverified')

  // 补上 client ⇒ 通过
  recordRun(store, journal, {
    workspace: BASE, target: 'client', command: './gradlew runClient', outcome: 'pass',
    evidence: 'logs/client.log', artifact: 'rpsideas-reboren-0.1.0.jar', by: 'human',
  })
  const both = pack({ runsRequired: ['server', 'client'] })
  assert.deepEqual(both.manifest.runGaps, [])
  assert.equal(both.manifest.acceptance[0]?.verdict, 'pass')
  // 渲染里两条运行记录都在（产物自证）
  const doc = renderDelivery(both.manifest, '# h')
  assert.match(doc, /## 真机运行记录/u)
  assert.match(doc, /runServer/u)
  assert.match(doc, /runClient/u)

  // 反向：**失败的运行**不能当证据
  const failing = recordRun(store, journal, {
    workspace: BASE, target: 'client', command: './gradlew runClient', outcome: 'fail',
    evidence: 'logs/client-crash.log', artifact: 'rpsideas-reboren-0.1.0.jar', by: 'human',
  })
  assert.equal(failing.ok, true, '失败也要如实记录')
  assert.equal(listRuns(store).length, 3)
})
