/**
 * 派发适配层（设计 §8.3 / T-M4-04、§8.7 / T-M4-06）。
 *
 * 三种后端，**同一次派发只用一个**（二选一约束：同一迭代内不混用，切换必须留痕）：
 *   · `subagent`    —— dsh 原生子代理（角色靠 persona + toolFilter 隔离）
 *   · `native-team` —— dsh 原生团队（若该装配提供）
 *   · `inline`      —— 降级：不派发，把任务卡交给主模型就地执行（依然走同一套认领/证据协议）
 *
 * 适配层只做**决策与请求构造**，真正的宿主调用在 index.ts 里（拿不到宿主服务就降级到 inline）。
 */
import { toolAllowList } from '../domain/roles.js'
import type { TaskCard } from '../types.js'

/** 取某角色的工具白名单：优先随包掩码表，读不到就退回内置兜底（绝不静默给全量工具）。 */
export function roleToolFilter(role: string): string[] {
  try {
    const list = toolAllowList(role as never)
    if (list.length > 0) return list
  } catch {
    /* 数据缺失时退回兜底 */
  }
  return TOOL_FILTER_FALLBACK[role] ?? TOOL_FILTER_FALLBACK['developer'] ?? []
}

export type BackendKind = 'subagent' | 'native-team' | 'inline'

export interface BackendProbe {
  subagent: boolean
  nativeTeam: boolean
  /** inline 永远可用（它就是"不派发"） */
  inline: true
}

export interface BackendDecision {
  backend: BackendKind
  /** 降级原因（首选后端不可用，或按二选一约束落到已用后端） */
  degradedReason?: string | undefined
  /** 相对首选是否发生了切换 */
  switched: boolean
}

/**
 * 选后端。`preference` 为 'auto' 时按 subagent > native-team > inline 选；
 * 指定了不可用的后端则**降级**并说明原因（不静默换）。
 */
export function pickBackend(
  preference: BackendKind | 'auto',
  probe: BackendProbe,
  previous?: { backend: BackendKind; iteration?: number | undefined } | undefined,
  iteration?: number | undefined,
): BackendDecision {
  const available = (kind: BackendKind): boolean =>
    kind === 'subagent' ? probe.subagent : kind === 'native-team' ? probe.nativeTeam : true

  let chosen: BackendKind
  let reason: string | undefined
  if (preference === 'auto') {
    chosen = probe.subagent ? 'subagent' : probe.nativeTeam ? 'native-team' : 'inline'
    if (chosen === 'inline' && !probe.subagent && !probe.nativeTeam) reason = '宿主没有可用的派发后端，降级为就地执行'
  } else if (available(preference)) {
    chosen = preference
  } else {
    chosen = 'inline'
    reason = `${preference} 后端不可用，降级为就地执行`
  }

  // 二选一约束：同一迭代内保持同一个后端（避免半张卡在一个后端、半张在另一个）
  if (
    reason === undefined &&
    previous !== undefined &&
    previous.backend !== chosen &&
    (previous.iteration === undefined || iteration === undefined || previous.iteration === iteration)
  ) {
    return {
      backend: previous.backend,
      degradedReason: `本迭代已用 ${previous.backend}，按二选一约束继续用它（如需切换请显式说明并留痕）`,
      switched: false,
    }
  }

  return { backend: chosen, switched: previous !== undefined && previous.backend !== chosen, ...(reason === undefined ? {} : { degradedReason: reason }) }
}

/** 容量预算：同时进行中的派发不超过 `maxParallel`（默认 4）。 */
export function capacityPlan(
  ready: TaskCard[],
  inProgress: number,
  maxParallel = 4,
): { dispatch: TaskCard[]; queued: TaskCard[] } {
  const room = Math.max(0, maxParallel - inProgress)
  return { dispatch: ready.slice(0, room), queued: ready.slice(room) }
}

/** 角色 → persona 名（与 `presets/sdo-office.patch.yml` 里的 persona 对齐）。 */
export const PERSONA_BY_ROLE: Record<string, string> = {
  analyst: 'sdo-analyst',
  'red-team': 'sdo-red-team',
  architect: 'sdo-architect',
  office: 'sdo-office',
  developer: 'sdo-developer',
  tester: 'sdo-tester',
  reviewer: 'sdo-reviewer',
  delivery: 'sdo-delivery',
}

/**
 * 角色工具面的**兜底**表（随包数据读不到时用）。
 * 正常路径走 `src/data/roles.yml` 的 allow 列表（`domain/roles.ts`），避免两份真相。
 */
export const TOOL_FILTER_FALLBACK: Record<string, string[]> = {
  analyst: ['read', 'grep', 'glob', 'write'],
  'red-team': ['read', 'grep', 'glob'],
  architect: ['read', 'grep', 'glob', 'write'],
  office: ['read', 'grep', 'glob', 'write'],
  developer: ['read', 'grep', 'glob', 'write', 'edit', 'bash'],
  tester: ['read', 'grep', 'glob', 'write', 'edit', 'bash'],
  reviewer: ['read', 'grep', 'glob'],
  delivery: ['read', 'grep', 'glob', 'write', 'bash'],
}

export interface DispatchRequest {
  task: TaskCard
  backend: BackendKind
  owner: string
  persona: string
  toolFilter: string[]
  /** 交给执行者的提示词（含协议与证据要求） */
  prompt: string
  expectedRevision: number
  writeScopes: string[]
}

/** 构造派发请求（纯函数，便于夹具测试）。 */
export function buildDispatch(input: {
  task: TaskCard
  backend: BackendKind
  owner: string
  projectName: string
}): DispatchRequest {
  const { task } = input
  const persona = PERSONA_BY_ROLE[task.role] ?? 'sdo-developer'
  const toolFilter = roleToolFilter(task.role)
  const prompt = [
    `你是 ${persona}（角色 ${task.role}），在 SDO 项目「${input.projectName}」里执行任务卡 ${task.id}。`,
    '',
    `目标：${task.goal}`,
    task.inputs.length === 0 ? '' : `输入：${task.inputs.join('；')}`,
    task.outputs.length === 0 ? '' : `输出：${task.outputs.join('；')}`,
    `完成定义（DoD）：${task.dod.join('；')}`,
    `证据要求：${task.evidenceRequired.join(' / ')}（done 时必须给出，空口完成不算完成）`,
    `写范围（只许改这些路径）：${task.writeScopes.join('、') || '（未限定，请先与流程官确认）'}`,
    '',
    '协议：',
    `1) 先用 \`sdo_task action=claim id=${task.id} expectedRevision=${task.revision}\` 认领（CAS，冲突就重新读卡）；`,
    '2) 只改写范围内的文件；',
    `3) 完成后 \`sdo_task action=done id=${task.id} owner=${input.owner}\` 并附证据；`,
    '4) 做不下去就 `sdo_task action=block id=… note=…`，不要硬撑也不要静默改范围。',
  ]
    .filter((line) => line !== '')
    .join('\n')
  return {
    task,
    backend: input.backend,
    owner: input.owner,
    persona,
    toolFilter,
    prompt,
    expectedRevision: task.revision,
    writeScopes: task.writeScopes,
  }
}

/** 越界写复核（T-M4-03）：声明范围之外的改动必须被点出来。 */
export function auditWriteScopes(changedFiles: string[], writeScopes: string[]): { ok: boolean; violations: string[] } {
  if (writeScopes.length === 0) return { ok: true, violations: [] }
  const violations = changedFiles.filter((file) => !writeScopes.some((scope) => file === scope || file.startsWith(scope)))
  return { ok: violations.length === 0, violations }
}

export interface ReviewRecord {
  id: string
  taskId: string
  reviewer: string
  /** 作者（任务卡 owner）；缺省时由调用方从任务卡解析 */
  author?: string | undefined
  verdict: 'pass' | 'changes-requested' | 'reject'
  findings: string[]
  at: string
}

/** 独立性校验（T-M4-06）：作者不得评审自己的产出。 */
export function independenceViolations(reviews: ReviewRecord[], tasks: TaskCard[]): { reviewId: string; detail: string }[] {
  const owners = new Map(tasks.map((task) => [task.id, task.owner]))
  const out: { reviewId: string; detail: string }[] = []
  for (const review of reviews) {
    const author = owners.get(review.taskId) ?? review.author
    if (review.reviewer === author) {
      out.push({ reviewId: review.id, detail: `${review.id} 的评审者与作者同为 ${review.reviewer}（${review.taskId}）` })
    }
  }
  return out
}
