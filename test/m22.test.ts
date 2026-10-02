/**
 * 增量 22：**缺陷复审报告（第二轮修复验证）P-1…P-18 的回归**。
 *
 * 报告来源：`sdo-test/docs/2026-10-02-插件缺陷复审报告（第二轮修复验证）.md` §5。
 * 每条都**先复现那次绕过/缺陷**，再断言现在被拦或被如实说出；能双向的都给了正例。
 *
 *   P-1  重渲染缓存的失效（改真源后不得命中旧渲染）
 *   P-3  验收矩阵必须引用真实存在、且属于该需求的 AC（在 m4 的双向用例里）
 *   P-5  存量 AC 重号必须被 G2 的 C9 查出并点名
 *   P-6  "未决"口径统一（未授权假设在派生视图与 grill 里也算未决）
 *   P-7  `/sdo-gate --channel=<非法>` 必须报错，不得静默降级
 *   P-8  `tests.passed` 与追溯判据共用坏行前置检查（源码级钉子，完整夹具成本过高）
 *   P-10 `change.ts` 与 `trace.ts` 用同一份解析器（缺 `kind` 的行必须算坏行）
 *   P-11 手写真源写坏时判据判红，而不是让整条门禁（连同注入状态块）抛异常
 *   P-12 改了内容的已冻结需求必须退回 `changed`，重新基线要刷新冻结事实
 *   P-13 签字失效理由列前 3 条并标注未分类事件
 *   P-14 渲染头声称的序号上必须真的发生过 `design/rendered`
 *   P-15 整份文件绑定：头部注释区也进比对；未知语言要报"头在撒谎"
 *   P-16 红队/议题/质量场景不算真源变更（在 m20 的口径用例里）
 *   P-17 回退删 `gates/*.json` 之前必须把判据明细写进 `phase/rolled-back`
 *   P-18 命令面文档（README 与双语命令描述）必须写出签字参数
 *
 * 纪律：断言只读**真源**（`.sdo/` 下的 yml / jsonl / 门禁判据 / 派生文档 / 语言包），不采信自述。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { renderSrs } from '../src/infra/render.js'
import { openQuestionsFor } from '../src/domain/grill.js'
import { readTraceLinksChecked } from '../src/domain/change.js'
import { createOfficeCommands } from '../src/interface/commands.js'
import type { OfficeCommandDeps } from '../src/interface/commands.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { GateCriterionResult, GrillQuestion } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m22/', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DIMS = { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }
const call = (): { sessionId: string } => ({ sessionId: 's1' })

let workspace: string
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M22 测试', scale: 'normal', stakeholders: ['业务方'] })
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

/** 一条已基线需求（G2 通过、阶段在 architecture）。 */
function baselined(): string {
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
    modelDimensions: DIMS,
  })
  office.askDesignQuestions(call(), { recommendation: { method: '结构化', rationale: '需求稳定' } })
  office.redTeamAttack(call(), [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const pending = office.questions(call()).filter((q) => q.status === 'open' && !q.targets.includes('design:method'))
    if (pending.length === 0) break
    office.answer(call(), { id: pending[0]!.id, answer: '已确认', modelDimensions: DIMS })
  }
  prepareG2(office, call())
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `前置：基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}

const docPath = (): string => join(workspace, 'docs', 'DESIGN.md')
const readDoc = (): string => readFileSync(docPath(), 'utf8')
const writeDoc = (text: string): void => writeFileSync(docPath(), text, 'utf8')

function criterion(criteria: GateCriterionResult[], id: string): GateCriterionResult {
  const found = criteria.find((item) => item.id === id)
  assert.ok(found !== undefined, `门禁里必须有判据 ${id}`)
  return found
}

const c25 = (): GateCriterionResult => criterion(office.evaluate(call(), 'G3').criteria, 'C-25')

const journalEvents = (): { type: string; seq: number; data: Record<string, unknown> }[] =>
  office.journalFor(workspace).read().events

// —————————————————————— P-1：缓存必须随真源失效 ——————————————————————

test('P-1：渲染缓存不得把"改过真源"判成绿（第二次判定的结果必须反映新真源）', () => {
  const id = baselined()
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单', requires: [id] })
  office.renderDesign(call())
  assert.equal(c25().ok, true, '前置：刚渲染时绿')

  // 改真源（会推进 seq）→ 第二次判定必须重新渲染、判红，而不是命中上一次的缓存
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '支付服务', responsibility: '处理支付', requires: [id] })
  assert.equal(c25().ok, false, '改了真源之后必须判红（缓存键含 journal 指纹，不会命中旧渲染）')
  office.renderDesign(call())
  assert.equal(c25().ok, true, '重渲染后转绿')
})

// —————————————————————— P-5：存量 AC 重号 ——————————————————————

test('P-5：存量 AC 重号必须被 G2 的 C9 点名（N-2 只堵了以后写不进来）', () => {
  baselined()
  // 手写真源制造重号（`capture`/`update` 已经拒绝重号，所以这里直接改文件——存量重号就是这个形态）
  const dir = join(workspace, '.sdo', 'requirements')
  const second = join(dir, 'REQ-002.yml')
  writeFileSync(second, [
    'requirement:',
    '  id: REQ-002',
    '  title: 手写第二条',
    '  kind: functional',
    '  statement: 系统须在每日对账后生成差异报表；单日 100 万，P99 < 500 毫秒',
    '  priority: must',
    '  status: draft',
    '  version: 0.1',
    '  baseline: null',
    '  createdAt: 2026-10-02T00:00:00.000Z',
    '  updatedAt: 2026-10-02T00:00:00.000Z',
    '  acceptance:',
    '    - id: AC-001',   // ← 与 REQ-001 撞号
    '      given: g',
    '      when: w',
    '      then: t',
    '  ambiguity:',
    '    score: 16',
    '    dimensions: {}',
    '    open: []',
  ].join('\n'), 'utf8')

  const c9 = criterion(office.evaluate(call(), 'G2').criteria, 'C9-ac-ids-unique')
  assert.equal(c9.ok, false, '存量重号必须判红')
  assert.match(c9.detail, /AC-001/u, `必须点名重号：${c9.detail}`)
  assert.match(c9.detail, /REQ-001/u, `必须点名归属：${c9.detail}`)
  assert.match(c9.detail, /REQ-002/u, `必须点名归属：${c9.detail}`)
})

// —————————————————————— P-6：未决口径 ——————————————————————

test('P-6：未获授权的假设在派生视图与 grill 的过滤里都算未决（口径与门禁同源）', () => {
  const id = baselined()
  // 把一条质询问题手改成未授权 `assumed`（模型自授/手写 YAML 的形态）
  const question = office.questions(call()).find((q) => q.origin === 'red-team' && q.targets.includes(id))
  assert.ok(question !== undefined, '前置：红队质询问题存在')
  const store = office.storeFor(workspace)
  const raw = store.readYaml<{ question: Record<string, unknown> }>('questions', `${question.id}.yml`)
  assert.ok(raw !== undefined)
  raw.question['status'] = 'assumed'
  delete raw.question['authorizedByUser']
  store.writeYaml(['questions', `${question.id}.yml`], raw)

  const downgraded = office.questions(call()).find((q) => q.id === question.id)
  assert.equal(downgraded?.status, 'assumed', '前置：已改成未授权假设')

  // ① grill 的"未决问题"过滤（问过没）：必须仍视为未决，否则不会再问
  assert.ok(
    openQuestionsFor(store, id).some((q) => q.id === question.id),
    '未授权假设必须仍被 grill 视为未决',
  )
  // ② SRS 的计数与开环问题列表：与门禁同源
  const srs = renderSrs({ project: office.status(call()).project, requirements: office.requirements(call()), questions: office.questions(call()), seq: 1 })
  const expectedOpen = office.questions(call()).filter((q: GrillQuestion) => q.status === 'assumed' && q.authorizedByUser !== true).length
  assert.ok(expectedOpen >= 1, '前置：至少一条未授权假设')
  const countLine = srs.split('\n').find((line) => line.includes('未决问题')) ?? ''
  assert.ok(
    Number(/(\d+) 条/u.exec(countLine)?.[1] ?? '0') >= 1,
    `SRS 的未决计数必须把它算进去（旧实现不算）：${countLine}`,
  )
})

// —————————————————————— P-7：非法 --channel ——————————————————————

test('P-7：`/sdo-gate --channel=<非法>` 必须报可读错误，不得静默降级成 statement', async () => {
  const seen: Record<string, unknown>[] = []
  const commands = createOfficeCommands({
    gate: async (_call: unknown, args: Record<string, unknown>) => {
      seen.push(args)
      return 'stub'
    },
  } as unknown as OfficeCommandDeps, false)
  const gate = commands.find((item) => item.name === 'sdo-gate')
  assert.ok(gate !== undefined)
  const invocation = {
    commandId: 'cmd-test',
    agent: { id: 's1', session: { header: { cwd: workspace } } },
    rawInput: '--sign --gate=G2 --quote="我确认" --channel=wechat',
    attachments: [],
    signal: new AbortController().signal,
  }
  const result = await gate.handler(invocation as never)
  assert.equal(result.kind, 'error', `非法通道必须报错：${JSON.stringify(result)}`)
  assert.match(result.text ?? '', /channel|statement|question/u, `错误要说明可用取值：${result.text}`)
  assert.deepEqual(seen, [], '非法通道不得落到处理器（更不得静默降级）')
})

// —————————————————————— P-8：同族判据的坏行检查 ——————————————————————

test('P-8：`tests.passed` 与追溯判据共用坏行前置检查（源码级钉子）', () => {
  const text = readFileSync(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8')
  assert.match(text, /function traceBadLinesFailure/u, '坏行检查必须是**一处**实现')
  for (const id of ['trace.orphans', 'trace.coverage', 'tests.passed']) {
    assert.match(
      text,
      new RegExp(`traceBadLinesFailure\\(ctx, '${id}'\\)`, 'u'),
      `${id} 必须调用同一处坏行检查（同族两套口径会留缝）`,
    )
  }
})

// —————————————————————— P-10：一份解析器 ——————————————————————

test('P-10：缺 `kind` 的追溯行在两处都算坏行（change.ts 不再自己抄一份）', () => {
  const id = baselined()
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单', requires: [id] })
  // 一行"缺 kind"的边：旧实现里 change.ts 当**正常边**计入，trace.ts 算坏行
  office.storeFor(workspace).appendLine(['trace', 'links.jsonl'], JSON.stringify({ from: id, to: 'DES-001' }))
  const checked = readTraceLinksChecked(office.storeFor(workspace))
  assert.equal(checked.badLines, 1, '缺 kind 的行必须算坏行（两处口径一致）')
  assert.equal(checked.links.some((link) => link.to === 'DES-001'), false, '坏行不得被当成正常边计入影响面')
})

// —————————————————————— P-11：坏 YAML 不得让门禁抛异常 ——————————————————————

test('P-11：手写真源写坏时判据判红（不抛异常），注入路径也不能一起失败', () => {
  const id = baselined()
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单', requires: [id] })
  office.renderDesign(call())
  // 复现：把组件视图的 YAML 缩进写坏（手改真源是插件明确支持的方式）
  const viewPath = join(workspace, '.sdo', 'design', 'component.yml')
  const original = readFileSync(viewPath, 'utf8')
  // `Tab` 缩进是 YAML 子集**明确拒绝**的写法（真机手改最常见的破坏形态）
  writeFileSync(viewPath, original.split('\n').map((line, index) => (index === 1 ? `\t${line}` : line)).join('\n'), 'utf8')

  let evaluation: ReturnType<SoftwareDevOffice['evaluate']> | undefined
  assert.doesNotThrow(() => {
    evaluation = office.evaluate(call(), 'G3')
  }, '判据检查器抛异常不得冒泡出去（否则整条门禁"说不出话"）')
  assert.equal(evaluation?.status, 'failed', '坏真源必须表现为"判红"')
  const broken = evaluation?.criteria.find((item) => !item.ok && item.detail.includes('异常'))
  assert.ok(broken !== undefined, `判红的判据必须写明是检查器抛异常：${evaluation?.criteria.filter((c) => !c.ok).map((c) => `${c.id}:${c.detail}`).join(' | ')}`)

  // 注入路径同一条现算链：`status()` 也不能抛（否则模型每轮拿不到门禁状态）
  assert.doesNotThrow(() => office.status(call()), '状态块（注入）不得因坏真源一起失败')
  writeFileSync(viewPath, original, 'utf8')
  assert.equal(c25().ok, true, '修好真源后必须能恢复判绿')
})

// —————————————————————— P-12：改了内容必须退出"已冻结" ——————————————————————

test('P-12：改了内容的已冻结需求退回 changed，重新基线必须刷新冻结事实', () => {
  const id = baselined()
  const before = office.requirements(call()).find((item) => item.id === id)
  assert.ok(before?.baseline !== undefined, '前置：已基线（有冻结事实）')
  const firstBaselineAt = before?.baseline?.at

  // 复现：用 `update` 改内容（旧实现不碰 status → 仍是 baselined）
  office.update(call(), { id, patch: { statement: '系统须在每日对账后识别差异；单日 200 万，P99 < 300 毫秒' } })
  const changed = office.requirements(call()).find((item) => item.id === id)
  assert.equal(changed?.status, 'changed', '内容变更后必须退出 baselined（否则重新基线会整条跳过）')

  // 内容变更会写 `requirement/updated` → G2 签字失效（这是**正确**的口径）→ 按流程重签后再基线
  prepareG2(office, call())
  // 冻结事实必须被刷新（而不是停在旧内容版本上）
  const again = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(again.ok, true, `重新基线应通过：${again.dor.failed.join(',')}`)
  assert.deepEqual(again.baselined.map((item) => item.id), [id], '改了内容的需求必须被重新冻结')
  const after = office.requirements(call()).find((item) => item.id === id)
  assert.notEqual(after?.baseline?.at, firstBaselineAt, '冻结时间必须刷新到本次')
  assert.ok(
    journalEvents().filter((event) => event.type === 'requirement/baselined').length >= 2,
    '必须留下本次的 requirement/baselined 事件',
  )

  // 双向：内容未改的第二次基线不得再冻结（N-14 的语义保持不变）
  const noop = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(noop.ok, true)
  assert.deepEqual(noop.baselined, [], '内容未改 → 不重新冻结')
})

// —————————————————————— P-13：失效理由 ——————————————————————

test('P-13：签字失效理由列前 3 条，并标注"未分类事件按保守口径处理"', () => {
  baselined()
  office.renderDesign(call())
  office.signGate(call(), { gate: 'G3', by: '张三', basis: '我确认这次设计可以放行', channel: 'command' })
  assert.equal(office.signatureState(call(), 'G3').status, 'valid', '前置：签字有效')

  // 追加 5 条会让签字失效的真源写入（含一条**尚未分类**的事件类型）
  const journal = office.journalFor(workspace)
  for (const type of ['adr/recorded', 'contract/recorded', 'trace/linked', 'design/updated']) {
    journal.append(type as never, { note: '复核用' })
  }
  journal.append('future/unclassified-write' as never, { note: '未分类' })

  const state = office.signatureState(call(), 'G3')
  assert.equal(state.status, 'stale')
  assert.match(state.reason, /共 5 条/u, `必须说明总条数：${state.reason}`)
  assert.match(state.reason, /未分类/u, `必须标注未分类事件按保守口径处理：${state.reason}`)
  assert.match(state.reason, /future\/unclassified-write/u, `必须点名那条未分类事件：${state.reason}`)
})

// —————————————————————— P-14：渲染动作可证 ——————————————————————

test('P-14：头里的序号上必须真的发生过 design/rendered（只改头+正文自述行不得判绿）', () => {
  const id = baselined()
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单', requires: [id] })
  office.renderDesign(call())
  const doc = readDoc()
  const seq = Number(/journal seq (\d+)/u.exec(doc)?.[1])
  assert.ok(Number.isFinite(seq), '前置：头里有序号')

  // 追加一条**中性**事件（不改正文、也不是渲染事件）→ 它的 seq 上没有 design/rendered
  const appended = office.journalFor(workspace).append('gate/result', { gate: 'G0', status: 'passed' })
  const forged = doc
    .replace(`journal seq ${seq}`, `journal seq ${appended.seq}`)
    .replace(new RegExp(`(生成时的真源事件序号[^：]*：)${seq}`, 'u'), `$1${appended.seq}`)
  assert.notEqual(forged, doc, '前置：头与正文自述行都改成了新序号（正文其余一字未动）')
  writeDoc(forged)

  const locked = c25()
  assert.equal(locked.ok, false, '头声称的序号上没有渲染事件 → 必须判红')
  assert.match(locked.detail, /design\/rendered|渲染/u, `理由必须点明"渲染不可证"：${locked.detail}`)
})

// —————————————————————— P-15：整份文件绑定 ——————————————————————

test('P-15：头部注释区也进比对（插一行"已人工核对"不得判绿）；未知语言报"头在撒谎"', () => {
  const id = baselined()
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单', requires: [id] })
  office.renderDesign(call())
  const doc = readDoc()
  assert.equal(c25().ok, true, '前置：刚渲染时绿')

  // 复现：在**头部注释区**插一行"已人工核对"（正文一字不动）—— 旧实现剥掉头部再比 → 判绿
  const firstLineEnd = doc.indexOf('\n') + 1
  writeDoc(`${doc.slice(0, firstLineEnd)}<!-- 已人工核对：本文件与真源一致，由 reviewer 复核通过 -->\n${doc.slice(firstLineEnd)}`)
  const head = c25()
  assert.equal(head.ok, false, '头部注释区被写入必须判红（它也是文档的一部分）')
  assert.match(head.detail, /重渲染|脱钩/u, `理由要说明与真源重渲染不一致：${head.detail}`)

  // 未知语言：头声明了随包语言之外的语言 → 必须报"头在撒谎"，而不是"缺章节"
  const bogus = doc.replace(/<!-- meta: lang [A-Za-z-]+/u, '<!-- meta: lang zh-CN-unknown')
  writeDoc(bogus)
  const unknown = c25()
  assert.equal(unknown.ok, false)
  assert.match(unknown.detail, /语言|撒谎/u, `必须点明是语言声明的问题：${unknown.detail}`)

  // 双向：重新渲染 → 转绿
  office.renderDesign(call())
  assert.equal(c25().ok, true, '重渲染后必须转绿')
})

// —————————————————————— P-17：回退留痕带上判据明细 ——————————————————————

test('P-17：回退删 gates/*.json 之前，必须把判据明细写进 phase/rolled-back', () => {
  baselined()
  // 先造一份"有判据明细"的 G3 留痕（renderDesign 之后 check 一次即可）
  office.renderDesign(call())
  office.checkGate(call(), 'G3')
  const result = office.rollbackPhase(call(), { to: 'requirements', reason: '发现需求缺口' })
  assert.equal(result.ok, true, `合法回退应当成功：${result.error ?? ''}`)

  const event = journalEvents().filter((item) => item.type === 'phase/rolled-back').at(-1)
  assert.ok(event !== undefined, '必须有回退事件')
  const details = event.data['invalidatedDetails']
  assert.ok(Array.isArray(details) && details.length > 0, `必须留下判据明细：${JSON.stringify(event.data).slice(0, 200)}`)
  const g3 = (details as { gate: string; criteria: { id: string; detail: string }[] }[]).find((item) => item.gate === 'G3')
  assert.ok(g3 !== undefined, 'G3 的明细必须在里面（它的 json 已被删除）')
  assert.ok(g3.criteria.length > 0, '每条判据的 id/detail 都要在（否则"为什么不过"永远查不到）')
  assert.ok(g3.criteria.some((item) => item.detail.trim() !== ''), '判据明细必须带 detail')
  // 留痕文件确实被删了 —— 明细只存在于 journal（这正是 P-17 要补的可审计性）
  let removed = false
  try {
    readFileSync(join(workspace, '.sdo', 'gates', 'G3.json'), 'utf8')
  } catch {
    removed = true
  }
  assert.equal(removed, true, 'G3 的判定留痕必须已被作废（明细只在 journal 里）')
})

// —————————————————————— P-18：命令面文档 ——————————————————————

test('P-18：README 与双语命令描述必须写出 `--sign/--quote`（照文档用命令的人要能发现它）', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const row = readme.split('\n').find((line) => line.startsWith('| `/sdo-gate`')) ?? ''
  for (const token of ['--sign', '--quote', '--rollback', '--waive']) {
    assert.ok(row.includes(token), `README 的 /sdo-gate 行必须含 ${token}：${row}`)
  }
  for (const file of ['zh-CN.yml', 'en.yml']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'lang', file), 'utf8')
    const line = text.split('\n').find((item) => item.startsWith('  sdo-gate:')) ?? ''
    for (const token of ['--sign', '--quote', '--rollback', '--waive']) {
      assert.ok(line.includes(token), `${file} 的 command.sdo-gate 必须含 ${token}：${line}`)
    }
  }
})
