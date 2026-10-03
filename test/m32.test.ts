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

import { startDispatch } from '../src/integration/dispatch.js'
import { describeDispatchStarted } from '../src/interface/describe.js'
import { toolNamesOfHeader } from '../src/domain/dispatchFace.js'
import type { DispatchRequest } from '../src/integration/orchestrator.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

const request: DispatchRequest = {
  task: { id: 'TASK-001', role: 'developer' } as never,
  backend: 'subagent',
  owner: 'subagent:developer:1',
  persona: 'sdo-developer',
  toolFilter: ['skill', 'read', 'edit', 'sdo_task'],
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
    { started: true, provider: 'spawn', childSessionId: 'session-child-1', toolFilterDeclared: true },
    '能力值只是"provider 的声明"，不代表"宿主已经收窄了工具面"（见 M32-06）',
  )
  assert.equal(calls.length, 1)
  const sent = calls[0] as { name: string; request: Record<string, unknown> }
  assert.equal(sent.name, 'spawn')
  assert.deepEqual(sent.request.prompt, [{ type: 'text', text: request.prompt }], '提示词要原样交给宿主')
  assert.deepEqual(sent.request.toolFilter, { allow: request.toolFilter, deny: ['sdo_review', 'sdo_gate'] }, 'allow 用角色掩码、deny 用角色 deny')
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
    const text = describeDispatchStarted(request, 'spawn', 'session-child-1', 9, declared)
    assert.match(text, /下发给宿主/u, '要说明我们做了下发')
    assert.match(text, /capabilities\.toolFilter/u, '要给出 provider 声明的能力值（作为事实，不作为保证）')
    assert.match(text, /无法自证|不可自证/u, '必须明说"是否收窄本插件不能自证"')
    assert.match(text, /钩子/u, '要说明兜底拦调用的是钩子')
    assert.doesNotMatch(text, /看不到掩码外的工具/u, '不得写与真机事实相反的断言')
  }
  // 真机反例要留在文案里（评审要求：把宿主侧发现如实带出）
  const text = describeDispatchStarted(request, 'spawn', 'session-child-1', 9, true)
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
  const real = describeDispatchStarted(request, 'spawn', 'child-1', 9, true, [
    { childSessionId: 'child-1', tools: ['bash', 'edit', 'read', 'sdo_task'], violations: [], calls: ['sdo_plan', 'sdo_review', 'sdo_gate'] },
  ])
  assert.match(real, /公告面/u, '要有公告面那行')
  assert.match(real, /执行面/u, '要有执行面那行')
  assert.match(real, /3 次掩码外调用/u, '执行面的次数要如实（callCount）')
  assert.match(real, /去重后 3 个工具/u, '去重后的工具数也要给（两个口径分开写）')
  assert.match(real, /child-tools\.jsonl/u, '要指路：观测持续写进台账（否则这份数据没人看）')

  // 同一次调用重复 3 次：次数 3、去重 1 —— 数字与口径必须对得上
  const repeated = describeDispatchStarted(request, 'spawn', 'child-2', 9, true, [
    { childSessionId: 'child-2', tools: ['read'], violations: [], calls: ['sdo_gate'], callCount: 3 },
  ])
  assert.match(repeated, /3 次/u)
  assert.match(repeated, /去重后 1 个工具/u)
  assert.match(real, /sdo_gate/u, '要点名越界调用')
  assert.match(real, /不等于调用被挡住/u, '公告面干净时必须说明它不等于调用被挡住')

  const announcedDirty = describeDispatchStarted(request, 'spawn', 'child-1', 9, true, [
    { childSessionId: 'child-1', tools: ['read', 'sdo_gate'], violations: ['sdo_gate'], calls: [] },
  ])
  assert.match(announcedDirty, /仍被公告/u, '公告面就有越界时要单独说')
  const allClean = describeDispatchStarted(request, 'spawn', 'child-1', 9, true, [
    { childSessionId: 'child-1', tools: ['read', 'edit'], violations: [], calls: [] },
  ])
  assert.match(allClean, /未观测到掩码外调用/u, '执行面干净也要说清')

  // 接线：监听器要认 `request/header` 并按角色算"掩码外工具"
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /eventType === 'request\/header'/u, '要处理 request/header')
  assert.match(index, /office\.dispatchedChildren\(/u, '只认我们自己派发出去的子会话')
  assert.match(index, /maskAllows\(role, tool\)/u, '按角色掩码算越界工具')
  assert.match(index, /eventType === 'tool\/call'/u, '执行面也要观测（对未公告工具的调用）')
  assert.match(index, /toolCallNameOf\(event\)/u, '从 tool/call 取工具名')
  assert.match(index, /k208FaceBlockHeader/u, 'sdo_status 要有观测块头')
  assert.match(index, /childFaceLines\(faces\)\.join/u, 'sdo_status 要真的把观测行拼进去')
  assert.match(index, /return text \+ faceBlock/u, 'status 的无参数分支要带上观测块')
  assert.match(index, /\+ faceBlock$/mu, 'status 的另一条分支（--rebuild）也要带上观测块')
  assert.match(index, /office\.childFaces\(call\)/u, '派发回执要展示已观测的工具面')
})
