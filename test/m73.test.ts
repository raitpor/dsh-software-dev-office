/**
 * **增量 73：`sdo-test-new`（2026-10-08 全量测试）报告的缺陷回归。**
 *
 * 每一条都对应报告里**已被我独立复现**的发现（读码 + 复跑证据，见该工作区
 * `docs/evidence/R2/R3/R4/R5/`）：
 *
 *   D-14（blocker）派发子代理拿到 **0 个工具**：探针按**全局层**查注册表 ⇒ 15 个名字全判未知 ⇒
 *         `toolFilter.allow=[]` 原样下发；回执把"角色意图"当"已下发"说；观测静默丢失。
 *   D-15（major）  显式 `backend=…` 被"同迭代二选一锁"静默覆盖，降级原因只进台账不进回执。
 *   D-7 （major）  复合 JSON 参数写坏 ⇒ 回执是一条**不相干的预算回执**（键用错，错误正文丢掉）。
 *   D-8 （major）  `sdo_adr action=record` 静默忽略传入的 `id`（传 ADR-999 落 ADR-006）。
 *   D-1 （major）  `pickedOption` 只拼进 `answer` 正文 ⇒ 事后无法复原用户到底选了什么。
 *   D-2 （major）  提问目标与需求内容无关（问了"多少毫秒"却没有时延关注点）。
 *   D-3 （major）  模型通道的质询结构上没有选项，`answer` 又拒绝对它用 `pickedOption`（死胡同）。
 *   D-5 （major）  议题文件 `status: open` 与门禁 C8 的现算闭环相反；`disposeIssue` 不可达。
 *   D-6 （minor）  `baseline` 重放阶段转移（journal 出现两对 exited/entered）。
 *   D-9 （minor）  对象数组里的**字符串列表**被读成空 + 误报"是 string 类型"（数据被静默丢弃）。
 *   D-10（minor）  映射形状下条数算出 **NaN**（回执「（NaN 条）」、journal `entries: null`）。
 *   D-11（minor）  形状会让内容丢失时**照样写盘**（而 C-29 读那份形状判红）。
 *   D-12（major）  `decompose` 不建 `req-task` 边 ⇒ G5 的 C-41 覆盖要人工补。
 *
 * 纪律与其它 m* 用例一致：只读**真源**（`.sdo/` 下的 yml / journal / 门禁判据），不采信自述；
 * 每条都**双向**（该堵的必须红，正常路径必须绿）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { isAdrId } from '../src/domain/adr.js'
import { answerQuestion, sanitizeOptions, selectQuestions, writeProposedQuestions } from '../src/domain/grill.js'
import { openIssue } from '../src/domain/issues.js'
import { artifactEntryCount, methodArtifactShapeProblems, readMethodArtifactChecked } from '../src/domain/method.js'
import { decompose } from '../src/domain/plan.js'
import { filterKnownTools } from '../src/domain/roles.js'
import { loadScoring } from '../src/domain/scoring.js'
import { readLinks } from '../src/domain/trace.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { writeMethodArtifactReceipt } from '../src/interface/designReceipt.js'
import { describeDispatchStarted } from '../src/interface/describe.js'
import { pickBackend } from '../src/integration/orchestrator.js'
import type { DispatchRequest } from '../src/integration/orchestrator.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { GrillQuestion, Requirement, TaskCard } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm73')
const ALL2 = { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }
const call = (): { sessionId: string } => ({ sessionId: 's1' })

// ————————————————————————————— 纯函数层 —————————————————————————————

function dispatchRequest(): DispatchRequest {
  const task = {
    id: 'TASK-050', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/x/'], role: 'developer', size: 'small', revision: 1, status: 'ready',
    requirements: [], evidence: [], createdAt: '', updatedAt: '',
  } as unknown as TaskCard
  return {
    task, backend: 'subagent', owner: 'subagent:developer:1', persona: 'sdo-developer',
    toolDeny: ['sdo_review', 'sdo_gate'], sdoAllow: ['sdo_task', 'sdo_test'], prompt: 'P', expectedRevision: 1, writeScopes: ['src/x/'],
  }
}

test('M73-01 D-14：探针"整份名单全未知"= 探针不可用 ⇒ 原样下发（绝不静默清空白名单）', () => {
  const never = (): boolean => false
  const blind = filterKnownTools(['read', 'grep', 'sdo_task'], never)
  assert.equal(blind.blind, true, '全未知必须被认成"探针盲"')
  assert.deepEqual(blind.dropped, ['read', 'grep', 'sdo_task'], '探针原样结果照实留（那是探针的说法，不是事实）')
  assert.deepEqual(
    blind.applied,
    ['read', 'grep', 'sdo_task'],
    '盲态下**实际下发**的是原名单 —— 旧实现下发空集，那正是子代理零工具的根因',
  )

  // 正常路径：只剔掉真正不认识的名字（`pdf` 真机回归），盲态判定不得误伤
  const partial = filterKnownTools(['read', 'pdf', 'sdo_task'], (name) => name !== 'pdf')
  assert.equal(partial.blind, false)
  assert.deepEqual(partial.applied, ['read', 'sdo_task'])
  assert.deepEqual(partial.dropped, ['pdf'])

  // 空名单不是盲态（没有"整份都不认识"这回事）
  const empty = filterKnownTools([], never)
  assert.equal(empty.blind, false)
  assert.deepEqual(empty.applied, [])
})

test('M73-02 D-14/口径纠正：回执分开说「SDO 流程面白名单」与「通用面 deny 面」', () => {
  // 实际下发的是 **deny 面**；回执必须同时交代"SDO 面允许了什么"与"通用面挡了什么"，
  // 因为真机缺陷正是**通用面被静默清空**（子代理报「无法使用 technique_apply」）
  const actual = describeDispatchStarted(dispatchRequest(), 'spawn', 'child-1', ['sdo_review', 'sdo_gate'], true)
  assert.match(actual, /SDO 流程面/u, `要交代 SDO 流程面：${actual.slice(0, 200)}`)
  assert.match(actual, /sdo_task/u, 'SDO 白名单要看得见')
  assert.match(actual, /继承宿主默认/u, '通用面是黑名单语义 ⇒ 必须说明它继承宿主默认（不是被清空）')
  assert.match(actual, /sdo_review sdo_gate/u, '实际下发的 deny 名单要看得见')
  assert.doesNotMatch(actual, /deny 面是空集/u, '非空不得告警')

  const empty = describeDispatchStarted(dispatchRequest(), 'spawn', 'child-1', [], true)
  assert.match(empty, /deny 面是空集/u, 'deny 面为空 = 掩码没生效 ⇒ 必须显式告警')
})

test('M73-03 D-14 连带①：子会话工具面为空必须留痕（观测失败不再静默）', () => {
  const index = readFileSync(join(fileURLToPath(new URL('../../', import.meta.url)), 'src', 'index.ts'), 'utf8')
  const branch = index.slice(index.indexOf("if (eventType === 'request/header')"))
  const body = branch.slice(0, branch.indexOf("if (eventType === 'assistant/message'"))
  assert.match(body, /noteObserveFailure/u, '工具面为空的子会话必须记观测失败（旧实现直接 return）')
  assert.match(body, /kObserveEmptyToolFace/u, '留痕要说明这是"零工具派发"的直接症状')
})

test('M73-04 D-15：显式点名覆盖迭代锁（并留痕）；auto 仍守锁；成功回执带降级/覆盖原因', () => {
  const probe = { subagent: true, nativeTeam: true, inline: true as const }
  // 显式点名 ⇒ 生效，且**不是**降级（结果等于请求），另有 overrideNote
  const override = pickBackend('inline', probe, { backend: 'subagent', iteration: 3 }, 3)
  assert.equal(override.backend, 'inline', '使用者明确要的后端必须生效')
  assert.equal(override.degradedReason, undefined, '结果等于请求 ⇒ 不是降级')
  assert.match(override.overrideNote ?? '', /显式指定/u, '覆盖要留痕')
  assert.equal(override.switched, true)

  // auto（没点名）仍守二选一锁，并说明原因
  const locked = pickBackend('auto', { subagent: false, nativeTeam: true, inline: true }, { backend: 'subagent', iteration: 3 }, 3)
  assert.equal(locked.backend, 'subagent', '自动选择不得在同一迭代里半路换后端')
  assert.match(locked.degradedReason ?? '', /二选一/u)

  // 成功路径（describeDispatchStarted）也必须回显降级与覆盖
  const text = describeDispatchStarted(
    dispatchRequest(), 'spawn', 'child-1', ['bash'], true, false, [],
    { reused: false, mode: 'one-shot' },
    'subagent 后端不可用，降级为就地执行',
    '显式指定了 inline，已覆盖本迭代的二选一锁（留痕）',
  )
  assert.match(text, /降级为就地执行/u, '成功路径也要说清降级原因（旧实现只有失败路径才渲染）')
  assert.match(text, /显式指定了 inline/u, '覆盖原因同样要看得见')
})

test('M73-05 D-2：与需求内容无关的关注点不再被问（interface/constraint 设闸）', () => {
  const model = loadScoring()
  const mk = (id: string, statement: string): Requirement => ({
    id, title: id, statement, rationale: '', kind: 'functional', priority: 'must', status: 'draft',
    sourceStakeholder: '', acceptance: [], version: 0.1, revision: 1, ambiguity: { score: 0, dimensions: {} },
    openQuestions: [], createdAt: '', updatedAt: '',
  } as unknown as Requirement)

  // REQ-001 是报告里的真机形态：既无时延也无上游
  const unrelated = mk('REQ-001', '系统须在 CLI 侧对同一输入文件产出与 legacy 脚本逐字节一致的报告输出')
  // 反向：真的有时延/上游关注点的需求，必须照旧被问到
  const related = mk('REQ-002', '系统须调用上游接口；上游超时必须在 500 毫秒内重试并返回脏数据提示')

  const picked = selectQuestions({ requirements: [unrelated, related], existing: [], model, limit: 12 })
  const gated = new Set(['interface', 'constraint'])
  for (const item of picked.filter((entry) => entry.target === 'REQ-001')) {
    assert.ok(!gated.has(item.template.dimension), `REQ-001 不该被问 ${item.template.dimension}：${item.template.id}`)
  }
  const relatedDims = new Set(picked.filter((entry) => entry.target === 'REQ-002').map((entry) => entry.template.dimension))
  assert.ok(
    relatedDims.has('constraint') || relatedDims.has('interface'),
    `有该关注点的需求必须照旧被问：${[...relatedDims].join(',')}`,
  )
  // 不设闸的维度仍然照常问（不把闸门泛化成"正文没写就不许问"）
  assert.equal(picked.some((entry) => !gated.has(entry.template.dimension)), true, '其余维度必须照旧')
})

// ————————————————————————————— 域层 —————————————————————————————

let workspace: string
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M73-06 D-1/D-3：选项与推荐项结构化落账；无选项的题给出"用自由文本"的出路', () => {
  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)

  // D-3：模型通道现在可以带选项（以前硬编码 `options: []`）
  const created = writeProposedQuestions(store, journal, 'REQ-001', [{
    text: '上游返回脏数据时应当怎么办？',
    options: [{ label: '整体阻断', cost: '可用性下降' }, { label: '失败重试', cost: '实现更复杂' }],
    recommendation: '整体阻断',
  }])
  assert.equal(created.length, 1)
  const question = created[0] as GrillQuestion
  assert.equal(question.options.length, 2, '带上去的选项要真的落盘')
  assert.equal(question.defaultRecommendation, '整体阻断', '推荐项必须与某个选项一致才落')

  // 选项形状不合法 ⇒ 当没有选项（不猜）
  assert.deepEqual(sanitizeOptions([{ cost: '没有 label' }, 'string', null]), [])
  assert.deepEqual(sanitizeOptions([{ label: 'A' }]), [{ label: 'A', cost: '' }])

  // D-1：回答时下标与标签**各记一份**（不再只有拼进正文的那句话）
  const target: GrillQuestion = { ...question, targets: [] }
  store.writeYaml(['questions', `${question.id}.yml`], { question: target })
  const answered = answerQuestion(store, journal, undefined, { id: question.id, answer: '用户原话：整体阻断', pickedOption: 1 })
  assert.ok(answered !== undefined)
  assert.equal(answered.question.pickedOption, 1)
  assert.equal(answered.question.pickedLabel, '失败重试', '标签按插件自己的选项表解析（可复算的那一份）')
  assert.match(answered.question.answer ?? '', /用户原话/u, '用户原话仍然保留')
  const event = journal.read().events.filter((item) => item.type === 'question/answered').at(-1)
  assert.equal(event?.data.pickedLabel, '失败重试', 'journal（唯一不可篡改的真源）里也要有结构化选择')
  assert.equal(event?.data.pickedOption, 1)

  // 0 选项的题：拒绝下标，但给出**可用的出路**（旧回执是一句"该题只有 0 个选项"的死胡同）
  const noOptions = writeProposedQuestions(store, journal, 'REQ-001', [{ text: '这条没有任何选项的质询怎么办？' }])[0] as GrillQuestion
  assert.equal(noOptions.options.length, 0)
  assert.throws(
    () => answerQuestion(store, journal, undefined, { id: noOptions.id, answer: 'x', pickedOption: 0 }),
    /没有选项|自由文本/u,
    '0 选项必须给出"改用自由文本"的出路',
  )
})

test('M73-07 D-6：baseline 不重放阶段转移（先 advance 再 baseline 只得一对）', () => {
  office.init(call(), { name: 'M73', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), {
    scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['m'], glossary: { 词: '释义' },
  })
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['探针'] })
  office.logRisk(call(), { title: 'r', level: 'low', probability: 'low', impact: '小', mitigation: 'm', owner: '业务方' })
  const captured = office.capture(call(), {
    title: '差异检测', statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    kind: 'functional', priority: 'must', sourceStakeholder: 'STK-01',
  })
  office.update(call(), {
    id: captured.requirement.id,
    addAcceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
    modelDimensions: ALL2,
  })
  office.askDesignQuestions(call(), { recommendation: { method: '结构化', rationale: '稳定' } })
  office.redTeamAttack(call(), [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const pending = office.questions(call()).filter(
      (question) => question.status === 'open' && !question.targets.includes('design:method'),
    )
    if (pending.length === 0) break
    office.answer(call(), { id: pending[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  prepareG2(office, call())

  const first = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(first.ok, true, `夹具必须真的能基线：${JSON.stringify(first.dor.failed)}`)
  assert.equal(office.status(call()).project?.phase, 'architecture')

  const journal = office.journalFor(workspace)
  const entered = (): number => journal.read().events.filter((event) => event.type === 'phase/entered').length
  const before = entered()

  // 再 baseline 一次：无论成败，都**不得**再写阶段转移（旧实现会再写一对 exited/entered）
  office.baseline(call(), { approvedBy: '张三' })
  assert.equal(entered(), before, '第二次 baseline 不得重放阶段转移')
  const architectureEntries = journal.read().events.filter(
    (event) => event.type === 'phase/entered' && event.data.phase === 'architecture',
  )
  assert.equal(architectureEntries.length, 1, 'architecture 只许进入一次')
  // 如实写"退出的到底是哪个阶段"：本夹具没有逐步 advance 门禁，当前阶段就是 intake，
  // 所以旧实现那句写死的 `exited requirements` 是**假事件**（D-6 的第二半）
  const exited = journal.read().events.filter((event) => event.type === 'phase/exited')
  assert.equal(exited.length, 1)
  assert.equal(exited[0]?.data.phase, 'intake', '必须写真实退出的阶段，不许硬编码 requirements')
})

test('M73-08 D-9/D-10：字符串形式的流名不得被读空；条数不得出现 NaN', () => {
  const store = new SdoStore(join(BASE, '.sdo-dfd'))
  store.writeYaml(['design', 'method-dfd.yml'], {
    artifact: {
      id: 'MA-001', kind: 'dfd', summary: '', updatedAt: '',
      levels: [{ level: 0, name: 'L0', flows: ['fixtureName', 'Report', 'errorText'] }],
    },
  })
  const { artifact, notes } = readMethodArtifactChecked(store, 'dfd')
  assert.deepEqual(
    artifact?.levels?.[0]?.flows.map((flow) => flow.name),
    ['fixtureName', 'Report', 'errorText'],
    '真机形态：`levels[].flows` 在盘上是**正确的字符串列表**，必须原样读回（旧实现读成空列表）',
  )
  assert.equal(notes.length, 0, `字符串列表是合法写法，不得产生形状提示：${JSON.stringify(notes)}`)

  // D-10：映射形状取 `.length` 以前得到 NaN（回执「（NaN 条）」、journal `entries: null`）
  const mapShaped = {
    id: 'MA-003', kind: 'layers', summary: '', updatedAt: '',
    rules: { layers: [], assignments: {}, allowed: { core: [] } },
  } as never
  assert.equal(Number.isNaN(artifactEntryCount(mapShaped)), false, '条数不许是 NaN')
  assert.equal(artifactEntryCount(mapShaped), 0)
  const arrayShaped = {
    id: 'MA-004', kind: 'layers', summary: '', updatedAt: '',
    rules: { layers: [], assignments: {}, allowed: [{ from: 'a', to: 'b' }] },
  } as never
  assert.equal(artifactEntryCount(arrayShaped), 1)
})

test('M73-09 D-11：形状会让内容丢失 ⇒ 写入边界直接拒（与 C-29 读的那份形状同源）', () => {
  // 报告的真机形态：`rules.allowed` 写成映射 ⇒ 读回来是空 ⇒ C-29（allowed 为空即失败）判红
  const lost = methodArtifactShapeProblems('layers', { rules: { allowed: { core: [], shell: ['core'] } } })
  assert.ok(lost.length > 0, '会丢内容的形状必须被识别出来')
  assert.equal(lost[0]?.field, 'rules.allowed')
  // 正常形状不得误报
  assert.deepEqual(methodArtifactShapeProblems('layers', { rules: { allowed: [{ from: 'a', to: 'b' }] } }), [])

  // 工具层：走真实回执函数 ⇒ 拒写、盘上不得出现该产物、回执点名字段
  const h = harness()
  const receipt = writeMethodArtifactReceipt(h.office, { cwd: BASE }, {
    action: 'artifact', artifactKind: 'layers',
    artifactData: JSON.stringify({ rules: { allowed: { core: [], shell: ['core'] } } }),
  } as never)
  assert.match(receipt, /未写入/u, `必须拒写：${receipt}`)
  assert.match(receipt, /rules\.allowed/u, '要点名是哪个字段')
  assert.equal(existsSync(join(BASE, '.sdo', 'design', 'method-layers.yml')), false, '被拒的提交不得写盘')
})

test('M73-10 D-12：decompose 建卡时就建立 req-task 追溯边（G5 的 C-41 不再靠人工补）', () => {
  const store = new SdoStore(join(BASE, '.sdo-plan'))
  const journal = new Journal(store)
  const requirement = {
    id: 'REQ-001', title: 'r', statement: 's', rationale: '', kind: 'functional', priority: 'must',
    status: 'baselined', sourceStakeholder: '', acceptance: [], version: 0.2, revision: 1,
    ambiguity: { score: 16, dimensions: {} }, openQuestions: [], createdAt: '', updatedAt: '',
  } as unknown as Requirement
  const result = decompose(store, journal, [requirement], {
    suggestions: [{
      title: '实现差异检测', role: 'developer', dod: ['d'], evidenceRequired: ['command'],
      writeScopes: ['src/diff/'], size: 'small', requirements: ['REQ-001'],
    }],
  })
  assert.equal(result.tasks.filter((task) => task.status !== 'dropped').length, 1)
  const links = readLinks(store)
  assert.ok(
    links.some((item) => item.kind === 'req-task' && item.from === 'REQ-001' && item.to === 'TASK-001'),
    `decompose 必须顺手建 req-task 边（旧实现只 createTask）：${JSON.stringify(links)}`,
  )
})

// ————————————————————————————— 工具层 —————————————————————————————

test('M73-11 D-7/D-8：JSON 解析失败回执说实话；ADR 显式 id 被尊重、重号/形状错一律拒', async () => {
  const h = harness()
  const good = '[{"option":"甲","pros":"省事","cons":"风险高"}]'

  // D-7：坏 JSON 必须报**真正的解析错误**，且不能说出"预算"这种与事实无关的话
  const bad = await h.callTool('sdo_adr', {
    action: 'record', title: 'T', decision: 'D', alternatives: good, consequences: '[「全角引号不是 JSON」]',
  }, 'cockpit', 0)
  assert.match(bad, /不是合法 JSON/u, `要报解析失败：${bad}`)
  assert.doesNotMatch(bad, /预算/u, '不得再出现与事实无关的预算回执（D-7 的真机症状）')
  assert.equal(h.journal.read().events.filter((event) => event.type === 'adr/recorded').length, 0, '解析失败不得留下任何写入')

  // D-8：显式 id 被尊重
  const first = await h.callTool('sdo_adr', {
    action: 'record', id: 'ADR-999', title: 'T', decision: 'D', alternatives: good, consequences: '["后果一"]',
  }, 'cockpit', 0)
  assert.match(first, /ADR-999/u, `显式 id 必须生效（旧实现静默改成自动编号）：${first}`)
  assert.equal(existsSync(join(BASE, '.sdo', 'decisions', 'ADR-999.yml')), true)

  // 冲突 / 形状错：拒，且不写盘
  const dup = await h.callTool('sdo_adr', {
    action: 'record', id: 'ADR-999', title: 'T2', decision: 'D2', alternatives: good, consequences: '["后果二"]',
  }, 'cockpit', 0)
  assert.match(dup, /已被占用/u, `重号必须拒：${dup}`)
  const shape = await h.callTool('sdo_adr', {
    action: 'record', id: 'not-an-id', title: 'T3', decision: 'D3', alternatives: good, consequences: '["后果三"]',
  }, 'cockpit', 0)
  assert.match(shape, /形状不合法/u, `形状错必须拒：${shape}`)
  assert.equal(h.journal.read().events.filter((event) => event.type === 'adr/recorded').length, 1, '被拒的两次不许留事件')
  assert.equal(isAdrId('ADR-007'), true)
  assert.equal(isAdrId('ADR-7'), false)
})

test('M73-12 D-5：议题处置路径可达 —— 写 issue/closed 并把文件状态追平', async () => {
  const h = harness()
  // 造一个红队议题（与真机同形：disposition none、相关质询已回答 ⇒ 门禁现算已闭环而文件仍 open）
  const question: GrillQuestion = {
    id: 'Q-0001', text: '谁会被伤害？', targets: ['REQ-001'], dimension: 'user', severity: 'P0',
    why: '#redteam-stakeholder', consequenceIfUnasked: 'c',
    options: [{ label: 'A', cost: 'c' }], defaultRecommendation: 'A',
    answer: '已确认', status: 'answered', askedAt: null, answeredBy: 'human', origin: 'red-team',
  }
  h.store.writeYaml(['questions', 'Q-0001.yml'], { question })
  const issue = openIssue(h.store, h.journal, { target: 'REQ-001', angles: ['redteam-stakeholder'], questionIds: ['Q-0001'] })
  assert.equal(existsSync(join(BASE, '.sdo', 'issues', `${issue.id}.yml`)), true)
  assert.equal(h.store.readYaml<{ issue: { status: string } }>('issues', `${issue.id}.yml`)?.issue.status, 'open', '前置：文件里还是 open')

  const disposed = await h.callTool('sdo_redteam', {
    action: 'dispose', id: issue.id, disposition: 'requirement', note: '已回到需求：答完质询',
  }, 'cockpit', 0)
  assert.match(disposed, /已处置/u, `处置路径必须可达（旧实现没有任何 action 接到 disposeIssue）：${disposed}`)
  assert.match(disposed, /门禁/u, '回执要点明"门禁的现算结论"这层关系')
  assert.equal(h.journal.read().events.filter((event) => event.type === 'issue/closed').length, 1, 'issue/closed 必须落账')
  const after = h.store.readYaml<{ issue: { status: string; disposition: string } }>('issues', `${issue.id}.yml`)
  assert.equal(after?.issue.status, 'closed', '文件状态必须追平（否则与门禁的现算结论互相矛盾）')
  assert.equal(after?.issue.disposition, 'requirement')

  // 缺参 / 找不到：拒，且不写盘
  const noId = await h.callTool('sdo_redteam', { action: 'dispose', disposition: 'risk' }, 'cockpit', 0)
  assert.match(noId, /需要 `id`/u)
  const missing = await h.callTool('sdo_redteam', { action: 'dispose', id: 'REQ-ISSUE-099', disposition: 'risk' }, 'cockpit', 0)
  assert.match(missing, /找不到议题/u)
  assert.equal(h.journal.read().events.filter((event) => event.type === 'issue/closed').length, 1, '被拒的两次不许留事件')
})

test('M73-13 D-1（工具层）：answer 带 pickedOption ⇒ 结构化字段与正文同时落账', async () => {
  const h = harness()
  const question: GrillQuestion = {
    id: 'Q-0001', text: '选哪个？', targets: [], dimension: 'data', severity: 'P0',
    why: 'w', consequenceIfUnasked: 'c',
    options: [{ label: '甲', cost: '省事' }, { label: '乙', cost: '稳' }], defaultRecommendation: '甲',
    answer: null, status: 'open', askedAt: null, answeredBy: null, origin: 'bank',
  }
  h.store.writeYaml(['questions', 'Q-0001.yml'], { question })
  const receipt = await h.callTool('sdo_requirement', {
    action: 'answer', id: 'Q-0001', answer: '用户说选乙', pickedOption: 1,
  }, 'cockpit', 0)
  assert.match(receipt, /乙/u, `回执要照出选中的选项：${receipt}`)
  const stored = h.store.readYaml<{ question: { pickedOption?: number; pickedLabel?: string } }>('questions', 'Q-0001.yml')
  assert.equal(stored?.question.pickedOption, 1)
  assert.equal(stored?.question.pickedLabel, '乙', '台账里必须能复原"用户到底选了什么"')
})

// ————————————————————————————— 工具层夹具 —————————————————————————————

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}

/** 真实装配 + 真实工具（与 m68 同一夹具）。 */
function harness(): {
  callTool: (name: string, args: Record<string, unknown>, sessionId: string, depth?: number) => Promise<string>
  store: SdoStore
  journal: Journal
  office: SoftwareDevOffice
} {
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
  apply(makeCtx() as unknown as Context, Config({} as never))
  const store = new SdoStore(join(BASE, '.sdo'))
  const journal = new Journal(store)
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  return {
    store,
    journal,
    office,
    async callTool(name, args, sessionId, depth = 1) {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `工具面缺少 ${name}`)
      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
      const exec = {
        agent: {
          id: sessionId,
          session: { header: { id: sessionId, cwd: BASE, delegationDepth: depth, ...(depth === 0 ? {} : { parentSession: 'cockpit' }) } },
        },
      }
      return String(await tool.execute(filtered, exec))
    },
  }
}
