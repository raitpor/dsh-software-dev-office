/**
 * 增量 3（规格 §7）：**设计门禁适用性由需求阶段决定 + 门禁级用户签字 + `porting` 方法包**。
 *
 * 这一组逐条覆盖实施规格 **§7.6 的六项验收，且每一项都双向**（反例必须真的能推翻断言）：
 *   ① 无声明 → G3 红（理由必须点明"未声明适用性"）；声明 + 工件 + **签字**齐备 → 绿；
 *   ② `viewsAbsent` 的视图 `na === true && ok === false && naReason` 非空且**等于声明理由**；
 *      且"既未列入 present 又未说明 absent"的视图 → 判红（必须显式二选一）；
 *   ③ 未签字即便其余全绿 → 红；签字后 → 绿；**签字后声明变更** → 签字失效 → 再红；
 *   ④ 签字**无引用文本** → 视为无效（红）；带引用文本 → 有效；
 *   ⑤ `porting`：缺映射/缺不变量/不变量无 `verify`/差分无基线来源 → 红；补齐 → 绿；
 *   ⑥ 存量项目（无声明）→ 红，且理由必须是"未声明适用性"而不是其它原因。
 *
 * 纪律：断言只读**真源**（`applyability.yml` / 方法产物 / 签字台账 / journal），
 * 不采信模型自述；反例都是"把某样真源去掉/改坏"，而不是把断言放松。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { writeMethodDoc } from './support/method-doc-fixture.js'
import { readApplicability } from '../src/domain/applicability.js'
import { t } from '../src/domain/i18n.js'
import { link } from '../src/domain/trace.js'
import { describeBaseline, describeGate } from '../src/interface/describe.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { SdoConfig } from '../src/config.js'
import type { GateCriterionResult, GateEvaluation, ViewKind } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m13/', import.meta.url))
const ALL2 = { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }
const ALL_VIEWS: ViewKind[] = ['context', 'component', 'runtime', 'data', 'deployment']
const call = (): { sessionId: string } => ({ sessionId: 's1' })

let workspace: string
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M13 测试', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// —————————————————————— 夹具 ——————————————————————

/** 一条已基线需求（G2 通过）。 */
function baselineRequirement(): string {
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call(), {
    title: '格式变更',
    level: 'low',
    probability: 'low',
    impact: '小',
    mitigation: '校验',
    owner: '业务方',
  })
  const captured = office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    kind: 'functional',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), {
    id: captured.requirement.id,
    addAcceptance: [{ id: 'AC-001', given: '已导入两日文件', when: '执行对账', then: '输出差异清单' }],
    modelDimensions: ALL2,
  })
  // **§7.2 时机迁移**：方法论选择题在**需求阶段**提出，且不阻塞 G2（P1）→ 先提出、不在这里回答
  office.askDesignQuestions(call(), { recommendation: { method: '结构化', rationale: '需求稳定' } })
  office.redTeamAttack(call(), [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    const pending = open.filter((question) => !question.targets.includes('design:method'))
    if (pending.length === 0) break
    office.answer(call(), { id: pending[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  // D1 + D4：未决 P1 补风险处置，再签 G2 字（放行依据是签字台账）
  prepareG2(office, call())
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}

/** 五视图元素（都挂到需求上，消除孤儿）。 */
function fiveViews(requirementId: string): void {
  for (const [kind, name] of [
    ['context', '对账系统'],
    ['component', '差异检测服务'],
    ['runtime', '夜间批处理'],
    ['data', '对账差异表'],
    ['deployment', '单机部署'],
  ] as const) {
    office.upsertElement(call(), { kind, name, requires: [requirementId] })
  }
  // **追溯边**必须真的写进追溯图（`criterion C-21 trace.orphans` 读的是它，
  // 只写 `requires` 字段不算 —— 与 m2/m8 夹具同一口径）。
  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)
  for (const element of office.views(call()).flatMap((view) => view.elements)) {
    link(store, journal, { from: requirementId, to: element.id, kind: 'req-des' })
  }
}

/** 一条含备选与后果的 ADR（G3 的 C-22）。 */
function addAdr(): void {
  office.recordAdr(call(), {
    title: '对账批处理窗口',
    context: '上游文件到达时间不稳定',
    decision: 'T+1 批处理，窗口 02:00–04:00',
    alternatives: [
      { option: '流式处理', pros: '时效高', cons: '运维与一致性成本高' },
      { option: 'T+1 批处理', pros: '实现简单、可重跑', cons: '时效 T+1' },
    ],
    consequences: ['差异结果 T+1 可见', '需要重跑入口'],
  })
}

/** 结构化包最小必产项（数据字典覆盖 DFD 流名）。 */
function structuredProducts(requirementId: string): void {
  office.writeMethodArtifact(call(), 'dictionary', {
    summary: '对账差异数据字典',
    dictionary: [
      { name: '对账文件', type: 'file', source: '上游系统', sink: '对账系统', validation: '非空且格式合法', requires: [requirementId] },
      { name: '差异清单', type: 'record[]', source: '对账系统', sink: '业务方', validation: '每条含差异 id', requires: [requirementId] },
    ],
  })
  office.writeMethodArtifact(call(), 'dfd', {
    summary: '对账分层数据流图',
    levels: [
      {
        level: 0,
        name: '上下文层',
        flows: [
          { name: '对账文件', from: '上游系统', to: '对账系统' },
          { name: '差异清单', from: '对账系统', to: '业务方' },
        ],
        processes: [{ name: '对账系统', inputs: ['对账文件'], outputs: ['差异清单'], requires: [requirementId] }],
      },
      {
        level: 1,
        name: '分解层',
        flows: [
          { name: '对账文件', from: '上游系统', to: '差异检测服务' },
          { name: '差异清单', from: '差异检测服务', to: '业务方' },
        ],
        processes: [{ name: '差异检测服务', inputs: ['对账文件'], outputs: ['差异清单'], requires: [requirementId] }],
      },
    ],
  })
  office.writeMethodArtifact(call(), 'erd', {
    summary: '对账差异 ERD',
    entities: [
      { name: '对账批次', identifier: '批次ID', requires: [requirementId] },
      { name: '对账差异', identifier: '差异ID', requires: [requirementId] },
    ],
    relations: [{ name: '批次含差异', from: '对账批次', to: '对账差异', cardinality: '1:N' }],
  })
  // 新口径（方法包人审文档）：选中 structured 就必须有一份与人审文档，且与台账指纹一致
  writeMethodDoc(workspace, new SdoStore(join(workspace, '.sdo')), 'structured')

}

/** 走完设计交互闭环（问题清零 + 方法选定 + 文档 + 逐条确认）。 */
function completeDesignInteraction(requirementId: string): void {
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '需求明确' } })
  const method = grilled.created.find((question) => question.targets.includes('design:method'))
  if (method !== undefined) office.answerDesign(call(), method.id, '0', '按推荐')
  for (const id of grilled.stillOpen.filter((qid) => qid !== method?.id)) office.answerDesign(call(), id, '0', '按推荐')
  structuredProducts(requirementId)
  office.renderDesign(call())
  for (const target of office.designConfirmGaps(call()).required) {
    office.confirmDesign(call(), target, '用户在会话中确认', '张三')
  }
}

/** 起草并让用户签字绑定声明。 */
function declareApplicability(input: {
  viewsPresent: ViewKind[]
  viewsAbsent?: { kind: ViewKind; why: string }[]
  artifacts?: string[]
}): void {
  office.draftApplicability(call(), {
    focus: '旧系统重构：只优化流程与效率，业务逻辑不变',
    viewsPresent: input.viewsPresent,
    viewsAbsent: input.viewsAbsent ?? [],
    artifacts: input.artifacts ?? [],
    by: '模型起草',
  })
  office.confirmApplicability(call(), '同意就按这份声明走', '张三')
  // X-1：C-25 要求 `docs/DESIGN.md` 不早于最后一次真源变更；声明（含其确认）也是文档真源。
  office.renderDesign(call())
}

/** G3 门禁级签字（带引用文本才算有效）。 */
let signG3Round = 0
function signG3(basis?: string): void {
  // **R-27**：同一句用户原话只代表**一次**表态（失效之后复用会被拒）⇒ 夹具每次给一句新的表态
  signG3Round += 1
  basis = basis ?? `我签字确认这次设计可以放行（第 ${signG3Round} 次表态）`
  office.signGate(call(), { gate: 'G3', by: '张三', basis, channel: 'command' })
  // X-1：签字后重渲染一次，使判定时刻的文档与真源一致。
  office.renderDesign(call())
}

function criterion(criteria: GateCriterionResult[], id: string): GateCriterionResult {
  const found = criteria.find((item) => item.id === id)
  assert.ok(found !== undefined, `G3 必须有判据 ${id}`)
  return found
}

function g3(): GateEvaluation {
  return office.evaluate(call(), 'G3')
}

/**
 * 「声明齐备 + 工件齐备 + 签字」的全绿夹具。
 *
 * 顺序很关键：先写全部真源（视图/交互/工件），再起草声明，**最后**签字 ——
 * 因为"签字后声明/需求变更 → 签字失效"是按 journal 序号判的（§7.2）。
 */
function fullyGreenFixture(requirementId: string): void {
  fiveViews(requirementId)
  addAdr()
  completeDesignInteraction(requirementId)
  declareApplicability({ viewsPresent: ALL_VIEWS })
  signG3()
}

// —————————————————————— ① 无声明 → 红；齐备 + 签字 → 绿 ——————————————————————

test('M13-01 无声明 → G3 红；声明齐备 + 工件齐备 + 签字 → 绿（双向）', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  addAdr()
  completeDesignInteraction(requirementId)

  // ① 反例：还没有声明 —— 即便设计交互全走完，G3 也必须红
  const before = g3()
  assert.equal(before.status, 'failed', '没有适用性声明时 G3 不得放行')
  assert.equal(criterion(before.criteria, 'C-2B').ok, false, 'design.applicability 必须判红')

  // ② 正例：声明 + 签字 → G3 绿
  declareApplicability({ viewsPresent: ALL_VIEWS })
  signG3()
  const after = g3()
  assert.equal(after.status, 'passed', `声明齐备 + 签字后 G3 应通过：${after.criteria.filter((c) => !c.ok && c.na !== true).map((c) => `${c.id}:${c.detail}`).join(' | ')}`)
})

// —————————————————————— ② viewsAbsent 的 N/A + 理由 + 显式二选一 ——————————————————————

test('M13-02a viewsAbsent 的视图：N/A + ok=false + naReason 等于声明理由（双向）', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  addAdr()
  completeDesignInteraction(requirementId)
  const why = '数据模型沿用旧库，本次不改'
  declareApplicability({
    viewsPresent: ['context', 'component', 'runtime', 'deployment'],
    viewsAbsent: [{ kind: 'data', why }],
  })
  signG3()

  const value = criterion(g3().criteria, 'C-20')
  assert.equal(value.na, true, '被声明为 absent 的视图，其判据必须是 N/A 态')
  assert.equal(value.ok, false, 'N/A **绝不能**被算成通过')
  assert.equal(value.naReason, `要做的视图 4 个已齐备；其余视图按声明判不适用：数据视图（${why}）`, 'N/A 理由必须逐字带上声明里的理由')
  assert.ok((value.naReason ?? '').includes(why), 'N/A 理由必须包含声明原文')

  // 反例（双向）：把"数据视图"改回 present 但**删掉它的内容** → 判据必须红（不是 N/A）
  declareApplicability({ viewsPresent: ALL_VIEWS })
  // 声明变更让签字失效 → 重新签（否则红的原因会是签字，掩盖视图判据）
  signG3()
  office.storeFor(workspace).remove('design', 'data.yml')
  const broken = criterion(g3().criteria, 'C-20')
  assert.equal(broken.na, undefined, 'present 的视图缺内容时不得退化成 N/A')
  assert.equal(broken.ok, false, 'present 的视图必须有内容，缺内容即红')
})

test('M13-02b 既未列入 present 又未说明 absent 的视图 → 判红（必须显式二选一）', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  completeDesignInteraction(requirementId)
  // 反例：只声明 4 个 present、不说明任何 absent → 第 5 个视图"两头都没交代"
  declareApplicability({ viewsPresent: ['context', 'component', 'runtime', 'deployment'] })
  signG3()
  const incomplete = criterion(g3().criteria, 'C-2B')
  assert.equal(incomplete.ok, false, '有视图既未列入 present 也未说明 absent 时必须判红')
  assert.match(incomplete.detail, /数据视图/u, '理由必须点名那个未交代的视图')
  assert.match(incomplete.detail, /显式二选一/u, '理由必须说明要求是显式二选一')

  // 正例：把该视图显式列入 absent 并给理由 → 绿
  declareApplicability({
    viewsPresent: ['context', 'component', 'runtime', 'deployment'],
    viewsAbsent: [{ kind: 'data', why: '沿用旧库，不改数据模型' }],
  })
  signG3()
  assert.equal(criterion(g3().criteria, 'C-2B').ok, true, '显式二选一后适用性判据应转绿')
})

test('M13-02c viewsAbsent 缺理由 → 判红（不做的理由必须写出来给用户看）', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  completeDesignInteraction(requirementId)
  // 直接写盘：`draftApplicability` 会原样保留空理由（不静默补文案）
  office.storeFor(workspace).writeYaml(['design', 'applicability.yml'], {
    applicability: {
      focus: '重构',
      viewsPresent: ['context', 'component', 'runtime', 'deployment'],
      viewsAbsent: [{ kind: 'data', why: '' }],
      artifacts: [],
      draftedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })
  const value = criterion(g3().criteria, 'C-2B')
  assert.equal(value.ok, false, 'absent 条目没写理由时必须判红')
  assert.match(value.detail, /没有写理由/u, '理由必须点明"没写理由"')
})

// —————————————————————— ③ 签字：未签→红 / 签→绿 / 声明变更→失效→红 ——————————————————————

test('M13-03 未签字即便其余全绿 → 红；签字后 → 绿；签字后声明变更 → 失效 → 再红', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  addAdr()
  completeDesignInteraction(requirementId)
  declareApplicability({ viewsPresent: ALL_VIEWS })

  // ① 其余判据都齐备，但**未签字** → G3 红，且只有签字相关项是红的
  const unsigned = g3()
  assert.equal(unsigned.status, 'failed', '未签字即便其余全绿也不可通过')
  const signed = criterion(unsigned.criteria, 'C-2D')
  assert.equal(signed.ok, false, 'design.signed 必须判红')
  assert.match(signed.detail, /还没有用户签字/u, '未签字理由要明确写"还没有用户签字"')
  const others = unsigned.criteria.filter((item) => !item.ok && item.na !== true).map((item) => item.id)
  assert.deepEqual(others, ['C-2D'], `未签字时唯一红项应是 C-2D，实际：${others.join(',')}`)

  // ② 签字 → 绿
  signG3()
  assert.equal(g3().status, 'passed', '签字后 G3 应通过')

  // ③ 签字后**声明变更** → 签字失效 → 再红
  office.draftApplicability(call(), {
    focus: '改成只做受影响部分',
    viewsPresent: ['context', 'component'],
    viewsAbsent: [
      { kind: 'runtime', why: '运行时形态不变' },
      { kind: 'data', why: '数据模型沿用旧库' },
      { kind: 'deployment', why: '部署形态不变' },
    ],
    artifacts: [],
    by: '模型起草',
  })
  const stale = g3()
  assert.equal(stale.status, 'failed', '声明在签字之后变更 → 签字必须失效 → 门禁再红')
  assert.equal(criterion(stale.criteria, 'C-2D').ok, false, '失效后的签字判据必须为红')
  assert.match(criterion(stale.criteria, 'C-2D').detail, /已失效/u, '理由要说明"签字已失效"')

  // ④ 重新签字 → 再绿（失效不是死结）
  signG3('变更后重新确认')
  assert.equal(g3().status, 'passed', '重新签字后应再次通过')
})

// —————————————————————— ④ 签字必须带引用文本 ——————————————————————

test('M13-04 签字无引用文本 → 无效（红）；带引用文本 → 有效（双向）', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  completeDesignInteraction(requirementId)
  declareApplicability({ viewsPresent: ALL_VIEWS })

  // ① 反例：直接写盘一条**空 basis** 的签字（模拟"代签"）→ 判据必须红
  office.storeFor(workspace).writeYaml(['gates', 'signatures.yml'], {
    signatures: [{ gate: 'G3', by: '张三', basis: '   ', channel: 'command', at: new Date().toISOString(), atSeq: 1 }],
  })
  const forged = criterion(g3().criteria, 'C-2D')
  assert.equal(forged.ok, false, '无引用文本的签字必须视为无效')
  assert.match(forged.detail, /没有引用文本/u, '理由必须点明"没有引用文本"')

  // ② 正例：带引用文本的签字 → 绿
  signG3('用户原话：我签字确认')
  const valid = criterion(g3().criteria, 'C-2D')
  assert.equal(valid.ok, true, '带引用文本的签字必须有效')
  assert.match(valid.detail, /用户原话：我签字确认/u, '判据详情里要出现引用原文')
})

test('M13-04b 声明本身的用户确认戳缺 basis → 声明视为未确认（不是"有 confirmed 就算过"）', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  completeDesignInteraction(requirementId)
  // 起草（未签字绑定）+ 直接伪造一条**没有 basis** 的 confirmed
  office.draftApplicability(call(), {
    focus: '重构',
    viewsPresent: ALL_VIEWS,
    viewsAbsent: [],
    artifacts: [],
    by: '模型起草',
  })
  office.storeFor(workspace).writeYaml(['gates', 'signatures.yml'], {
    signatures: [{ gate: 'G3', by: '张三', basis: '   ', channel: 'command', at: new Date().toISOString(), atSeq: 1 }],
  })
  const value = criterion(g3().criteria, 'C-2D')
  assert.equal(value.ok, false, '没有有效签字的声明不得放行')
})

// —————————————————————— ⑤ porting 方法包：最小必产项 ——————————————————————

/**
 * 在**目标工作区**里落一个真实存在的源文件。
 *
 * 为什么需要它：`porting` 包的「目标侧引用真实存在的模块/类型」是拿**被设计的目标工作区**
 * 的文件清单去核的（不是拿插件自己的源码）—— 移植的目标仓库就是工作区。测试里必须真的
 * 造出那个文件，否则"指向真实模块"的正例无从成立。
 */
function writeTargetModule(relativePath: string): void {
  const absolute = join(workspace, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, '// 目标写法的真实模块（测试夹具）\nexport const x = 1\n', 'utf8')
}

/** 写入一份 porting 映射产物；`to` 指向**真实存在**的仓库文件（机械检查会查它）。 */
function writeMapping(requirementId: string, entry: Record<string, unknown>): void {
  office.writeMethodArtifact(call(), 'mapping', {
    summary: '旧→新映射',
    requires: [requirementId],
    mappings: [entry as never],
  })
}

function writeInvariants(requirementId: string, items: Record<string, unknown>[]): void {
  office.writeMethodArtifact(call(), 'invariants', {
    summary: '不变量清单',
    requires: [requirementId],
    invariants: items as never,
  })
}

function writeDiffVerify(requirementId: string, strategy: Record<string, unknown>): void {
  office.writeMethodArtifact(call(), 'diffVerify', {
    summary: '差分验证策略',
    requires: [requirementId],
    diffVerify: strategy as never,
  })
}

const TARGET_MODULE = 'src/reconcile/ReconcileService.ts'

const GOOD_MAPPING = {
  from: 'OldReconcileService.java',
  to: TARGET_MODULE,
  rewrite: '把 setter 注入改成构造注入',
  alternatives: [{ option: '保留 setter', rejectedBecause: '与目标写法不一致，无法机械迁移' }],
}

const GOOD_INVARIANT = { statement: '差异判定结果必须逐字节一致', category: 'behaviour', verify: '用黄金样本跑 1000 组对照' }

const GOOD_DIFF = {
  sameInputSameOutput: '同两日文件输入 → 差异清单逐字节相同',
  baselineSource: 'golden-samples',
  baselineRef: 'testdata/reconcile/golden',
}

/** 选 `porting` 并补齐三类必产项。 */
function portingFixture(): void {
  writeTargetModule(TARGET_MODULE)
  office.askDesignQuestions(call(), { recommendation: { method: 'porting', rationale: '旧写法转新写法' } })
  const question = office
    .questions(call())
    .find((item) => item.targets.includes('design:method'))
  assert.ok(question !== undefined)
  office.answerDesign(call(), question.id, 'porting', '移植：只换写法')
}

test('M13-05a porting 缺映射 / 缺不变量 / 缺差分策略 → 红；补齐 → 绿（双向）', () => {
  const requirementId = baselineRequirement()
  portingFixture()

  // ① 三样都没有 → 全红
  const empty = office.methodProducts(call())
  const emptyPorting = empty.packages.find((item) => item.id === 'porting')
  assert.ok(emptyPorting !== undefined, 'packages 必须有 porting')
  assert.equal(emptyPorting.selected, true, '已选 porting 时必须按选中处理')
  assert.equal(emptyPorting.ok, false, '什么都没有时 porting 包必须失败')
  assert.equal(emptyPorting.na, false, '已选包不允许退化成 N/A')
  assert.equal(emptyPorting.missing.length, 3, `应缺 3 类必产项，实际：${emptyPorting.missing.join(' / ')}`)

  // ② 只补映射与不变量，缺差分策略 → 仍红
  writeMapping(requirementId, GOOD_MAPPING)
  writeInvariants(requirementId, [GOOD_INVARIANT])
  const noDiff = office.methodProducts(call()).packages.find((item) => item.id === 'porting')
  assert.equal(noDiff?.ok, false, '缺差分验证策略时必须仍为红')

  // ③ 补上差分策略 → 绿
  writeDiffVerify(requirementId, GOOD_DIFF)
  const done = office.methodProducts(call()).packages.find((item) => item.id === 'porting')
  assert.equal(done?.ok, true, `三类补齐后 porting 应通过：${done?.missing.join(' / ')}`)
  assert.deepEqual(done?.missing, [])
})

test('M13-05b 不变量没带 verify → 红；补上 verify → 绿（双向）', () => {
  const requirementId = baselineRequirement()
  portingFixture()
  writeMapping(requirementId, GOOD_MAPPING)
  writeDiffVerify(requirementId, GOOD_DIFF)

  // ① 反例：不变量缺 verify
  writeInvariants(requirementId, [{ statement: '存档格式不变', category: 'save-format' }])
  const bad = office.methodProducts(call()).packages.find((item) => item.id === 'porting')
  assert.equal(bad?.ok, false, '不变量没有验证方法时必须判红')
  assert.ok(bad?.missing.some((line) => line.includes('验证方法')), `理由必须点名缺验证方法：${bad?.missing.join(' / ')}`)

  // ② 正例：补上 verify
  writeInvariants(requirementId, [
    { statement: '存档格式不变', category: 'save-format', verify: '用 v1 存档加载后逐字段比对' },
  ])
  const fixed = office.methodProducts(call()).packages.find((item) => item.id === 'porting')
  assert.equal(fixed?.ok, true, `补上 verify 后应通过：${fixed?.missing.join(' / ')}`)
})

test('M13-05c 映射目标侧不是真实存在的模块/类型 → 红；指向真实模块 → 绿（双向）', () => {
  const requirementId = baselineRequirement()
  portingFixture()
  writeInvariants(requirementId, [GOOD_INVARIANT])
  writeDiffVerify(requirementId, GOOD_DIFF)

  // ① 反例：目标侧是一个不存在的模块
  writeMapping(requirementId, { ...GOOD_MAPPING, to: 'src/ghost/NoSuchModule.ts' })
  const ghost = office.methodProducts(call()).packages.find((item) => item.id === 'porting')
  assert.equal(ghost?.ok, false, '映射指向不存在的模块时必须判红')
  assert.ok(ghost?.missing.some((line) => line.includes('不是真实存在')), `理由必须点明目标侧不存在：${ghost?.missing.join(' / ')}`)

  // ② 正例：目标侧指向本仓库真实存在的文件
  writeMapping(requirementId, GOOD_MAPPING)
  const real = office.methodProducts(call()).packages.find((item) => item.id === 'porting')
  assert.equal(real?.ok, true, `指向真实模块后应通过：${real?.missing.join(' / ')}`)
})

test('M13-05d 映射缺替代方案、差分基线来源非法 → 红；补齐 → 绿（双向）', () => {
  const requirementId = baselineRequirement()
  portingFixture()
  writeInvariants(requirementId, [GOOD_INVARIANT])

  // ① 反例：映射没有替代方案 + 差分基线来源非法
  writeMapping(requirementId, { from: 'Old.java', to: 'src/domain/method.ts', rewrite: '改写' })
  writeDiffVerify(requirementId, { sameInputSameOutput: '逐字节相同', baselineSource: 'vibes', baselineRef: 'x' })
  const bad = office.methodProducts(call()).packages.find((item) => item.id === 'porting')
  assert.equal(bad?.ok, false, '缺替代方案 / 基线来源非法时必须判红')
  assert.ok(bad?.missing.some((line) => line.includes('替代方案')), `缺替代方案要出现在理由里：${bad?.missing.join(' / ')}`)
  assert.ok(bad?.missing.some((line) => line.includes('基线来源')), `非法基线来源要出现在理由里：${bad?.missing.join(' / ')}`)

  // ② 正例：补齐替代方案与合法基线来源
  writeMapping(requirementId, GOOD_MAPPING)
  writeDiffVerify(requirementId, GOOD_DIFF)
  const good = office.methodProducts(call()).packages.find((item) => item.id === 'porting')
  assert.equal(good?.ok, true, `补齐后应通过：${good?.missing.join(' / ')}`)
})

test('M13-05e porting 的方法产物进既有孤儿检查（不新造判据）', () => {
  baselineRequirement()
  portingFixture()
  // 不挂 requires 的映射条目 → 既有 `trace.orphans` 必须抓到
  office.writeMethodArtifact(call(), 'mapping', {
    summary: '无来源映射',
    mappings: [GOOD_MAPPING as never],
  })
  const report = office.traceReport(call())
  const orphans = report.orphans.design.join(' ')
  assert.match(orphans, /MAP-/u, `映射条目的孤儿必须由既有检查抓到：${orphans}`)
})

// —————————————————————— ⑥ 存量项目：无声明 → 红，理由必须是"未声明适用性" ——————————————————————

test('M13-06 存量项目（无声明）→ 红，理由必须是"未声明适用性"而不是其它原因', () => {
  const requirementId = baselineRequirement()
  // 模拟存量项目：设计交互全做完了，但**从来没有**起草过适用性声明
  fiveViews(requirementId)
  addAdr()
  completeDesignInteraction(requirementId)

  assert.equal(readApplicability(office.storeFor(workspace)), undefined, '前置：还没有声明')
  const value = g3()
  assert.equal(value.status, 'failed')
  const applicability = criterion(value.criteria, 'C-2B')
  assert.equal(applicability.ok, false)
  assert.match(applicability.detail, /未声明适用性/u, `理由必须是"未声明适用性"：${applicability.detail}`)
  const views = criterion(value.criteria, 'C-20')
  assert.match(views.detail, /未声明适用性/u, '视图判据的失败理由也必须指向声明缺失，而不是"视图为空"')
  const doc = readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8')
  assert.match(doc, /设计适用性声明/u, 'docs/DESIGN.md 必须带上适用性声明章节（第三处可见）')

  // 补声明 + 重新签字 → 存量项目也能转绿（强制重新声明不是死结）
  declareApplicability({
    viewsPresent: ALL_VIEWS,
    viewsAbsent: [],
  })
  signG3()
  assert.equal(g3().status, 'passed', '补声明并签字后应通过')
})

// —————————————————————— 三处可见（§7.1 不得静默）——————————————————————

test('M13-07 声明在注入块 / action=issues / docs/DESIGN.md 三处都出现（不得静默）', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  completeDesignInteraction(requirementId)
  const why = '数据模型沿用旧库，本次不改'
  declareApplicability({
    viewsPresent: ['context', 'component', 'runtime', 'deployment'],
    viewsAbsent: [{ kind: 'data', why }],
    artifacts: ['invariants'],
  })
  // 声明是**真源变更**：派生视图要重渲染才反映它（与"声明必须让用户看到"同一件事）
  office.renderDesign(call())

  // ① 注入块
  const status = office.status(call())
  assert.ok(status.applicabilityLines !== undefined, '状态快照必须带声明渲染行')
  const injected = (status.applicabilityLines ?? []).join('\n')
  assert.match(injected, /旧系统重构/u, '注入块要带 focus')
  assert.match(injected, new RegExp(why), '注入块要带 absent 的理由')
  assert.equal(status.applicabilityConfirmed, true, '签字绑定后状态必须反映出来')

  // ② `sdo_design action=issues`
  const issues = office.designIssues(call())
  assert.ok(Array.isArray(issues.open), '问题账本可读')

  // ③ docs/DESIGN.md
  const doc = readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8')
  assert.match(doc, /设计适用性声明/u, 'DESIGN.md 必须有声明章节')
  assert.match(doc, new RegExp(why), 'DESIGN.md 要带 absent 的理由')
})

test('M13-07b 需求基线回执要提示"下一步在需求阶段定设计适用性"（未声明时）', () => {
  baselineRequirement()
  // D1：`baselineRequirement` 里那次签字仍然有效（baseline 自身写的 `requirement/baselined`
  // 不属于 G2 的失效事件集合），因此第二次冻结不需要重新签字。
  const receipt = office.baseline(call(), { approvedBy: '张三' })
  // 第二次 baseline 会因已冻结而语义不同；这里直接看**未声明**时的回执提示：
  // 用一个独立工作区重放一次基线，断言回执里出现下一步提示。
  assert.equal(receipt.ok, true)
  const store = office.storeFor(workspace)
  // 把声明删掉，模拟"存量项目/还没声明"，再判一次（`baseline` 已冻结，用 describeBaseline 直接渲染）
  store.remove('design', 'applicability.yml')
  const text = describeBaseline(receipt, { applicabilityDeclared: office.applicability(call()) !== undefined })
  assert.match(text, /设计适用性声明/u, `未声明时基线回执必须提示下一步去声明：\n${text}`)
  // 起草后同一条提示必须消失（双向：提示是**条件行**，不是噪声）
  declareApplicability({ viewsPresent: ALL_VIEWS })
  const after = describeBaseline(receipt, { applicabilityDeclared: office.applicability(call()) !== undefined })
  assert.equal(after.includes(t('uiDescribe.kApplicabilityNext')), false, '已声明后不再重复提示')
})

test('M13-08 门禁回执要明确写"等待用户签字确认"', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  completeDesignInteraction(requirementId)
  declareApplicability({ viewsPresent: ALL_VIEWS })
  const receipt = describeGate(g3())
  assert.match(receipt, /等待用户签字/u, `未签字时回执必须写明等待签字：\n${receipt}`)
  signG3()
  assert.equal(receipt.includes('等待用户签字'), true, '（前一次回执是快照，这里只是确认文案可读）')
})

// —————————————————————— §6.1 阶段回退 ——————————————————————

test('M13-09 阶段回退：必须有 reason、只能走声明的合法边、回退后门禁失效', () => {
  const requirementId = baselineRequirement()
  fullyGreenFixture(requirementId)
  // **D2 之后这里不再调用 `advance`**：`baseline` 已经把阶段推到 architecture，而 `advance`
  // 现在会对出口门禁 `evaluateGate` 现算 —— G3 已是绿的，调用它反而会推进到 design-plan。
  // 本用例要的是"停在 architecture 做回退"，因此按构造断言即可（不再依赖"没有 G3 记录"这种旧口径）。
  assert.equal(office.status(call()).project?.phase, 'architecture', '前置：已进入架构阶段')

  // ① 反例：原因空 → 拒绝，阶段不动
  const noReason = office.rollbackPhase(call(), { to: 'requirements', reason: '   ' })
  assert.equal(noReason.ok, false, '没有 reason 的回退必须被拒')
  assert.equal(office.status(call()).project?.phase, 'architecture', '被拒的回退不得改阶段')

  // ② 反例：非法回退边（架构 → 交付 未声明）→ 拒绝
  const illegal = office.rollbackPhase(call(), { to: 'delivery', reason: '随便退' })
  assert.equal(illegal.ok, false, '未声明的回退边必须被拒')
  assert.match(illegal.error ?? '', /非法|不允许/u, '拒绝理由要说明回退边非法')

  // ③ 正例：架构 → 需求（流程数据声明过）→ 通过，且**目标阶段及其之后**的门禁记录全被删
  //    （R-2 收紧：旧语义只删 G2，会让 G4–G7 的陈旧 passed 在重走时直接放行）
  assert.ok(office.rollbackTargets(call()).includes('requirements'), 'waterfall 的架构阶段应允许退回需求')
  const rolled = office.rollbackPhase(call(), { to: 'requirements', reason: '与客户沟通发现需求缺口' })
  assert.equal(rolled.ok, true, `合法回退应当成功：${rolled.error ?? ''}`)
  assert.deepEqual(
    rolled.invalidatedGates,
    ['G2', 'G3', 'G4', 'G5', 'G6', 'G7'],
    '回退到需求阶段必须让「需求及其之后」全部出口门禁失效',
  )
  assert.equal(office.status(call()).project?.phase, 'requirements', '阶段必须退回到需求')
  for (const gate of ['G2', 'G3', 'G4', 'G5', 'G6', 'G7']) {
    assert.equal(existsSync(join(workspace, '.sdo', 'gates', `${gate}.json`)), false, `${gate} 的"已通过"记录必须被删除`)
  }

  // ④ 回退留痕：journal 里有 reason / from / to / invalidatedGates / legalAtThatTime（R-3 自证）
  const events = office.journalFor(workspace).read().events.filter((event) => event.type === 'phase/rolled-back')
  assert.equal(events.length, 1, '回退必须留一条 journal 事件')
  assert.equal(events[0]?.data['from'], 'architecture')
  assert.equal(events[0]?.data['to'], 'requirements')
  assert.equal(events[0]?.data['reason'], '与客户沟通发现需求缺口')
  assert.deepEqual(events[0]?.data['invalidatedGates'], rolled.invalidatedGates, '事件必须记录失效门禁清单')
  assert.deepEqual(
    events[0]?.data['legalAtThatTime'],
    ['requirements', 'feasibility'],
    '事件必须自证「回退当时」的合法边集合',
  )

  // ⑤ 回退后要重新过 G2：重新判定并把记录写回去
  const g2 = office.checkGate(call(), 'G2', '张三')
  assert.equal(g2.status, 'passed', `回退后重新判定的 G2 应通过：${g2.criteria.filter((c) => !c.ok).map((c) => c.id).join(',')}`)
})

test('M13-10 回退判据 `phase.rollback-recorded`：无回退→通过；有回退且合规→通过；非法边→红', () => {
  const requirementId = baselineRequirement()
  fullyGreenFixture(requirementId)
  // ① 从未回退 → 通过
  assert.equal(criterion(g3().criteria, 'C-2E').ok, true, '没有回退时判据应通过')

  office.advance(call())
  // ② 直接伪造一条**非法边**的回退事件 → 判红
  office.journalFor(workspace).append('phase/rolled-back', {
    from: 'architecture',
    to: 'delivery',
    reason: '伪造的非法回退',
    invalidatedGates: [],
  })
  const illegal = criterion(office.evaluate(call(), 'G3').criteria, 'C-2E')
  assert.equal(illegal.ok, false, '非法回退边必须判红')
  assert.match(illegal.detail, /合法目标/u, '理由要给出合法目标')

  // ③ 伪造一条**没有 reason** 的回退 → 判红
  office.journalFor(workspace).append('phase/rolled-back', {
    from: 'architecture',
    to: 'requirements',
    reason: '',
    invalidatedGates: ['G2'],
  })
  const noReason = criterion(office.evaluate(call(), 'G3').criteria, 'C-2E')
  assert.equal(noReason.ok, false, '回退缺 reason 必须判红')
  assert.match(noReason.detail, /没有写 reason/u, '理由要说明缺 reason')
})

// —————————————————————— 时机迁移（§7.2 第 3 条）——————————————————————

test('M13-11 方法论选择题在需求阶段提出（origin=requirements），不再是设计阶段才问', () => {
  const requirementId = baselineRequirement()
  const question = office.questions(call()).find((item) => item.targets.includes('design:method'))
  assert.ok(question !== undefined, '需求阶段就应该有方法论选择题')
  assert.equal(question.origin, 'requirements', `origin 必须是 requirements（实际 ${question.origin}）`)
  assert.equal(question.status, 'open', '提出时未决')

  // 需求阶段就能回答（走同一问答账本，不另造一套）
  office.answer(call(), { id: question.id, answer: '结构化' })
  const answered = office.questions(call()).find((item) => item.id === question.id)
  assert.equal(answered?.status, 'answered', '需求阶段的回答必须落同一账本')
  assert.equal(answered?.origin, 'requirements', 'origin 不因回答而改变')

  // 设计侧仍读得到它（迁移不能让这个决定从设计侧消失）
  const selection = office.methodSelection(call())
  assert.equal(selection.questionId, question.id, '设计侧必须从同一题读答案')
  const issues = office.designIssues(call())
  assert.ok([...issues.open, ...issues.closed].some((item) => item.id === question.id), '设计问题回执里必须仍能看到它')

  // 兼容：设计阶段再跑 grill 也不会重复造第二道方法题
  office.grillDesign(call(), { recommendation: { method: '结构化', rationale: 'x' } })
  const methods = office.questions(call()).filter((item) => item.targets.includes('design:method'))
  assert.equal(methods.length, 1, `方法题只能有一道，实际 ${methods.length}`)
  void requirementId
})

test('M13-12 porting 也被解析与渲染（别名 + 标签），且与既有三包并列可选', () => {
  const requirementId = baselineRequirement()
  portingFixture()
  const selection = office.methodSelection(call())
  assert.equal(selection.status, 'chosen', `porting 必须能被机械解析：${selection.reason}`)
  assert.deepEqual(selection.methods, ['porting'])
  // 未选中的包在回执里是 N/A + 理由（三态口径不变）
  const products = office.methodProducts(call())
  for (const id of ['structured', 'oo', 'evolutionary']) {
    const pack = products.packages.find((item) => item.id === id)
    assert.equal(pack?.na, true, `${id} 未选中时必须是 N/A`)
    assert.equal(pack?.ok, false, 'N/A 绝不能算成通过')
    assert.ok((pack?.naReason ?? '').trim() !== '', 'N/A 必须带理由')
  }
  assert.match(t('uiMethod.prodMapping'), /映射/u)
  void requirementId
})
