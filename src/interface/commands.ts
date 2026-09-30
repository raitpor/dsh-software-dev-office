/**
 * 斜杠命令：宿主侧**确定性**执行，不产生模型消息（设计 §9.2 / REQ-020）。
 *
 * ⚠️ 命名偏差（任务计划 §9 的 D-01）：`@deepseek-ai/dsh-commands` 的命令名必须匹配
 * `/^[a-z][a-z0-9_-]*$/`，**不接受冒号**，因此设计里的 `/sdo:status`、`/sdo:board`
 * 落成 `/sdo-status`、`/sdo-board`（其余同理）。
 *
 * 设计 §9.2 另有一条可达性约束：命令面只在交互式适配器（Web/CLI）可用，因此
 * **所有命令能力都必须有等价的模型工具入口**——这里每个命令都对应 `sdo_*` 工具。
 */
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

import { fmt, t } from '../domain/i18n.js'
import type { OfficeCall } from '../office.js'
import type { GateArgs, InitArgs, RedTeamArgs, RequirementArgs } from './tools.js'

/** 命令行为依赖，由插件入口注入。 */
export interface OfficeCommandDeps {
  init(call: OfficeCall, args: InitArgs): Promise<string>
  langSwitch(input?: string | undefined): Promise<string>
  status(call: OfficeCall, args: { rebuild?: boolean | undefined }): Promise<string>
  board(call: OfficeCall, args: { expand?: boolean | undefined; all?: boolean | undefined; write?: boolean | undefined }): Promise<string>
  requirement(call: OfficeCall, args: RequirementArgs): Promise<string>
  redteam(call: OfficeCall, args: RedTeamArgs): Promise<string>
  gate(call: OfficeCall, args: GateArgs): Promise<string>
  cost(call: OfficeCall, args: { action: string }): Promise<string>
  setBudget(call: OfficeCall, input: { total?: number | undefined; currency?: string | undefined; tiers?: number[] | undefined }): string
  decideBudget(call: OfficeCall, choice: string, note: string): string
  render(call: OfficeCall, args: { target?: string | undefined }): Promise<string>
}

function callOf(invocation: CommandInvocation): OfficeCall {
  const agent = invocation.agent
  if (agent === undefined) return {}
  // **实测结论（dsh-agent 0.2.0-rc.1）**：Agent 上**没有** `cwd`/`workspace.cwd`/`session.cwd`；
  // 会话工作目录在 `agent.session.header.cwd`。此前读错字段 → 工作区恒为 undefined
  // （症状：requireWorkspace 抛「无法确定本会话的工作区」）。旧字段作为兜底保留，代价为零。
  const holder = agent as unknown as {
    cwd?: unknown
    workspace?: { cwd?: unknown }
    session?: { cwd?: unknown; header?: { cwd?: unknown } }
  }
  const cwd = [holder.session?.header?.cwd, holder.cwd, holder.workspace?.cwd, holder.session?.cwd].find(
    (value): value is string => typeof value === 'string' && value !== '',
  )
  return { sessionId: String(agent.id), agent, ...(cwd === undefined ? {} : { cwd }) }
}

/** 从 `rawInput` 里读一个布尔开关（`--flag` / `--flag=false`）。 */
function flag(raw: string, name: string): boolean {
  const matched = new RegExp(`(?:^|\\s)--${name}(?:=(true|false))?(?=\\s|$)`).exec(raw)
  if (matched === null) return false
  return matched[1] !== 'false'
}

/** 取 `--key=value` 的值。 */
function option(raw: string, name: string): string | undefined {
  const matched = new RegExp(`(?:^|\\s)--${name}=([^\\s]+)`).exec(raw)
  return matched?.[1]
}

/** 取 `--key value` 或 `--key=value` 后的自由文本（用于 --answer）。 */
function textOption(raw: string, name: string): string | undefined {
  const matched = new RegExp(`(?:^|\\s)--${name}=(?:"([^"]*)"|'([^']*)'|(\\S+))`).exec(raw)
  if (matched === null) return undefined
  return matched[1] ?? matched[2] ?? matched[3]
}

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(error: unknown): CommandResult {
  return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
}

/** 创建 SDO 的命令定义数组。 */
/**
 * 统一回显：用 `agent.followup()` 把命令结果注入成一条**用户可见的消息**。
 *
 * 为什么这样做（2026-09-29 真机实测）：
 *   · Web 客户端**不渲染**"轮次之外"的命令节点 → 不回显就等于"回车没反应"，命令面形同不存在；
 *   · 实测 `followup` **只渲染、不触发模型回复**，因此它**不是**"用模型消息兜底"，
 *     而是命令结果的正常呈现通道 —— 与设计 §9.2 的"命令不产生模型消息"并不冲突。
 * 仍可用 `commandEcho: none` / `SDO_COMMAND_ECHO=none` 关掉。
 */
/**
 * 构造"命令结果回显"消息。
 *
 * **形状必须与宿主的 `UserMessage` 一致**（抄自同实例里已验证可用的 `dsh-memory-layer`）：
 *   · `id: 'ms_<uuid>'` —— 缺了它就是非法消息：既让命令请求返回"处理失败"，
 *     又会把会话记录写成投影读不出来的样子（实测：切换会话后看不到记录）；
 *   · `source: {kind:'plugin'}` —— 宿主据此把它当**注入上下文**；若写成 `user`，
 *     这段文本会被当成"用户原话"，污染对话语义。
 * 导出以便单测直接断言形状（这条 bug 就是"形状错"造成的，必须有测试守着）。
 */
export function echoMessage(name: string, text: string): UserMessage {
  // 必须用宿主的构造器：手搓对象缺字段会让驱动**每一步**都处理失败
  // （实测症状："指令内容展示了，但后续全是处理失败"）。
  // source 必须是插件来源：写成 user 会被当成"用户原话"污染对话语义。
  return createUserMessage({
    content: [
      { type: 'text', text: fmt('uiCommands.k1', { p1: name, p2: cap(text) }) },
    ],
    // source 的形状**随会话格式变化**（抄自 dsh-memory-layer 的 messageSourceFor）：
    //   会话格式 minor >= 2 → `{kind: 'plugin:<插件名>'}`；
    //   0.1 线（minor < 2）  → `{kind: 'plugin', plugin: '<插件名>'}`。
    // 本插件基线是 dsh 0.2.0（C-01），因此用前者。**用错形状的后果很重**：
    // 宿主每一步都处理失败（实测："指令内容展示了，但后续全是处理失败"）。
    // 注意：本包编译用的 `@deepseek-ai/dsh-session` 类型是**旧线**的（不含 `plugin:<名>` 形态），
    // 因此这里必须 `as unknown as`；运行时该形态由已安装版本决定（memory-layer 的
    // `messageSourceFor` 也是运行时探测后才转换的）。本插件只支持 dsh 0.2.0（C-01），用新形态。
    source: { kind: 'plugin:dsh-software-dev-office' } as unknown as UserMessage['source'],
  })
}

/** 回显正文的上限：命令结果可能很长（如看板），不设限会灌爆上下文。 */
const ECHO_TEXT_LIMIT = 4000

function cap(text: string): string {
  return text.length <= ECHO_TEXT_LIMIT ? text : fmt('uiCommands.k2', { p1: text.slice(0, ECHO_TEXT_LIMIT) })
}

/**
 * 投递回显消息：**优先 inbox splice（`send(..., wakeup=false)`，不唤醒轮次）**，
 * 退而用 `followup`。两条路都可能失败——失败原因要返回给调用方去显式报告，不能吞。
 * 依据：同实例里 `dsh-memory-layer` 的注入走"宿主 splice 进 inbox"，实测**只渲染、不触发模型回复**。
 */
async function deliverEcho(invocation: CommandInvocation, message: unknown): Promise<string | undefined> {
  const agent = invocation.agent as unknown as {
    inbox?: { send(message: unknown, target: string, wakeup: boolean): unknown }
    followup?(message: unknown): unknown
  }
  const errors: string[] = []
  if (typeof agent.inbox?.send === 'function') {
    try {
      await Promise.resolve(agent.inbox.send(message, 'next-step', false))
      return undefined
    } catch (error) {
      errors.push(`inbox.send: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (typeof agent.followup === 'function') {
    try {
      await Promise.resolve(agent.followup(message))
      return undefined
    } catch (error) {
      errors.push(`followup: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return errors.length === 0 ? t('command.noEchoChannel') : errors.join('；')
}

function withEcho(commands: CommandDefinition[], echo: boolean): CommandDefinition[] {
  if (!echo) return commands
  return commands.map((command) => ({
    ...command,
    handler: async (invocation: CommandInvocation) => {
      const result = await command.handler(invocation)
      const text = result.kind === 'success' ? (result.text ?? '') : result.text
      if (text.trim() === '') return result
      // 静默 fail-open：回显拿不到通道时**不往结果里塞任何东西**
      //（往 success 结果里追加告警文本曾被怀疑触发客户端的"处理失败"分支）
      await deliverEcho(invocation, echoMessage(command.name, text))
      return result
    },
  }))
}

export function createOfficeCommands(deps: OfficeCommandDeps, echo = false): CommandDefinition[] {
  return withEcho([
    {
      name: 'sdo-init',
      description: t('command.sdo-init'),
      handler: async (invocation) => {
        try {
          const raw = invocation.rawInput
          const scale = option(raw, 'scale')
          return ok(
            await deps.init(callOf(invocation), {
              name: option(raw, 'name'),
              process: option(raw, 'process'),
              scale: scale === 'trivial' || scale === 'normal' || scale === 'critical' ? scale : undefined,
              stakeholders: option(raw, 'stakeholders')?.split(',').map((value) => value.trim()).filter((value) => value !== ''),
            }),
          )
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-status',
      description: t('command.sdo-status'),
      handler: async (invocation) => {
        try {
          return ok(await deps.status(callOf(invocation), { rebuild: flag(invocation.rawInput, 'rebuild') }))
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-board',
      description: t('command.sdo-board'),
      handler: async (invocation) => {
        try {
          return ok(
            await deps.board(callOf(invocation), {
              expand: flag(invocation.rawInput, 'expand'),
              all: flag(invocation.rawInput, 'all'),
              write: flag(invocation.rawInput, 'write'),
            }),
          )
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-list',
      description: t('command.sdo-list'),
      handler: async (invocation) => {
        try {
          return ok(await deps.requirement(callOf(invocation), { action: 'list' }))
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-grill',
      description: t('command.sdo-grill'),
      handler: async (invocation) => {
        try {
          return ok(
            await deps.requirement(callOf(invocation), {
              action: 'grill',
              id: option(invocation.rawInput, 'id'),
              quick: flag(invocation.rawInput, 'quick'),
            }),
          )
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-answer',
      description: t('command.sdo-answer'),
      handler: async (invocation) => {
        try {
          const index = option(invocation.rawInput, 'option')
          return ok(
            await deps.requirement(callOf(invocation), {
              action: 'answer',
              id: option(invocation.rawInput, 'id'),
              answer: textOption(invocation.rawInput, 'answer') ?? '',
              pickedOption: index === undefined ? undefined : Number(index),
              assume: flag(invocation.rawInput, 'assume'),
            }),
          )
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-redteam',
      description: t('command.sdo-redteam'),
      handler: async (invocation) => {
        try {
          const raw = invocation.rawInput
          const action = flag(raw, 'attack') ? 'attack' : flag(raw, 'off') ? 'off' : flag(raw, 'on') ? 'on' : 'status'
          return ok(
            await deps.redteam(callOf(invocation), {
              action,
              reason: option(raw, 'reason'),
            }),
          )
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-gate',
      description: t('command.sdo-gate'),
      handler: async (invocation) => {
        try {
          const raw = invocation.rawInput
          const args: GateArgs = {
            action: flag(raw, 'waive') ? 'waive' : 'check',
            gate: option(raw, 'gate'),
            approvedBy: option(raw, 'approved-by') ?? option(raw, 'approvedBy'),
            reason: textOption(raw, 'reason'),
            approver: option(raw, 'approver'),
          }
          return ok(await deps.gate(callOf(invocation), args))
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-next',
      description: t('command.sdo-next'),
      handler: async (invocation) => {
        try {
          return ok(await deps.gate(callOf(invocation), { action: 'advance' }))
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-lang',
      description: t('command.sdo-lang'),
      handler: async (invocation) => {
        try {
          return ok(await deps.langSwitch(invocation.rawInput.trim() === '' ? undefined : invocation.rawInput.trim()))
        } catch (error) {
          return ok(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'sdo-budget',
      description: t('command.sdo-budget'),
      handler: async (invocation) => {
        try {
          const raw = invocation.rawInput
          if (flag(raw, 'set')) {
            const total = option(raw, 'total')
            const tiers = option(raw, 'tiers')
            return ok(
              deps.setBudget(callOf(invocation), {
                ...(total === undefined ? {} : { total: Number(total) }),
                currency: option(raw, 'currency'),
                ...(tiers === undefined ? {} : { tiers: tiers.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value)) }),
              }),
            )
          }
          if (flag(raw, 'decide')) {
            const choice = option(raw, 'choice')
            if (choice === undefined) return ok(t('uiCommands.k3'))
            return ok(deps.decideBudget(callOf(invocation), choice, textOption(raw, 'note') ?? t('uiCommands.k4')))
          }
          return ok(await deps.cost(callOf(invocation), { action: 'report' }))
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-render',
      description: t('command.sdo-render'),
      handler: async (invocation) => {
        try {
          return ok(await deps.render(callOf(invocation), { target: option(invocation.rawInput, 'target') }))
        } catch (error) {
          return fail(error)
        }
      },
    },
  ], echo)
}
