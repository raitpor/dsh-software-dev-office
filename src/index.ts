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
import { contractCoverage } from './domain/contracts.js'
import { makeAcceptanceIds } from './domain/requirements.js'
import { SdoStore } from './infra/store.js'
import {
  describeAdr,
  describeAdrList,
  describeAdvance,
  describeAnswer,
  describeAssessment,
  describeBaseline,
  describeBoardNote,
  describeCapture,
  describeChange,
  describeContract,
  describeDesign,
  describeDesignElement,
  describeDesignGate,
  describeFeasibility,
  describeGate,
  describeInit,
  describeProject,
  describeProjectUpdate,
  describeQuestions,
  describeRedTeam,
  describeRender,
  describeRequirementList,
  describeRisks,
  describeScenario,
  describeScenarioList,
  describeStatus,
  describeDispatch,
  describeInlineHandoff,
  describeManifest,
  describePlan,
  describeTask,
  describeTaskBoard,
  describeTaskConflict,
  describeTrace,
} from './interface/describe.js'
import { renderStatusBlock } from './interface/inject.js'
import { createOfficeCommands } from './interface/commands.js'
import { createOfficeTools, parseList } from './interface/tools.js'
import { buildDispatch, pickBackend } from './integration/orchestrator.js'
import type { BackendProbe, BackendKind } from './integration/orchestrator.js'
import type {
  AdrArgs,
  DeliverArgs,
  DesignArgs,
  FeasibilityArgs,
  GateArgs,
  InitArgs,
  PlanArgs,
  ProjectArgs,
  QualityArgs,
  RedTeamArgs,
  RequirementArgs,
  ReviewArgs,
  RiskArgs,
  TaskArgs,
  TestArgs,
  TraceArgs,
} from './interface/tools.js'
import { SoftwareDevOffice } from './office.js'
import type { OfficeCall } from './office.js'
import { VIEW_KINDS } from './types.js'
import type { AcceptanceCriterion, Dimension, EvidenceItem, ViewKind } from './types.js'

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

/** 视图种类解析（非法值返回 undefined，由调用方给可读错误）。 */
function parseViewKind(value: string | undefined): ViewKind | undefined {
  return value !== undefined && (VIEW_KINDS as readonly string[]).includes(value) ? (value as ViewKind) : undefined
}

/** 契约种类解析。 */
function parseContractKind(value: string | undefined): 'http' | 'event' | 'rpc' | 'schema' {
  return value === 'http' || value === 'event' || value === 'rpc' ? value : 'schema'
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

  /**
   * plan mode 适配器（设计 §8.5 / Q-17 / Q-20）。
   * `dsh-plan-mode` 只在装了它的组合里存在，因此这里**软探测**：拿不到就让设计阶段按 Q-20 阻塞。
   */
  interface PlanModeLike {
    get(agent: unknown): { active: boolean }
    set(agent: unknown, active: boolean): string
  }
  let planMode: PlanModeLike | undefined
  ctx.inject(['planMode'], (planCtx) => {
    planMode = planCtx.get('planMode') as PlanModeLike
  })
  /** 派发后端探测（软探测：宿主没有对应服务就降级为 inline）。 */
  let subagentsService: unknown
  ctx.inject(['subagents'], (subCtx) => {
    subagentsService = subCtx.get('subagents')
  })
  const backendProbe = (): BackendProbe => ({
    subagent: subagentsService !== undefined,
    nativeTeam: false,
    inline: true,
  })
  let lastBackend: { backend: BackendKind; iteration?: number | undefined } | undefined

  const planAdapter = {
    status(agent: unknown): { available: boolean; active: boolean } {
      // 没有 plan mode 服务、或这次调用拿不到 agent 引用 ⇒ 我们既不能驱动也不能查询计划评审，
      // 因此按 Q-20 视为"无交互评审通道"（绝不能假装进入了 plan mode）
      if (planMode === undefined || agent === undefined) return { available: false, active: false }
      try {
        return { available: true, active: planMode.get(agent).active === true }
      } catch {
        return { available: true, active: false }
      }
    },
    enter(agent: unknown): string {
      if (planMode === undefined || agent === undefined) return 'unavailable'
      try {
        return planMode.set(agent, true)
      } catch (error) {
        return `error:${error instanceof Error ? error.message : String(error)}`
      }
    },
  }

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

    async plan(call: OfficeCall, args: PlanArgs): Promise<string> {
      if (args.action === 'decompose') {
        const requirements = jsonOr<string[]>(args.requirements, 'requirements')
        if (requirements.error !== undefined) return requirements.error
        const suggestions = jsonOr<Record<string, unknown>[]>(args.suggestions, 'suggestions')
        if (suggestions.error !== undefined) return suggestions.error
        const result = office.planDecompose(call, {
          ...(requirements.value === undefined ? {} : { requirements: requirements.value }),
          ...(suggestions.value === undefined
            ? {}
            : {
                suggestions: suggestions.value.map((row) => ({
                  title: String(row.title ?? '(未命名卡片)'),
                  dod: Array.isArray(row.dod) ? row.dod.map(String) : [],
                  role: String(row.role ?? 'developer'),
                  ...(Array.isArray(row.writeScopes) ? { writeScopes: row.writeScopes.map(String) } : {}),
                  ...(row.size === 'small' || row.size === 'medium' || row.size === 'large' ? { size: row.size } : {}),
                })),
              }),
          ...(office.iteration(call) === undefined ? {} : { iteration: office.iteration(call)?.number }),
        })
        return describePlan(result.tasks, result.issues)
      }

      if (args.action === 'iteration') {
        if ((args.goal ?? '').trim() === '') return '开迭代需要 `goal`（没有目标的迭代无法判定"完成"）。'
        const iteration = office.startIteration(call, args.goal ?? '')
        return `已开启迭代 ${iteration.number}：${iteration.goal}（status=${iteration.status}）\n- 下一步：\`sdo_plan action=decompose\` 拆出本迭代的卡，然后 \`sdo_plan action=next\` 派发。`
      }

      if (args.action !== 'next') return `未知 action：${args.action}（可用：decompose | iteration | next）`

      const plan = office.dispatchPlan(call)
      if (plan.dispatch.length === 0) {
        const issues = office.planIssues(call)
        if (issues.length > 0) return describePlan(office.tasks(call), issues)
        return plan.queued.length === 0
          ? '没有可派发的任务卡（都已认领/完成）。用 `sdo_task action=list` 看全貌。'
          : `容量已满：${plan.queued.length} 张卡在排队（\`maxParallelDispatch\` = ${settings.maxParallelDispatch}）。`
      }

      const preference = args.backend === 'subagent' || args.backend === 'native-team' || args.backend === 'inline' ? args.backend : 'auto'
      const iteration = office.iteration(call)
      const decision = pickBackend(preference, backendProbe(), lastBackend, iteration?.number)
      const take = Math.max(1, Math.min(args.limit ?? 1, plan.dispatch.length))
      const picked = plan.dispatch.slice(0, take)
      const out: string[] = []
      for (const [index, task] of picked.entries()) {
        const owner = decision.backend === 'inline' ? 'cockpit' : `${decision.backend}:${task.role}:${index + 1}`
        const request = buildDispatch({ task, backend: decision.backend, owner, projectName: office.status(call).project?.name ?? '' })
        office.recordDispatch(call, {
          taskId: task.id,
          backend: decision.backend,
          owner,
          ...(decision.degradedReason === undefined ? {} : { degradedReason: decision.degradedReason }),
        })
        lastBackend = { backend: decision.backend, iteration: iteration?.number }
        out.push(
          decision.backend === 'inline'
            ? describeInlineHandoff(request, decision.degradedReason)
            : describeDispatch(request, decision.degradedReason),
        )
      }
      const tail = plan.queued.length === 0 ? '' : `\n- 另有 ${plan.queued.length} 张卡在容量队列里等待。`
      return `${out.join('\n\n')}${tail}`
    },

    async task(call: OfficeCall, args: TaskArgs): Promise<string> {
      switch (args.action) {
        case 'claim': {
          if (args.id === undefined || args.owner === undefined || args.expectedRevision === undefined) {
            return '认领需要 `id`、`owner` 与 `expectedRevision`（CAS：你读到的版本号）。'
          }
          const result = office.claimTask(call, { taskId: args.id, owner: args.owner, expectedRevision: args.expectedRevision })
          return result.ok ? describeTask(result.task) : describeTaskConflict(result.detail, result.current, result.code)
        }
        case 'done':
        case 'block': {
          if (args.id === undefined || args.owner === undefined) return '回报需要 `id` 与 `owner`。'
          const evidence = jsonOr<{ kind: string; detail: string }[]>(args.evidence, 'evidence')
          if (evidence.error !== undefined) return evidence.error
          const items: EvidenceItem[] = (evidence.value ?? []).map((row) => ({
            kind: row.kind === 'command' || row.kind === 'workspace-changes' ? row.kind : 'artifact',
            detail: String(row.detail ?? ''),
            at: new Date().toISOString(),
          }))
          const result = office.reportTask(call, {
            taskId: args.id,
            owner: args.owner,
            status: args.action === 'done' ? 'done' : 'blocked',
            ...(items.length === 0 ? {} : { evidence: items }),
            ...(args.note === undefined ? {} : { note: args.note }),
          })
          return result.ok ? describeTask(result.task) : `回报被拒（${result.code}）：${result.detail}`
        }
        case 'release':
        case 'reassign': {
          if (args.id === undefined) return '需要 `id`。'
          const actor = args.actor ?? 'cockpit'
          const reason = args.reason ?? '（未说明）'
          const task =
            args.action === 'release'
              ? office.releaseTask(call, { taskId: args.id, actor, reason })
              : args.owner === undefined
                ? undefined
                : office.reassignTask(call, { taskId: args.id, actor, owner: args.owner, reason })
          if (task === undefined) return `${args.action === 'reassign' && args.owner === undefined ? '改派需要 `owner`。' : `找不到任务卡 ${args.id}。`}`
          return `${args.action === 'release' ? '已释放' : '已改派'}：${describeTask(task)}`
        }
        case 'list':
        default:
          return describeTaskBoard({
            tasks: office.tasks(call),
            ready: office.readyForDispatch(call, 64),
            stale: office.staleTasks(call),
            issues: office.planIssues(call),
            iteration: office.iteration(call),
          })
      }
    },

    async test(call: OfficeCall, args: TestArgs): Promise<string> {
      switch (args.action) {
        case 'plan': {
          if ((args.title ?? '') === '' || (args.expected ?? '') === '') return '写用例需要 `title` 与 `expected`。'
          const steps = jsonOr<string[]>(args.steps, 'steps')
          if (steps.error !== undefined) return steps.error
          const testCase = office.addTestCase(call, {
            title: args.title ?? '',
            kind: args.kind ?? 'unit',
            ...(args.requirement === undefined ? {} : { requirement: args.requirement }),
            steps: steps.value ?? [],
            expected: args.expected ?? '',
          })
          return `已记录用例 ${testCase.id}　[${testCase.kind}]　${testCase.title}${testCase.requirement === undefined ? '' : `　（覆盖 ${testCase.requirement}）`}`
        }
        case 'record': {
          if (args.caseId === undefined || args.status === undefined) return '记录结果需要 `caseId` 与 `status`。'
          if (args.status === 'pass' && (args.evidence ?? '').trim() === '') {
            return '通过也必须带 `evidence`（命令 + 输出摘要，或产物路径）——否则这个"通过"没有证据。'
          }
          const result = office.addTestResult(call, {
            caseId: args.caseId,
            status: args.status === 'fail' ? 'fail' : args.status === 'skip' ? 'skip' : 'pass',
            evidence: args.evidence ?? '',
          })
          const stats = office.verification(call)
          return `已记录结果 ${result.id}：${result.caseId} → ${result.status}\n- 用例 ${stats.cases} 条 ｜ 通过 ${stats.passed} ｜ 失败 ${stats.failed} ｜ 未关闭缺陷 ${stats.defectsOpen}`
        }
        case 'defect': {
          if (args.defectId !== undefined) {
            const status = args.status === 'fixed' || args.status === 'closed' || args.status === 'wontfix' ? args.status : 'open'
            const defect = office.setDefectStatus(call, args.defectId, status)
            return defect === undefined ? `找不到缺陷 ${args.defectId}。` : `已更新缺陷 ${defect.id} → ${defect.status}`
          }
          if ((args.title ?? '') === '' || args.severity === undefined) return '登记缺陷需要 `title` 与 `severity`（blocker/major/minor）。'
          const defect = office.addDefect(call, {
            title: args.title ?? '',
            severity: args.severity,
            ...(args.caseId === undefined ? {} : { caseId: args.caseId }),
            status: args.status === 'fixed' || args.status === 'closed' || args.status === 'wontfix' ? args.status : 'open',
          })
          return `已登记缺陷 ${defect.id}　[${defect.severity}/${defect.status}]　${defect.title}`
        }
        case 'list':
        default: {
          const stats = office.verification(call)
          const lines = [`用例 ${stats.cases} 条 ｜ 结果 ${stats.results}（通过 ${stats.passed} / 失败 ${stats.failed} / 跳过 ${stats.skipped}）｜ 未关闭缺陷 ${stats.defectsOpen}（阻塞 ${stats.blockersOpen}）`]
          for (const testCase of office.testCases(call)) {
            lines.push(`- ${testCase.id}　[${testCase.kind}]　${testCase.title}${testCase.requirement === undefined ? '' : `　（覆盖 ${testCase.requirement}）`}`)
          }
          for (const defect of office.defects(call)) lines.push(`- ${defect.id}　[${defect.severity}/${defect.status}]　${defect.title}`)
          return lines.join('\n')
        }
      }
    },

    async review(call: OfficeCall, args: ReviewArgs): Promise<string> {
      if (args.action !== 'record') {
        const reviews = office.reviews(call)
        if (reviews.length === 0) return '还没有评审记录。用 `sdo_review action=record`（评审者 ≠ 作者）。'
        return [
          `评审 ${reviews.length} 条：`,
          ...reviews.map((review) => `- ${review.id}　${review.taskId}　${review.verdict}（${review.reviewer}）`),
          ...office.reviewViolations(call).map((item) => `- ⚠️ 独立性违规：${item.detail}`),
        ].join('\n')
      }
      if (args.taskId === undefined || args.reviewer === undefined || args.verdict === undefined) {
        return '记录评审需要 `taskId`、`reviewer` 与 `verdict`。'
      }
      const findings = jsonOr<string[]>(args.findings, 'findings')
      if (findings.error !== undefined) return findings.error
      const task = office.taskById(call, args.taskId)
      if (task === undefined) return `找不到任务卡 ${args.taskId}。`
      if (task.owner === args.reviewer) {
        return `评审独立性违规：${args.taskId} 的作者也是 ${args.reviewer}。请换一位评审者（设计 §8.7）。`
      }
      const review = office.addReview(call, {
        taskId: args.taskId,
        reviewer: args.reviewer,
        verdict: args.verdict,
        findings: findings.value ?? [],
      })
      return `已记录评审 ${review.id}：${review.taskId} → ${review.verdict}（评审者 ${review.reviewer}${task.owner === undefined ? '' : `，作者 ${task.owner}`}）`
    },

    async deliver(call: OfficeCall, args: DeliverArgs): Promise<string> {
      if (args.action !== 'package') {
        const manifest = office.manifest(call)
        return manifest === undefined ? '还没有交付包。用 `sdo_deliver action=package`。' : describeManifest(manifest)
      }
      const artifacts = jsonOr<{ path: string; kind?: string }[]>(args.artifacts, 'artifacts')
      if (artifacts.error !== undefined) return artifacts.error
      if ((artifacts.value ?? []).length === 0) return '打包需要 `artifacts`（JSON 数组：相对路径 + 类型）。'
      const acceptance = jsonOr<{ requirement: string; criterion: string; evidence: string; verdict?: string }[]>(args.acceptance, 'acceptance')
      if (acceptance.error !== undefined) return acceptance.error
      if ((args.rollbackPoint ?? '').trim() === '') return '打包需要 `rollbackPoint`（出问题退回到哪个已知状态）。'
      const result = office.packageDelivery(call, {
        by: args.by ?? 'human',
        artifacts: (artifacts.value ?? []).map((row) => ({
          path: row.path,
          kind:
            row.kind === 'docs' || row.kind === 'config' || row.kind === 'schema' || row.kind === 'test'
              ? row.kind
              : 'source',
        })),
        acceptance: (acceptance.value ?? []).map((row) => ({
          requirement: row.requirement,
          criterion: row.criterion,
          evidence: row.evidence,
          verdict: row.verdict === 'fail' || row.verdict === 'waived' ? row.verdict : 'pass',
        })),
        rollbackPoint: args.rollbackPoint ?? '',
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      })
      const docs = office.renderVerificationDocs(call)
      const lines = [describeManifest(result.manifest)]
      if (result.missingArtifacts.length > 0) lines.push(`- ⚠️ 这些产物在盘上找不到（哈希算不出来）：${result.missingArtifacts.join(' ')}`)
      lines.push(`- 已渲染：${docs.join('、')}`)
      return lines.join('\n')
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

    async design(call: OfficeCall, args: DesignArgs): Promise<string> {
      const action = args.action === '' ? 'view' : args.action
      if (action === 'view') return describeDesign(office.views(call), office.contracts(call))

      // 两道门：G2 已过 + 计划评审已完成（无交互评审通道时按 Q-20 阻塞）
      const outcome = office.designPrecondition(call, planAdapter.status(call.agent))
      switch (outcome.kind) {
        case 'no-project':
          return '尚未初始化：先调用 `sdo_init`。'
        case 'blocked-no-reviewer':
          return [
            `进入设计被阻塞：${outcome.reason}。`,
            '- 架构阶段要求**先过计划评审**（设计 Q-17：SDO 主动驱动 plan mode），而本环境没有交互式评审通道。',
            '- 已写 `plan/review-blocked` 留痕；**不进入 plan mode、不触达 G3、不提供跳过开关**（Q-20）。',
            '- remedy：在 Web/CLI 会话里继续（新建一个选择 `sdo-office` 的会话，接续同一个 `.sdo/`）。',
          ].join('\n')
        case 'needs-plan-mode': {
          const result = planAdapter.enter(call.agent)
          if (result === 'unavailable' || result.startsWith('error')) {
            // 驱动失败也必须阻塞并留痕，而不是"以为进入了 plan mode"
            office.markPlanBlocked(call, 'plan mode could not be entered for this call')
            return [
              '进入设计被阻塞：无法为本次调用驱动 plan mode（缺少 agent 引用或服务异常）。',
              '- 已写 `plan/review-blocked` 留痕；不进入 plan mode、不触达 G3（Q-20）。',
              '- remedy：在 Web/CLI 会话里继续（那里的交互式评审通道可用）。',
            ].join('\n')
          }
          office.markPlanEntered(call)
          return [
            `已进入 plan mode（${result}）：先做探索与方案比较，不要落笔实现。`,
            '- 请用户评审架构计划；通过后由 `exit_plan_mode` 结束计划模式（这是第一道门）。',
            '- 计划通过后再调 `sdo_design action=create` 写入视图与元素（第二道门是 G3）。',
          ].join('\n')
        }
        case 'plan-review-pending':
          return '计划评审尚未完成：仍在 plan mode。请用户评审并用 `exit_plan_mode` 通过后再写入设计。'
        case 'gate-blocked':
          return describeDesignGate(outcome.check, action)
        case 'ready':
          break
      }

      if (action === 'contract') {
        if ((args.producer ?? '') === '' || (args.consumer ?? '') === '' || (args.schema ?? '') === '') {
          return '记录契约需要 `producer`、`consumer` 与 `schema`（契约正文）。'
        }
        const contract = office.recordContract(call, {
          name: `${args.consumer} → ${args.producer}`,
          kind: parseContractKind(args.contractKind),
          producer: args.producer ?? '',
          consumer: args.consumer ?? '',
          schema: args.schema ?? '',
          failureSemantics: {
            timeout: args.timeout ?? '',
            retry: args.retry ?? '',
            idempotency: args.idempotency ?? '',
          },
        })
        const coverage = contractCoverage(office.storeFor(office.workspaceFor(call)))
        return describeContract(contract, coverage)
      }

      if (action !== 'create') return `未知 action：${action}（可用：create | contract | view）`
      const kind = parseViewKind(args.kind)
      if (kind === undefined) return "创建元素需要 `kind`（context | component | runtime | data | deployment）。"
      if ((args.name ?? '') === '') return '创建元素需要 `name`。'
      const result = office.upsertElement(call, {
        kind,
        ...(args.id === undefined ? {} : { id: args.id }),
        name: args.name ?? '',
        elementKind: args.elementKind,
        responsibility: args.responsibility,
        dependsOn: parseList(args.dependsOn),
        summary: args.summary,
      })
      return describeDesignElement(result)
    },

    async adr(call: OfficeCall, args: AdrArgs): Promise<string> {
      switch (args.action) {
        case 'record':
        case 'supersede': {
          if ((args.title ?? '') === '' || (args.decision ?? '') === '') return 'ADR 需要 `title` 与 `decision`。'
          const alternatives = jsonOr<{ option: string; pros: string; cons: string }[]>(args.alternatives, 'alternatives')
          if (alternatives.error !== undefined) return alternatives.error
          const consequences = jsonOr<string[]>(args.consequences, 'consequences')
          if (consequences.error !== undefined) return consequences.error
          if ((alternatives.value ?? []).length === 0) {
            return 'ADR 必须给出**备选方案**（`alternatives` JSON 数组，含 pros/cons）——G3 会拒绝只有结论的决策。'
          }
          if ((consequences.value ?? []).length === 0) {
            return 'ADR 必须给出**后果**（`consequences` JSON 数组，包含你不喜欢的那些）。'
          }
          const adr = office.recordAdr(call, {
            title: args.title ?? '',
            context: args.context ?? '',
            decision: args.decision ?? '',
            alternatives: alternatives.value ?? [],
            consequences: consequences.value ?? [],
            ...(args.action === 'supersede' && args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
          })
          return describeAdr(adr, args.supersedes)
        }
        case 'list':
        default:
          return describeAdrList(office.adrs(call))
      }
    },

    async quality(call: OfficeCall, args: QualityArgs): Promise<string> {
      switch (args.action) {
        case 'scenario': {
          if ((args.attribute ?? '') === '' || (args.measure ?? '') === '') {
            return '质量场景需要 `attribute` 与**可测的** `measure`（指标 + 条件 + 阈值）。'
          }
          if (!/\d/u.test(args.measure ?? '') && !/[≥≤<>]=?/u.test(args.measure ?? '')) {
            return `度量不可测：${args.measure}。请写成"指标 + 条件 + 阈值"（含数值或阈值符号）。`
          }
          const scenario = office.recordScenario(call, {
            attribute: args.attribute ?? '',
            stimulus: args.stimulus ?? '',
            response: args.response ?? '',
            measure: args.measure ?? '',
            priority: args.priority,
            targets: parseList(args.targets),
          })
          return describeScenario(scenario)
        }
        case 'evaluate': {
          const risks = jsonOr<string[]>(args.risks, 'risks')
          if (risks.error !== undefined) return risks.error
          const sensitivities = jsonOr<string[]>(args.sensitivities, 'sensitivities')
          const tradeoffs = jsonOr<string[]>(args.tradeoffs, 'tradeoffs')
          const assessment = office.assessQuality(call, {
            risks: risks.value ?? [],
            sensitivities: sensitivities.value ?? [],
            tradeoffs: tradeoffs.value ?? [],
            by: args.by ?? 'human',
          })
          return describeAssessment(assessment)
        }
        case 'list':
        default:
          return describeScenarioList(office.scenarios(call))
      }
    },

    async trace(call: OfficeCall, args: TraceArgs): Promise<string> {
      switch (args.action) {
        case 'link': {
          const batch = jsonOr<{ from: string; to: string; kind: string }[]>(args.links, 'links')
          if (batch.error !== undefined) return batch.error
          const inputs =
            batch.value ??
            (args.from !== undefined && args.to !== undefined && args.kind !== undefined
              ? [{ from: args.from, to: args.to, kind: args.kind }]
              : [])
          if (inputs.length === 0) return '建立追溯边需要 `from`/`to`/`kind`，或用 `links` 传 JSON 数组。'
          try {
            const result = office.linkTrace(call, inputs)
            const data = office.traceReport(call)
            return [
              `已建立 ${result.created} 条追溯边（请求 ${inputs.length} 条）。`,
              `- 需求覆盖率：${Math.round(data.coverage * 100)}% ｜ 孤儿：设计 ${data.orphans.design.length} / 任务 ${data.orphans.tasks.length} / 测试 ${data.orphans.tests.length}`,
              `- must 需求缺测试用例：${data.uncoveredMust.length === 0 ? '无' : data.uncoveredMust.join(' ')}`,
            ].join('\n')
          } catch (error) {
            return error instanceof Error ? error.message : String(error)
          }
        }
        case 'report': {
          const path = office.renderTrace(call)
          return `已渲染追溯报告 → \`${path}\`（派生视图，含覆盖率与孤儿清单）。`
        }
        case 'query':
        default:
          return describeTrace(office.traceReport(call))
      }
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
