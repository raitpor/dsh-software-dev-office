/**
 * M93：**缺陷追溯判据 —— 孤儿缺陷拦 G5（含显式豁免通道）**（TASK-038 / REQ-058 / 判据 `C-58`）。
 *
 * 缺陷原文（DEF-022）："缺陷没有强制挂需求：`req-defect` 边可用但无判据拦截，孤儿缺陷只可见不可拦"。
 * 本文件守的就是"只可见"变成"可见且可拦"这**一件事**，按用例计划 TC-060 的六种情形逐条两态：
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | 未绑定、未豁免 | 判红并**逐条点名**缺陷 id |
 * | ② | 绑定到**已基线**需求 | 绿（不因它判红） |
 * | ③ | 绑定到未基线 / 已作废需求 | 判红并点名**失效目标** id（"有边"≠"有效"） |
 * | ④ | 带合规豁免（理由 + 批准人） | 不计孤儿，但回执**单列豁免清单** |
 * | ⑤ | 豁免缺理由或缺批准人 | 按未豁免处理并点名 |
 * | ⑥ | 台账读不动 | 判红（fail-closed，判不动不许判绿） |
 * | ⑦ | 判红 | 回执给出**可执行修法**（补哪条边 / 走哪条豁免） |
 * | ⑧ | 读数同源 | 回执 / `TRACE.md` / `BOARD.md` 三处**同一现算口径** |
 *
 * 两态用**同一套夹具**：每条用例先断言红态（在盘上留下未修的内容 → 判红并点名），再改盘、断言绿态。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { loadProcess } from '../src/domain/process.js'
import { evaluateGate } from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import { link, readDefectLinksOf, renderTraceReport, report as traceReport } from '../src/domain/trace.js'
import { renderBoard } from '../src/board/render.js'
import type { BoardModel } from '../src/board/render.js'
import { describeGate } from '../src/interface/describe.js'
import { renderHeader } from '../src/infra/render.js'
import type { GateEvaluation, Requirement, TraceReport } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm93')
/** 被测判据在两处流程数据里的 check 键（四处声明指的是同一个检查器）。 */
const CHECK = 'trace.defect-links'
const CRITERION = 'C-58'

let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 一条需求（只要判据读得到的那几位：id / status）。 */
function requirementOf(id: string, status: Requirement['status']): Requirement {
  return {
    id,
    title: `需求 ${id}`,
    kind: 'functional',
    statement: '示例',
    rationale: '',
    source: {},
    priority: 'must',
    ambiguity: { score: 0, dimensions: {}, open: [] },
    acceptance: [],
    status,
    version: 1,
    baseline: status === 'baselined' ? { at: '2026-01-01T00:00:00.000Z', by: 'human', evidence: '夹具' } : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Requirement
}

// —————————————————————— 盘上写夹具（`.sdo/` 是公共面，不受卡写范围约束） ——————————————————————

/** 写一条缺陷记录（`exemption` 给了就原样落盘 —— 那正是本判据要读的豁免通道）。 */
function writeDefect(id: string, exemption?: Record<string, unknown>): void {
  store.writeYaml(['defects', `${id}.yml`], {
    defect: {
      id,
      title: `缺陷 ${id}`,
      severity: 'major',
      status: 'open',
      at: '2026-01-01T00:00:00.000Z',
      ...(exemption === undefined ? {} : { exemption }),
    },
  })
}

/** 建一条 `req-defect` 边（**不经校验地直写图** —— 悬空边只能这样造出来）。 */
function writeRawEdge(from: string, to: string): void {
  store.appendLine(['trace', 'links.jsonl'], JSON.stringify({ from, to, kind: 'req-defect' }))
}

function gateContext(requirements: Requirement[]): GateContext {
  const process = loadProcess('waterfall')
  assert.ok(process !== undefined, 'waterfall 流程必须装载得到')
  return {
    workspace: BASE,
    store,
    journal,
    project: undefined,
    requirements,
    questions: [],
    risks: [],
    issues: [],
    feasibility: undefined,
    redTeamExecuted: false,
    redTeamDisabled: true,
    waivedGates: [],
    prototypeDir: 'prototype',
    prototypeThrowaway: false,
    riskConclusion: undefined,
    process,
  } as unknown as GateContext
}

/** 判一次门禁并**只取被测那一条判据**（其余判据与本卡无关，缺夹具时它们会各自判红）。 */
function criterionOf(processId: string, gateId: string, requirements: Requirement[]): { evaluation: GateEvaluation; detail: string; ok: boolean; remedy: string } {
  const ctx = gateContext(requirements)
  const process = loadProcess(processId)
  assert.ok(process !== undefined, `流程 ${processId} 必须装载得到`)
  const evaluation = evaluateGate(process, gateId, ctx)
  const found = evaluation.criteria.find((item) => item.id === CRITERION)
  assert.ok(found !== undefined, `${processId} 的 ${gateId} 必须声明判据 ${CRITERION}（check=${CHECK}）`)
  return { evaluation, detail: found!.detail, ok: found!.ok, remedy: found!.remedy ?? '' }
}

/** 走真实接线判 `waterfall` 的 G5。 */
function waterfallG5(requirements: Requirement[]): { detail: string; ok: boolean; remedy: string; status: string } {
  const { evaluation, detail, ok, remedy } = criterionOf('waterfall', 'G5', requirements)
  return { detail, ok, remedy, status: evaluation.status }
}

const READY = [requirementOf('REQ-901', 'baselined'), requirementOf('REQ-902', 'draft'), requirementOf('REQ-903', 'dropped')]

// —————————————————————— ① 未绑定、未豁免 ⇒ 红并逐条点名 ——————————————————————

test('TC-060 ①：缺陷未挂需求也未豁免 ⇒ 判红并**逐条点名**缺陷 id', () => {
  writeDefect('DEF-901')
  writeDefect('DEF-902')

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, false, '孤儿缺陷必须判红')
  assert.equal(verdict.status, 'failed', '门禁整体也必须失败（不是只报一条红）')
  // 逐条点名：两条缺陷 id 都要在回执里（不许只说数量）
  assert.ok(verdict.detail.includes('DEF-901'), `回执必须点名 DEF-901，实际：${verdict.detail}`)
  assert.ok(verdict.detail.includes('DEF-902'), `回执必须点名 DEF-902，实际：${verdict.detail}`)
  assert.ok(verdict.detail.includes('0%'), `无一条可追溯 ⇒ 覆盖率读数应为 0%，实际：${verdict.detail}`)
})

test('TC-060 ① 两态绿侧：两条都绑到已基线需求 ⇒ 判据不因它们判红', () => {
  writeDefect('DEF-901')
  writeDefect('DEF-902')
  writeRawEdge('REQ-901', 'DEF-901')
  writeRawEdge('REQ-901', 'DEF-902')

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, true, `已绑定的缺陷不该判红，实际回执：${verdict.detail}`)
  assert.ok(verdict.detail.includes('100%'), `全部可追溯 ⇒ 覆盖率 100%，实际：${verdict.detail}`)
})

// —————————————————————— ② 已绑定且目标已基线 ⇒ 绿 ——————————————————————

test('TC-060 ②：绑定到**已基线**需求 ⇒ 绿（走生产 link()，不是手写图）', () => {
  writeDefect('DEF-901')
  const created = link(store, journal, { from: 'REQ-901', to: 'DEF-901', kind: 'req-defect' })
  assert.equal(created.created, true, '生产 link() 应能建这条边（目标实体必须存在）')

  const verdict = waterfallG5([requirementOf('REQ-901', 'baselined')])
  assert.equal(verdict.ok, true, `已基线目标 ⇒ 绿，实际回执：${verdict.detail}`)
})

// —————————————————————— ③ 绑定到未基线 / 已作废需求 ⇒ 红并点名失效目标 ——————————————————————

test('TC-060 ③：边指向**未基线**需求 ⇒ 判红并点名失效目标 id（"有边"≠"有效"）', () => {
  writeDefect('DEF-901')
  writeRawEdge('REQ-902', 'DEF-901') // REQ-902 = draft

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, false, '目标未基线 ⇒ 必须判红')
  assert.ok(verdict.detail.includes('DEF-901'), `要点名缺陷，实际：${verdict.detail}`)
  assert.ok(verdict.detail.includes('REQ-902'), `要点名失效目标需求 id，实际：${verdict.detail}`)
})

test('TC-060 ③：边指向**已作废**需求 ⇒ 判红并点名失效目标 id', () => {
  writeDefect('DEF-901')
  writeRawEdge('REQ-903', 'DEF-901') // REQ-903 = dropped

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, false, '目标已作废 ⇒ 必须判红')
  assert.ok(verdict.detail.includes('DEF-901'), `要点名缺陷，实际：${verdict.detail}`)
  assert.ok(verdict.detail.includes('REQ-903'), `要点名已作废目标 id，实际：${verdict.detail}`)
})

test('TC-060 ③：边指向**不存在**需求 ⇒ 同样判红并点名（悬空边口径）', () => {
  writeDefect('DEF-901')
  writeRawEdge('REQ-999', 'DEF-901')

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, false, '悬空边必须判红')
  assert.ok(verdict.detail.includes('REQ-999'), `要点名不存在的目标 id，实际：${verdict.detail}`)
})

// —————————————————————— ④ 合规豁免 ⇒ 不计孤儿，但回执单列豁免清单 ——————————————————————

test('TC-060 ④：带合规豁免（理由 + 批准人）⇒ 不计孤儿，但回执**单列豁免清单**', () => {
  writeDefect('DEF-901', { reason: '上游宿主缺陷，本仓无修复面（R-11 已评估）', approvedBy: 'human:Raitpor' })

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, true, `合规豁免 ⇒ 不计孤儿、判据不红，实际：${verdict.detail}`)
  // 「不得静默放过」：理由与批准人都必须出现在回执里
  assert.ok(verdict.detail.includes('上游宿主缺陷'), `回执必须列出豁免理由，实际：${verdict.detail}`)
  assert.ok(verdict.detail.includes('human:Raitpor'), `回执必须列出批准人，实际：${verdict.detail}`)
})

test('TC-060 ④ 两态红侧：豁免存在但**缺批准人** ⇒ 按未豁免处理并点名', () => {
  writeDefect('DEF-901', { reason: '只写了理由' })

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, false, '缺批准人的豁免不算豁免 ⇒ 必须判红')
  assert.ok(verdict.detail.includes('DEF-901'), `要点名该缺陷，实际：${verdict.detail}`)
  assert.ok(verdict.detail.includes('豁免') || verdict.detail.includes('exemption'), `要点明是豁免不成立，实际：${verdict.detail}`)
})

test('TC-060 ⑤：豁免**缺理由** ⇒ 按未豁免处理并点名', () => {
  writeDefect('DEF-901', { approvedBy: 'human:Raitpor' })

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, false, '缺理由的豁免不算豁免 ⇒ 必须判红')
  assert.ok(verdict.detail.includes('DEF-901'), `要点名该缺陷，实际：${verdict.detail}`)
})

test('TC-060 ⑤：豁免字段写成空对象 ⇒ 同样按未豁免处理', () => {
  writeDefect('DEF-901', {})

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, false, '空豁免对象不算豁免 ⇒ 必须判红')
  assert.ok(verdict.detail.includes('DEF-901'), `要点名该缺陷，实际：${verdict.detail}`)
})

// —————————————————————— ⑥ 台账读不动 ⇒ 红（fail-closed） ——————————————————————

test('TC-060 ⑥：缺陷台账里的 YAML **读不动** ⇒ 判红并点名原因（判不动不许判绿）', () => {
  // 形状/语法坏掉的真源：解析器抛错 ⇒ 判据必须判红，而不是"没有这条缺陷"
  mkdirSync(join(BASE, '.sdo', 'defects'), { recursive: true })
  writeFileSync(join(BASE, '.sdo', 'defects', 'DEF-901.yml'), 'defect: [未闭合\n', 'utf8')

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, false, '台账读不动必须判红（fail-closed）')
  assert.ok(verdict.detail.includes('DEF-901.yml'), `要点名读不动的文件，实际：${verdict.detail}`)
})

test('TC-060 ⑥b：`defects` 路径被写成一个**文件**（不是目录）⇒ 判红', () => {
  const path = join(BASE, '.sdo', 'defects')
  rmSync(path, { recursive: true, force: true })
  writeFileSync(path, 'not a directory\n', 'utf8')

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, false, '台账目录不可读必须判红')
})

test('TC-060 ⑥c 绿侧对照：台账**不存在**（没有 `.sdo/defects/`）⇒ 空台账 = 100%，不判红', () => {
  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, true, `没有缺陷要挂 ⇒ 100%，实际：${verdict.detail}`)
})

// —————————————————————— ⑦ 判红时给出可执行修法 ——————————————————————

test('TC-060 ⑦：判红时回执必须给出**补齐入口**（补哪条边 / 走哪条豁免）', () => {
  writeDefect('DEF-901')

  const verdict = waterfallG5(READY)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.remedy.includes('sdo_trace action=link'), `修法要给出建边命令，实际：${verdict.remedy}`)
  assert.ok(verdict.remedy.includes('req-defect'), `修法要点明边类型，实际：${verdict.remedy}`)
  assert.ok(verdict.remedy.includes('DEF-*.yml'), `修法要给出豁免的落点，实际：${verdict.remedy}`)
  assert.ok(verdict.remedy.includes('approvedBy'), `修法要写明豁免字段，实际：${verdict.remedy}`)
  // 回执（含修法）由 describeGate 全量打印给用户
  const receipt = describeGate({ gate: 'G5', phase: 'construction', status: 'failed', at: '2026-01-01T00:00:00.000Z', criteria: [{ id: CRITERION, ok: false, detail: verdict.detail, remedy: verdict.remedy }], remedy: [verdict.remedy] })
  assert.ok(receipt.includes('DEF-901'), `回执必须点名缺陷，实际：${receipt}`)
  assert.ok(receipt.includes('sdo_trace action=link'), `回执必须给出修法，实际：${receipt}`)
})

// —————————————————————— ⑧ 落点二：四个流程的门禁都声明了这条判据 ——————————————————————

test('TC-060 ⑧：waterfall/prototype/spiral 的 G5 与 agile 的 GI 都声明 C-58（同口径）', () => {
  const expected: [string, string][] = [
    ['waterfall', 'G5'],
    ['prototype', 'G5'],
    ['spiral', 'G5'],
    // agile **没有 G5**：迭代出口是 GI（卡上落点二的本轮修正）——落位与 TASK-037 在 G6/GI 的处置同款
    ['agile', 'GI'],
  ]
  for (const [processId, gateId] of expected) {
    const process = loadProcess(processId)
    assert.ok(process !== undefined, `流程 ${processId} 必须装载得到`)
    const declared = process!.gates.find((gate) => gate.id === gateId)?.criteria.find((item) => item.id === CRITERION)
    assert.ok(declared !== undefined, `${processId} 的 ${gateId} 必须声明 ${CRITERION}`)
    assert.equal(declared!.check, CHECK, `${processId} 的 ${CRITERION} 必须挂在检查器 ${CHECK} 上`)
  }
  // 反向守卫：agile 里**不该**凭空长出一个 G5（否则这条断言会在无声中变成"两处都有"）
  assert.equal(loadProcess('agile')!.gates.some((gate) => gate.id === 'G5'), false, 'agile 没有 G5')
})

test('TC-060 ⑧：agile 的 GI 走真实接线也判红（同一条判据，不是另一份实现）', () => {
  writeDefect('DEF-901')

  const verdict = criterionOf('agile', 'GI', READY)
  assert.equal(verdict.ok, false, 'agile GI 上的同口径判据也必须判红')
  assert.ok(verdict.detail.includes('DEF-901'), `要点名缺陷，实际：${verdict.detail}`)
})

// —————————————————————— ⑨ 读数同源：回执 / TRACE.md / BOARD.md ——————————————————————

/** 三处读数取同一份现算结果时的**期望读数**（覆盖率百分数）。 */
function readingOf(reportValue: TraceReport): number {
  const links = readDefectLinksOf(reportValue)
  assert.ok(links !== undefined, '追溯报告必须带缺陷追溯读数（defectLinks）')
  return Math.round(links!.coverage * 100)
}

test('TC-060 ⑨：回执 / TRACE.md / BOARD.md 三处读**同一份**现算读数（同一报告对象）', () => {
  writeDefect('DEF-901')
  writeDefect('DEF-902', { reason: '已评估，本仓无修复面', approvedBy: 'human:Raitpor' })
  writeRawEdge('REQ-901', 'DEF-901')
  const requirements = [requirementOf('REQ-901', 'baselined')]

  // 一次现算，三处消费（这正是"不得各写一份"的可观察形式）
  const reportValue = traceReport(store, requirements)
  const expected = readingOf(reportValue)
  assert.equal(expected, 100, `两条都可追溯（一条边 + 一条豁免）⇒ 100%，实际 ${expected}`)

  // ① 门禁回执
  const verdict = waterfallG5(requirements)
  assert.ok(verdict.detail.includes(`${expected}%`), `回执读数必须是 ${expected}%，实际：${verdict.detail}`)

  // ② TRACE.md
  const trace = renderTraceReport({ report: reportValue, seq: 7, header: renderHeader('.sdo/trace/links.jsonl', 7) })
  assert.ok(trace.includes(`${expected}%`), `TRACE.md 读数必须是 ${expected}%，实际：${trace}`)
  assert.ok(trace.includes('已评估，本仓无修复面'), `TRACE.md 必须列出豁免理由，实际：${trace}`)
  assert.ok(trace.includes('human:Raitpor'), `TRACE.md 必须列出批准人，实际：${trace}`)

  // ③ BOARD.md —— 走 board/render.ts 的真实渲染，读数从**同一份报告**取
  const office = { traceReport: () => reportValue } as unknown as Parameters<typeof renderBoard>[0] & never
  const model = {
    project: { id: 'PRJ-901', name: '夹具', process: 'waterfall', phase: 'construction', scope: { in: [], out: [] }, stakeholders: [], metrics: { success: [] }, glossary: {}, tailoring: { scale: 'normal' }, phaseHistory: [] },
    config: { scale: 'normal', board: { window: 10 } },
    counts: { requirements: requirements.length, questions: 0, openQuestions: 0, gates: 0, evidence: 0 },
    gates: [],
    process: loadProcess('waterfall'),
    pendingGate: 'G5',
    requirements: [],
    dataDirName: '.sdo',
    truncated: false,
    defectLinks: readDefectLinksOf(reportValue),
  } as unknown as BoardModel
  void office
  const board = renderBoard(model)
  assert.ok(board.includes(`${expected}%`), `BOARD.md 读数必须是 ${expected}%，实际：${board}`)
  assert.ok(board.includes('已评估，本仓无修复面'), `BOARD.md 必须列出豁免理由，实际：${board}`)
})

test('TC-060 ⑨ 两态红侧：读数在红态下也同源（0% + 逐条点名）', () => {
  writeDefect('DEF-901')
  const requirements = [requirementOf('REQ-901', 'baselined')]

  const reportValue = traceReport(store, requirements)
  const expected = readingOf(reportValue)
  assert.equal(expected, 0, '一条孤儿缺陷 ⇒ 0%')

  const verdict = waterfallG5(requirements)
  assert.equal(verdict.ok, false)
  const trace = renderTraceReport({ report: reportValue, seq: 1, header: renderHeader('.sdo/trace/links.jsonl', 1) })
  assert.ok(trace.includes('DEF-901'), 'TRACE.md 红态也要点名孤儿缺陷')
  assert.ok(trace.includes(`${expected}%`), `TRACE.md 读数应为 ${expected}%`)
})
