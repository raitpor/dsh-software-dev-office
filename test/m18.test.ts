/**
 * 增量 7：F-21 的回归 —— ① 容器族（列表 / 映射位置被手写成别的形状）**系统性收口**；
 * ② `dropped` 只认布尔但**绝不静默**。
 *
 * ① 容器族（与 F-20 的"标量类型假设"同族）：`.sdo/**\/*.yml` 是给人手改的真源，
 *    而 YAML 的类型由写法决定。手写漏一对 `[]`（`targets: REQ-001`）或漏一组 `-`
 *    （`options: {label: 甲}`）在旧实现里会让 `targets.includes` / `dod.some` /
 *    `artifacts.filter` / `viewsPresent.includes` / `collaborators.includes` 抛
 *    `… is not a function`。口径（在**每个实体的 readXxx 边界**归一，不在消费点打补丁）：
 *      · 列表位置：标量 → **单元素列表**（意图明确，不静默丢值）；映射 → **不猜**，按空 + 提示；
 *      · 映射位置：标量 / 列表 → **不猜**，按空映射 + 提示。
 *    每个形状问题都产出 `FieldShapeNote`，在**回执 / 只读视图 / 相关门禁详情**三处可见。
 * ② `dropped`：只有 `true` 才算放弃；`false` / 缺失**无**提示；
 *    非布尔（`yes` / `'true'` / `1`）→ **不放弃**（不替用户猜）但**必须报出**并点名建议写法。
 *
 * 纪律（与 m13/m14/m15/m17 一致）：
 *   · 断言只读**真源**（`.sdo/` 下的 yml / 门禁判据 / 公开读取函数），不采信自述；
 *   · 双向：形状写对时**一条提示都不许有**（有提示就是噪声），写错时值不丢 + 有提示；
 *   · 工具通道用例**按 schema 过滤入参**后调用真实工具（复现宿主的入参过滤）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { adrCompleteness, adrShapeNotes, readAdr } from '../src/domain/adr.js'
import { applicabilityShapeNotes, applicabilityState, readApplicability } from '../src/domain/applicability.js'
import { componentEdges, readView, viewShapeNotes } from '../src/domain/architecture.js'
import { changeShapeNotes, readChange } from '../src/domain/change.js'
import { contractShapeNotes, listContracts } from '../src/domain/contracts.js'
import { confirmationShapeNotes, isConfirmed, listConfirmations, readUiView, uiCompleteness, uiViewShapeNotes } from '../src/domain/design.js'
import { evaluateDor } from '../src/domain/dor.js'
import { feasibilityShapeNotes, readFeasibility, unevaluatedDimensions } from '../src/domain/feasibility.js'
import { openQuestionsFor, questionShapeNotes, readQuestion } from '../src/domain/grill.js'
import { fmt, t } from '../src/domain/i18n.js'
import { issueClosure, issueShapeNotes, readIssue } from '../src/domain/issues.js'
import { artifactEntryCount, methodShapeNotes, readMethodArtifact } from '../src/domain/method.js'
import { listTasks, readTask, taskShapeNotes, validatePlan } from '../src/domain/plan.js'
import { listScenarios, qualityShapeNotes, readScenario } from '../src/domain/quality.js'
import { deliveryCompleteness, manifestShapeNotes, readManifest } from '../src/domain/records.js'
import { listRequirements, readRequirement, requirementShapeNotes } from '../src/domain/requirements.js'
import { collectShapeNotes, shapeNoteHeader, shapeNoteLines } from '../src/domain/shapeNotes.js'
import { latestSignature, signatureShapeNotes } from '../src/domain/signature.js'
import { droppedFlag } from '../src/infra/scalar.js'
import { budgetShapeNotes, crossingTier } from '../src/integration/cost.js'
import type { FieldShapeNote } from '../src/infra/scalar.js'
import { describeChange, describeContract, describeDesign, describeManifest, describeScenarioList, describeTask } from '../src/interface/describe.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m18/', import.meta.url))
const call = (): { sessionId: string } => ({ sessionId: 's1' })

let workspace: string
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  // 只要一个可用的 `.sdo/`（形状归一化在读取边界，不需要走完需求阶段）
  office.init(call(), { name: 'M18 测试', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 直接写一份手改过的 `.sdo/**` 文件（复现"作者手写真源"的场景）。 */
function writeSdo(rel: string, lines: string[]): void {
  const target = join(workspace, '.sdo', rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${lines.join('\n')}\n`)
}

/** 一条提示的渲染（回执 / 门禁详情都该出现这一行）。 */
function line(note: FieldShapeNote): string {
  return shapeNoteLines([note])[0] as string
}

/** 断言"这一行"出现在回执里，失败时把回执整段打出来。 */
function includesLine(text: string, expected: string, what: string): void {
  assert.ok(text.includes(expected), `${what} 必须包含该提示行：\n--- 期望 ---\n${expected}\n--- 实际 ---\n${text}`)
}

// —————————————————————— F-21 ①：设计视图（五视图） ——————————————————————

const VIEW_HEAD = ['view:', '  kind: component', '  elements:', '    - id: DES-001', '      name: api', '      kind: service', '      responsibility: 接口']
const VIEW_TAIL = ['  summary: ""', '  updatedAt: 2026-01-01T00:00:00.000Z']

test('F-21 ①：视图元素 dependsOn 写成标量——不崩、按单元素保留、回执点名（写对时无提示）', () => {
  writeSdo('design/component.yml', [...VIEW_HEAD, '      dependsOn: api', ...VIEW_TAIL])
  const store = office.storeFor(workspace)
  // ① 不崩：修复前 `element.dependsOn.join is not a function`
  assert.deepEqual(readView(store, 'component')?.elements.map((element) => element.dependsOn), [['api']], '标量按单元素列表保留（丢边 = 静默改数据）')
  assert.doesNotThrow(() => componentEdges(store), '契约覆盖判定不得因形状抛异常')
  // ② 提示精确点名实体 / 字段 / 实际类型 / 建议写法
  assert.deepEqual(viewShapeNotes(store), [
    { entity: 'view', id: 'component', field: 'elements[0].dependsOn', key: 'dependsOn', position: 'list', actualType: 'string', handling: 'single', text: 'api' },
  ])
  const expected = fmt('uiDescribe.shapeNoteListSingle', { p1: t('shapeEntity.view'), p2: 'component', p3: 'elements[0].dependsOn', p4: 'string', p5: 'api', p6: 'dependsOn' })
  // ③ 只读视图（回执）里有标题 + 该行
  const view = describeDesign(office.views(call()), office.contracts(call()), [], office.shapeNotes(call()))
  assert.ok(view.includes(shapeNoteHeader()), `视图回执必须给出形状提示标题：\n${view}`)
  includesLine(view, expected, '视图回执')

  // ④ 反向：写对（真正的列表）时**一条提示都不许有**
  writeSdo('design/component.yml', [...VIEW_HEAD, '      dependsOn: [api]', ...VIEW_TAIL])
  assert.deepEqual(viewShapeNotes(office.storeFor(workspace)), [], '列表写法正确时不得产生提示')
  const clean = describeDesign(office.views(call()), office.contracts(call()), [], office.shapeNotes(call()))
  assert.ok(!clean.includes(shapeNoteHeader()), `无形状问题时不出现提示块：\n${clean}`)

  // ⑤ 列表位置写成**映射**：不猜 → 空列表 + 提示（可读失败，不是崩）
  writeSdo('design/component.yml', [...VIEW_HEAD, '      dependsOn:', '        a: 1', ...VIEW_TAIL])
  assert.deepEqual(readView(office.storeFor(workspace), 'component')?.elements.map((element) => element.dependsOn), [[]], '映射写在列表位置按空处理（不猜）')
  assert.deepEqual(viewShapeNotes(office.storeFor(workspace)), [
    { entity: 'view', id: 'component', field: 'elements[0].dependsOn', key: 'dependsOn', position: 'list', actualType: 'object', handling: 'empty', text: '' },
  ])
  assert.doesNotThrow(() => describeDesign(office.views(call()), office.contracts(call()), [], office.shapeNotes(call())))
})

// —————————————————————— F-21 ①：审讯问题 ——————————————————————

const QUESTION_HEAD = ['question:', '  id: Q-0001', '  text: 单日数据量是多少？', '  dimension: data', '  severity: P0', '  why: 影响容量设计', '  consequenceIfUnasked: 容量未知', '  defaultRecommendation: 给出量级']
const QUESTION_TAIL = ['  answer: null', '  status: open', '  askedAt: null', '  answeredBy: null', '  origin: bank']

test('F-21 ①：审讯问题的 targets / options 写成标量——消费点不崩、值保留、提示点名', () => {
  writeSdo('questions/Q-0001.yml', [...QUESTION_HEAD, '  targets: REQ-001', '  options: 直接回答', ...QUESTION_TAIL])
  const store = office.storeFor(workspace)
  const question = readQuestion(store, 'Q-0001')
  assert.deepEqual(question?.targets, ['REQ-001'], 'targets 标量按单元素列表')
  assert.deepEqual(question?.options, [{ label: '直接回答', cost: '' }], 'options 标量按单元素列表（放进最自然的字段）')
  // ① 不崩：修复前 `question.targets.includes is not a function`
  assert.doesNotThrow(() => openQuestionsFor(store, 'REQ-001'))
  assert.deepEqual(questionShapeNotes(store).map((note) => note.field), ['targets', 'options'])
  includesLine(shapeNoteLines(questionShapeNotes(store)).join('\n'), fmt('uiDescribe.shapeNoteListSingle', { p1: t('shapeEntity.question'), p2: 'Q-0001', p3: 'targets', p4: 'string', p5: 'REQ-001', p6: 'targets' }), '问题提示')

  // ② 反向：正常列表 → 无提示
  writeSdo('questions/Q-0001.yml', [...QUESTION_HEAD, '  targets:', '    - REQ-001', '  options:', '    - label: 甲', '      cost: 一', ...QUESTION_TAIL])
  assert.deepEqual(questionShapeNotes(office.storeFor(workspace)), [], '正常列表不得产生提示')

  // ③ 列表位置写成映射 → 空 + 提示（不静默）
  writeSdo('questions/Q-0001.yml', [...QUESTION_HEAD, '  targets:', '    REQ: 001', '  options: []', ...QUESTION_TAIL])
  assert.deepEqual(readQuestion(office.storeFor(workspace), 'Q-0001')?.targets, [], '映射写在列表位置按空处理')
  assert.deepEqual(questionShapeNotes(office.storeFor(workspace)), [
    { entity: 'question', id: 'Q-0001', field: 'targets', key: 'targets', position: 'list', actualType: 'object', handling: 'empty', text: '' },
  ])
})

// —————————————————————— F-21 ①：任务卡 ——————————————————————

const TASK_HEAD = ['task:', '  id: TASK-0001', '  title: 实现差异检测', '  goal: 完成检测', '  role: developer', '  size: small', '  status: planned', '  revision: 1']
const TASK_TAIL = ['  evidenceRequired:', "    - artifact", '  writeScopes:', '    - src/recon/', '  requirements: []', '  createdAt: 2026-01-01T00:00:00.000Z', '  updatedAt: 2026-01-01T00:00:00.000Z']

test('F-21 ①：任务卡的 dod / blockedBy / evidence 写成标量——校验不崩、值保留、门禁详情点名', () => {
  writeSdo('tasks/TASK-0001.yml', [...TASK_HEAD, '  dod: 完成即可', '  blockedBy: TASK-9999', '  evidence: 手工验证通过', ...TASK_TAIL])
  const store = office.storeFor(workspace)
  const task = readTask(store, 'TASK-0001')
  assert.deepEqual(task?.dod, ['完成即可'])
  assert.deepEqual(task?.blockedBy, ['TASK-9999'], 'blockedBy 标量按单元素列表（丢依赖 = 静默改数据）')
  assert.deepEqual(task?.evidence, [{ kind: 'command', detail: '手工验证通过', at: '' }])
  // ① 不崩：修复前 `task.dod.some is not a function` / `task.blockedBy.includes is not a function`
  let issues: ReturnType<typeof validatePlan> | undefined
  assert.doesNotThrow(() => { issues = validatePlan(listTasks(store)) })
  assert.ok((issues ?? []).some((issue) => issue.code === 'acyclic'), '依赖不存在照样判红（可读的失败）')
  assert.deepEqual(taskShapeNotes(store).map((note) => note.field), ['evidence', 'dod', 'blockedBy'])
  // ② 写入回执点名
  const receipt = describeTask(readTask(office.storeFor(workspace), 'TASK-0001') as never, office.shapeNotes(call()))
  includesLine(receipt, line(taskShapeNotes(office.storeFor(workspace))[1] as FieldShapeNote), '任务卡回执')
  // ③ 门禁详情（C-31 `plan.tasks`）点名
  const c31 = office.checkGate(call(), 'G4').criteria.find((criterion) => criterion.id === 'C-31')
  includesLine(c31?.detail ?? '', fmt('uiDescribe.shapeNoteListSingle', { p1: t('shapeEntity.task'), p2: 'TASK-0001', p3: 'dod', p4: 'string', p5: '完成即可', p6: 'dod' }), 'C-31 详情')

  // ④ 反向：正常列表 → 无提示
  writeSdo('tasks/TASK-0001.yml', [...TASK_HEAD, '  dod:', '    - 完成即可', '  blockedBy: []', '  evidence: []', ...TASK_TAIL])
  assert.deepEqual(taskShapeNotes(office.storeFor(workspace)), [], '正常列表不得产生提示')

  // ⑤ 列表位置写成映射 → 空 + 提示，且既有判据判红（dod 非空是硬要求）
  writeSdo('tasks/TASK-0001.yml', [...TASK_HEAD, '  dod:', '    a: 1', '  blockedBy: []', '  evidence: []', ...TASK_TAIL])
  assert.deepEqual(readTask(office.storeFor(workspace), 'TASK-0001')?.dod, [])
  assert.deepEqual(taskShapeNotes(office.storeFor(workspace)), [
    { entity: 'task', id: 'TASK-0001', field: 'dod', key: 'dod', position: 'list', actualType: 'object', handling: 'empty', text: '' },
  ])
  assert.ok(validatePlan(listTasks(office.storeFor(workspace))).some((issue) => issue.code === 'dod-nonempty'), '空 DoD 照旧判红（可读失败）')
})

// —————————————————————— F-21 ①：交付清单 ——————————————————————

const MANIFEST_HEAD = ['manifest:', '  id: DLV-001', '  at: 2026-01-01T00:00:00.000Z', '  by: human', '  rollbackPoint: tag-1', '  prototypeExcluded: true', '  notes: ""']

test('F-21 ①：交付清单的 artifacts / acceptance 写成标量——完整性检查不崩、值保留、提示点名', () => {
  writeSdo('delivery/manifest.yml', [...MANIFEST_HEAD, '  artifacts: src/a.ts', '  acceptance: 对账通过'])
  const store = office.storeFor(workspace)
  const manifest = readManifest(store)
  assert.deepEqual(manifest?.artifacts, [{ path: 'src/a.ts', kind: 'source', sha256: 'missing' }], '标量产物行保留 path（哈希算不出来 → 既有判据判红）')
  assert.deepEqual(manifest?.acceptance, [{ requirement: '对账通过', criterion: '', evidence: '', verdict: 'fail' }])
  // ① 不崩：修复前 `manifest.artifacts.filter is not a function`
  let completeness: ReturnType<typeof deliveryCompleteness> | undefined
  assert.doesNotThrow(() => { completeness = deliveryCompleteness(store, [], 'prototype') })
  assert.equal(completeness?.ok, false, '哈希算不出来 + 验收行不完整 → 可读地判红')
  assert.ok((completeness?.problems ?? []).some((problem) => problem.includes('src/a.ts')))
  assert.deepEqual(manifestShapeNotes(store).map((note) => note.field), ['artifacts', 'acceptance'])
  // `prototypeExcluded` 同样是布尔位置：手写 `yes` 不得被当成"已排除"（Q-05 不得被静默放行）
  writeSdo('delivery/manifest.yml', [...MANIFEST_HEAD.slice(0, -1), '  prototypeExcluded: yes', '  notes: ""', '  artifacts: []', '  acceptance: []'])
  assert.equal(readManifest(office.storeFor(workspace))?.prototypeExcluded, false)
  assert.deepEqual(manifestShapeNotes(office.storeFor(workspace)).map((note) => note.field), ['prototypeExcluded'])
  assert.ok(deliveryCompleteness(office.storeFor(workspace), [], 'prototype').problems.some((problem) => problem.includes('prototype/')), '非布尔 → 门禁照旧判红（不静默放行）')
  includesLine(describeManifest(manifest as never, office.shapeNotes(call())), line(manifestShapeNotes(office.storeFor(workspace))[0] as FieldShapeNote), '交付回执')

  // ② 反向：正常列表 → 无提示
  writeSdo('delivery/manifest.yml', [...MANIFEST_HEAD, '  artifacts:', "    - path: src/a.ts", '      kind: source', '      sha256: abc', '  acceptance: []'])
  assert.deepEqual(manifestShapeNotes(office.storeFor(workspace)), [], '正常列表不得产生提示')

  // ③ 列表位置写成映射 → 空 + 提示
  writeSdo('delivery/manifest.yml', [...MANIFEST_HEAD, '  artifacts:', '    path: src/a.ts', '  acceptance: []'])
  assert.deepEqual(readManifest(office.storeFor(workspace))?.artifacts, [], '单个映射写在列表位置按空处理（不猜它是不是单元素）')
  assert.deepEqual(manifestShapeNotes(office.storeFor(workspace)), [
    { entity: 'manifest', id: 'DLV-001', field: 'artifacts', key: 'artifacts', position: 'list', actualType: 'object', handling: 'empty', text: '' },
  ])
})

// —————————————————————— F-21 ①：适用性声明 ——————————————————————

const APP_HEAD = ['applicability:', '  focus: 内部对账服务', '  draftedAt: 2026-01-01T00:00:00.000Z', '  updatedAt: 2026-01-01T00:00:00.000Z']

test('F-21 ①：适用性声明的 viewsPresent / viewsAbsent / artifacts 写成别的形状——判读不崩、提示点名', () => {
  writeSdo('design/applicability.yml', [...APP_HEAD, '  viewsPresent: component', '  viewsAbsent:', '    - kind: deployment', '      why: 单机部署', '  artifacts: invariants'])
  const store = office.storeFor(workspace)
  const declaration = readApplicability(store)
  assert.deepEqual(declaration?.viewsPresent, ['component'])
  assert.deepEqual(declaration?.artifacts, ['invariants'])
  // ① 不崩：修复前 `app.viewsPresent.includes is not a function`
  let state: ReturnType<typeof applicabilityState> | undefined
  assert.doesNotThrow(() => { state = applicabilityState(store) })
  assert.equal(state?.status, 'incomplete', '未显式二选一的视图照旧判红（可读失败）')
  assert.deepEqual(applicabilityShapeNotes(store).map((note) => note.field), ['viewsPresent', 'artifacts'])

  // ② 反向：正常列表 → 无提示
  writeSdo('design/applicability.yml', [...APP_HEAD, '  viewsPresent:', '    - component', '  viewsAbsent: []', '  artifacts: []'])
  assert.deepEqual(applicabilityShapeNotes(office.storeFor(workspace)), [], '正常列表不得产生提示')

  // ③ viewsAbsent（记录列表）写成单个映射 → 空 + 提示（不猜）
  writeSdo('design/applicability.yml', [...APP_HEAD, '  viewsPresent: []', '  viewsAbsent:', '    kind: deployment', '    why: 单机', '  artifacts: []'])
  assert.deepEqual(readApplicability(office.storeFor(workspace))?.viewsAbsent, [], '单个映射写在记录列表位置按空处理')
  assert.deepEqual(applicabilityShapeNotes(office.storeFor(workspace)), [
    { entity: 'applicability', id: 'applicability.yml', field: 'viewsAbsent', key: 'viewsAbsent', position: 'list', actualType: 'object', handling: 'empty', text: '' },
  ])

  // ④ 标量写在记录列表位置 → 单元素（why 为空 → 既有判据判红，可读失败）
  writeSdo('design/applicability.yml', [...APP_HEAD, '  viewsPresent: []', '  viewsAbsent: deployment', '  artifacts: []'])
  assert.deepEqual(readApplicability(office.storeFor(workspace))?.viewsAbsent, [{ kind: 'deployment', why: '' }])
  assert.deepEqual(applicabilityShapeNotes(office.storeFor(workspace)).map((note) => note.field), ['viewsAbsent'])
})

// —————————————————————— F-21 ①：方法产物 ——————————————————————

test('F-21 ①：方法产物的顶层列表 / 条目内列表 / rules 映射——不崩、值保留、提示点名', () => {
  writeSdo('design/method-classes.yml', [
    'artifact:',
    '  id: MA-001',
    '  kind: classes',
    '  summary: 类清单',
    '  types:',
    '    - name: Reconciler',
    '      kind: class',
    '      layer: domain',
    '      responsibility: 对账',
    '      collaborators: Repo',
    '      requires: REQ-001',
    '  updatedAt: 2026-01-01T00:00:00.000Z',
  ])
  writeSdo('design/method-layers.yml', ['artifact:', '  id: MA-002', '  kind: layers', '  summary: 分层规则', '  rules: none', '  updatedAt: 2026-01-01T00:00:00.000Z'])
  const store = office.storeFor(workspace)
  const classes = readMethodArtifact(store, 'classes')
  assert.deepEqual(classes?.types?.[0]?.collaborators, ['Repo'], '条目内列表（collaborators）标量按单元素')
  assert.deepEqual(classes?.types?.[0]?.requires, ['REQ-001'])
  assert.deepEqual(readMethodArtifact(store, 'layers')?.rules, undefined, 'rules 写成标量 → 空映射（不猜）')
  // ① 不崩：修复前 `type.collaborators.includes is not a function` / `rules.allowed.length`
  assert.doesNotThrow(() => { artifactEntryCount(readMethodArtifact(store, 'layers') as never) })
  assert.deepEqual(methodShapeNotes(store).map((note) => note.field), ['types[0].collaborators', 'types[0].requires', 'rules'])
  // F-14 的 `leaf` 也是布尔位置：`leaf: yes` 不得静默豁免"必须有协作方"
  writeSdo('design/method-classes.yml', ['artifact:', '  id: MA-001', '  kind: classes', '  summary: 类清单', '  types:', '    - name: Reconciler', '      kind: class', '      layer: domain', '      responsibility: 对账', '      collaborators: []', '      leaf: yes', '  updatedAt: 2026-01-01T00:00:00.000Z'])
  assert.equal(readMethodArtifact(office.storeFor(workspace), 'classes')?.types?.[0]?.leaf, undefined, '非布尔 → 按未声明处理（不静默豁免）')
  assert.deepEqual(methodShapeNotes(office.storeFor(workspace)).filter((note) => note.id === 'MA-001').map((note) => note.field), ['types[0].leaf'])
  const layersNote = methodShapeNotes(store).find((note) => note.field === 'rules') as FieldShapeNote
  includesLine(shapeNoteLines([layersNote]).join('\n'), fmt('uiDescribe.shapeNoteMapEmpty', { p1: t('shapeEntity.methodArtifact'), p2: 'MA-002', p3: 'rules', p4: 'string', p5: 'none', p6: 'rules' }), '方法产物提示')

  // ② 顶层列表写成标量 → 单元素（保住作者意图）
  writeSdo('design/method-classes.yml', ['artifact:', '  id: MA-001', '  kind: classes', '  summary: 类清单', '  types: Reconciler', '  updatedAt: 2026-01-01T00:00:00.000Z'])
  assert.deepEqual(readMethodArtifact(office.storeFor(workspace), 'classes')?.types?.map((type) => type.name), ['Reconciler'])
  assert.deepEqual(methodShapeNotes(office.storeFor(workspace)).map((note) => note.field), ['types', 'rules'])

  // ③ 反向：正常形状 → 无提示
  writeSdo('design/method-classes.yml', [
    'artifact:',
    '  id: MA-001',
    '  kind: classes',
    '  summary: 类清单',
    '  types:',
    '    - name: Reconciler',
    '      kind: class',
    '      layer: domain',
    '      responsibility: 对账',
    '      collaborators:',
    '        - Repo',
    '      requires:',
    '        - REQ-001',
    '  updatedAt: 2026-01-01T00:00:00.000Z',
  ])
  writeSdo('design/method-layers.yml', [
    'artifact:',
    '  id: MA-002',
    '  kind: layers',
    '  summary: 分层规则',
    '  rules:',
    '    layers:',
    '      - domain',
    '      - infra',
    '    assignments: {}',
    '    allowed: []',
    '  updatedAt: 2026-01-01T00:00:00.000Z',
  ])
  assert.deepEqual(methodShapeNotes(office.storeFor(workspace)), [], '正常形状不得产生提示')
})

// —————————————————————— F-21 ①：界面视图（第 6 个视图） ——————————————————————

const UI_HEAD = ['ui:', '  id: UI-001', '  style:', '    source: minimal', '    tokens:', '      --fg: "#111"', '    rationale: 极简']
const UI_TAIL = ['  breakpoints: []', '  accessibility:', '    contrast: 4.5:1', '    keyboard: true', '    screenReader: 读屏', '  updatedAt: 2026-01-01T00:00:00.000Z']

test('F-21 ①：界面视图的 screens / layout 写成别的形状——齐备性检查不崩、提示点名', () => {
  writeSdo('design/ui.yml', [...UI_HEAD, '  screens: 差异清单', ...UI_TAIL])
  const store = office.storeFor(workspace)
  assert.deepEqual(readUiView(store)?.screens.map((screen) => screen.name), ['差异清单'], '标量按单元素页面')
  // ① 不崩：修复前 `ui.screens.every is not a function`
  assert.doesNotThrow(() => uiCompleteness(store))
  assert.equal(uiCompleteness(store).columns, false, '缺栏目照旧判"未齐备"（可读失败）')
  assert.deepEqual(uiViewShapeNotes(store), [
    { entity: 'view', id: 'UI-001', field: 'screens', key: 'screens', position: 'list', actualType: 'string', handling: 'single', text: '差异清单' },
  ])

  // ② 反向：正常列表 → 无提示
  writeSdo('design/ui.yml', [...UI_HEAD, '  screens:', '    - id: SCR-001', '      name: 差异清单', '      columns:', '        - name: 编号', '          kind: text', '      layout:', '        grid: 12 栏', '        regions:', '          - 页头', '      interactions: []', '      states: {}', '      requires: []', ...UI_TAIL])
  assert.deepEqual(uiViewShapeNotes(office.storeFor(workspace)), [], '正常列表不得产生提示')

  // ③ 映射写在列表位置 / 映射位置写成标量 → 空 + 提示
  writeSdo('design/ui.yml', [...UI_HEAD, '  screens:', '    name: 差异清单', ...UI_TAIL])
  assert.deepEqual(readUiView(office.storeFor(workspace))?.screens, [], '单个映射写在 screens 位置按空处理（不猜）')
  assert.deepEqual(uiViewShapeNotes(office.storeFor(workspace)).map((note) => note.field), ['screens'])
})

// —————————————————————— F-21 ②：dropped 只认布尔 ——————————————————————

const CONTRACT_HEAD = ['contract:', '  name: api → web', '  kind: http', '  producer: api', '  consumer: web', '  schema: GET /x', "  failureSemantics:", "    timeout: '3s'", "    retry: '2'", "    idempotency: 'k'", '  at: 2026-01-01T00:00:00.000Z']
function writeContract(id: string, body: string[]): void {
  writeSdo(`contracts/${id}.yml`, ['contract:', `  id: ${id}`, ...CONTRACT_HEAD.slice(1), ...body])
}

test('F-21 ②：dropped 只认布尔——true 算放弃、false 不算且无提示、yes 不算但必须报出建议写法', () => {
  // ① 判定助手本身：同一个口径，一处一种写法被堵死
  assert.deepEqual(droppedFlag(true), { dropped: true, issue: undefined })
  assert.deepEqual(droppedFlag(false), { dropped: false, issue: undefined })
  assert.equal(droppedFlag(undefined).dropped, false)
  assert.equal(droppedFlag(undefined).issue, undefined)
  const loose = droppedFlag('yes')
  assert.equal(loose.dropped, false, '插件不替用户猜：yes / true / 1 都不当放弃')
  assert.deepEqual(loose.issue, { position: 'bool', actualType: 'string', handling: 'empty', text: 'yes' })
  assert.equal(droppedFlag(1).dropped, false)

  // ② dropped: true → 放弃（真源对象里也是布尔）
  writeContract('CT-001', ['  dropped: true'])
  const store = office.storeFor(workspace)
  const dropped = listContracts(store).find((contract) => contract.id === 'CT-001')
  assert.equal(dropped?.dropped, true)
  assert.deepEqual(contractShapeNotes(store), [], '布尔 true 不产生提示（正确写法）')

  // ③ dropped: false → 不算放弃，且**无**提示
  writeContract('CT-002', ['  dropped: false'])
  const store2 = office.storeFor(workspace)
  assert.equal(listContracts(store2).find((contract) => contract.id === 'CT-002')?.dropped, false)
  assert.deepEqual(contractShapeNotes(store2), [], '布尔 false 同样不产生提示')

  // ④ dropped: yes（字符串）→ 不算放弃，但**必须报出**并点名建议写法
  writeContract('CT-003', ['  dropped: yes'])
  const store3 = office.storeFor(workspace)
  const looseContract = listContracts(store3).find((contract) => contract.id === 'CT-003')
  assert.equal(looseContract?.dropped, false, '非布尔绝不当放弃')
  assert.deepEqual(contractShapeNotes(store3), [
    { entity: 'contract', id: 'CT-003', field: 'dropped', key: 'dropped', position: 'bool', actualType: 'string', handling: 'empty', text: 'yes' },
  ])
  const expected = fmt('uiDescribe.shapeNoteBool', { p1: t('shapeEntity.contract'), p2: 'CT-003', p3: 'dropped', p4: 'string', p5: 'yes', p6: 'dropped' })
  assert.ok(expected.includes('dropped: true'), `提示必须点名建议写法：${expected}`)
  // 回执
  const store4 = office.storeFor(workspace)
  const contract = listContracts(store4).find((item) => item.id === 'CT-003')
  const receipt = describeContract(contract as never, { totalEdges: 0, covered: 0, missing: [], incompleteSemantics: [] }, [], office.shapeNotes(call()))
  includesLine(receipt, expected, '契约写入回执')
  // 相关门禁详情（C-30 design.contracts）
  const c30 = office.checkGate(call(), 'G4').criteria.find((criterion) => criterion.id === 'C-30')
  includesLine(c30?.detail ?? '', expected, 'C-30 详情')

  // ⑤ 反向：把 CT-003 改成布尔 true 后提示消失、且真源里就是放弃
  writeContract('CT-003', ['  dropped: true'])
  const store5 = office.storeFor(workspace)
  assert.equal(listContracts(store5).find((item) => item.id === 'CT-003')?.dropped, true)
  assert.deepEqual(contractShapeNotes(store5), [], '改成布尔后不得再有提示')
})

// —————————————————————— 工具通道：写入回执 / 只读视图真的带提示 ——————————————————————

interface ToolHarness {
  tools: ToolDefinition[]
  callTool(name: string, args: Record<string, unknown>): Promise<string>
}

/** 真实装配 + 按 schema 过滤入参（复现宿主行为；不过滤会假绿）。 */
function toolHarness(ws: string): ToolHarness {
  const registered: ToolDefinition[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition): (() => void) => { registered.push(tool); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  assert.ok(registered.length >= 20, `真实装配应注册全部工具，实际 ${registered.length}`)
  const exec = { agent: { id: 's1', session: { header: { cwd: ws } } } } as unknown as ToolRunContext
  return {
    tools: registered,
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `工具面缺少 ${name}`)
      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      const dropped = Object.keys(args).filter((key) => !(key in properties))
      assert.deepEqual(dropped, [], `${name} 的这些入参不在 schema 里，会被宿主静默丢掉：${dropped.join(',')}`)
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
      return String(await tool.execute(filtered, exec))
    },
  }
}

test('F-21 工具通道：sdo_design action=view 的只读视图必须带形状提示（无问题时逐字不带）', async () => {
  const harness = toolHarness(workspace)
  writeSdo('design/component.yml', [...VIEW_HEAD, '      dependsOn: api', ...VIEW_TAIL])
  const expected = fmt('uiDescribe.shapeNoteListSingle', { p1: t('shapeEntity.view'), p2: 'component', p3: 'elements[0].dependsOn', p4: 'string', p5: 'api', p6: 'dependsOn' })
  const view = await harness.callTool('sdo_design', { action: 'view' })
  assert.ok(view.includes(shapeNoteHeader()), `只读视图必须给出形状提示标题：\n${view}`)
  includesLine(view, expected, '只读视图')

  // 反向：写对之后，只读视图不再出现提示块
  writeSdo('design/component.yml', [...VIEW_HEAD, '      dependsOn: [api]', ...VIEW_TAIL])
  const clean = await harness.callTool('sdo_design', { action: 'view' })
  assert.ok(!clean.includes(shapeNoteHeader()), `无形状问题时不出现提示块：\n${clean}`)
})

test('F-21 收集器：collectShapeNotes 覆盖每一类实体（不多不少）', () => {
  writeSdo('design/component.yml', [...VIEW_HEAD, '      dependsOn: api', ...VIEW_TAIL])
  writeSdo('design/ui.yml', [...UI_HEAD, '  screens: 差异清单', ...UI_TAIL])
  writeSdo('questions/Q-0001.yml', [...QUESTION_HEAD, '  targets: REQ-001', '  options: []', ...QUESTION_TAIL])
  writeSdo('tasks/TASK-0001.yml', [...TASK_HEAD, '  dod: 完成即可', '  blockedBy: []', '  evidence: []', ...TASK_TAIL])
  writeSdo('delivery/manifest.yml', [...MANIFEST_HEAD, '  artifacts: src/a.ts', '  acceptance: []'])
  writeSdo('design/applicability.yml', [...APP_HEAD, '  viewsPresent: component', '  viewsAbsent: []', '  artifacts: []'])
  writeSdo('design/method-classes.yml', ['artifact:', '  id: MA-001', '  kind: classes', '  summary: 类清单', '  types: Reconciler', '  updatedAt: 2026-01-01T00:00:00.000Z'])
  writeContract('CT-001', ['  dropped: yes'])

  const notes = collectShapeNotes(office.storeFor(workspace))
  assert.deepEqual(
    [...new Set(notes.map((note) => note.entity))].sort(),
    ['applicability', 'contract', 'manifest', 'methodArtifact', 'question', 'task', 'view'],
    '每一类实体都要被收集到（漏一类就是静默）',
  )
  assert.deepEqual(notes.filter((note) => note.entity === 'view').map((note) => note.id).sort(), ['UI-001', 'component'])
  // 每条提示都能渲染成一句可读的话（无 undefined / 无未替换的占位符）
  for (const text of shapeNoteLines(notes)) {
    assert.ok(!text.includes('{p'), `提示文案不得残留占位符：${text}`)
    assert.ok(text.length > 10, `提示文案必须可读：${text}`)
  }
})

// —————————————————————— F-21 ①：其余手写真源实体（需求 / 可行性 / 议题 / 质量 / ADR / 变更 / 台账） ——————————————————————

test('F-21 ①：需求 / 可行性 / 议题 / 质量 / ADR / 变更 / 两个台账的手写形状都不崩且有提示', () => {
  // 需求：acceptance（记录列表）与 ambiguity.dimensions（映射）
  writeSdo('requirements/REQ-001.yml', [
    'requirement:',
    '  id: REQ-001',
    '  title: 差异检测',
    '  kind: functional',
    '  statement: 识别差异',
    '  rationale: 对账需要',
    '  acceptance: 输出差异清单',
    '  ambiguity:',
    '    score: 8',
    '    dimensions: data',
    '    open: []',
    '  status: draft',
    '  version: 1',
    '  createdAt: 2026-01-01T00:00:00.000Z',
    '  updatedAt: 2026-01-01T00:00:00.000Z',
  ])
  let store = office.storeFor(workspace)
  assert.deepEqual(readRequirement(store, 'REQ-001')?.acceptance.map((ac) => ac.then), ['输出差异清单'])
  assert.doesNotThrow(() => evaluateDor({ requirements: listRequirements(store), questions: [], project: undefined, redTeamExecuted: true, redTeamDisabled: false }))
  assert.deepEqual(requirementShapeNotes(store).map((note) => note.field), ['acceptance', 'ambiguity.dimensions'])

  // 可行性：telos（映射）与 poc（列表）
  writeSdo('feasibility.yml', ['feasibility:', '  id: FEAS-001', '  telos: 技术可行', '  verdict: go', '  rationale: 可行', '  poc: 先验证格式', '  at: 2026-01-01T00:00:00.000Z', '  by: human'])
  store = office.storeFor(workspace)
  assert.equal(readFeasibility(store)?.verdict, 'go')
  assert.doesNotThrow(() => unevaluatedDimensions(readFeasibility(store)))
  assert.deepEqual(feasibilityShapeNotes(store).map((note) => note.field), ['telos', 'poc'])

  // 红队议题：angles / questionIds
  writeSdo('issues/REQ-ISSUE-001.yml', ['issue:', '  id: REQ-ISSUE-001', '  target: REQ-001', '  angles: redteam-cost', '  questionIds: Q-0001', '  status: open', '  disposition: none', '  note: ""', '  at: 2026-01-01T00:00:00.000Z'])
  store = office.storeFor(workspace)
  assert.deepEqual(readIssue(store, 'REQ-ISSUE-001')?.questionIds, ['Q-0001'])
  assert.doesNotThrow(() => issueClosure(readIssue(store, 'REQ-ISSUE-001') as never, [], []))
  assert.deepEqual(issueShapeNotes(store).map((note) => note.field), ['angles', 'questionIds'])

  // 质量场景 targets + ATAM 三张清单
  writeSdo('quality/QS-001.yml', ['scenario:', '  id: QS-001', '  attribute: 性能', '  stimulus: 请求', '  response: 响应', '  measure: P99 < 500ms', '  priority: high', '  targets: REQ-001', '  at: 2026-01-01T00:00:00.000Z'])
  writeSdo('quality/atam.yml', ['assessment:', '  at: 2026-01-01T00:00:00.000Z', '  by: human', '  risks: 单点', '  sensitivities: []', '  tradeoffs: []'])
  store = office.storeFor(workspace)
  assert.deepEqual(readScenario(store, 'QS-001')?.targets, ['REQ-001'])
  assert.doesNotThrow(() => describeScenarioList(listScenarios(store)))
  assert.deepEqual(qualityShapeNotes(store).map((note) => note.field), ['targets', 'risks'])

  // ADR：alternatives（记录列表）/ consequences（列表）
  writeSdo('decisions/ADR-001.yml', ['adr:', '  id: ADR-001', '  title: 选型', '  status: accepted', '  context: 背景', '  decision: 用 A', '  alternatives: 用 B', '  consequences: 成本上升', '  at: 2026-01-01T00:00:00.000Z'])
  store = office.storeFor(workspace)
  assert.deepEqual(readAdr(store, 'ADR-001')?.alternatives.map((item) => item.option), ['用 B'])
  assert.equal(adrCompleteness(store).incomplete.length, 0, '标量按单元素保留 → 不再把字符串长度当条目数（不静默判错）')
  assert.deepEqual(adrShapeNotes(store).map((note) => note.field), ['alternatives', 'consequences'])

  // 变更请求：changes 与 impact 映射
  writeSdo('changes/CR-001.yml', ['change:', '  id: CR-001', '  requirement: REQ-001', '  reason: 需求变了', '  changes: 增加字段', '  impact: 影响两个任务', '  decision: approved', '  decidedBy: 张三', '  at: 2026-01-01T00:00:00.000Z'])
  store = office.storeFor(workspace)
  assert.deepEqual(readChange(store, 'CR-001')?.changes, ['增加字段'])
  assert.deepEqual(readChange(store, 'CR-001')?.impact.design, [])
  assert.doesNotThrow(() => describeChange({ change: readChange(store, 'CR-001') as never, applied: false }))
  assert.deepEqual(changeShapeNotes(store).map((note) => note.field), ['changes', 'impact'])

  // 两个台账：confirmations / signatures（`?? []` 挡不住标量）
  writeSdo('design/confirmed.yml', ['confirmations: DES-001'])
  writeSdo('gates/signatures.yml', ['signatures: G3'])
  store = office.storeFor(workspace)
  assert.deepEqual(listConfirmations(store).map((item) => item.target), ['DES-001'], '标量按单元素保留（意图明确）')
  assert.doesNotThrow(() => isConfirmed(store, 'DES-001'))
  assert.doesNotThrow(() => latestSignature(store, 'G3'))
  assert.deepEqual(confirmationShapeNotes(store).map((note) => note.field), ['confirmations'])
  assert.deepEqual(signatureShapeNotes(store).map((note) => note.field), ['signatures'])

  // 反向：全部改成正确形状后，一条提示都不许有
  writeSdo('requirements/REQ-001.yml', [
    'requirement:',
    '  id: REQ-001',
    '  title: 差异检测',
    '  kind: functional',
    '  statement: 识别差异',
    '  rationale: 对账需要',
    '  acceptance:',
    '    - id: AC-001',
    '      given: 有文件',
    '      when: 执行',
    '      then: 输出清单',
    '  ambiguity:',
    '    score: 8',
    '    dimensions:',
    '      data: 2',
    '    open: []',
    '  status: draft',
    '  version: 1',
    '  createdAt: 2026-01-01T00:00:00.000Z',
    '  updatedAt: 2026-01-01T00:00:00.000Z',
  ])
  writeSdo('feasibility.yml', ['feasibility:', '  id: FEAS-001', '  telos:', '    technical:', '      verdict: 可行', '      rationale: 已验证', '  verdict: go', '  rationale: 可行', '  poc: []', '  at: 2026-01-01T00:00:00.000Z', '  by: human'])
  writeSdo('issues/REQ-ISSUE-001.yml', ['issue:', '  id: REQ-ISSUE-001', '  target: REQ-001', '  angles:', '    - redteam-cost', '  questionIds:', '    - Q-0001', '  status: open', '  disposition: none', '  note: ""', '  at: 2026-01-01T00:00:00.000Z'])
  writeSdo('quality/QS-001.yml', ['scenario:', '  id: QS-001', '  attribute: 性能', '  stimulus: 请求', '  response: 响应', '  measure: P99 < 500ms', '  priority: high', '  targets:', '    - REQ-001', '  at: 2026-01-01T00:00:00.000Z'])
  writeSdo('quality/atam.yml', ['assessment:', '  at: 2026-01-01T00:00:00.000Z', '  by: human', '  risks:', '    - 单点', '  sensitivities: []', '  tradeoffs: []'])
  writeSdo('decisions/ADR-001.yml', ['adr:', '  id: ADR-001', '  title: 选型', '  status: accepted', '  context: 背景', '  decision: 用 A', '  alternatives:', '    - option: 用 B', '      pros: 快', '      cons: 贵', '  consequences:', '    - 成本上升', '  at: 2026-01-01T00:00:00.000Z'])
  writeSdo('changes/CR-001.yml', ['change:', '  id: CR-001', '  requirement: REQ-001', '  reason: 需求变了', '  changes:', '    - 增加字段', '  impact:', '    design: []', '    tasks: []', '    tests: []', '    note: ""', '  decision: approved', '  decidedBy: 张三', '  at: 2026-01-01T00:00:00.000Z'])
  writeSdo('design/confirmed.yml', ['confirmations:', '  - target: DES-001', '    basis: 用户确认', '    by: human', '    at: 2026-01-01T00:00:00.000Z'])
  writeSdo('gates/signatures.yml', ['signatures:', '  - gate: G3', '    by: 张三', '    basis: 用户原话', '    channel: command', '    at: 2026-01-01T00:00:00.000Z', '    atSeq: 3'])
  const all = collectShapeNotes(office.storeFor(workspace))
  assert.deepEqual(all, [], `形状全部写对时不得有提示：${JSON.stringify(all)}`)
})

test('F-21 ①：预算的 tiers / askedTiers / decisions 写成标量——不再被展开成字符（静默胡说）', () => {
  writeSdo('budget.yml', ['budget:', '  currency: CNY', '  tiers: 50', '  askedTiers: 50%', '  decisions: 追加预算'])
  const store = office.storeFor(workspace)
  // 修复前：`[...budget.tiers]` 把 '50' 展开成 ['5','0']，阈值提醒变成静默的胡说
  assert.deepEqual(office.budget(call())?.tiers, [50], '标量按单元素数字保留（意图明确）')
  assert.deepEqual(office.budget(call())?.askedTiers, ['50%'])
  assert.deepEqual(office.budget(call())?.decisions.map((decision) => decision.tier), ['追加预算'])
  assert.doesNotThrow(() => crossingTier(60, { total: 100, currency: 'CNY', tiers: [50], askedTiers: [], decisions: [] }))
  assert.deepEqual(budgetShapeNotes(store).map((note) => note.field), ['tiers', 'askedTiers', 'decisions'])

  // 反向：正常形状 → 无提示
  writeSdo('budget.yml', ['budget:', '  currency: CNY', '  total: 100', '  tiers:', '    - 50', '    - 80', '  askedTiers: []', '  decisions: []'])
  assert.deepEqual(budgetShapeNotes(office.storeFor(workspace)), [], '正常形状不得产生提示')
  // 写回路径不得因归一化写出 undefined（YAML 写入器不支持）
  assert.doesNotThrow(() => office.setBudget(call(), { total: 200 }))
})
