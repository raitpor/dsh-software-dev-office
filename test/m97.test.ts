/**
 * M97：**G6 验证门禁要求签署测试报告**（TASK-062 / REQ-059 / REQ-051 / 判据 `C-59` / 检查器 `testing.report-signed`）。
 *
 * 本卡把「测试报告必须由用户签字确认才能过验证门」做成一等判据，四态**逐条可观察**
 * （卡上落点一 / 落点二 / 落点四）：
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | 报告真源与渲染稿都不在盘 | 判红，并点名「先由真源渲染测试报告」（fail-closed） |
 * | ② | 盘上有稿、journal 里**没有**渲染登记 | 判红，并点名它「不是当前真源的渲染」（不许签来路不明的稿子） |
 * | ③ | 报告齐备、签字台账里**没有本门签字** | 判红，修法里给出**可执行命令**（`sdo_gate action=sign gate=…`） |
 * | ④ | 报告齐备 + 存在**当前指纹**的签字 | 判绿，回执给出**报告路径 / 内容指纹 / 签字时刻** |
 * | ⑤ | 签字之后**报告真源被改**（指纹变了） | 判红并点名「签字已失效，需重签」，回执同时给出签字侧与当前侧两个指纹 |
 * | ⑥ | 签字之后**渲染稿被手改**（真源没动） | 判红并点名失效（真源指纹一致也不许放过） |
 * | ⑦ | 历史签字**没有**记录报告指纹（G2/G3 那类） | **不得假红**：落到「当前真源自洽」口径，并在回执里**如实写明这是降级判定** |
 *
 * ## 三条纪律（写在这里免得后人踩）
 *   ① **反例不得空转**：每条红线断言都必须点到**具体名字**（`docs/TESTREPORT.md`、`验证门禁（G6）`、
 *      `sdo_gate action=sign`、`签字已失效`、两个指纹字面值…），只断言 `ok === false` 会把
 *      「判据没跑」与「判据判红」混为一谈；
 *   ② **指纹口径不另造**：报告内容指纹就是报告渲染头里那一个（`docSourceFingerprint(store,'report')`，
 *      即 `.sdo/testing/report.yml` 的规范化内容哈希），本文件不自己算哈希、也不引入第二套台账；
 *   ③ **design.signed（C-2D）逐字节不变**：G3 那条通道不写报告指纹字段（用例 ⑧ 钉住），
 *      于是它的判定路径与结果与改动前完全一致。
 *
 * 夹具是本仓自己的沙箱工作区（`node_modules/.sdo-test/m97`），项目用**真实工具** `sdo_init` 建、
 * 报告用**真实渲染器** `writeTestingDoc` 落盘（连 `doc/rendered` 登记一起）—— 手写 `.sdo/` 在本仓
 * 是「不算证据」的形态（D4），用在这里会让「判据真的读到了那份报告」这一结论失去效力。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { CHECKERS, requiredArtifactNames } from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import { SoftwareDevOffice } from '../src/office.js'
import { gateDef, loadProcess } from '../src/domain/process.js'
import { latestSignature, recordSignature, signoffInput, signatureState } from '../src/domain/signature.js'
import { docSourceFingerprint, writeTestingSource } from '../src/domain/testingStore.js'
import { writeTestingDoc } from '../src/domain/testingRender.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm97')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'm97-session'

/** 判据 id（流程数据里的 `criteria[].id`）与检查器键（`criteria[].check`）——本卡的两条落点各一个。 */
const CRITERION = 'C-59'
const CHECK = 'testing.report-signed'

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

let harness: { tool: (name: string) => RegisteredTool; exec: () => unknown; fire: (event: string, payload: unknown) => void }

function makeHarness(): typeof harness {
  const listeners = new Map<string, (payload: never) => void>()
  const registered = new Map<string, RegisteredTool>()
  const services: Record<string, unknown> = {
    tools: { register: (tool: RegisteredTool) => registered.set(tool.name, tool) },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (event: string, listener: never) => { listeners.set(event, listener); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  const tool = (name: string): RegisteredTool => {
    const found = registered.get(name)
    if (found === undefined) throw new Error(`真实装配没有注册 ${name}（注册表里只有：${[...registered.keys()].join(', ')}）`)
    return found
  }
  return {
    tool,
    // **取会话工作目录只能读 `agent.session.header.cwd`**（dsh-agent 0.2.0-rc.1 上没有顶层 cwd）
    exec: () => ({ name: 'sdo_init', arguments: {}, agent: { session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } } }),
    fire: (event, payload) => listeners.get(event)?.(payload as never),
  }
}

const store = (): SdoStore => new SdoStore(join(WORKSPACE, '.sdo'))
const journal = (): Journal => new Journal(store())
const office = (): SoftwareDevOffice => new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
const call = (): { sessionId: string; cwd: string } => ({ sessionId: SESSION, cwd: WORKSPACE })

/** 判据的**真实注册实现**（不是本文件另写一份口径）。 */
function checkReportSigned(): { ok: boolean; detail: string; remedy?: string | undefined; warnings?: string[] | undefined } {
  const checker = CHECKERS[CHECK]
  assert.equal(typeof checker, 'function', `${CHECK} 必须在 CHECKERS 里注册`)
  if (checker === undefined) throw new Error(`${CHECK} 未注册`)
  const ctx = { workspace: WORKSPACE, store: store(), journal: journal() } as unknown as GateContext
  const verdict = checker(ctx)
  return {
    ok: verdict.ok === true,
    detail: verdict.detail ?? '',
    ...(verdict.remedy === undefined ? {} : { remedy: verdict.remedy }),
    ...(verdict.warnings === undefined ? {} : { warnings: verdict.warnings }),
  }
}

/** 报告真源的**规范路径**（与判据读的是同一份映射表，不另拼路径）。 */
const REPORT_SOURCE = join(WORKSPACE, '.sdo', 'testing', 'report.yml')
/** 渲染稿的**规范路径**（`docs/TESTREPORT.md`）。 */
const REPORT_DOC = join(WORKSPACE, 'docs', 'TESTREPORT.md')

/** 落一份报告真源（走真实写入路径：`.sdo/testing/report.yml` + `truth/file-written` 留痕）。 */
function writeReportSource(): void {
  writeTestingSource(store(), 'report', 'report', {
    title: 'M97 夹具测试总结报告',
    exitCriteria: [{ id: 'EC-1', criterion: '全部 must 需求用例通过', threshold: '100%', measured: '100%', verdict: 'pass' }],
    coverage: [{ criterion: 'C-50', threshold: '1', measured: '1', verdict: 'pass' }],
  }, journal())
}

/** 渲染 + 登记：返回**渲染时的真源指纹**（即签名要绑的那个值）。 */
function renderReport(): string {
  const written = writeTestingDoc(store(), 'report', { seq: 1 }, journal())
  return written.fingerprint
}

/** 一条真实签字（走 `office.signGate` —— 与用户在工具面按下的那条路同源）。 */
function sign(gate: string, basis: string): void {
  office().signGate(call(), { gate, by: '张三', basis, channel: 'command' })
}

beforeEach(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  harness = makeHarness()
  harness.fire('session/created', { id: SESSION, header: { cwd: WORKSPACE } })
  const receipt = String(
    await harness.tool('sdo_init').execute(
      { name: 'M97 夹具', process: 'waterfall', scale: 'normal', stakeholders: '签字人,执行者' },
      harness.exec(),
    ),
  )
  assert.match(receipt, /PRJ-001/u, `夹具立项失败：${receipt}`)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// —————————————————————— ① 报告不在盘 ⇒ 判红（fail-closed） ——————————————————————

test('M97-01 报告不存在 ⇒ 判红并点名「先由真源渲染测试报告」', () => {
  const verdict = checkReportSigned()
  assert.equal(verdict.ok, false, '没有报告就是没有可签的对象 —— 必须判红，不许 N/A、不许静默放过')
  // **点名**：报告名、渲染命令，一个都不能少（只断言 ok===false 会把「判据没跑」也算通过）
  assert.match(verdict.detail, /TESTREPORT\.md/u, `detail 要点名报告名：${verdict.detail}`)
  assert.match(verdict.remedy ?? '', /sdo_render target=report/u, `修法必须是可执行命令：${verdict.remedy ?? '(无)'}`)
  assert.match(verdict.remedy ?? '', /\.sdo\/testing\/report\.yml/u, `修法要点名报告真源：${verdict.remedy ?? '(无)'}`)
  // 真源路径也要与判据读的那一份一致（`TESTING_DOC_META` 是唯一映射表）
  assert.ok(REPORT_SOURCE.endsWith(join('.sdo', 'testing', 'report.yml')), '夹具的真源落点要与判据口径一致')
})

// —————————————————————— ② 有稿、无渲染登记 ⇒ 判红（不许签来路不明的稿子） ——————————————————————

test('M97-02 盘上有报告但 journal 里没有渲染登记 ⇒ 判红并点名它「不是当前真源的渲染」', () => {
  // 真源在盘上、稿子也在盘上，但**没有任何 `doc/rendered` 登记**（手塞进去的稿子）
  writeReportSource()
  mkdirSync(join(WORKSPACE, 'docs'), { recursive: true })
  writeFileSync(REPORT_DOC, '# 手写的测试总结报告\n\n（不是渲染器写的）\n', 'utf8')

  const verdict = checkReportSigned()
  assert.equal(verdict.ok, false, '来路不明的稿子不算「当前真源的渲染」⇒ 判红')
  assert.match(verdict.detail, /docs\/TESTREPORT\.md/u, `detail 要点名那份稿子：${verdict.detail}`)
  assert.match(verdict.detail, /没有它的渲染登记/u, `detail 要说清是「来路不明」而不是「真源改了」：${verdict.detail}`)
  assert.match(verdict.remedy ?? '', /sdo_render target=report/u, `修法要给重新渲染的命令：${verdict.remedy ?? '(无)'}`)
})

// —————————————————————— ③ 报告齐备但没签字 ⇒ 判红并给可执行修法 ——————————————————————

test('M97-03 报告齐备、台账里没有 G6 签字 ⇒ 判红并给出可执行修法', () => {
  writeReportSource()
  const fingerprint = renderReport()

  const verdict = checkReportSigned()
  assert.equal(verdict.ok, false, '报告在、但没有人签过字 ⇒ 判红')
  assert.match(verdict.detail, /验证门禁（G6）/u, `detail 要点名该签的是哪个门禁：${verdict.detail}`)
  assert.match(verdict.detail, /docs\/TESTREPORT\.md/u, `detail 要点名报告路径：${verdict.detail}`)
  assert.ok(verdict.detail.includes(fingerprint), `detail 要给出当前内容指纹 ${fingerprint}：${verdict.detail}`)
  // **可执行修法**：命令 + 通道 + 签完怎么核（用户会照着做）
  assert.match(verdict.remedy ?? '', /sdo_gate action=sign gate="验证门禁（G6）"/u, `修法要给准确的签字命令：${verdict.remedy ?? '(无)'}`)
  assert.match(verdict.remedy ?? '', /channel=question/u, `修法要点明默认通道：${verdict.remedy ?? '(无)'}`)
  assert.match(verdict.remedy ?? '', /sdo_gate action=check/u, `修法要写清签完怎么核：${verdict.remedy ?? '(无)'}`)
  assert.ok((verdict.remedy ?? '').includes(CRITERION), `修法要点名判据 ${CRITERION}：${verdict.remedy ?? '(无)'}`)
})

// —————————————————————— ④ 报告 + 当前指纹的签字 ⇒ 判绿（回执三要素齐全） ——————————————————————

test('M97-04 报告 + 当前指纹的签字 ⇒ 判绿，回执给出报告路径 / 内容指纹 / 签字时刻', () => {
  writeReportSource()
  const fingerprint = renderReport()
  sign('验证门禁（G6）', '我确认这份测试报告属实，可以据此过验证门')

  // 签字面：这条签字真的把**当前报告指纹**绑进去了（不是本文件自己填的）
  const signature = latestSignature(store(), 'G6')
  assert.ok(signature !== undefined, '台账里必须有一条 G6 签字')
  assert.equal(signature?.reportFingerprint, fingerprint, '签字要绑定渲染时的报告指纹')
  assert.equal(signature?.channel, 'command', '通道如实落账')

  const verdict = checkReportSigned()
  assert.equal(verdict.ok, true, `报告 + 当前指纹的签字 ⇒ 判绿：${verdict.detail}`)
  assert.match(verdict.detail, /docs\/TESTREPORT\.md/u, `回执要给报告路径：${verdict.detail}`)
  assert.ok(verdict.detail.includes(fingerprint), `回执要给内容指纹 ${fingerprint}：${verdict.detail}`)
  assert.ok(verdict.detail.includes(String(signature?.at)), `回执要给签字时刻 ${String(signature?.at)}：${verdict.detail}`)
  assert.match(verdict.detail, /张三/u, `回执要点名签字人：${verdict.detail}`)
  assert.doesNotMatch(verdict.detail, /降级判定/u, '强口径（有指纹）时不许自称降级')
})

// —————————————————————— ⑤ 签字之后报告真源被改 ⇒ 判红并点名失效 ——————————————————————

test('M97-05 签字之后报告真源被改（指纹变了）⇒ 判红并点名「签字已失效，需重签」', () => {
  writeReportSource()
  const signedFingerprint = renderReport()
  sign('验证门禁（G6）', '我确认这版测试报告，同意据它过验证门')

  // 签字之后改真源 + 重新渲染（用户签的是**上一版**报告；这是真机最常见的形态）
  writeTestingSource(store(), 'report', 'report', {
    title: 'M97 夹具测试总结报告（改过）',
    exitCriteria: [{ id: 'EC-1', criterion: '全部 must 需求用例通过', threshold: '100%', measured: '92%', verdict: 'fail' }],
  }, journal())
  const currentFingerprint = renderReport()
  assert.notEqual(currentFingerprint, signedFingerprint, '夹具前提：改真源之后指纹必须变（否则这条用例什么都没证）')

  const verdict = checkReportSigned()
  assert.equal(verdict.ok, false, '签字之后报告内容变了 ⇒ 判红')
  assert.match(verdict.detail, /签字已失效，需重签/u, `detail 要点名失效与重签：${verdict.detail}`)
  assert.ok(verdict.detail.includes(signedFingerprint), `detail 要给出**签字绑定**的那个指纹 ${signedFingerprint}：${verdict.detail}`)
  assert.ok(verdict.detail.includes(currentFingerprint), `detail 要给出**当前**指纹 ${currentFingerprint}：${verdict.detail}`)
  assert.match(verdict.remedy ?? '', /sdo_gate action=sign gate="验证门禁（G6）"/u, `修法要指向重签：${verdict.remedy ?? '(无)'}`)
})

// —————————————————————— ⑥ 签字之后渲染稿被手改（真源没动）⇒ 判红 ——————————————————————

test('M97-06 签字之后渲染稿被手改（真源没动）⇒ 判红并点名失效', () => {
  writeReportSource()
  const fingerprint = renderReport()
  sign('验证门禁（G6）', '我确认这份渲染稿，同意据它过验证门')
  assert.equal(checkReportSigned().ok, true, '夹具前提：手改之前是绿的')

  // **只手改渲染稿**：真源一个字节都没动 ⇒ 真源内容指纹不变，但盘上那份不是渲染器写下的字节
  const rendered = readFileSync(REPORT_DOC, 'utf8')
  writeFileSync(REPORT_DOC, `${rendered}\n\n（有人手工加了这一段：全部结论其实都通过了）\n`, 'utf8')
  assert.equal(docSourceFingerprint(store(), 'report'), fingerprint, '夹具前提：手改渲染稿**不会**改真源指纹（这正是旧口径漏掉的那一档）')

  const verdict = checkReportSigned()
  assert.equal(verdict.ok, false, '签字之后渲染稿被手改 ⇒ 判红（签字绑的是那份稿子，不是「真源没动」）')
  assert.match(verdict.detail, /签字已失效，需重签/u, `detail 要点名失效与重签：${verdict.detail}`)
  assert.match(verdict.detail, /手工改过/u, `detail 要说清是「稿子被手改」而不是「真源改了」：${verdict.detail}`)
  assert.match(verdict.detail, /docs\/TESTREPORT\.md/u, `detail 要点名被改的那份稿子：${verdict.detail}`)
})

// —————————————————————— ⑦ 历史签字没有报告指纹 ⇒ 不得假红（降级判定要写明） ——————————————————————

test('M97-07 历史签字没有记录报告指纹 ⇒ 按「当前真源自洽」降级判定，并在回执里写明这是降级', () => {
  writeReportSource()
  renderReport()
  // 模拟历史签字（本字段引入之前写下的，或非本通道写入）：走 `recordSignature` 直接落一条不带指纹的
  recordSignature(store(), journal(), {
    gate: 'G6', by: '李四', basis: '（历史签字：当时还没有报告指纹口径）', channel: 'command',
  })

  const verdict = checkReportSigned()
  assert.equal(verdict.ok, true, `真源自洽 + 报告齐备 ⇒ 不许因为「读不到指纹」就判红（假红比不引入更糟）：${verdict.detail}`)
  assert.match(verdict.detail, /降级判定/u, `回执必须如实写明这是降级判定：${verdict.detail}`)
  assert.match(verdict.detail, /docs\/TESTREPORT\.md/u, `降级判定也要给出报告路径：${verdict.detail}`)
})

// —————————————————————— ⑧ design.signed（C-2D）语义不变：G3 通道不写报告指纹 ——————————————————————

test('M97-08 G3 签字不带报告指纹字段，`design.signed` 的判定路径与结果一字不变', () => {
  writeReportSource()
  renderReport()
  sign('架构门禁（G3）', '我确认这份设计与适用性声明可以放行')

  const g3 = latestSignature(store(), 'G3')
  assert.ok(g3 !== undefined, 'G3 签字要落账')
  assert.equal(Object.hasOwn(g3 as object, 'reportFingerprint'), false, 'G3 通道不写报告指纹字段（design.signed 的行为因此逐字节不变）')

  // `design.signed` 仍是「有效签字 + 台账与真源一致」⇒ 绿，且理由里读不到报告两字
  const state = signatureState(store(), journal(), 'G3')
  assert.equal(state.status, 'valid', `G3 签字应有效：${state.reason}`)
  assert.notEqual(state.inconsistent, true, `台账与 journal 必须一致：${state.reason}`)
  const signoff = signoffInput(store(), journal(), 'G3')
  assert.deepEqual(
    { status: signoff.status, signer: signoff.signer },
    { status: 'valid', signer: '张三' },
    `design.signed 读到的仍是同一份签字状态：${JSON.stringify(signoff)}`,
  )
})

// —————————————————————— ⑨ 判据注册：四个流程各挂一条 C-59，且指向同一个检查器 ——————————————————————

test('M97-09 四个流程各注册一条 C-59 / testing.report-signed，挂点逐流程可核对', () => {
  const expected: Record<string, { gate: string; phase: string }> = {
    waterfall: { gate: 'G6', phase: 'verification' },
    agile: { gate: 'G6', phase: 'release' },
    prototype: { gate: 'G6', phase: 'verification' },
    spiral: { gate: 'G6', phase: 'verification' },
  }
  for (const [id, spot] of Object.entries(expected)) {
    const process = loadProcess(id)
    assert.ok(process !== undefined, `流程数据 ${id}.yml 必须存在`)
    if (process === undefined) continue
    const hits = process.gates.flatMap((gate) => gate.criteria.filter((item) => item.id === CRITERION).map((item) => ({ gate: gate.id, check: item.check, desc: item.desc })))
    assert.equal(hits.length, 1, `${id} 必须**恰好**注册一条 ${CRITERION}（现有 ${hits.length} 条）`)
    assert.equal(hits[0]?.check, CHECK, `${id} 的 ${CRITERION} 必须指向检查器 ${CHECK}`)
    assert.equal(hits[0]?.gate, spot.gate, `${id} 的 ${CRITERION} 挂点应是 ${spot.gate}`)
    // 挂点理由：该门禁的出口阶段 —— 挂错阶段的门禁不会在正确的时刻判
    const phase = (process.phases ?? []).find((item) => (item.exit ?? []).includes(spot.gate))
    assert.equal(phase?.id, spot.phase, `${spot.gate} 应是 ${spot.phase} 阶段（${id}）的出口门禁`)
    // desc 必须写明四态与可执行修法（判据描述是签字人看到的"这条判什么"）
    const desc = hits[0]?.desc ?? ''
    for (const token of ['签字', '指纹', 'sdo_gate action=sign', 'sdo_render target=report']) {
      assert.ok(desc.includes(token), `${id} 的 ${CRITERION} desc 要写明「${token}」：${desc}`)
    }
  }
})

test('M97-11 挂点事实核实：agile **有** G6（`release` 阶段出口），C-59 不挂 GI', () => {
  const agile = loadProcess('agile')
  assert.ok(agile !== undefined)
  if (agile === undefined) return
  // 派发假设是「agile 没有 G5/G6」——**只有前半句成立**：查一遍机器可核的事实
  assert.equal(gateDef(agile, 'G5'), undefined, 'agile 确实没有 G5（这一点派发说得对）')
  assert.ok(gateDef(agile, 'G6') !== undefined, 'agile **有** G6（`release` 阶段的出口「发布前门」）—— 挂点据此改到 G6')
  assert.equal((agile.phases ?? []).find((item) => (item.exit ?? []).includes('G6'))?.id, 'release', 'G6 是 release 阶段的出口')
  assert.equal((agile.phases ?? []).find((item) => (item.exit ?? []).includes('GI'))?.id, 'iteration', 'GI 是 iteration 阶段的出口')
  // 为什么**不**挂 GI：迭代出口时报告常常还没有真源，fail-closed 会把每个迭代都卡住
  // （实测：敏捷 GI 夹具 test/m4.test.ts 在挂 GI 的版本上当场转红）
  const onGi = gateDef(agile, 'GI')?.criteria?.filter((item) => item.id === CRITERION) ?? []
  assert.equal(onGi.length, 0, `C-59 不许挂在 GI 上（迭代出口没有报告是常态，判红即假红）：${JSON.stringify(onGi)}`)
  // 但仍要**同一条判据、同一个检查器**：四流程一致（REQ-059 / AC-240）
  const onG6 = gateDef(agile, 'G6')?.criteria?.filter((item) => item.id === CRITERION) ?? []
  assert.equal(onG6.length, 1, 'C-59 必须挂在 agile 的 G6 上')
  assert.equal(onG6[0]?.check, CHECK, 'agile 的 C-59 必须指向同一个检查器')
})

test('M97-10 `testing.report-signed` 把 TESTREPORT.md 列入本门**必需**产物（审核单的必需栏要看得见它）', () => {
  const waterfall = loadProcess('waterfall')
  assert.ok(waterfall !== undefined)
  if (waterfall === undefined) return
  const names = requiredArtifactNames(gateDef(waterfall, 'G6'))
  assert.ok(names.includes('TESTREPORT.md'), `G6 的必需产物里要有 TESTREPORT.md（现有：${names.join(' / ')}）`)
})
