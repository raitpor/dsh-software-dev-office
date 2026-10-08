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
  /**
   * 可续聊（continuable）子代理的入口。
   *
   * **2026-10-04 实测纠正**：宿主 `dsh-subagent` 的**便捷方法** `start(name, request)` 确实把描述符写死成
   * `mode: "one-shot"`，但**同一个服务**还暴露 `startContinuable(spec)` 与 `sendMessage(...)`
   * —— 后者按宿主注释就是"给直接子代理投递模型消息：运行中在最近步骤边界收下、**空闲则起一轮**、
   * 不存在则从持久化冷恢复"。所以插件**今天就能复用**，此前"宿主没有入口"的说法是错的（只看了 `start`）。
   */
  activate?: unknown
  /** 建一个**可续聊**子代理：`{ provider, request: {parent, prompt, persona?, toolFilter?, maxDepth?}, signal }` → `{childId, messageId}` */
  startContinuable?: ((spec: {
    provider: string
    request: {
      parent: unknown
      prompt: { type: 'text'; text: string }[]
      persona?: string
      /** `allow` 省略 = **不做白名单过滤**（继承宿主默认）—— 本插件只发 `deny`（见 `DispatchRequest.toolDeny`） */
      toolFilter?: { allow?: readonly string[] | undefined; deny: readonly string[] }
      maxDepth?: number
    }
    label?: string
    signal: AbortSignal
  }) => Promise<{ childId?: unknown; messageId?: unknown }>) | undefined
  /** 把一条模型消息投给**直接**子代理（空闲则起一轮）——复用的投递原语 */
  sendMessage?: ((sender: unknown, targetId: string, content: { type: 'text'; text: string }[], options: { signal: AbortSignal }) => Promise<unknown>) | undefined
  resume?: unknown
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
      /** `allow` 省略 = **不做白名单过滤**（继承宿主默认）—— 本插件只发 `deny`（见 `DispatchRequest.toolDeny`） */
      toolFilter?: { allow?: readonly string[] | undefined; deny: readonly string[] }
      persona?: string
      maxDepth?: number
    },
  ) => Promise<{ id?: unknown }>) | undefined
}

export type DispatchOutcome =
  | {
      started: true
      provider: string
      childSessionId: string
      toolFilterDeclared: boolean
      reuseSupported: boolean
      /** 这次是否**复用**了一个已有子代理（真复用：同一个子代理承接第二张及以后的卡） */
      reused: boolean
      /** 宿主给这个子代理的模式（`continuable` 才能再复用；`one-shot` 结算后就没了） */
      mode: 'continuable' | 'one-shot'
      /** 想复用但没成的原因（如实回报，不静默降级成"新起一个"） */
      reuseFailed?: string | undefined
      /** 想用可续聊入口但宿主没给（如 `CONTINUATION_UNAVAILABLE`）——池因此退化为并发上限 */
      continuableFailed?: string | undefined
    }
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
  /** 角色池挑好的**空闲可复用**子代理（给了就优先投给它，而不是新起一个） */
  reuseChildId?: string | undefined
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
  const blocks = [{ type: 'text' as const, text: input.request.prompt }]
  const label = `${input.request.task.id} ${input.request.owner}`
  const toolFilterDeclared = toolFilterCapability(runtime, input.provider)
  const reuseSupported = reuseCapability(runtime).supported
  let reuseFailed: string | undefined
  let continuableFailed: string | undefined
  // ① 真复用：把这张卡投给一个**已有且空闲**的子代理（宿主注释：空闲则起一轮）
  if (input.reuseChildId !== undefined && input.reuseChildId !== '' && typeof runtime.sendMessage === 'function') {
    try {
      await runtime.sendMessage(input.agent, input.reuseChildId, blocks, { signal: dispatchSignal() })
      return {
        started: true,
        provider: input.provider,
        childSessionId: input.reuseChildId,
        toolFilterDeclared,
        reuseSupported,
        reused: true,
        mode: 'continuable',
      }
    } catch (error) {
      // 复用失败**不静默**：如实带回去，然后按"新起一个"继续（拒绝复用不该让这张卡派不出去）
      reuseFailed = error instanceof Error ? error.message : String(error)
    }
  }
  // ② 建可续聊子代理（只有它结算后还能再收卡；one-shot 结算即消失）
  if (typeof runtime.startContinuable === 'function') {
    try {
      const created = await runtime.startContinuable({
        provider: input.provider,
        request: {
          parent: input.agent,
          prompt: blocks,
          persona: input.request.persona,
          // **只发 deny**（2026-10-08 口径纠正）：allow 一填就把整个通用面挡掉了
          toolFilter: { deny: input.deny },
          maxDepth: input.maxDepth,
        },
        label,
        signal: dispatchSignal(),
      })
      const childSessionId = typeof created?.childId === 'string' ? created.childId : String(created?.childId ?? '')
      if (childSessionId !== '') {
        return {
          started: true,
          provider: input.provider,
          childSessionId,
          toolFilterDeclared,
          reuseSupported,
          reused: false,
          mode: 'continuable',
          ...(reuseFailed === undefined ? {} : { reuseFailed }),
        }
      }
      continuableFailed = '宿主 startContinuable 没返回可用的 childId'
    } catch (error) {
      continuableFailed = error instanceof Error ? error.message : String(error)
    }
  }
  try {
    const run = await runtime.start(input.provider, {
      label,
      prompt: blocks,
      parent: input.agent,
      signal: dispatchSignal(),
      toolFilter: { deny: input.deny },
      persona: input.request.persona,
      maxDepth: input.maxDepth,
    })
    const childSessionId = typeof run?.id === 'string' ? run.id : String(run?.id ?? '')
    if (childSessionId === '') return { started: false, reason: 'failed', detail: '宿主返回的 run 没有可用的会话 id' }
    // 能力值只当"provider 的**声明**"带回去。**不能**据此推断"宿主已经收窄了工具面"：
    // 真机反例（sdo-test §8.4②）用它派发出去的子代理仍然看得见并调用了掩码外的工具 —— spawn 声明
    // `toolFilter: true`、宿主链路里也调了 `childCtx.tools.restrict(...)`，但实际没生效。
    // 所以回执只陈述"已下发 + 该 provider 声明了什么 + 本插件无法自证"，见 describeDispatchStarted。
    return {
      started: true,
      provider: input.provider,
      childSessionId,
      toolFilterDeclared,
      reuseSupported,
      reused: false,
      mode: 'one-shot',
      ...(reuseFailed === undefined ? {} : { reuseFailed }),
      ...(continuableFailed === undefined ? {} : { continuableFailed }),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { started: false, reason: 'failed', detail }
  }
}

/**
 * **子代理复用能力探测**（复用方案 1 的插件侧半个）。
 *
 * 宿主 `dsh-subagent` 内部**有** `one-shot` 与 `continuable` 两种模式（`dsh-subagent` 的持久化描述符校验里明确列了这两个字面量），
 * 但 Service 暴露的 `start()` 把描述符**写死成 `mode: "one-shot"`**（`dsh-subagent` 的 `Service.start()` 里那个字面量）⇒ 插件今天拿不到可续聊的子代理。
 * 所以这里只看**显式存在**的入口（`activate`/`startContinuable`/`resume`）：宿主一旦开放，回执会自动改口径，
 * 不需要再改插件。**绝不用"猜"来宣布支持**（与 `toolFilter` 探测同一口径：只看 `typeof === 'function'`）。
 */
export function reuseCapability(runtime: SubagentRuntimeLike): { supported: boolean; detail: string } {
  for (const name of ['startContinuable', 'activate', 'resume'] as const) {
    if (typeof (runtime as Record<string, unknown>)[name] === 'function') return { supported: true, detail: name }
  }
  return { supported: false, detail: '宿主没暴露可续聊入口（只有 start → one-shot）' }
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
