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
import { scopePathWithin } from '../domain/scopePaths.js'
// **`C-52` 的名字回退口径**（`ADR-022` 裁决③ 连带 / 口径 A1）：按**角色前缀**比较 owner 名 ——
// 与认领期/收口期的 owner→角色口径**同一份实现**（`claimCoverage.ts`），不在这里另写一套。
import { ownerRolesEqual } from '../domain/claimCoverage.js'

/**
 * 取某角色的**声明工具面**（唯一真源：随包掩码表 `src/data/roles.yml`）。
 *
 * 注意：它**不再**是下发给宿主的 allow 白名单（见 `domain/roles.ts` 的 {@link maskAllows} 注释）。
 * 现在用于指纹、自检与回执里说明"这个角色声明了哪些工具"。
 *
 * **`TASK-189`（`DEF-181`）：删掉了内置兜底 `TOOL_FILTER_FALLBACK`。**
 * 它是"随包数据读不到时用的第二份工具面"，**零产品调用点**（只有本函数与 `test/m7` 的等价性断言），
 * 而它那条 `office` 早就与 `roles.yml` 分家了（兜底写着 `read/grep/glob/write`，真源已是 ADR-031 六组）
 * ⇒ 一旦真源读不到，它就会**静默**把流程官降级成"四个工具"。这正是"两份真相"的典型形态
 * （`DEF-044` 的教训）：**宁可给空面（立刻可诊断）也不给陈旧面（看起来正常）**。
 * 守卫：`test/m225.test.ts` 的 M225-R5 断言该常量已不存在、且 `roleToolFilter(role) === toolAllowList(role)`。
 */
export function roleToolFilter(role: string): string[] {
  try {
    return toolAllowList(role as never)
  } catch {
    // 真源读不到 ⇒ 空面（调用方据此可见"数据缺失"），绝不退回另一份可能过期的表
    return []
  }
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

/**
 * **全局并行预算的占位读数**（`TASK-231` 落点二）：一个位子最多被一张卡占一次。
 *
 * 三条口径，全部可机械核对：
 *   ① **占位 = 卡在 `in-progress` ∪ 真在飞**（`started` 之后未 `finished`、未超 TTL、未被 release）。
 *      前者是"有人在干活"（认领过），后者是"有子会话在跑"（哪怕它还没认领）—— 任一成立就占一个位子；
 *   ② **去重**：两边都有的卡只算一次（修前 `inProgress` 一个数就把"已认领但派发已结算"与
 *      "派发还活着但卡没认领"两种不同事实压成同一个数）；
 *   ③ **悬空的 `decided` 一个位子都不占**（`danglingDecisions` 只用于点名，不参与算术）——
 *      这正是"幽灵在飞卡虚占真实名额"的机械反证（`DEF-214` 的第 ⑷ 层危害）。
 */
export interface SeatReading {
  /** 真正占掉几个位子（去重后） */
  occupied: number
  budget: number
  /** 还能收几张（`budget − occupied`，不小于 0） */
  free: number
  /** 卡状态是 `in-progress` 的那批 */
  inProgress: string[]
  /** 真在飞的那批（唯一出口：`liveDispatchReading`） */
  liveDispatches: string[]
  /** 两边都出现过的卡（只占一个位子） */
  both: string[]
  /** 悬空的派发决定（**不占位**，只点名） */
  danglingDecisions: string[]
}

export function seatReading(input: {
  inProgress: readonly string[]
  liveDispatches: readonly string[]
  danglingDecisions?: readonly string[] | undefined
  budget: number
}): SeatReading {
  const inProgress = [...new Set(input.inProgress.filter((id) => id !== ''))].sort()
  const live = [...new Set(input.liveDispatches.filter((id) => id !== ''))].sort()
  const liveSet = new Set(live)
  const occupiedIds = new Set([...inProgress, ...live])
  return {
    occupied: occupiedIds.size,
    budget: input.budget,
    free: Math.max(0, input.budget - occupiedIds.size),
    inProgress,
    liveDispatches: live,
    both: inProgress.filter((id) => liveSet.has(id)),
    danglingDecisions: [...new Set(input.danglingDecisions ?? [])].filter((id) => id !== '').sort(),
  }
}

/**
 * 占位读数的一行投影（回执/诊断用）。**字段名用 ASCII**：与 `poolReadingLine` 同口径
 * （语言包键不在本卡写范围内，且这一行是给复验者的读数）。
 *
 * **为什么不逐张列 `in-progress`**（`TASK-231` 返工，按 `TASK-218` 的回执预算口径收窄）：
 * 那一批就是"卡状态计数"本身，读者拿 `inProgress=3` 就能与卡表对上；真正需要**点名**的是
 * 「**卡不是 `in-progress`、但子会话在跑**」那批（`live`）—— 它才是本卡新增的解释力，
 * 也是修前**完全不占位**的那个缺口。于是这一行**有界**：卡号只随真在飞的张数增长，
 * 而那张数本身受预算与孤儿 TTL 约束（不会随候选数或卡数线性膨胀）。
 */
export function seatLine(reading: SeatReading): string {
  const ids = (list: readonly string[]): string => (list.length === 0 ? '-' : list.join(' '))
  return `dispatch-seats: occupied=${String(reading.occupied)}/${String(reading.budget)} free=${String(reading.free)}`
    + ` inProgress=${String(reading.inProgress.length)} live=${ids(reading.liveDispatches)}`
    + ` both=${ids(reading.both)} dangling=${ids(reading.danglingDecisions)}`
}

/**
 * 这一份占位读数**是否值得单独占一行 `sdo_plan next` 回执**（`TASK-231` 返工）。
 *
 * 判据只有一条：**照着卡表算出来的数，与这份读数不一致**。两种不一致：
 *   · 有卡**不在 `in-progress`、但子会话在跑**（真在飞 ⊄ 卡状态计数）—— 这正是修前**完全不占位**
 *     的那个缺口，也是本卡新增的解释力；
 *   · 有**悬空决定**（决定了却没发生，读者从卡表上完全看不到它）。
 *
 * 两边一致时（例如"1 张在飞卡也就是那 1 张 `in-progress` 卡"）**一字不印**：那种行只是把读者
 * 已经知道的事再说一遍，却会白吃 `TASK-218` 建立的体积余量（实测：冻结夹具回执 7,192 → 7,295，
 * 而 `M232-06` 的余量只有 105 字符 —— 一格新读数就吃掉 98%）。
 *
 * `sdo_status` 不受这条约束（它不是被体积守卫盯着的那一面）：那里**每轮都印**。
 */
export function seatNeedsLine(reading: SeatReading): boolean {
  if (reading.danglingDecisions.length > 0) return true
  const claimed = new Set(reading.inProgress)
  return reading.liveDispatches.some((id) => !claimed.has(id))
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
  // **ADR-009 / DEF-057**：命中判定收敛到**唯一出口** `scopePathWithin`（同一路径，或**目录边界前缀**）。
  // 旧实现是单向 `file.startsWith(scope)`：改动 `src/a.tsx` 对卡范围 `src/a.ts` 会判「在范围内」
  // —— 文件名前缀**假放行**（比误拒危险：真越界被静默放过）。
  const violations = changedFiles.filter((file) => !writeScopes.some((scope) => scopePathWithin(file, scope)))
  return { ok: violations.length === 0, violations }
}

export interface ReviewRecord {
  id: string
  taskId: string
  reviewer: string
  /** 作者（任务卡 owner）；缺省时由调用方从任务卡解析 */
  author?: string | undefined
  /**
   * **记录这条评审的会话 uuid**（DEF-066 起的材料；DEF-042 起 C-52 用它判独立）。
   * 缺省 = 存量记录（那时只能按名字判 —— 如实降级，不假装判过）。
   */
  sessionId?: string | undefined
  verdict: 'pass' | 'changes-requested' | 'reject'
  findings: string[]
  at: string
}

/**
 * 独立性校验（T-M4-06 / **C-52**）：作者不得评审自己的产出。
 *
 * **DEF-042（第三批 §3.15）**：判据从"只比**名字**"改成"**按会话 uuid 判**"。
 * 病根：名字是**调用方自报**的字符串（`backend:role:序号`），改个名就能绕过独立性；
 * 而 `DEF-066` 早就在评审记录里留了**会话 uuid**（`review.sessionId`）却没接到这条判据上。
 *
 * 口径（材料齐时 **uuid 说了算**，名字不参与）：
 *   · 卡有认领会话（`claimed`，来自 `task/claimed` 事件）且评审记了 `sessionId` ⇒
 *     两者有交集 ⇒ **判红**（名字不同也照样判红）；无交集 ⇒ **不判**（同名不同会话 = 独立）；
 *   · 材料不全（存量记录没带 `sessionId`，或卡没有认领会话）⇒ 退回**名字口径**（旧行为，
 *     如实降级；不假装判过 uuid）。
 */
export interface IndependenceEntry {
  reviewId: string
  detail: string
}

/**
 * 独立性审计的**两个桶**（2026-10-21 用户裁定「收窄两条」）。
 *
 * 为什么必须分桶：`C-52` 原来把两件性质完全不同的事判成同一件 ——
 *   · **自评的放行**（`verdict=pass`，且这张卡没有别的独立面可依据）⇒ 真的自我放行，必须判红；
 *   · **自评的自我否定**（`changes-requested` / `reject`）⇒ 自己给自己挑毛病，不是放水；
 *   · **`pass` 自评但另有独立采纳评审** ⇒ 依据在别处，自评只是噪声。
 * 后两类进 `noted`（留痕、不判红）。历史不能改，若不收窄，`C-52` 就是一条**永远修不好的红**
 * —— 人迟早学会忽略它（本项目一直在挡的那种 Goodhart）。
 */
export interface IndependenceAudit {
  /** 真违规：`pass` 自评，且这张卡**没有**「不同会话 + `verdict=pass` + 已采纳」的评审可依据。 */
  violations: IndependenceEntry[]
  /** 留痕（不判红）：自我否定的自评；以及已被独立评审覆盖的 `pass` 自评。 */
  noted: IndependenceEntry[]
}

/**
 * 独立性审计（T-M4-06 / **C-52** 的唯一判据出口）：一趟扫描、两个桶。
 *
 * **DEF-042（第三批 §3.15）**：判据从"只比**名字**"改成"**按会话 uuid 判**"。
 * 病根：名字是**调用方自报**的字符串（`backend:role:序号`），改个名就能绕过独立性；
 * 而 `DEF-066` 早就在评审记录里留了**会话 uuid**（`review.sessionId`）却没接到这条判据上。
 *
 * 口径（材料齐时 **uuid 说了算**，名字不参与）：
 *   · 卡有认领会话（`claimed`，来自 `task/claimed` 事件）且评审记了 `sessionId` ⇒
 *     两者有交集 ⇒ 命中「自评」；无交集 ⇒ 不命中（同名不同会话 = 独立）；
 *   · 材料不全（存量记录没带 `sessionId`，或卡没有认领会话）⇒ 退回**名字口径**（旧行为，
 *     如实降级；不假装判过 uuid）。
 *
 * **收窄口径（2026-10-21）**：命中「自评」之后再看两件事 ——
 *   ① 非 `pass` 的评审 ⇒ `noted`（自我否定不是放水）；
 *   ② `pass` 的评审 ⇒ 若该卡存在一条**不同会话**、`verdict=pass`、且**已采纳**（id 在
 *      `adoptedReviewIds` 里）的评审 ⇒ `noted`（依据在别处）；否则 ⇒ `violations`。
 *
 * `adoptedReviewIds` 由调用方从 `reviewAdoptions(...)` 现算后传入（**不在这里另造一套采纳口径**：
 * 采纳态的唯一出口在 `reviewVerification.ts`）。
 */
export function independenceAudit(
  reviews: ReviewRecord[],
  tasks: TaskCard[],
  claimedSessions: ReadonlyMap<string, readonly string[]> = new Map(),
  adoptedReviewIds: ReadonlySet<string> = new Set(),
): IndependenceAudit {
  const owners = new Map(tasks.map((task) => [task.id, task.owner]))
  const violations: IndependenceEntry[] = []
  const noted: IndependenceEntry[] = []
  /** 这张卡有没有「不同会话 + pass + 已采纳」的评审可依据（`except` 排除自评那一自身）。 */
  const coveredByIndependent = (review: ReviewRecord): boolean => {
    const claimed = claimedSessions.get(review.taskId) ?? []
    return reviews.some((other) => {
      if (other.id === review.id || other.taskId !== review.taskId) return false
      if (other.verdict !== 'pass' || !adoptedReviewIds.has(other.id)) return false
      const session = (other.sessionId ?? '').trim()
      // 没有会话材料 ⇒ 证不出"不同会话" ⇒ 不算独立面（保守方向）
      if (session === '') return false
      return !claimed.includes(session)
    })
  }
  for (const review of reviews) {
    const claimed = claimedSessions.get(review.taskId) ?? []
    const reviewSession = (review.sessionId ?? '').trim()
    const selfBySession = reviewSession !== '' && claimed.length > 0
    if (selfBySession) {
      if (!claimed.includes(reviewSession)) continue
    } else {
      const author = owners.get(review.taskId) ?? review.author
      /**
       * **`C-52` 的名字回退口径（`ADR-022` 裁决③ 连带 / 口径 A1 / `TASK-172`）**：
       * 按**角色前缀**比较 —— `developer-20af1d60` 与 `developer-yyyy` 是同一角色 ⇒ 判自评。
       *
       * 修前是逐字比较 `review.reviewer === author`。owner 改成「角色-8位uuid」之后，同一个人
       * 换个会话就是另一个名字 ⇒ 历史/存量评审会被判成"独立"（**该红的反而不红**，方向是危险的那一边）。
       * 反过来"同角色不同会话"在这条**材料不全**的回退路上也判自评 —— 保守方向是对的
       * （材料齐时先走上面的 uuid 分支，名字根本不参与）。
       */
      if (!ownerRolesEqual(review.reviewer, author ?? '')) continue
    }
    const who = selfBySession
      ? `${review.id} 的评审者与实现者是**同一个会话**（${reviewSession}；显示名 ${review.reviewer}，卡 ${review.taskId}）`
      : `${review.id} 的评审者与作者同为 ${review.reviewer}（${review.taskId}）`
    if (review.verdict !== 'pass') {
      noted.push({ reviewId: review.id, detail: `${who} —— 自我否定（${review.verdict}），不构成放水，留痕不判红` })
      continue
    }
    if (coveredByIndependent(review)) {
      noted.push({ reviewId: review.id, detail: `${who} —— 已被该卡的独立采纳评审覆盖，留痕不判红` })
      continue
    }
    violations.push({ reviewId: review.id, detail: `${who} —— 独立性按会话判，换名字也不算独立` })
  }
  return { violations, noted }
}

/**
 * 兼容投影：只要**违规**那一桶（既有调用方与守卫按数组用）。
 * 新代码请用 {@link independenceAudit}（两桶一次取，别在两处各判一遍 —— `DEF-044` 的教训）。
 */
export function independenceViolations(
  reviews: ReviewRecord[],
  tasks: TaskCard[],
  claimedSessions: ReadonlyMap<string, readonly string[]> = new Map(),
  adoptedReviewIds: ReadonlySet<string> = new Set(),
): IndependenceEntry[] {
  return independenceAudit(reviews, tasks, claimedSessions, adoptedReviewIds).violations
}
