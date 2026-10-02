/**
 * 增量 6：诊断报告《2026-10-01-插件测试报告-0.1.2设计阶段》§6.6–§6.9 的回归
 * （F-16 / F-17 / F-18 / F-19 / F-20）。
 *
 *   F-16  早期构建写入的契约**方向被交换**（存量残留）：当前构建的写入路径已对（D4-2），
 *         但**读取侧没有任何提示** —— 报告 §6.6.1 用逐条语义核对证明「名字与字段矛盾」
 *         只能推出"两者之一错了"，**推不出是哪一边**（9 条字段错 + 17 条名字旧口径）。
 *         因此本插件只做**检测与告警**，绝不自动对调。
 *   F-17  `sdo_requirement` 的 schema 动作枚举漏了 `change`（报错列表里有、schema 里没有）
 *   F-18  同一份报错列表反向漏了 `design-questions` / `applicability` / `applicability-confirm`
 *   F-19  逐条确认戳**不绑定内容**：内容改了旧戳仍算"已确认"（门禁背书的是另一个版本）
 *   F-20  手工把契约字段写成**未加引号的数字**（`retry: 2`）→ YAML 解析成 number →
 *         `contractCoverage` 抛 `contract.failureSemantics.retry.trim is not a function`。
 *         口径：不崩（按字符串 `2` 使用）/ 不假红（值语义正确，不因此判红）/ 不静默
 *         （回执与 C-30 详情点名契约、字段、类型、建议写法）；对象/数组给**可读的失败**。
 *
 * 纪律（与 m13/m14/m15 一致）：
 *   · 断言只读**真源**（`.sdo/` 下的 yml / journal / 门禁判据），不采信自述；
 *   · 工具通道用例**按 schema 过滤入参**后调用真实工具（复现宿主的入参过滤）；
 *   · 双向：确认→改内容→失效→重新确认→恢复，正反两个方向都要有断言。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { contractCoverage, contractDirectionAnomalies, contractFieldNotes, listContracts } from '../src/domain/contracts.js'
import { fmt, t } from '../src/domain/i18n.js'
import { describeDesign } from '../src/interface/describe.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import {
  ADR_ACTIONS,
  COST_ACTIONS,
  DELIVER_ACTIONS,
  DESIGN_ACTIONS,
  FEASIBILITY_ACTIONS,
  GATE_ACTIONS,
  LANG_ACTIONS,
  PLAN_ACTIONS,
  PROJECT_ACTIONS,
  QUALITY_ACTIONS,
  REDTEAM_ACTIONS,
  REQUIREMENT_ACTIONS,
  REVIEW_ACTIONS,
  RISK_ACTIONS,
  TASK_ACTIONS,
  TEST_ACTIONS,
  TRACE_ACTIONS,
  actionList,
} from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m17/', import.meta.url))
const ALL2 = { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }
const call = (): { sessionId: string } => ({ sessionId: 's1' })

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

// —————————————————————— 夹具（需求阶段用领域门面，设计阶段走工具通道） ——————————————————————

/** 一条已基线需求（G2 通过），项目**含界面**（`surfaces=['web']`）。 */
function baselineRequirement(): string {
  office.init(call(), { name: 'M17 测试', scale: 'normal', stakeholders: ['业务方'], surfaces: ['web'] })
  office.updateProject(call(), {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call(), { title: '格式变更', level: 'low', probability: 'low', impact: '小', mitigation: '校验', owner: '业务方' })
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
  assert.equal(outcome.ok, true, `前置：基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}

interface ToolHarness {
  tools: ToolDefinition[]
  callTool(name: string, args: Record<string, unknown>): Promise<string>
}

/** 真实装配 + 按 schema 过滤入参（复现宿主行为；F-7 的教训：不过滤会假绿）。 */
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

/** 设计门禁前置：计划评审出口（无 plan mode 服务的宿主用它）。 */
async function readyForDesign(harness: ToolHarness): Promise<void> {
  await harness.callTool('sdo_design', { action: 'review', approvedBy: '张三' })
}

const UI_VIEW = (layout: string): string => JSON.stringify({
  id: 'UI-001',
  style: { source: 'minimal', tokens: { '--fg': '#111' }, rationale: '极简，减少视觉噪声' },
  screens: [
    {
      id: 'SCR-001',
      name: '差异清单',
      columns: [{ name: '编号', kind: 'text' }, { name: '标题', kind: 'text' }],
      layout: { grid: '12 栏', regions: [layout] },
      requires: [],
    },
  ],
  breakpoints: [{ name: 'desktop', width: '≥1024', changes: ['三栏'] }],
  accessibility: { contrast: '>=4.5:1', keyboard: true, screenReader: '读屏可用' },
})

// —————————————————————— F-17 / F-18：三份动作清单同源 ——————————————————————

/** 工具 → 动作常量 + 编译产物里的 handler 名 + 落到默认分支的动作。 */
const ACTION_BRANCHES: ReadonlyArray<{
  tool: string
  handler: string
  actions: readonly string[]
  /** 该动作由 `default` 分支承接（实现里没有它的字面量） */
  defaultAction?: string
  /** 该工具有「未知 action」报错回执（清单必须与常量一致） */
  receiptKey?: string
  /** schema 在动作清单之后还追加了"各动作语义"的说明句（清单本身仍由常量生成） */
  proseSuffix?: boolean
  /** 静态分支核对不适用（handler 不是 `async x(call, args)` 形态；另有运行用例覆盖） */
  skipStatic?: boolean
}> = [
  { tool: 'sdo_project', handler: 'project', actions: PROJECT_ACTIONS, receiptKey: 'uiIndex.k9' },
  { tool: 'sdo_cost', handler: 'cost', actions: COST_ACTIONS, receiptKey: 'uiIndex.k17' },
  { tool: 'sdo_plan', handler: 'plan', actions: PLAN_ACTIONS, receiptKey: 'uiIndex.k29' },
  { tool: 'sdo_task', handler: 'task', actions: TASK_ACTIONS },
  { tool: 'sdo_test', handler: 'test', actions: TEST_ACTIONS },
  { tool: 'sdo_review', handler: 'review', actions: REVIEW_ACTIONS, defaultAction: 'list' },
  { tool: 'sdo_deliver', handler: 'deliver', actions: DELIVER_ACTIONS, defaultAction: 'show' },
  { tool: 'sdo_gate', handler: 'gate', actions: GATE_ACTIONS, receiptKey: 'uiIndex.k59' },
  { tool: 'sdo_feasibility', handler: 'feasibility', actions: FEASIBILITY_ACTIONS, receiptKey: 'uiIndex.k61' },
  { tool: 'sdo_risk', handler: 'risk', actions: RISK_ACTIONS },
  { tool: 'sdo_requirement', handler: 'requirement', actions: REQUIREMENT_ACTIONS, receiptKey: 'uiIndex.k88' },
  { tool: 'sdo_redteam', handler: 'redteam', actions: REDTEAM_ACTIONS, proseSuffix: true },
  { tool: 'sdo_design', handler: 'design', actions: DESIGN_ACTIONS, receiptKey: 'uiIndex.k102' },
  { tool: 'sdo_adr', handler: 'adr', actions: ADR_ACTIONS },
  { tool: 'sdo_quality', handler: 'quality', actions: QUALITY_ACTIONS },
  { tool: 'sdo_trace', handler: 'trace', actions: TRACE_ACTIONS },
  { tool: 'sdo_lang', handler: 'langAction', actions: LANG_ACTIONS, proseSuffix: true, skipStatic: true },
]

/**
 * 取出 handler 里 `switch (args.action) { … }` 的**整段**（花括号配对）。
 *
 * 为什么不能直接扫 `case 'x'`：同一个 handler 里还有 `switch (outcome.kind)` 这类
 * **不是动作**的分支（`sdo_design` 的设计门禁前置就有 6 条），把它们算成动作会假红。
 */
export function actionSwitchBodies(body: string): string[] {
  const out: string[] = []
  const marker = /switch \(args\.action\)/gu
  let match = marker.exec(body)
  while (match !== null) {
    const open = body.indexOf('{', match.index)
    if (open >= 0) {
      let depth = 0
      let index = open
      for (; index < body.length; index += 1) {
        if (body[index] === '{') depth += 1
        else if (body[index] === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      out.push(body.slice(open, index + 1))
    }
    marker.lastIndex = match.index + match[0].length
    match = marker.exec(body)
  }
  return out
}

/**
 * 从**编译产物**里抽出某个 handler 认识的动作字面量。
 *
 * 为什么读编译产物：TS 源码里类型标注/注释中的 `'view'` 会让源码扫描假绿（F-7 的教训）。
 * 两种写法都要覆盖：`switch (args.action) { case 'x': }` 与 `if (action === 'x')`。
 */
export function handlerActions(source: string, handler: string): { literals: string[]; defaultAction?: string } {
  const marks = [...source.matchAll(/async (\w+)\(call, args\) \{/gu)].map((match) => ({
    name: match[1] as string,
    at: match.index ?? 0,
  }))
  const index = marks.findIndex((mark) => mark.name === handler)
  if (index < 0) return { literals: [] }
  const body = source.slice(marks[index]!.at, marks[index + 1]?.at ?? source.length)
  const literals = new Set<string>()
  for (const block of actionSwitchBodies(body)) {
    for (const match of block.matchAll(/case '([^']+)'/gu)) literals.add(match[1] as string)
  }
  for (const match of body.matchAll(/\baction (?:===|!==) '([^']+)'/gu)) literals.add(match[1] as string)
  return { literals: [...literals] }
}

/** 报告 F-17/F-18 的机械核对：编译产物分支集合 == 常量集合。 */
export function actionDrift(
  source: string,
  entries: ReadonlyArray<{ tool: string; handler: string; actions: readonly string[]; defaultAction?: string }>,
): string[] {
  const drift: string[] = []
  for (const entry of entries) {
    const { literals } = handlerActions(source, entry.handler)
    if (literals.length === 0) {
      drift.push(`${entry.tool}: 编译产物里找不到 handler ${entry.handler}`)
      continue
    }
    const found = new Set(literals)
    if (entry.defaultAction !== undefined) found.add(entry.defaultAction)
    const declared = new Set(entry.actions)
    for (const action of declared) if (!found.has(action)) drift.push(`${entry.tool}: 常量声明了 ${action}，实现里没有分支`)
    for (const action of found) if (!declared.has(action)) drift.push(`${entry.tool}: 实现里有 ${action}，常量没声明`)
  }
  return drift
}

test('F-17/F-18 守卫：动作常量 == 编译产物分支 == schema 描述（三份清单同源）', () => {
  const harness = toolHarness(workspace)
  const compiled = readFileSync(join(ROOT, 'lib/src/index.js'), 'utf8')
  assert.deepEqual(
    actionDrift(compiled, ACTION_BRANCHES.filter((entry) => entry.skipStatic !== true)),
    [],
    '动作常量与实现分支漂移（这份清单以前散在三处，各错一边）',
  )
  for (const entry of ACTION_BRANCHES) {
    const tool = harness.tools.find((item) => item.name === entry.tool)
    assert.ok(tool !== undefined, `工具面缺少 ${entry.tool}`)
    const description = (tool.parameters as { properties?: Record<string, { description?: string }> }).properties?.action?.description
    if (entry.proseSuffix === true) {
      // 说明句在语言包里（`param.redteamAction` / `param.langAction`），清单必须来自常量
      assert.ok(description?.startsWith(actionList(entry.actions)), `${entry.tool} 的 schema 动作清单必须由常量生成：${description}`)
    } else {
      assert.equal(description, actionList(entry.actions), `${entry.tool} 的 schema 动作清单必须由常量生成`)
    }
  }
  // 守卫自证：删掉一个分支必须被报出来（不是空断言）
  const broken = compiled.replace("case 'change': {", "case 'change-renamed': {")
  assert.ok(
    actionDrift(broken, ACTION_BRANCHES).some((line) => line.includes('sdo_requirement') && line.includes('change')),
    '把实现分支改名后守卫必须报出 sdo_requirement 的 change 漂移',
  )
})

test('F-17/F-18 守卫自证：合成一份分支集合与常量不符的编译产物，检查器必须逐条报出', () => {
  const synthetic = [
    'async probe(call, args) {',
    "  switch (args.action) {",
    "    case 'a': break",
    "    case 'b': break",
    '    default: break',
    '  }',
    '}',
  ].join('\n')
  const drift = actionDrift(synthetic, [{ tool: 'sdo_probe', handler: 'probe', actions: ['a', 'c'] }])
  assert.deepEqual(drift.sort(), [
    'sdo_probe: 实现里有 b，常量没声明',
    'sdo_probe: 常量声明了 c，实现里没有分支',
  ])
  // 找不到 handler 也必须报（不许静默当"通过"）
  assert.deepEqual(actionDrift(synthetic, [{ tool: 'sdo_x', handler: 'missing', actions: ['a'] }]), [
    'sdo_x: 编译产物里找不到 handler missing',
  ])
})

test('F-17/F-18：未知 action 的报错回执必须列出该工具的**全部**动作（含 change / sign / rollback）', async () => {
  baselineRequirement()
  const harness = toolHarness(workspace)
  await readyForDesign(harness)
  for (const entry of ACTION_BRANCHES) {
    if (entry.receiptKey === undefined) continue
    const receipt = await harness.callTool(entry.tool, { action: '__probe__' })
    assert.ok(
      receipt.includes(entry.actions.join(' | ')),
      `${entry.tool} 的报错回执必须列全动作：期望含「${entry.actions.join(' | ')}」，实际：${receipt.split('\n')[0]}`,
    )
  }
  // F-17 的原症状：schema 漏 change（模型会以为不支持变更控制）
  const requirement = harness.tools.find((item) => item.name === 'sdo_requirement')
  const description = (requirement?.parameters as { properties?: Record<string, { description?: string }> }).properties?.action?.description ?? ''
  assert.ok(description.includes("'change'"), `sdo_requirement 的 schema 必须声明 change：${description}`)
  // F-18 的原症状：报错列表漏 design-questions / applicability / applicability-confirm
  for (const action of ['design-questions', 'applicability', 'applicability-confirm']) {
    assert.ok(description.includes(`'${action}'`), `sdo_requirement 的 schema 必须声明 ${action}`)
  }
  // 门禁侧：sign / rollback 此前两处都漏
  const gate = harness.tools.find((item) => item.name === 'sdo_gate')
  const gateDescription = (gate?.parameters as { properties?: Record<string, { description?: string }> }).properties?.action?.description ?? ''
  for (const action of ['sign', 'rollback']) {
    assert.ok(gateDescription.includes(`'${action}'`), `sdo_gate 的 schema 必须声明 ${action}`)
  }
  // 报错回执与真源一致：GATE_ACTIONS 里的 sign/rollback 都真的被实现认识（不是抄进清单）
  assert.ok((await harness.callTool('sdo_gate', { action: 'sign' })).length > 0)
  assert.equal((await harness.callTool('sdo_gate', { action: 'sign' })).includes('未知 action'), false)
  assert.equal((await harness.callTool('sdo_gate', { action: 'rollback' })).includes('未知 action'), false)
  assert.equal((await harness.callTool('sdo_requirement', { action: 'change' })).includes('未知 action'), false)
  assert.equal((await harness.callTool('sdo_task', { action: 'release' })).includes('未知 action'), false)
})

// —————————————————————— F-19：确认戳绑定内容 ——————————————————————

/** 造一个"有需求来源"的元素（无来源的元素本来就不在关键条目清单里）。 */
function elementWithSource(requirementId: string): string {
  const created = office.upsertElement(call(), {
    kind: 'component',
    name: '差异检测服务',
    responsibility: '识别差异（v1）',
    requires: [requirementId],
  })
  return created.element.id
}

test('F-19：确认 → 改内容 → 失效 → 重新确认 → 恢复（元素，双向）', async () => {
  const requirementId = baselineRequirement()
  const harness = toolHarness(workspace)
  await readyForDesign(harness)
  const target = elementWithSource(requirementId)

  // ① 未确认 → 缺口里有它
  assert.deepEqual(office.designConfirmGaps(call()).missing, [target])
  assert.deepEqual(office.designConfirmGaps(call()).stale, [])

  // ② 确认 → 缺口清空，真源里**绑定了内容指纹**
  await harness.callTool('sdo_design', { action: 'confirm', target, note: '用户原话：这条我确认' })
  const afterConfirm = office.designConfirmGaps(call())
  assert.deepEqual(afterConfirm.missing, [])
  assert.deepEqual(afterConfirm.stale, [])
  const confirmedFile = readFileSync(join(workspace, '.sdo/design/confirmed.yml'), 'utf8')
  assert.match(confirmedFile, /contentHash: sha256:[0-9a-f]{64}/u, `确认戳必须绑定内容指纹：\n${confirmedFile}`)
  const gateGreen = office.checkGate(call(), 'G3').criteria.find((item) => item.id === 'C-24')
  assert.equal(gateGreen?.ok, true, `确认后 C-24 应通过：${gateGreen?.detail}`)

  // ③ 改内容（按 id 原地改写，target 不变）→ 旧确认失效 + 门禁判红且**说得清是"内容已变"**
  const rewrite = await harness.callTool('sdo_design', {
    action: 'create',
    kind: 'component',
    id: target,
    name: '差异检测服务',
    responsibility: '识别差异（v2：规则完全重写）',
  })
  assert.ok(
    rewrite.includes(t('uiDesign.uiConfirmInvalidatedHeader')),
    `改写回执必须点名"确认戳因内容变更失效"：\n${rewrite}`,
  )
  assert.ok(rewrite.includes(target), `失效清单必须点出是哪个 target：\n${rewrite}`)
  const afterChange = office.designConfirmGaps(call())
  assert.deepEqual(afterChange.missing, [target], '内容改了，旧确认不得再算"已确认"')
  assert.deepEqual(afterChange.stale.map((item) => item.target), [target])
  assert.notEqual(afterChange.stale[0]?.confirmedHash, afterChange.stale[0]?.currentHash, '两版指纹必须不同')
  assert.match(afterChange.stale[0]?.confirmedHash ?? '', /^sha256:[0-9a-f]{64}$/u, '指纹带算法前缀，避免纯数字被 YAML 解析成 number 造成永假不等')
  const gateRed = office.checkGate(call(), 'G3').criteria.find((item) => item.id === 'C-24')
  assert.equal(gateRed?.ok, false, '内容已变后 C-24 必须判红')
  assert.ok(
    (gateRed?.detail ?? '').includes(t('uiGates.kUnconfirmedStale').split('{p1}')[0]?.trim() ?? ''),
    `C-24 的 detail 必须区分"内容已变"与"从未确认"：${gateRed?.detail}`,
  )

  // ④ 重新确认 → 恢复绿
  const reconfirm = await harness.callTool('sdo_design', { action: 'confirm', target, note: '用户原话：新版我也确认' })
  assert.equal(reconfirm.includes(t('uiDesign.uiConfirmInvalidatedHeader')), false, `重新确认后不应再列它为失效：\n${reconfirm}`)
  const recovered = office.designConfirmGaps(call())
  assert.deepEqual(recovered.missing, [])
  assert.deepEqual(recovered.stale, [])
  const gateGreenAgain = office.checkGate(call(), 'G3').criteria.find((item) => item.id === 'C-24')
  assert.equal(gateGreenAgain?.ok, true, `重新确认后应恢复通过：${gateGreenAgain?.detail}`)

  // ⑤ 契约同样受管：改 schema 后旧确认失效
  const contract = await harness.callTool('sdo_design', { action: 'contract', producer: 'api', consumer: 'web', schema: 'GET /a' })
  assert.ok(contract.includes('CT-001'))
  await harness.callTool('sdo_design', { action: 'confirm', target: 'CT-001', note: '用户确认' })
  assert.deepEqual(office.designConfirmGaps(call()).missing, [])
  await harness.callTool('sdo_design', { action: 'contract', id: 'CT-001', producer: 'api', consumer: 'web', schema: 'GET /b' })
  assert.deepEqual(office.designConfirmGaps(call()).stale.map((item) => item.target), ['CT-001'])
})

test('F-19：界面条目同样绑定内容（确认 → 改布局 → 失效 → 重确认 → 恢复）', async () => {
  baselineRequirement()
  const harness = toolHarness(workspace)
  await readyForDesign(harness)
  await harness.callTool('sdo_design', { action: 'create', kind: 'ui', ui: UI_VIEW('页头') })

  const checkUnconfirmed = office.uiView(call()).check
  assert.equal(checkUnconfirmed.ok, false)
  assert.deepEqual(checkUnconfirmed.stale, [])
  for (const target of ['ui:UI-001:style', 'SCR-001:columns', 'SCR-001:layout']) {
    await harness.callTool('sdo_design', { action: 'confirm', target, note: '用户确认' })
  }
  const checkGreen = office.uiView(call()).check
  assert.equal(checkGreen.ok, true, `三条界面条目确认后 C-27 应通过：${JSON.stringify(checkGreen)}`)

  // 只改布局：只有 :layout 那条失效，另外两条不受影响
  const rewrite = await harness.callTool('sdo_design', { action: 'create', kind: 'ui', ui: UI_VIEW('页头/清单/详情') })
  assert.ok(rewrite.includes('SCR-001:layout'), `界面重写回执必须点名失效的条目：\n${rewrite}`)
  const checkStale = office.uiView(call()).check
  assert.equal(checkStale.ok, false)
  assert.deepEqual(checkStale.stale, ['SCR-001:layout'])
  assert.deepEqual(checkStale.unconfirmed, ['SCR-001:layout'])
  const gateRed = office.checkGate(call(), 'G3').criteria.find((item) => item.id === 'C-27')
  assert.equal(gateRed?.ok, false)
  assert.ok(
    (gateRed?.detail ?? '').includes(t('uiGates.kUiMissingStale').split('{p1}')[0]?.trim() ?? ''),
    `C-27 的 detail 必须区分"内容已变"：${gateRed?.detail}`,
  )

  await harness.callTool('sdo_design', { action: 'confirm', target: 'SCR-001:layout', note: '用户确认新版布局' })
  const recovered = office.uiView(call()).check
  assert.equal(recovered.ok, true, `重新确认后 C-27 应恢复：${JSON.stringify(recovered)}`)
  assert.deepEqual(recovered.stale, [])
  // 写界面回执里也要给"还差哪些确认"的入口（原有行为不得被 F-19 的改动挤掉）
  assert.ok(rewrite.includes(t('uiDesign.confirmGapsHeader')) || rewrite.includes(t('uiDesign.uiWriteOk').replace('{p1}', '')), `界面写入回执仍要有确认入口：\n${rewrite}`)
})

test('F-19：旧确认戳（没有内容指纹）一律按"需重新确认"处理，不静默背书', async () => {
  const requirementId = baselineRequirement()
  const target = elementWithSource(requirementId)
  // 复刻旧构建写下的真源：只有 target/basis/by/at，没有 contentHash
  mkdirSync(join(workspace, '.sdo/design'), { recursive: true })
  writeFileSync(
    join(workspace, '.sdo/design/confirmed.yml'),
    ['confirmations:', `  - target: ${target}`, '    basis: 旧确认', '    by: human', '    at: 2026-01-01T00:00:00.000Z', ''].join('\n'),
  )
  const gaps = office.designConfirmGaps(call())
  assert.deepEqual(gaps.stale.map((item) => item.target), [target], '没有指纹的旧戳必须判失效')
  assert.equal(gaps.stale[0]?.confirmedHash, '')
  const gate = office.checkGate(call(), 'G3').criteria.find((item) => item.id === 'C-24')
  assert.equal(gate?.ok, false, '旧版确认戳不得让 C-24 直接通过')
  // 重新确认后指纹写上 → 通过
  office.confirmDesign(call(), target, '用户原话：重新确认', 'human')
  assert.deepEqual(office.designConfirmGaps(call()).missing, [])
  assert.equal(office.checkGate(call(), 'G3').criteria.find((item) => item.id === 'C-24')?.ok, true)
})

// —————————————————————— F-16：存量契约的方向矛盾只报不改 ——————————————————————

test('F-16：名字与字段矛盾的存量契约被检出（写明"哪边错推不出"），且**不被自动改写**', async () => {
  baselineRequirement()
  const harness = toolHarness(workspace)
  await readyForDesign(harness)
  // 组件视图：web 依赖 api（边 consumer=web、producer=api）
  await harness.callTool('sdo_design', { action: 'create', kind: 'component', name: 'api', responsibility: '接口' })
  await harness.callTool('sdo_design', { action: 'create', kind: 'component', name: 'web', responsibility: '前端', dependsOn: 'api' })

  // 当前构建的写入路径：name 永远等于 `producer → consumer`（D4-2）
  await harness.callTool('sdo_design', { action: 'contract', producer: 'api', consumer: 'web', schema: 'GET /x', timeout: '3s', retry: '2', idempotency: 'k' })
  assert.equal(contractDirectionAnomalies(office.storeFor(workspace)).length, 0, '按写入路径写的契约不应被判为矛盾')

  // 复刻旧构建的存量：name 是 `consumer → producer` 口径、字段方向正确
  writeFileSync(join(workspace, '.sdo/contracts/CT-001.yml'), [
    'contract:',
    '  id: CT-001',
    '  name: web → api',
    '  kind: http',
    '  producer: api',
    '  consumer: web',
    '  schema: GET /x',
    '  failureSemantics:',
    "    timeout: '3s'",
    "    retry: '2'",
    "    idempotency: 'k'",
    '  at: 2026-01-01T00:00:00.000Z',
    '',
  ].join('\n'))
  const anomalies = contractDirectionAnomalies(office.storeFor(workspace))
  assert.deepEqual(anomalies.map((item) => item.id), ['CT-001'])
  assert.equal(anomalies[0]?.expectedName, 'api → web')

  // 只读视图必须把矛盾摆出来（否则读 producer/consumer 做影响分析的人拿到反向关系却无提示）
  const view = await harness.callTool('sdo_design', { action: 'view' })
  assert.ok(view.includes(t('uiDesign.contractDirectionHeader')), `视图回执必须给出方向矛盾警示：\n${view}`)
  assert.ok(view.includes(t('uiDesign.contractDirectionHint')), '警示必须写明"名字与字段矛盾 = 两者之一错了"')
  // 门禁详情同样提示（不改判据通过与否）
  const gate = office.checkGate(call(), 'G4').criteria.find((item) => item.id === 'C-30')
  assert.ok((gate?.detail ?? '').includes(t('uiGates.kContractsDirectionAnomaly').split('{p1}')[0]?.trim() ?? ''), `门禁详情要提示方向矛盾：${gate?.detail}`)

  // **绝不自动对调**：真源里的字段与名字原样保留（报告 §6.6.1：自动判定会改错一半）
  const raw = readFileSync(join(workspace, '.sdo/contracts/CT-001.yml'), 'utf8')
  assert.match(raw, /name: web → api/u)
  assert.match(raw, /producer: api/u)
  assert.match(raw, /consumer: web/u)
})

// —————————————————————— F-20：手写 YAML 的类型（number / 对象）不得让覆盖判定崩溃 ——————————————————————

/**
 * F-20 夹具：一条依赖边（consumer=web、producer=api）+ 一份**手写**契约。
 *
 * 手写契约是关键：工具通道的入参一定是 string，所以这个缺陷**只能**从手改
 * `.sdo/contracts/*.yml` 进来（`retry: 2` 少一对引号即可）。
 */
async function f20Setup(harness: ToolHarness): Promise<void> {
  await harness.callTool('sdo_design', { action: 'create', kind: 'component', name: 'api', responsibility: '接口' })
  await harness.callTool('sdo_design', { action: 'create', kind: 'component', name: 'web', responsibility: '前端', dependsOn: 'api' })
  mkdirSync(join(workspace, '.sdo', 'contracts'), { recursive: true })
}

const CONTRACT_HEAD = [
  'contract:',
  '  id: CT-001',
  '  name: api → web',
  '  kind: http',
  '  producer: api',
  '  consumer: web',
  '  schema: GET /x',
  '  failureSemantics:',
  "    timeout: '3s'",
]
const CONTRACT_TAIL = ["    idempotency: 'key'", '  at: 2026-01-01T00:00:00.000Z', '']

function writeContractFile(body: string[]): void {
  writeFileSync(join(workspace, '.sdo/contracts', 'CT-001.yml'), [...CONTRACT_HEAD, ...body, ...CONTRACT_TAIL].join('\n'))
}

/** C-30（`design.contracts`）的门禁判据。 */
function c30(): { ok?: boolean; detail?: string } | undefined {
  return office.checkGate(call(), 'G4').criteria.find((item) => item.id === 'C-30')
}

test('F-20：手写 `retry: 2`（number）不再抛异常——按字符串 `2` 使用、**不判红**、回执点名该字段', async () => {
  baselineRequirement()
  const harness = toolHarness(workspace)
  await readyForDesign(harness)
  await f20Setup(harness)
  writeContractFile(['    retry: 2'])

  const store = office.storeFor(workspace)
  // ① 不崩：修复前这里是 TypeError: contract.failureSemantics.retry.trim is not a function
  let coverage: ReturnType<typeof contractCoverage> | undefined
  assert.doesNotThrow(() => { coverage = contractCoverage(store) }, '手写 number 不得让覆盖判定抛异常')
  // ② 不假红：值本身语义正确，只是 YAML 类型不同
  assert.equal(coverage?.ok, true, 'number 只是类型不同，不得因此判红')
  assert.deepEqual(coverage?.incompleteSemantics, [], '不得把 number 当成"失败语义缺失"')
  assert.equal(listContracts(store)[0]?.failureSemantics.retry, '2', '读取侧按字符串口径落地')
  assert.equal(c30()?.ok, true, 'C-30 不得因 number 判红')

  // ③ 不静默：提示要**点名**契约 / 字段 / 当前类型 / 建议写法
  const notes = contractFieldNotes(store)
  assert.deepEqual(
    notes,
    [{ contractId: 'CT-001', field: 'failureSemantics.retry', key: 'retry', actualType: 'number', text: '2', usable: true }],
    '类型提示必须精确点名契约与字段（多报/漏报都算静默）',
  )
  const expected = fmt('uiDescribe.contractFieldNoteTyped', { p1: 'CT-001', p2: 'failureSemantics.retry', p3: 'retry', p4: 'number', p5: '2' })

  // 只读视图（action=view）
  const view = await harness.callTool('sdo_design', { action: 'view' })
  assert.ok(view.includes(t('uiDescribe.contractFieldNoteHeader')), `视图回执必须给出类型提示标题：\n${view}`)
  assert.ok(view.includes(expected), `视图回执必须点名 CT-001 的 failureSemantics.retry（当前 number，建议 retry: '2'）：\n${view}`)

  // C-30 详情
  const detail = c30()?.detail ?? ''
  assert.ok(detail.includes(t('uiGates.kContractsFieldNote').split('{p1}')[0]?.trim() ?? ''), `C-30 详情要给出类型提示：${detail}`)
  assert.ok(detail.includes(expected), `C-30 详情必须点名该字段与建议写法：${detail}`)

  // 契约写入回执（写 CT-002；提示报的是**当前真源整体状态**，与 F-16 的方向清单同口径）
  const write = await harness.callTool('sdo_design', { action: 'contract', producer: 'api', consumer: 'web', schema: 'GET /y', timeout: '3s', retry: '2', idempotency: 'k' })
  assert.ok(write.includes(expected), `契约写入回执必须同样点名手改坏的字段：\n${write}`)
})

test('F-20 反向：字符串型 `retry: \'2\'` 不产生任何提示，行为与此前一致', async () => {
  baselineRequirement()
  const harness = toolHarness(workspace)
  await readyForDesign(harness)
  await f20Setup(harness)
  writeContractFile(["    retry: '2'"])

  const store = office.storeFor(workspace)
  const coverage = contractCoverage(store)
  assert.equal(coverage.ok, true)
  assert.deepEqual(coverage.incompleteSemantics, [])
  assert.equal(listContracts(store)[0]?.failureSemantics.retry, '2')
  // 类型正确 → 一条提示都不该有（有提示就是噪声/假提示）
  assert.deepEqual(contractFieldNotes(store), [], '字符串字段不得产生类型提示')

  const view = await harness.callTool('sdo_design', { action: 'view' })
  assert.ok(!view.includes(t('uiDescribe.contractFieldNoteHeader')), `无类型问题时不出现提示块：\n${view}`)
  const detail = c30()?.detail ?? ''
  assert.ok(!detail.includes(t('uiGates.kContractsFieldNote').split('{p1}')[0]?.trim() ?? ''), `无类型问题时 C-30 详情不出现提示：${detail}`)
})

test('F-20：手写 `retry: {a: 1}`（对象）给出**可读的失败**而不是崩溃', async () => {
  baselineRequirement()
  const harness = toolHarness(workspace)
  await readyForDesign(harness)
  await f20Setup(harness)
  writeContractFile(['    retry: {a: 1}'])

  const store = office.storeFor(workspace)
  let coverage: ReturnType<typeof contractCoverage> | undefined
  assert.doesNotThrow(() => { coverage = contractCoverage(store) }, '对象字段不得让覆盖判定抛异常')
  // 无法字符串化 → 该字段按空缺处理 → 判据判红，但这是**可读的失败**（不是崩）
  assert.equal(coverage?.ok, false, '对象无法字符串化 → 该字段按空缺处理，判据判红')
  assert.deepEqual(coverage?.incompleteSemantics, ['CT-001'], '判红必须点名契约 id')
  assert.equal(listContracts(store)[0]?.failureSemantics.retry, '', '不可字符串化的字段按空缺处理')

  const expected = fmt('uiDescribe.contractFieldNoteUnusable', { p1: 'CT-001', p2: 'failureSemantics.retry', p3: 'retry', p4: 'object' })
  assert.deepEqual(
    contractFieldNotes(store),
    [{ contractId: 'CT-001', field: 'failureSemantics.retry', key: 'retry', actualType: 'object', text: '', usable: false }],
  )
  const detail = c30()?.detail ?? ''
  assert.equal(c30()?.ok, false)
  assert.ok(detail.includes(expected), `C-30 详情要给出可读的失败与修正办法：${detail}`)
  const view = await harness.callTool('sdo_design', { action: 'view' })
  assert.ok(view.includes(expected), `视图回执要给出可读的失败与修正办法：\n${view}`)
})

test('F-20：`contract:` 主体不是映射（`contract: 123`）同样——跳过并报出，不崩', async () => {
  baselineRequirement()
  const harness = toolHarness(workspace)
  await readyForDesign(harness)
  await f20Setup(harness)
  writeFileSync(join(workspace, '.sdo/contracts', 'CT-001.yml'), 'contract: 123\n')

  const store = office.storeFor(workspace)
  let coverage: ReturnType<typeof contractCoverage> | undefined
  assert.doesNotThrow(() => { coverage = contractCoverage(store) }, '主体不是映射时不得抛异常')
  assert.deepEqual(listContracts(store), [], '读不成契约的文件被跳过（不是崩）')
  assert.equal(coverage?.ok, false, '跳过它 → 依赖边无契约覆盖 → 判红（可读的失败）')
  assert.equal(coverage?.missing.length, 1)

  assert.deepEqual(
    contractFieldNotes(store),
    [{ contractId: 'CT-001', field: 'contract', key: 'contract', actualType: 'number', text: '', usable: false }],
  )
  const expected = fmt('uiDescribe.contractFieldNoteBody', { p1: 'CT-001', p2: 'number' })
  const view = await harness.callTool('sdo_design', { action: 'view' })
  assert.ok(view.includes(expected), `视图回执必须报出"这份文件读不成契约"：\n${view}`)
  assert.ok((c30()?.detail ?? '').includes(expected), `C-30 详情必须报出：${c30()?.detail}`)
})

test('F-20 同类（结构假设）：手写 `dependsOn: api`（标量而非列表）不再让视图渲染崩，且这条边被保留', () => {
  // 修复前实测：TypeError: element.dependsOn.join is not a function（.verify/probe-f20-containers.mjs）
  office.init(call(), { name: 'M17 结构探针', scale: 'normal', stakeholders: ['业务方'] })
  mkdirSync(join(workspace, '.sdo', 'design'), { recursive: true })
  writeFileSync(join(workspace, '.sdo', 'design', 'component.yml'), [
    'view:',
    '  kind: component',
    '  elements:',
    '    - id: DES-001',
    '      name: api',
    '      kind: service',
    '      responsibility: 接口',
    '      dependsOn: api',
    '  summary: ""',
    '  updatedAt: 2026-01-01T00:00:00.000Z',
    '',
  ].join('\n'))

  const elements = office.views(call())[0]?.elements ?? []
  assert.deepEqual(elements.map((item) => item.dependsOn), [['api']], '标量按**单元素列表**保留（丢掉这条边就是静默改数据）')
  assert.doesNotThrow(() => describeDesign(office.views(call()), office.contracts(call()), []), '视图渲染不得因结构类型抛异常')
})
