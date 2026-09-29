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
  describeAdvance,
  describeChange,
  describeFeasibility,
  describeGate,
  describeProject,
  describeProjectUpdate,
  describeQuestions,
  describeRedTeam,
  describeRender,
  describeRequirementList,
  describeRisks,
  describeStatus,
} from './interface/describe.js'
import { renderStatusBlock } from './interface/inject.js'
import { createOfficeCommands } from './interface/commands.js'
import { createOfficeTools } from './interface/tools.js'
import type { FeasibilityArgs, GateArgs, InitArgs, ProjectArgs, RedTeamArgs, RequirementArgs, RiskArgs } from './interface/tools.js'
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
        process: office.process(call),
        pendingGate: status.pendingGate,
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

    async gate(call: OfficeCall, args: GateArgs): Promise<string> {
      if (args.action === 'advance') {
        return describeAdvance(office.advance(call))
      }
      if (args.action === 'waive') {
        if (args.gate === undefined) return '豁免门禁需要 `gate`。'
        if ((args.reason ?? '').trim() === '' || (args.approver ?? '').trim() === '') {
          return '豁免必须留痕：请同时给出 `reason` 与 `approver`（设计 §7.5 / AC-003）。'
        }
        const recorded = office.waiveGate(call, args.gate, args.reason ?? '', args.approver ?? '')
        return `已豁免门禁 ${recorded.gate}（approver=${args.approver}，理由：${args.reason}）。\n${describeGate(recorded)}`
      }
      if (args.action !== 'check') return `未知 action：${args.action}（可用：check | advance | waive）`
      if (args.gate === undefined) return '判定门禁需要 `gate`（例如 G0 / G1 / G2 / G7）。'
      // 螺旋流程的风险象限门：先落本圈风险结论，再判定
      if (args.conclusion !== undefined) {
        office.concludeRisk(call, args.conclusion, args.rationale ?? args.reason ?? '', args.approvedBy ?? 'human')
      }
      return describeGate(office.checkGate(call, args.gate, args.approvedBy))
    },

    async feasibility(call: OfficeCall, args: FeasibilityArgs): Promise<string> {
      if (args.action !== 'assess') return `未知 action：${args.action}（可用：assess）`
      if (args.verdict === undefined) return '可行性评估需要 `verdict`（go / no-go / conditional）。'
      const telosRows = jsonOr<{ dimension?: string; verdict?: string; rationale?: string }[]>(args.telos, 'telos')
      if (telosRows.error !== undefined) return telosRows.error
      const telos: Partial<Record<'technical' | 'economic' | 'legal' | 'operational' | 'schedule', { verdict: string; rationale: string }>> = {}
      for (const row of telosRows.value ?? []) {
        const dimension = row.dimension
        if (dimension === 'technical' || dimension === 'economic' || dimension === 'legal' || dimension === 'operational' || dimension === 'schedule') {
          telos[dimension] = { verdict: row.verdict ?? '未评估', rationale: row.rationale ?? '' }
        }
      }
      const poc = jsonOr<string[]>(args.poc, 'poc')
      if (poc.error !== undefined) return poc.error
      const assessment = office.assessFeasibility(
        call,
        {
          verdict: args.verdict,
          rationale: args.rationale ?? '',
          ...(Object.keys(telos).length === 0 ? {} : { telos }),
          ...(poc.value === undefined ? {} : { poc: poc.value }),
        },
        args.by ?? 'human',
      )
      return describeFeasibility(assessment)
    },

    async risk(call: OfficeCall, args: RiskArgs): Promise<string> {
      switch (args.action) {
        case 'log': {
          if ((args.title ?? '').trim() === '' || args.level === undefined) {
            return '登记风险需要 `title` 与 `level`（low / medium / high / blocker）。'
          }
          const risk = office.logRisk(call, {
            title: args.title ?? '',
            level: args.level,
            probability: args.probability ?? 'medium',
            impact: args.impact ?? '',
            mitigation: args.mitigation ?? '',
            owner: args.owner ?? '',
            ...(args.origin === undefined ? {} : { origin: args.origin }),
          })
          const lines = [`已登记风险 ${risk.id}　[${risk.level}]　${risk.title}`]
          if (risk.mitigation.trim() === '' || risk.owner.trim() === '') {
            lines.push('- ⚠️ 缺 `mitigation` 或 `owner`：G1/GR 会拒绝（高/阻塞级风险必须有应对与责任人）')
          }
          if (risk.origin !== undefined && risk.origin.startsWith('REQ-ISSUE-')) {
            lines.push(`- 该风险指向红队议题 ${risk.origin}，议题因此视为闭环（设计 §5.4）`)
          }
          return lines.join('\n')
        }
        case 'update': {
          if (args.id === undefined) return '更新风险需要 `id`。'
          const updated = office.updateRisk(call, args.id, {
            ...(args.status === undefined ? {} : { status: args.status }),
            ...(args.mitigation === undefined ? {} : { mitigation: args.mitigation }),
            ...(args.owner === undefined ? {} : { owner: args.owner }),
            ...(args.level === undefined ? {} : { level: args.level }),
            ...(args.impact === undefined ? {} : { impact: args.impact }),
          })
          if (updated === undefined) return `找不到风险 ${args.id}。`
          return `已更新风险 ${updated.id}：${updated.status}　[${updated.level}]　${updated.title}`
        }
        case 'conclude': {
          if (args.conclusion === undefined) return '风险结论需要 `conclusion`（continue / adjust / stop）。'
          const record = office.concludeRisk(call, args.conclusion, args.rationale ?? '', args.owner ?? 'human')
          return `已记录本圈风险结论：${record.conclusion}（${record.rationale}）`
        }
        case 'list':
        default:
          return describeRisks(office.risks(call))
      }
    },

    async requirement(call: OfficeCall, args: RequirementArgs): Promise<string> {
      switch (args.action) {
        case 'capture': {
          if (typeof args.statement !== 'string' || args.statement.trim() === '') {
            return '捕获需求需要 `statement`（"系统须…"这样的可判定陈述）。请先向用户问清楚要做什么。'
          }
          const dims = jsonOr<Partial<Record<Dimension, number>>>(args.dimensions, 'dimensions')
          if (dims.error !== undefined) return dims.error
          const fromPrototype = args.source === 'prototype'
          const result = office.capture(call, {
            title: args.title ?? args.statement.slice(0, 40),
            statement: args.statement,
            rationale: args.rationale,
            kind: args.kind,
            priority: args.priority,
            sourceStakeholder: fromPrototype ? undefined : (args.source ?? args.sourceStakeholder),
            sourceRaw: args.sourceRaw,
            prototypeSource: fromPrototype,
            modelDimensions: dims.value,
          })
          const text = describeCapture(result)
          return fromPrototype ? `${text}\n- 已标记来源为**原型回填**（source=prototype）。` : text
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

        case 'change': {
          if (args.id === undefined) return '变更需要 `id`。'
          if ((args.reason ?? '').trim() === '') return '变更必须给出 `reason`（设计 §5.5：变更内容 + 理由 + 影响分析 + 决策）。'
          if (args.decision === undefined) return '变更必须给出 `decision`（approved / rejected / deferred）。'
          const patch = {
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.statement === undefined ? {} : { statement: args.statement }),
            ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
            ...(args.priority === undefined ? {} : { priority: args.priority }),
            ...(args.kind === undefined ? {} : { kind: args.kind }),
          }
          const changes: string[] = []
          if (args.statement !== undefined) changes.push(`陈述改为：${args.statement}`)
          if (args.priority !== undefined) changes.push(`优先级改为：${args.priority}`)
          if (args.title !== undefined) changes.push(`标题改为：${args.title}`)
          if (changes.length === 0) changes.push('（仅记录变更请求，未给出具体字段）')
          return describeChange(
            office.change(call, {
              requirement: args.id,
              reason: args.reason ?? '',
              changes,
              decision: args.decision,
              decidedBy: args.decidedBy ?? args.by ?? 'human',
              ...(Object.keys(patch).length === 0 ? {} : { patch }),
            }),
          )
        }

        case 'list':
          return describeRequirementList(office.requirements(call))

        default:
          return `未知 action：${args.action}（可用：capture | grill | answer | update | change | list | baseline）`
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
