/**
 * 增量 23：**第三轮复审报告的回归（R-1…R-14）**。
 *
 * 报告来源：`sdo-test/docs/2026-10-02-插件缺陷复审报告（第三轮修复验证）.md` §4，
 * 以及同批的评审员独立核实 `.review/2026-10-02-第三轮复审报告的独立核实（评审员）.md`。
 *
 * **本文件按评审员的硬要求写（§7）**：
 *   1. 每个 blocker 的用例走**与缺陷同一条路径** —— R-1 走"手写真源（无 journal 事件）"，
 *      R-7 走"坏 requirements/questions/risks/issues（`gateContext` 更早的读取点）"，
 *      而不是上一轮那种"改真源必然产生事件/只坏 design 真源"的路径；
 *   2. 关键用例做**变异自证**：断言直接比较"冷渲染 vs 缓存渲染""逐条判据数"，回滚修复即红
 *      （本轮的变异实测记录见交付说明；`assert.equal(cached, cold)` 这类断言本身就是变异敏感的）；
 *   3. 每条 blocker 都断言"用户看得见"这一半（状态块/台账里有 `truthError` / `unjudged`）。
 *
 * 覆盖：R-1 缓存假绿（手改路径）｜R-2 C9 remedy 可执行｜R-3 缓存依赖清单｜R-4 `--turn`｜
 *       R-5 未决口径第三份手抄｜R-6 CHANGELOG 排版与计数｜R-7 兜底装错层（两半）｜
 *       R-8 `patch.status` 旁路｜R-9 版本号口径｜R-10 头里的 `phase`｜R-11/R-13 回退载荷｜
 *       R-12 CRLF｜R-14 报错带文件名 + `unjudged`
 */
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { Journal } from '../src/infra/journal.js'
import { renderDesignDoc, renderDesignDocCached } from '../src/domain/design.js'
import { signatureState } from '../src/domain/signature.js'
import { listRequirements } from '../src/domain/requirements.js'
import { listQuestions } from '../src/domain/grill.js'
import { apply } from '../src/index.js'
import { boardModelFor, renderBoard } from '../src/board/render.js'
import { describeStatus } from '../src/interface/describe.js'
import { renderStatusBlock } from '../src/interface/inject.js'
import { createOfficeCommands } from '../src/interface/commands.js'
import type { OfficeCommandDeps } from '../src/interface/commands.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { GateCriterionResult } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m23/', import.meta.url))
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
  office.init(call(), { name: 'M23 测试', scale: 'normal', stakeholders: ['业务方'] })
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

/** 渲染 + 建一个设计元素（让 DESIGN.md 有内容、渲染头合法）。 */
function rendered(): string {
  const id = baselined()
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单', requires: [id] })
  office.renderDesign(call())
  return id
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

/** 把某个真源文件写坏（Tab 缩进是 YAML 子集明确拒绝的形态 —— 手改真源最常见的破坏）。 */
function breakYaml(path: string, lineIndex = 1): void {
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.split('\n').map((line, index) => (index === lineIndex ? `\t${line}` : line)).join('\n'), 'utf8')
}

const firstFileIn = (dir: string): string => {
  const list = readdirSync(join(workspace, '.sdo', dir)).filter((name) => name.endsWith('.yml')).sort()
  assert.ok(list.length > 0, `前置：.sdo/${dir} 下应有 yml`)
  return join(workspace, '.sdo', dir, list[0]!)
}

// —————————————————————— R-1（blocker）：手写真源无事件路径 ——————————————————————

test('R-1：手改真源（**不产生 journal 事件**）后，缓存不得端上旧渲染 —— C-25 必须判红', () => {
  const id = rendered()
  assert.equal(c25().ok, true, '前置：合法渲染后判绿')
  const store = new SdoStore(join(workspace, '.sdo'))
  const journal = new Journal(store)
  const seq = Number(/journal seq (\d+)/u.exec(readDoc())?.[1])
  const input = {
    workspace,
    store,
    project: journal.loadProject().project,
    requirements: listRequirements(store),
    questions: listQuestions(store),
    seq,
    meta: { phase: 'architecture' },
  }
  const cold = renderDesignDoc(input)
  const cached = renderDesignDocCached(input)
  // **变异敏感断言**：旧实现（键只看 journal）在这里会 cached === 手改前的渲染 ≠ cold
  assert.equal(cached, cold, '缓存必须与冷渲染一致（同一真源状态只能有一个结果）')

  // 手改一个**文档可见**字段（`name` 会进 DESIGN.md），不碰 journal
  const viewPath = join(workspace, '.sdo', 'design', 'component.yml')
  const before = readFileSync(viewPath, 'utf8')
  writeFileSync(viewPath, before.replace(/^(\s*name:\s*).*$/mu, '$1手改过的服务名'), 'utf8')
  assert.notEqual(readFileSync(viewPath, 'utf8'), before, '前置：真源确实被手改了')
  const eventsBefore = office.journalFor(workspace).read().events.length

  const coldAfter = renderDesignDoc(input)
  assert.notEqual(coldAfter, cold, '前置：手改真的改变了渲染结果（该字段文档可见）')
  assert.equal(renderDesignDocCached(input), coldAfter, '缓存键必须含真源文件指纹（旧实现会命中旧渲染）')
  assert.equal(office.journalFor(workspace).read().events.length, eventsBefore, '手写真源不产生 journal 事件（这正是旧前提错在哪）')

  // 用户可见的那一半：C-25 判红（旧实现这里会 PASS = 假绿）
  const stale = c25()
  assert.equal(stale.ok, false, '手改真源后文档已与真源脱钩 → 必须判红（不得假绿）')
  assert.match(stale.detail, /重渲染|脱钩/u, `理由要说明与真源重渲染不一致：${stale.detail}`)

  // 双向：重新渲染 → 转绿
  office.renderDesign(call())
  assert.equal(c25().ok, true, '重新渲染后必须转绿')
  void id
})

// —————————————————————— R-7（blocker）：兜底必须在正确的层 ——————————————————————

test('R-7a：坏 requirements/questions/risks/issues 四类真源，status/evaluate/advance 都不得抛异常', () => {
  baselined()
  const targets: [string, string][] = [
    ['requirements', firstFileIn('requirements')],
    ['questions', firstFileIn('questions')],
    ['risks', firstFileIn('risks')],
  ]
  // issues 目录：跑过红队攻击后应有议题文件
  const issueFile = (() => {
    try {
      return firstFileIn('issues')
    } catch {
      return undefined
    }
  })()
  if (issueFile !== undefined) targets.push(['issues', issueFile])

  for (const [label, path] of targets) {
    const original = readFileSync(path, 'utf8')
    breakYaml(path, 2)
    try {
      let status: ReturnType<SoftwareDevOffice['status']> | undefined
      assert.doesNotThrow(() => {
        status = office.status(call())
      }, `坏 ${label} 时 status() 不得抛（注入状态块走这条路径）`)
      assert.ok((status?.truthError ?? '') !== '', `坏 ${label} 时状态块必须如实说明读不出真源：${status?.truthError ?? '（空）'}`)
      assert.match(status?.truthError ?? '', /文件：/u, `报错必须带相对路径（R-14）：${status?.truthError}`)
      assert.equal(status?.truthError?.includes(workspace), false, '不得泄漏绝对路径（NFR-009）')
      // 读不出 ⇒ 不能显得"没有待判定门禁"（最保守：报当前阶段第一个出口门禁）
      assert.equal(status?.pendingGate, 'G3', `读不出真源时待判定门禁必须保守：${status?.pendingGate}`)

      assert.doesNotThrow(() => office.evaluate(call(), 'G2'), `坏 ${label} 时 evaluate() 不得抛`)
      const evaluation = office.evaluate(call(), 'G2')
      assert.equal(evaluation.status, 'failed', '读不动 ⇒ 判红（查不到不能算过）')
      assert.equal(evaluation.unjudged, true, '必须标 unjudged（区分"查不动"与"判不过"）')

      let step: ReturnType<SoftwareDevOffice['advance']> | undefined
      assert.doesNotThrow(() => {
        step = office.advance(call())
      }, `坏 ${label} 时 advance() 不得抛`)
      assert.equal(step?.advanced, false, '读不动时推进必须被拦')
      assert.equal(step?.blockedBy, 'gate.unreadable')
      assert.ok((step?.remedy ?? []).length > 0, '被拦时必须给出补救')
    } finally {
      writeFileSync(path, original, 'utf8')
    }
  }

  // 双向：全部修好 → 恢复正常判定
  assert.doesNotThrow(() => office.evaluate(call(), 'G3'))
  assert.notEqual(office.evaluate(call(), 'G3').unjudged, true, '修好后不得再标 unjudged')
})

test('R-7b：坏 design 真源不得让整门塌成一条判据（其余判据照常判定）', () => {
  rendered()
  const normal = office.evaluate(call(), 'G3').criteria.length
  assert.ok(normal > 1, `前置：G3 应有多条判据，实际 ${normal}`)

  breakYaml(join(workspace, '.sdo', 'design', 'component.yml'), 1)
  const broken = office.evaluate(call(), 'G3')
  assert.ok(
    broken.criteria.length > 1,
    `坏真源后判据仍应逐条判定（旧实现塌成 1 条 gate.internal）：${broken.criteria.length} 条 / ${broken.criteria.map((c) => c.id).join(',')}`,
  )
  assert.equal(broken.criteria.some((item) => item.id === 'gate.unreadable'), false, '设计侧真源坏掉应落在具体判据上，而不是整门读不动')
  assert.equal(broken.status, 'failed', '坏真源必须判红')
  assert.equal(
    broken.criteria.filter((item) => !item.ok).length >= 1,
    true,
    '至少有一条判据判红（而不是"一条都不判"）',
  )
})

test('R-7c / R-14：读真源失败必须落进台账并标 unjudged（事后能分辨"查不动"）', () => {
  baselined()
  const reqFile = firstFileIn('requirements')
  const original = readFileSync(reqFile, 'utf8')
  breakYaml(reqFile, 2)
  try {
    const evaluation = office.checkGate(call(), 'G2')
    assert.equal(evaluation.unjudged, true)
    const events = office.journalFor(workspace).read().events.filter((event) => event.type === 'gate/result')
    const last = events.at(-1)
    assert.equal(last?.data['unjudged'], true, `台账必须记下"判据未逐条判定"：${JSON.stringify(last?.data)}`)
    assert.deepEqual(last?.data['failed'], ['gate.unreadable'], 'failed 里的 id 必须自证不是流程判据')
    assert.equal(last?.data['passed'], 0)
  } finally {
    writeFileSync(reqFile, original, 'utf8')
  }
})

// —————————————————————— R-10 / R-12：渲染头的阶段与行尾 ——————————————————————

test('R-10：头里的 phase 必须是真实阶段（伪造 delivery/99 必须判红）', () => {
  rendered()
  const doc = readDoc()
  assert.equal(c25().ok, true, '前置：真阶段（architecture）判绿')

  for (const phase of ['delivery', '99']) {
    writeDoc(doc.replace(/phase\s+\S+/u, `phase ${phase}`))
    const forged = c25()
    assert.equal(forged.ok, false, `伪造 phase=${phase} 必须判红（旧实现 PASS）`)
    assert.match(forged.detail, /阶段/u, `理由必须点明是阶段声明的问题：${forged.detail}`)
  }
  writeDoc(doc)
  assert.equal(c25().ok, true, '还原后判绿')
})

test('R-12：CRLF（内容一字未改）不得判红，但人工批注仍判红', () => {
  rendered()
  const doc = readDoc()
  writeDoc(doc.replace(/\n/gu, '\r\n'))
  assert.equal(c25().ok, true, 'Windows 行尾不算内容变更（旧实现"什么都没改却一直红"）')

  writeDoc(`<!-- 我的人工批注 -->\n${doc}`)
  assert.equal(c25().ok, false, '人工批注仍必须判红（派生视图请勿手改）')
  writeDoc(doc)
  assert.equal(c25().ok, true)
})

// —————————————————————— R-2：C9 的 remedy 必须可执行 ——————————————————————

test('R-2：AC 重号可用 `acceptanceMode=replace` 改号修完（旧 remedy 只能追加、永远修不完）', async () => {
  // 造重号：手写第二条需求，复用 REQ-001 的 AC-001（存量重号就是这个形态）
  const id = baselined()
  const secondPath = join(workspace, '.sdo', 'requirements', 'REQ-002.yml')
  writeFileSync(secondPath, [
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
    '    - id: AC-001',
    '      given: g',
    '      when: w',
    '      then: t',
    '  ambiguity:',
    '    score: 16',
    '    dimensions: {}',
    '    open: []',
  ].join('\n'), 'utf8')
  assert.equal(criterion(office.evaluate(call(), 'G2').criteria, 'C9-ac-ids-unique').ok, false, '前置：重号判红')

  // 按 remedy 走：整份替换成未占用的号（工具面真实入口）
  const harness = toolHarness()
  const receipt = await harness.callTool('sdo_requirement', {
    action: 'update',
    id: 'REQ-002',
    acceptance: JSON.stringify([
      { id: 'AC-021', given: 'g', when: 'w', then: 't' },
      { id: 'AC-022', given: 'g2', when: 'w2', then: 't2' },
    ]),
    acceptanceMode: 'replace',
  })
  assert.ok(receipt.length > 0, '更新应有回执')
  const after = criterion(office.evaluate(call(), 'G2').criteria, 'C9-ac-ids-unique')
  assert.equal(after.ok, true, `按 remedy 做必须能转绿：${after.detail}`)

  // 双向：非法 acceptanceMode 必须被拒（工具面 schema 直接拒绝，不得静默当成 append）
  await assert.rejects(
    () => harness.callTool('sdo_requirement', { action: 'update', id: id, acceptance: '[]', acceptanceMode: 'bogus' }),
    /acceptanceMode/u,
    '非法模式必须被拒并点名参数',
  )
})

// —————————————————————— R-8 / R-9：内容判定优先、版本号口径 ——————————————————————

test('R-8 / R-9：内容判定优先于 patch.status，且内容改过必须涨版本号', () => {
  const id = baselined()
  const before = office.requirements(call()).find((item) => item.id === id)
  assert.ok(before !== undefined)
  const versionBefore = before.version

  // R-8 的旁路：改内容 + 试图把 status 写回 baselined
  office.update(call(), {
    id,
    patch: { statement: '系统须在每日对账后识别差异；单日 300 万，P99 < 200 毫秒', status: 'baselined' },
  })
  const after = office.requirements(call()).find((item) => item.id === id)
  assert.equal(after?.status, 'changed', '内容变更不可被 patch.status 绕过（R-8）')
  assert.equal(
    after?.version,
    Math.round((versionBefore + 0.1) * 10) / 10,
    `内容改过必须涨版本号（R-9）：${versionBefore} → ${after?.version}`,
  )

  // 双向：只改投影（问题账本/语义分）不得误伤
  office.update(call(), { id, modelDimensions: DIMS, openQuestions: [] })
  const projected = office.requirements(call()).find((item) => item.id === id)
  assert.equal(projected?.status, 'changed', '投影更新不改状态（仍是 changed）')
  assert.equal(projected?.version, after?.version, '投影更新不得涨版本号')
})

// —————————————————————— R-11 / R-13：回退载荷 ——————————————————————

test('R-11 / R-13：回退留痕带 desc、按审计需要裁剪，键名是 invalidatedDetails[].criteria', () => {
  rendered()
  office.checkGate(call(), 'G3')
  const result = office.rollbackPhase(call(), { to: 'requirements', reason: '发现需求缺口' })
  assert.equal(result.ok, true, `合法回退应当成功：${result.error ?? ''}`)
  const event = office.journalFor(workspace).read().events.filter((item) => item.type === 'phase/rolled-back').at(-1)
  assert.ok(event !== undefined)
  const details = event.data['invalidatedDetails'] as { gate: string; criteria: { id: string; ok: boolean; desc?: string; detail?: string }[] }[]
  assert.ok(Array.isArray(details) && details.length > 0, '必须留下 invalidatedDetails')
  const g3 = details.find((item) => item.gate === 'G3')
  assert.ok(g3 !== undefined, 'G3 的明细必须在内（它的 json 已被删除）')
  assert.ok(
    g3.criteria.some((item) => (item.desc ?? '') !== ''),
    'R-11：必须带 desc（否则审计读不出"这条判据是什么"）',
  )
  // R-13：通过的判据不留 detail（控体积），判红的必须留
  const passed = g3.criteria.filter((item) => item.ok && item.detail === undefined)
  assert.ok(passed.length > 0, 'R-13：通过的判据只留 id/ok（体积可控）')
  const js = JSON.stringify(event.data)
  assert.ok(Buffer.byteLength(js, 'utf8') < 7900, `R-13：裁剪后的事件应小于旧实现（实测约 7.9KB），当前 ${Buffer.byteLength(js, 'utf8')} 字节`)
})

// —————————————————————— R-4：命令面 --turn ——————————————————————

test('R-4：`/sdo-gate --turn=…` 必须真的传给处理器（旧实现静默丢弃）', async () => {
  const seen: Record<string, unknown>[] = []
  const commands = createOfficeCommands({
    gate: async (_call: unknown, args: Record<string, unknown>) => {
      seen.push(args)
      return 'stub'
    },
  } as unknown as OfficeCommandDeps, false)
  const gate = commands.find((item) => item.name === 'sdo-gate')
  assert.ok(gate !== undefined)
  await gate.handler({
    commandId: 'cmd-test',
    agent: { id: 's1', session: { header: { cwd: workspace } } },
    rawInput: '--sign --gate=G2 --quote="我确认" --turn=session:12',
    attachments: [],
    signal: new AbortController().signal,
  } as never)
  assert.equal(seen[0]?.['turn'], 'session:12', `--turn 必须传下去（文档已宣传它）：${JSON.stringify(seen[0])}`)
})

// —————————————————————— R-5 / R-6：口径与文档 ——————————————————————

test('R-5：`method.ts` 不得再手抄"未决"判定（复用 dor.isEffectivelyOpen）', () => {
  const text = readFileSync(join(ROOT, 'src', 'domain', 'method.ts'), 'utf8')
  assert.match(text, /import \{ isEffectivelyOpen \} from '\.\/dor\.js'/u, 'method.ts 必须 import dor 的判定')
  assert.equal(
    /question\.status === 'assumed' && question\.authorizedByUser !== true/u.test(text),
    false,
    '不得再有第三份手抄（N-1/P-6 的成因正是"同一概念多份手抄"）',
  )
})

test('R-6：CHANGELOG 结构正确（升级须知在最后、每轮只出现一次、编号**单调**）', () => {
  const raw = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  /**
   * **CRLF 归一（Windows CI 的必修）**：GitHub 的 Windows runner 默认 `core.autocrlf=true`，
   * 检出的是 **CRLF** 文本；对文件内容做"整行相等/位置"判断时，行尾的 `\r` 会让 `=== '### 修复'`
   * 这类断言全部落空 —— 实测 tag `v0.1.2` 上 windows × node20/22 的 CI 就是挂在这一点上
   * （ubuntu 全绿、windows 都红在"构建并运行测试"）。
   *
   * 这里对 **LF 与 CRLF 两种形态各跑一遍**：既修掉 Windows 的假红，也让"必须归一"这件事
   * 在 Linux 上就能被守住（否则回归只会再次以 Windows-only 的形式暴露）。
   */
  const variants: [string, string][] = [['LF', raw], ['CRLF（Windows 检出）', raw.replace(/\r?\n/gu, '\r\n')]]
  for (const [label, rawText] of variants) {
    const lines = rawText.replace(/\r\n?/gu, '\n').split('\n')
    const count = (needle: string): number => lines.filter((line) => line.includes(needle)).length
    const indexOf = (needle: string): number => lines.findIndex((line) => line.includes(needle))
    assert.equal(count('## [0.1.2] - 2026-10-01'), 1, `[${label}] 不得有重复的 0.1.2 段`)
    assert.equal(count('## [0.1.1] - 2026-09-30'), 1, `[${label}] 不得有重复的 0.1.1 段`)
    assert.equal(count('### 升级须知'), 1, `[${label}] 升级须知只应有一节`)

    // 两套编号必须用**明确前缀**分开（评审员曾被混用编号误导过一次）：
    //   `缺陷复审报告 第 N 轮` = sdo-test 的缺陷复审报告轮次；`评审员核实 第 N 轮` = 评审员的独立核实轮次
    const verified = [5, 4, 3, 2, 1].map((n) => `评审员核实 第 ${n} 轮`)
    const reports = [4, 3, 2].map((n) => `缺陷复审报告 第 ${n} 轮`)
    for (const roundLabel of [...verified, ...reports]) {
      assert.equal(count(roundLabel), 1, `[${label}] ${roundLabel} 只应出现一次`)
    }
    // 单调性（此前只断言"出现一次"，排序是乱的：前段最新在前、后段最新在后）
    const vIdx = verified.map(indexOf)
    const rIdx = reports.map(indexOf)
    assert.deepEqual([...vIdx].sort((a, b) => a - b), vIdx, `[${label}] 评审员核实轮次必须**最新在前**`)
    assert.deepEqual([...rIdx].sort((a, b) => a - b), rIdx, `[${label}] 缺陷复审报告轮次必须**最新在前**`)
    assert.ok(Math.max(...vIdx) < Math.min(...rIdx), `[${label}] 评审员核实轮次必须整体排在缺陷复审报告之前`)

    const unrel = lines.indexOf('## [Unreleased]')
    const upgrade = lines.findIndex((line) => line === '### 升级须知')
    const v012 = lines.indexOf('## [0.1.2] - 2026-10-01')
    assert.ok(unrel < upgrade && upgrade < v012, `[${label}] 顺序必须是：Unreleased → 升级须知 → 0.1.2`)
    assert.ok(
      lines.slice(unrel, upgrade).some((line) => line === '### 修复'),
      `[${label}] 各轮条目都必须落在「### 修复」之下（旧版把第二轮挂在升级须知底下）`,
    )
  }
})


// —————————————————————— 脚手架 ——————————————————————

function toolHarness(): { callTool(name: string, args: Record<string, unknown>): Promise<string> } {
  const registered: { name: string; execute: (args: unknown, ctx: unknown) => unknown }[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: { name: string; execute: (args: unknown, ctx: unknown) => unknown }): (() => void) => { registered.push(tool); return () => {} } },
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
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  return {
    callTool: async (name, args) => {
      const tool = registered.find((item) => item.name === name)
      if (tool === undefined) throw new Error(`没有注册工具 ${name}（已注册：${registered.map((t) => t.name).join(',')}）`)
      return String(await tool.execute(args, { agent: { id: 's1', session: { header: { cwd: workspace } } } }))
    },
  }
}

// ———————— R-7 的"看得见"那一半（评审员 §4.1 / §4.3）：必须断言**渲染出来的字符串** ————————

test('R-7 可见性：读真源失败必须在**注入块 / 看板 / sdo_status 回执**里显式说出来（不是只有 API 字段）', () => {
  baselined()
  const normalStatus = office.status(call())
  const normalBlock = renderStatusBlock(normalStatus, '.sdo', 1500)
  assert.equal(normalBlock.includes('读真源失败'), false, '前置：正常状态下注入块不得出现该警告')

  const reqFile = firstFileIn('requirements')
  const original = readFileSync(reqFile, 'utf8')
  breakYaml(reqFile, 2)
  try {
    const status = office.status(call())
    assert.ok((status.truthError ?? '') !== '', '前置：API 层确实带上了 truthError')

    // ① 注入块：模型每轮真正读到的东西 —— 旧实现与正常块**逐字相同**（只改了待判定门禁）
    const block = renderStatusBlock(status, '.sdo', 1500)
    assert.match(block, /读真源失败/u, `注入块必须显式告警：\n${block}`)
    assert.match(block, /requirements\/REQ-001\.yml/u, `告警必须带相对路径：\n${block}`)
    assert.equal(block.includes(workspace), false, '不得泄漏绝对路径（NFR-009）')
    assert.notEqual(block, normalBlock, '退化的状态块不得与正常状态块逐字相同')

    // ② sdo_status 回执
    const receipt = describeStatus(status, '.sdo')
    assert.match(receipt, /读真源失败/u, `sdo_status 回执必须显式告警：\n${receipt}`)

    // ③ 看板（只读展示：读不动也要能出图 + 顶部告警）
    const board = renderBoard(boardModelFor(office, status, call(), '.sdo').model)
    assert.match(board, /读真源失败/u, `看板必须显式告警：\n${board}`)
  } finally {
    writeFileSync(reqFile, original, 'utf8')
  }

  // 双向：修好后三处都不得再有该警告
  const fixed = office.status(call())
  assert.equal(fixed.truthError, undefined)
  assert.equal(renderStatusBlock(fixed, '.sdo', 1500).includes('读真源失败'), false)
  assert.equal(describeStatus(fixed, '.sdo').includes('读真源失败'), false)
})

test('R-7 可见性②：只读列表入口不得裸抛（sdo_requirement action=list / sdo_board 要给可读结果）', async () => {
  baselined()
  const reqFile = firstFileIn('requirements')
  const original = readFileSync(reqFile, 'utf8')
  breakYaml(reqFile, 2)
  try {
    const harness = toolHarness()
    // 旧实现这里直接抛 YamlSubsetError（用户看到的是会话报错）
    const list = await harness.callTool('sdo_requirement', { action: 'list' })
    assert.match(list, /读真源失败|读取真源失败/u, `列表入口必须给可读失败：${list}`)
    assert.match(list, /requirements\/REQ-001\.yml/u, `必须点名文件（相对路径）：${list}`)
    assert.equal(list.includes(workspace), false, '不得泄漏绝对路径')

    // 看板是**命令**（不是工具）：走真实装配函数，读不动也要能出图（顶部告警），不得整条失败
    const { model, readError } = boardModelFor(office, office.status(call()), call(), '.sdo')
    assert.ok(readError !== undefined, '装配必须如实回报读不动（而不是抛出去）')
    assert.deepEqual(model.requirements, [], '读不动的需求列表按空处理（且已告警）')
    const board = renderBoard(model)
    assert.match(board, /读真源失败/u, `看板必须能出图并告警：\n${board.slice(0, 300)}`)
    assert.match(board, /requirements\/REQ-001\.yml/u, '看板告警要带相对路径')
  } finally {
    writeFileSync(reqFile, original, 'utf8')
  }
  // 双向：修好后列表恢复正常
  const harness = toolHarness()
  const ok = await harness.callTool('sdo_requirement', { action: 'list' })
  assert.equal(/读真源失败|读取真源失败/u.test(ok), false, `修好后不得再报读失败：${ok.slice(0, 200)}`)
})

// ———————— §5.x（第二份评审员报告）：`project.json` 坏 JSON 的降级形态必须**说真话** ————————

/** 把 `.sdo/project.json` 写成坏 JSON（它是可重建的派生投影，插件自己的注释这么声明）。 */
function breakProjectJson(): { path: string; original: string } {
  const path = join(workspace, '.sdo', 'project.json')
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, `${original.slice(0, 2)}坏${original.slice(3)}`, 'utf8')
  return { path, original }
}

test('§5.1：project 读不出时不得断言"尚未初始化/没有 .sdo/"（那是假陈述），且必须打印告警', () => {
  rendered()
  const normalBlock = renderStatusBlock(office.status(call()), '.sdo', 1500)
  assert.equal(normalBlock.includes('尚未初始化'), false, '前置：正常状态块不得出现该断言')
  const normalReceipt = describeStatus(office.status(call()), '.sdo')
  assert.equal(normalReceipt.includes('当前工作目录下没有'), false, '前置：正常回执不得出现该断言')

  const { path, original } = breakProjectJson()
  try {
    const status = office.status(call())
    assert.equal(status.project, undefined, '前置：project 读不出')
    assert.ok((status.truthError ?? '') !== '', '前置：truthError 非空')

    const block = renderStatusBlock(status, '.sdo', 1500)
    assert.match(block, /读真源失败/u, `注入块必须告警：\n${block}`)
    assert.match(block, /project\.json/u, `告警必须点名那个文件：\n${block}`)
    // **反向断言（评审员要求）**：不得再说"尚未初始化 / 没有 `.sdo/`"
    assert.equal(block.includes('尚未初始化'), false, `不得把"读不出"说成"没有"：\n${block}`)
    // 反向断言用**旧假陈述的原文**（新文案里含「这不等于「没有 .sdo/」」，不能用子串粗暴判定）
    assert.equal(block.includes('当前工作目录下没有'), false, `不得声称没有 .sdo/：\n${block}`)
    assert.match(block, /这不等于|无法确认/u, `必须写清"无法确认"而不是"没有"：\n${block}`)

    const receipt = describeStatus(status, '.sdo')
    assert.match(receipt, /读真源失败/u, `回执必须告警：\n${receipt}`)
    assert.equal(receipt.includes('当前工作目录下没有'), false, `回执不得声称没有 .sdo/：\n${receipt}`)
  } finally {
    writeFileSync(path, original, 'utf8')
  }
})

test('§5.2 / §5.3：project 读不出时 checkGate 与看板装配都不得抛（要给可读判红/能出图）', () => {
  rendered()
  const { path, original } = breakProjectJson()
  try {
    // **§5.3 先测**：此刻投影还是坏的 —— 装配必须回报读不动且能出图
    (() => {
      const built = (() => {
        try {
          return boardModelFor(office, office.status(call()), call(), '.sdo')
        } catch (error) {
          assert.fail(`看板装配不得抛：${String(error)}`)
        }
      })()
      assert.ok((built.readError ?? '') !== '', `投影坏时装配必须回报读不动：${JSON.stringify(built.readError)}`)
      const board = renderBoard(built.model)
      assert.match(board, /读真源失败/u, `看板必须能出图并告警：\n${board.slice(0, 240)}`)
      assert.ok(built.model.process.phases.length > 0, '流程退回随包瀑布流程（看板仍要有阶段）')
    })()

    // §5.2：`sdo_gate action=check` 是用户卡住时最该能用的入口
    let evaluation: ReturnType<SoftwareDevOffice['checkGate']> | undefined
    assert.doesNotThrow(() => {
      evaluation = office.checkGate(call(), 'G3')
    }, 'checkGate 的降级分支不得再读 contextFor（它正是刚失败的那一步）')
    assert.equal(evaluation?.unjudged, true, '必须标 unjudged（读不动 ≠ 判不过）')
    assert.match(evaluation?.criteria[0]?.detail ?? '', /project\.json/u, '判红 detail 要点名文件')

    // **自愈（如实断言）**：`Journal.append` 会 `rebuild()` —— 派生投影由真源重建，
    // 所以上面那次 `checkGate` 落盘之后，坏掉的 `project.json` 已被按 journal 修好。
    assert.doesNotThrow(() => office.process(call()), '投影应由 journal 自动重建（派生视图跟随真源）')
    assert.equal(JSON.parse(readFileSync(join(workspace, '.sdo', 'project.json'), 'utf8')).id, 'PRJ-001', '投影应已重建为可解析的 JSON')
    assert.equal(boardModelFor(office, office.status(call()), call(), '.sdo').readError, undefined, '自愈后装配应恢复正常')
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  // 双向：修好后两者都恢复正常
  assert.equal(office.checkGate(call(), 'G3').unjudged, undefined)
  assert.equal(boardModelFor(office, office.status(call()), call(), '.sdo').readError, undefined)
})

// ———————— §4.4（第三份评审员报告）：journal 中段坏行 + 写操作 ⇒ 投影不得被静默回退 ————————

test('§4.4：journal 中段坏行后，任何写操作都不得把投影静默回退到"截断前缀"', () => {
  baselined()
  const projectPath = join(workspace, '.sdo', 'project.json')
  const before = JSON.parse(readFileSync(projectPath, 'utf8')) as { phase: string; name: string }
  assert.equal(before.phase, 'architecture', '前置：阶段在 architecture')

  // 模拟崩溃半写：在 journal **中段**插一行坏 JSON（其后的事件都还在盘上）
  const journalPath = join(workspace, '.sdo', 'journal.jsonl')
  const lines = readFileSync(journalPath, 'utf8').split('\n').filter((line) => line.trim() !== '')
  lines.splice(3, 0, '{ 这是崩溃留下的一行坏 JSON')
  writeFileSync(journalPath, `${lines.join('\n')}\n`, 'utf8')

  const truncated = office.status(call())
  assert.equal(truncated.truncated, true, '前置：坏行已被检测到')
  assert.equal(truncated.project?.phase, 'architecture', '前置：读路径仍以最后一份良好投影为准')

  // **任一写操作**（旧实现：append → rebuild → 用截断前缀覆盖投影 → 静默回退）
  office.logRisk(call(), {
    title: '写操作不倒退',
    level: 'low',
    probability: 'low',
    impact: '小',
    mitigation: '校验',
    owner: '业务方',
  })
  const after = JSON.parse(readFileSync(projectPath, 'utf8')) as { phase: string; name: string }
  assert.equal(after.phase, 'architecture', `投影不得被回退到截断前缀（旧实现会变成 intake）：${after.phase}`)
  assert.equal(after.name, before.name, '投影不得被回退')
  assert.equal(office.status(call()).project?.phase, 'architecture', '状态也不得悄悄退回早期阶段')

  // 告警仍在，并且必须说明"投影不会被重建"与强制重建的入口
  const block = renderStatusBlock(office.status(call()), '.sdo', 1500)
  assert.match(block, /真源损坏|已截断/u, `注入块必须保留截断告警：\n${block}`)
  assert.match(block, /不会被重建/u, `必须说明投影未被重建：\n${block}`)
  assert.match(block, /--rebuild/u, `必须给出显式强制重建入口：\n${block}`)

  // 双向：**显式**入口仍可按用户要求强制重建（唯一逃生口，且如实回报 truncated）
  const forced = office.rebuild(call())
  assert.equal(forced.truncated, true, '显式重建必须如实回报"真源仍被截断"')
  assert.equal(
    (JSON.parse(readFileSync(projectPath, 'utf8')) as { phase: string }).phase,
    'intake',
    '只有显式 --rebuild 才会按截断真源强制重建（有意为之，不是静默回退）',
  )
})

// ———————— §3（第四份评审员报告）：截断期「以事件流为证据」的判定必须 fail-closed ————————

/** 在 `journal.jsonl` 中段插一行坏 JSON（模拟崩溃半写）。 */
function corruptJournal(atLine = 3): { path: string; original: string } {
  const path = join(workspace, '.sdo', 'journal.jsonl')
  const original = readFileSync(path, 'utf8')
  const lines = original.split('\n').filter((line) => line.trim() !== '')
  lines.splice(atLine, 0, '{ 崩溃留下的坏行')
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  return { path, original }
}

function signatureOf(gate: string): ReturnType<typeof signatureState> {
  const store = new SdoStore(join(workspace, '.sdo'))
  return signatureState(store, new Journal(store), gate)
}

test('§3.1：截断期签字不得报 valid（假绿），必须报「无法判定」；修好 journal 后失效必须被看见', () => {
  baselined()
  assert.equal(signatureOf('G2').status, 'valid', '前置：G2 签字有效')

  const { path } = corruptJournal()
  {
    // 截断期改需求：这条 `requirement/updated` 落在坏行之后 —— 旧实现读不到，签字仍报 valid（假绿）
    office.update(call(), { id: 'REQ-001', patch: { title: '截断期改动' } })
    const state = signatureOf('G2')
    assert.equal(state.status, 'unknown', `截断期必须「无法判定」而不是 valid/stale：${state.status}`)
    assert.match(state.reason, /journal\.jsonl/u, `理由要点名坏行：${state.reason}`)

    // 用户可见面①：状态回执必须点名坏行，并说明事件流类判定此刻无法判定
    const receipt = describeStatus(office.status(call()), '.sdo')
    assert.match(receipt, /journal\.jsonl/u, `回执必须点名坏真源：\n${receipt}`)
    assert.match(receipt, /损坏|截断/u, `回执必须说明真源坏了：\n${receipt}`)
    assert.match(receipt, /无法判定/u, `回执必须说明事件流类判定此刻「无法判定」：\n${receipt}`)

    // 用户可见面②：门禁面 G2 不得判过，且判据必须给「无法判定」的理由（不是"签字无效"）
    const g2 = office.checkGate(call(), 'G2')
    assert.notEqual(g2.status, 'passed', '截断期 G2 不得判过')
    assert.ok(
      g2.criteria.some((criterion) => criterion.detail.includes('无法判定')),
      `签字判据必须给「无法判定」的理由：${JSON.stringify(g2.criteria.map((c) => c.detail).slice(0, 4))}`,
    )
  }

  // 双向：**只去掉那一行坏 JSON**（不能把整份 journal 还原 —— 那会把截断期的写入一起抹掉，
  // 于是"签字仍 valid"反而成了正确结论）。修好后，那次失效**必须被看见**。
  const repaired = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '{ 崩溃留下的坏行')
    .join('\n')
  writeFileSync(path, repaired, 'utf8')
  assert.equal(signatureOf('G2').status, 'stale', '修好 journal 后，截断期那次改动必须被看见（失效）')
})

test('§3.2：截断期合法重渲染后，C-25 不得自信宣布「没有任何渲染事件」，必须报「查不动」', () => {
  rendered()
  const { path, original } = corruptJournal()
  try {
    office.renderDesign(call()) // 合法重渲染：事件落在坏行之后，read() 看不到
    const c25 = office.checkGate(call(), 'G3').criteria.find((criterion) => criterion.id === 'C-25')
    assert.ok(c25 !== undefined, 'G3 里应有 C-25')
    assert.equal(c25.ok, false)
    assert.match(c25.detail, /真源不完整|截断|无法判定/u, `必须说明"查不动"：${c25.detail}`)
    assert.equal(c25.detail.includes('没有任何'), false, `不得自信断言「没有任何渲染事件」：${c25.detail}`)

    // 同族判据（红队记录 / 回退留痕）同样 fail-closed：G2/G3 里都要出现「真源不完整」
    const all = [...office.checkGate(call(), 'G2').criteria, ...office.checkGate(call(), 'G3').criteria]
    assert.ok(all.some((criterion) => criterion.detail.includes('真源不完整')), 'C6/C-2E 等事件流判据也要 fail-closed')
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  // 双向：修好 journal 后不得再报「查不动」
  const after = office.checkGate(call(), 'G3').criteria.find((criterion) => criterion.id === 'C-25')
  assert.equal(after?.detail.includes('真源不完整') ?? false, false, '修好后不得再报「查不动」')
})

// ———————— 展示面与判定面一致（用户裁决 ②）+ ③ 两项核实后修复 ————————

test('②展面一致：截断期**三面**（注入块/回执/看板）必须与判定面同口径', () => {
  baselined()
  corruptJournal()
  const status = office.status(call())
  const block = renderStatusBlock(status, '.sdo', 1500)
  const receipt = describeStatus(status, '.sdo')
  const board = renderBoard(boardModelFor(office, status, call(), '.sdo').model)
  // 三面都必须：点名坏真源 + 点名坏行 + 说明"以事件流为证据的判定一律无法判定" + 不再说"尾部损坏"
  for (const [label, text] of [['注入块', block], ['回执', receipt], ['看板', board]] as const) {
    assert.match(text, /journal\.jsonl/u, `${label} 必须点名坏真源：\n${text.slice(0, 240)}`)
    assert.match(text, /第 \d+ 行/u, `${label} 必须点名坏行`)
    assert.match(text, /无法判定/u, `${label} 必须与判定面同口径（事件流类判定此刻无法判定）：\n${text.slice(0, 300)}`)
    assert.equal(text.includes('尾部损坏'), false, `${label} 不得再说「尾部损坏」（中段同样触发）`)
  }
  // 看板另外要求：不得把留痕读成当前判定
  assert.match(board, /不代表当前判定|不是当前判定/u, '看板上的记录不得被读成当前判定')
  // 注入块另外要求：给出投影不被重建与强制重建入口（避免用户以为"没写进去"或"要手改投影"）
  assert.match(block, /不会被重建/u, '注入块必须说明派生投影不会被重建')
  assert.match(block, /--rebuild/u, '注入块必须给出显式强制重建入口')
})

test('③a：gates/*.json 写坏时，**存活的只读入口**都要给可读结论（域层仍不吞异常）', () => {
  baselined()
  const gateFile = join(workspace, '.sdo', 'gates', 'G2.json')
  const original = readFileSync(gateFile, 'utf8')
  writeFileSync(gateFile, '{坏JSON', 'utf8')
  try {
    // ① 域层：**有意**不吞异常（静默返回空列表会把"读不出"伪装成"没有记录"）
    assert.throws(() => office.gatesFor(call()), /gates\/G2\.json/u, '域层列表读取按分层约定仍抛，且必须点名文件')

    // ② status（`sdo_status` / 注入块的唯一数据源）：降级快照 + 可读 truthError（点名文件）
    const status = office.status(call())
    assert.match(status.truthError ?? '', /gates\/G2\.json/u, `status 必须点名坏文件：${status.truthError}`)
    const receipt = describeStatus(status, '.sdo')
    assert.match(receipt, /读真源失败/u, '回执必须显式告警')
    assert.match(receipt, /gates\/G2\.json/u, '回执必须点名坏文件')

    // ③ 看板装配（boardModelFor 的 gates 读取已兜底）：读不动也要能出图 + 顶部告警
    const built = boardModelFor(office, status, call(), '.sdo')
    assert.match(built.readError ?? '', /gates\/G2\.json/u, `看板装配必须如实回报读不动：${built.readError}`)
    const board = renderBoard(built.model)
    assert.match(board, /读真源失败/u, `看板必须能出图并告警：\n${board.slice(0, 200)}`)

    // ④ 判定面不受影响：坏的是"审计留痕"，判定照样现算（不得因留痕坏掉而整门塌）
    const g3 = office.checkGate(call(), 'G3')
    assert.ok(g3.criteria.length > 1, '判据必须照常逐条判定')
  } finally {
    writeFileSync(gateFile, original, 'utf8')
  }
  // 双向：修好后 status 与看板装配都恢复正常
  assert.equal(office.status(call()).truthError, undefined)
  assert.equal(boardModelFor(office, office.status(call()), call(), '.sdo').readError, undefined)
})

test('③b：--rebuild 的回执必须说明「已强制重建」，真源残缺时必须说明「只折叠到最后一致前缀、可能回退」', async () => {
  const harness = toolHarness()
  baselined()
  // 健康真源：回执只说"已强制重建"，不得出现截断警告
  const healthy = await harness.callTool('sdo_status', { rebuild: true })
  assert.match(healthy, /强制重建/u, `健康真源下必须说明已强制重建：${healthy.slice(0, 200)}`)
  assert.equal(/最后一致前缀/u.test(healthy), false, '健康真源下不得出现截断警告')

  // 残缺真源：必须说明本次重建只折叠到最后一致前缀、可能回退
  const { path } = corruptJournal()
  const forced = await harness.callTool('sdo_status', { rebuild: true })
  assert.match(forced, /强制重建/u, `必须说明已强制重建：${forced.slice(0, 240)}`)
  assert.match(forced, /最后一致前缀/u, `必须说明只折叠到最后一致前缀：${forced.slice(0, 240)}`)
  assert.match(forced, /可能被?回退|可能回退|回退到更早/u, `必须说明阶段可能回退：${forced.slice(0, 240)}`)
  assert.match(forced, /第 \d+ 行/u, '必须点名坏行')
  void path
})
