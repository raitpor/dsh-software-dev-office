/**
 * **角色池与卡队列**（子代理复用，2026-10-04）。
 *
 * 用户的运维口径（原话）：
 * > 每个角色有子 agent 池（限制并行上限）；卡片类类似于消息队列 —— 一轮将卡片分发给角色池中的
 * > 子 agent，若所有子 agent 在工作则阻塞队列，直到有子 agent 完成任务后再将卡片发给空闲子 agent。
 *
 * 本模块只做**账**：给定随包配置的角色上限与 journal 事件流，算出每个角色池里谁在飞、谁空闲、
 * 还能收几张卡，以及本轮该派哪几张、其余为什么排队。它**不碰宿主**（起子代理 / 投递消息都在
 * `integration/dispatch.ts`），因此可以纯函数测到边界。
 *
 * 三条纪律：
 *   ① **不新增真源**：池的状态全部从 `dispatch/started` / `dispatch/finished` 现算 ——
 *      插件重启、上下文压缩都不影响"谁在飞"（这是 append-only 台账的既有回报）；
 *   ② **一次认领一个孩子**：同一个 `childSessionId` 在"已开始、未结算"期间算 **busy**，
 *      绝不出现在可复用清单里（重复投递会让两张卡在同一个子代理里打架）；
 *   ③ **只有 continuable 能复用**：one-shot 子代理结算后就没了（宿主写死的默认模式），
 *      把它们算进"空闲可复用"就是把"池"说成不存在的能力 —— 这里单列 `retired` 如实记账。
 */
import { fmt } from './i18n.js'
import type { TaskCard } from '../types.js'

/** 一轮派发（`dispatch/started` + 其结算）。 */
export interface PoolChild {
  childSessionId: string
  /**
   * **派发它的父会话**（DEF-066）：宿主只允许父会话复用**自己**的子会话（跨父会话会报
   * `belongs to another parent session`）。老事件没有这个字段 ⇒ 空串（**未知**，如实标注，
   * 绝不当成"本会话可复用"）。
   */
  parentSessionId?: string | undefined
  /** 折叠过程中的**内部**字段：该子会话接过哪些卡（对外用 `cards` 数） */
  cardIds?: string[] | undefined
  role: string
  /** 当前/最后一次承接的卡 */
  task: string
  /** 宿主给的模式；**老事件没有这个字段 ⇒ 按 one-shot 读**（保守：one-shot 不可复用） */
  mode: 'continuable' | 'one-shot'
  state: 'busy' | 'idle'
  /** 同一个子代理承接过的轮数（复用后 > 1；回执用它说明"这是第几轮"） */
  rounds: number
  /**
   * 同一个子代理承接过的**不同卡数**（DEF-069）：真机实测同一会话接了 20 张卡、34 轮，
   * 末两次派发一次零改动、一次只落 1/5 落点 —— 余量判定必须看得到这个数。
   * 老事件折叠不出来 ⇒ `undefined`（**未知**，不据此拒绝复用）。
   */
  cards?: number | undefined
  startedAt: string
  finishedAt: string
  /**
   * **这一轮子代理的工具面指纹**（SDO-52）：真机上同一个子会话被复用约 137 张卡，
   * 中途给角色补的 `read_image` **始终拿不到** —— 工具面是**创建会话时**定下的，复用不会刷新。
   * 老事件没有这个字段 ⇒ 空串（**未知指纹 ⇒ 不允许复用**，保守但正确）。
   */
  maskHash?: string | undefined
}

/** 一个角色池的现状。 */
export interface RolePool {
  role: string
  /** 该角色的并行上限（配置没写就用全局上限） */
  cap: number
  /** 在飞（已派发未结算）—— 池里"占着位子"的 */
  busy: PoolChild[]
  /** 空闲且**可复用**（continuable + 已结算） */
  idle: PoolChild[]
  /**
   * `idle` 里**属于本会话**（父会话 = 观察者）的那部分 —— 只有这些是派发器**真的能**投卡的（DEF-066）。
   *
   * 真机矛盾：`sdo_status` 报「空闲可复用 31」而派发器永远新起（`provider=spawn`）——
   * 因为那 31 个是**上一任驾驶舱**派的（另一个父会话），宿主一律拒。
   */
  idleSameParent: PoolChild[]
  /** `idle` 里**跨父会话**的那部分（宿主会拒）—— **如实标注**，不再计入"看起来能复用"的数 */
  idleForeign: PoolChild[]
  /** `idle` 里**父会话未知**的（老事件）—— 同样不当作本会话可复用 */
  idleUnknownParent: number
  /**
   * **超时未结算**（`started` 之后一直没有 `finished`，且已超过孤儿 TTL）。
   *
   * 不计入 `busy`、不占池位（真机缺陷：僵尸派发把池永久占满）。**也绝不进 `idle`** ——
   * 我们不能确定它还在不在，把它当"空闲可复用"会把卡投进一个不存在的子代理。
   */
  stale: PoolChild[]
  /** 已结算但 one-shot（不可复用；重启后宿主那边也不在了） */
  retired: number
  /**
   * **不能复用、但也不该继续占池位**的空闲子代理（**R-1**，sdo-test-new 2026-10-08 复测发现）。
   *
   * 三种来源：掩码指纹不符/未知（SDO-52）、该会话被观测到**手里 0 个工具**（修复前的构建创建的
   * 零工具子会话）、**没有任何工具面观测**（无法确认它手里有工具）。
   *
   * 为什么必须从 `idle` 里摘出去：复用的前提是"这个会话真的能用"，而池上限是按**子代理个数**算的
   * （`freeSlots = cap − 在飞 − 可复用空闲`）。一个永远不会被复用的空闲会话若继续占位，`cap=1` 的角色
   * 就会**永久排队**：既不复用它、也没位子新建 ⇒ 卡永远派不出去（比"少复用"严重得多）。
   */
  unusable: { childSessionId: string; reason: string }[]
  /**
   * 还能**新建几个子代理**（= 上限 − 在飞 − **可复用**空闲）。
   *
   * 注意口径：池上限管的是**子代理个数**，不是"并发卡数"。所以池里已经躺着 1 个空闲可复用时，
   * 可新建位子是 0，但**仍能接卡**（投给那个空闲者）—— 这两件事必须分开算，否则会在池满时
   * 还在新建子代理（把池撑爆，复用也就没意义了）。
   */
  freeSlots: number
}

/** journal 事件的最小形状（只读池相关的两种；别的类型忽略）。 */
export interface PoolEvent {
  type: string
  data: Record<string, unknown>
  at?: string | undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/**
 * 从事件流折叠出**每个子代理**的状态。
 *
 * 同一 `childSessionId` 可以出现多轮（复用）：每轮 `started` 把它置回 busy，
 * 对应 `finished` 再置回 idle（`rounds` +1）。结算找不到对应 started 的（手写/丢事件）
 * 不凭空造一个孩子 —— 宁可少记，也不编。
 */
export function foldPoolChildren(events: readonly PoolEvent[]): Map<string, PoolChild> {
  const children = new Map<string, PoolChild>()
  for (const event of events) {
    const id = text(event.data['childSessionId'])
    if (id === '') continue
    if (event.type === 'dispatch/started') {
      const previous = children.get(id)
      const mergedCardIds = [...new Set([...(previous?.cardIds ?? []), text(event.data['task'])])].filter((item) => item !== '')
      children.set(id, {
        childSessionId: id,
        role: text(event.data['role']),
        task: text(event.data['task']),
        // 老事件没有 `mode` ⇒ one-shot（不可复用）。反过来猜"可复用"会在真机上把卡投进一个已经不存在的子代理。
        parentSessionId: text(event.data['parentSessionId']),
        mode: text(event.data['mode']) === 'continuable' ? 'continuable' : 'one-shot',
        state: 'busy',
        rounds: (previous?.rounds ?? 0) + 1,
        // **DEF-069**：`cards` = 该子会话承接过的**不同卡数**（必须**累积**，不能只存当轮 —— 真机
        // 同一会话接了 20 张卡，只看轮数会以为"还有余量"）。
        cards: mergedCardIds.length,
        startedAt: event.at ?? text(event.data['startedAt']),
        finishedAt: '',
        maskHash: text(event.data['maskHash']),
        cardIds: mergedCardIds,
      })
      continue
    }
    if (event.type !== 'dispatch/finished') continue
    const child = children.get(id)
    if (child === undefined) continue
    // 结算只认"当前这一轮"：已经 idle 的孩子再收一条 finished 不重复计数（幂等）
    children.set(id, { ...child, state: 'idle', finishedAt: event.at ?? text(event.data['finishedAt']) })
  }
  return children
}

/** 角色 → 并行上限（配置里没写的角色用 `defaultCap`）。 */
export function capOf(caps: Record<string, number>, role: string, defaultCap: number): number {
  const declared = caps[role]
  return typeof declared === 'number' && Number.isFinite(declared) && declared >= 1 ? Math.floor(declared) : defaultCap
}

/**
 * **该空闲子代理为什么不能复用** —— 判据**只有这一处**（R-6，sdo-test-new 2026-10-08 复测）。
 *
 * 真机缺陷：`rolePools`（池视图，状态行/排队行都渲染它）只吃"工具面观测"这一层判据，
 * 而掩码指纹比对写在 `admitDispatch` 内部 ⇒ **同一个空闲会话**在池视图里是"空闲可复用"、
 * 在准入里却被拒 ⇒ 回执印出「池满（在飞 2/4，空闲可复用 3）」这种自相矛盾的话，
 * 而 `freeSlots = cap − 在飞 − 可复用空闲` 被"不能用的人"占掉 ⇒ developer 的有效并发从 4 掉到 2，
 * 两张卡被无谓排队（实测：seq≤583 时 busy=2 / idle=3 / freeSlots=0，两张卡全 `pool-full`）。
 *
 * **最坏情况**（同机制外推）：4 个槽全是"掩码过期但被观测过"的空闲会话 ⇒ 该角色永久无法派发。
 *
 * @param wantedMaskHash 该角色**当前**的掩码指纹；空串 = 取不到指纹 ⇒ 保守视为不可复用（与旧口径一致）
 * @param extra 额外判据（office 层接的是工具面观测：零工具 / 没观测到都不给复用）
 */
export function reuseBlockedReason(
  child: PoolChild,
  wantedMaskHash: string,
  extra?: ((child: PoolChild) => string | undefined) | undefined,
  /**
   * **复用余量**（DEF-069）：`maxRounds` 由**项目声明**（插件不写死数字）。
   * 0 / 未给 = 未声明 ⇒ 不判（行为与加它之前一致）。
   */
  budget?: { maxRounds?: number | undefined; maxCards?: number | undefined } | undefined,
): string | undefined {
  const observed = extra?.(child)
  if (observed !== undefined) return observed
  const maxRounds = budget?.maxRounds ?? 0
  if (maxRounds > 0 && child.rounds >= maxRounds) {
    return fmt('uiPool.kReuseRoundsExceeded', { p1: String(child.rounds), p2: String(maxRounds) })
  }
  const maxCards = budget?.maxCards ?? 0
  if (maxCards > 0 && child.cards !== undefined && child.cards >= maxCards) {
    return fmt('uiPool.kReuseCardsExceeded', { p1: String(child.cards), p2: String(maxCards) })
  }
  const actual = child.maskHash ?? ''
  if (wantedMaskHash === '' || actual !== wantedMaskHash) {
    return actual === ''
      ? '旧子代理没有掩码指纹（无法确认其工具面）'
      : '掩码已变更（该会话的工具面是创建时的旧面）'
  }
  return undefined
}

/**
 * 折叠出每个角色池的现状（**含没有孩子的角色**：只列 `roles` 里出现的角色，
 * 目的是让"这个角色今天没有池"和"池空了"在回执里长得不一样）。
 */
export function rolePools(input: {
  children: Iterable<PoolChild>
  /** 参与展示的角色（通常来自待派卡片的角色集合） */
  roles: readonly string[]
  caps: Record<string, number>
  defaultCap: number
  /** 未结算派发的孤儿 TTL（毫秒）。缺省/<=0 ⇒ 不做孤儿判定（全部算在飞） */
  orphanTtlMs?: number | undefined
  /** 判定"现在"的时间（测试注入；缺省 `Date.now()`） */
  nowMs?: number | undefined
  /**
   * **该空闲子代理为什么不能复用**（R-1）：返回原因即"不可复用"。
   *
   * office 层用它接上"工具面观测"（`child-tools.jsonl`）：零工具 / 没观测到 ⇒ 不给复用。
   * 不传 = 不做这一层判定（既有行为，掩码指纹那层仍在 `admitDispatch` 里）。
   */
  reuseBlockedOf?: ((child: PoolChild) => string | undefined) | undefined
  /**
   * **取该角色当前的掩码指纹**（R-6）：与 `admitDispatch` 用**同一个** `reuseBlockedReason` 判。
   * 缺省/返回空串 ⇒ 保守视为"指纹取不到" ⇒ 不可复用（方向与准入路径一致）。
   */
  maskHashOf?: ((role: string) => string) | undefined
  /**
   * **观察者会话**（DEF-066）：用它把"空闲可复用"分成**本会话**（真能投）与**跨父会话**（宿主会拒）。
   * 不传 ⇒ 分栏为空、`idleSameParent` 视为全部（行为与加这个字段之前一致）。
   */
  viewerSessionId?: string | undefined
  /** **项目声明的复用余量**（DEF-069）：池视图必须用与准入**同一个**判据，否则读数与行为又会分叉 */
  reuseBudget?: { maxRounds?: number | undefined; maxCards?: number | undefined } | undefined
}): RolePool[] {
  const ttl = input.orphanTtlMs ?? 0
  const now = input.nowMs ?? Date.now()
  const byRole = new Map<string, PoolChild[]>()
  for (const child of input.children) {
    if (child.role === '') continue
    const list = byRole.get(child.role) ?? []
    list.push(child)
    byRole.set(child.role, list)
  }
  const wanted = [...new Set([...input.roles, ...byRole.keys()])].filter((role) => role !== '').sort()
  return wanted.map((role) => {
    const children = byRole.get(role) ?? []
    const cap = capOf(input.caps, role, input.defaultCap)
    const inFlight = children.filter((child) => child.state === 'busy')
    const stale = inFlight.filter((child) => isStaleDispatch(child, now, ttl))
    const busy = inFlight.filter((child) => !stale.includes(child))
    const continuable = children.filter((child) => child.state === 'idle' && child.mode === 'continuable')
    // **R-1**：不可复用的空闲子代理**不占池位**（否则 cap=1 的角色会永久排队），单独列出来如实报
    // **R-6**：判据与 `admitDispatch` 共用 `reuseBlockedReason` —— 掩码指纹也在这里判，
    // 否则"池视图说空闲可复用、准入却拒绝"会让 `freeSlots` 被不能用的人占掉（真机并发 4→2）。
    const wanted = input.maskHashOf?.(role) ?? ''
    const unusable = continuable
      .map((child) => ({
        childSessionId: child.childSessionId,
        reason: reuseBlockedReason(child, wanted, input.reuseBlockedOf, input.reuseBudget) ?? '',
      }))
      .filter((item) => item.reason !== '')
    const unusableIds = new Set(unusable.map((item) => item.childSessionId))
    const idle = continuable.filter((child) => !unusableIds.has(child.childSessionId))
    const retired = children.filter((child) => child.state === 'idle' && child.mode !== 'continuable').length
    // **DEF-066**：按"宿主会不会拒"如实分栏。不传观察者 ⇒ 全部算本会话（与既有行为一致）。
    const viewer = input.viewerSessionId ?? ''
    const idleSameParent = viewer === '' ? idle : idle.filter((child) => child.parentSessionId === viewer)
    const idleForeign = viewer === ''
      ? []
      : idle.filter((child) => {
          const parent = child.parentSessionId ?? ''
          return parent !== '' && parent !== viewer
        })
    const idleUnknownParent = viewer === '' ? 0 : idle.filter((child) => (child.parentSessionId ?? '') === '').length
    return {
      role,
      cap,
      busy,
      idle,
      idleSameParent,
      idleForeign,
      idleUnknownParent,
      stale,
      retired,
      unusable,
      freeSlots: Math.max(0, cap - busy.length - idle.length),
    }
  })
}

/**
 * 该"在飞"派发是否已算**孤儿**（超时未结算）。
 *
 * 两个保守约定：
 *   · `startedAt` 读不出时间（手写事件）⇒ **不算孤儿**（宁可占位，也不重复派发一个可能还活着的子代理）；
 *   · TTL 缺省（<=0）⇒ 不做判定（行为与加这个特性之前一致）。
 */
export function isStaleDispatch(child: PoolChild, nowMs: number, ttlMs: number): boolean {
  if (ttlMs <= 0 || child.state !== 'busy') return false
  const started = Date.parse(child.startedAt)
  return Number.isFinite(started) && nowMs - started > ttlMs
}

/**
 * 「挂起后**原样重派**」判定：该卡最近一次"实质事件"是 `task/blocked` ⇒ 之后只被 release/reassign，
 * 卡内容一个字没改就又被派出去 —— 等于让它再撞一次同一堵墙（真机教训，见设计文档）。
 *
 * 只认**能被机械核对**的：`task/blocked` 之后若出现过 `task/updated`（卡内容改过）或 `task/done`，
 * 就不再提醒（前者说明缺口可能已被处理，后者说明卡已经做完过）。
 */
export function unresolvedBlock(events: readonly PoolEvent[], taskId: string): { reason: string; seq: number } | undefined {
  let blocked: { reason: string; seq: number } | undefined
  for (const event of events) {
    const id = text(event.data['id'])
    if (id !== taskId) continue
    if (event.type === 'task/blocked') blocked = { reason: text(event.data['reason']), seq: Number(event.data['seq'] ?? 0) }
    else if (event.type === 'task/updated' || event.type === 'task/done') blocked = undefined
  }
  return blocked
}

/** 本轮派发计划：谁上、谁排队（含排队原因）。 */
export interface PoolAdmission {
  /**
   * **这一轮到底试没试复用**（`DEF-139` 定案用）。
   *
   * 为什么必须把它回显出来：`reuseSkipped` 只在"试过复用"时才有意义 ——
   * 调用方传了 `reuseIdle=false`（宿主没有续聊入口）或 `forceNew=true`（本轮就换人）时，
   * 清单为空是**正确**的，不是"判据全过却不复用"那个毛病。两种情况在旧台账上**长得一模一样**，
   * 驾驶舱因此只能靠掩码哈希反推（并反推错过两次）。回显它，回执与事件就能直接分流。
   */
  reuseIdle: boolean
  /** 本轮是否**强制新起**（`sdo_plan freshChild=true`）—— 同上，是"没打算复用"而不是"复用被拒" */
  forceNew: boolean
  /** 本轮可派的卡；`reuseChildId` 给了就是「投给这个**已有**子代理」（真复用），没给就是新起一个 */
  dispatch: { task: TaskCard; reuseChildId?: string | undefined }[]
  /** **被闸门拒的空闲子代理**（掩码/观测/持卡/余量四类，判据只有 `rolePools` 那一处）：回执与事件靠它答"为什么没复用" */
  reuseSkipped: { childSessionId: string; role: string; reason: string }[]
  /* ———————————————————— 定案面（`DEF-139` 落点一/二） ———————————————————— */
  /**
   * **本轮各角色的现场读数**（`TASK-163` 落点一）：由 `office.poolPlan` 用**准入前**的池快照填
   * （`rolePoolReadings`）。为什么用准入前那一份：读数要回答的是"**做决定时**池里长什么样"
   * —— 准入过程会把复用的孩子从 `idle` 挪进 `busy`、把 `freeSlots` 减掉，那是**决定的结果**，
   * 拿结果当原因就永远答不了「为什么没复用」（真机反推错过两次的病根）。
   *
   * 派发路径把它按卡的角色取一条并进 `dispatch/started`（{@link PoolReading} 五件 + 八桶）。
   */
  readings?: PoolReading[] | undefined
  /** 排队但**没被任何预算挡住**的（等下一轮空位） */
  queued: TaskCard[]
  /** 被挡下的卡及原因（池满 / 全局预算满） */
  blocked: { task: TaskCard; reason: 'pool-full' | 'global-budget'; detail: string }[]
  pools: RolePool[]
  /**
   * **R-9**：这些 ready 卡被**未结算的派发**冻着（子会话还活着或未超时）—— 回执里"没有可派发的卡"
   * 必须说清是它们（真机：卡已 `release` 回 ready，回执却说"都已认领/完成"）。
   * `minutes` = 那笔派发已经过去多久（操作者据此判断该等结算还是该覆盖 TTL）。
   */
  heldByDispatch?: { taskId: string; childSessionId: string; minutes: number }[] | undefined
  /**
   * **DEF-067**：这些计划卡的写范围与**在飞卡**相交 ⇒ 本轮**不派**（派了也认领失败）。
   * 回执必须**单列一行**点名（卡 id、挡路的卡与其 owner、**重叠的那个路径**），
   * 否则会复现 DEF-058 的误判：首屏看不到就以为"没派"。
   */
  heldByScope?: {
    taskId: string
    holderId: string
    holderOwner: string
    overlap: string[]
    /**
     * **凭什么处置**（`REQ-066` / `AC-303`）：`merge` = **照派**、只点名（两边靠合并流程处理）；
     * `exclusive-window` / `unknown-scope` = **串行**（本轮不派）。
     *
     * 为什么必须有这个字段：`heldByScope` 修前只有"挡住了"一种含义，回执也就只有一句"暂不可派"。
     * 相交从"硬阻断"降为"可见不阻断"之后，**同一条读数承载两种处置** —— 不带这个字段，
     * 界面层就只能靠"卡是否在 dispatch 里"反推，两处口径一旦分叉，回执会把照派的卡写成"暂不可派"。
     */
    kind: string
  }[] | undefined
  /**
   * **R-14**：这些卡的**要求**与该角色的**掩码能力**矛盾（`evidenceRequired` 要命令却没有 `bash`、
   * 有写范围却没有 `write/edit`）—— 派发前就要说出来，别等子会话动手失败（真机赔了一整轮）。
   */
  infeasible?: { taskId: string; role: string; gaps: string[] }[] | undefined
  /**
   * **DEF-080（第七批 §3.1 F1/F2）**：这些计划卡的写范围压在**未提交的被跟踪改动**上 ⇒ 本轮**不派**
   *（与 `heldByScope` 同一形状、同一回执面）。点名的 `over` 是**那些未提交的路径**，读者照做即可。
   */
  dirtyByScope?: { taskId: string; over: string[] }[] | undefined
  /**
   * **F5（第八批 §3.1）**：写范围是**超宽 glob**（`**` / `src/**` / `src/*` …）的卡 —— 那些脏文件
   * **只提示不拦**（拦住它们会让任何脏文件都把卡钉死）。要点名的仍是**相交的脏路径**。
   */
  dirtyHints?: { taskId: string; over: string[] }[] | undefined
  /**
   * **DEF-080 F4**：工作树**读不动**（不是仓库/没有 git）⇒ 这一态**单列**出来，
   * 与"干净"（键不出现）可区分，带 `reason` 供人判读。
   */
  dirtyUnjudgeable?: { reason: string } | undefined
}

/**
 * **复用候选的挑选顺序**（`TASK-196` / `DEF-139`）：**同父会话优先**，其余保持台账折叠顺序。
 *
 * 判据取自 `rolePools` 已经算好的那一栏（{@link PoolBuckets.idleSameParent}：「`idle` 里父会话 =
 * 观察者的（**派发器真的能投**）」）—— 决策与读数**同源**，不另立一套判定。
 *
 * 不传观察者（`rolePools` 的 `viewerSessionId` 为空）时 `idleSameParent` 就是整个 `idle`，
 * 本函数退化为恒等 ⇒ 老调用方的顺序与行为一字不变。
 *
 * 返回的是**新数组**：调用方按 `childSessionId` 从 `pool.idle` 里摘，不改本数组。
 */
export function reuseCandidateOrder(pool: RolePool): PoolChild[] {
  const deliverable = new Set(pool.idleSameParent.map((child) => child.childSessionId))
  return [
    ...pool.idle.filter((child) => deliverable.has(child.childSessionId)),
    ...pool.idle.filter((child) => !deliverable.has(child.childSessionId)),
  ]
}

/**
 * 派发准入：**先全局预算、再逐角色池**（两者都是上限，取更严的那个）。
 *
 * @param ready 待派卡（已有顺序，通常来自 `readyTasks`）
 * @param pools 角色池现状（`rolePools` 的结果）
 * @param globalRoom 全局还能并行几张（沿用既有 `maxParallelDispatch − 进行中` 口径）
 * @param reuseIdle 是否把"空闲可复用子代理"当作**直接可派**的位子（宿主没有 continuable 时由调用方传 false）
 */
export function admitDispatch(input: {
  ready: readonly TaskCard[]
  pools: RolePool[]
  globalRoom: number
  reuseIdle: boolean
  /** 取某角色掩码指纹（SDO-52）：只有指纹**一致**的空闲子代理才允许复用 */
  maskHashOf?: ((role: string) => string) | undefined
  /**
   * **当前"进行中"（in-progress）的卡数**（R-5 症状 D）：只用于把全局预算的拒收回执说真话。
   * 旧实现把文案里的数字**硬编码成 0**（`进行中 ${0} 张`），真机 4 张在飞时也印 0。
   */
  inProgress?: number | undefined
  /**
   * **本轮强制新起**（`sdo_plan freshChild=true`，R-13，sdo-test-new 2026-10-08）。
   *
   * 语义冲突：池容量口径是 `freeSlots = cap − busy − idle(可复用)`，而 `freshChild` 又禁止复用它们
   * ⇒ 池里躺满 `cap` 个可复用空闲时，「想新建会超 cap、想复用被自己禁止」⇒ **自锁**（真机
   * `在飞 0/4` 却 `池满`，TASK-041 从 22:00 起派不出去）。
   * 修法：本轮既然**不许用**它们，它们就不该占容量 ⇒ 容量按 `cap − busy` 算（只对新建计数）。
   */
  forceNew?: boolean | undefined
  /**
   * **该空闲子代理为什么不能复用**（R-1，与 `rolePools` 同一函数）：返回原因即拒绝复用。
   * office 层接的是"工具面观测"——**观测到零工具 / 没观测到**都不给复用（新起一个永远是对的）。
   */
  reuseBlockedOf?: ((child: PoolChild) => string | undefined) | undefined
  /**
   * **项目声明的复用余量**（DEF-069）：与 `rolePools` 走**同一个** `reuseBlockedReason`
   *（真机教训：读数与准入各自实现一次判定必然分叉）。0/未给 = 未声明 ⇒ 不判。
   */
  reuseBudget?: { maxRounds?: number | undefined; maxCards?: number | undefined } | undefined
}): PoolAdmission {
  const pools = input.pools.map((pool) => ({ ...pool, busy: [...pool.busy], idle: [...pool.idle] }))
  const byRole = new Map(pools.map((pool) => [pool.role, pool]))
  const dispatch: PoolAdmission['dispatch'] = []
  const reuseSkipped: PoolAdmission['reuseSkipped'] = []
  /** 每个角色**本次准入新建**了几张（R-5A：`在飞` 只报真实在飞，新建数另说，不再塞占位孩子） */
  const admittedByRole = new Map<string, number>()
  const queued: TaskCard[] = []
  const blocked: PoolAdmission['blocked'] = []
  let room = Math.max(0, Math.floor(input.globalRoom))
  for (const task of input.ready) {
    if (room <= 0) {
      queued.push(task)
      blocked.push({
        task,
        reason: 'global-budget',
        detail: `全局并行预算已满（进行中 ${input.inProgress ?? 0} 张之外无空位）`,
      })
      continue
    }
    const pool = byRole.get(task.role)
    if (pool === undefined) {
      // 该角色今天还没有池 —— 建一个空池再判（不能因为"没出现过"就当成不限量）
      const created: RolePool = {
        role: task.role,
        cap: 0,
        busy: [],
        idle: [],
        idleSameParent: [],
        idleForeign: [],
        idleUnknownParent: 0,
        stale: [],
        retired: 0,
        unusable: [],
        freeSlots: 0,
      }
      byRole.set(task.role, created)
      queued.push(task)
      blocked.push({ task, reason: 'pool-full', detail: `角色 ${task.role} 的池没有可用位子` })
      continue
    }
    // 位子 = 空闲的**可复用**子代理（复用同一个人）或池里还空着的并发槽
    // **SDO-52**：复用的前提是**工具面指纹一致** —— 掩码改过（补 `read_image`、收窄工具）之后，
    // 旧会话拿到的还是旧工具面；把卡投进去 = 又一次"公告与实际不符"。
    // **R-1（sdo-test-new 2026-10-08 复测）**：指纹一致**还不够** —— 掩码没变不等于这个会话手里有工具。
    // 真机：修复前构建创建的 `f4ae86fa`（`toolFilter.allow: []`）被复用两次，两次都是"无工具 → 把调用
    // 写成正文 → 1 轮结束"（`dispatch/started.tools: 11` 但紧接着 `dispatch/observe-failed`）。
    // 所以再加一条**证据型**判据：该子会话被**观测到**手里有工具才允许复用（观测不到 ⇒ 也不复用）。
    const wanted = input.maskHashOf?.(task.role) ?? ''
    // **R-6**：与 `rolePools` 共用同一个判据函数（口径只有一处，回执不可能自相矛盾）
    const blockedReasonOf = (child: PoolChild): string | undefined =>
      reuseBlockedReason(child, wanted, input.reuseBlockedOf, input.reuseBudget)
    /**
     * **`DEF-139` 落点二（`TASK-163`）：`reuseSkipped` 从这一版起**真的会有内容**。**
     *
     * 修前的形状（旧代码：在 `pool.idle` 上再判一遍 `blockedReasonOf`）是**结构性空转**：
     *   · `rolePools` 用的是**同一个** `reuseBlockedReason`（`R-6` 的修法），过不了闸门的空闲孩子
     *     **早就被它从 `idle` 摘到 `unusable`** 了 ⇒ `pool.idle` 里剩下的全是**能复用**的
     *     ⇒「`pool.idle.length > 0` 且 `findIndex(...) === -1`」**永远不可能同时成立**；
     *   · 于是 `reuseSkipped` 恒为空 —— 不是"没落事件"，而是**这条读数在本进程里根本不存在**
     *     （现盘证据：`reuseSkipped=[]` 与 `unusable=N` 并存 ⇒ 回执永远说不出"为什么没复用"）。
     *
     * 现在：原因**只算一次**（`rolePools` 的 `unusable`，判据唯一，这里只做**投影 + 补上角色**），
     * 条件与上面那次"复用之试"**同一口径**：`reuseIdle=false`（宿主没有续聊入口）或 `forceNew=true`
     *（本轮就打算换人）都不算"这些孩子不合格"，不许把它们记成"被闸门拒"。
     */
    if (input.reuseIdle && input.forceNew !== true) {
      // ① **唯一口径**的那一份：`rolePools` 已经判过（真实路径里这不是"重复判一次"，而是唯一来源）。
      for (const row of pool.unusable) {
        reuseSkipped.push({ childSessionId: row.childSessionId, role: pool.role, reason: row.reason })
      }
      // ② **调用方给的 pools 比准入判得松**的那一格（例如池视图只判掩码、观测判据只有准入这一层知道）：
      // 这一层由准入自己再判一次并如实记账 —— 否则"池里看着可复用、实际被拒"这件事在回执上会消失
      //（`M77-03` 守的就是它）。两条都进同一个清单，末尾按 `childSessionId` 去重（`R-5B`）。
      for (const child of pool.idle) {
        const reason = blockedReasonOf(child) ?? ''
        if (reason === '') continue
        reuseSkipped.push({ childSessionId: child.childSessionId, role: pool.role, reason })
      }
      /**
       * ③ **跨父会话**（`DEF-066` 的分栏 ÷ `DEF-185` 的落点二）：宿主的 `sendMessage` 只对**自己起的直接
       * 子代理**生效，`idleForeign` 里的会话投进去必被拒 —— 它过得了闸门，却到不了终点。
       *
       * 为什么必须在**这条**记账面里点名：修前它们被算作"空闲可复用"（占着 `freeSlots`），
       * 回执于是印出「池里有空闲可复用却新起」，而台账里**一个字都不解释**（`DEF-185` 的真机形状：
       * `idleForeign=0` 那一档看不出来，但同样"读数是可复用、决策是不复用"的坑在跨父会话上照旧存在）。
       */
      for (const child of pool.idleForeign) {
        reuseSkipped.push({
          childSessionId: child.childSessionId,
          role: pool.role,
          reason: '跨父会话（宿主只允许父会话复用自己起的子代理）→ 不复用',
        })
      }
    }
    /**
     * **`DEF-139` 落点二（`TASK-196`）**：候选**顺序**也是决策的一部分 ——
     * **同父会话优先**，其余（父会话未知的老事件）排后。
     *
     * 病根（真机 seq 4982 / 4998 的同一形状：`idle=68 / idleSameParent=29 / idleUnknownParent=39 /
     * unusable=0` 却 `reused=false` 且零条 `reuse-skipped`）：旧实现取 `pool.idle.findIndex(...)`，
     * 而 `pool.idle` 的顺序**是台账折叠顺序**（最老的在前）⇒ 挑中的几乎总是最老的那个老会话。
     * 那个会话投进去被宿主拒（`startDispatch` 的 `sendMessage` 抛错 ⇒ `reuseFailed` ⇒ 退化成新起），
     * 于是**每一轮 developer 派发都挑同一个投不进去的候选、每一次都新起**，
     * 而"复用被拒"只活在回执里、不进台账 ⇒ 驾驶舱只能靠掩码哈希反推（并反推错过两次）。
     *
     * 池视图自己已经把这一桶分出来了：`idleSameParent` 的定义就是「`idle` 里父会话 = 观察者的
     * （**派发器真的能投**）」（见 {@link PoolBuckets.idleSameParent}）。决策不读它 = 读数与决策不同源。
     *
     * **诚实边界**：父会话未知的老会话**不是**一律不可投 —— 台账里 60 笔成功复用中有 41 笔复用的正是
     * 这种老会话（`parentSessionId` 字段是后来才加上的）。所以这里只做**排序**、不做排除：
     * 同父的挑完了，仍然可以落到它们身上。
     */
    if (input.reuseIdle && input.forceNew !== true && pool.idle.length > 0) {
      const taken = reuseCandidateOrder(pool).find((child) => blockedReasonOf(child) === undefined)
      if (taken !== undefined) {
        const index = pool.idle.findIndex((child) => child.childSessionId === taken.childSessionId)
        if (index >= 0) pool.idle.splice(index, 1)
        pool.busy.push({ ...taken, state: 'busy', task: task.id })
        dispatch.push({ task, reuseChildId: taken.childSessionId })
        room -= 1
        continue
      }
    }
    // **R-13**：`forceNew` 时容量不含"可复用空闲"（本轮不许用它们，它们也就不该挡新起）
    const admitted = admittedByRole.get(pool.role) ?? 0
    const freshRoom = input.forceNew === true ? Math.max(0, pool.cap - pool.busy.length - admitted) : pool.freeSlots
    if (freshRoom > 0) {
      pool.freeSlots = Math.max(0, pool.freeSlots - 1)
      // **R-5A**：这里**不再**往 `pool.busy` 里塞占位孩子（`childSessionId: ''`）。
      // 占位会让回执印出「在飞 4/4」而实际只派了 1 张（真机：0 真在飞 + 4 准入 = 4/4）——
      // 「在飞」是**事实**，「本次准入 N 张」是**计划**，两者必须分开讲。
      admittedByRole.set(pool.role, (admittedByRole.get(pool.role) ?? 0) + 1)
      dispatch.push({ task })
      room -= 1
      continue
    }
    queued.push(task)
    const admittedNow = admittedByRole.get(pool.role) ?? 0
    const forced = input.forceNew === true && pool.idle.length > 0
      ? `，本轮 freshChild=true（强制新起）⇒ 池内 ${pool.idle.length} 个空闲可复用会话**不参与容量计算**`
      : ''
    blocked.push({
      task,
      reason: 'pool-full',
      detail: `${pool.role} 池满（在飞 ${pool.busy.length}/${pool.cap}${pool.idle.length > 0 ? `，空闲可复用 ${pool.idle.length}` : ''}${admittedNow > 0 ? `，本次已先准入 ${admittedNow} 张新建` : ''}${forced}）`,
    })
  }
  // **R-5B**：`reuseSkipped` 以前在"逐候选卡"的循环里 push ⇒ **候选卡 × 不可复用会话**的笛卡尔积
  // （真机把同一个 sessionId 重复列了 6 次/5 次，回执写「有 12 个空闲子代理没有被复用」而实际只有 2 个）。
  // 按 `childSessionId` 去重，保首条理由（顺序即首次出现的顺序）。
  const seenSkipped = new Set<string>()
  const dedupedSkipped = reuseSkipped.filter((item) => {
    if (seenSkipped.has(item.childSessionId)) return false
    seenSkipped.add(item.childSessionId)
    return true
  })
  return { reuseIdle: input.reuseIdle, forceNew: input.forceNew === true, dispatch, reuseSkipped: dedupedSkipped, queued, blocked, pools }
}

/* —————————————————————— 派发现场的**可读读数**（`TASK-163` / `DEF-139`） —————————————————————— */

/**
 * **children 从哪来**（`DEF-139` 落点一）：这个口径名必须**写进事件**。
 *
 * 病根（真机两次反推错过的事故）：驾驶舱只能看到「池里明明有空闲可复用、却没复用」，
 * 于是拿掩码哈希反推"是不是判据没过"—— 而真相可能是**孩子根本没被取到**（折叠/来源不含）
 * 或者**复用分支压根没跑到**（`reuseIdle=false` / `freshChild=true`）。两者与"判据说不行"
 * 在台账上长得一模一样。名字固定三种，读侧不必猜：
 *
 *   · `journal`    —— 只从 append-only 台账折叠（`foldPoolChildren`；**今天实现就是这一种**）；
 *   · `host-live`  —— 只用宿主实时列表（`subagents.listDescendants()` 一类）；
 *   · `journal+host` —— 两者合并（各自的 id 并集）。
 *
 * **诚实边界**：本字段只陈述"这一轮读数的来源"，不陈述"来源里应该有而没有的"。
 * 后者要么靠宿主实时列表（第三种），要么在池视图里如实标"不在实时列表"。
 */
export type ChildrenSource = 'journal' | 'host-live' | 'journal+host'

/** 一个角色池的**各桶计数**（`DEF-139` 落点一：定案靠它，不靠掩码哈希反推）。 */
export interface PoolBuckets {
  /** 在飞（已派发未结算；不含 `stale`） */
  busy: number
  /** 空闲且可复用（continuable + 已结算 + 过闸门） */
  idle: number
  /** `idle` 里父会话 = 观察者的（**派发器真的能投**） */
  idleSameParent: number
  /** `idle` 里跨父会话的（宿主会拒） */
  idleForeign: number
  /** `idle` 里父会话未知的（老事件） */
  idleUnknownParent: number
  /** 超时未结算（不占池位、不进 `idle`） */
  stale: number
  /** 已结算但 one-shot（不可复用） */
  retired: number
  /** 空闲但过不了闸门（掩码/观测/持卡/余量）—— `reuseSkipped` 说的就是这些 */
  unusable: number
}

/** 一次派发的**现场读数**：`children 从哪来 + 一共几个 + 各桶几条 + 该角色 cap/freeSlots`。 */
export interface PoolReading {
  role: string
  childrenSource: ChildrenSource
  /** **折叠出来的孩子总数**（全角色；`buckets` 才是该角色的桶） */
  childrenTotal: number
  buckets: PoolBuckets
  /** 该角色的并行上限 */
  cap: number
  /** 还能**新建**几个子代理 */
  freeSlots: number
}

/**
 * 算**一个角色**的现场读数（纯函数，`nowMs` 由调用方经 `rolePools` 注入 ⇒ 同一台账两次调用逐字节相同）。
 *
 * 口径纪律：**不另立一套判定** —— 桶全部取自 `rolePools()` 的结果（`freeSlots` 也一样），
 * 所以"回执里的数"与"准入用的数"是**同一份**。`childrenTotal` 是喂进池的折叠结果大小（全角色）。
 *
 * 该角色在 `pools` 里没有条目（没出现在 roles、也没有孩子）⇒ 各桶为 0、`cap`/`freeSlots` 为 0
 * ——**不是**"不限量"：调用方要么先把角色放进 `rolePools({roles})`，要么在回执里说"这个角色今天没有池"。
 */
export function poolReading(input: {
  role: string
  childrenSource: ChildrenSource
  children: Iterable<PoolChild>
  pools: readonly RolePool[]
}): PoolReading {
  const children = [...input.children]
  const pool = input.pools.find((item) => item.role === input.role)
  return {
    role: input.role,
    childrenSource: input.childrenSource,
    childrenTotal: children.length,
    buckets: {
      busy: pool?.busy.length ?? 0,
      idle: pool?.idle.length ?? 0,
      idleSameParent: pool?.idleSameParent.length ?? 0,
      idleForeign: pool?.idleForeign.length ?? 0,
      idleUnknownParent: pool?.idleUnknownParent ?? 0,
      stale: pool?.stale.length ?? 0,
      retired: pool?.retired ?? 0,
      unusable: pool?.unusable.length ?? 0,
    },
    cap: pool?.cap ?? 0,
    freeSlots: pool?.freeSlots ?? 0,
  }
}

/**
 * **一次派发要记的那几条读数**（`TASK-163` 落点一）：逐角色摊平成一份清单（**按角色名排序**，
 * 键序由 `poolReading` 的字面量固定 ⇒ 同一台账两次调用逐字节相同）。
 *
 * 口径纪律：桶与 `freeSlots` 全部取自**同一份** `rolePools()` 结果，本函数只做"选角色 + 排序"，
 * 不另立判定 —— 否则回执里的数会与准入用的数分叉（`R-6` 的真机教训）。
 *
 * @param input.pools **准入之前**的池快照（不传准入后的那一份，理由见 `PoolAdmission.readings`）
 */
export function rolePoolReadings(input: {
  roles: readonly string[]
  childrenSource: ChildrenSource
  children: Iterable<PoolChild>
  pools: readonly RolePool[]
}): PoolReading[] {
  const roles = [...new Set(input.roles)].filter((role) => role !== '').sort()
  return roles.map((role) => poolReading({
    role,
    childrenSource: input.childrenSource,
    children: input.children,
    pools: input.pools,
  }))
}

/** 从读数列里取**某个角色**那条（没有 ⇒ `undefined`：**"没记"与"记了 0"必须可区分**）。 */
export function readingOfRole(readings: readonly PoolReading[] | undefined, role: string): PoolReading | undefined {
  return (readings ?? []).find((reading) => reading.role === role)
}

/**
 * **读数的逐字节可比指纹**（`REQ-035` / `REQ-037` 的可复现性口径）。
 *
 * 为什么要有它：`AC-254` 那条（同一门禁同真源两次 criteria 逐条相同）被降级到待重开卡，
 * 但同类口径必须在本卡**真的可判**：同一台账、同一角色，两次独立读数要给出**同一个字节序列**。
 * 因此这里不做"看起来相等的对象比较"，而是取 **JSON 文本**（键序由 {@link poolReading} 的字面量固定）。
 */
export function poolReadingsFingerprint(readings: readonly PoolReading[]): string {
  return JSON.stringify(readings.map((reading) => ({
    role: reading.role,
    childrenSource: reading.childrenSource,
    childrenTotal: reading.childrenTotal,
    buckets: {
      busy: reading.buckets.busy,
      idle: reading.buckets.idle,
      idleSameParent: reading.buckets.idleSameParent,
      idleForeign: reading.buckets.idleForeign,
      idleUnknownParent: reading.buckets.idleUnknownParent,
      stale: reading.buckets.stale,
      retired: reading.buckets.retired,
      unusable: reading.buckets.unusable,
    },
    cap: reading.cap,
    freeSlots: reading.freeSlots,
  })))
}

/**
 * 读数的一行投影（回执/诊断用）。**字段名用 ASCII**：本行会被写进事件与回执，
 * 而语言包键不在本卡的写范围内（见 `dispatchFace.reuseSkippedLines` 的同类说明）。
 */
export function poolReadingLine(reading: PoolReading): string {
  const b = reading.buckets
  return `role=${reading.role} childrenSource=${reading.childrenSource} childrenTotal=${reading.childrenTotal}`
    + ` idle=${b.idle} idleSameParent=${b.idleSameParent} idleForeign=${b.idleForeign} idleUnknownParent=${b.idleUnknownParent}`
    + ` stale=${b.stale} retired=${b.retired} unusable=${b.unusable} busy=${b.busy}`
    + ` cap=${reading.cap} freeSlots=${reading.freeSlots}`
}

/**
 * **被闸门拒的空闲孩子逐条摊开**（`DEF-139` 落点二）：`childSessionId` / `role` / `reason` **三个字段
 * 每条都列**，不许只打一个数量。
 *
 * 为什么必须逐条：真机回执只印「有 12 个空闲子代理没有被复用」—— 那个数还是**笛卡尔积去重前**的
 * （`R-5B`），于是"为什么没复用"在回执上永远答不了；回执里现在也缺了 `role` 这一列，
 * 而跨角色混在一起正是看不清的主因。
 */
export function reuseSkippedLines(rows: readonly { childSessionId: string; role: string; reason: string }[]): string[] {
  return rows.map((row) => `childSessionId=${row.childSessionId} role=${row.role} reason=${row.reason}`)
}

/** 满池排队的人读说明（回执用；点名角色与上限，并指向"等谁结算"）。 */
export function poolBlockedReason(admission: PoolAdmission): string | undefined {
  if (admission.blocked.length === 0) return undefined
  const roles = [...new Set(admission.blocked.filter((item) => item.reason === 'pool-full').map((item) => item.task.role))]
  return roles.length > 0 ? roles.join(' / ') : 'global'
}
