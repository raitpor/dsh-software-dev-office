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
import { sdoAllowList, toolAllowList, toolDenyList } from '../domain/roles.js'
import type { TaskCard } from '../types.js'

/**
 * 取某角色的**声明工具面**：优先随包掩码表，读不到就退回内置兜底（绝不静默给全量工具）。
 *
 * 注意：它**不再**是下发给宿主的 allow 白名单（见 `domain/roles.ts` 的 {@link maskAllows} 注释）。
 * 现在用于指纹、自检与回执里说明"这个角色声明了哪些工具"。
 */
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
  /**
   * **D-15（sdo-test-new 2026-10-08，major）**：调用方**显式**指定了后端、并因此**覆盖**了
   * "同迭代二选一锁"时的留痕说明。它与 `degradedReason` 是两件事：降级 = 结果**不等于**请求，
   * 覆盖 = 结果**等于**请求（锁被让路）。两者都必须进回执，否则使用者无法知道自己要的后端有没有生效。
   */
  overrideNote?: string | undefined
  /** 相对首选是否发生了切换 */
  switched: boolean
}

/**
 * 选后端。`preference` 为 'auto' 时按 subagent > native-team > inline 选；
 * 指定了不可用的后端则**降级**并说明原因（不静默换）。
 *
 * `explicit` = 调用方**显式点名**了后端（不是 `auto`）。此时"同迭代二选一锁"**让路**：
 * 旧实现把显式请求也覆盖回 `previous.backend`，而降级文案却写着「如需切换请显式说明并留痕」——
 * 承诺的入口根本不存在（D-15 真机：显式 `backend=inline` 被静默换回 `subagent`）。
 */
export function pickBackend(
  preference: BackendKind | 'auto',
  probe: BackendProbe,
  previous?: { backend: BackendKind; iteration?: number | undefined } | undefined,
  iteration?: number | undefined,
  explicit = preference !== 'auto',
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
  // **显式点名时让路**（D-15）：约束是给"自动选择"用的纪律，不能反过来吞掉使用者的明确指令。
  if (
    reason === undefined &&
    previous !== undefined &&
    previous.backend !== chosen &&
    (previous.iteration === undefined || iteration === undefined || previous.iteration === iteration)
  ) {
    if (explicit) {
      return {
        backend: chosen,
        overrideNote: `显式指定了 ${chosen}，已覆盖本迭代的「${previous.backend}」二选一锁（留痕：这条覆盖原因写进 dispatch/decided）`,
        switched: true,
      }
    }
    return {
      backend: previous.backend,
      degradedReason: `本迭代已用 ${previous.backend}，按二选一约束继续用它（如需切换请显式指定 backend=…）`,
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
  /**
   * **下发给宿主的 deny 面**（唯一内容）：通用面的硬禁止（`roles.yml` 的 `deny`）
   * ∪ 「SDO 流程面里不属于本角色的工具」。
   *
   * 只发 deny、**不发 allow** —— 发了 allow 就等于把宿主/harness 的**整个通用面**也隐藏掉
   * （真机事故：子代理报「无法使用 `technique_apply`」，因为它手里只有角色声明的十几个名字）。
   */
  toolDeny: string[]
  /** 该角色在 **SDO 流程面**可用的工具（**不下发**，只进回执/台账，用来说明职责分离到哪一层） */
  sdoAllow: string[]
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
  /**
   * **本插件真实注册的 `sdo_*` 工具名**（由 `index.ts` 从注册表现取，绝不硬编码第二份）。
   *
   * 缺省空数组 = 调用方没给 ⇒ 只下发 `roles.yml` 的 deny（通用面），SDO 流程面不做补集 deny。
   * 生产路径必须传（见 index.ts），否则职责分离只靠钩子兜底。
   */
  sdoNames?: readonly string[] | undefined
}): DispatchRequest {
  const { task } = input
  const persona = PERSONA_BY_ROLE[task.role] ?? 'sdo-developer'
  const sdoNames = input.sdoNames ?? []
  const toolDeny = toolDenyList(task.role as never, sdoNames)
  const sdoAllow = sdoAllowList(task.role as never, sdoNames)
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
    // B4：先把角色卡技能加载进来（`sdo-role-cards` 是索引，正文在 `skills/role-<角色>.md`）。
    // 不用假设执行者会自己从技能目录里发现它 —— 派发提示是它唯一必然读到的上下文。
    `0) 先加载角色卡：用 \`skill\` 工具取 \`sdo-role-cards\`（索引里逐行给出「角色 → 卡片路径 → 掩码理由」），
    再读你角色的卡片全文（\`skills/role-${task.role}.md\`）后按卡片执行；`,
    `1) 先用 \`sdo_task action=claim id=${task.id} expectedRevision=${task.revision}\` 认领（CAS，冲突就重新读卡）；`,
    '2) 只改写范围内的文件；',
    `3) 完成后 \`sdo_task action=done id=${task.id} owner=${input.owner}\` 并附证据；`,
    '4) 做不下去就 `sdo_task action=block id=… note=…`，不要硬撑也不要静默改范围。',
    // **F-7（2026-10-05 真机）**：子代理报告曾把**上一次被中断会话留下的**文件算成本轮产出
    // （实测：报告列 5 个文件，mtime 全是前一天，而派发在第二天）。报告必须自证"本轮写了什么"。
    '5) 报告/证据里**必须**列出本轮**实际写入**的文件（路径 + mtime）——更早会话留下的文件不算本轮产出；没有改动就明说"本轮零产品改动"。',
    // **执行者禁令（2026-10-08 用户裁定）**：在提示面上就说清 —— 别让模型"试了才知道"（那会浪费一轮）
    '6) **不得派出子代理**：你没有 `subagent` / `subagent_fork` / `workflow` / `sdo_plan` —— 它们起的子代理**不带角色掩码**，等于绕开整张掩码表。派发是驾驶舱的活；做不完就 `block` 回报。',
    // **执行者禁用面（2026-10-08 全面审计）**：平台/用户/会话/共享库层面的能力都不给执行者
    '7) **平台/用户/会话层面的动作也不在你手里**：`plugin_manager`（装卸插件）、`exit_plan_mode`（要用户批准计划）、`memory_forget` / `technique_forget`（共享知识库的**不可逆删除**）、`failure_forgive`（给自己豁免纪律）、`create_goal` / `update_goal`（会**自动续轮**）—— 需要这类动作就 `block` 或在报告里说明，由驾驶舱转给用户。',
  ]
    .filter((line) => line !== '')
    .join('\n')
  return {
    task,
    backend: input.backend,
    owner: input.owner,
    persona,
    toolDeny,
    sdoAllow,
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
