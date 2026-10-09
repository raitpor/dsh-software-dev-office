/**
 * **增量 81：覆盖测试首轮实测出的五条（R-23 / R-24 / R-25 / R-26 / R-27）** —— 回归 + 变异自证。
 *
 *   · **R-23**：`sdo_gate action=waive` 不校验门禁是否属于**当前流程** ⇒ 一条"豁免某个用不上的门禁"的
 *     探索动作会：① 把指向不存在门禁的豁免写进项目裁剪（日后新增同名门禁就静默生效）；
 *     ② 连带作废刚签的人类签字（那两类写入都在 G2 的失效集合里）。
 *   · **R-24**：成本回执的"说明"两行（`uiIndex.k5`/`k6`）被复制成了 **plan-mode** 文案
 *     （`k5`/`k6` 与 `m5`/`m6` 逐字相同）⇒ 成本报告里出现「已进入 plan mode（22）」。
 *   · **R-25**：`acceptanceMode=replace` **静默重新编号 AC** —— 而 AC 编号是交付验收矩阵的追溯键
 *     （C-60/P-3）⇒ "只改一句 AC 文本"会不作声地作废已出的交付包。
 *   · **R-26**：「G2 判定通过」≠「需求已重新冻结」：`baseline` 动作漏跑时，门禁一片绿、到下一次 `claim`
 *     才被 `change-not-digested` 拦住（白跑一轮）。
 *   · **R-27（major）**：签字依据**可重放** —— `channel=statement` 只校验原话"在会话里出现过"，
 *     于是任何旧话都能在任意时刻、对任意门禁反复铸成新签字（真机 `#1132` 复用了 `#1099` 的「确认签字」）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { recordSignature } from '../src/domain/signature.js'
import { describeAdvance, describeRequirementUpdate } from '../src/interface/describe.js'
import { apply } from '../src/index.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { loadPackagedYaml } from '../src/infra/data.js'
import type { SdoConfig } from '../src/config.js'
import type { Requirement } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm81')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function officeOf(cwd: string): SoftwareDevOffice {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('cockpit', cwd)
  return office
}

function fixture(): { office: SoftwareDevOffice; call: { sessionId: string; cwd: string }; journal: Journal } {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-cockpit', BASE)
  office.init({ sessionId: 's-cockpit', cwd: BASE }, { name: 'M81', scale: 'normal', stakeholders: ['业务方'] })
  return { office, call: { sessionId: 's-cockpit', cwd: BASE }, journal: office.journalFor(BASE) }
}

// ————————————————————————— R-23 —————————————————————————

test('M81-01 R-23：豁免一个**当前流程不存在**的门禁 ⇒ 拒绝，且不写裁剪、不作废签字', () => {
  const { office, call, journal } = fixture()
  const before = journal.read().events.length
  // 先签一个 G2（它是"会被 project/updated 作废"的那个门，正是真机被连带作废的对象）
  office.signGate(call, { gate: 'G2', by: '张三', basis: '我确认需求基线可以冻结', channel: 'command' })
  const afterSign = journal.read().events.length
  const recorded = office.waiveGate(call, '原型验收门禁（GP）', '覆盖测试：故意不适用', 'cockpit')
  assert.equal(recorded.status, 'failed', '不存在的门禁不许报"已豁免"')
  assert.equal(recorded.criteria[0]?.id, 'gate.unknown')
  assert.equal(recorded.criteria[0]?.ok, false)
  assert.match(recorded.criteria[0]?.remedy ?? '', /G0.*G7/u, '要给出可用门禁清单')
  // **核心断言**：没有写 tailoring / project / gate-result，也没有新签字事件
  const types = journal.read().events.slice(afterSign).map((event) => event.type)
  assert.deepEqual(types, [], `不许写任何东西（实际写了：${types.join(' ')}）`)
  assert.equal(journal.read().events.length, afterSign, '事件数不许变')
  assert.ok(before < afterSign)
  // 连带：刚签的 G2 仍然有效（没被这条探索动作作废）
  assert.equal(office.signatureState(call, 'G2').status, 'valid', '人类签字不许被"豁免用不上的门禁"作废')
  // 对照：豁免一个**真实存在**的门禁 ⇒ 放行并写裁剪
  const ok = office.waiveGate(call, 'G4', '本项目不需要详设门禁', 'cockpit')
  assert.equal(ok.status, 'waived', `存在的门禁要能豁免：${JSON.stringify(ok.criteria)}`)
  assert.equal(
    journal.read().events.filter((event) => event.type === 'tailoring/updated').length,
    1,
    '合法豁免才写 tailoring',
  )
})

// ————————————————————————— R-24 —————————————————————————

test('M81-02 R-24：成本回执的"说明"不许再用 plan-mode 文案（k5/k6 曾被复制成 m5/m6）', () => {
  for (const file of ['zh-CN.yml', 'en.yml']) {
    const pack = loadPackagedYaml(`src/data/lang/${file}`) as Record<string, Record<string, string>>
    const k5 = String(pack['uiIndex']?.['k5'] ?? '')
    const k6 = String(pack['uiIndex']?.['k6'] ?? '')
    const m6 = String(pack['uiIndex']?.['m6'] ?? '')
    assert.doesNotMatch(k5, /plan mode/u, `成本说明 k5 不该是 plan-mode 文案：${k5}`)
    assert.doesNotMatch(k6, /plan mode/u, `成本说明 k6 不该是 plan-mode 文案：${k6}`)
    assert.notEqual(k6, m6, '成本说明与 plan-mode 文案必须是两句不同的话（旧实现逐字相同）')
    assert.match(k6, /\{p1\}/u, 'k6 要带后代会话数这个占位符')
  }
  // 接线：成本归集路径用的就是这两个键（k5 兜底 / k6 带后代会话数）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /let note: string \| undefined = t\('uiIndex\.k5'\)/u)
  assert.match(index, /note = fmt\('uiIndex\.k6', \{ p1: descendants\.length \}\)/u)
})

// ————————————————————————— R-25 —————————————————————————

test('M81-03 R-25：`acceptanceMode=replace` 的编号变动必须出现在回执里（交付追溯键）', () => {
  const requirement = {
    id: 'REQ-006', title: '举例', kind: 'functional', statement: 's', rationale: '', source: {},
    priority: 'must', ambiguity: { score: 0, dimensions: {}, open: [] }, acceptance: [
      { id: 'AC-022', given: '', when: '', then: '改了文本' },
      { id: 'AC-023', given: '', when: '', then: '改了文本' },
    ], version: 0.3, status: 'changed', openQuestions: [], createdAt: '', updatedAt: '',
  } as unknown as Requirement
  const text = describeRequirementUpdate({
    requirement,
    flags: [],
    acceptanceRenumbered: [{ from: 'AC-011', to: 'AC-022' }, { from: 'AC-012', to: 'AC-023' }],
  })
  assert.match(text, /AC-011→AC-022/u, `回执要给出编号映射：${text}`)
  assert.match(text, /AC-012→AC-023/u)
  assert.match(text, /交付/u, '要说清它影响交付验收矩阵（追溯键）')
  // 没变动时不许出现这行（不许变成噪音）
  assert.doesNotMatch(describeRequirementUpdate({ requirement, flags: [] }), /编号已变/u)
  // 接线：编号映射由"改前的编号"与"改后的编号"按位置比对得出
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /beforeAcceptance/u)
  assert.match(index, /acceptanceRenumbered/u)
})

// ————————————————————————— R-26 —————————————————————————

test('M81-04 R-26：推进回执必须说"判定通过 ≠ 已重新冻结"（漏跑 baseline 不许到 claim 才发现）', () => {
  const text = describeAdvance({
    advanced: true, from: 'requirements', to: 'architecture',
    notes: ['已批准的变更还没有覆盖它们的重新基线事件：CR-001'],
  })
  assert.match(text, /CR-001/u, `推进回执要带上这条（真机 G2 判 ✅ 却仍算未消化）：${text}`)
  assert.match(text, /⚠️/u, '要显著（与"干净推进"区分开）')
  // 没有待办时不许多一行
  assert.doesNotMatch(describeAdvance({ advanced: true, from: 'requirements', to: 'architecture' }), /⚠️/u)
  // 接线：office.advance 从"未消化变更"里筛出**没有重新基线**的那些
  const office = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.match(office, /listUndigestedChanges\(store, journal, process\)/u)
  assert.match(office, /rebaselinedSeq === undefined/u)
  assert.match(office, /uiIndex\.kAdvanceBaselinePending/u)
})

// ————————————————————————— R-27 —————————————————————————

test('M81-05 R-27（核心）：同一句原话在"本门失效之后"再签必须被拒；用户重新表态才放行', () => {
  const { store, journal } = { store: new SdoStore(join(BASE, '.sdo')), journal: new Journal(new SdoStore(join(BASE, '.sdo'))) }
  const basis = '确认签字'
  // 带"这句话在会话派生消息里的位置"（`basisAt`）—— 前两次是**同一处**老话（下标相同）
  const first = recordSignature(store, journal, { gate: 'G3', by: '张三', basis, channel: 'command', basisAt: 3 })
  assert.equal(first.basisFirstSeq, first.atSeq, '首次使用 ⇒ 出处就是本条')
  // ① 本门**没有**失效事件 ⇒ 同句再签允许（用户那句话仍然"当前有效"）
  const second = recordSignature(store, journal, { gate: 'G3', by: '张三', basis, channel: 'command', basisAt: 3 })
  assert.equal(second.basisFirstSeq, first.atSeq, '第二次仍记"最早用于第一条"')
  // ② 本门失效（任何非中性真源事件）⇒ 同一处老话再签**被拒**（真机 #1132 的形态）
  journal.append('trace/linked', { from: 'REQ-001', to: 'DES-001', kind: 'req-des' })
  assert.throws(
    () => recordSignature(store, journal, { gate: 'G3', by: '张三', basis, channel: 'command', basisAt: 3 }),
    /上次失效之前/u,
    '失效之后复用同一处旧话必须被拒绝',
  )
  // ③ **用户重新表态**（同一句话又出现在**更靠后**的消息里 ⇒ basisAt 更大）⇒ 放行
  const fresh = recordSignature(store, journal, { gate: 'G3', by: '张三', basis, channel: 'command', basisAt: 9 })
  assert.ok(fresh.atSeq > second.atSeq, '重新表态要能签上')
  // 台账里能看出依据出处（审计一眼可辨）
  const stored = store.readYaml<{ signatures: { basis: string; basisFirstSeq?: number; basisAt?: number }[] }>('gates', 'signatures.yml')
  const last = stored?.signatures.at(-1)
  assert.equal(last?.basisFirstSeq, first.atSeq, '出处要落盘')
  assert.equal(last?.basisAt, 9)
})

test('M81-06 R-27（工具层）：`channel=statement` 复读旧话 ⇒ 回执明确拒绝且不落签字事件', async () => {
  const registered: { name: string; execute: (args: unknown, exec: unknown) => unknown }[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: never) => { registered.push(tool as never); return () => {} } },
    sessions: {},
    subagents: {},
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  const exec = { agent: { id: 'cockpit', session: { header: { cwd: BASE } } } }
  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = registered.find((item) => item.name === name)
    assert.ok(tool !== undefined, `${name} 必须注册进工具表`)
    return String(await tool.execute(args, exec))
  }
  await callTool('sdo_init', { name: 'R27 演练', process: 'waterfall', scale: 'normal', stakeholders: '运维' })
  const sign = (): Promise<string> => callTool('sdo_gate', { action: 'sign', gate: 'G3', quote: '确认签字', approvedBy: '张三' })
  const first = await sign()
  assert.match(first, /已记录/u, `第一次签字应当成功（宿主没有会话历史 ⇒ 按规格最低要求放行）：${first.slice(0, 200)}`)
  // 让 G3 失效，再复读同一句话
  const journal = new Journal(new SdoStore(join(BASE, '.sdo')))
  journal.append('trace/linked', { from: 'REQ-001', to: 'DES-001', kind: 'req-des' })
  const before = journal.read().events.filter((event) => event.type === 'gate/signed').length
  const second = await sign()
  assert.match(second, /签字被拒/u, `复读旧话必须被拒：${second.slice(0, 300)}`)
  assert.match(second, /channel=question/u, '要给出可操作的出路（工具当场问用户）')
  assert.equal(
    journal.read().events.filter((event) => event.type === 'gate/signed').length,
    before,
    '被拒时不许落任何签字事件',
  )
  // 回执里的"依据出处"（第一条签字）也要能看出处
  assert.match(first, /依据出处/u, '签字回执要印依据出处（审计可辨是否重放）')
})

// ————————————————————————— R-28 —————————————————————————

test('M81-07 R-28：已失效过的门禁走 `channel=question` 必须能签上（不许把补救通道自己堵死）', () => {
  const { store, journal } = { store: new SdoStore(join(BASE, '.sdo')), journal: new Journal(new SdoStore(join(BASE, '.sdo'))) }
  // 第一支：question 通道（依据 = 插件固定的选项文案，逐字重复是设计使然）
  const first = recordSignature(store, journal, { gate: 'G3', by: 'human', basis: '签字确认，批准通过', channel: 'question', basisFresh: true })
  assert.equal(first.channel, 'question')
  // 门禁失效（真源变更）
  journal.append('trace/linked', { from: 'REQ-001', to: 'DES-001', kind: 'req-des' })
  // 再由**工具当场问用户**取得的同一句选项文案 ⇒ **必须放行**（真机 R-28：这里被拒，导致 G3 不可过）
  const second = recordSignature(store, journal, { gate: 'G3', by: 'human', basis: '签字确认，批准通过', channel: 'question', basisFresh: true })
  assert.ok(second.atSeq > first.atSeq, '失效后 question 通道必须还能签（它是 R-27 自己推荐的补救路径）')
  assert.equal(store.readYaml<{ signatures: { basisFresh?: boolean }[] }>('gates', 'signatures.yml')?.signatures.at(-1)?.basisFresh, true, '台账要记"依据是本次当场取回的"')
  // **R-27 不许回退**：同一句旧话走 statement 通道（无位置证据）⇒ 仍然被拒
  assert.throws(
    () => recordSignature(store, journal, { gate: 'G3', by: 'human', basis: '签字确认，批准通过', channel: 'command' }),
    /上次失效之前/u,
    'statement 通道复读旧话仍必须被拒',
  )
})

test('M81-08 R-28 建议 5：被拒的签字尝试要留痕，且**不作废**已有签字（中性事件）', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-cockpit', BASE)
  office.init({ sessionId: 's-cockpit', cwd: BASE }, { name: 'R28', scale: 'normal', stakeholders: ['业务方'] })
  const call = { sessionId: 's-cockpit', cwd: BASE }
  const journal = office.journalFor(BASE)
  office.signGate(call, { gate: 'G3', by: '张三', basis: '第一句表态', channel: 'command' })
  assert.equal(office.signatureState(call, 'G3').status, 'valid')
  office.noteSignRejected(call, '架构门禁（G3）', 'command', '想复读的旧话')
  const rejected = journal.read().events.filter((event) => event.type === 'gate/sign-rejected')
  assert.equal(rejected.length, 1, '被拒尝试要落痕（真机 R-28：审计上看不见"有人试图签字并被拦"）')
  assert.equal(rejected[0]?.data['gate'], 'G3', '门禁名要归一成内部编号（与签字同口径）')
  assert.equal(rejected[0]?.data['channel'], 'command')
  assert.equal(rejected[0]?.data['basis'], '想复读的旧话', '依据原文照录')
  // **中性**：被拒不许顺带作废已有签字（否则"被拒一次"会让用户白签）
  assert.equal(office.signatureState(call, 'G3').status, 'valid', '被拒 ≠ 真源变更，不许作废签字')
  // 接线：工具层三条拒绝路径都要留痕
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /office\.noteSignRejected\(call, args\.gate, 'command', quote\)/u)
})

// ————————————————————————— R-27 的连坐面：设计确认 / 豁免 —————————————————————————

test('M81-09 设计确认：没依据不许盖"用户确认"戳；编造原话被拒；内容变了不许沿用同一句旧授权', () => {
  const { office, call } = fixture()
  const store = office.storeFor(BASE)
  // 关键条目 = 有需求来源的设计元素
  office.upsertElement(call, { kind: 'component', id: 'DES-010', name: 'Parser', elementKind: 'component', responsibility: '解析 CSV', requires: ['REQ-001'] })
  const target = office.designConfirmGaps(call).required[0]
  assert.equal(target, 'DES-010', '前置：它必须在"必须确认"集合里')
  // ① 没有依据 ⇒ 拒绝（旧实现会填**插件自己的**文案「用户在会话中确认」并记 basisSource=user）
  assert.deepEqual(office.confirmDesign(call, target, '   ', 'human'), { refused: 'no-basis' })
  // ② 内容变了 + 同一句旧授权 ⇒ 拒绝（戳绑内容只保证"内容没变时仍有效"，不保证"内容变了用户还认账"）
  const first = office.confirmDesign(call, target, '用户说：这个元素我确认', 'human', 'user', 'session')
  assert.ok('confirmation' in first && first.confirmation.basis === '用户说：这个元素我确认')
  office.upsertElement(call, { kind: 'component', id: 'DES-010', name: 'Parser', elementKind: 'component', responsibility: '解析 CSV（改过职责）', requires: ['REQ-001'] })
  assert.deepEqual(
    office.confirmDesign(call, target, '用户说：这个元素我确认', 'human', 'user', 'session'),
    { refused: 'replayed-basis' },
    '内容变了还拿同一句旧话盖章必须被拒',
  )
  // ③ 新的表态 ⇒ 放行，并把核对口径落盘
  const fresh = office.confirmDesign(call, target, '用户说：改过之后我重新确认', 'human', 'user', 'session')
  assert.ok('confirmation' in fresh && fresh.confirmation.basisChecked === 'session')
  const stored = store.readYaml<{ confirmations: { basis: string; basisChecked?: string }[] }>('design', 'confirmed.yml')
  assert.equal(stored?.confirmations[0]?.basis, '用户说：改过之后我重新确认')
  assert.equal(stored?.confirmations[0]?.basisChecked, 'session')
})

test('M81-10 豁免：批准人有没有用户原话依据必须留痕并印在回执上', () => {
  const { office, call } = fixture()
  const journal = office.journalFor(BASE)
  // ① 不给依据 ⇒ 放行（自救出口），但真源记 `approverChecked: none`
  office.waiveGate(call, 'G4', '本项目不需要详设门', '用户本人同意（我编的）')
  const none = journal.read().events.filter((event) => event.type === 'tailoring/updated').at(-1)
  assert.equal(none?.data['approverChecked'], 'none', '没依据要如实记 none')
  assert.equal(none?.data['approverBasis'], undefined)
  // ② 给了依据 ⇒ 记原话 + 核对口径
  office.waiveGate(call, 'G6', '本轮不做验证门', '张三', { quote: '确认豁免', checked: 'session' })
  const withBasis = journal.read().events.filter((event) => event.type === 'tailoring/updated').at(-1)
  assert.equal(withBasis?.data['approverBasis'], '确认豁免')
  assert.equal(withBasis?.data['approverChecked'], 'session')
  // 接线：工具层给了 quote 就核对（核不过拒绝），并在回执里说明有无依据
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /kWaiveQuoteMismatch/u)
  assert.match(index, /kWaiveNoBasis/u)
  assert.match(index, /kWaiveBasis/u)
})

test('M81-11 R-29：对不存在的门禁 waive ⇒ 回执不许说"已豁免"，也不许说"判定记录已写入"', async () => {
  const registered: { name: string; execute: (args: unknown, exec: unknown) => unknown }[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: never) => { registered.push(tool as never); return () => {} } },
    sessions: {}, subagents: {},
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  const exec = { agent: { id: 'cockpit', session: { header: { cwd: BASE } } } }
  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = registered.find((item) => item.name === name)
    assert.ok(tool !== undefined, `${name} 必须注册进工具表`)
    return String(await tool.execute(args, exec))
  }
  await callTool('sdo_init', { name: 'R29 演练', process: 'waterfall', scale: 'normal', stakeholders: '运维' })
  // ① 不存在的门禁（waterfall 没有 GP）
  const refused = await callTool('sdo_gate', { action: 'waive', gate: '原型验收门禁（GP）', reason: '覆盖测试', approver: 'cockpit' })
  assert.doesNotMatch(refused, /已豁免/u, `不存在的门禁不许说"已豁免"：${refused.slice(0, 160)}`)
  assert.doesNotMatch(refused, /判定记录已写入/u, `没落盘就不许说"已写入"：${refused.slice(0, 200)}`)
  assert.match(refused, /gate\.unknown/u, '要给出判定')
  assert.match(refused, /G0.*G7/u, '要给出可用门禁清单')
  // 台账零写入
  const journal = new Journal(new SdoStore(join(BASE, '.sdo')))
  assert.equal(journal.read().events.filter((event) => event.type === 'tailoring/updated').length, 0, '不许写裁剪')
  // ② 真实门禁 ⇒ 照旧说"已豁免"且**确实**落盘
  const ok = await callTool('sdo_gate', { action: 'waive', gate: 'G4', reason: '本项目不需要详设门', approver: '张三', quote: '确认豁免详设门' })
  assert.match(ok, /已豁免/u, `真实门禁要照旧：${ok.slice(0, 120)}`)
  assert.match(ok, /判定记录已写入/u, '真的写了才说已写入')
  assert.equal(existsSync(join(BASE, '.sdo', 'gates', 'G4.json')), true, '判定文件要真的存在')
  // ③ 判据层：`persisted` 必须与"文件是否真的存在"一致
  const failure = officeOf(BASE).checkGate({ sessionId: 'cockpit', cwd: BASE }, '原型验收门禁（GP）')
  assert.equal(failure.persisted, true, 'check 路径确实落盘（walk 走的是普通判定）')
})
