/**
 * 斜杠命令：宿主侧**确定性**执行，不产生模型消息（设计 §9.2 / REQ-020）。
 *
 * ⚠️ 命名偏差（任务计划 §9 的 D-01）：`@deepseek-ai/dsh-commands` 的命令名必须匹配
 * `/^[a-z][a-z0-9_-]*$/`，**不接受冒号**，因此设计里的 `/sdo:status`、`/sdo:board`
 * 落成 `/sdo-status`、`/sdo-board`（其余同理）。
 *
 * 设计 §9.2 另有一条可达性约束：命令面只在交互式适配器（Web/CLI）可用，因此
 * **所有命令能力都必须有等价的模型工具入口**——这里每个命令都对应 `sdo_*` 工具。
 *
 * **参数解析**（2026-09-30 重写）：见 {@link ArgvReader} / `argv.ts` —— 一次扫描切成
 * token，再统一解析出 `flags` / `options(k=v)` / `positionals`。旧的"主路径 + 裸 `k=v` 回退"
 * 已删除：它在 `/sdo-budget --decide --note choice=waive` 一类输入上会把自由文本值里
 * 恰好含同命令别的 `k=v` 的内容**错误认领**。每条命令用 `ArgvReader.of(raw, [...开关名])`
 * 声明自己的开关，声明过的开关**不吞**下一个 token（这正是修复点）。
 */
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

import { fmt, t } from '../domain/i18n.js'
import type { OfficeCall } from '../office.js'
import { ArgvReader } from './argv.js'
import type { DesignArgs, GateArgs, InitArgs, RedTeamArgs, RequirementArgs } from './tools.js'

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
  /**
   * 设计阶段的交互动作（grill / answer / confirm / issues / render）。
   *
   * **与模型工具 `sdo_design` 是同一个依赖函数**（插件入口里就那一份实现）：
   * 命令只负责解析参数，行为、门禁顺序（这五个动作在 designPrecondition **之前**处理）
   * 与回执文案全部复用工具那条路径 —— 不许在这里复制一份逻辑。
   */
  design(call: OfficeCall, args: DesignArgs): Promise<string>
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

/**
 * 取一个命令的参数读取器。
 *
 * `flagNames` 必须列全该命令的**开关**（`--flag` 型）——解析器据此决定 `--sw` 后面
 * 的 token 是否被吞成值。漏列开关的后果是把它的值当字符串选项（`--decide choice=waive`
 * 的 `choice=waive` 因此必须保持独立）。
 */
function reader(raw: string, flagNames: readonly string[] = []): ArgvReader {
  return ArgvReader.of(raw, flagNames)
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
          const argv = reader(invocation.rawInput)
          const scale = argv.option('scale')
          return ok(
            await deps.init(callOf(invocation), {
              name: argv.option('name'),
              process: argv.option('process'),
              scale: scale === 'trivial' || scale === 'normal' || scale === 'critical' ? scale : undefined,
              stakeholders: argv.option('stakeholders')?.split(',').map((value) => value.trim()).filter((value) => value !== ''),
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
          return ok(await deps.status(callOf(invocation), { rebuild: reader(invocation.rawInput, ['--rebuild']).flag('rebuild') }))
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
          const argv = reader(invocation.rawInput, ['--expand', '--all', '--write'])
          return ok(
            await deps.board(callOf(invocation), {
              expand: argv.flag('expand'),
              all: argv.flag('all'),
              write: argv.flag('write'),
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
          const argv = reader(invocation.rawInput, ['--quick'])
          return ok(
            await deps.requirement(callOf(invocation), {
              action: 'grill',
              id: argv.option('id'),
              quick: argv.flag('quick'),
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
          const argv = reader(invocation.rawInput, ['--assume'])
          const index = argv.option('option')
          return ok(
            await deps.requirement(callOf(invocation), {
              action: 'answer',
              id: argv.option('id'),
              answer: argv.textOption('answer') ?? '',
              pickedOption: index === undefined ? undefined : Number(index),
              assume: argv.flag('assume'),
              // **M1（本报告）**：命令面此前**根本没有** dimensions 参数 ——
              // 模型通道的语义分只有工具面能给，命令行路径永远无法移动分数
              // （"看起来努力了，判据没动"）。这里补上与工具面等价的 JSON 入参。
              dimensions: argv.option('dimensions'),
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
          const argv = reader(invocation.rawInput, ['--attack', '--off', '--on'])
          const action = argv.flag('attack') ? 'attack' : argv.flag('off') ? 'off' : argv.flag('on') ? 'on' : 'status'
          return ok(
            await deps.redteam(callOf(invocation), {
              action,
              reason: argv.option('reason'),
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
          // **N-4**：命令面此前只有 `--waive`，而 B2/D1 之后"需求基线签字只能走工具面"——
          // 于是 `/sdo-gate` 这条入口根本完成不了流程（不是绕过，是死角）。现在补齐
          // `--sign/--quote/--channel`，与工具面共用同一段 handler（`deps.gate`）。
          const argv = reader(invocation.rawInput, ['--waive', '--sign', '--rollback'])
          const action = argv.flag('sign')
            ? 'sign'
            : argv.flag('rollback')
              ? 'rollback'
              : argv.flag('waive')
                ? 'waive'
                : 'check'
          const args: GateArgs = {
            action,
            gate: argv.option('gate'),
            approvedBy: argv.option('approved-by') ?? argv.option('approvedBy'),
            reason: argv.textOption('reason'),
            approver: argv.option('approver'),
            ...(argv.textOption('quote') === undefined ? {} : { quote: argv.textOption('quote') }),
            ...(argv.option('channel') === undefined
              ? // 签字面必须显式给出通道（缺省 = 会话明确表述），否则下游拿到 undefined 就"看情况"
                action === 'sign'
                ? { channel: 'statement' as const }
                : {}
              : // **P-7**：非法通道不得静默降级 —— `--channel=wechat` 曾被当成"会话明确表述"，
                // 而那条通道的语义是"引用必须能在会话记录里找到"，等于悄悄换了一套更严的语义。
                argv.option('channel') === 'question' || argv.option('channel') === 'statement'
                ? { channel: argv.option('channel') as 'question' | 'statement' }
                : (() => { throw new Error(fmt('uiIndex.kChannelInvalid', { p1: String(argv.option('channel')) })) })()),
            ...(argv.option('to') === undefined ? {} : { to: argv.option('to') }),
            // **R-4**：`--turn` 在工具面是消费的（写进 `gate/signed.data.turn`），命令面此前**静默丢弃** ——
            // 而双语命令描述已经宣传了它（文档超出实现）。
            ...(argv.option('turn') === undefined ? {} : { turn: argv.option('turn') }),
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
          // 位置参数（`/sdo-lang en`）。用分词结果而不是整段原文：`/sdo-lang "en"` 也拿到 `en`
          const argv = reader(invocation.rawInput)
          return ok(await deps.langSwitch(argv.first))
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
          const argv = reader(invocation.rawInput, ['--set', '--decide'])
          if (argv.flag('set')) {
            const total = argv.option('total')
            const tiers = argv.option('tiers')
            return ok(
              deps.setBudget(callOf(invocation), {
                ...(total === undefined ? {} : { total: Number(total) }),
                currency: argv.option('currency'),
                ...(tiers === undefined ? {} : { tiers: tiers.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value)) }),
              }),
            )
          }
          if (argv.flag('decide')) {
            // **关键修复**：`--decide --note choice=waive` 里的 `choice=waive` 是 `--note` 的**值**。
            // 旧实现的主路径失败后回退扫裸 `k=v`，会把同一个 token 再认成 `choice` 选项 ✗。
            // 这里 `decide` 是声明过的开关 → 解析阶段就不吞下一个 token，`--note` 才吞它。
            const choice = argv.option('choice')
            if (choice === undefined) return ok(t('uiCommands.k3'))
            return ok(deps.decideBudget(callOf(invocation), choice, argv.textOption('note') ?? t('uiCommands.k4')))
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
          return ok(await deps.render(callOf(invocation), { target: reader(invocation.rawInput).option('target') }))
        } catch (error) {
          return fail(error)
        }
      },
    },
    // —————————————— 增量 1：设计阶段交互（与 `sdo_design` 的五个动作一一对应） ——————————————
    // 命名沿用既有的 `/sdo-<…>` 连字符风格（D-01：宿主命令名不接受冒号，`/sdo:design` 非法）；
    // 动作名进名称第二段（`sdo-design-<action>`），与工具 `sdo_design action=<action>` 对齐。
    // 全部委托 `deps.design`（与工具同一个函数）：参数解析在此，行为不在此复制。
    {
      name: 'sdo-design-grill',
      description: t('command.sdo-design-grill'),
      handler: async (invocation) => {
        try {
          const argv = reader(invocation.rawInput)
          return ok(
            await deps.design(callOf(invocation), {
              action: 'grill',
              method: argv.option('method'),
              rationale: argv.option('rationale'),
              round: argv.numberOption('round'),
              by: argv.option('by'),
            }),
          )
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-design-answer',
      description: t('command.sdo-design-answer'),
      handler: async (invocation) => {
        try {
          const argv = reader(invocation.rawInput, ['--assume'])
          return ok(
            await deps.design(callOf(invocation), {
              action: 'answer',
              questionId: argv.option('id') ?? argv.option('question-id') ?? argv.option('questionId'),
              choice: argv.option('choice'),
              note: argv.option('note'),
              by: argv.option('by'),
              assume: argv.flag('assume'),
            }),
          )
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-design-confirm',
      description: t('command.sdo-design-confirm'),
      handler: async (invocation) => {
        try {
          const argv = reader(invocation.rawInput)
          return ok(
            await deps.design(callOf(invocation), {
              action: 'confirm',
              target: argv.option('target') ?? argv.option('id'),
              note: argv.option('note'),
              by: argv.option('by'),
            }),
          )
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-design-issues',
      description: t('command.sdo-design-issues'),
      handler: async (invocation) => {
        try {
          return ok(
            await deps.design(callOf(invocation), {
              action: 'issues',
              state: reader(invocation.rawInput).option('state'),
            }),
          )
        } catch (error) {
          return fail(error)
        }
      },
    },
    {
      name: 'sdo-design-render',
      description: t('command.sdo-design-render'),
      handler: async (invocation) => {
        try {
          // 这里必须声明 `puml`：声明过的开关会进 `ArgvReader.flag(...)`，"出现"与
          // "取值"才能分开（`--puml` = 默认落点；`--puml=路径` = 指定相对路径）。
          const argv = reader(invocation.rawInput, ['puml'])
          // 只写 `.puml` 骨架源码，**不渲染成图**（本仓库没有 PlantUML 渲染器）。
          const wanted = argv.flag('puml')
          const custom = argv.option('puml')
          return ok(await deps.design(callOf(invocation), {
            action: 'render',
            ...(wanted || custom !== undefined ? { puml: custom ?? 'true' } : {}),
          }))
        } catch (error) {
          return fail(error)
        }
      },
    },
  ], echo)
}
