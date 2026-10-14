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
 *
 * —————————————————————— TASK-019：回归一等纪律（REQ-052） ——————————————————————
 *
 * 同文件追加**回归链**（变更集 → 影响集 → 回归集）的守卫。三条需求点各自对应下面的用例：
 *   · **AC-206**：影响集由**追溯图多跳闭包**推出（不是人手罗列），影响集里的用例没跑 ⇒ 判红并点名；
 *   · **AC-207**：图里没有相关边 ⇒ **显式报影响面不可推导**并给人工确认入口，**不默认"无影响"**；
 *   · **AC-208**：结果绑的产物哈希与当前产物不一致 ⇒ 判过期并**点名产物路径**。
 *
 * 还有一条**两态守卫**（DoD 的"守卫用例两态"）：把"图空 ⇒ 判不可推导"这一处**变异掉**
 * （`derivable = seeds.length > 0`，也就是"图里没写 = 没影响"那种静默口径），
 * 同一个探针必须**在变异体上判红、在当前实现上判绿** —— 变异过程与实测结论都印在下面那条用例里。
 * 它挡的正是本模块最危险的那种退化：**判据自己把"图里没写"读成"不用跑"**。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { answerQuestion, readQuestion } from '../src/domain/grill.js'
import { attributeRole } from '../src/domain/roles.js'
import { changedFilesSince, recordWorkspaceChanges, unresolvedSeqs } from '../src/domain/workspaceChanges.js'
import { link, traceClosure, traceGraphOf } from '../src/domain/trace.js'
import { CHECKERS, evaluateGate } from '../src/domain/gates.js'
import { loadProcess } from '../src/domain/process.js'
import { TESTING_SOURCE_FILES, readTestingSource } from '../src/domain/testingStore.js'
import { describeShapeReport } from '../src/domain/testingShapes.js'
import type { TestingShapeReport, TestingValidatedWriteResult } from '../src/domain/testingShapes.js'
import type { GateContext } from '../src/domain/gates.js'
import {
  assessRegression,
  assessRegressionFromStore,
  changeSetFromLedger,
  deriveImpact,
  describeRegression,
  type ChangeSet,
  type RegressionSourceInput,
} from '../src/domain/regression.js'
import { describeSignature } from '../src/interface/describe.js'
import type { GateSignature, Requirement } from '../src/types.js'
import type { TraceEdge } from '../src/domain/trace.js'

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

// —————————————————————— TASK-019：回归链（变更集 → 影响集 → 回归集，REQ-052） ——————————————————————

/**
 * 一张**形状干净**的小追溯图（TASK-019 的夹具）。
 *
 * `REQ-001 --req-tc--> TC-001`：这条边必须靠**两跳**才走得到（REQ → DES → TASK → TC）——
 * 只走一跳的实现在这里就会漏掉它（漏掉的后果是"该重跑的用例没进回归集"，正是本卡要挡的那类静默）。
 * `CE-1 --des-ct--> CT-006` 是**反向**边走回需求的样本（改了契约 ⇒ 它挂靠的需求也进影响集）。
 */
const BASIC_EDGES: TraceEdge[] = [
  { from: 'REQ-001', to: 'DES-001', kind: 'req-des' },
  { from: 'REQ-001', to: 'TASK-001', kind: 'req-task' },
  { from: 'REQ-001', to: 'TC-001', kind: 'req-tc' },
  { from: 'REQ-001', to: 'TC-002', kind: 'req-tc' },
  { from: 'DES-001', to: 'TASK-001', kind: 'des-task' },
  { from: 'DES-001', to: 'CT-006', kind: 'des-ct' },
  { from: 'REQ-002', to: 'DES-002', kind: 'req-des' },
  { from: 'REQ-001', to: 'DEF-004', kind: 'req-defect' },
]

const CHANGED_REQ_001: ChangeSet = {
  items: [{ id: 'REQ-001', file: '', from: 'CR-003' }],
  sources: { changes: 1, defects: 0, workspaceFiles: 0 },
  rawFileCount: 0,
}

/** 造一份回归真源（`artifactHash` 由调用方现算，避免手抄哈希）。 */
function regressionSource(cases: NonNullable<RegressionSourceInput['cases']>): RegressionSourceInput {
  return { impact: [], cases }
}

test('TASK-019 / AC-206：影响集由追溯图**多跳闭包**推出（不是人手罗列）', () => {
  const impact = deriveImpact(['REQ-001'], BASIC_EDGES)
  assert.equal(impact.derivable, true, `图非空且种子走得出去 ⇒ 影响面可推导：${impact.undecidable}`)
  assert.deepEqual(
    impact.nodes,
    ['CT-006', 'DEF-004', 'DES-001', 'REQ-001', 'TASK-001', 'TC-001', 'TC-002'],
    '闭包要走到 4 跳之外（REQ → DES → CT / REQ → TC），且不许把另一族（REQ-002 / DES-002）卷进来',
  )
  assert.deepEqual(impact.byPrefix.cases, ['TC-001', 'TC-002'], '用例是被"该重跑什么"点名的对象')
  assert.deepEqual(impact.byPrefix.tasks, ['TASK-001'])
  assert.deepEqual(impact.byPrefix.artifacts, ['CT-006'], '契约与设计元素分开点名（回执里能看清是什么被影响了）')

  // **反向边**同样算数：改了契约 CT-006 ⇒ 它挂靠的需求 REQ-001 及其整族进影响集
  const fromContract = deriveImpact(['CT-006'], BASIC_EDGES)
  assert.deepEqual(fromContract.byPrefix.requirements, ['REQ-001', 'REQ-002'].filter((id) => fromContract.nodes.includes(id)), '反向边要能走回需求')
  assert.ok(fromContract.byPrefix.cases.includes('TC-001'), `改了契约也要把相关用例带出来：${fromContract.byPrefix.cases.join(' ')}`)

  // **环**不许把遍历卡死或让结果抖动（图是人手维护的，环是常态）
  const cyclic = traceGraphOf(
    [
      { from: 'REQ-009', to: 'DES-009', kind: 'req-des' },
      { from: 'DES-009', to: 'REQ-009', kind: 'des-task' },
    ],
    0,
    2,
  )
  const closure = traceClosure(cyclic, ['REQ-009'])
  assert.deepEqual([...closure.nodes].sort(), ['DES-009', 'REQ-009'])

  // 同一张图 ⇒ 同一份影响集（判据可复算、报告可 diff）
  assert.deepEqual(deriveImpact(['REQ-001'], BASIC_EDGES).nodes, impact.nodes)
  assert.deepEqual(deriveImpact(['REQ-001'], [...BASIC_EDGES].reverse()).nodes, impact.nodes, '边的顺序不影响结论')
  // 与"人手罗列"划清界限：图里**没有**的东西不许出现在影响集里
  assert.ok(!impact.nodes.includes('TC-099'), '影响集只来自图，不来自谁的记忆')
})

test('TASK-019 / AC-206：影响集里的用例没跑 ⇒ 判红并**点名**（在回归集里的那条也要有结果）', () => {
  const assessment = assessRegression({
    workspace: ROOT,
    changeSet: CHANGED_REQ_001,
    // `artifact` 是**绑定的产物哈希**（`types.ts` 的 `TestingRegressionCase.artifact` +
    // 既有夹具 `test/m31.test.ts` 的 `regressionFixture()` 都是这个口径）
    source: regressionSource([
      { case: 'TC-001', result: 'pass', artifact: `sha256:${'c'.repeat(64)}`, command: 'node --test lib/test/m38.test.js' },
      { case: 'TC-099', result: 'fail', artifact: `sha256:${'c'.repeat(64)}` },
    ]),
    edges: BASIC_EDGES,
    knownCaseIds: ['TC-001', 'TC-002'],
  })
  assert.equal(assessment.outcome, 'incomplete', `影响集里的 TC-002 没跑 ⇒ 不许声称本次变更已完成：${describeRegression(assessment)}`)
  assert.deepEqual(assessment.missing, ['TC-002'], '漏跑的用例要逐个点名')
  assert.deepEqual(assessment.offenders, ['TC-001', 'TC-002', 'TC-099'], '点名集合 = 漏跑 ∪ 有问题的跑记录（多跑的那条失败了、只写哈希没写路径的那条，都要点名）')
  assert.ok(assessment.violations.some((issue) => issue.code === 'case-missing' && issue.field === 'TC-002'), '问题码要能按类分类')
  // **反向**（负向对照不许空转）：把 TC-002 补上就转绿 —— 否则上面那条断言在"永远判红"的实现上也成立
  const complete = assessRegression({
    workspace: ROOT,
    changeSet: CHANGED_REQ_001,
    source: regressionSource([
      { case: 'TC-001', result: 'pass', artifact: freshHashOf('src/domain/regression.ts'), artifactPath: 'src/domain/regression.ts' },
      { case: 'TC-002', result: 'pass', artifact: freshHashOf('src/domain/regression.ts'), artifactPath: 'src/domain/regression.ts' },
    ]),
    edges: BASIC_EDGES,
    knownCaseIds: ['TC-001', 'TC-002'],
  })
  assert.equal(complete.outcome, 'ok', `补齐后必须转绿（否则"判红"没有判别力）：${describeRegression(complete)}`)
  assert.deepEqual(complete.missing, [])
  assert.equal(complete.counts.passed, 2, '两条都通过且产物哈希对得上 ⇒ 计入通过')
})

test('TASK-019 / AC-206：**跑失败**与**没结果**分开点名（都判红，但补救动作不同）', () => {
  const failed = assessRegression({
    workspace: ROOT,
    changeSet: CHANGED_REQ_001,
    source: regressionSource([
      { case: 'TC-001', result: 'fail', artifact: `sha256:${'c'.repeat(64)}` },
      { case: 'TC-002', result: '', artifact: `sha256:${'c'.repeat(64)}` },
    ]),
    edges: BASIC_EDGES,
  })
  assert.equal(failed.outcome, 'incomplete')
  assert.deepEqual(failed.offenders, ['TC-001', 'TC-002'])
  assert.equal(failed.counts.failed, 1)
  assert.equal(failed.counts.notRun, 1)
  assert.ok(failed.violations.some((issue) => issue.code === 'run-failed' && issue.message.includes('没通过')), '跑失败要说"去修"，不是"去重跑"')
  assert.ok(failed.violations.some((issue) => issue.code === 'not-run' && issue.message.includes('narrow')), '没跑要说清"补跑或写进 narrow 说明为什么不跑"')
  assert.equal(failed.counts.passed, 0, '**有结果 ≠ 通过了**：pass 之外一条都不许计入通过')
})

test('TASK-019 / AC-208：产物哈希过期 ⇒ 判过期并**点名产物路径**（不点名就等于没判）', () => {
  const artifact = 'src/domain/regression.ts'
  const current = freshHashOf(artifact)
  assert.equal(current.length, 64, '夹具前提：产物哈希是 64 位十六进制（`hashOf` 的口径，写进真源时可带 `sha256:` 前缀）')
  /**
   * 同一份真源、只换被测产物那一处 ⇒ 逐条看结论（判据可复算，回执可点名）。
   *
   * **两种写法都要覆盖**（`assessRun` 的表）：`artifact` 写**哈希**（与 `artifactHash` 路径配对）、
   * 或 `artifact` 直接写**路径**。
   */
  const withArtifact = (
    value: string | undefined,
    /** `null` = **这一条不写产物路径**（`undefined` 是"用默认的那条路径"：默认参数遇到显式 `undefined` 也会生效，
     *  真机实测踩过 —— 想表达"没给"必须用一个能穿过默认值的哨兵）。 */
    artifactPath: string | null = artifact,
    result = 'pass',
  ): ReturnType<typeof assessRegression> =>
    assessRegression({
      workspace: ROOT,
      changeSet: CHANGED_REQ_001,
      source: regressionSource([
        { case: 'TC-001', result, ...(value === undefined ? {} : { artifact: value }), ...(artifactPath === null ? {} : { artifactPath }) },
        { case: 'TC-002', result: 'pass', artifact: current, artifactPath: artifact },
      ]),
      edges: BASIC_EDGES,
    })

  // ① 记录时的那一版就是现在这一版 ⇒ 可用（**负向对照的前提**：判据不是"永远判过期"）
  const fresh = withArtifact(current)
  assert.equal(fresh.outcome, 'ok', `哈希一致时必须可用：${describeRegression(fresh)}`)
  assert.equal(fresh.counts.stale, 0)
  assert.equal(fresh.counts.passed, 2)
  assert.deepEqual(fresh.staleArtifacts, [])

  // ② 同一份真源、把哈希换掉（= 产物在记录之后被改动）⇒ **判过期**并点名产物路径与两个哈希
  const changed = withArtifact(`sha256:${'a'.repeat(64)}`)
  assert.equal(changed.outcome, 'stale', `哈希不符必须判过期（过期优先于其它问题）：${describeRegression(changed)}`)
  assert.deepEqual(changed.staleArtifacts, [artifact], 'AC-208：过期的**产物路径**要能被点名')
  assert.deepEqual(changed.offenders, ['TC-001'])
  const changedText = describeRegression(changed)
  assert.ok(changedText.includes(artifact), `回执里要点名那个产物路径：${changedText.slice(0, 400)}`)
  assert.ok(changedText.includes('aaaa') && changedText.includes(current.slice(0, 12)), '回执里要印出"记录时 vs 现在"两个哈希，人才能比对')

  // ③ 两态差别的**来源只有哈希**（同一份真源、同一张图）——这就是负向对照不空转的证据
  assert.equal(fresh.counts.cases, changed.counts.cases)
  assert.notEqual(fresh.outcome, changed.outcome)

  // ④ `sha256:` 前缀有无不算"变"（归一化后逐字比对：不然记录时少写个前缀会假报过期）
  const prefixed = withArtifact(`sha256:${current}`)
  assert.equal(prefixed.outcome, 'ok', `同一哈希换个写法不许假报过期：${describeRegression(prefixed)}`)

  // ⑤ 只写哈希不写产物路径 ⇒ **判不动**（`artifact` 位是哈希 ⇒ 不知道产物在哪，无从核对它有没有变）
  const hashOnly = withArtifact(`sha256:${'b'.repeat(64)}`, null)
  assert.equal(hashOnly.outcome, 'incomplete')
  assert.equal(hashOnly.counts.unbound, 1)
  assert.ok(hashOnly.violations.some((issue) => issue.code === 'artifact-path-missing'), '要说清缺的是"产物路径"')

  // ⑥ 产物路径写错 / 产物被删（哈希还在）⇒ 判红并点名那个路径（*这一条*要的是"点得出是哪个产物"）
  const gone = withArtifact(`sha256:${'d'.repeat(64)}`, 'src/domain/does-not-exist.ts')
  assert.equal(gone.outcome, 'incomplete')
  assert.equal(gone.counts.artifactMissing, 1)
  assert.ok(gone.violations.some((issue) => issue.code === 'artifact-missing' && issue.message.includes('does-not-exist.ts')), '点名的必须是那个路径')

  // ⑦ 产物绑到**工作区之外** ⇒ 判红（证据只认本工作区里的产物）
  const outside = withArtifact(`sha256:${'d'.repeat(64)}`, '/etc/hostname')
  assert.equal(outside.outcome, 'incomplete')
  assert.equal(outside.counts.artifactMissing, 1)
  assert.ok(outside.violations.some((issue) => issue.code === 'artifact-outside'), '要说清"必须是本工作区里的产物"')

  // ⑧ 通过了却根本没绑产物 ⇒ 同样不许算数（REQ-052 的"结果须绑被测产物哈希"）
  const blank = withArtifact(undefined)
  assert.equal(blank.outcome, 'incomplete')
  assert.equal(blank.counts.unbound, 1)
  assert.equal(blank.counts.passed, 1, '只有 TC-002 那条算通过（它绑了产物哈希）')
})

test('TASK-019 / AC-207：追溯图里没有相关边 ⇒ 显式报**影响面不可推导**并给人工确认入口（不默认无影响）', () => {
  // ① 图**空**：连边都没有 ⇒ 不可推导（这里是最危险的那种静默：图上没写 = 不用跑）
  const emptyGraph = assessRegression({
    workspace: ROOT,
    changeSet: CHANGED_REQ_001,
    source: regressionSource([{ case: 'TC-001', result: 'pass', artifact: `sha256:${'c'.repeat(64)}` }]),
    edges: [],
  })
  assert.equal(emptyGraph.impact.derivable, false)
  assert.equal(emptyGraph.impact.graphEmpty, true)
  assert.equal(emptyGraph.outcome, 'incomplete', '图空 ⇒ 判红，不许当"无影响"')
  assert.ok(emptyGraph.violations.some((issue) => issue.code === 'impact-underivable'), '要如实报"不可推导"')
  assert.ok(emptyGraph.violations.some((issue) => issue.code === 'undecidable-missing'), '推不出来又不声明不可推导 ⇒ 单独一条判红')
  const text = describeRegression(emptyGraph)
  assert.match(text, /不可推导/u, `回执要点明影响面不可推导：${text}`)
  assert.match(text, /sdo_trace action=link/u, '要给**可执行**的人工确认入口（补图），不是一句"请人工确认"')
  assert.deepEqual(emptyGraph.missing, [], '推不出来时不做"漏跑"对账（该跑什么是未知，硬对账会退化成"图上没写=不用跑"）')

  // ② 显式声明了不可推导 ⇒ 那条"没声明"的判红消失，但**不可推导本身仍判红**
  const declared = assessRegression({
    workspace: ROOT,
    changeSet: CHANGED_REQ_001,
    source: { undecidable: '追溯图为空：本轮由人工确认影响范围为 REQ-001 全族（确认人：用户）', cases: [] },
    edges: [],
  })
  assert.equal(declared.outcome, 'incomplete')
  assert.ok(!declared.violations.some((issue) => issue.code === 'undecidable-missing'), '声明了就撤销"没声明"那一击')
  assert.ok(declared.violations.some((issue) => issue.code === 'impact-underivable'), '但是"不可推导"本身不许被一句声明洗白')

  // ③ **反向**（本卡最容易搞错的一处）：图**非空**、种子走得出去、就是**推不出用例**
  //    （影响集里只有设计元素，还没有用例）⇒ 这是"推出来了、就是没有"，**不算不可推导**。
  //    把它当不可推导会让判据永远发不出绿（每条需求早期都没用例）。
  const noCases = deriveImpact(['REQ-002'], BASIC_EDGES)
  assert.equal(noCases.derivable, true, '图非空且种子走得出去 ⇒ 可推导')
  assert.deepEqual(noCases.byPrefix.cases, [], '这条需求的族里确实还没有用例')
  const derived = assessRegression({
    workspace: ROOT,
    changeSet: { items: [{ id: 'REQ-002', file: '', from: 'CR-004' }], sources: { changes: 1, defects: 0, workspaceFiles: 0 }, rawFileCount: 0 },
    // `impact` 非空 = 影响面**记下来了**（TASK-055：这一档要求真源"有内容"；
    // `{impact: [], cases: []}` 那种四位全空的写法按"没记回归"判红，见本文件末尾的守卫态⑤）
    source: { impact: ['REQ-002', 'DES-002'], cases: [] },
    edges: BASIC_EDGES,
  })
  assert.equal(derived.outcome, 'ok', `推得出但推不出用例 ⇒ 不算不可推导（否则判据永远红）：${describeRegression(derived)}`)
  assert.deepEqual(derived.missing, [])

  // ④ 种子在图上一跳都走不出去（图里有别的边）⇒ 点名这个种子"判不动"
  const orphanSeed = assessRegression({
    workspace: ROOT,
    changeSet: { items: [{ id: 'REQ-777', file: '', from: 'CR-009' }], sources: { changes: 1, defects: 0, workspaceFiles: 0 }, rawFileCount: 0 },
    source: { undecidable: 'REQ-777 未建图，人工确认无下游', cases: [] },
    edges: BASIC_EDGES,
  })
  assert.equal(orphanSeed.impact.derivable, false)
  assert.deepEqual(orphanSeed.impact.unconnected, ['REQ-777'])
  assert.equal(orphanSeed.outcome, 'incomplete')
  assert.ok(orphanSeed.violations.some((issue) => issue.code === 'seed-unconnected' && issue.field === 'REQ-777'), '要**点名**是哪个种子判不动')

  // ⑤ 图里有坏行 ⇒ 图不完整，单独判红（"没这条边"与"这条边读不出来"分不开）
  const badLines = assessRegression({
    workspace: ROOT,
    changeSet: CHANGED_REQ_001,
    source: regressionSource([
      { case: 'TC-001', result: 'pass', artifact: `sha256:${'c'.repeat(64)}` },
      { case: 'TC-002', result: 'pass', artifact: `sha256:${'c'.repeat(64)}` },
    ]),
    edges: BASIC_EDGES,
    badLines: 2,
    totalLines: BASIC_EDGES.length + 2,
  })
  assert.equal(badLines.outcome, 'incomplete')
  assert.ok(badLines.violations.some((issue) => issue.code === 'graph-unreadable' && issue.message.includes('2 行')), '坏行数要点名')
})

test('TASK-019：变更集从**台账**现取（不留痕的文件不假装属于某条需求）', () => {
  store.writeYaml(['changes', 'CR-003.yml'], {
    change: { id: 'CR-003', requirement: 'REQ-001', reason: '口径变更', changes: ['改验收标准'], impact: { design: [], tasks: [], tests: [], note: '' }, decision: 'approved', decidedBy: 'human', at: '2026-10-13T00:00:00.000Z' },
  })
  store.writeYaml(['changes', 'CR-004.yml'], {
    change: { id: 'CR-004', requirement: 'REQ-002', reason: '被拒的变更', changes: ['x'], impact: { design: [], tasks: [], tests: [], note: '' }, decision: 'rejected', decidedBy: 'human', at: '2026-10-13T00:00:00.000Z' },
  })
  store.writeYaml(['defects', 'DEF-004.yml'], { defect: { id: 'DEF-004', title: '签字的假缺失', severity: 'major', status: 'fixed', at: '2026-10-13T00:00:00.000Z' } })
  recordWorkspaceChanges({ store, sessionId: 's1', seq: 10, summary: { files: [{ path: 'src/domain/trace.ts' }, { path: 'docs/x.md' }] }, enabled: true, hasProject: true })

  const changeSet = changeSetFromLedger(store)
  assert.deepEqual(changeSet.sources, { changes: 1, defects: 1, workspaceFiles: 2 })
  // 被拒的 CR **不进**变更集（没落地的变更不产生回归义务）
  assert.ok(!changeSet.items.some((item) => item.from === 'CR-004'), '只有 approved 的 CR 才算变更')
  assert.ok(changeSet.items.some((item) => item.id === 'REQ-001' && item.from === 'CR-003'))
  assert.ok(changeSet.items.some((item) => item.id === 'DEF-004'), '已修缺陷是变更集的一项（后果由 req-defect 边去推）')
  // 文件项：图里**恰好**出现过 `src/domain/trace.ts` 才补得成实体；`docs/x.md` 补不上就如实记成文件项
  assert.equal(changeSet.rawFileCount, 2, '两个文件原样记下来（不假装它们属于某条需求）')
  const seeds = changeSet.items.map((item) => item.id).filter((id) => id !== '').sort()
  assert.deepEqual(seeds, ['DEF-004', 'REQ-001'], '种子 = 实体 id（文件能不能补成实体由 deriveImpact/changeSetSeeds 看图定）')
})

// —————————————————————— TASK-019：守卫用例**两态**（变异自证） ——————————————————————

/**
 * 探针：把"图空 ⇒ 影响面不可推导"这条纪律压成一个**两态**观察。
 *
 * 判据是**负向**的：一份回归真源里**只有 TC-001**、而图里 REQ-001 的族含 TC-001 与 TC-002 ⇒
 * 正确实现必须报 `missing`（漏跑 TC-002）；"图里没写 = 没影响"那种静默实现会报空。
 *
 * 为什么这么写：这正是本模块**最危险的退化方向** —— 判据自己把"图里没写"读成"不用跑"，
 * 于是永远绿、且错的正是它唯一的职责。所以红灯不是"随便改坏一处"，而是**把这条纪律变异掉**。
 */
const GUARD_PROBE = `import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { assessRegression } from '__SUT__'
// 被检产物就在探针的 cwd 下：记录的哈希与现算的哈希必须**一致**，
// 否则两态观察会先撞上"过期"这一条，红/绿的差别就不再来自"图空 ⇒ 不可推导"。
const BODY = 'TASK-019 guard artifact\\n'
writeFileSync('guard-artifact.txt', BODY)
const hash = createHash('sha256').update(BODY).digest('hex')
const changeSet = { items: [{ id: 'REQ-001', file: '', from: 'CR-003' }], sources: { changes: 1, defects: 0, workspaceFiles: 0 }, rawFileCount: 0 }
const first = assessRegression({
  workspace: process.cwd(),
  changeSet,
  source: { cases: [{ case: 'TC-001', result: 'pass', artifact: hash, artifactPath: 'guard-artifact.txt' }] },
  edges: [],
})
const second = assessRegression({
  workspace: process.cwd(),
  changeSet,
  source: { cases: [{ case: 'TC-001', result: 'pass', artifact: hash, artifactPath: 'guard-artifact.txt' }] },
  edges: [{ from: 'REQ-001', to: 'TC-001', kind: 'req-tc' }, { from: 'REQ-001', to: 'TC-002', kind: 'req-tc' }],
})
console.log('GUARD=' + JSON.stringify({
  derivableOnEmptyGraph: first.impact.derivable,
  missingOnEmptyGraph: first.missing.length,
  undecidableSpoken: first.violations.some((issue) => issue.code === 'impact-underivable'),
  derivableOnFilledGraph: second.impact.derivable,
  missingOnFilledGraph: second.missing.length,
}))
`

/** 仓库根下某个**相对路径**的当前 sha256（与被检产物的哈希口径一致：64 位十六进制）。 */
function freshHashOf(relative: string): string {
  const run = spawnSync(process.execPath, ['-e', `process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(${JSON.stringify(join(ROOT, relative))})).digest('hex'))`], { encoding: 'utf8' })
  assert.equal(run.status, 0, `夹具前提：读得到 ${relative}`)
  return run.stdout.trim()
}

test('TASK-019 DoD（守卫用例两态）：把"图空 ⇒ 判不可推导"变异掉 ⇒ 探针必须变红；回滚 ⇒ 变绿', () => {
  const guard = join(ROOT, 'node_modules', '.sdo-test', 'm38-guard')
  rmSync(guard, { recursive: true, force: true })
  mkdirSync(guard, { recursive: true })
  /**
   * 探针里的被测模块由**每次运行**注入绝对 URL（变异体在临时目录里，相对 import 会解析到不存在的
   * 文件 —— 那样红灯就退化成"路径错误"，而不是"这条纪律被砍掉了"；本用例第一版真实踩过这个坑，
   * 当时探针里写死了当前实现，于是两态都是绿的、红灯是**假**的）。
   */
  const writeProbe = (module: string): void => {
    writeFileSync(join(guard, 'probe.mjs'), GUARD_PROBE.replace('__SUT__', pathToFileURL(module).href), 'utf8')
  }

  /** 跑一次探针（`module` 指向要加载的 regression.js）。 */
  const runProbe = (module: string): { code: number; out: string; seen: Record<string, unknown> } => {
    writeProbe(module)
    const script = `import ${JSON.stringify(pathToFileURL(join(guard, 'probe.mjs')).href)}\n`
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: guard, encoding: 'utf8' })
    const out = `${run.stdout}${run.stderr}`
    const matched = /GUARD=(\{.*\})/u.exec(out)
    return { code: run.status ?? -1, out, seen: matched === null ? {} : (JSON.parse(matched[1] as string) as Record<string, unknown>) }
  }

  // —— 红态：把"图空"这条纪律变异掉（等价于"图里没写 = 没影响"）——
  const compiled = join(ROOT, 'lib', 'src', 'domain', 'regression.js')
  assert.ok(existsSync(compiled), `变异自证要先有编译产物（npm run build）：${compiled}`)
  const original = readFileSync(compiled, 'utf8')
  const needle = 'const derivable = unique.length > 0 && !graphEmpty && unconnected.length === 0'
  assert.ok(original.includes(needle), '变异点必须还在（没找到它说明实现变了，这条守卫要跟着改，不许静默失效）')
  const mutant = join(guard, 'regression.mutant.mjs')
  // 变异体放进临时目录后，**相对 import 要按编译产物所在目录改写**（否则它连加载都失败，
  // 红灯就退化成"语法/路径错误"而不是"这条纪律被砍掉了"）
  const rewritten = original.replace(/from '(\.[^']*)'/gu, (_all, spec: string) => `from '${pathToFileURL(join(ROOT, 'lib', 'src', 'domain', spec)).href}'`)
  writeFileSync(mutant, rewritten.replace(needle, 'const derivable = unique.length > 0'), 'utf8')
  assert.notEqual(readFileSync(mutant, 'utf8'), original, '变异体必须与当前实现**实质不同**（否则红态是假的）')

  const red = runProbe(mutant)
  assert.equal(red.code, 0, `变异体必须能跑起来（否则探针跑不动，红态不成立）：${red.out.slice(-400)}`)
  assert.equal(red.seen['derivableOnEmptyGraph'], true, `变异体把图空当"可推导（无影响）"：${red.out.slice(-400)}`)
  assert.equal(red.seen['missingOnEmptyGraph'], 0, '变异体因此**漏掉**"图空就该报的不可推导"')
  assert.equal(red.seen['undecidableSpoken'], false, '变异体不会说"影响面不可推导"——这就是要挡的静默')
  assert.equal(red.seen['missingOnFilledGraph'], 1, `前提：图非空时它仍会报漏跑（说明变异只砍了图空那一条）：${red.out.slice(-400)}`)

  // —— 绿态：回滚到当前实现，同一个探针必须变绿 ——
  const green = runProbe(compiled)
  assert.equal(green.code, 0, `当前实现必须能跑起来：${green.out.slice(-400)}`)
  assert.equal(green.seen['derivableOnEmptyGraph'], false, '当前实现：图空 ⇒ 不可推导')
  assert.equal(green.seen['missingOnEmptyGraph'], 0, '当前实现：推不出来时不做"漏跑"对账（该跑什么是未知）')
  assert.equal(green.seen['undecidableSpoken'], true, '当前实现：必须显式说出"影响面不可推导"')
  assert.equal(green.seen['derivableOnFilledGraph'], true, '当前实现：图非空 ⇒ 可推导')
  assert.equal(green.seen['missingOnFilledGraph'], 1, '当前实现：图里写了 TC-002 而回归集里没有 ⇒ 点名漏跑')
  // 两态必须是**同一个探针**在**同一张图**上的不同结论（红态绿态的差别只来自被测实现）
  assert.notEqual(red.seen['undecidableSpoken'], green.seen['undecidableSpoken'])
  rmSync(guard, { recursive: true, force: true })
})

test('TASK-019 真机接线：本仓现取一次回归链（图 / 变更集 / 真源都在盘上时必须给出可复算的结论）', () => {
  const live = new SdoStore(join(ROOT, '.sdo'))
  const changeSet = changeSetFromLedger(live)
  // 走**生产路径**读盘（`traceGraph` + `readTestingSource`），而不是把边喂给纯函数
  const assessment = assessRegressionFromStore(live, ROOT, changeSet)
  const text = describeRegression(assessment)
  assert.ok(text.length > 0)
  // 结论要么是"真源不在盘上"（本仓的实证状态），要么是一份可复算的链上读数；
  // **绝不许**出现"图空却判绿"这种静默（那正是两态守卫挡的那条）
  if (!assessment.present) {
    assert.match(text, /regression\.yml 不在盘上/u, `如实说"没记回归"：${text}`)
  } else {
    assert.notEqual(assessment.outcome, 'ok', `真源在盘上时必须逐条判过：${text}`)
  }
  assert.ok(assessment.impact.totalLines >= 0)
})

// —————————————————————— TASK-037：回归集进门禁判据（G6 C-57）+ regression.yml 落盘 ——————————————————————
//
// REQ-052 到 TASK-019 为止只交付了**判定层**（`regression.ts`：变更集 → 影响集 → 回归集）。
// 判定层再对，只要没接在门禁上，它就只是一个"没人调用的库"。这一节钉三件事：
//
//   ① **落点一（接线）**：`CHECKERS['regression.discipline']` 存在，且走**真实接线**（`evaluateGate`
//      判 G6）时 `C-57` 真的出现、结论与判定层一致 —— 只测判定函数的用例，"判据根本没人调用"也会全绿。
//   ② **落点四（两态守卫）**：影响集齐备 + 产物哈希一致 ⇒ 判据绿；漏跑一条 / 产物改动 ⇒ 判红并
//      **点名**（用例 id、产物路径、记录时 vs 现在的两侧哈希），且补救来自判定层（`regressionRemedy`）。
//   ③ **落点三（落盘路径）**：`.sdo/testing/regression.yml` 由具名出口 `writeRegressionSource` 落盘 ——
//      形状合法才写、非法**一个字节都不写**（不落半成品），回执点名到字段（TASK-016 的 coverage.yml
//      在 `test/m35.test.ts` 的 M35-17 走的是同一个落盘闸门）。
//
// 为什么落盘出口要**按名取用**（`await import` + 断言）而不是静态 `import { writeRegressionSource }`：
// 本卡的**红侧**就是"出口还没接通"。静态 import 会让 `tsc` 直接失败，红态于是退化成"编译不过"
// 而不是"断言红" —— 同 TASK-019 那条守卫的教训（红态必须是行为红，不是语法/路径红）。

/** 本节夹具的独立沙箱（与文件顶部的 `BASE` 分开，免得与 R-1 / SDO-15 的夹具互相清空）。 */
const REG_BASE = join(ROOT, 'node_modules', '.sdo-test', 'm38-regression-gate')
/** 被测产物（绑在回归结果上的那一版）：相对工作区的路径。 */
const REG_ARTIFACT = 'artifacts/unit.txt'

function regClean(): void {
  rmSync(REG_BASE, { recursive: true, force: true })
  mkdirSync(join(REG_BASE, '.sdo'), { recursive: true })
  mkdirSync(join(REG_BASE, 'artifacts'), { recursive: true })
}

function writeArtifact(text: string): void {
  writeFileSync(join(REG_BASE, 'artifacts', 'unit.txt'), text)
}

/** 现算被测产物的 sha256（与 `coverage.pathFingerprint` 同一口径：文件的字节摘要）。 */
function artifactHash(): string {
  return createHash('sha256').update(readFileSync(join(REG_BASE, 'artifacts', 'unit.txt'))).digest('hex')
}

/** 与 `regression.ts` 的 `shorten` 同口径（>16 位取前 16 位 + 省略号）：回执里印的就是这个形态。 */
function shortenHash(value: string): string {
  const text = value.trim()
  return text.length > 16 ? `${text.slice(0, 16)}…` : text
}

/**
 * 夹具：一条**已批准**的变更（否则变更集为空 ⇒ 影响面推不出来，绿态发不出来）+ 追溯图
 * （`REQ-052 → TC-046 / TC-047`，走生产的 `link()` 建边）+ 一个被测产物。
 */
function regressionGateFixture(): { ctx: GateContext; store: SdoStore } {
  regClean()
  writeArtifact('regression artifact v1\n')
  const store = new SdoStore(join(REG_BASE, '.sdo'))
  const journal = new Journal(store)
  store.writeYaml(['changes', 'CR-052.yml'], {
    change: {
      id: 'CR-052',
      requirement: 'REQ-052',
      reason: '把回归判据接到 G6',
      changes: ['新增回归判据 C-57'],
      impact: { design: [], tasks: [], tests: [], note: '' },
      decision: 'approved',
      decidedBy: 'human',
      at: '2026-10-13T00:00:00.000Z',
    },
  })
  link(store, journal, { from: 'REQ-052', to: 'TC-046', kind: 'req-tc' })
  link(store, journal, { from: 'REQ-052', to: 'TC-047', kind: 'req-tc' })
  // `waivedGates` 必须给：`evaluateGate` 的放行判定读它（`ctx.waivedGates.includes(...)`），
  // 缺了它整门会塌成一条 `gate.internal`（那是夹具的缺口，不是被测行为）。
  const ctx = { workspace: REG_BASE, store, journal, requirements: [], waivedGates: [] } as unknown as GateContext
  return { ctx, store }
}

/** 一条回归跑记录（`artifact` 写**当前**这一版产物的哈希，`artifactPath` 写路径 —— 两位配对）。 */
function regressionCaseOf(caseId: string): Record<string, unknown> {
  return { case: caseId, result: 'pass', artifact: `sha256:${artifactHash()}`, artifactPath: REG_ARTIFACT, command: 'node --test lib/test/m38.test.js' }
}

/** 一份回归真源（`impact` 与图上现推的影响集一致：种子 REQ-052 + 两条用例）。 */
function regressionSourceOf(cases: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { impact: ['REQ-052', 'TC-046', 'TC-047'], cases }
}

/** 形状回执的一行摘要（判红时打进断言消息里，省得只看到 `false !== true`）。 */
function shapeIssueText(report: TestingShapeReport | undefined): string {
  if (report === undefined) return '（没有形状回执）'
  return describeShapeReport(report)
}

type RegressionWriteGate = (store: SdoStore, value: unknown, options?: Record<string, unknown>) => TestingValidatedWriteResult

/**
 * 落点三的**具名落盘出口**（`gates.ts` 的 `writeRegressionSource`），按名取用（见本节抬头）。
 *
 * 红侧（出口未接通）时它是 `undefined` ⇒ 断言当场红，而不是整个文件编译不过。
 */
async function regressionWriteGate(): Promise<RegressionWriteGate> {
  const module = (await import('../src/domain/gates.js')) as unknown as Record<string, unknown>
  const gate = module['writeRegressionSource']
  assert.equal(typeof gate, 'function', 'gates.ts 必须导出 writeRegressionSource（落点三：.sdo/testing/regression.yml 的落盘出口）')
  return gate as RegressionWriteGate
}

test('TASK-037 落点二：四个流程的 G6 都声明了 C-57（check=regression.discipline），且该 check 键真的有实现', () => {
  for (const process of ['waterfall', 'agile', 'prototype', 'spiral']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'processes', `${process}.yml`), 'utf8')
    const g6 = text.slice(text.indexOf('- id: G6'), text.indexOf('- id: G7'))
    assert.match(
      g6,
      /id: C-57,\s*check: "regression\.discipline"/u,
      `${process} 的 G6 必须声明 C-57 且 check 指向 regression.discipline（判据没接在门禁上 = 没做）\n${g6}`,
    )
    assert.equal((g6.match(/id: C-57,/gu) ?? []).length, 1, `${process} 的 G6 里 C-57 只许声明一次（重号即错配）`)
    assert.match(g6, /回归/u, `${process} 的 C-57 描述要写清是回归纪律`)
  }
  // 判据存在但**没实现**时 `evaluateGate` 按"未实现即失败"处理（fail-closed）：这里直接钉实现
  assert.equal(typeof CHECKERS['regression.discipline'], 'function', 'regression.discipline 必须在 CHECKERS 里注册')
})

test('TASK-037 落点一/落点四：判据经 evaluateGate 真的进 G6；齐备 + 哈希一致 ⇒ 绿，漏跑 / 产物改动 ⇒ 判红并点名', async () => {
  const { ctx, store } = regressionGateFixture()
  const writeGate = await regressionWriteGate()
  const checker = CHECKERS['regression.discipline']
  assert.equal(typeof checker, 'function', 'regression.discipline 必须在 CHECKERS 里注册（否则 G6 少判一条）')
  if (checker === undefined) throw new Error('regression.discipline 未注册')

  // ① 绿侧（守卫态一）：影响集齐备（TC-046 / TC-047 都在）且产物哈希与当前一致 ⇒ **判据绿**
  const greenWrite = writeGate(store, regressionSourceOf([regressionCaseOf('TC-046'), regressionCaseOf('TC-047')]))
  assert.equal(greenWrite.ok, true, `形状合法的回归真源应当能落盘：${shapeIssueText(greenWrite.report)}`)
  const green = checker(ctx)
  assert.equal(green.ok, true, `齐备 + 哈希一致 ⇒ 判据必须绿：${green.detail}`)
  assert.equal(green.na, undefined, '不许用 N/A 蒙过去（N/A 既不算过也不算不过）')
  assert.match(green.detail, /回归链可用/u, `回执要说清链条走通了：${green.detail}`)

  // ①b **真实接线**：走 `evaluateGate` 判 waterfall 的 G6 —— C-57 必须真的出现在逐条判定里，
  //     且结论与判定层一致。只测 `CHECKERS[...]` 的话，"判据根本没挂到 G6 上"也能全绿。
  const waterfall = loadProcess('waterfall')
  assert.ok(waterfall !== undefined, '随包流程数据必须读得到（src/data/processes/waterfall.yml）')
  const greenGate = evaluateGate(waterfall, 'G6', ctx)
  const greenCriterion = greenGate.criteria.find((item) => item.id === 'C-57')
  assert.ok(greenCriterion !== undefined, `G6 的逐条判定里必须有 C-57：${greenGate.criteria.map((item) => item.id).join(' ')}`)
  assert.equal(greenCriterion?.ok, true, `C-57 与判定层结论一致（绿）：${greenCriterion?.detail}`)

  // ② 真源不在盘上：**处置看变更集**（TASK-055 收窄了 TASK-037 的无条件 N/A）。
  //    这一份夹具的变更集**非空**（`CR-052` 已批准）⇒ 有变更却完全没记回归 ⇒ **判红**，
  //    而不是"三态里的第三态"——否则 REQ-052 的核心纪律从 G6 下面漏过去（本卡要补的就是这一档）。
  //    "无变更集 ⇒ 仍按 N/A"那一侧由本文件末尾的 TASK-055 守卫态③独立看着。
  rmSync(join(REG_BASE, '.sdo', 'testing', 'regression.yml'), { force: true })
  const absent = checker(ctx)
  assert.equal(absent.ok, false, `有变更却删掉真源 ⇒ 判红（不再转 N/A）：${absent.detail}`)
  assert.equal(absent.na, undefined, '不许再降级成 N/A（TASK-055 落点一）')
  assert.match(absent.detail, /regression\.yml 不在盘上/u, '要把判定层的话原样带出来（人据此知道怎么补）')
  assert.match(absent.detail, /本次变更未记回归/u, '要点名"本次变更未记回归"')
  assert.ok((absent.remedy ?? '').includes('sdo_test') && (absent.remedy ?? '').includes('undecidable'), `修法要给出两条可执行的路（补记真源 / 显式声明无影响面）：${absent.remedy ?? ''}`)

  // ③ 漏跑一条（守卫态二之一）：影响集里的 TC-047 没进回归集 ⇒ 判红并**点名那条用例**
  const partial = writeGate(store, regressionSourceOf([regressionCaseOf('TC-046')]))
  assert.equal(partial.ok, true, `形状合法（少一条记录不是形状问题）：${shapeIssueText(partial.report)}`)
  const missing = checker(ctx)
  assert.equal(missing.ok, false, `影响集里的 TC-047 没跑 ⇒ 判据必须红：${missing.detail}`)
  assert.equal(missing.na, undefined, '判红就是判红，不许同时挂 N/A')
  assert.match(missing.detail, /TC-047/u, `要点名漏跑的那条用例：${missing.detail}`)
  assert.ok((missing.remedy ?? '').includes('sdo_trace action=link'), `补救要来自判定层（可执行入口）：${missing.remedy ?? ''}`)

  // ④ 产物改动（守卫态二之二）：记录时那一版被改掉 ⇒ 判红，且**点名产物路径与两侧哈希**
  const recordedWrite = writeGate(store, regressionSourceOf([regressionCaseOf('TC-046'), regressionCaseOf('TC-047')]))
  assert.equal(recordedWrite.ok, true, shapeIssueText(recordedWrite.report))
  const recorded = `sha256:${artifactHash()}`
  writeArtifact('regression artifact v2\n') // 产物改动（改一个字节也算改动）
  const actual = artifactHash()
  assert.notEqual(recorded, actual, '夹具前提：两版产物的哈希必须不同（否则下面的"两侧哈希"是恒真断言）')
  const stale = checker(ctx)
  assert.equal(stale.ok, false, `产物改动 ⇒ 旧结果过期，判据必须红：${stale.detail}`)
  assert.match(stale.detail, /artifacts\/unit\.txt/u, `AC-208：必须点名**产物路径**：${stale.detail}`)
  assert.ok(
    stale.detail.includes(shortenHash(recorded)) && stale.detail.includes(shortenHash(actual)),
    `回执里要印出"记录时 vs 现在"两侧哈希：${stale.detail}`,
  )
  assert.notEqual(shortenHash(recorded), shortenHash(actual), '两侧哈希必须真的不同（点名才有意义）')
  assert.equal(
    evaluateGate(waterfall, 'G6', ctx).criteria.find((item) => item.id === 'C-57')?.ok,
    false,
    '走门禁接线时同样要红（C-57 的结论来自判定层，不是独立的一套）',
  )

  // ⑤ "过期"有修复路径：重跑重记（把结果绑到**当前**这一版产物上）⇒ 判据转绿
  const healedWrite = writeGate(store, regressionSourceOf([regressionCaseOf('TC-046'), regressionCaseOf('TC-047')]))
  assert.equal(healedWrite.ok, true, shapeIssueText(healedWrite.report))
  assert.equal(checker(ctx).ok, true, '重跑重记后判据必须能恢复（否则 ④ 的红另有原因，结论不成立）')

  rmSync(REG_BASE, { recursive: true, force: true })
})

test('TASK-037 落点三：regression.yml 的落盘路径——形状合法才落盘，非法一律不落盘并点名字段', async () => {
  regClean()
  const store = new SdoStore(join(REG_BASE, '.sdo'))
  const writeGate = await regressionWriteGate()

  // ① 非法形状（`cases[0]` 缺 `artifact` 与 `artifactPath`）⇒ **一个字节都不写**
  const rejected = writeGate(store, regressionSourceOf([{ case: 'TC-046', result: 'pass' }]))
  assert.equal(rejected.ok, false, '非法形状必须被拒（fail-closed）')
  assert.equal(rejected.report.outcome, 'invalid', `拒收的理由要落在形状回执上：${shapeIssueText(rejected.report)}`)
  assert.equal(store.exists('testing', 'regression.yml'), false, '非法形状一律不落盘（不落半成品）')
  const fields = rejected.report.issues.map((issue) => issue.field)
  assert.ok(
    fields.includes('cases[0].artifact') && fields.includes('cases[0].artifactPath'),
    `回执要点名到**字段**（缺哪一位说哪一位）：${fields.join(' ')}`,
  )
  const receipt = describeShapeReport(rejected.report)
  assert.match(receipt, /cases\[0\]\.artifactPath/u, `人读回执同样要点名字段：${receipt}`)
  assert.match(receipt, /\.sdo\/testing\/regression\.yml/u, `人读回执要点名是哪个真源：${receipt}`)

  // ② 合法形状 ⇒ 落在 `.sdo/testing/regression.yml`（`root:` 单键包裹），往返不丢条目
  writeArtifact('regression artifact v1\n')
  const accepted = writeGate(store, regressionSourceOf([regressionCaseOf('TC-046')]))
  assert.equal(accepted.ok, true, `合法形状应当落盘：${shapeIssueText(accepted.report)}`)
  assert.equal(store.exists('testing', 'regression.yml'), true, '落点必须是 .sdo/testing/regression.yml')
  assert.match(store.readText('testing', 'regression.yml') ?? '', /^regression:/mu, '落盘形态与其它真源一致（root: 单键包裹）')
  const regressionRef = TESTING_SOURCE_FILES.regression[0]
  assert.ok(regressionRef !== undefined, '回归真源的落点必须登记在 TESTING_SOURCE_FILES 里')
  const readBack = readTestingSource(store, regressionRef)
  assert.equal(readBack.present, true, '落盘之后按真源类读得回来')
  assert.equal(readBack.unreadable, false, '落盘的是可解析的真源')
  assert.equal((readBack.value['cases'] as unknown[]).length, 1, '往返不许丢条目（空集合不许算通过）')

  // ③ 盘上已有合法真源 + 再来一次非法写 ⇒ 那一份**逐字节不动**（拒收不许碰既有真源）
  const before = store.readText('testing', 'regression.yml')
  const again = writeGate(store, regressionSourceOf([{ case: 'TC-047', result: 'not-run' }]))
  assert.equal(again.ok, false, '结果只写 `not-run` 却缺产物哈希/路径 ⇒ 同样是非法形状')
  assert.equal(store.readText('testing', 'regression.yml'), before, '被拒的写不许碰盘上那份（逐字节不变）')

  rmSync(REG_BASE, { recursive: true, force: true })
})

// —————————————————————— TASK-055：有变更集却无回归真源 ⇒ 判红（补 N/A 收窄，REQ-052） ——————————————————————
//
// TASK-037 把 C-57 接进 G6 时**主动上报**过一处收窄：`regression.yml` 不在盘上 ⇒ 判 **N/A**。
// 于是「**有变更却完全没记回归**」这一档从门禁下面漏了过去 —— 而它正是 REQ-052 的核心纪律
// （回归集未跑即不得声称变更完成）。本节把这一档补成**判红**：变更集非空 ⇒ 真源缺失 / 为空 / 读不动
// 一律判红并点名；变更集为空 ⇒ 仍按 N/A（不误伤无变更的项目）。
//
// 五个守卫态（DoD 落点三）：
//   ① 有变更集 + 无真源 ⇒ 判红并点名「本次变更未记回归」；
//   ② 有变更集 + 真源齐备且哈希一致 ⇒ **不判红**（负向对照：判据不是"永远判红"）；
//   ③ 无变更集 + 无真源 ⇒ **N/A**（不误伤）；
//   ④ 真源**读不动** ⇒ 判红（不是 N/A），且判在真源那一档；
//   ⑤ 判红时回执给出**可执行**修法（补记真源 / 或显式声明无影响面并给理由）。

/**
 * 本节夹具：一个**干净**的沙箱（无 CR / 无缺陷 / 无工作区改动 ⇒ 变更集为空），
 * 落一份被测产物，并按 TASK-037 的接线建一张最小的图（种子 REQ-052 → TC-046）。
 *
 * 与 `regressionGateFixture` 的差别只在**变更集**：那一份先写 `CR-052`（变更集非空 ⇒ 判据必须逐条判），
 * 这一份留空，用来观察"没有变更就没有回归义务"那一侧。
 */
function failClosedFixture(): { ctx: GateContext; store: SdoStore } {
  regClean()
  writeArtifact('regression artifact v1\n')
  const store = new SdoStore(join(REG_BASE, '.sdo'))
  const journal = new Journal(store)
  link(store, journal, { from: 'REQ-052', to: 'TC-046', kind: 'req-tc' })
  link(store, journal, { from: 'REQ-052', to: 'TC-047', kind: 'req-tc' })
  const ctx = { workspace: REG_BASE, store, journal, requirements: [], waivedGates: [] } as unknown as GateContext
  return { ctx, store }
}

/**
 * 一份**已批准**的变更请求 —— 变更集非空的那一路来源（`changeSetFromLedger` 只认 `approved` 的 CR，
 * 被拒的 CR 不算变更：test/m38 上面那条用例已经钉过这条）。
 */
function writeApprovedChange(store: SdoStore, id: string, requirement: string): void {
  store.writeYaml(['changes', `${id}.yml`], {
    change: {
      id,
      requirement,
      reason: '本次施工期的一处口径变更',
      changes: ['改一处口径'],
      impact: { design: [], tasks: [], tests: [], note: '' },
      decision: 'approved',
      decidedBy: 'human',
      at: '2026-10-13T00:00:00.000Z',
    },
  })
}

test('TASK-055 守卫态①／③：无变更集 ⇒ N/A（不误伤）；有变更集而真源缺失 ⇒ **判红**并点名「本次变更未记回归」', () => {
  const { ctx, store } = failClosedFixture()
  const checker = CHECKERS['regression.discipline']
  assert.equal(typeof checker, 'function', 'regression.discipline 必须在 CHECKERS 里注册')
  if (checker === undefined) throw new Error('regression.discipline 未注册')

  // ③ **无变更集 + 无真源 ⇒ N/A**（不误伤）：没有变更就没有回归义务，这一步既不算过也不算不过
  const empty = changeSetFromLedger(store)
  assert.equal(empty.items.length, 0, `夹具前提：变更集为空（CR / 缺陷 / 工作区改动都没有）`)
  const withoutChange = checker(ctx)
  assert.equal(withoutChange.na, true, `没有变更 + 没记回归 ⇒ N/A：${withoutChange.detail}`)
  assert.match(withoutChange.detail, /regression\.yml 不在盘上/u, 'N/A 的理由要照旧说清是"没记回归"')

  // ① **同一份盘、只补一份变更（其他都不动）⇒ 判据必须从 N/A 翻成判红**
  //    （两态的差别**只来自变更集**：真源始终不在盘上）
  writeApprovedChange(store, 'CR-052', 'REQ-052')
  const withChange = checker(ctx)
  assert.equal(withChange.ok, false, `有变更却完全没记回归 ⇒ 必须判红：${withChange.detail}`)
  assert.equal(withChange.na, undefined, '这一档**不许**再降级成 N/A（TASK-037 上报的收窄就是这里）')
  assert.match(
    withChange.detail,
    /本次变更未记回归/u,
    `回执要点名"本次变更未记回归"（人看得懂缺的是哪一步）：${withChange.detail}`,
  )
  assert.match(withChange.detail, /regression\.yml 不在盘上/u, '仍要如实说清真源的状态（不在盘上）')
  // ⑤ 判红时必须给**可执行**修法：补记真源、或显式声明无影响面并给理由（两条路都要写出来）
  const remedy = withChange.remedy ?? ''
  assert.match(remedy, /sdo_test/u, `修法要点名补记回归真源的入口：${remedy}`)
  assert.match(remedy, /undecidable/u, `修法要给第二条路（显式声明无影响面并给理由）：${remedy}`)
  assert.match(remedy, /不许留空当作/u, `修法要说清"留空当作无影响"这件事本身不被接受：${remedy}`)

  // 两态对照：唯一变量是变更集（真源两态都不在盘上）
  assert.notEqual(
    `${withoutChange.na}`,
    `${withChange.na}`,
    '同一个沙箱里，N/A 与判红的差别必须只来自"有没有变更集"',
  )

  rmSync(REG_BASE, { recursive: true, force: true })
})

test('TASK-055 守卫态②：有变更集 + 真源齐备且哈希一致 ⇒ **不判红**（判据不是"永远判红"）', async () => {
  const { ctx, store } = failClosedFixture()
  const checker = CHECKERS['regression.discipline']
  if (checker === undefined) throw new Error('regression.discipline 未注册')
  const writeGate = await regressionWriteGate()

  writeApprovedChange(store, 'CR-052', 'REQ-052')
  const written = writeGate(store, regressionSourceOf([regressionCaseOf('TC-046'), regressionCaseOf('TC-047')]))
  assert.equal(written.ok, true, `形状合法的真源应当能落盘：${shapeIssueText(written.report)}`)

  const green = checker(ctx)
  assert.equal(green.ok, true, `变更集非空 + 真源齐备 + 哈希一致 ⇒ 必须绿：${green.detail}`)
  assert.equal(green.na, undefined, '许绿的那一档不许挂 N/A')
  // 判红的解除条件只有一个：真源**齐备**（不是"随便落一份文件"）—— 空真源仍是判红（守卫态⑤）
  rmSync(join(REG_BASE, '.sdo', 'testing', 'regression.yml'), { force: true })
  assert.equal(checker(ctx).ok, false, '把真源删掉 ⇒ 立刻判红（绿态不是"落在盘上过"的缓存）')

  rmSync(REG_BASE, { recursive: true, force: true })
})

test('TASK-055 守卫态④：真源**读不动** ⇒ 判红并点名原因（不许降级成 N/A）', () => {
  const { ctx, store } = failClosedFixture()
  const checker = CHECKERS['regression.discipline']
  if (checker === undefined) throw new Error('regression.discipline 未注册')
  writeApprovedChange(store, 'CR-052', 'REQ-052')

  // 文件**在盘上**但解析不出对象（形状非法 / 文件损坏）
  mkdirSync(join(REG_BASE, '.sdo', 'testing'), { recursive: true })
  writeFileSync(join(REG_BASE, '.sdo', 'testing', 'regression.yml'), 'regression: {\n')
  const unreadable = checker(ctx)
  assert.equal(unreadable.ok, false, `真源读不动 ⇒ 判红（与既有 fail-closed 口径一致）：${unreadable.detail}`)
  assert.equal(unreadable.na, undefined, '**不许**降级成 N/A："查不动"比"没记"更严重')
  assert.match(unreadable.detail, /读不出对象/u, `要点名原因（读不出对象）：${unreadable.detail}`)
  assert.match(unreadable.detail, /regression\.yml/u, '要点名是哪个真源读不动')
  assert.ok((unreadable.remedy ?? '').length > 0, '判红就要给修法（先修 YAML 再判回归）')

  // 反向对照：把文件换成**能解析**的一份 ⇒ 同一条"读不动"判红必须消失
  // （否则上面那条断言在"见文件就判红"的实现上也成立，等于空转）
  store.writeYaml(['testing', 'regression.yml'], {
    regression: { impact: ['REQ-052', 'TC-046'], cases: [] },
  })
  const readable = checker(ctx)
  assert.notEqual(readable.detail.includes('读不出对象'), true, `能解析之后不许再报"读不出对象"：${readable.detail}`)

  rmSync(REG_BASE, { recursive: true, force: true })
})

test('TASK-055 守卫态⑤：真源在盘上但**是空真源**（既无影响面也无不可推导声明）⇒ 判红并点名，且点的是真源不是本卡', async () => {
  const { ctx, store } = failClosedFixture()
  const checker = CHECKERS['regression.discipline']
  if (checker === undefined) throw new Error('regression.discipline 未注册')
  writeApprovedChange(store, 'CR-052', 'REQ-052')

  // "空"的一种真实形态（形状层能落盘的那一种）：根键在、正文也是个映射，但**没有 cases**
  store.writeYaml(['testing', 'regression.yml'], { regression: { impact: [] } })
  const blank = checker(ctx)
  assert.equal(blank.ok, false, `有变更 + 空真源 ⇒ 判红：${blank.detail}`)
  assert.equal(blank.na, undefined, '空真源不许降级成 N/A')
  assert.match(blank.detail, /regression\.yml/u, '点名的对象是那份真源（不是别的卡）')
  assert.match(blank.detail, /本次变更未记回归/u, '点名的是**变更未记回归**这件事')
  assert.match(blank.detail, /四位全空/u, '要说清"空"到什么程度（这才判得动怎么补）')
  assert.match(blank.remedy ?? '', /sdo_test/u, '修法可执行（补记回归真源）')

  rmSync(REG_BASE, { recursive: true, force: true })
})

/**
 * TASK-055 的**两态探针**（变异自证的观察面）。
 *
 * 观察的是**判据本体**（`CHECKERS['regression.discipline']` 的 G6 接线结论），不是判定层的纯函数：
 * 落点一那一档就写在接线里（`assessRegressionCriterion`），所以探针必须走接线才看得见。
 *
 * 三个观察位：
 *   · `naWithoutChange` —— 无变更集 + 无真源 ⇒ N/A（这一档两态都必须是 true：变异不许误伤它）；
 *   · `naWithChange`    —— 有变更集 + 无真源 ⇒ **当前实现必须是 false**（判红），变异体是 true（= 旧行为）；
 *   · `namesMiss`       —— 判红时点名「本次变更未记回归」（当前实现 true）。
 */
const T055_MUTANT_PROBE = `import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SdoStore } from '__STORE__'
import { Journal } from '__JOURNAL__'
import { link } from '__TRACE__'
import { CHECKERS } from '__GATES__'
const BASE = process.env.T055_BASE
rmSync(BASE, { recursive: true, force: true })
mkdirSync(join(BASE, '.sdo'), { recursive: true })
const store = new SdoStore(join(BASE, '.sdo'))
const journal = new Journal(store)
link(store, journal, { from: 'REQ-052', to: 'TC-046', kind: 'req-tc' })
const ctx = { workspace: BASE, store, journal, requirements: [], waivedGates: [] }
const checker = CHECKERS['regression.discipline']
const before = checker(ctx)
store.writeYaml(['changes', 'CR-052.yml'], {
  change: { id: 'CR-052', requirement: 'REQ-052', reason: 'x', changes: ['x'], impact: { design: [], tasks: [], tests: [], note: '' }, decision: 'approved', decidedBy: 'human', at: '2026-10-13T00:00:00.000Z' },
})
const after = checker(ctx)
console.log('GUARD=' + JSON.stringify({
  naWithoutChange: before.na === true,
  naWithChange: after.na === true,
  redWithChange: after.ok === false && after.na !== true,
  namesMiss: String(after.detail).includes('本次变更未记回归'),
}))
`

/** 编译产物里那一档的判定点（变异自证要能**逐字**找到它，找不到就报错而不是静默放过）。 */
const T055_NEEDLE = 'if (!assessment.present && changeSet.items.length === 0)'
/** 变回去 = TASK-037 的旧行为：`present:false` 一律 N/A（于是"有变更却无真源"漏过门禁）。 */
const T055_MUTATION = 'if (!assessment.present)'

test('TASK-055 DoD（变异自证）：把"有变更却无真源 ⇒ 判红"回滚成 N/A ⇒ 探针必须变红（killed）；当前实现 ⇒ 绿', () => {
  const guard = join(ROOT, 'node_modules', '.sdo-test', 'm38-t055-guard')
  rmSync(guard, { recursive: true, force: true })
  mkdirSync(guard, { recursive: true })
  const base = join(guard, 'workspace')
  const compiled = join(ROOT, 'lib', 'src', 'domain', 'gates.js')
  assert.ok(existsSync(compiled), `变异自证要先有编译产物（npm run build）：${compiled}`)

  const writeProbe = (gatesModule: string): void => {
    const source = T055_MUTANT_PROBE.replace('__GATES__', pathToFileURL(gatesModule).href)
      .replace('__STORE__', pathToFileURL(join(ROOT, 'lib', 'src', 'infra', 'store.js')).href)
      .replace('__JOURNAL__', pathToFileURL(join(ROOT, 'lib', 'src', 'infra', 'journal.js')).href)
      .replace('__TRACE__', pathToFileURL(join(ROOT, 'lib', 'src', 'domain', 'trace.js')).href)
    writeFileSync(join(guard, 'probe.mjs'), source, 'utf8')
  }

  const runProbe = (gatesModule: string): { code: number; out: string; seen: Record<string, unknown> } => {
    writeProbe(gatesModule)
    const script = `import ${JSON.stringify(pathToFileURL(join(guard, 'probe.mjs')).href)}\n`
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: guard,
      encoding: 'utf8',
      env: { ...process.env, T055_BASE: base },
    })
    const out = `${run.stdout}${run.stderr}`
    const matched = /GUARD=(\{.*\})/u.exec(out)
    return { code: run.status ?? -1, out, seen: matched === null ? {} : (JSON.parse(matched[1] as string) as Record<string, unknown>) }
  }

  // —— 红态：把落点一那一档**回滚**（等价于 TASK-037 那版的 `present:false` ⇒ 一律 N/A）——
  const original = readFileSync(compiled, 'utf8')
  assert.ok(
    original.includes(T055_NEEDLE),
    `变异点必须还在（没找到它说明实现变了，这条守卫要跟着改，不许静默失效）：${T055_NEEDLE}`,
  )
  const mutant = join(guard, 'gates.mutant.mjs')
  // 变异体放进临时目录后，**相对 import 要按编译产物所在目录改写**（否则它连加载都失败，
  // 红灯就退化成"路径错误"而不是"这一档被回滚了"）
  const rewritten = original.replace(/from '(\.[^']*)'/gu, (_all, spec: string) => `from '${pathToFileURL(join(ROOT, 'lib', 'src', 'domain', spec)).href}'`)
  writeFileSync(mutant, rewritten.replace(T055_NEEDLE, T055_MUTATION), 'utf8')
  assert.notEqual(readFileSync(mutant, 'utf8'), original, '变异体必须与当前实现**实质不同**（否则红态是假的）')

  const red = runProbe(mutant)
  assert.equal(red.code, 0, `变异体必须能跑起来（否则红灯是假的）：${red.out.slice(-400)}`)
  assert.equal(red.seen['naWithoutChange'], true, `前提：变异体也没误伤"无变更 ⇒ N/A"那一档：${red.out.slice(-400)}`)
  assert.equal(red.seen['naWithChange'], true, '**killed**：回滚之后"有变更却无真源"又变回 N/A（这正是本卡要补的漏档）')
  assert.equal(red.seen['redWithChange'], false, '回滚之后它不再判红')
  assert.equal(red.seen['namesMiss'], false, '回滚之后也不会点名"本次变更未记回归"')

  // —— 绿态：当前实现（同一份探针、同一份盘）——
  const green = runProbe(compiled)
  assert.equal(green.code, 0, `当前实现必须能跑起来：${green.out.slice(-400)}`)
  assert.equal(green.seen['naWithoutChange'], true, '当前实现：无变更 + 无真源 ⇒ 仍按 N/A（不误伤）')
  assert.equal(green.seen['naWithChange'], false, '当前实现：有变更 + 无真源 ⇒ **不许** N/A')
  assert.equal(green.seen['redWithChange'], true, '当前实现：这一档判红')
  assert.equal(green.seen['namesMiss'], true, '当前实现：点名「本次变更未记回归」')
  // 两态必须是**同一份盘**上的不同结论（差别只来自被测实现）
  assert.notEqual(red.seen['naWithChange'], green.seen['naWithChange'])

  rmSync(guard, { recursive: true, force: true })
})

