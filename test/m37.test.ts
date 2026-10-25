/**
 * 签字失效口径与签字归一的回归（依据真机报告 `2026-10-05-插件测试报告-签字失效口径与记账事件.md`）。
 *
 * 三条真机缺陷：
 *   · **F-1（major）**：`sdo_gate action=sign` 把调用方传入的字符串**原样落盘**（真机留下
 *     `gate: 架构门禁（G3）`），而判定侧按内部编号 `G3` 精确过滤 ⇒ 那条签字**永远不被看见**；
 *     更糟的是同一次调用的回执用**入参**自证「当前有效」——工具回执与门禁结论互相矛盾。
 *   · **F-2（major）**：中性表漏了 5 条**记账类**事件（派发收尾/回报、实现包选择、变异与契约测试证据）
 *     ⇒ 签完 G3 只要继续正常干活，C-2D 就会翻红。
 *   · **F-3（major）**：`trace/linked` / `trace/unlinked` 一刀切失效，而施工期覆盖边（`req-task`/`req-tc`）
 *     **不进 `DESIGN.md`**（§8 追溯矩阵只列需求↔设计元素/契约/界面条目）。
 *
 * 本用例同时钉**反向**：该失效的仍必须失效（尤其 `risk/*` —— §11 会把风险渲染进文档），
 * 以及"不传 payload 时保守失效"（黑名单的默认方向不许被这次修改放宽）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { buildDispatch } from '../src/integration/orchestrator.js'
import { describeDispatchStarted } from '../src/interface/describe.js'
import { latestSignature, signatureState } from '../src/domain/signature.js'
import { SIGNATURE_NEUTRAL_EVENTS, isSignatureInvalidatingEvent } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'
import { renderTestReportSignable } from '../src/domain/reviewDoc.js'
import { currentJournalSeq, writeTestingSource } from '../src/domain/testingStore.js'
import { writeTestingDoc } from '../src/domain/testingRender.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm37')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 已签字的 G3 记录（结构与 `.sdo/gates/signatures.yml` 一致）。 */
const G3_SIGNATURE = {
  gate: 'G3',
  by: 'human',
  basis: '签字确认，批准通过',
  channel: 'question',
  at: '2026-10-05T01:53:07.392Z',
  atSeq: 573,
}

const fakeStore = (signatures: unknown[] = [G3_SIGNATURE]): SdoStore =>
  ({ readYaml: () => ({ signatures }) }) as unknown as SdoStore

const fakeJournal = (events: ReadonlyArray<{ seq: number; type: string; data?: unknown }>): Journal =>
  ({ read: () => ({ events, truncated: false }) }) as unknown as Journal

// —————————————————————— F-2 中性表 ——————————————————————

/**
 * **中性表的身份快照**（`TASK-240` 落点三）。
 *
 * 修前的写法是"手挑六条记账事件写成清单"，而那份清单**漏了** `dispatch/aborted`：G3 走**黑名单**
 * 口径（不在中性表里即失效）⇒ 把 `src/types.ts` 里那一行删掉，`isSignatureInvalidatingEvent` 会翻成
 * `true`（每次 `release` 都把 G3 签字判失效），而修前**一条用例都不红**（`REV-103` F6 的洞）。
 *
 * 现在两个方向都钉住（两态都红）：
 *   · **派生方向** —— 中性表里写着什么，判定就必须说"不失效"。整表逐条 ⇒ 新增一条中性事件自动被覆盖
 *     （不用改这份用例）。
 *   · **对账方向** —— 表的**成员身份**必须与下面这份快照逐条相等：表里多一条、少一条都红并**点名**。
 *     只靠派生方向对"少一条"是瞎的（表变了、判定跟着变，两边仍然自洽）。
 * 增删是**显式动作**：改 `src/types.ts` 之后同步这份快照，并在提交说明里写清为什么。
 */
const NEUTRAL_TABLE_SNAPSHOT = [
  'design/rendered',
  'doc/rendered',
  'project/environment',
  'gate/result',
  'gate/signed',
  'gate/sign-rejected',
  'gate/sign-unavailable',
  'phase/entered',
  'phase/exited',
  'phase/rolled-back',
  'plan/mode',
  'plan/review-blocked',
  'plan/review-approved',
  'plan/review-waived',
  'dispatch/decided',
  'dispatch/started',
  'dispatch/finished',
  'dispatch/claim-missing',
  'dispatch/aborted',
  'task/claim-rejected',
  'dispatch/reported',
  'dispatch/observe-failed',
  'dispatch/observed',
  'dispatch/reuse-skipped',
  // **`TASK-228`（`REV-116` 必核四①）**：池候选的一次性退役（`pool/retired`）。纯记账：它只记
  // "谁被移出池"，不改任何设计真源（需求/设计/契约/追溯边一概不动）⇒ 与 `dispatch/reuse-skipped`
  // 同类，**不得**作废 G3 签字。加进中性表的同一批把它登记进 `SdoEventType` 联合并删掉写侧的
  // `as SdoEventType` 断言 —— 三件事必须一起做（联合是"写过哪些事件"的唯一枚举）。
  'pool/retired',
  'worktree/created',
  'worktree/merged',
  'worktree/conflict',
  'worktree/removed',
  'plan/profile-decided',
  'iteration/updated',
  'task/created',
  'task/updated',
  'task/claimed',
  'task/released',
  'task/errata',
  'task/reopened',
  'task/restored',
  'task/done',
  'task/blocked',
  'task/unblocked',
  'task/claim-blocked',
  'task/dropped',
  'review/recorded',
  'review/verified',
  'review/hashed',
  'review/appended',
  'test/recorded',
  'test/case-updated',
  'test/mutation-recorded',
  'test/contract-test-recorded',
  'defect/recorded',
  'defect/updated',
  'delivery/packaged',
  'delivery/run-recorded',
  'evidence/recorded',
  'cost/updated',
  'cost/sample',
  'budget/decision',
  'change/requested',
  'change/decided',
  'change/noop',
  'feasibility/assessed',
  'redteam/mode',
  'redteam/attack',
  'redteam/propose',
  'redteam/model-proposed',
  'redteam/file',
  'issue/opened',
  'issue/closed',
  'quality/recorded',
] as const

test('F-2 派生方向：中性表里写什么，G3 就判"不失效"（整表逐条，新增一条自动被覆盖）', () => {
  for (const type of SIGNATURE_NEUTRAL_EVENTS) {
    assert.equal(
      isSignatureInvalidatingEvent('G3', type),
      false,
      `${type} 在中性表里 ⇒ G3 必须判"不失效"（黑名单口径的读侧与表各说各话，只能在很久以后被发现）`,
    )
  }
})

test('F-2 对账方向：中性表的成员身份与快照逐条相等（多一条/少一条都红并点名）', () => {
  const table = new Set<string>(SIGNATURE_NEUTRAL_EVENTS)
  const snapshot = new Set<string>(NEUTRAL_TABLE_SNAPSHOT)
  const added = [...table].filter((type) => !snapshot.has(type)).sort()
  const removed = [...NEUTRAL_TABLE_SNAPSHOT].filter((type) => !table.has(type)).sort()
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    '中性表成员身份变了：新增 [' + added.join(' ') + '] / 删除 [' + removed.join(' ') + ']'
      + '（增删都要同步 test/m37.test.ts 的快照，并说明为什么）',
  )
})

test('F-2 身份锚：`dispatch/aborted` 必须留在中性表（删了它 ⇒ 每次 release 都让 G3 签字失效）', () => {
  // 这条就是 `REV-103` F6 点名的那一行：上面对账已在"删掉它"时红，这里再把**为什么**钉在同处。
  assert.equal((SIGNATURE_NEUTRAL_EVENTS as readonly string[]).includes('dispatch/aborted'), true, 'dispatch/aborted 必须中性（release 每次都会落它，而它不改设计真源）')
  assert.equal(isSignatureInvalidatingEvent('G3', 'dispatch/aborted'), false, '它是纯记账 ⇒ 不得作废 G3 签字')
})


test('F-2 反向：改设计文档/设计承诺的事件仍必须失效（口径不许改宽）', () => {
  const stillInvalidating = [
    'design/updated',
    'design/ui-updated',
    'design/artifact-updated',
    'design/confirmed',
    'contract/recorded',
    'contract/updated',
    'adr/recorded',
    'requirement/updated',
    'question/answered',
    // **实测依据**：`DESIGN.md` 的 §11 会把风险渲染进文档（真机 §11 列有 RISK-006）⇒ 登记风险确实改文档
    'risk/logged',
    'risk/updated',
  ]
  for (const type of stillInvalidating) {
    assert.equal(isSignatureInvalidatingEvent('G3', type), true, `${type} 会改设计真源，必须作废 G3 签字`)
  }
})

// —————————————————————— F-3 追溯边按作用域 ——————————————————————

test('F-3：追溯边按作用域区分 —— req-des 失效，req-task / req-tc 不失效', () => {
  assert.equal(isSignatureInvalidatingEvent('G3', 'trace/linked', { kind: 'req-des' }), true, '设计侧边改追溯矩阵')
  assert.equal(isSignatureInvalidatingEvent('G3', 'trace/linked', { kind: 'req-task' }), false, '任务覆盖边不进设计文档')
  assert.equal(isSignatureInvalidatingEvent('G3', 'trace/linked', { kind: 'req-tc' }), false, '用例覆盖边不进设计文档')
  assert.equal(isSignatureInvalidatingEvent('G3', 'trace/unlinked', { kind: 'req-task' }), false, '撤销覆盖边同理')
})

test('F-3 反向：不传 payload / kind 未知 ⇒ 保守失效（黑名单默认方向不变，既有断言不用改）', () => {
  assert.equal(isSignatureInvalidatingEvent('G3', 'trace/linked'), true, '只传类型时保守失效（m20 的既有断言依赖这一点）')
  assert.equal(isSignatureInvalidatingEvent('G3', 'trace/linked', {}), true, '缺 kind 时保守失效')
  assert.equal(isSignatureInvalidatingEvent('G3', 'trace/linked', { kind: 'brand-new-kind' }), true, '未知 kind 保守失效')
  assert.equal(isSignatureInvalidatingEvent('G3', 'future/brand-new-truth-write'), true, '未知事件类型仍默认失效')
})

test('G2 白名单口径不受本次改动影响', () => {
  assert.equal(isSignatureInvalidatingEvent('G2', 'requirement/updated'), true)
  assert.equal(isSignatureInvalidatingEvent('G2', 'design/updated'), false)
  assert.equal(isSignatureInvalidatingEvent('G2', 'dispatch/finished'), false)
})

test('端到端：签 G3 后挂施工期覆盖边 + 派发收尾 ⇒ 仍 valid；再加一条设计侧边 ⇒ 立刻 stale', () => {
  const constructionPhase = [
    { seq: 574, type: 'trace/linked', data: { from: 'REQ-013', to: 'TASK-045', kind: 'req-task' } },
    { seq: 575, type: 'trace/linked', data: { from: 'REQ-013', to: 'TC-014', kind: 'req-tc' } },
    { seq: 576, type: 'dispatch/finished', data: { task: 'TASK-043', role: 'developer' } },
    { seq: 577, type: 'dispatch/reported', data: { childSessionId: 'c1', report: 'r.md' } },
    { seq: 578, type: 'test/mutation-recorded', data: { task: 'TASK-043', killed: 5, survived: 0 } },
  ]
  assert.equal(signatureState(fakeStore(), fakeJournal(constructionPhase), 'G3').status, 'valid', '施工期记账不得作废签字')

  const withDesignEdge = [...constructionPhase, { seq: 579, type: 'trace/linked', data: { from: 'REQ-013', to: 'DES-DATA-ELITE', kind: 'req-des' } }]
  assert.equal(signatureState(fakeStore(), fakeJournal(withDesignEdge), 'G3').status, 'stale', '设计侧追溯边改了追溯矩阵 ⇒ 必须重签')
})

// —————————————————————— F-1 签字名归一 ——————————————————————

test('F-1 写入侧：用中文全名签字 ⇒ 落盘归一成内部编号，判定侧（按 G3 过滤）能看见它', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }
  const signature = office.signGate(call, { gate: '架构门禁（G3）', by: 'human', basis: '签字确认，批准通过', channel: 'question' })
  assert.equal(signature.gate, 'G3', `落盘必须归一成内部编号（真机缺陷：原样存了「架构门禁（G3）」）：${signature.gate}`)
  assert.equal(latestSignature(store, 'G3')?.atSeq, signature.atSeq, '判定侧按 G3 过滤必须能找到这条签字')
  assert.equal(signatureState(store, journal, 'G3').status, 'valid', '签字刚落盘、之后没有真源变更 ⇒ 有效')
  assert.equal(latestSignature(store, '架构门禁（G3）')?.atSeq, signature.atSeq, '读取侧也要认中文全名（同一个门禁）')
})

test('F-1 读取侧：兼容盘上已有的脏记录（`gate: 架构门禁（G3）`）—— 它必须**被真正采用**，而不是被过滤掉', () => {
  // 模拟真机台账里那条历史脏记录（`atSeq` 用小序号，好让"其后追加一条真源事件"能排到它后面）
  store.writeYaml(['gates', 'signatures.yml'], {
    signatures: [{ gate: '架构门禁（G3）', by: 'human', basis: '签字确认，批准通过', channel: 'question', at: '2026-10-05T01:53:07.392Z', atSeq: 1 }],
  })
  assert.equal(latestSignature(store, 'G3')?.atSeq, 1, '带括号编号的中文名要认成 G3（否则这条签字永远不被看见）')
  // 只写一条签字事件（与台账一致），其后没有失效事件 ⇒ 有效
  journal.append('gate/signed', { gate: 'G3', by: 'human', basis: '签字确认，批准通过', channel: 'question' })  // seq=1
  assert.equal(signatureState(store, journal, 'G3').status, 'valid', '脏记录被采用后，应当有效而不是「缺失」')

  // 反向：**它真的生效**——之后追加一条改设计真源的事件，立刻 stale（说明不是"被忽略"）
  journal.append('design/updated', { kind: 'component', id: 'DES-CMP-X' })  // seq=2，排在那条脏签字之后
  assert.equal(signatureState(store, journal, 'G3').status, 'stale', '脏记录被采用 ⇒ 失效判定也要跟着它生效')
})

test('F-1 回执基于**落盘后**的记录：sign 回执不得用入参自证有效（真机同秒两条矛盾输出的根因）', () => {
  const index = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(
    index,
    /describeSignature\(signature, office\.signatureState\(call, args\.gate\)\)/u,
    '不许用调用方传入的字符串判状态（那正是"回执说有效、门禁说失效"的来源）',
  )
  assert.match(index, /describeSignature\(signature, office\.signatureState\(call, signature\.gate\)\)/u, '状态必须基于落盘后的记录')
})

// —————————————————————— F-4：能力 ≠ 本次复用 ——————————————————————

function dispatchRequest(): Parameters<typeof describeDispatchStarted>[0] {
  const task: TaskCard = {
    id: 'TASK-050', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/x/'], role: 'developer', size: 'small', revision: 1, status: 'ready',
    requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  return {
    task, backend: 'subagent', owner: 'subagent:developer:1', persona: 'sdo-developer',
    toolDeny: ['sdo_gate'], sdoAllow: ['sdo_task'], prompt: 'P', expectedRevision: 1, writeScopes: ['src/x/'],
  }
}

test('F-4：回执把「宿主有复用能力」与「本次是否真的复用」分成两句，并写出观测到的 mode', () => {
  const reused = describeDispatchStarted(dispatchRequest(), 'spawn', 'child-1', dispatchRequest().toolDeny, true, true, [], { reused: true, mode: 'continuable' })
  assert.match(reused, /复用\*\*能力\*\*/u, `能力那句要说清是能力：${reused.slice(0, 300)}`)
  assert.match(reused, /本次派发：.*复用了同一个子代理.*mode=continuable/u, `必须写出本次事实与 mode：${reused.slice(0, 400)}`)

  const fresh = describeDispatchStarted(dispatchRequest(), 'spawn', 'child-2', dispatchRequest().toolDeny, true, true, [], { reused: false, mode: 'continuable' })
  assert.match(fresh, /本次派发：.*新起了一个子代理.*mode=continuable/u, '没复用就要直说（真机 10 次派发 0 次复用）')

  // 反向：能力不可用时**不许**宣称本次复用
  const oneShot = describeDispatchStarted(dispatchRequest(), 'spawn', 'child-3', dispatchRequest().toolDeny, true, false, [], { reused: false, mode: 'one-shot' })
  assert.match(oneShot, /复用\*\*能力\*\*：宿主没暴露可续聊入口/u)
  assert.match(oneShot, /新起了一个子代理/u)
})

// —————————————————————— F-7：报告必须自证「本轮写了什么」 ——————————————————————

test('F-7：派发协议要求执行者列出本轮**实际写入**的文件（防"上一次会话的残留算本轮产出"）', () => {
  const request = buildDispatch({ task: dispatchRequest().task, backend: 'subagent', owner: 'subagent:developer:1', projectName: 'P' })
  assert.match(request.prompt, /实际写入/u, '协议里要有"列出本轮实际写入的文件"')
  assert.match(request.prompt, /mtime/u, '要带上 mtime（真机就是靠 mtime 对出来的）')
  assert.match(request.prompt, /零产品改动/u, '没改动也要明说')
})

// —————————————————————— TASK-018：测试总结报告 → 签字通道（REQ-051） ——————————————————————
//
// DoD 三条：① 报告由真源渲染、带渲染头与内容指纹；② 渲染幂等（同源两次逐字节一致）；
// ③ 改真源 ⇒ 报告判过期。
//
// 边界（先核实再落笔，防与 TASK-001 重复）：报告**本身**（渲染 / 渲染头 / 指纹 / 幂等写入 /
// `改真源 ⇒ 过期`）已由 `testingRender.ts` + `testingStore.ts` 交付；本卡补的是**签字通道**
// （`reviewDoc.ts`）：在此之前 `grep TESTREPORT|report.yml` 在 testing 三个模块之外**零命中** ——
// 报告渲染得出来，却没有签字入口。所以这组用例盯的是「投影到签字面」的三件事是否成立。

const REPORT_BASE = join(ROOT, 'node_modules', '.sdo-test', 'm37-report')

/** 报告真源夹具（一条准出准则 + 变异 kill 率）。 */
function reportSource(threshold = '80%'): Record<string, unknown> {
  return {
    exitCriteria: [{
      id: 'C-53', criterion: '语句覆盖', metric: 'statement',
      threshold, scope: 'src/domain', verdict: 'pass',
    }],
    mutationKillRate: '0.9',
  }
}

/** 建一份「已渲染 + 已登记」的报告：返回 store / journal / 登记。 */
function reportFixture(threshold = '80%'): {
  store: SdoStore
  journal: Journal
  write: ReturnType<typeof writeTestingDoc>
} {
  rmSync(REPORT_BASE, { recursive: true, force: true })
  mkdirSync(join(REPORT_BASE, '.sdo', 'testing'), { recursive: true })
  const fixtureStore = new SdoStore(join(REPORT_BASE, '.sdo'))
  const fixtureJournal = new Journal(fixtureStore)
  writeTestingSource(fixtureStore, 'report', 'report', reportSource(threshold), fixtureJournal)
  const seq = currentJournalSeq(fixtureStore, fixtureJournal)
  const write = writeTestingDoc(fixtureStore, 'report', { seq }, fixtureJournal)
  return { store: fixtureStore, journal: fixtureJournal, write }
}

test('TASK-018 报告带渲染头与内容指纹，且投影到签字面', () => {
  const { store: fixtureStore, write } = reportFixture()
  const signable = renderTestReportSignable({ store: fixtureStore })
  assert.equal(signable.kind, 'report')
  assert.equal(signable.path, 'docs/TESTREPORT.md', '签字面要指向用户看的那份报告')
  assert.notEqual(signable.title.trim(), '', '标题取自真源元信息，不许为空')
  // 渲染头：第一行自证「谁生成的」，第二行自证「从哪份真源、第几号事件」——
  // 断言**盘上那份**（不是返回值里的副本）：用户点的就是盘上这份。
  const onDisk = readFileSync(join(REPORT_BASE, 'docs', 'TESTREPORT.md'), 'utf8')
  assert.match(onDisk, /^<!-- generated by /u, '首行必须是生成器自证头')
  assert.match(onDisk, /source: \.sdo\/testing\/report\.yml/u, '渲染头要写清真源落点')
  assert.match(onDisk, /@ journal seq \d+/u, '渲染头要写清对应真源的第几号事件')
  assert.equal(signable.payload.items[0]?.content, onDisk, '签字面拿到的正文必须与盘上那份逐字节相同')
  // 内容指纹与登记一致 ⇒ 这份报告就是当前真源的渲染
  assert.equal(signable.fingerprint, write.fingerprint, '投影出来的指纹必须与登记时的真源指纹同口径')
  assert.match(signable.fingerprint, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(signable.stale, false, '刚渲染完的报告不该判过期')
  assert.equal(signable.sourceChanged, false)
  assert.equal(signable.unregistered, false)
  // 受审载荷：签字面拿到的必须是**报告正文**，而不是一句"已渲染"
  const item = signable.payload.items[0]
  assert.equal(signable.payload.collection, 'testing/report.yml')
  assert.equal(item?.path, 'docs/TESTREPORT.md')
  assert.match(String(item?.content), /# /u, '载荷正文要有 Markdown 标题')
  assert.match(String(item?.content), /C-53/u, '载荷正文要带逐条结论')
})

test('TASK-018 幂等：同一份真源投影两次逐字节一致（含渲染头里的 seq）', () => {
  const { store: fixtureStore, write } = reportFixture()
  const first = renderTestReportSignable({ store: fixtureStore })
  const second = renderTestReportSignable({ store: fixtureStore })
  assert.deepEqual(second, first, '同真源两次投影必须完全一致（结构逐字段相等）')
  assert.equal(String(second.payload.items[0]?.content), String(first.payload.items[0]?.content), '正文逐字节一致')
  assert.equal(second.renderSeq, first.renderSeq, 'seq 也必须是同一个（否则渲染头就变了）')
  assert.equal(first.renderSeq, write.seq, 'seq 取登记里的那个 —— 这正是幂等的口径')

  // 反例（防"幂等"是恒真断言）：换一个 seq 渲染，正文与渲染头必须**变**
  const other = renderTestReportSignable({ store: fixtureStore, renderSeq: first.renderSeq + 1 })
  assert.notEqual(
    String(other.payload.items[0]?.content),
    String(first.payload.items[0]?.content),
    'seq 变了正文就得变 —— 否则"逐字节一致"这条断言什么都没证明',
  )
})

test('TASK-018 守卫：改真源 ⇒ 报告判过期（点名"真源改了"，不是"来路不明"）', () => {
  const { store: fixtureStore, journal: fixtureJournal, write } = reportFixture()
  const before = renderTestReportSignable({ store: fixtureStore })
  assert.equal(before.stale, false, '前提：改之前是当前的')

  // 改真源（阈值 80% → 95%）——**不重新渲染**
  writeTestingSource(fixtureStore, 'report', 'report', reportSource('95%'))
  const after = renderTestReportSignable({ store: fixtureStore })
  assert.equal(after.sourceChanged, true, '真源内容指纹与登记不符 ⇒ sourceChanged')
  assert.equal(after.stale, true, '改真源 ⇒ 报告判过期')
  assert.equal(after.unregistered, false, '这是"真源改了"，不是"来路不明"（两者必须分得开）')
  assert.notEqual(after.fingerprint, write.fingerprint, '指纹必须真的变了（否则断言恒真）')
  assert.notEqual(after.fingerprint, before.fingerprint)

  // 反向：重新渲染 ⇒ 立刻回到"当前"（证明上面判的不是"永远红"）
  // ⚠️ 必须传**同一个 journal 实例**：不传时 `writeTestingDoc` 自建一个 `Journal`，
  // 登记事件落进真源但读不回来 ⇒ `renderStale` 仍看到旧登记（实测踩到，M37 一度红）。
  writeTestingDoc(fixtureStore, 'report', { seq: currentJournalSeq(fixtureStore, fixtureJournal) }, fixtureJournal)
  const reRendered = renderTestReportSignable({ store: fixtureStore })
  assert.equal(reRendered.stale, false, '重渲染后必须回到当前')
  assert.equal(reRendered.sourceChanged, false)
})

test('TASK-018 无渲染登记 ⇒ 同样不许签（fail-closed，且理由标"来路不明"）', () => {
  // 只写真源、**不登记渲染**：盘上那份报告不可能是"当前真源的渲染"
  rmSync(REPORT_BASE, { recursive: true, force: true })
  mkdirSync(join(REPORT_BASE, '.sdo', 'testing'), { recursive: true })
  const loneStore = new SdoStore(join(REPORT_BASE, '.sdo'))
  writeTestingSource(loneStore, 'report', 'report', reportSource())
  const signable = renderTestReportSignable({ store: loneStore })
  assert.equal(signable.unregistered, true, '没有登记 ⇒ 来路不明')
  assert.equal(signable.stale, true, '来路不明的报告不许当作"当前真源的渲染"被签')
  assert.equal(signable.sourceChanged, false, '没有可比对的登记指纹 ⇒ 不能报"真源改了"（那是另一种动作）')
})
