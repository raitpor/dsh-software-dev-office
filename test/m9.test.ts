/**
 * 增量 2：设计阶段交互的**命令面**（`/sdo-design-*`）与「必须确认哪些条目」的缺口清单。
 *
 * 关键立场（否则测试会自欺）：
 *   · 命令不是第二套实现 —— 它们与模型工具 `sdo_design` 走**同一个依赖函数**。
 *     测试里两条入口都接同一份 `deps.design`（= `designInteraction`），因此可以
 *     **逐字节比对回执**，也可以逐项比对"交给依赖的参数"，而不是只断言"都返回了字符串"。
 *   · 「必须确认但尚未确认」是**双向**的：有一个未确认条目时清单非空；全部确认后清单为空；
 *     没有任何关键条目时同样为空（绝不凭空造 target）。
 *   · `--flag=value` 与 `--flag value` 两种写法都要能被解析（历史坑：只认等号 → 静默不生效）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { Config, resolveSettings } from '../src/config.js'
import { DESIGN_DOC_SECTIONS } from '../src/domain/design.js'
import { t } from '../src/domain/i18n.js'
import { link } from '../src/domain/trace.js'
import { createOfficeCommands } from '../src/interface/commands.js'
import type { OfficeCommandDeps } from '../src/interface/commands.js'
import { designInteraction } from '../src/interface/designReceipt.js'
import { createOfficeTools } from '../src/interface/tools.js'
import type { DesignArgs, OfficeToolDeps } from '../src/interface/tools.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { OfficeCall } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m9/', import.meta.url))
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
  office.init(call(), { name: 'M9 测试', scale: 'normal', stakeholders: ['业务方'] })
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

// —————————————————————— 与插件入口同构的测试脚手架 ——————————————————————

/** 真机 Agent 形状：工作目录只在 `session.header.cwd`（读错字段会导致"工作区未确定"）。 */
function agentOf(): unknown {
  return { id: 's1', session: { header: { cwd: workspace } } }
}

/**
 * 与 `src/index.ts` 的 `deps.design` 同构：命令与工具都走 `designInteraction`。
 * （`index.ts` 里的那份还带门禁分派，这里只取交互动作这一段，行为完全一致。）
 */
function deps(): { design(call: OfficeCall, args: DesignArgs): Promise<string> } {
  return {
    design: async (call, args) => designInteraction(office, call, args.action === '' ? 'view' : args.action, args),
  }
}

function invocationFor(rawInput: string): CommandInvocation {
  return {
    commandId: 'cmd-test',
    agent: agentOf(),
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  } as unknown as CommandInvocation
}

/** 取某条命令的 handler（走真实命令处理路径）。 */
function commandHandler(name: string): (invocation: CommandInvocation) => Promise<CommandResult> {
  const found = createOfficeCommands(deps() as unknown as OfficeCommandDeps, false).find((item) => item.name === name)
  assert.ok(found !== undefined, `命令面缺少 ${name}`)
  return async (invocation) => await found.handler(invocation)
}

async function commandText(name: string, rawInput: string): Promise<string> {
  const result = await commandHandler(name)(invocationFor(rawInput))
  assert.equal(result.kind, 'success', `${name} 应成功：${result.text}`)
  return result.text ?? ''
}

async function toolDesign(args: DesignArgs): Promise<string> {
  const tool = createOfficeTools(deps() as unknown as OfficeToolDeps).find((item) => item.name === 'sdo_design')
  assert.ok(tool !== undefined, '工具面缺少 sdo_design')
  return String(await tool.execute(args, { agent: agentOf() } as unknown as ToolRunContext))
}

/** 记录依赖：只观察"命令/工具把什么交给了同一个函数"。 */
function recordingDeps(seen: DesignArgs[]): { design(call: OfficeCall, args: DesignArgs): Promise<string> } {
  return {
    design: async (_call, args) => {
      seen.push(args)
      return 'stub'
    },
  }
}

/** 只保留"被真正设置"的语义字段（工具会把未给的键显式写成 undefined/false，命令是缺键）。 */
const SEMANTIC_KEYS = ['action', 'questionId', 'choice', 'note', 'target', 'state', 'method', 'rationale', 'round', 'by', 'assume'] as const
function semantics(args: DesignArgs): Record<string, unknown> {
  const bag = args as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of SEMANTIC_KEYS) {
    const value = bag[key]
    if (value === undefined || value === false || value === '') continue
    out[key] = value
  }
  return out
}

/** 造一条已基线需求（G2 通过）——grill 的设计问题由它的缺口推导出来。 */
function baselineRequirement(): string {
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
  office.redTeamAttack(call(), [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    if (open.length === 0) break
    office.answer(call(), { id: open[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  // D1 + D4：未决 P1 补风险处置，再签 G2 字（放行依据是签字台账）
  prepareG2(office, call())
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}

/** 补一张能通过 `design.views` 的五视图（元素**带需求来源**，形成 `confirm` 的关键条目）。 */
function fiveViews(requirementId: string): void {
  for (const [kind, name] of [
    ['context', '对账系统'],
    ['component', '差异检测服务'],
    ['runtime', '夜间批处理'],
    ['data', '对账差异表'],
    ['deployment', '单机部署'],
  ] as const) {
    // `requires` 必须在**写入时**给出：`designConfirmGaps` 只把"有需求来源"的元素算作关键条目
    //（事后 `link()` 只补追溯图，不会回填元素上的 requires）。
    office.upsertElement(call(), { kind, name, requires: [requirementId] })
  }
  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)
  for (const id of office.views(call()).flatMap((view) => view.elements.map((element) => element.id))) {
    link(store, journal, { from: requirementId, to: id, kind: 'req-des' })
  }
}

/**
 * 取 `docs/DESIGN.md` 的**待确认清单章节**——只在章节内断言，避免误命中别的元素/契约清单。
 *
 * 增量 2 在 §2 后插入了「设计方法」与「各方法产物」两章，待确认清单因此从 §7 顺延为 **§9**。
 */
function confirmSection(text: string): string {
  const start = text.indexOf('## 9. ')
  const end = text.indexOf('## 10. ')
  assert.ok(start >= 0 && end > start, 'DESIGN.md 必须有 §9（待确认清单）与 §10')
  return text.slice(start, end)
}

// —————————————————————— 命令面：命名 + 真实处理路径 ——————————————————————

test('M9-01 五个设计命令存在，且命名沿用既有的 `/sdo-<…>` 连字符风格', () => {
  const names = createOfficeCommands({} as unknown as OfficeCommandDeps, false).map((item) => item.name)
  for (const required of [
    'sdo-design-grill',
    'sdo-design-answer',
    'sdo-design-confirm',
    'sdo-design-issues',
    'sdo-design-render',
  ]) {
    assert.ok(names.includes(required), `缺命令 ${required}`)
  }
  // 冒号在宿主命令名里非法（D-01），因此只能是连字符风格
  for (const name of names) assert.match(name, /^[a-z][a-z0-9_-]*$/u, `命令名非法：${name}`)
})

test('M9-02 五个命令都走真实处理路径，并产出可用回执', async () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)

  // grill：真的建出问题，并给出草案 + 问题清单
  const grill = await commandText('sdo-design-grill', '--method=结构化 --rationale=需求已基线')
  assert.ok(grill.includes(t('uiDesign.uiDraftHeader')), 'grill 回执必须含设计草案')
  assert.ok(grill.includes(t('uiDesign.uiQuestionsHeader')), 'grill 回执必须含问题清单')
  const open = office.designIssues(call()).open
  assert.ok(open.length > 0, 'grill 命令必须真的建出设计问题')

  // answer：回答后该问题不再未决
  const answer = await commandText('sdo-design-answer', `--id=${open[0]!.id} --choice=0 --note=按推荐`)
  assert.ok(answer.includes(open[0]!.id), 'answer 回执必须点名被回答的问题')
  assert.equal(office.designIssues(call()).open.some((question) => question.id === open[0]!.id), false, '答复后不应再未决')

  // confirm：确认后不再出现在缺口里
  const target = office.designConfirmGaps(call()).missing[0]
  assert.ok(target !== undefined, '前置：必须有未确认的关键条目')
  const confirm = await commandText('sdo-design-confirm', `--target=${target} --note=用户确认`)
  assert.ok(confirm.includes(target), 'confirm 回执必须点名条目')
  assert.equal(office.designConfirmGaps(call()).missing.includes(target), false, '确认后不应再缺')

  // issues：非空回执
  assert.ok((await commandText('sdo-design-issues', '--state=open')).length > 0)

  // render：写出 docs/DESIGN.md 并回报路径
  const render = await commandText('sdo-design-render', '')
  assert.ok(render.includes('docs/DESIGN.md'), 'render 回执必须回报路径')
  assert.ok(existsSync(join(workspace, 'docs', 'DESIGN.md')), 'render 必须真的写出文档')
})

test('M9-03 命令与工具把**同一组参数**交给同一个依赖函数（逐项比对）', async () => {
  const cases: { command: string; raw: string; tool: DesignArgs }[] = [
    {
      command: 'sdo-design-grill',
      raw: '--method=结构化 --rationale=需求已基线 --round=2 --by=model',
      tool: { action: 'grill', method: '结构化', rationale: '需求已基线', round: 2, by: 'model' },
    },
    {
      command: 'sdo-design-answer',
      raw: '--id=Q-0001 --choice=0 --note=按推荐 --by=human',
      tool: { action: 'answer', questionId: 'Q-0001', choice: '0', note: '按推荐', by: 'human' },
    },
    {
      command: 'sdo-design-confirm',
      raw: '--target=DES-001 --note=用户确认 --by=human',
      tool: { action: 'confirm', target: 'DES-001', note: '用户确认', by: 'human' },
    },
    { command: 'sdo-design-issues', raw: '--state=all', tool: { action: 'issues', state: 'all' } },
    { command: 'sdo-design-render', raw: '', tool: { action: 'render' } },
  ]

  for (const item of cases) {
    const commandSeen: DesignArgs[] = []
    const byCommand = createOfficeCommands(recordingDeps(commandSeen) as unknown as OfficeCommandDeps, false)
      .find((command) => command.name === item.command)
    assert.ok(byCommand !== undefined, `缺命令 ${item.command}`)
    const result = await byCommand.handler(invocationFor(item.raw))
    assert.equal(result.kind, 'success', `${item.command} 应成功`)

    const toolSeen: DesignArgs[] = []
    const tool = createOfficeTools(recordingDeps(toolSeen) as unknown as OfficeToolDeps).find((item) => item.name === 'sdo_design')
    assert.ok(tool !== undefined)
    await tool.execute(item.tool, { agent: agentOf() } as unknown as ToolRunContext)

    assert.equal(commandSeen.length, 1, `${item.command} 必须调用依赖恰好一次`)
    assert.equal(toolSeen.length, 1)
    assert.deepEqual(
      semantics(commandSeen[0]!),
      semantics(toolSeen[0]!),
      `${item.command} 交给依赖的参数必须与工具动作一致`,
    )
  }
})

test('M9-04 同一动作：命令回执与工具回执**逐字节一致**（issues / confirm），且 state 过滤生效', async () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '稳定' } })
  const closedId = grilled.stillOpen[0]
  assert.ok(closedId !== undefined, '前置：grill 必须问出问题')
  office.answerDesign(call(), closedId, '0')

  const issuesOpen = await commandText('sdo-design-issues', '--state=open')
  assert.equal(issuesOpen, await toolDesign({ action: 'issues', state: 'open' }), '命令与工具的 issues(open) 必须逐字节一致')
  const issuesAll = await commandText('sdo-design-issues', '--state=all')
  assert.equal(issuesAll, await toolDesign({ action: 'issues', state: 'all' }), '命令与工具的 issues(all) 必须逐字节一致')
  assert.equal(issuesOpen.includes(closedId), false, '--state=open 不得列出已答复的问题')
  assert.equal(issuesAll.includes(closedId), true, '--state=all 必须列出已答复的问题')

  const target = office.designConfirmGaps(call()).missing[0]
  assert.ok(target !== undefined)
  const byCommand = await commandText('sdo-design-confirm', `--target=${target} --note=用户确认`)
  assert.equal(byCommand, await toolDesign({ action: 'confirm', target, note: '用户确认' }), '命令与工具的 confirm 必须逐字节一致')

  // render：命令与工具报告同一个产物路径（字节数会随 journal 序号变化，故只比对路径）
  assert.ok((await commandText('sdo-design-render', '')).includes('docs/DESIGN.md'))
  assert.ok((await toolDesign({ action: 'render' })).includes('docs/DESIGN.md'))
})

test('M9-05 `--flag=value` 与 `--flag value` 两种写法都解析（双向各测一次）', async () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '稳定' } })
  const closedId = grilled.stillOpen[0]
  assert.ok(closedId !== undefined)
  office.answerDesign(call(), closedId, '0')

  // 取值选项：等号 / 空格
  const equals = await commandText('sdo-design-issues', '--state=all')
  const space = await commandText('sdo-design-issues', '--state all')
  assert.equal(space, equals, 'space 与 equals 写法必须得到同一份回执（issues 是只读动作）')
  assert.ok(space.includes(closedId), '`--state all` 必须真的生效（列出已答复）')

  // 取值选项（写状态）：等号 / 空格
  const missing = office.designConfirmGaps(call()).missing
  const first = missing[0]
  const second = missing[1]
  assert.ok(first !== undefined && second !== undefined)
  assert.ok((await commandText('sdo-design-confirm', `--target=${first} --note=等号写法`)).includes(first))
  assert.ok((await commandText('sdo-design-confirm', `--target ${second} --note 空格写法`)).includes(second))
  assert.equal(office.designConfirmGaps(call()).missing.includes(first), false, '等号写法的确认必须落盘')
  assert.equal(office.designConfirmGaps(call()).missing.includes(second), false, '空格写法的确认必须落盘')

  // answer：等号 / 空格
  const openIds = office.designIssues(call()).open.map((question) => question.id)
  assert.ok(openIds.length >= 2, '前置：至少两个未决问题')
  assert.ok((await commandText('sdo-design-answer', `--id=${openIds[0]} --choice=0`)).includes(openIds[0]!))
  assert.ok((await commandText('sdo-design-answer', `--id ${openIds[1]} --choice 0`)).includes(openIds[1]!))

  // grill：方法推荐参数也能用空格写法
  assert.ok((await commandText('sdo-design-grill', '--method 结构化 --rationale 需求已基线')).includes(t('uiDesign.uiQuestionsHeader')))
})

test('M9-06 `--choice` 缺省：回执可读，且**不得**把问题悄悄记为已答（命令与工具同一句错误）', async () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '稳定' } })
  const id = grilled.stillOpen[0]
  assert.ok(id !== undefined)

  const result = await commandHandler('sdo-design-answer')(invocationFor(`--id=${id}`))
  assert.equal(result.kind, 'success')
  assert.equal(result.text, t('uiDesign.uiAnswerNeedChoice'), '缺 choice 必须给语言包里的可读错误')
  assert.notEqual(result.text, 'uiAnswerNeedChoice', '回执必须是真文案，不是键名')
  assert.equal(await toolDesign({ action: 'answer', questionId: id }), result.text, '命令与工具必须给出同一句错误')
  assert.equal(office.designIssues(call()).open.some((question) => question.id === id), true, '缺 choice 时问题必须仍未决')

  // **反例方向**：收紧不得拦错 —— `--assume`（用户明确授权按建议办）是合法路径，不需要 choice
  const assumed = await commandText('sdo-design-answer', `--id ${id} --assume`)
  assert.equal(assumed.includes(t('uiDesign.uiAnswerNeedChoice')), false, '--assume 不得被 choice 校验误拦')
  assert.ok(assumed.includes(id), '--assume 必须真的记录到该问题')
  assert.equal(office.designIssues(call()).open.some((question) => question.id === id), false, 'assume 后该问题不再未决')
})

// —————————————————————— 「必须确认哪些条目」的缺口清单（双向） ——————————————————————

test('M9-07 issues 返回体列出「必须确认但尚未确认」的 target（有一个时非空、全部确认后为空）', async () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  const component = office.views(call()).find((view) => view.kind === 'component')?.elements[0]
  assert.ok(component !== undefined)
  office.recordContract(call(), {
    name: '对账系统 → 差异检测服务',
    producer: '对账系统',
    consumer: component.name,
    schema: '{"差异id":"string"}',
    kind: 'schema',
    failureSemantics: { timeout: '3s', retry: '3 次退避', idempotency: '按差异 id 幂等' },
  })

  const gaps = office.designConfirmGaps(call())
  assert.ok(gaps.missing.length >= 2, '前置：必须有未确认的关键条目')

  // 注意：这里**故意不调用 grill** —— 问题账本为空时，旧实现会提前 return，
  // 把"必须确认哪些条目"整段吞掉（这正是本测试要挡住的 UX 缺口）。
  const before = await commandText('sdo-design-issues', '--state=open')
  assert.ok(before.includes(t('uiDesign.uiNoQuestions')), '前置：此时没有未决问题（问题账本为空）')
  assert.ok(before.includes(t('uiDesign.confirmGapsHeader')), '要确认的条目清单必须出现在 issues 返回体里')
  for (const target of gaps.missing) assert.ok(before.includes(target), `清单缺 ${target}`)
  assert.ok(before.includes(t('uiDesign.confirmKindElement')), '每项必须带含义（设计元素）')
  assert.ok(before.includes(t('uiDesign.confirmKindContract')), '每项必须带含义（契约）')

  for (const target of gaps.required) office.confirmDesign(call(), target, '用户在会话中确认', '张三')
  assert.deepEqual(office.designConfirmGaps(call()).missing, [])

  const after = await commandText('sdo-design-issues', '--state=open')
  assert.equal(after.includes(t('uiDesign.confirmGapsHeader')), false, '全部确认后确认清单必须为空')
  for (const target of gaps.required) assert.equal(after.includes(target), false, `清单不得再出现 ${target}`)
})

test('M9-08 DESIGN.md 的待确认章节列出同一批 target（全部确认后为空）', async () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  const gaps = office.designConfirmGaps(call())
  assert.ok(gaps.missing.length > 0)

  await commandText('sdo-design-render', '')
  const doc = readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8')
  for (const key of DESIGN_DOC_SECTIONS) assert.ok(doc.includes(t(key)), `DESIGN.md 缺章节 ${key}`)
  const before = confirmSection(doc)
  assert.ok(before.includes(t('uiDesign.docUnconfirmedTargets')), '§9 必须有待确认清单')
  for (const target of gaps.missing) assert.ok(before.includes(target), `§9 缺 ${target}`)
  assert.ok(before.includes(t('uiDesign.confirmKindElement')), '§9 的每项也要带含义')

  for (const target of gaps.required) office.confirmDesign(call(), target, '用户在会话中确认', '张三')
  await commandText('sdo-design-render', '')
  const after = confirmSection(readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8'))
  assert.equal(after.includes(t('uiDesign.docUnconfirmedTargets')), false, '全部确认后 §9 不得再有待确认清单')
  for (const target of gaps.required) assert.equal(after.includes(target), false, `§9 不得再出现 ${target}`)
})

test('M9-08b 没有任何关键条目时两处清单都为空（不凭空造 target）', async () => {
  baselineRequirement()
  assert.deepEqual(office.designConfirmGaps(call()).required, [], '前置：本项目没有任何关键条目')

  const issues = await commandText('sdo-design-issues', '--state=open')
  assert.equal(issues.includes(t('uiDesign.confirmGapsHeader')), false, '没有关键条目时不得出现确认清单')
  await commandText('sdo-design-render', '')
  const doc = confirmSection(readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8'))
  assert.equal(doc.includes(t('uiDesign.docUnconfirmedTargets')), false, '没有关键条目时 §9 不得出现待确认清单')
})

// —————————————————————— 顺序守卫：命令依赖的五个动作必须在门禁之前 ——————————————————————

test('M9-09 五个交互动作必须在 designPrecondition **之前**分派（否则 plan-mode 会把命令拦住）', () => {
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const dispatch = source.indexOf("action === 'grill'")
  const precondition = source.indexOf('office.designPrecondition')
  assert.ok(dispatch >= 0, '找不到五个交互动作的分派')
  assert.ok(precondition >= 0, '找不到 designPrecondition')
  assert.ok(dispatch < precondition, '交互动作必须早于门禁分派（顺序一旦破坏，命令与工具都会被 plan-mode 阻塞）')
  for (const action of ['grill', 'answer', 'issues', 'confirm', 'render']) {
    assert.ok(source.includes(`action === '${action}'`), `分派条件缺 ${action}`)
  }
})
