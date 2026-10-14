/**
 * P-1：**真派发**。宿主 `subagents.start(provider, request)` 起一次子代理运行。
 *
 * 之前这一步是空的（回执让流程官自己 `send_message` 桥接），被 sdo-test 的测试报告列为 blocker。
 * 本文件盯三件事：
 *   ① 传给宿主的参数**逐项正确**（提示词、persona、`toolFilter.allow`=角色掩码、`deny`、`maxDepth`）；
 *   ② 宿主缺失/未注册 provider/拿不到发起 agent/`start` 抛错时**如实返回"没派出去"**（绝不假装成功）；
 *   ③ 接线：`sdo_plan action=next` 真的调用它，并把子会话 id 记进台账。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { reuseCapability, startDispatch } from '../src/integration/dispatch.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { loadAllProcesses } from '../src/domain/process.js'
import { CHECKERS } from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import {
  assessOutline,
  describeOutlineVerdict,
  ensureOutline,
  generateOutline,
  outlineRemedy,
} from '../src/domain/acceptance.js'
import { validateTestingSet } from '../src/domain/testingShapes.js'
import type { TestingShapeKnown } from '../src/domain/testingShapes.js'
import type { Requirement } from '../src/types.js'
import { describeDispatchStarted } from '../src/interface/describe.js'
import { toolNamesOfHeader } from '../src/domain/dispatchFace.js'
import type { DispatchRequest } from '../src/integration/orchestrator.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

const request: DispatchRequest = {
  task: { id: 'TASK-001', role: 'developer' } as never,
  backend: 'subagent',
  owner: 'subagent:developer:1',
  persona: 'sdo-developer',
  toolDeny: ['sdo_review', 'sdo_gate'],
  sdoAllow: ['sdo_task'],
  prompt: '你是 sdo-developer……协议：① claim ② 只改写范围内文件 ③ done 附证据',
  expectedRevision: 3,
  writeScopes: ['src/det/'],
}

/** 记录宿主收到的参数，便于逐项断言。 */
function fakeRuntime(options: { providers?: string[]; fail?: string; toolFilter?: boolean | undefined; getProviderThrows?: boolean } = {}) {
  const calls: { name: string; request: Record<string, unknown> }[] = []
  const runtime = {
    list: () => options.providers ?? ['spawn'],
    getProvider: (name: string) => {
      if (options.getProviderThrows === true) throw new Error('provider 查询失败')
      return options.toolFilter === undefined ? { name } : { name, capabilities: { toolFilter: options.toolFilter } }
    },
    start: async (name: string, payload: unknown) => {
      calls.push({ name, request: payload as Record<string, unknown> })
      if (options.fail !== undefined) throw new Error(options.fail)
      return { id: 'session-child-1' }
    },
  }
  return { runtime, calls }
}

test('M32-01 P-1 真派发：参数逐项下发（提示词/persona/allow=掩码/deny/maxDepth）', async () => {
  const { runtime, calls } = fakeRuntime({ toolFilter: true })
  const outcome = await startDispatch({
    runtime,
    provider: 'spawn',
    agent: { id: 'session-parent' },
    request,
    deny: ['sdo_review', 'sdo_gate'],
    maxDepth: 1,
  })
  assert.deepEqual(
    outcome,
    // 本轮新增：宿主给这个子代理的模式 + 这次是否复用（角色池/队列的判据）
    { started: true, provider: 'spawn', childSessionId: 'session-child-1', toolFilterDeclared: true, reuseSupported: false, reused: false, mode: 'one-shot' },
    '能力值只是"provider 的声明"，不代表"宿主已经收窄了工具面"（见 M32-06）',
  )
  assert.equal(calls.length, 1)
  const sent = calls[0] as { name: string; request: Record<string, unknown> }
  assert.equal(sent.name, 'spawn')
  assert.deepEqual(sent.request.prompt, [{ type: 'text', text: request.prompt }], '提示词要原样交给宿主')
  // **2026-10-08 口径纠正**：只发 deny。发 allow 会把宿主/harness 的整个通用面
  // （技能/记忆/联网…）也隐藏掉 —— 真机事故就是子代理报「无法使用 technique_apply」。
  assert.deepEqual(sent.request.toolFilter, { deny: ['sdo_review', 'sdo_gate'] }, '只发 deny，不发 allow')
  assert.equal(sent.request.persona, 'sdo-developer')
  assert.equal(sent.request.maxDepth, 1, '深度要限住（子代理不再开子代理）')
  assert.deepEqual(sent.request.parent, { id: 'session-parent' }, 'parent 必须是发起 agent')
  assert.ok(sent.request.signal instanceof AbortSignal, '要给出取消信号')
  assert.match(String(sent.request.label), /TASK-001/u, 'label 要能认出是哪张卡')
})

test('M32-02 P-1 三种"没派出去"都要如实返回原因（且绝不调用 start）', async () => {
  // ① 没有宿主服务
  const none = await startDispatch({ runtime: undefined, provider: 'spawn', agent: {}, request, deny: [], maxDepth: 1 })
  assert.deepEqual(none, { started: false, reason: 'no-service', detail: '宿主没有 subagents 服务（或该服务没有 start）' })

  // ② provider 没注册（并把可用列表带出来）
  const wrongProvider = fakeRuntime({ providers: ['native-team'] })
  const missing = await startDispatch({ runtime: wrongProvider.runtime, provider: 'spawn', agent: {}, request, deny: [], maxDepth: 1 })
  assert.equal(missing.started, false)
  assert.equal(missing.started === false ? missing.reason : '', 'no-provider')
  assert.match(missing.started === false ? missing.detail : '', /native-team/u, '要告诉用户有哪些可用 provider')
  assert.equal(wrongProvider.calls.length, 0, '没注册就不该调用 start')

  // ③ 拿不到发起 agent（宿主要求 live Agent）
  const noParent = fakeRuntime()
  const orphan = await startDispatch({ runtime: noParent.runtime, provider: 'spawn', agent: undefined, request, deny: [], maxDepth: 1 })
  assert.equal(orphan.started, false)
  assert.equal(orphan.started === false ? orphan.reason : '', 'no-parent')
  assert.equal(noParent.calls.length, 0)
})

test('M32-03 P-1 宿主抛错 → 没派出去（带原始原因），不得假装成功', async () => {
  const { runtime } = fakeRuntime({ fail: '深度超限：已达上限 1' })
  const outcome = await startDispatch({ runtime, provider: 'spawn', agent: { id: 'a' }, request, deny: [], maxDepth: 1 })
  assert.equal(outcome.started, false)
  assert.equal(outcome.started === false ? outcome.reason : '', 'failed')
  assert.match(outcome.started === false ? outcome.detail : '', /深度超限/u, '要把宿主的原因原样带回来')

  // 反向：宿主返回的 run 没有可用 id → 也算没派出去（否则台账会记一个空会话）
  const empty = {
    list: () => ['spawn'],
    start: async () => ({ id: undefined }),
  }
  const blank = await startDispatch({ runtime: empty, provider: 'spawn', agent: { id: 'a' }, request, deny: [], maxDepth: 1 })
  assert.equal(blank.started, false)
  assert.equal(blank.started === false ? blank.reason : '', 'failed')
})

test('M32-04 P-1 接线：sdo_plan next 必须真的调用 startDispatch 并把子会话 id 记进台账', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /await startDispatch\(\{/u, 'plan next 必须 await startDispatch')
  assert.match(index, /runtime: subagentsApi/u, 'runtime 用软探测到的 subagents 服务')
  assert.match(index, /provider: settings\.dispatchProvider/u, 'provider 取自配置')
  assert.match(index, /agent: call\.agent/u, 'parent 用本次调用的发起 agent')
  assert.match(index, /office\.recordDispatchStarted\(call/u, '派发成功要留痕（子会话 id）')
  assert.match(index, /describeDispatchStarted\(/u, '成功回执要走"已真正派发"那一条')
  assert.match(index, /fmt\('uiIndex\.kDispatchNotStarted'/u, '失败要用 fmt 如实给出原因（不是假装）')
  // 配置项与描述函数都在
  const config = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8')
  assert.match(config, /dispatchProvider: z\.string\(\)\.default\('spawn'\)/u)
  assert.match(config, /dispatchMaxDepth: z\.number\(\)[\s\S]{0,40}default\(1\)/u)
  const describe = readFileSync(join(ROOT, 'src', 'interface', 'describe.ts'), 'utf8')
  assert.match(describe, /export function describeDispatchStarted/u)
})

test('M32-05 P-1 能力**声明**如实带回（注意：声明 ≠ 生效，真机 spawn 就是声明 true 却没生效）', async () => {
  const supported = await startDispatch({ runtime: fakeRuntime({ toolFilter: true }).runtime, provider: 'spawn', agent: { id: 'a' }, request, deny: [], maxDepth: 1 })
  assert.equal(supported.started && supported.toolFilterDeclared, true, '声明支持 → true')

  const unsupported = await startDispatch({ runtime: fakeRuntime({ toolFilter: false }).runtime, provider: 'spawn', agent: { id: 'a' }, request, deny: [], maxDepth: 1 })
  assert.equal(unsupported.started && unsupported.toolFilterDeclared, false, '声明不支持 → false')

  // 反向：查不到能力 / 查询抛错，都按「未声明」处理（不替宿主打包票）
  const unknown = await startDispatch({ runtime: fakeRuntime().runtime, provider: 'spawn', agent: { id: 'a' }, request, deny: [], maxDepth: 1 })
  assert.equal(unknown.started && unknown.toolFilterDeclared, false)
  const thrown = await startDispatch({ runtime: fakeRuntime({ getProviderThrows: true }).runtime, provider: 'spawn', agent: { id: 'a' }, request, deny: [], maxDepth: 1 })
  assert.equal(thrown.started && thrown.toolFilterDeclared, false)
})

test('M32-06 P-1 回执按事实说话：不支持 toolFilter 时不得写「它看不到掩码外的工具」', () => {
  // 两种声明值下，回执都**不得**断言"它看不到掩码外的工具"（真机已推翻），且都必须写明"不可自证"
  for (const declared of [true, false]) {
    const text = describeDispatchStarted(request, 'spawn', 'session-child-1', request.toolDeny, declared)
    assert.match(text, /下发给宿主/u, '要说明我们做了下发')
    assert.match(text, /capabilities\.toolFilter/u, '要给出 provider 声明的能力值（作为事实，不作为保证）')
    assert.match(text, /无法自证|不可自证/u, '必须明说"是否收窄本插件不能自证"')
    assert.match(text, /钩子/u, '要说明兜底拦调用的是钩子')
    assert.doesNotMatch(text, /看不到掩码外的工具/u, '不得写与真机事实相反的断言')
  }
  // 真机反例要留在文案里（评审要求：把宿主侧发现如实带出）
  const text = describeDispatchStarted(request, 'spawn', 'session-child-1', request.toolDeny, true)
  assert.match(text, /sdo_plan|sdo_review|sdo_gate/u, '要带上真机反例的工具名')

  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /outcome\.toolFilterDeclared/u, '回执必须带 provider 的声明值')
  const dispatch = readFileSync(join(ROOT, 'src', 'integration', 'dispatch.ts'), 'utf8')
  assert.match(dispatch, /capabilities\?\.toolFilter === true/u, '声明值只看显式 true')
  assert.match(dispatch, /声明值/u, '要把「声明≠生效」写进代码注释，避免下一个人再据此打包票')
})

// —————————————————————— 评审 §4.2：把"工具面是否收窄"变成可观察 ——————————————————————

test('M32-07 观测的纯函数：从头里取工具名；回执按观测结果说实话', () => {
  assert.deepEqual(toolNamesOfHeader({ tools: [{ name: 'sdo_gate' }, { name: 'read' }, { name: 'read' }] }), ['read', 'sdo_gate'], '去重并排序')
  assert.deepEqual(toolNamesOfHeader({ tools: [{ nope: 1 }, 'x', null] }), [], '结构不对就当空，不猜')
  assert.deepEqual(toolNamesOfHeader(undefined), [])

  // 回执：**公告面与执行面分开讲**（真机那个子会话公告面干净、执行面却有 3 次越界调用）
  const real = describeDispatchStarted(request, 'spawn', 'child-1', request.toolDeny, true, false, [
    { childSessionId: 'child-1', tools: ['bash', 'edit', 'read', 'sdo_task'], violations: [], calls: ['sdo_plan', 'sdo_review', 'sdo_gate'] },
  ])
  assert.match(real, /公告面/u, '要有公告面那行')
  assert.match(real, /执行面/u, '要有执行面那行')
  assert.match(real, /3 次掩码外调用/u, '执行面的次数要如实（callCount）')
  assert.match(real, /去重后 3 个工具/u, '去重后的工具数也要给（两个口径分开写）')
  assert.match(real, /child-tools\.jsonl/u, '要指路：观测持续写进台账（否则这份数据没人看）')

  // 同一次调用重复 3 次：次数 3、去重 1 —— 数字与口径必须对得上
  const repeated = describeDispatchStarted(request, 'spawn', 'child-2', request.toolDeny, true, false, [
    { childSessionId: 'child-2', tools: ['read'], violations: [], calls: ['sdo_gate'], callCount: 3 },
  ])
  assert.match(repeated, /3 次/u)
  assert.match(repeated, /去重后 1 个工具/u)
  assert.match(real, /sdo_gate/u, '要点名越界调用')
  assert.match(real, /不等于调用被挡住/u, '公告面干净时必须说明它不等于调用被挡住')

  const announcedDirty = describeDispatchStarted(request, 'spawn', 'child-1', request.toolDeny, true, false, [
    { childSessionId: 'child-1', tools: ['read', 'sdo_gate'], violations: ['sdo_gate'], calls: [] },
  ])
  assert.match(announcedDirty, /仍被公告/u, '公告面就有越界时要单独说')
  const allClean = describeDispatchStarted(request, 'spawn', 'child-1', request.toolDeny, true, false, [
    { childSessionId: 'child-1', tools: ['read', 'edit'], violations: [], calls: [] },
  ])
  assert.match(allClean, /未观测到掩码外调用/u, '执行面干净也要说清')

  // 接线：监听器要认 `request/header` 并按角色算"掩码外工具"
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /eventType === 'request\/header'/u, '要处理 request/header')
  assert.match(index, /office\.dispatchedChildren\(/u, '只认我们自己派发出去的子会话')
  assert.match(index, /maskAllows\(role, tool, \{ executor: true \}\)/u, '按角色掩码算越界工具（子会话 = 执行者）')
  assert.match(index, /eventType === 'tool\/call'/u, '执行面也要观测（对未公告工具的调用）')
  assert.match(index, /toolCallNameOf\(event\)/u, '从 tool/call 取工具名')
  assert.match(index, /k208FaceBlockHeader/u, 'sdo_status 要有观测块头')
  assert.match(index, /childFaceLines\(faces\)\.join/u, 'sdo_status 要真的把观测行拼进去')
  // 状态块会随新块（未消化变更、角色池）继续长，所以判据只钉"**两条分支都带观测块**"这件事：
  // 写死整条拼接表达式会随每次加块而漂（本守卫已经因此改过两轮）。
  const statusReturns = index
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('return') && line.includes('finishedBlock'))
  assert.equal(statusReturns.length, 2, `status 的两条分支（无参数 / --rebuild）都要带上观测块：${statusReturns.join(' | ')}`)
  for (const line of statusReturns) assert.match(line, /faceBlock/u, `这两条分支都要拼上观测块：${line}`)
  assert.match(index, /office\.childFaces\(call\)/u, '派发回执要展示已观测的工具面')
})

test('M32-08 复用探测（方案 1 的插件侧半个）：宿主没有 continuable 入口就如实说 one-shot，探到才改口径', async () => {
  // 宿主事实（读码，2026-10-05 更正）：`dsh-subagent` 的**便捷方法** `start(name, request)` 把描述符
  // 写死 `mode:"one-shot"`，但**同一个服务**还暴露 `startContinuable(spec)`（L2879 → 实现 L1671）与
  // `sendMessage(...)`（L2897，"空闲的目标会起一轮"）⇒ 复用**是可用的**，缺的只是插件侧实现。
  // 本用例钉的是**探测口径**：只看"显式入口在不在"，不看宿主版本号或猜测。
  const base = { start: async () => ({}) }
  assert.equal(reuseCapability(base).supported, false, '没有显式入口就按不支持（fail-safe）')
  for (const name of ['startContinuable', 'activate', 'resume']) {
    assert.equal(reuseCapability({ ...base, [name]: () => undefined }).supported, true, `探到 ${name} 就要认`)
  }
  const notSupported = describeDispatchStarted(request, 'spawn', 'child-1', request.toolDeny, false, false, [])
  assert.match(notSupported, /复用\*\*能力\*\*/u, '要有这一行，且必须说清是"能力"')
  assert.match(notSupported, /没暴露可续聊入口|每次派发都是新会话/u, '不支持时要说清每次派发都是新会话')
  const supported = describeDispatchStarted(request, 'spawn', 'child-1', request.toolDeny, false, true, [])
  assert.match(supported, /宿主提供了可续聊入口/u, '支持时口径要变')
  assert.doesNotMatch(supported, /没暴露可续聊入口/u)
  // **F-4（2026-10-05 真机）**：能力那句**不许**被读成"本次复用了" —— 传了本次事实就必须另起一句写清
  const withFact = describeDispatchStarted(request, 'spawn', 'child-1', request.toolDeny, false, true, [], { reused: false, mode: 'one-shot' })
  assert.match(withFact, /本次派发：.*新起了一个子代理/u, '本次没复用就要直说（真机 10 次派发 0 次复用）')

  const outcome = await startDispatch({ runtime: fakeRuntime().runtime, provider: 'spawn', agent: { id: 'a' }, request, deny: [], maxDepth: 1 })
  assert.equal(outcome.started && outcome.reuseSupported, false, 'startDispatch 要把它带回来（否则回执拿不到）')
  const withActivate = await startDispatch({
    runtime: { ...fakeRuntime().runtime, activate: () => undefined },
    provider: 'spawn', agent: { id: 'a' }, request, deny: [], maxDepth: 1,
  })
  assert.equal(withActivate.started && withActivate.reuseSupported, true)
})

// ════════════════════════════════════════════════════════════════════════════════════════
// TASK-013（REQ-046）：**验收大纲左移到需求基线**
//
// DoD 三条：
//   ① 按每条 must 需求的每条 AC 生成 acceptance.yml（验收项 + 判定基准）；
//   ② 需求变更后**整份大纲失效**并在回执里点名；
//   ③ 守卫用例：改需求 ⇒ 大纲判过期。
//
// 这组用例同时盯**接线**（判据真的挂在 G2 上、check 键真的在 CHECKERS 里）——
// 只测域层会让"判据没挂上"或"键名拼错"一路绿到交付（TASK-012 的同类教训：入口守卫要先判种类）。
// ════════════════════════════════════════════════════════════════════════════════════════

const ACC_BASE = join(ROOT, 'node_modules', '.sdo-test', 'm32-acceptance')
const ACC_SDO = join(ACC_BASE, '.sdo')

let accStore: SdoStore
let accJournal: Journal

function freshAcc(): void {
  rmSync(ACC_BASE, { recursive: true, force: true })
  mkdirSync(ACC_SDO, { recursive: true })
  accStore = new SdoStore(ACC_SDO)
  accJournal = new Journal(accStore)
}

/** 一条 must 需求（带 N 条 AC）。 */
function requirement(id: string, acs: { id: string; given: string; when: string; then: string }[], priority = 'must'): Requirement {
  return {
    id,
    title: `${id} 的标题`,
    kind: 'functional',
    statement: 's',
    rationale: 'r',
    status: 'baselined',
    priority,
    source: 'user',
    acceptance: acs,
    revision: 1,
    version: 2,
    createdAt: '',
    updatedAt: '',
  } as unknown as Requirement
}

function twoMusts(): Requirement[] {
  return [
    requirement('REQ-046', [
      { id: 'AC-188', given: '需求基线冻结', when: '读取验收大纲', then: '每条 must 需求的每条 AC 都有对应验收项与判定基准' },
      { id: 'AC-189', given: '基线冻结后批准了一条需求变更', when: '跑需求基线门禁', then: '验收大纲与基线签字一并失效并要求重新生成' },
    ]),
    requirement('REQ-047', [
      { id: 'AC-191', given: '一个已完成开发的顺序流程项目', when: '尝试开始验证阶段的执行记账', then: '在测试计划通过计划评审之前被阻塞' },
    ]),
    // 非 must：**不进大纲**（大纲只覆盖 must）
    requirement('REQ-999', [{ id: 'AC-999', given: 'g', when: 'w', then: 't' }], 'should'),
  ]
}

const GEN = { generatedAt: '2026-10-13T09:00:00.000Z', generatedBy: 'human' }

test('M32-09 TASK-013 生成：每条 must 需求的每条 AC 一行（验收项 + 判定基准），非 must 不进大纲', () => {
  freshAcc()
  const generated = generateOutline({ requirements: twoMusts(), ...GEN })
  assert.equal(generated.outline.length, 3, '2 条 must 需求共 3 条 AC ⇒ 3 行（should 需求不进）')
  assert.deepEqual(
    generated.outline.map((entry) => `${entry.requirement}:${entry.ac}`),
    ['REQ-046:AC-188', 'REQ-046:AC-189', 'REQ-047:AC-191'],
    '按需求 id + AC id 排序 ⇒ 顺序稳定',
  )
  assert.deepEqual(generated.outline.map((entry) => entry.id), ['TA-001', 'TA-002', 'TA-003'], '大纲条目编号连续')
  for (const entry of generated.outline) {
    assert.notEqual(entry.item.trim(), '', '验收项不许为空')
    assert.notEqual(entry.baseline.trim(), '', '判定基准不许为空（"写清用什么判定它对不对"是 REQ-046 的硬要求）')
    assert.ok(entry.baseline.includes('Then'), `判定基准要指到判定依据：${entry.baseline}`)
  }
  assert.match(generated.requirementFingerprint, /^sha256:[0-9a-f]{64}$/u, '生成时绑定需求真源指纹')
})

test('M32-10 TASK-013 幂等：同一需求真源两次生成逐字节一致；ensureOutline 在已最新时不写盘', () => {
  freshAcc()
  const one = generateOutline({ requirements: twoMusts(), ...GEN })
  const two = generateOutline({ requirements: twoMusts(), ...GEN })
  assert.deepEqual(two, one, '同需求 + 同时刻 ⇒ 同大纲（重新生成是幂等的）')
  // 需求顺序颠倒不影响结果（指纹与行序都不依赖盘上顺序）
  const shuffled = generateOutline({ requirements: [...twoMusts()].reverse(), ...GEN })
  assert.deepEqual(shuffled, one, '需求顺序不该影响大纲（否则每次读盘顺序变了都判过期）')

  const first = ensureOutline({ store: accStore, requirements: twoMusts(), ...GEN })
  assert.equal(first.generated, true, '首次：没有大纲 ⇒ 生成')
  const path = join(ACC_SDO, 'testing', 'acceptance.yml')
  const bytes = readFileSync(path, 'utf8')
  const second = ensureOutline({ store: accStore, requirements: twoMusts(), ...GEN })
  assert.equal(second.generated, false, '已是最新 ⇒ **不写盘**（幂等，避免无意义的事件噪声）')
  assert.equal(readFileSync(path, 'utf8'), bytes, '盘上字节不变')
})

test('M32-11 TASK-013 守卫（DoD③）：改需求 ⇒ 整份大纲判过期，并在结论里点名变了的 AC', () => {
  freshAcc()
  ensureOutline({ store: accStore, requirements: twoMusts(), ...GEN })
  assert.equal(assessOutline(accStore, twoMusts()).verdict, 'ok', '前提：生成后是一致的')

  // 需求变更：给 REQ-046 增一条 AC（并改一条既有 AC 的 Then）
  const changed = twoMusts()
  changed[0] = requirement('REQ-046', [
    ...changed[0]!.acceptance,
    { id: 'AC-190', given: 'g', when: 'w', then: 't' },
  ])
  const stale = assessOutline(accStore, changed)
  assert.equal(stale.verdict, 'stale', '需求真源一变 ⇒ 整份大纲失效（REQ-046 的降级口径）')
  assert.notEqual(stale.recordedFingerprint, stale.currentFingerprint, '指纹能指出"生成时 vs 现在"不同')
  assert.deepEqual(stale.missing, ['REQ-046:AC-190'], '点名新缺的那条 AC')
  assert.match(describeOutlineVerdict(stale), /验收大纲与当前需求基线不一致/u, '回执要说清是"与基线不一致"')
  assert.match(outlineRemedy(), /重新生成/u, '补救办法要可执行')

  // 再生成 ⇒ 回到 ok（且这次真的写了盘）
  const again = ensureOutline({ store: accStore, requirements: changed, ...GEN })
  assert.equal(again.generated, true, '过期 ⇒ 重新生成')
  assert.equal(assessOutline(accStore, changed).verdict, 'ok')

  // 反向：需求**删**一条 AC ⇒ 大纲里那行变成"多余"，同样判过期并点名
  const shrunk = twoMusts().slice(1)
  const staleB = assessOutline(accStore, shrunk)
  assert.equal(staleB.verdict, 'stale', '删需求也算变更')
  assert.ok(staleB.extra.includes('REQ-046:AC-188'), `要点名残留的旧行：${staleB.extra.join(' ')}`)
})

test('M32-12 TASK-013 缺项与空判定基准：指纹一致也要判红（incomplete），且逐条点名', () => {
  freshAcc()
  ensureOutline({ store: accStore, requirements: twoMusts(), ...GEN })
  const path = join(ACC_SDO, 'testing', 'acceptance.yml')
  const raw = accStore.readYaml<{ acceptance: Record<string, unknown> }>('testing', 'acceptance.yml')
  assert.ok(raw !== undefined, '前提：大纲已在盘上')
  const body = raw.acceptance as { outline: { requirement: string; ac: string; baseline: string }[]; requirementFingerprint: string }
  const recorded = body.requirementFingerprint

  // ① 手工删掉一行（模拟"有人手改真源"）——指纹保持原样，所以判的必须是"缺项"而不是"过期"
  body.outline = body.outline.filter((entry) => entry.ac !== 'AC-189')
  accStore.writeYaml(['testing', 'acceptance.yml'], { acceptance: { ...body, requirementFingerprint: recorded } })
  const missing = assessOutline(accStore, twoMusts())
  assert.equal(missing.verdict, 'incomplete', '指纹一致但缺条目 ⇒ incomplete（不是 stale）')
  assert.deepEqual(missing.missing, ['REQ-046:AC-189'], '点名缺的那条')

  // ② 判定基准被清空 ⇒ 也算没写清"怎么判定"
  body.outline = generateOutline({ requirements: twoMusts(), ...GEN }).outline
  body.outline[0] = { ...body.outline[0]!, baseline: '   ' }
  accStore.writeYaml(['testing', 'acceptance.yml'], { acceptance: { ...body, requirementFingerprint: recorded } })
  const empty = assessOutline(accStore, twoMusts())
  assert.equal(empty.verdict, 'incomplete')
  assert.deepEqual(empty.withoutBaseline, ['REQ-046:AC-188'], '点名没写判定基准的那条')

  // ③ 完全没有大纲 ⇒ missing（并给出应有多少条）
  rmSync(path)
  const none = assessOutline(accStore, twoMusts())
  assert.equal(none.verdict, 'missing')
  assert.equal(none.expectedCount, 3)
  assert.match(describeOutlineVerdict(none), /不存在/u)
})

test('M32-13 TASK-013 生成物必须过测试域自己的形状校验（字段名不许两套）', () => {
  freshAcc()
  const { outline } = ensureOutline({ store: accStore, requirements: twoMusts(), ...GEN })
  // 用 TASK-012 的形状校验器复核：acceptance.yml 必须被判 ok（cross-ref 用同一份需求表）
  const known: TestingShapeKnown = {
    requirements: new Map([['REQ-046', ['AC-188', 'AC-189']], ['REQ-047', ['AC-191']]]),
  }
  const report = validateTestingSet([{ class: 'acceptance', file: 'acceptance', value: outline }], known)
  assert.equal(report.outcome, 'ok', `生成的大纲要能过形状校验：${report.issues.map((issue) => `${issue.field}[${issue.code}]`).join(' ')}`)

  // 反向：把判定基准改空 ⇒ 形状校验必须判红（证明上面那条 ok 不是因为校验器空转）
  const broken = { ...outline, outline: outline.outline.map((entry, index) => (index === 0 ? { ...entry, baseline: '' } : entry)) }
  assert.equal(validateTestingSet([{ class: 'acceptance', file: 'acceptance', value: broken }], known).outcome, 'invalid')
})

test('M32-14 TASK-013 接线：G2 声明了这条判据，且 check 键在 CHECKERS 里真的有实现（fail-closed）', () => {
  // ① 流程数据里 G2 声明了 `dor.acceptance_outline`（否则判据等于没挂）
  const processes = loadAllProcesses()
  const waterfall = processes.find((entry) => entry.id === 'waterfall')
  assert.ok(waterfall !== undefined, '瀑布流程必须能装载')
  const g2 = waterfall.gates.find((gate) => gate.id === 'G2')
  assert.ok(g2 !== undefined, 'G2 必须在流程数据里')
  const criterion = g2.criteria.find((item) => item.check === 'dor.acceptance_outline')
  assert.ok(criterion !== undefined, 'G2 必须声明验收大纲判据')
  assert.match(String(criterion.desc), /验收大纲/u, '判据的中文说明要能给人看')

  // ② check 键必须在 CHECKERS 里有实现 —— 没实现的话 evaluateGate 会按"未实现即失败"处理，
  //    但那属于"实现了但坏了"；这里直接盯"有没有挂上"，让漏接线在单测就暴露
  assert.equal(typeof CHECKERS['dor.acceptance_outline'], 'function', 'check 键必须在 CHECKERS 里注册')

  // ③ 判据三态：没有大纲 ⇒ 判红且点名；生成后 ⇒ 判过
  freshAcc()
  const ctx = {
    workspace: ACC_BASE,
    store: accStore,
    journal: accJournal,
    process: waterfall,
    project: undefined,
    requirements: twoMusts(),
    questions: [],
    risks: [],
    issues: [],
    feasibility: undefined,
    redTeamExecuted: false,
    redTeamDisabled: false,
    waivedGates: [],
    prototypeDir: 'prototype',
    prototypeThrowaway: false,
    riskConclusion: undefined,
  } as unknown as GateContext
  const before = CHECKERS['dor.acceptance_outline']!(ctx)
  assert.equal(before.ok, false, '没有大纲 ⇒ 判红')
  assert.match(before.detail, /不存在/u)
  assert.ok((before.remedy ?? '').includes('重新生成'), '判红必须给可执行的补救')

  ensureOutline({ store: accStore, requirements: twoMusts(), ...GEN })
  const after = CHECKERS['dor.acceptance_outline']!(ctx)
  assert.equal(after.ok, true, `生成后判过：${after.detail}`)
  assert.match(after.detail, /齐备/u)

  // ④ 需求变更后再判 ⇒ 又红（判据与需求真源现算，不缓存）
  ctx.requirements = [...twoMusts(), requirement('REQ-048', [{ id: 'AC-194', given: 'g', when: 'w', then: 't' }])]
  const stale = CHECKERS['dor.acceptance_outline']!(ctx)
  assert.equal(stale.ok, false, '需求一变 ⇒ 判据立刻红（现算，不看缓存）')
  assert.match(stale.detail, /与当前需求基线不一致/u)
})

// ════════════════════════════════════════════════════════════════════════════════════════
// TASK-031：两条判据的**四流程同挂**（遍历，不硬编码条数）
//
// 背景（两次脱节的实例）：
//   ① `dor.acceptance_outline`（REQ-046）当初只挂上了 waterfall 的 G2 —— 别的流程走 G2 时
//      "验收大纲"这条判据等于不存在，而 TASK-013 的守卫只盯 waterfall，全绿；
//   ② `exit.criteria`（REQ-050）同样只挂上了 waterfall 的 G6（C-53）。
//
// 所以这里**不写死"某三条判据"**：遍历 `loadAllProcesses()` 的每一个流程，逐流程 × 逐 check 断言。
// 将来新增流程（`src/data/processes/*.yml`）自动进圈 —— 漏挂当场红，而不是等真机上门禁少判一条。
// ════════════════════════════════════════════════════════════════════════════════════════

/** 某流程某门禁里 check 等于给定键的判据（0 条 = 漏挂，≥2 条 = 重复挂）。 */
function criteriaFor(processId: string, gateId: string, check: string): { id: string; desc?: string | undefined }[] {
  const process = loadAllProcesses().find((entry) => entry.id === processId)
  assert.ok(process !== undefined, `流程 ${processId} 必须能装载`)
  const gate = process.gates.find((item) => item.id === gateId)
  assert.ok(gate !== undefined, `${processId} 必须有 ${gateId}`)
  return gate.criteria.filter((item) => item.check === check)
}

/** 每个流程（当前四套：waterfall / agile / prototype / spiral）都必须挂上的两条判据。 */
const REQUIRED_CRITERIA = [
  { gate: 'G2', check: 'dor.acceptance_outline' },
  { gate: 'G6', check: 'exit.criteria' },
] as const

test('M32-15 TASK-031 四流程同挂：每个流程的 G2 挂 dor.acceptance_outline、G6 挂 exit.criteria（遍历，逐条点名）', () => {
  const processes = loadAllProcesses()
  // 反自证：遍历面必须真的盖住四套流程（写成 1-2 个流程就会在这里先红）
  assert.deepEqual(
    processes.map((entry) => entry.id).sort(),
    ['agile', 'prototype', 'spiral', 'waterfall'],
    '遍历面必须盖住四套随包流程（少一套 ⇒ 未来新增流程会静默漏挂）',
  )

  const trace: string[] = []
  for (const process of processes) {
    for (const required of REQUIRED_CRITERIA) {
      const found = criteriaFor(process.id, required.gate, required.check)
      assert.equal(
        found.length,
        1,
        found.length === 0
          ? `流程 ${process.id} 的 ${required.gate} 缺判据 ${required.check}（判据没挂上 = 该流程这条约束不存在）`
          : `流程 ${process.id} 的 ${required.gate} 重复挂了 ${required.check}：${found.map((item) => item.id).join(' ')}`,
      )
      const criterion = found[0]!
      assert.notEqual(String(criterion.desc).trim(), '', `${process.id}/${required.gate}/${criterion.id} 的 desc 不许为空`)
      // check 键必须在 CHECKERS 里注册（判据存在但没实现 = 门禁按"未实现"判，等于没约束）
      assert.equal(typeof CHECKERS[required.check], 'function', `check 键 ${required.check} 必须在 CHECKERS 里注册`)
      trace.push(`${process.id}/${required.gate}/${criterion.id}`)
    }
  }
  assert.equal(trace.length, processes.length * REQUIRED_CRITERIA.length, `逐流程逐 check 都要有落点：${trace.join(' ')}`)

  // 判据 id 逐流程唯一（跨门禁、含本卡新增的两条）：重号会让"逐条点名"指错判据
  for (const process of processes) {
    const ids = process.gates.flatMap((gate) => gate.criteria.map((item) => item.id))
    const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index)
    assert.deepEqual(duplicated, [], `流程 ${process.id} 的判据 id 重号：${duplicated.join(' ')}`)
  }
})

test('M32-16 TASK-031 desc 与 waterfall 同口径：两条判据的 desc 在四个流程里逐字节一致（防口径漂移）', () => {
  const reference = (gate: string, check: string): string => {
    const found = criteriaFor('waterfall', gate, check)
    assert.equal(found.length, 1, `基准：waterfall 的 ${gate} 必须有且只有一条 ${check}`)
    return String(found[0]!.desc)
  }

  // 基准文案要含该判据的实质口径 —— 四个流程共用同一句，改口径就得四处一起改
  const acceptanceDesc = reference('G2', 'dor.acceptance_outline')
  for (const phrase of ['验收大纲', 'must 需求', '需求变更后整份失效', '重新生成', '随 G2 重签']) {
    assert.ok(acceptanceDesc.includes(phrase), `dor.acceptance_outline 的 desc 必须写明「${phrase}」：${acceptanceDesc}`)
  }
  const exitDesc = reference('G6', 'exit.criteria')
  for (const phrase of ['逐条现算', '禁止加权', '任一不达标即整体不成立并逐条点名', '找不到实测判红']) {
    assert.ok(exitDesc.includes(phrase), `exit.criteria 的 desc 必须写明「${phrase}」：${exitDesc}`)
  }

  for (const process of loadAllProcesses()) {
    for (const required of REQUIRED_CRITERIA) {
      const found = criteriaFor(process.id, required.gate, required.check)
      assert.equal(found.length, 1, `流程 ${process.id} 的 ${required.gate} 缺 ${required.check}`)
      assert.equal(
        String(found[0]!.desc),
        reference(required.gate, required.check),
        `流程 ${process.id} 的 ${required.gate}/${required.check} 的 desc 与 waterfall 不同口径（同一判据不许两套说明）`,
      )
    }
  }
})
