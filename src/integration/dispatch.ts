/**
 * **真派发（P-1）**：把"派发请求"真的交给宿主的 `subagents` 服务起一次子代理运行。
 *
 * 之前这一步是空的：`sdo_plan action=next` 只把 persona / 掩码 / 写范围 / 提示词组装好并留痕，
 * 然后回执让流程官自己用 `send_message` 桥接（"宿主调用尚未接线"）。sdo-test 的测试报告把它列为
 * **blocker**：组装完整但起不了进程。
 *
 * 宿主契约（`ctx.get('subagents')`，DSH 0.2.0-rc.1）：
 *   · `list(): string[]`                      —— 已注册的 provider 名（preset 里 `tool-subagent` 配的是 `spawn`）
 *   · `start(name, request): Promise<SubagentRun>`，`request` 支持
 *     `{ label, prompt: ContentBlock[], parent: Agent, signal, toolFilter: {allow, deny}, persona, maxDepth }`
 *   · 返回 `{ id: SessionId, localAgent, result, dispose() }`
 *
 * **工具面隐藏**也顺带解决：`toolFilter` 由宿主施加 ⇒ 子代理**看不到**掩码外的工具
 * （此前只有钩子事后拦调用，模型仍然看得见 —— 测试报告 P-3）。
 *
 * 本模块是**纯适配**：不读台账、不写日志，宿主缺失/失败一律如实返回"没派出去"，
 * 绝不假装成功（回执里由调用方说明原因）。
 */
import type { DispatchRequest } from './orchestrator.js'

/** 宿主 `subagents` 服务里本模块用到的最小面（软探测，缺失即降级）。 */
export interface SubagentRuntimeLike {
  list?: (() => string[]) | undefined
  /** 取 provider 的能力声明（`capabilities.toolFilter` 决定"宿主会不会真的隐藏工具面"）。 */
  getProvider?: ((name: string) => { capabilities?: { toolFilter?: boolean } } | undefined) | undefined
  start?: ((
    name: string,
    request: {
      label?: string
      prompt: { type: 'text'; text: string }[]
      parent: unknown
      signal: AbortSignal
      toolFilter?: { allow: readonly string[]; deny: readonly string[] }
      persona?: string
      maxDepth?: number
    },
  ) => Promise<{ id?: unknown }>) | undefined
}

export type DispatchOutcome =
  | { started: true; provider: string; childSessionId: string; toolFilterDeclared: boolean }
  | { started: false; reason: 'no-service' | 'no-provider' | 'no-parent' | 'failed'; detail: string }

/** 派发用的取消信号：SDO 目前没有"派发生命周期"的所有者，先各自持有，便于将来统一取消。 */
const controllers = new Set<AbortController>()

export function dispatchSignal(): AbortSignal {
  const controller = new AbortController()
  controllers.add(controller)
  return controller.signal
}

/** 取消全部在飞的派发（供将来的"止损"入口；目前只导出能力，不自动调用）。 */
export function abortAllDispatches(): void {
  for (const controller of controllers) controller.abort()
  controllers.clear()
}

/**
 * 真正起一次派发。
 *
 * @param input.runtime 宿主的 `subagents` 服务（缺失 → `no-service`）
 * @param input.provider provider 名（如 `spawn`）；不在 `runtime.list()` 里 → `no-provider`
 * @param input.agent 发起 agent（宿主要求 live Agent；缺失 → `no-parent`）
 * @param input.deny 角色 `deny` 列表（纵深防御：即使宿主忽略 allow，也把明确越界的挡掉）
 */
export async function startDispatch(input: {
  runtime: SubagentRuntimeLike | undefined
  provider: string
  agent: unknown
  request: DispatchRequest
  deny: readonly string[]
  maxDepth: number
}): Promise<DispatchOutcome> {
  const runtime = input.runtime
  if (runtime === undefined || typeof runtime.start !== 'function') {
    return { started: false, reason: 'no-service', detail: '宿主没有 subagents 服务（或该服务没有 start）' }
  }
  const available = typeof runtime.list === 'function' ? safeList(runtime) : []
  if (available.length > 0 && !available.includes(input.provider)) {
    return { started: false, reason: 'no-provider', detail: `provider「${input.provider}」未注册；可用：${available.join(' / ')}` }
  }
  if (input.agent === undefined || input.agent === null) {
    return { started: false, reason: 'no-parent', detail: '拿不到发起 agent（宿主要求 live Agent 作为 parent）' }
  }
  try {
    const run = await runtime.start(input.provider, {
      label: `${input.request.task.id} ${input.request.owner}`,
      prompt: [{ type: 'text', text: input.request.prompt }],
      parent: input.agent,
      signal: dispatchSignal(),
      toolFilter: { allow: input.request.toolFilter, deny: input.deny },
      persona: input.request.persona,
      maxDepth: input.maxDepth,
    })
    const childSessionId = typeof run?.id === 'string' ? run.id : String(run?.id ?? '')
    if (childSessionId === '') return { started: false, reason: 'failed', detail: '宿主返回的 run 没有可用的会话 id' }
    // 能力值只当"provider 的**声明**"带回去。**不能**据此推断"宿主已经收窄了工具面"：
    // 真机反例（sdo-test §8.4②）用它派发出去的子代理仍然看得见并调用了掩码外的工具 —— spawn 声明
    // `toolFilter: true`、宿主链路里也调了 `childCtx.tools.restrict(...)`，但实际没生效。
    // 所以回执只陈述"已下发 + 该 provider 声明了什么 + 本插件无法自证"，见 describeDispatchStarted。
    return { started: true, provider: input.provider, childSessionId, toolFilterDeclared: toolFilterCapability(runtime, input.provider) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { started: false, reason: 'failed', detail }
  }
}

function toolFilterCapability(runtime: SubagentRuntimeLike, provider: string): boolean {
  // 注意：这是**声明值**，不是"隐藏是否生效"的判据（见 startDispatch 里的注释）。
  try {
    return runtime.getProvider?.(provider)?.capabilities?.toolFilter === true
  } catch {
    return false
  }
}

function safeList(runtime: SubagentRuntimeLike): string[] {
  try {
    return (runtime.list?.() ?? []).filter((name): name is string => typeof name === 'string')
  } catch {
    return []
  }
}
