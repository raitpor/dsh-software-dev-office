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

test('F-2：记账类事件不得作废设计签字（且必须真的进了中性表）', () => {
  const bookkeeping = [
    'dispatch/finished',
    'dispatch/reported',
    'dispatch/observe-failed',
    'plan/profile-decided',
    'test/mutation-recorded',
    'test/contract-test-recorded',
  ]
  for (const type of bookkeeping) {
    assert.equal((SIGNATURE_NEUTRAL_EVENTS as readonly string[]).includes(type), true, `${type} 应进 SIGNATURE_NEUTRAL_EVENTS`)
    assert.equal(isSignatureInvalidatingEvent('G3', type), false, `${type} 是记账，不得作废 G3 签字`)
  }
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
