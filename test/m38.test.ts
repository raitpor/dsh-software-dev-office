/**
 * rpsidease-reboren 真机报告（2026-10-05《SDO 流程与门禁》）的回归。
 *
 * 这一轮修的三条都出自真机、且都有"静默"的共同病根：
 *   · **R-1（用户直接点出）**：父会话认领过一张 developer 卡 ⇒ 被判成 `developer` ⇒ **掩码开始拦它
 *     自己的工具调用**（回执写着"以 developer 身份"）。身份该由**血缘**决定，认领只决定"卡归谁"。
 *   · **SDO-15（阻塞）**：`evidence/workspace-changes.jsonl` 的 `seq` 是**宿主会话**的计数器，
 *     而认领基线是 **journal** 序号（真机：883/994/1488 vs journal 444）⇒ `entry.seq > 440` 恒真
 *     ⇒ 写范围对账退化成"整会话改动都算本卡越界" ⇒ **任何卡都无法 done**。
 *   · **SDO-01**：`assume=true`（采用题库建议）与 `answer=<自己的正文>` 同传时，正文被**静默丢掉**。
 *
 * 另附 SDO-05 / SDO-13 的**顺序警示**（签字回执必须写出"签之前该做完什么"）的端到端断言 ——
 * 真机上「签 G2 后再登记一条风险」「签 G3 后再补契约」都各自当场作废签字，而回执当时只列了失效集合。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { answerQuestion, readQuestion } from '../src/domain/grill.js'
import { attributeRole } from '../src/domain/roles.js'
import { changedFilesSince, recordWorkspaceChanges, unresolvedSeqs } from '../src/domain/workspaceChanges.js'
import { describeSignature } from '../src/interface/describe.js'
import type { GateSignature, Requirement } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm38')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// —————————————————————— R-1：父会话的角色由血缘决定 ——————————————————————

test('R-1：根会话认领过 developer 卡 ⇒ **仍是驾驶舱**（认领只决定卡归谁，不决定我是谁）', () => {
  const claims = [{ sessionId: 'session-parent', cardId: 'TASK-022', role: 'developer' as const }]
  // 根会话：没有父会话、delegationDepth 为 0（真机里 `owner=cockpit` 认领很常见）
  assert.deepEqual(
    attributeRole({ sessionId: 'session-parent', delegationDepth: 0, claims }),
    { kind: 'cockpit', role: 'cockpit' },
    '父会话被判成 dispatched/developer ⇒ 掩码会拦它自己的工具调用（R-1 的真机症状）',
  )
  assert.deepEqual(attributeRole({ sessionId: 'session-parent', delegationDepth: undefined, claims }), { kind: 'cockpit', role: 'cockpit' }, 'depth 缺省按 0')

  // 子会话：带父会话 ⇒ 按认领卡的角色走（掩码照旧生效）
  assert.deepEqual(
    attributeRole({ sessionId: 'child-1', delegationDepth: 1, parentSessionId: 'session-parent', claims: [{ sessionId: 'child-1', cardId: 'TASK-022', role: 'developer' }] }),
    { kind: 'dispatched', role: 'developer', cardId: 'TASK-022' },
  )
  // 子会话即使 header 没带 parentSession（只有 depth）也仍按子会话走
  assert.deepEqual(
    attributeRole({ sessionId: 'child-2', delegationDepth: 1, claims: [{ sessionId: 'child-2', cardId: 'TASK-023', role: 'tester' }] }),
    { kind: 'dispatched', role: 'tester', cardId: 'TASK-023' },
  )
  // 子会话没认领过卡 ⇒ unclaimed-child（不因为"有父会话"就成了驾驶舱）
  assert.deepEqual(attributeRole({ sessionId: 'child-3', delegationDepth: 1, parentSessionId: 'session-parent', claims }), { kind: 'unclaimed-child', role: 'dispatched' })
  // 认领卡的 role 坏了 ⇒ 不施加掩码，但仍按非驾驶舱走
  assert.deepEqual(
    attributeRole({ sessionId: 'child-4', delegationDepth: 1, parentSessionId: 'session-parent', claims: [{ sessionId: 'child-4', cardId: 'TASK-024', role: 'nope' as never }] }),
    { kind: 'unclaimed-child', role: 'dispatched' },
  )
  // 拿不到会话 id ⇒ unknown（fail-open 到驾驶舱，与旧行为一致）
  assert.deepEqual(attributeRole({ sessionId: undefined, claims }), { kind: 'unknown', role: 'cockpit' })

  // 接线：钩子必须把**血缘**一起传进去（否则子/父分不开）
  const index = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.match(index, /parentSessionId: typeof parentSession === 'string' \? parentSession : undefined/u, 'attributeRole 要拿到 parentSession')
  assert.match(index, /sessionHeader\?\.parentSession/u, '从 session.header 读血缘')
  // **执行者禁令**的判据必须**同时**看 depth 与 parentSession（任一成立即"子会话"）
  assert.match(index, /delegationDepth >= 1/u, '执行者判定要看 delegationDepth')
  assert.match(index, /executor: isChildSession/u, '掩码判定要把"是不是执行者"传进去')
})

// —————————————————————— SDO-15：写范围对账必须同量纲 ——————————————————————

/** 直接往 journal 写一条认领事件（返回它的 journal seq，就是认领基线）。 */
function claimEvent(taskId: string, sessionId: string): number {
  return journal.append('task/claimed', { id: taskId, owner: 'dev', revision: 1, sessionId }).seq
}

test('SDO-15：宿主 seq 与 journal seq 不同量纲 ⇒ 不再把整会话改动算成越界；旧记录如实退回"未对账"', () => {
  const session = 'session-1'
  const claimSeq = claimEvent('TASK-022', session) // 认领基线（journal 序号，很小）
  // ① **认领前**的改动：宿主 seq 很大（真机 883/994/1488），journal 空间里在认领之前
  recordWorkspaceChanges({ store, sessionId: session, seq: 883, journalSeq: claimSeq - 1, summary: { files: [{ path: 'docs/early.md' }] }, enabled: true, hasProject: true })
  // ② **认领后**的改动：journal 空间里在认领之后
  recordWorkspaceChanges({ store, sessionId: session, seq: 994, journalSeq: claimSeq + 1, summary: { files: [{ path: 'src/card/file.ts' }] }, enabled: true, hasProject: true })

  const window = changedFilesSince(store, session, claimSeq)
  assert.deepEqual(window.files, ['src/card/file.ts'], '只算认领之后的改动（修复前这里会把 docs/early.md 也算进来 ⇒ 假越界）')
  assert.equal(window.audited, true, '窗口内每条都有摘要 ⇒ 已对账')

  // ③ 旧格式记录（没有 journalSeq）：**不参与比较**，且如实报"未对账"（不拿两个计数器硬拼）
  rmSync(join(BASE, '.sdo', 'evidence'), { recursive: true, force: true })
  recordWorkspaceChanges({ store, sessionId: session, seq: 1488, summary: { files: [{ path: 'docs/legacy.md' }] }, enabled: true, hasProject: true })
  const legacy = changedFilesSince(store, session, claimSeq)
  assert.deepEqual(legacy.files, [], '旧记录不参与比较 ⇒ 不产生假越界')
  assert.equal(legacy.audited, false, '⇒ 如实退回"未对账"（回执会写「写范围未对账」，而不是判越界）')

  // ④ `done` 时的补摘要窗口同口径（否则会给认领前的记录补摘要、噪音与误判都回来了）
  rmSync(join(BASE, '.sdo', 'evidence'), { recursive: true, force: true })
  recordWorkspaceChanges({ store, sessionId: session, seq: 883, journalSeq: claimSeq - 1, summary: undefined, enabled: true, hasProject: true })
  recordWorkspaceChanges({ store, sessionId: session, seq: 994, journalSeq: claimSeq + 1, summary: undefined, enabled: true, hasProject: true })
  assert.deepEqual(unresolvedSeqs(store, session, claimSeq), [994], '只补认领之后的那个宿主 seq')
})

test('SDO-15 真机形状：宿主 seq 全部远大于 journal 序号，且认领前有大量改动 ⇒ 窗口内为空（可收工）', () => {
  const session = 'session-real'
  // 真机形状：先有 440 条台账事件（立项→需求→设计→开发的正常轨迹），**认领发生在 seq ~441**；
  // 而这几笔改动记录是**更早**采集的（真机 seq 883/994/1488/1838 是宿主计数器，且发生在认领之前）。
  journal.append('phase/entered', { phase: 'construction' })
  for (let i = 0; i < 439; i += 1) journal.append('trace/linked', { from: `REQ-${i}`, to: `DES-${i}`, kind: 'req-des' })
  const claimSeq = claimEvent('TASK-022', session)
  assert.ok(claimSeq > 440, `前提：认领在 journal 的较后位置（实际 ${claimSeq}）`)
  for (const [hostSeq, journalSeq, file] of [
    [883, 100, '.poc/poc-build/build.gradle'],
    [994, 120, 'docs/port/psi-api-mapping.md'],
    [1488, 200, 'docs/METHOD-porting.md'],
    [1838, 300, 'docs/sdo-plugin-observations.md'],
  ] as const) {
    recordWorkspaceChanges({ store, sessionId: session, seq: hostSeq, journalSeq, summary: { files: [{ path: file }] }, enabled: true, hasProject: true })
  }
  const window = changedFilesSince(store, session, claimSeq)
  assert.deepEqual(window.files, [], '这些都在认领之前 ⇒ 不算本卡越界（这正是真机那 4 张卡被误判的原因）')
  assert.equal(window.audited, false, '没有窗口内记录 ⇒ 未对账（不冒充已核对）')
})

// —————————————————————— SDO-01：assume 与 answer 同传即报错 ——————————————————————

function writeQuestion(id: string, recommendation: string): void {
  store.writeYaml(['questions', `${id}.yml`], {
    question: {
      id,
      targets: ['REQ-001'],
      dimension: 'constraint',
      priority: 'P0',
      text: `${id} 的问题`,
      options: [],
      defaultRecommendation: recommendation,
      status: 'open',
      answer: '',
    },
  })
}

function writeRequirement(id: string): void {
  const requirement: Partial<Requirement> = { id, title: id, kind: 'functional', statement: 's', rationale: 'r', status: 'draft' }
  store.writeYaml(['requirements', `${id}.yml`], { requirement })
}

test('SDO-01：`assume=true` 与自有正文同传 ⇒ **可读失败**（不再静默丢正文）；两种合法写法照旧', () => {
  writeRequirement('REQ-001')
  writeQuestion('Q-0001', '题库建议：给出毫秒 + 数据量 + 分位')
  writeQuestion('Q-0002', '题库建议：按你的建议处理')

  // ① 矛盾组合 ⇒ 报错，且**不写盘**（不得留下半条答案）
  assert.throws(
    () => answerQuestion(store, journal, undefined, { id: 'Q-0001', answer: '【本领域化正文】配方与 GUI 需求…', assume: true, authorizedByUser: true, by: 'human' }),
    /assume=true/,
    '必须给出可读失败（旧实现把它静默替换成题库建议）',
  )
  assert.equal(readQuestion(store, 'Q-0001')?.answer, '', '被拒时不得写入任何答案')
  assert.equal(journal.read().events.filter((event) => event.type === 'question/answered').length, 0, '被拒时不得落 journal')

  // ② 要保留自己的正文 ⇒ 不传 assume
  const kept = answerQuestion(store, journal, undefined, { id: 'Q-0001', answer: '【本领域化正文】配方与 GUI 需求…', by: 'human' })
  assert.equal(kept?.question.answer, '【本领域化正文】配方与 GUI 需求…', '正文必须原样保留')
  assert.equal(kept?.question.status, 'answered')

  // ③ 要采用题库建议 ⇒ 传 assume 且不传 answer
  const adopted = answerQuestion(store, journal, undefined, { id: 'Q-0002', answer: '', assume: true, authorizedByUser: true, by: 'human' })
  assert.equal(adopted?.question.answer, '题库建议：按你的建议处理')
  assert.equal(adopted?.question.status, 'assumed')
})

// —————————————————————— SDO-05 / SDO-13：签字回执要写清"签之前做完什么" ——————————————————————

function signature(gate: string): GateSignature {
  return { gate, by: 'human', basis: '签字确认，批准通过', channel: 'question', at: '2026-10-05T00:00:00.000Z', atSeq: 1 }
}

test('SDO-05 / SDO-13：G2 回执提示"签前先登记风险/问题"，G3 回执提示"签前先补完契约"', () => {
  const g2 = describeSignature(signature('G2'), { status: 'valid', reason: 'ok' })
  assert.match(g2, /签字前请先把 需求 \/ 问题 \/ 风险 \/ 红队 登记完/u, `G2 回执要写出顺序要求：${g2.slice(-300)}`)
  assert.match(g2, /risk\/logged/u, '要点名 risk/logged 也会作废签字（真机就是这条把 G2 掀掉的）')

  const g3 = describeSignature(signature('G3'), { status: 'valid', reason: 'ok' })
  assert.match(g3, /契约与其它设计真源请在签字前补完/u, `G3 回执要写出"契约要签前补"：${g3.slice(-300)}`)
  assert.match(g3, /C-30/u, '要说明为什么（G4 的 C-30 要求契约齐备）')

  // 反向：其它门禁不硬塞这两句（避免变成人人无视的样板）
  const g1 = describeSignature(signature('G1'), { status: 'valid', reason: 'ok' })
  assert.doesNotMatch(g1, /签字前请先把 需求/u)
  assert.doesNotMatch(g1, /契约与其它设计真源/u)
})
