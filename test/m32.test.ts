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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { reuseCapability, startDispatch } from '../src/integration/dispatch.js'
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
