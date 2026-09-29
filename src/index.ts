/**
 * dsh-software-dev-office（SDO）—— deepseek-harness (dsh) 原生 Cordis 插件。
 *
 * 基于软件工程方法论的 Agent 研发办公室：把「可行性 → 需求审讯 → 架构设计 → 拆分派发 →
 * 开发 → 验证 → 交付」做成可留痕、可门禁、可重放的流程，全部落在项目内的 `.sdo/`。
 *
 * 本文件只做**装配**：把配置、领域门面（{@link SoftwareDevOffice}）与三个界面
 * （提示注入 / 工具 / 命令）接起来。业务规则都在 `src/domain`、`src/infra`、`src/interface` 里。
 *
 * 入口纪律（C-07）：本插件**不在 profile 层插入自己**，只出现在 `sdo-office` preset 的
 * `config.plugins` 里；未选择该 preset 的会话完全不加载本插件。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { renderBoard } from './board/render.js'
import { Config, resolveSettings } from './config.js'
import type { SdoConfig } from './config.js'
import { makeAcceptanceIds } from './domain/requirements.js'
import { SdoStore } from './infra/store.js'
import {
  describeAnswer,
  describeBaseline,
  describeBoardNote,
  describeCapture,
  describeDesignGate,
  describeInit,
  describeProject,
  describeProjectUpdate,
  describeQuestions,
  describeRedTeam,
  describeRender,
  describeRequirementList,
  describeStatus,
} from './interface/describe.js'
import { renderStatusBlock } from './interface/inject.js'
import { createOfficeCommands } from './interface/commands.js'
import { createOfficeTools } from './interface/tools.js'
import type { InitArgs, ProjectArgs, RedTeamArgs, RequirementArgs } from './interface/tools.js'
import { SoftwareDevOffice } from './office.js'
import type { OfficeCall } from './office.js'
import type { AcceptanceCriterion, Dimension } from './types.js'

export const name = 'dsh-software-dev-office'

/** 需要会话存储来定位工作目录（设计 §11.6 的依赖清单）。 */
export const inject = ['sessions']

export { Config }
export type { SdoConfig }

/** 系统提示的 section 注册表（结构式读取，避免绑死内部类型）。 */
interface PromptSection {
  name: string
  order: number
  text: () => string
}

interface PromptSectionRegistry {
  context(section: PromptSection): () => void
}

/** 读取会话的工作目录（结构式读取；缺失表示该会话没有工作目录）。 */
function cwdOf(session: Session): string | undefined {
  const header = (session as { header?: { cwd?: unknown } }).header
  return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
}

/** 解析 JSON 参数；失败时给出可读错误。 */
function jsonOr<T>(value: string | undefined, label: string): { value?: T; error?: string } {
  if (value === undefined || value.trim() === '') return {}
  try {
    return { value: JSON.parse(value) as T }
  } catch (error) {
    return { error: `${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 插件入口。 */
export function apply(ctx: Context, config: SdoConfig): void {
  const settings = resolveSettings(config)
  const logger = ctx.logger(name)
  const office = new SoftwareDevOffice(settings)

  // 会话 → 工作目录：所有 .sdo/ 操作都以此定位项目。
  ctx.on('session/created', (session: Session) => {
    office.noteSession(String(session.id), cwdOf(session))
  })

  const deps = {
    async init(call: OfficeCall, args: InitArgs): Promise<string> {
      const result = office.init(call, args)
      return describeInit(result, settings.projectDirName)
    },

    async status(call: OfficeCall, args: { rebuild?: boolean | undefined }): Promise<string> {
      if (args.rebuild === true) office.rebuild(call)
      return describeStatus(office.status(call), settings.projectDirName)
    },

    async board(
      call: OfficeCall,
      args: { expand?: boolean | undefined; all?: boolean | undefined; write?: boolean | undefined },
    ): Promise<string> {
      const status = office.status(call)
      const model = {
        project: status.project,
        config: status.config,
        counts: status.counts,
        gates: office.gatesFor(call),
        requirements: office.boardRequirements(call),
        dataDirName: settings.projectDirName,
        truncated: status.truncated,
        ...(status.badLine === undefined ? {} : { badLine: status.badLine }),
      }
      const text = renderBoard(model, { expand: args.expand === true, all: args.all === true })
      if (args.write !== true) return text
      if (!settings.board.text) {
        return `${text}\n${describeBoardNote('看板写盘被禁用（board.text=false），未写入 docs/BOARD.md。')}`
      }
      const workspace = office.workspaceFor(call)
      const target = new SdoStore(workspace).writeText(['docs', 'BOARD.md'], text)
      return `${text}\n${describeBoardNote(`已写入 ${office.relativize(workspace, target)}。`)}`
    },

    async project(call: OfficeCall, args: ProjectArgs): Promise<string> {
      if (args.action === 'show') return describeProject(office.status(call), settings.projectDirName)
      if (args.action !== 'update') return `未知 action：${args.action}（可用：update | show）`
      const result = office.updateProject(call, {
        name: args.name,
        process: args.process,
        scale: args.scale,
        scopeIn: args.scopeIn,
        scopeOut: args.scopeOut,
        stakeholders: args.stakeholders,
        metricsSuccess: args.metricsSuccess,
        glossary: args.glossary,
      })
      return describeProjectUpdate(result)
    },

    async requirement(call: OfficeCall, args: RequirementArgs): Promise<string> {
      switch (args.action) {
        case 'capture': {
          if (typeof args.statement !== 'string' || args.statement.trim() === '') {
            return '捕获需求需要 `statement`（"系统须…"这样的可判定陈述）。请先向用户问清楚要做什么。'
          }
          const dims = jsonOr<Partial<Record<Dimension, number>>>(args.dimensions, 'dimensions')
          if (dims.error !== undefined) return dims.error
          const result = office.capture(call, {
            title: args.title ?? args.statement.slice(0, 40),
            statement: args.statement,
            rationale: args.rationale,
            kind: args.kind,
            priority: args.priority,
            sourceStakeholder: args.sourceStakeholder,
            sourceRaw: args.sourceRaw,
            modelDimensions: dims.value,
          })
          return describeCapture(result)
        }

        case 'grill': {
          const ids = args.id === undefined ? office.requirements(call).map((requirement) => requirement.id) : [args.id]
          if (ids.length === 0) return '还没有需求可追问：先用 `sdo_requirement action=capture` 捕获一条。'
          const limit = Math.max(1, Math.min(4, args.limit ?? 4))
          const result = office.grill(call, {
            requirementIds: ids,
            limit,
            quick: args.quick === true,
            includeBanned: true,
          })
          return describeQuestions(result.questions, result.skipped)
        }

        case 'answer': {
          if (args.id === undefined) return '回答问题需要 `id`（问题账本里的 Q-xxxx）。'
          const dims = jsonOr<Partial<Record<Dimension, number>>>(args.dimensions, 'dimensions')
          if (dims.error !== undefined) return dims.error
          if ((args.answer ?? '') === '' && args.assume !== true) {
            return '请给出 `answer`，或用 `assume=true` 表示用户不知道、采用问题的默认建议并记为假设。'
          }
          const result = office.answer(call, {
            id: args.id,
            answer: args.answer ?? '',
            pickedOption: args.pickedOption,
            by: args.by,
            assume: args.assume === true,
            modelDimensions: dims.value,
          })
          if (result === undefined) return `找不到问题 ${args.id}。`
          return describeAnswer(result)
        }

        case 'update': {
          if (args.id === undefined) return '更新需求需要 `id`。'
          const acceptance = jsonOr<{ given?: string; when?: string; then?: string }[]>(args.acceptance, 'acceptance')
          if (acceptance.error !== undefined) return acceptance.error
          const dims = jsonOr<Partial<Record<Dimension, number>>>(args.dimensions, 'dimensions')
          if (dims.error !== undefined) return dims.error

          const store = office.storeFor(office.workspaceFor(call))
          const rows = acceptance.value ?? []
          const ids = makeAcceptanceIds(store, rows.length)
          const criteria: AcceptanceCriterion[] = rows.map((row, index) => ({
            id: ids[index] ?? `AC-${index + 1}`,
            given: row.given ?? '',
            when: row.when ?? '',
            then: row.then ?? '',
          }))

          const patch = {
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.statement === undefined ? {} : { statement: args.statement }),
            ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
            ...(args.kind === undefined ? {} : { kind: args.kind }),
            ...(args.priority === undefined ? {} : { priority: args.priority }),
            ...(args.sourceStakeholder === undefined && args.sourceRaw === undefined
              ? {}
              : {
                  source: {
                    ...(args.sourceStakeholder === undefined ? {} : { stakeholder: args.sourceStakeholder }),
                    ...(args.sourceRaw === undefined ? {} : { raw: args.sourceRaw }),
                  },
                }),
          }
          const result = office.update(call, {
            id: args.id,
            ...(Object.keys(patch).length === 0 ? {} : { patch }),
            ...(criteria.length === 0 ? {} : { addAcceptance: criteria }),
            modelDimensions: dims.value,
          })
          if (result === undefined) return `找不到需求 ${args.id}。`
          return describeCapture(result)
        }

        case 'baseline': {
          if ((args.approvedBy ?? '').trim() === '') {
            return '基线需要人类签字：请传 `approvedBy`（设计 §15.3 G2 要求人类签字）。'
          }
          const outcome = office.baseline(call, { approvedBy: args.approvedBy })
          return describeBaseline(outcome)
        }

        case 'list':
          return describeRequirementList(office.requirements(call))

        default:
          return `未知 action：${args.action}（可用：capture | grill | answer | update | list | baseline）`
      }
    },

    async redteam(call: OfficeCall, args: RedTeamArgs): Promise<string> {
      switch (args.action) {
        case 'attack': {
          const ids = args.ids ?? office.requirements(call).map((requirement) => requirement.id)
          if (ids.length === 0) return '还没有需求可攻击：先 `sdo_requirement action=capture`。'
          const limit = Math.max(1, Math.min(7, args.limit ?? 4))
          const result = office.redTeamAttack(call, ids, limit)
          return describeRedTeam('attack', { questions: result.questions, skipped: result.skipped })
        }
        case 'off':
        case 'on': {
          office.setRedTeam(call, args.action === 'on', args.reason)
          return describeRedTeam(args.action, { reason: args.reason })
        }
        case 'status':
        default:
          return describeRedTeam('status', {
            enabled: !office.redTeamDisabled(call),
            executed: office.redTeamExecuted(call),
          })
      }
    },

    async render(call: OfficeCall, args: { target?: string | undefined }): Promise<string> {
      const target = args.target ?? 'srs'
      if (target !== 'srs') return `M1 只实现 \`srs\`；\`${target}\` 在后续里程碑提供。`
      const path = office.render(call, 'srs')
      const seq = office.journalFor(office.workspaceFor(call)).read().events.length
      return describeRender('SRS', path, seq)
    },

    async design(call: OfficeCall, args: { action?: string | undefined }): Promise<string> {
      const action = args.action ?? 'create'
      const check = office.designCheck(call)
      if (!check.allowed) return describeDesignGate(check, action)
      if (action === 'view') return describeDesignGate(check, action)
      return describeDesignGate(check, action)
    },
  }

  if (settings.injectStatus) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      const systemPrompt = promptCtx.get('systemPrompt') as PromptSectionRegistry
      promptCtx.effect(() => systemPrompt.context({
        name: 'sdo-status',
        order: settings.promptOrder,
        text: () => renderStatusBlock(
          office.status(office.currentCall()),
          settings.projectDirName,
          settings.statusChars,
        ),
      }), 'sdo:status-block')
    })
  }

  if (settings.registerTools) {
    ctx.inject(['tools'], (toolCtx) => {
      const tools = toolCtx.get('tools') as ToolRuntime
      for (const tool of createOfficeTools(deps)) {
        toolCtx.effect(() => tools.register(tool), `sdo:tool:${tool.name}`)
      }
    })
  }

  if (settings.registerCommands) {
    ctx.inject(['commands'], (commandCtx) => {
      const commands = commandCtx.get('commands') as CommandRuntime
      for (const command of createOfficeCommands(deps)) {
        commandCtx.effect(() => commands.register(command), `sdo:command:${command.name}`)
      }
    })
  }

  logger.debug(
    `sdo: ready (projectDir=${settings.projectDirName}, gateLevel=${settings.gateLevel}, `
    + `orchestrator=${settings.orchestrator}, tools=${settings.registerTools}, commands=${settings.registerCommands})`,
  )
}
