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

import type { OfficeCall } from '../office.js'
import type { RedTeamArgs, RequirementArgs } from './tools.js'

/** 命令行为依赖，由插件入口注入。 */
export interface OfficeCommandDeps {
  status(call: OfficeCall, args: { rebuild?: boolean | undefined }): Promise<string>
  board(call: OfficeCall, args: { expand?: boolean | undefined; all?: boolean | undefined; write?: boolean | undefined }): Promise<string>
  requirement(call: OfficeCall, args: RequirementArgs): Promise<string>
  redteam(call: OfficeCall, args: RedTeamArgs): Promise<string>
  render(call: OfficeCall, args: { target?: string | undefined }): Promise<string>
}

function callOf(invocation: CommandInvocation): OfficeCall {
  const agent = invocation.agent
  return agent === undefined ? {} : { sessionId: String(agent.id) }
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
export function createOfficeCommands(deps: OfficeCommandDeps): CommandDefinition[] {
  return [
    {
      name: 'sdo-status',
      description: '查看 SDO 项目状态（阶段、门禁缺口、需求与开环问题计数）；`--rebuild` 强制从 journal 重建投影',
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
      description: '查看 SDO 文本看板；`--expand` 展开明细，`--all` 不受保留窗口限制，`--write` 落盘到 docs/BOARD.md',
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
      description: '列出需求（ID／优先级／状态／歧义评分／未决问题数）',
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
      description: '就需求生成下一批审讯问题（≤4 问，带选项与代价）；`--id=REQ-001` 限定需求，`--quick` 只问 P0',
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
      description: '回答问题：`--id=Q-0001 --answer="…" [--option=0]`；用户不知道时用 `--assume`（采用默认建议并记为假设）',
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
      description: '红队：`--attack` 生成质询问题；`--off` / `--on` 切换本会话红队（写 redteam/mode 留痕）；默认显示状态',
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
      name: 'sdo-render',
      description: '把 `.sdo/` 真源渲染成人类文档（M1：`--target=srs` → docs/SRS.md）',
      handler: async (invocation) => {
        try {
          return ok(await deps.render(callOf(invocation), { target: option(invocation.rawInput, 'target') }))
        } catch (error) {
          return fail(error)
        }
      },
    },
  ]
}
