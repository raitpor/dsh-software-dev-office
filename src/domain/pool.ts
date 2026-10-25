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
import { REUSE_SKIPPED_EVENT } from './dispatchFace.js'
import { MASK_FINGERPRINT_VERSION, maskBacktrack, maskHashVersion } from './roles.js'
import { sessionIdleTracker } from './dispatchHealth.js'
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
   *
   * `TASK-208` 起带**口径版本**（`2:<hash>`，见 `MASK_FINGERPRINT_VERSION`）：没有版本前缀的是旧口径，
   * 不能与现算值直接比 —— 那是 `DEF-194` 的"两种口径长得一样"的病根。
   */
  maskHash?: string | undefined
  /**
   * 该会话**创建时**的 SDO 流程面白名单（`dispatch/started.sdoAllow`）—— 旧口径指纹的**回溯依据**
   * （`TASK-208` 落点五）。只在第一次 `dispatch/started` 上取：工具面是创建时定下的，后续复用那几笔
   * 记的是"当时的角色面"，不是这个会话的面。
   */
  sdoAllow?: string[] | undefined
  /** 该会话**创建时**实际下发的 deny 面（`dispatch/started.deny`）—— 同上，是"当时禁令集"的唯一残迹。 */
  deny?: string[] | undefined
  /**
   * **最近一次投递被宿主拒**的原话（`TASK-208` 落点二）：该孩子仍空闲，但往它那儿投卡被拒过，
   * 且在它之后没有一次成功投递（成功即清空）。
   *
   * 为什么必须进读数：`DEF-185` 的真机形状是「`idle=77 / unusable=0` 却 `reused=false`」——
   * 投递被拒这件事只活在回执里，桶里一个字都没有 ⇒ 看起来"判据全过却不复用"。
   */
  deliveryFailedReason?: string | undefined
}

/**
 * 「投递被宿主拒」那批留痕的**机器可读前缀**（`TASK-208` 落点二）。
 *
 * 为什么用前缀而不是新增字段：留在台账里的 `reuseSkipped` 行只有三字段（`childSessionId`/`role`/
 * `reason`，见 `dispatchFace.reuseSkippedFields`），闸门拒与投递拒走**同一个**承载 ⇒ 读侧要靠一个
 * **稳定字形**分流。ASCII 前缀不受语言包影响（口径与 `dispatchFace` 里那些 ASCII 投影一致）。
 */
export const DELIVERY_FAILED_PREFIX = 'delivery-failed: '

/** 从一条 `reuseSkipped.reason` 里取出「投递被拒」的宿主原话（不是投递拒的 ⇒ `undefined`）。 */
export function deliveryFailureOf(reason: string): string | undefined {
  return reason.startsWith(DELIVERY_FAILED_PREFIX) ? reason.slice(DELIVERY_FAILED_PREFIX.length).trim() : undefined
}

function namesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
}

/** 一个角色池的现状。 */
export interface RolePool extends RetiredBuckets {
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
 *
 * `TASK-208` 起多折三样（都只从**已有事件**折，不新增真源）：
 *   · `sdoAllow` / `deny` —— **创建时**那两份面（旧口径指纹的回溯依据，落点五）；
 *   · `maskHash` —— **创建时**那一份（复用那几笔记的是"当时的角色面"，不是这个会话的面 ⇒ 不许覆盖，
 *     否则旧会话被复用一次之后就"看起来跟当前一致"，R-7 的口子重新打开）；
 *   · `deliveryFailedReason` —— 最近一次**投递被宿主拒**的原话（落点二：让它进 `unusable` 桶）。
 */
export function foldPoolChildren(events: readonly PoolEvent[]): Map<string, PoolChild> {
  const children = new Map<string, PoolChild>()
  // **先减退役集再折叠**（`TASK-228` 落点一；顺序与复活规则见 `retiredSetOf`）
  const retired = retiredSetOf(events)
  // 忙闲读数走**同一处真源**（`TASK-261` 落点一：`dispatchHealth.ts` 的 `sessionIdleTracker`，修前这里内联过一份）
  const idle = sessionIdleTracker()
  for (const event of events) {
    if (event.type === 'dispatch/started') {
      const id = text(event.data['childSessionId'])
      if (id === '') {
        // 没有孩子 id 的 started 不成话，但它可能挂着**投递被拒**的留痕（那批 row 自己有 childSessionId）
        applyDeliverySkips(children, event.data['reuseSkipped'], undefined)
        continue
      }
      // **先减退役集**（`TASK-228` 落点一）：已退役的候选不进折叠（池视图/准入/`reuseSkippedOf` 都看不到它）
      if (retired.has(id)) continue
      const previous = children.get(id)
      const mergedCardIds = [...new Set([...(previous?.cardIds ?? []), text(event.data['task'])])].filter((item) => item !== '')
      const reused = event.data['reused'] === true
      children.set(id, {
        childSessionId: id,
        role: text(event.data['role']),
        task: text(event.data['task']),
        // 老事件没有 `mode` ⇒ one-shot（不可复用）。反过来猜"可复用"会在真机上把卡投进一个已经不存在的子代理。
        parentSessionId: text(event.data['parentSessionId']),
        mode: text(event.data['mode']) === 'continuable' ? 'continuable' : 'one-shot',
        state: idle.step(id, event).idle ? 'idle' : 'busy',
        rounds: (previous?.rounds ?? 0) + 1,
        // **DEF-069**：`cards` = 该子会话承接过的**不同卡数**（必须**累积**，不能只存当轮 —— 真机
        // 同一会话接了 20 张卡，只看轮数会以为"还有余量"）。
        cards: mergedCardIds.length,
        startedAt: event.at ?? text(event.data['startedAt']),
        finishedAt: '',
        // ① 复用的那一笔**不覆盖**创建时的指纹（见函数头注释）；② 这一笔若是一次**成功投递**，
        // 上一次的"投递被拒"就作废（成功即清空）。
        maskHash: reused && previous !== undefined ? (previous.maskHash ?? '') : text(event.data['maskHash']),
        sdoAllow: previous?.sdoAllow ?? namesOf(event.data['sdoAllow']),
        deny: previous?.deny ?? namesOf(event.data['deny']),
        cardIds: mergedCardIds,
      })
      applyDeliverySkips(children, event.data['reuseSkipped'], id)
      continue
    }
    // **独立事件承载**（`dispatch/reuse-skipped`）：同样只认带「投递被拒」前缀的那几条
    if (event.type === REUSE_SKIPPED_EVENT) {
      applyDeliverySkips(children, [event.data], undefined)
      continue
    }
    const id = text(event.data['childSessionId'])
    if (id === '') continue
    // 收口判据也读同一处真源（`settled` = 这一笔结算了这一轮；修前是内联的 `isTerminalDispatch(…, 'session')`）
    const step = idle.step(id, event)
    if (!step.settled) continue
    const child = children.get(id)
    if (child === undefined) continue
    // 结算只认"当前这一轮"：已经 idle 的孩子再收一条 finished 不重复计数（幂等）
    children.set(id, { ...child, state: step.idle ? 'idle' : 'busy', finishedAt: event.at ?? text(event.data['finishedAt']) })
  }
  return children
}

/**
 * 把一批 `reuseSkipped` 留痕里**投递被拒**的那几条标到对应的孩子身上（`TASK-208` 落点二）。
 *
 * 两个边界：
 *   · 只认 `DELIVERY_FAILED_PREFIX` 开头的那批 —— 闸门拒（掩码/持卡/余量）本来就由
 *     `reuseBlockedReason` 现算，不需要台账帮忙，混进来只会把两件事说成一件；
 *   · 孩子认不出（事件里没有它的 `dispatch/started`）⇒ **不凭空造**（`DEF-185` 的教训：宁可少记也不编）。
 *     `justDelivered` 是这一笔事件里**刚被投递成功**的孩子：成功即清空上一次的失败标记。
 */
function applyDeliverySkips(children: Map<string, PoolChild>, rows: unknown, justDelivered: string | undefined): void {
  if (justDelivered !== undefined) {
    const delivered = children.get(justDelivered)
    if (delivered !== undefined && delivered.deliveryFailedReason !== undefined) {
      const { deliveryFailedReason: _cleared, ...rest } = delivered
      children.set(justDelivered, rest)
    }
  }
  if (!Array.isArray(rows)) return
  for (const item of rows) {
    const row = item as { childSessionId?: unknown; reason?: unknown }
    const id = text(row.childSessionId)
    const reason = deliveryFailureOf(text(row.reason))
    if (id === '' || reason === undefined) continue
    const child = children.get(id)
    if (child === undefined) continue
    children.set(id, { ...child, deliveryFailedReason: reason })
  }
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
  const deliveryFailed = child.deliveryFailedReason ?? ''
  const actual = child.maskHash ?? ''
  const maskReason = maskBlockedReason(child, actual, wantedMaskHash)
  if (maskReason !== undefined) return maskReason
  // **`TASK-208` 落点二**：投递被拒也是"不能复用"的事实，必须进同一个判据（⇒ 进 `unusable` 桶并带原因）。
  // 放在掩码之后：掩码/观测是"这个会话的面不对"，比"上一次投递失败"更根本，先报更可执行的。
  if (deliveryFailed !== '') {
    return `上一次投递被宿主拒（宿主原话：${deliveryFailed}）⇒ 不再挑它`
  }
  return undefined
}

/**
 * **掩码口径的比对**（`DEF-194` / `TASK-208` 落点三、落点五）—— 三条路，**方向全部是保守的**：
 *
 *   ① **同版本**（两侧都带版本号）⇒ 逐字节比哈希：快路径，面变没变一目了然；
 *   ② **旧值无版本号** ⇒ 走 {@link maskBacktrack} 从已存的面**现算**：只有能证成"禁令集与角色 deny
 *      都已覆盖、且可回溯子面逐项相同"才放行；证不成 ⇒ **版本不可比 ⇒ 不复用**（`R-7` 不回归）；
 *   ③ 指纹缺失/当前指纹取不到 ⇒ 一律不复用（与旧口径一致）。
 *
 * 为什么"旧值"这一档不能沿用"掩码已变更"了事：旧台账里 77 个 developer 空闲会话全是旧口径指纹，
 * 一句"面变了"会把整池一次性作废（`DEF-194` 反对的正是这种代价）；但也不能为了留住它们就把
 * 判据放宽 —— 所以是"能证成才放行"，理由里逐字写出证成/证不成在哪。
 */
function maskBlockedReason(child: PoolChild, actual: string, wantedMaskHash: string): string | undefined {
  if (wantedMaskHash !== '' && actual === wantedMaskHash) return undefined
  if (actual === '') return '旧子代理没有掩码指纹（无法确认其工具面）'
  if (wantedMaskHash === '' || maskHashVersion(actual) === MASK_FINGERPRINT_VERSION) {
    return '掩码已变更（该会话的工具面是创建时的旧面）'
  }
  const backtrack = maskBacktrack(child.role, { sdoAllow: child.sdoAllow, deny: child.deny })
  if (backtrack.reusable) return undefined
  return `掩码已变更（旧口径指纹没有版本号，且回溯判不了：${backtrack.detail}）`
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
      unusable, permanent: permanentCandidatesOf(continuable.filter((child) => unusableIds.has(child.childSessionId)), input.viewerSessionId),
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

/* —————————————————————— ② 真实在飞：唯一口径（`TASK-231` / `DEF-214`） —————————————————————— */

/** 台账事件的最小读形状（带序号：点名要能引到可复算锚点）。 */
export interface DispatchLedgerEvent extends PoolEvent {
  seq?: number | undefined
}

/**
 * 「真在飞」的一份读数（`TASK-231` 落点二）：只由 `dispatch/started` 推导，**永不**由 `decided` 推导。
 */
export interface LiveDispatchReading {
  /** 真在飞的卡 id（去重、按首次出现排序） */
  taskIds: string[]
  /** 真在飞的孩子（`busy` 且未超 TTL、且卡未被 release 覆盖）—— 回执「在飞定位」就是它的投影 */
  children: PoolChild[]
  /** 被 `task/released` 覆盖掉的卡（派发之后操作者已判定那个子会话没了）—— 如实交回，别静默丢 */
  releasedAfterDispatch: string[]
  /** `started` 有、`finished` 无、且已超 TTL 的（孤儿：不占位，也**不**当空闲可复用） */
  stale: PoolChild[]
}

/**
 * 现算「真在飞的卡」：**所有"谁在飞"的判定都走这里**（池视图 / 冻结判定 / 容量预算 /
 * `recoverView` / `inflightView`）。
 *
 * ⚠️ 措辞更正（`REV-104` #5）：上一版把它写成"唯一出口"，而 `recoverView` / `inflightView`
 * 当时仍在用 `dispatchedChildren`（全部 `started`，不过 `finished`、不过 TTL）—— 声称强于机制。
 * 现在这两处也改过来了；"唯一"指的是**`started` 三态判定的唯一实现**，不是"全仓只有一处读
 * `dispatch/started`"（历史面 `dispatchedChildren` 仍在，用于"谁跑过"）。
 *
 * 一张卡算**在飞**的充要条件：`dispatch/started` 之后既没有 `dispatch/finished`、也没超孤儿 TTL，
 * 且该卡在那笔派发之后**没有**被 `task/released`（R-9：那是操作者的显式判定）。
 *
 * 为什么必须只有一处：`DEF-214` 的真机形状是「回执说在飞、卡却是 planned、`owner` 空」——
 * 读数与容量各算一遍时必然分叉。判据只看 `started`：**`decided` 是"决定了"，不是"发生了"**，
 * 它永远不进这个集合（哪怕它一条 `started` 都没有）。
 *
 * 折叠与 `foldPoolChildren` 完全同源（不新增真源、不另立一遍状态机），只多做两步：
 *   ① 超 TTL 的 `busy` 是**孤儿**（`isStaleDispatch`）⇒ 进 `stale`，不进 `children`；
 *   ② 卡在派发之后被 `task/released` ⇒ 不进 `children`，进 `releasedAfterDispatch`。
 */
export function liveDispatchReading(
  events: readonly DispatchLedgerEvent[],
  options: { ttlMs?: number | undefined; nowMs?: number | undefined } = {},
): LiveDispatchReading {
  const ttl = options.ttlMs ?? 0
  const now = options.nowMs ?? Date.now()
  const children = [
    ...foldPoolChildren(events.map((event) => ({ type: event.type, data: event.data, at: event.at }))).values(),
  ]
  // R-9：`task/released` 晚于该卡的 `dispatch/started` ⇒ 操作者已判定那个子会话没了
  const lastStarted = new Map<string, number>()
  const lastRelease = new Map<string, number>()
  for (const [index, event] of events.entries()) {
    const seq = event.seq ?? index
    const id = text(event.data['id'] ?? event.data['task'])
    if (id === '') continue
    if (event.type === 'dispatch/started') lastStarted.set(id, seq)
    if (event.type === 'task/released') lastRelease.set(id, seq)
  }
  const releasedAfterDispatch = new Set<string>()
  for (const [id, seq] of lastRelease) if ((lastStarted.get(id) ?? Number.POSITIVE_INFINITY) < seq) releasedAfterDispatch.add(id)
  const stale = children.filter((child) => child.state === 'busy' && isStaleDispatch(child, now, ttl))
  const live = children.filter((child) =>
    child.state === 'busy' && !isStaleDispatch(child, now, ttl) && !releasedAfterDispatch.has(child.task))
  const seen = new Set<string>()
  const taskIds: string[] = []
  for (const child of live) {
    if (child.task === '' || seen.has(child.task)) continue
    seen.add(child.task)
    taskIds.push(child.task)
  }
  return { taskIds, children: live, stale, releasedAfterDispatch: [...releasedAfterDispatch].sort() }
}

/* ——————————————— ④ 池候选的**一次性退役**（`TASK-228` / `DEF-210` 同族） ——————————————— */

/**
 * **退役事件**（`pool/retired`）：某个候选被判定为**永久**不可复用 ⇒ 落一条事件、此后移出池。
 *
 * 为什么需要它（真账两时点都量过，读数在本卡回报里）：`reuse-skipped` 里**同一个候选的同一句话**
 * 被**每一轮派发**重记一遍 —— 本轮现算 **2379 条事件 / 3179 条候选行**，其中 **3149 条**是同一句
 * 「旧口径指纹没有版本号」。那些候选**不会**再变回可用（指纹在会话创建时定死），却每轮都被重新
 * 判定、重新落账 ⇒ 台账噪音随派发次数线性长，而"为什么没复用"这个读数反而被死账淹没。
 *
 * 三条口径（都写在这里，免得读侧各猜一遍）：
 *   ① **谁写**：`index.ts` 在**真派发**那一轮写（`why=true` 是纯诊断面，不写台账）；
 *   ② **写几条**：本轮判成永久的候选**一次性**落盘（写入端按 `POOL_RETIRED_CHUNK` 分片），
 *      此后每轮 **0 条** —— {@link foldPoolChildren} 先减退役集，它们根本不再进折叠；
 *   ③ **怎么读**：{@link retiredCandidatesOf}（按角色点名）/ {@link retiredSinceOf}（刀口位置，读侧据此只砍死账），
 *      只认事件字形，不新立真源。
 *
 * ⚠️ **append-only 的后果必须一起读**：退役**不会**改写历史事件 ⇒ 历史读数里那 3149 条仍然在账上
 * （它们记的是"当年每一轮为什么没复用"，那是**事实**）。所以"退役之后历史计数没变小"是**对的**，
 * 不是没修好；变的是**此后每一轮**（新增 0 条 + 不再重判）。
 *
 * ⚠️ **「一次」是"每一轮不重复"，不是"可逆"**（`REV-116` 必核二① 附带 / 必核二②，本卡的正式承认）：
 *   · **复活**（退役之后又出现 `dispatch/started`）只让该候选**重新进折叠**、并把它从
 *     {@link retiredCandidatesOf} 里**拿掉**（见 {@link retiredSinceOf} 的位置判据）；
 *   · 它**不撤销判定**：判据读的是**创建时**定死的字段（`maskHash` 在复用那几笔里刻意不被覆盖，
 *     见 {@link foldPoolChildren} 头注释），所以复活的孩子下一轮会被**再判永久、再写一条**
 *     `pool/retired`（同一孩子两条事件）。
 *   · 于是「误退役的代价」= **一个可被外部补写救回来、但救回来仍会被再退一次**的循环，而不是
 *     干净的撤销。要真正可逆，得让退役事件带 `parentSessionId` / `viewerScope` 并有
 *     `pool/unretire` 一类带人工签字的推翻通道 —— 那是**另一张卡**（本卡不假装它已经存在）。
 */
export const POOL_RETIRED_EVENT = 'pool/retired'

/**
 * 一个被退役的候选（`pool/retired` 的读侧投影）。
 *
 * `basis` 是**机器可读**的永久性分类，`reason` 是**人读原话**：两者由**同一个**判定
 * （{@link permanentUnreusableReason}）产出 ⇒ 写侧不必再各判一遍（判据两处必然分叉）。
 */
export interface RetiredCandidate {
  childSessionId: string
  role: string
  /** 人读原话（与池视图 `unusable.reason` 同一形态） */
  reason: string
  /** `mask-not-comparable` / `host-unreachable`（空串 = 老事件没写这一格，如实留空） */
  basis: string
  /** 那笔退役事件的 `at`（空串 = 事件没带时间） */
  at: string
}

/** 从一笔事件的数据面里取出退役行（两种形态都认：批量的 `retired[]` 与单条的 `childSessionId`）。 */
function retiredRowsOf(data: Record<string, unknown>): { childSessionId: string; role: string; reason: string; basis: string }[] {
  const out: { childSessionId: string; role: string; reason: string; basis: string }[] = []
  const single = text(data['childSessionId'])
  if (single !== '') {
    out.push({ childSessionId: single, role: text(data['role']), reason: text(data['reason']), basis: text(data['basis']) })
  }
  const rows = data['retired']
  if (!Array.isArray(rows)) return out
  for (const item of rows) {
    const row = item as { childSessionId?: unknown; role?: unknown; reason?: unknown; basis?: unknown }
    const id = text(row.childSessionId)
    if (id === '') continue
    out.push({ childSessionId: id, role: text(row.role), reason: text(row.reason), basis: text(row.basis) })
  }
  return out
}

/**
 * **当前仍处于退役态**的候选（按台账顺序，同一孩子取**最后一次**退役那一笔）。
 *
 * 复活规则（唯一的例外，必须一起读）：一个孩子退役之后**又出现** `dispatch/started` ⇒ 它重新算活
 * （有人真的把它投起来了）⇒ **从本清单里被拿掉**（不是"改写一条事件"：append-only 里没有撤销写法）。
 * **没有**这条规则，一次误判会把这个会话永久钉死在账外；**有**这条规则也不等于判定可逆 ——
 * 复活的孩子下一轮会被**再判永久、再写一条**（判据读创建时字段），代价写在
 * {@link POOL_RETIRED_EVENT} 的「一次 ≠ 可逆」那段里。
 */
export function retiredCandidatesOf(events: readonly PoolEvent[]): RetiredCandidate[] {
  const latest = new Map<string, RetiredCandidate>()
  events.forEach((event) => {
    if (event.type !== POOL_RETIRED_EVENT) return
    for (const row of retiredRowsOf(event.data)) {
      latest.set(row.childSessionId, { ...row, at: event.at ?? '' })
    }
  })
  const live = retiredSetOf(events)
  return [...latest.values()].filter((row) => live.has(row.childSessionId))
}

/**
 * **退役位置表**（`childSessionId` → 它"最后一次退役"在台账里的位置）：读侧的**分界线**。
 *
 * 为什么要位置而不只是集合：append-only 台账里"退役"是一**刀**。刀**之前**写下的
 * `reuse-skipped` 行是死账（那个候选当年每一轮都被重记一遍），刀**之后**写下的行是新事实
 * （例如运维手工补的一笔探查）。读侧（`reuseSkippedOf`）据此只砍死账、不砍新事实 ——
 * 于是"退役之后回执不再念死账"与"退役那一轮的行仍可核对"两件事能同时成立。
 *
 * 口径：同一孩子"最后一次退役的位置"必须**晚于**它"最后一次 `dispatch/started` 的位置"
 * （之后又起来了 = 复活 ⇒ 不在表里）。顺序取自事件在数组里的位置（台账顺序 = append 顺序；
 * 缺 `seq` 的老调用方也照样可判）。
 *
 * ⚠️ 反向**没有**留痕（`REV-116` 必核二②）：复活不写任何计数事件，读者只看见某条从
 * {@link retiredCandidatesOf} 里消失；能追回去的只有那笔 `dispatch/started` 本身。这条是**已知取舍**，
 * 不是漏 —— 要补就得给事件族加一种"推翻"事件（与 `viewerScope` 同一批做）。
 */
export function retiredSinceOf(events: readonly PoolEvent[]): Map<string, number> {
  const retiredAt = new Map<string, number>()
  const startedAt = new Map<string, number>()
  events.forEach((event, index) => {
    if (event.type === POOL_RETIRED_EVENT) {
      for (const row of retiredRowsOf(event.data)) retiredAt.set(row.childSessionId, index)
      return
    }
    if (event.type !== 'dispatch/started') return
    const id = text(event.data['childSessionId'])
    if (id !== '') startedAt.set(id, index)
  })
  const out = new Map<string, number>()
  for (const [id, index] of retiredAt) {
    if (index > (startedAt.get(id) ?? -1)) out.set(id, index)
  }
  return out
}

/**
 * **可以退役的候选**：从**同一份事件数组**里投影出来的「永久」那一批（`TASK-228` 落点一的**唯一入口**）。
 *
 * 三条口径（`REV-116` 返工后定稿，`index.ts` 只调这一个函数）：
 *   ① **一份读、两件产出**：退役清单（{@link retiredCandidatesOf}）与本轮待退役的行都由调用方交进来的
 *      **同一个** `events` 数组算出 ⇒ 不会出现「快照里的 `permanent`」与「台账里的 `retiredOfRole`」
 *      两份读数（那正是 `REV-116` 必核四② 点名的 `DEF-185` 形态：同一次决定读两遍，并发追加下两份不等，
 *      于是同一候选会被算两遍、并被再退役一次）。
 *   ② **判据只有一处**：{@link permanentUnreusableReason}（本层唯一判定点），本函数只做投影。
 *   ③ **刻意不判「跨父会话」**：不传观察者 ⇒ `host-unreachable` 这一档**不进退役**。原因是语义冲突
 *      （`REV-116` 必核四③）：退役是**台账全局**的，而 `host-unreachable` 是**观察者相对**的
 *      （见 {@link permanentUnreusableReason} 的 `viewerSessionId`）⇒ 若接进来，观察者 A 就能把
 *      B 自己起的子代理从**所有**池里删掉。要接它，退役事件必须先带 `parentSessionId` / `viewerScope`
 *      （另一张卡）。真账读数：这一档 0 条（101 条退役 basis 全是 `mask-not-comparable`）。
 *
 * **没有「出生满一轮」那道门**（`REV-116` 必核三②，本卡删掉了它）：那道门按「最后一笔
 * `dispatch/started` 是不是最新的」排序，而判据**只读创建时定死的字段**（`maskHash` / `sdoAllow` /
 * `deny` / `parentSessionId`，见 `foldPoolChildren` 头注释与 `permanentUnreusableReason`）⇒ 等一轮
 * 结论**一个字都不会变**，唯一效果是延迟一轮。留下的实质门是**内容**判据（「有在飞卡 ⇒ 临时」
 * 「投递失败 ⇒ 临时」，都在 `permanentUnreusableReason` ①②，有真实理由：那两态会变）。
 */
export function permanentCandidatesFromEvents(
  events: readonly PoolEvent[],
): { childSessionId: string; role: string; reason: string; basis: string }[] {
  // `foldPoolChildren` **先减退役集** ⇒ 已退役的候选根本不会出现在这里（幂等由结构给出，不靠调用方）
  const continuable = [...foldPoolChildren(events).values()]
    .filter((child) => child.role !== '' && child.mode === 'continuable')
  const rows = permanentCandidatesOf(continuable)
  const roleOf = new Map(continuable.map((child) => [child.childSessionId, child.role]))
  return rows.map((row) => ({ ...row, role: roleOf.get(row.childSessionId) ?? '' }))
}

/**
 * 退役集（`childSessionId` 的集合）：**先减退役集再折叠**用的那一份（= {@link retiredSinceOf} 的键）。
 */
export function retiredSetOf(events: readonly PoolEvent[]): Set<string> {
  return new Set(retiredSinceOf(events).keys())
}


/**
 * **这个候选为什么是「永久」不可复用** —— 本层（`domain/pool.ts`）**唯一判定点**：池视图的
 * `permanent` 桶、退役事件的 `basis` / `reason`、以及 `index.ts` 的退役预告都读它（不各写一份）。
 *
 * 四类形状，两个方向（`TASK-228` 的判定表；判错的代价是不对称的 —— 误退役永久丢掉一个可能可用的
 * 会话，误不退役只是多记几行账，所以**判不准的一律不退役**）：
 *
 *   · **口径不可比 ⇒ 永久**：该会话记下的掩码指纹**没有版本号**（`TASK-208` 之前的口径），或压根没有
 *     指纹 ⇒ 与今天的现算值**不可比**，而指纹在会话创建时定死 ⇒ 它不会再变得可比
 *     （回溯能证成「面没变过」的那一档不算永久，见下）；
 *   · **宿主不可达 ⇒ 永久**：跨父会话（宿主只允许父会话复用自己起的子代理）—— 这一条**只对观察到
 *     的那个父会话成立**，所以观察者身份由调用方给（不给 ⇒ 不判，宁可留账）；
 *   · **有在飞卡 ⇒ 临时**：卡结算之后这个会话就又能用了（`idle` 都还不是，见第一行）；
 *   · **投递失败 ⇒ 临时**：宿主这一次拒了不代表下一次也拒（`DEF-185` 的真机形状里它就是"下一轮再试"）。
 *
 * ⚠️ **刻意不退役的第三档**：指纹同版本但**与当前值不等**（`maskBlockedReason` 的
 * 「掩码已变更（该会话的工具面是创建时的旧面）」）—— 角色面**改回去**它就会重新可比，属可逆 ⇒
 * 不按永久处理。这一档的真账读数（本轮现算 25 条）在回报的判定表里单列。
 */
export interface PermanentUnreusable {
  /** 机器可读的永久性分类（进事件的 `basis`；只这两种，别在这里加第三类而不改判定表） */
  basis: 'mask-not-comparable' | 'host-unreachable'
  /** 人读原话（进事件的 `reason` 与回执；与 `unusable.reason` 同一形态） */
  reason: string
}

export function permanentUnreusableReason(
  child: PoolChild,
  options: {
    /**
     * **观察者（本侧父会话）**：只有它知道"跨父会话"是不是真的不可达（`DEF-066`）。
     * 不给 = 不做这一层判定（不判 ≠ 可复用，只是**不在这里退役**）。
     */
    viewerSessionId?: string | undefined
  } = {},
): PermanentUnreusable | undefined {
  // ① 有在飞卡 ⇒ 临时（连 `idle` 都不是：这一档压根没资格被讨论）
  if (child.state !== 'idle') return undefined
  // ② 投递失败 ⇒ 临时：宿主原话在 `deliveryFailedReason`，下一轮该再试
  if ((child.deliveryFailedReason ?? '') !== '') return undefined
  // ③ 口径不可比 ⇒ 永久
  const actual = child.maskHash ?? ''
  if (actual === '') {
    return { basis: 'mask-not-comparable', reason: '旧子代理没有掩码指纹（旧口径没有版本号 ⇒ 与今天的现算值不可比）' }
  }
  if (maskHashVersion(actual) !== MASK_FINGERPRINT_VERSION) {
    const backtrack = maskBacktrack(child.role, { sdoAllow: child.sdoAllow, deny: child.deny })
    // 回溯**能证成**「面没变过」⇒ 还可复用 ⇒ 不退役（否则会把 `DEF-194` 反对的那种整池作废做回去）
    if (backtrack.reusable) return undefined
    return {
      basis: 'mask-not-comparable',
      reason: `掩码口径不可比（旧口径指纹没有版本号，且回溯判不了：${backtrack.detail}）`,
    }
  }
  // ④ 宿主不可达 ⇒ 永久（只对调用方给的那一侧成立，见 `options.viewerSessionId`）
  const viewer = options.viewerSessionId ?? ''
  const parent = child.parentSessionId ?? ''
  if (viewer !== '' && parent !== '' && parent !== viewer) {
    return {
      basis: 'host-unreachable',
      reason: `跨父会话（宿主只允许父会话复用自己起的子代理；观察者 ${viewer.slice(0, 8)} 投不进去）`,
    }
  }
  return undefined
}

/**
 * **池视图里与「退役」有关的两桶**（`TASK-228`）。
 *
 * 为什么单独一个接口（而不是直接写进 {@link RolePool} 的字段区）：本仓 `m249` 把 `pool.ts` 里
 * `liveDispatchReading` 注释的某一行**按行号**钉住（那份守卫不在本卡的写范围，改不了），
 * 把新字段塞进上半段会让那一行的行号漂移 ⇒ 判据当场红。接口合并（`extends`）是**同一份类型面**
 * 的等价写法：`RolePool` 仍然带这两桶，读侧一个字都不用改。
 */
export interface RetiredBuckets {
  /**
   * `unusable` 里被判成**永久**不可复用的那部分（`TASK-228`；判据是
   * {@link permanentUnreusableReason}，**本层唯一判定点**，见 {@link permanentCandidatesOf}）。
   *
   * 它们是**下一批退役对象**：`index.ts` 在真派发那一轮把它们一次性落成 `pool/retired`（分片写入），
   * 此后 `foldPoolChildren` **先减退役集** ⇒ 它们根本不再进池 —— 于是这一桶在退役之后变成空，
   * 而它们出现在台账的退役事件里（读数那一侧由 {@link poolTriageRows} 补回来）。
   */
  permanent: { childSessionId: string; reason: string; basis: string }[]
}

/**
 * 把「过不了闸门」的那批孩子里**永久**不可复用的挑出来（`rolePools` 的 `permanent` 桶）。
 *
 * 三条口径：
 *   ① **只在这批里判**：调用方交进来的已经是"过不了闸门"的那批（候选池 `unusable`），
 *      一个过得了闸门的孩子不参与讨论（否则"可复用"与"永久不可用"会同时成立）；
 *   ② **判据只有一处**：`permanentUnreusableReason`（本层唯一判定点）—— 本函数只做投影，
 *      不重新分类（两处各判一遍必然分叉，`R-6` 的教训）；
 *   ③ **不编造**：`basis` / `reason` 一律来自那个判定，缺什么就留空（空串 = 老事件没写这一格）。
 */
export function permanentCandidatesOf(
  children: Iterable<PoolChild>,
  viewerSessionId?: string | undefined,
): { childSessionId: string; reason: string; basis: string }[] {
  const out: { childSessionId: string; reason: string; basis: string }[] = []
  for (const child of children) {
    const verdict = permanentUnreusableReason(child, { viewerSessionId: viewerSessionId ?? '' })
    if (verdict === undefined) continue
    out.push({ childSessionId: child.childSessionId, reason: verdict.reason, basis: verdict.basis })
  }
  return out
}

/* ——————————————— 池摘要的**三分**（`TASK-228` 落点三） ——————————————— */

/**
 * 一个角色池的**三分读数**：`reusable / temp-unusable / retired`（三者相加 = `total`，恒等式由构造给出）。
 *
 * 为什么要三分而不只是"空闲几个"：`TASK-228` 的真账读数里"空闲可复用"是 0，而"为什么没复用"那一栏
 * 有 3149 条**永久**不可复用的候选 + 25 条可逆的 + 4 条临时不可达 —— 一个桶装不下三种东西，
 * 读数就会被**永久**那一档淹没（读者以为"再等等就好了"，其实那批等不来）。
 *
 * 三档的边界（写死在这里，别处不再各解一遍）：
 *   · `reusable`：`idle`（过完闸门、本会话真能投的那批）；
 *   · `tempUnusable`：`unusable` 里**不是永久**的那部分（持卡 / 投递失败 / 可逆的口径变化 / 没有观测证据）；
 *   · `retired`：**永久**不可复用的 —— 台账里**已退役**的那批 ＋ 本轮已判成永久、还没落盘的那批
 *     `permanent`。退役那个动作**不改变**这个数（左边进右边出）—— 于是同一份台账在退役前后读到
 *     同一个 `retired`，读者不会以为"退役把候选藏起来了"。
 */
export interface PoolTriage {
  role: string
  reusable: number
  tempUnusable: number
  retired: number
  /** `reusable + tempUnusable + retired`（= `idle + unusable + retiredOfRole`，算式见 {@link poolTriage}） */
  total: number
}

/**
 * 算一个角色池的三分读数（纯函数）。
 *
 * 算式（`permanent` 是 `unusable` 的子集，所以两条加起来才不重复）：
 *   `reusable = idle`；`tempUnusable = unusable − permanent`；
 *   `retired = retiredOfRole + permanent`；`total = reusable + tempUnusable + retired`。
 * 展开即 `idle + unusable + retiredOfRole` —— 与"退役前后 `retired` 不变"是同一条恒等式的两面。
 *
 * @param retiredOfRole 该角色**已退役**的候选数（台账口径的那一份：{@link retiredCandidatesOf}）。
 *   缺省 `0` = 不把已退役那批算进来（只读单池时用）；逐角色出读数请走 {@link poolTriageRows}。
 */
export function poolTriage(pool: RolePool, retiredOfRole = 0): PoolTriage {
  const reusable = pool.idle.length
  const tempUnusable = pool.unusable.length - pool.permanent.length
  const retired = retiredOfRole + pool.permanent.length
  return { role: pool.role, reusable, tempUnusable, retired, total: reusable + tempUnusable + retired }
}

/**
 * **逐角色的三分读数**（回执/诊断入口）：把"已退役"那一桶也算进角色清单里。
 *
 * 为什么要单独一个入口而不是让调用方自己 `map(poolTriage)`：退役之后那些候选**已经不在池里**
 * （`foldPoolChildren` 先减退役集），所以一个"候选全被退役"的角色可能连池条目都没有 ——
 * 只按池条目出读数，那一批就会**凭空消失**（读者看到的 `total=0` 与台账里的 3149 条对不上）。
 *
 * @param input.retired **权威退役清单**（{@link retiredCandidatesOf} 的结果）。给了就用它算每个角色的
 *   退役数，并补出"只有退役候选、没有池条目"的角色；不给 = 只按池自身的 `permanent` 出读数。
 */
export function poolTriageRows(input: {
  pools: readonly RolePool[]
  retired?: readonly RetiredCandidate[] | undefined
}): PoolTriage[] {
  const counts = new Map<string, number>()
  for (const row of input.retired ?? []) counts.set(row.role, (counts.get(row.role) ?? 0) + 1)
  const rows = input.pools.map((pool) => poolTriage(pool, counts.get(pool.role) ?? 0))
  const known = new Set(input.pools.map((pool) => pool.role))
  const extra = [...counts.entries()]
    .filter(([role, count]) => role !== '' && count > 0 && !known.has(role))
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([role, count]) => ({ role, reusable: 0, tempUnusable: 0, retired: count, total: count }))
  return [...rows, ...extra]
}

/**
 * **本轮的三分读数**（回执入口；`TASK-228` 返工后 `index.ts` 只调这一个）：把三份读数**同源化**。
 *
 * 为什么需要这一层（`REV-116` 必核四② / 必核一②）：一份回执里，"本轮待退役的候选"来自准入快照
 * （`plan.pools[*].permanent`），而"已退役"来自台账（`retiredCandidatesOf`）。两份读数**不是同一次
 * 读**（快照先读、台账后读）⇒ 若两次之间落了别的 `pool/retired`，同一候选会同时出现在两边，
 * `poolTriage` 就会把它**算两遍**（`retired` 多 1、`tempUnusable` 也不会少 → 恒等式仍然"成立"却
 * 与事实不符），并且它还会被**再退役一次**。
 *
 * 口径（写死在这里，回执不再各解一遍）：
 *   · **退役集是权威**：本块读到的 `retired` 是最新的一份，快照里仍在 `permanent` 的那些（已经被
 *     退役过）从 `permanent` 桶里**剔掉**，并且**同时**从 `unusable` 桶里剔掉 —— 否则
 *     `tempUnusable = unusable − permanent`（{@link poolTriage} 的算式）会把它改判成"临时不可用"，
 *     读数就从"双计"变成"错桶"，而恒等式照样成立（那才是最坏的一种错）；
 *   · **本轮新退役的按已退役算**（`retiring`）：退役动作**不改变** `retired`/`total`（左边进右边出，
 *     这是三分的本意）⇒ 回执在退役前后读到同一个数；
 *   · **不重不漏**：一个 `childSessionId` 只会被数一次（`counted` 集合），`poolTriage` 的恒等式
 *     `reusable + tempUnusable + retired = total` 照旧成立。
 *
 * @param input.pools 准入快照里的池（`plan.pools`）
 * @param input.retired 台账口径的已退役清单（{@link retiredCandidatesOf}）
 * @param input.retiring 本轮刚落盘的退役行（{@link permanentCandidatesFromEvents} 的结果）
 */
export function poolTriageForRound(input: {
  pools: readonly RolePool[]
  retired?: readonly RetiredCandidate[] | undefined
  retiring?: readonly { childSessionId: string; role: string; reason: string; basis: string }[] | undefined
}): PoolTriage[] {
  const counted = new Set<string>()
  for (const row of input.retired ?? []) counted.add(row.childSessionId)
  for (const row of input.retiring ?? []) counted.add(row.childSessionId)
  const pools = input.pools.map((pool) => ({
    ...pool,
    unusable: pool.unusable.filter((row) => !counted.has(row.childSessionId)),
    permanent: pool.permanent.filter((row) => !counted.has(row.childSessionId)),
  }))
  const retired: RetiredCandidate[] = [
    ...(input.retired ?? []),
    // 本轮刚落盘的按"已退役"算：`at` 留空 —— 它只用于人读，不参与任何判据
    ...(input.retiring ?? []).map((row) => ({ ...row, at: '' })),
  ]
  return poolTriageRows({ pools, retired })
}

/**
 * 三分读数的一行投影（回执/诊断用）。**字段名用 ASCII**：与 {@link poolReadingLine} 同一理由
 * —— 本行会进回执，而语言包键不在本卡写范围内。
 */
export function poolTriageLine(triage: PoolTriage): string {
  return `pool-triage: role=${triage.role} reusable=${triage.reusable}`
    + ` temp-unusable=${triage.tempUnusable} retired=${triage.retired} total=${triage.total}`
}

/* —————————————————— ③ 派发决定的收口（`TASK-231` 落点一 / 落点三） —————————————————— */

/** 一笔派发决定的**收口**。`pending` = 悬空（决定了却既没 started 也没 failed）。 */
export type DispatchDecisionClosure = 'started' | 'failed' | 'inline' | 'pending'

/**
 * 缺省收口窗口（秒）：`dispatch/decided` 之后多久仍无 `started` / `failed` 就判红。
 *
 * **这条窗口对谁有意义**（`REV-104` #7 纠正了原先的依据）：`TASK-231` 起派发路径改成
 * **先尝试、后落账**（`startDispatch` 返回之后才写 decided），所以**新账**上 decided 与 started 的
 * 间隔是毫秒级 —— 对新账它**恒绿**，这是写顺序的保证，不是窗口的功劳。
 * 它真正守的是两类**别的**形状：
 *   · **老形状**（decided 先写、started 后写，台账里 204 笔都是这个形状）；
 *   · **别的写者 / 半失败**：如 `REV-104` #2 那条 —— 决定写了 `outcome='started'`，但对应的
 *     `dispatch/started` 那次 append 没成。
 *
 * 300 秒是**给"慢宿主/慢磁盘"留的余量**（老形状的实测延迟中位数 3.3 秒、最大 36.6 秒），
 * 不是延迟判据本身：**它只判"没有收口"，不判"慢"**。
 */
export const DECIDED_SETTLE_SECONDS = 300

/** 一笔派发决定的收口读数（`TASK-231` 落点三的判据面）。 */
export interface DispatchDecisionRow {
  /** `dispatch/decided` 的序号（可复算锚点） */
  seq: number
  at: string
  taskId: string
  backend: string
  /** 决定里声明的**角色面**（不是可定位身份 —— 身份要等派发之后才知道） */
  owner: string
  /** 行上自带的收口（新口径写进同一笔事件）；老台账没有这个字段 ⇒ `undefined` */
  outcome: 'started' | 'failed' | 'inline' | undefined
  /** `failed` 收口的原因原话（只有 `failed` 才有） */
  failureReason: string
  /** 现算的收口（老台账靠"后来有没有 `started`"兜底） */
  closure: DispatchDecisionClosure
  /** 若收口是 `started`：那一笔的序号 */
  startedSeq: number | undefined
  /**
   * 悬空时**为什么**悬空（只对 `closure === 'pending'` 有值）：
   *   · `started-event-missing` —— 决定上写着 `outcome='started'`，但台账里**没有**对应的
   *     `dispatch/started`（`REV-104` #2：两次独立 append，第二笔失败时两个守卫都会放过它）；
   *   · `no-closure` —— 老形状：既没有 `outcome`，也没有等到 `started`。
   */
  pendingReason: 'started-event-missing' | 'no-closure' | undefined
  /** 距"现在"多少秒；`at` 读不出 ⇒ `-1`（**判不了**，见 {@link danglingDecisions}） */
  ageSeconds: number
}

/**
 * 折叠出**每一笔派发决定**的收口状态（`TASK-231` 落点一 / 落点三的唯一出口）。
 *
 * 收口的两条来源：
 *   ① 同一笔 `dispatch/decided` 上的 `outcome`：`failed` / `inline` **直接收口**（写顺序保证
 *      "先尝试、后落账"⇒ 这两态没有悬空窗口，崩溃在尝试期间连 decided 都不会有）；
 *   ② **`started` 这一态不由 `outcome` 一句话说了算**：它必须由**台账事件背书** ——
 *      看同一张卡之后有没有 `dispatch/started`（有 ⇒ `started` 并记下它的序号）。找不到就照
 *      `pending` 处理，并点名 `pendingReason='started-event-missing'`。
 *      为什么：decided 与 started 是**两次独立 append**，第二笔写失败时台账会留下
 *      「决定说起来了、started 事件没有」—— 修前那一版无条件采信 `outcome='started'`，
 *      于是悬空守卫（看 `closure`）与容量守卫（看 `live`）**都会放过它**（`REV-104` #2）。
 *   ③ 老台账没有 `outcome`（`TASK-231` 之前的 204 笔）⇒ 走与 ② **同一条**向后扫的路径；
 *      若先又出现一笔新的 `decided` ⇒ 前一笔判 **`pending`**，不会被后一笔的 started 洗白。
 *
 * 老 `inline` 决定（降级就地执行）**天然没有** started ⇒ 按 `inline` 收口（它的收口就在回执里）。
 *
 * ⚠️ 措辞纪律（`REV-105` #1）：`failed` 侧由**写顺序**保证，`started` 侧由**事件核对**保证 ——
 * 两侧的保证方式不同，所以这句话的正确写法就是上面 ①② 那两句，**不要**把它们合并成一句
 * 「决定与收口同生同死，悬空在结构上不可能」这种强断言（**这是 `REV-104` #2 当时被推翻的原话**，
 * 逐字见台账 seq 8467 / `REV-105` #1 / `TASK-231-decided-closure.md:308`；不是本注释自造的措辞）。
 * 改声明时先 `grep` **全部出现处**，不是改记得的那一处。
 */
export function dispatchDecisionRows(
  events: readonly DispatchLedgerEvent[],
  options: { nowMs?: number | undefined } = {},
): DispatchDecisionRow[] {
  const now = options.nowMs ?? Date.now()
  const rows: DispatchDecisionRow[] = []
  for (const [index, event] of events.entries()) {
    if (event.type !== 'dispatch/decided') continue
    const seq = event.seq ?? index
    const taskId = text(event.data['task'])
    const backend = text(event.data['backend'])
    const raw = text(event.data['outcome'])
    const outcome = raw === 'started' || raw === 'failed' || raw === 'inline' ? raw : undefined
    const at = event.at ?? ''
    const parsed = Date.parse(at)
    const ageSeconds = Number.isFinite(parsed) ? Math.max(0, Math.round((now - parsed) / 1000)) : -1
    /**
     * 收口判定（`REV-104` #2 之后）：**`started` 这一态也必须由台账事件背书**。
     *
     * 修前只有"老形状"才去找 `dispatch/started`；`outcome='started'` 被**无条件信任** ——
     * 而 decided 与 started 是**两次独立 append**，第二笔失败时台账就长成「决定说起来了、
     * started 事件没有」，悬空守卫（看 `closure`）与容量守卫（看 `live`）**都会放过它**。
     * 现在两侧同判：`started` 只认"真的有一笔 `dispatch/started`"。
     */
    let closure: DispatchDecisionClosure = 'pending'
    let startedSeq: number | undefined
    let pendingReason: 'started-event-missing' | 'no-closure' | undefined
    if (outcome === 'failed' || outcome === 'inline') {
      closure = outcome
    } else if (outcome === undefined && backend === 'inline') {
      // 老台账里的 inline 决定（降级就地执行）：天然没有子会话可起，收口就在回执里
      closure = 'inline'
    } else {
      // 只看"下一笔同卡的 dispatch 事件"：出现新的 decided 就说明这一笔被**覆盖**了，不许被它洗白
      for (let cursor = index + 1; cursor < events.length; cursor += 1) {
        const later = events[cursor]
        if (later === undefined) break
        if (text(later.data['task']) !== taskId) continue
        if (later.type === 'dispatch/started') {
          closure = 'started'
          startedSeq = later.seq ?? cursor
          break
        }
        if (later.type === 'dispatch/decided') break
      }
      if (closure === 'pending') pendingReason = outcome === 'started' ? 'started-event-missing' : 'no-closure'
    }
    rows.push({
      seq, at, taskId, backend, owner: text(event.data['owner']),
      outcome, failureReason: text(event.data['failureReason']), closure, startedSeq, pendingReason, ageSeconds,
    })
  }
  return rows
}

/**
 * **悬空的派发决定**（`TASK-231` 落点三的守卫）：收口是 `pending` 且已过 {@link DECIDED_SETTLE_SECONDS}。
 *
 * 判据刻意**保守**：`at` 读不出（`ageSeconds < 0`）时直接算悬空 —— "判不了年龄"不等于"它没问题"。
 * 返回的每一行都点名**卡**（`taskId`）、**决定锚点**（`seq`）与**声明的角色面**（`owner`），
 * 于是"决定了却没发生"这件事不可能再静默躺着（`DEF-214` 的第 ⑶ 层危害）。
 */
export function danglingDecisions(
  events: readonly DispatchLedgerEvent[],
  options: { nowMs?: number | undefined; settleSeconds?: number | undefined } = {},
): DispatchDecisionRow[] {
  const settle = options.settleSeconds ?? DECIDED_SETTLE_SECONDS
  return dispatchDecisionRows(events, options)
    .filter((row) => row.closure === 'pending' && (row.ageSeconds < 0 || row.ageSeconds >= settle))
}

/**
 * 「悬空决定」的一行投影（回执/诊断用）。**字段名用 ASCII**：理由与 {@link poolReadingLine} 同
 * （语言包键不在本卡写范围，且这一行是给复验者的读数）。
 */
export function danglingDecisionLine(row: DispatchDecisionRow): string {
  const reason = row.closure !== 'pending'
    ? '-'
    : row.pendingReason === 'started-event-missing'
      // 决定写着 started，但台账里没有那一笔 —— 比"什么都没发生"更需要人看（`REV-104` #2）
      ? 'outcome=started-but-no-dispatch-started'
      : 'no-dispatch-started-and-no-dispatch-failed'
  return `dangling-decided: task=${row.taskId} decidedSeq=${String(row.seq)}`
    + ` owner=${row.owner === '' ? '-' : row.owner} at=${row.at === '' ? '-' : row.at}`
    + ` ageSeconds=${String(row.ageSeconds)} closure=${row.closure}`
    + ` reason=${reason}`
}

/**
 * 回执里**逐行点名**的悬空决定上限（`TASK-231` 返工：进回执预算）。
 *
 * 为什么是 3：这一行是**判红的点名**，一条就足以让人去修；3 条能看出"是不是同一批卡"，
 * 再多的边际信息远小于它吃掉的预算（一条约 150 字符，10 张悬空卡就是 1500 —— 足以把
 * `TASK-218` 建立的 7000 预算与宿主 8000 上限顶穿）。**全量清单不丢**：折叠行给出总数与卡#锚点，
 * 逐条读数走 `dispatchDecisionHealth`（一次性列表，不在回执预算里）。
 */
export const DANGLING_LINES_SHOWN = 3

/**
 * 悬空决定的**有界**逐行投影：前 {@link DANGLING_LINES_SHOWN} 条 + 一条折叠计数行。
 *
 * 计数行同样是 ASCII 投影（与逐行同一口径），带 `+N more` 与卡#锚点 ——
 * 于是"判红不静默"与"回执体积有界"不再冲突（修前它俩在 `TASK-218` 那场官司里是对立的两头：
 * 体积压到 8000 以内，而新读数若无条件追加就会把它顶回去）。
 */
export function danglingDecisionLines(
  rows: readonly DispatchDecisionRow[],
  max = DANGLING_LINES_SHOWN,
): string[] {
  if (rows.length === 0) return []
  const shown = rows.slice(0, Math.max(0, max)).map((row) => danglingDecisionLine(row))
  const rest = rows.length - shown.length
  if (rest <= 0) return shown
  const folded = rows.slice(shown.length).map((row) => `${row.taskId}#${String(row.seq)}`)
  return [
    ...shown,
    `dangling-decided: +${String(rest)} more (${folded.slice(0, 10).join(' ')}${folded.length > 10 ? ' …' : ''}; full list: dispatchDecisionHealth)`,
  ]
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
  /**
   * 本轮可派的卡；`reuseChildId` 给了就是「投给这个**已有**子代理」（真复用），没给就是新起一个。
   *
   * `reuseCandidates`（`TASK-208` 落点一）：**有序候选队列**，`reuseChildId` 是它的第 0 项。
   * 修前的形状是"只取一个候选"——`find()` 出来的那一个投递失败就整轮降级新起，
   * 于是同一个投不进去的候选每轮都被挑中、每轮都新起（`DEF-185`，真机 `b5e60eac` 连撞三次）。
   * 投递层（`startDispatch`）按这个顺序**逐条试**：成功即采用，失败逐条留痕，全部失败才新起。
   */
  dispatch: { task: TaskCard; reuseChildId?: string | undefined; reuseCandidates?: string[] | undefined }[]
  /**
   * **本次准入把哪个空闲会话分配给了哪张卡**（`TASK-245` / `DEF-229`）—— **计划面，不是在飞**。
   *
   * 为什么必须单独一个结构（而不是写进 `RolePool.busy`）：准入发生在**派发之前**，而真正"起来了"
   * 只有一笔 `dispatch/started` 才算数。旧实现（修前 `pool.busy.push({ ...taken, state: 'busy',
   * task: task.id })`）把这张**计划**写成 busy，于是「准入通过、但本轮没派」的卡会以「在飞」形态
   * 印在回执的角色池段 —— 被 `limit=N` 截掉时它在台账里**零** `dispatch/started`（`DEF-229` 的真机
   * 形状：一次 `next limit=1` 印出 3 行「在飞定位」，其中 2 张从未派发）。
   *
   * 同函数 15 行之下的 **R-5A** 已经为**新起支**修过同一种病（原话：「在飞」是事实，「本次准入 N 张」
   * 是计划，两者必须分开讲）—— 本字段是把那条规则**补齐到复用支**，不另立第三套口径：
   *   · **事实** = `RolePool.busy`（只由 `dispatch/started` 折叠出来）；
   *   · **计划** = `dispatch`（谁上）与 `reuseAdmissions`（哪张卡拿走了哪个空闲会话）。
   *
   * 渲染层要显示「本轮准入的复用分配」时**读这个结构**，并**明确标注它不是「在飞」**；
   * 谁也不许拿它去增删 `busy`（`DEF-229` 的回归守卫是 `test/m250.test.ts` 的 M250-13/14/15）。
   */
  reuseAdmissions: { task: string; childSessionId: string; role: string }[]
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
  /**
   * **本次准入的复用分配**（计划面，`TASK-245` / `DEF-229`）：谁把哪个空闲会话拿走了。
   *
   * 它**不进** `pool.busy` —— 那里只放由 `dispatch/started` 折叠出来的事实（见字段注释）。
   */
  const reuseAdmissions: PoolAdmission['reuseAdmissions'] = []
  /** 每个角色**本次准入新建**了几张（R-5A：`在飞` 只报真实在飞，新建数另说，不再塞占位孩子） */
  const admittedByRole = new Map<string, number>()
  /** 每个角色**本次准入复用**了几张（`TASK-245`：与上面同一口径 —— 计划数只进回执文案，不进 `busy`） */
  const reusedByRole = new Map<string, number>()
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
        permanent: [],
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
      /**
       * **`TASK-208` 落点一（修 `DEF-185`）：候选不再是"一个"，而是一条有序队列。**
       *
       * 修前：`reuseCandidateOrder(pool).find(...)` ⇒ **只取第 1 个过闸门的候选**；投递失败（宿主
       * `sendMessage` 抛 `is unavailable`）⇒ `startDispatch` 直接降级新起，**第 2..N 个候选一次都没试过**。
       * 真机后果（seq 5251 / 5277 / 5299）：同一个投不进去的 `b5e60eac` 连续三轮被挑中、三轮 unavailable、
       * 三轮新起，而池里另外 76 个空闲会话从未被投递过一次。
       *
       * 现在：过闸门的候选**按同一顺序整条交给投递层**（`reuseCandidates`），由它逐条试、成功即采用。
       * 准入这边仍然只占**一个位子**（`room -= 1` / 从 `idle` 摘一个）——"试几个"是投递层的事，
       * "这一张卡占几个位子"始终是 1。
       */
      const deliverable = reuseCandidateOrder(pool).filter((child) => blockedReasonOf(child) === undefined)
      const taken = deliverable[0]
      if (taken !== undefined) {
        const index = pool.idle.findIndex((child) => child.childSessionId === taken.childSessionId)
        if (index >= 0) pool.idle.splice(index, 1)
        /**
         * **`TASK-245`（`DEF-229`）：这里**不再**往 `pool.busy` 里塞这一行。**
         *
         * 修前的形状是 `pool.busy.push({ ...taken, state: 'busy', task: task.id })` —— 把一张**已空闲**
         * 的会话连同**本张卡**的 id 一起写成"在飞"。这一步发生在**准入**时刻，而 `dispatch/started`
         * 是准入之后才写的（且完全可能不写：被 `limit=N` 挡下、或被容量挤进 `queued`）⇒ 于是
         * 「准入成功但本轮没派」的卡会以「在飞」形态印出来，台账里**零** `dispatch/started`
         * （真机一次 `next limit=1` 印 3 行「在飞定位」，其中 2 张从未派发）。
         *
         * 这正是上面 **R-5A** 为新起支修过的同一种病（「在飞」是事实，「本次准入 N 张」是计划），
         * 修前只修了新起那一支 —— 本行是把那条规则**补齐到复用支**，不另立第三套口径：
         * 计划进 `reuseAdmissions`，事实只由 `busy`（折叠 `dispatch/started`）说。
         *
         * 连带的同源症状也一并消失：`busy` 里那一行是**准入时的快照**（`{ ...taken }` 的 `rounds` /
         * `cards` 不含本轮），回执的角色池段因此会比同一份回执的复用依据行**差一轮**
         * （真机：池段印「第 9 轮/8 张」而复用依据行印「第 10 轮、已承接 9 张」）。
         */
        reuseAdmissions.push({ task: task.id, childSessionId: taken.childSessionId, role: pool.role })
        reusedByRole.set(pool.role, (reusedByRole.get(pool.role) ?? 0) + 1)
        dispatch.push({
          task,
          reuseChildId: taken.childSessionId,
          reuseCandidates: deliverable.map((child) => child.childSessionId),
        })
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
    const reusedNow = reusedByRole.get(pool.role) ?? 0
    /**
     * **容量读数与被占用的位子分开讲**（`TASK-245` / `DEF-229`；同一句纪律见 R-5A）。
     *
     * 修前这一句印的是「池满（在飞 4/4）」—— 那个 4 里混着"本次准入"的**计划**。现在：
     *   · **位子** = `cap − freeSlots`：准入循环自己维护的那份容量账（复用支从 `idle` 摘一个、
     *     新起支 `freeSlots -= 1`），于是"还剩几个位子"与"这轮准入用掉几个"可以同时成立；
     *   · **在飞** = `busy.length`：只数台账里真的有一笔 `dispatch/started` 的（事实）；
     *   · **本次已先准入 N 张** = 计划（复用 / 新建分开报，别混成一句）。
     * 三者分开之后，「在飞 0/3 却池满」不再是自相矛盾，而是"这一轮的位子已经许出去了"。
     */
    const seats = Math.max(0, pool.cap - pool.freeSlots)
    const admittedText = reusedNow === 0
      ? `${admittedNow} 张新建`
      : admittedNow === 0
        ? `${reusedNow} 张复用`
        : `${reusedNow + admittedNow} 张（复用 ${reusedNow} / 新建 ${admittedNow}）`
    const forced = input.forceNew === true && pool.idle.length > 0
      ? `，本轮 freshChild=true（强制新起）⇒ 池内 ${pool.idle.length} 个空闲可复用会话**不参与容量计算**`
      : ''
    blocked.push({
      task,
      reason: 'pool-full',
      detail: `${pool.role} 池满（位子 ${seats}/${pool.cap}：在飞 ${pool.busy.length}${reusedNow + admittedNow > 0 ? ` + 本次已先准入 ${admittedText}` : ''}${pool.idle.length > 0 ? `，空闲可复用 ${pool.idle.length}` : ''}${forced}）`,
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
  return {
    reuseIdle: input.reuseIdle,
    forceNew: input.forceNew === true,
    dispatch,
    // **`TASK-245`**：计划面的复用分配（`pools` 的 `busy` 里一格都不许有它 —— 那里只放折叠事实）
    reuseAdmissions,
    reuseSkipped: dedupedSkipped,
    queued,
    blocked,
    pools,
  }
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
 * 未复用候选的列示档位（`DEF-175` 落点一；与 `interface/describe.ts` 的 {@link ReadoutOptions} 同口径）。
 *
 * `verbose: true` 才**逐条**展开；缺省档走**按原因归并**（见 {@link reuseSkippedLines}）。
 */
export interface ReuseSkipOptions {
  /** `true` = 每个候选一行（人手排查用，一字不少）；缺省 = 按原因原话归并的有界汇总。 */
  verbose?: boolean | undefined
}

/**
 * 一组原因里最多点几个子会话（列**前 8 位**：与回执里其余 `childSessionId` 的写法同口径 ——
 * `describe.ts` 的 `POOL_UNUSABLE_IDS_PER_REASON`、`ownerOf` 的会话段、在飞定位全是前 8 位，
 * "定位够用"这一点由那几处先例定过；**完整** uuid 走 `verbose` 档，一字不少）。
 *
 * 为什么不在这里列完整 uuid：`TASK-218` 实测三组 × 3 条完整 uuid = 324 字符，而回执的其余
 * 每一处都只用前 8 位 —— 同一份回执里两种口径并存本身就是新的不一致，且这 200+ 字符
 * 正是把派发结论顶出 8000 的那部分。反查能力不减：前 8 位在台账里是唯一的定位前缀。
 */
export const REUSE_SKIP_IDS_PER_REASON = 3

/**
 * 原因原话的**硬上限**（字符）：只防「宿主原话无界」这一种极端，归并才是主要手段。
 *
 * 定 200 的依据与 `describe.ts` 的 `POOL_UNUSABLE_REASON_CHARS` 同源（现盘最长的原因原话 168 字符：
 * 掩码回溯判不了时点名缺哪几条禁令）—— 上限必须**大于真实形状**，否则默认档会把"缺哪几条禁令"
 * 这句最有价值的话切掉。
 */
export const REUSE_SKIP_REASON_CHARS = 200

/**
 * 缺省档**整块**的字符预算（所有原因分组之和）。与 `describe.ts` 的 `POOL_UNUSABLE_CHARS` 同一手法：
 * 按原因出现顺序累加到预算为止 ⇒ 常见形状（几种原因、每种一句原话）一定全部印全，只有"又多又长"时才折叠，
 * 且折叠时明写「还有 K 种原因没展开」（**种数**必须说出来 —— 读者至少知道"原因被折叠了"这件事）。
 */
export const REUSE_SKIP_CHARS = 700

/** 折叠时的**指路**（ASCII）：被折叠原因的原话在台账里逐条写着 —— 回执不教读者一个不存在的参数。 */
export const REUSE_SKIP_REASON_SOURCE = '.sdo/journal.jsonl dispatch/reuse-skipped'

/* ————————————————————————————————————————————————————————————————————————————————
 * **`TASK-224` / `DEF-210`：`dispatch/reuse-skipped` 从"一行一个候选"改成"一行一个原因"**
 *
 * 病根（真账两时点并列，读者能看到它在长）：卡面量的时候 **608 条事件里 495 条**是它（81%，1 种原因、
 * 86 个子会话、6 次派发、平均 82 条/派发）；本轮再量已经是 **7795 条 / 1938 条（24.9%）/ 944KB / 5 种原因**
 * —— 噪音不但没停，还**开始衍生变体**（同一种原因因 deny 面尾部差一个词而分成 985 + 923 两条）。
 *
 * 两次写入的差别是"O(候选数) → O(原因种数)"：一次派发只落**一条**，`reasons[]` 里每个原因带
 * `count` 与 `sampleChildIds ≤3`；与**上一次**派发"原因集 + 各自 count 全等"时只落一条
 * `{ task, sameAsSeq, candidates }` 引用（读者靠 seq 回溯到完整原话）。
 *
 * 三条纪律：
 *   ① **不丢原因**：聚合的是数量，原话一条不少（与回执 `reuseSkippedLines` 的归并同一口径）；
 *   ② **老事件不改写**：真源 append-only，读侧两种形状都认（{@link reuseSkippedRowsFromEvents}）；
 *   ③ **`sameAsSeq` 判得比"原因集相同"更严**：数量变了（86→12）说明现场变了，引用旧读数会把
 *      "这次跳过了几个"读错 —— 所以 `count` 也必须全等。
 * ———————————————————————————————————————————————————————————————————————————————— */

/** 聚合计划：**一次派发只产出 1 条事件**（`reasons[]` 承载全部原因）。 */
export interface ReuseSkippedPlan {
  /** 直接交给 `journal.append(REUSE_SKIPPED_EVENT, event)` 的数据面（恒为 1 条） */
  events: Record<string, unknown>[]
  /** 这次是"引用上一次"而不是完整形态时，被引用的 seq */
  sameAsSeq?: number
  /** 候选总数（= `reasons[].count` 之和，或引用形态里的 `candidates`） */
  candidates: number
  /** 不同原因原话的种数（软阈值：> 3 时回执明说，**不硬砍**） */
  reasonCount: number
}

/**
 * 从台账里取**上一次** `dispatch/reuse-skipped` 的读数（给 `sameAsSeq` 的"全等"判据用）。
 *
 * 只看**尾部**同类事件的最后一条：聚合形态读它的 `reasons[]`；引用形态读它自己引用的那条
 * （递归 ≤4 层，找不到就返回 `undefined` ⇒ 本次一定写完整形态，绝不引用一个读不回来的 seq）。
 */
export function lastReuseSkippedReference(
  events: readonly { seq: number; type: string; data: Record<string, unknown> }[],
): ReuseSkippedReference | undefined {
  const bySeq = new Map(events.map((event) => [event.seq, event] as const))
  const reasonsOf = (data: Record<string, unknown>, depth = 0): { reason: string; count: number }[] | undefined => {
    const sameAs = data['sameAsSeq']
    if (typeof sameAs === 'number') {
      if (depth >= 4) return undefined
      const target = bySeq.get(sameAs)
      return target === undefined ? undefined : reasonsOf(target.data, depth + 1)
    }
    const reasons = data['reasons']
    if (!Array.isArray(reasons)) return undefined
    const out: { reason: string; count: number }[] = []
    for (const item of reasons) {
      const row = item as { reason?: unknown; count?: unknown }
      const reason = text(row.reason)
      const count = typeof row.count === 'number' && row.count > 0 ? row.count : 1
      out.push({ reason, count })
    }
    return out
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== REUSE_SKIPPED_EVENT) continue
    const reasons = reasonsOf(event.data)
    if (reasons === undefined) continue
    return { seq: event.seq, reasons }
  }
  return undefined
}

/** 上一次派发留下的"可被引用"的读数（`seq` + 原因集与各自 count）。 */
export interface ReuseSkippedReference {
  seq: number
  reasons: { reason: string; count: number }[]
}

/**
 * 把一次派发里被拒的候选**聚合成一条事件**（`TASK-224` 落点一）。
 *
 * `previous` 给定时：若本次"原因集 + 各自 count"与它**全等** ⇒ 产出 `{ task, sameAsSeq, candidates }`
 * （落点二）；只要多一种、少一种、或某种的 count 变了 ⇒ 回到完整形态（守卫 `M238-04` 钉住这条反例）。
 */
export function planReuseSkippedEvents(
  rows: readonly { childSessionId: string; role: string; reason: string }[],
  options: { task?: string | undefined; decidedAt?: string | undefined; previous?: ReuseSkippedReference | undefined } = {},
): ReuseSkippedPlan {
  const task = options.task
  const decidedAt = options.decidedAt ?? new Date().toISOString()
  const groups = new Map<string, { reason: string; count: number; sampleChildIds: string[]; roles: string[] }>()
  for (const row of rows) {
    const reason = text(row.reason)
    const group = groups.get(reason) ?? { reason, count: 0, sampleChildIds: [], roles: [] }
    group.count += 1
    // 样本最多 3 个（"谁被跳过"要能点名，但**不**随候选数线性膨胀）
    if (group.sampleChildIds.length < REUSE_SKIP_IDS_PER_REASON) group.sampleChildIds.push(row.childSessionId)
    const role = text(row.role)
    if (role !== '' && !group.roles.includes(role)) group.roles.push(role)
    groups.set(reason, group)
  }
  const reasons = [...groups.values()]
  const candidates = rows.length
  if (reasons.length === 0) return { events: [], candidates: 0, reasonCount: 0 }
  const previous = options.previous
  if (previous !== undefined && previous.reasons.length === reasons.length) {
    // **全等判据**：原因集 + 各自 count 都必须一致（顺序无关）
    const mine = new Map(reasons.map((group) => [group.reason, group.count]))
    const same = previous.reasons.every((row) => mine.get(row.reason) === row.count)
    if (same) {
      return {
        events: [{
          ...(task === undefined ? {} : { task }),
          sameAsSeq: previous.seq,
          candidates,
          decidedAt,
        }],
        sameAsSeq: previous.seq,
        candidates,
        reasonCount: reasons.length,
      }
    }
  }
  return {
    events: [{
      ...(task === undefined ? {} : { task }),
      candidates,
      reasons: reasons.map((group) => ({
        reason: group.reason,
        count: group.count,
        sampleChildIds: group.sampleChildIds,
        ...(group.roles.length === 0 ? {} : { roles: group.roles }),
      })),
      decidedAt,
    }],
    candidates,
    reasonCount: reasons.length,
  }
}

/**
 * **读侧展开**（`TASK-224`：两种形状都要能读，老事件不改写）。
 *
 * 认三种：① 老的"一行一个候选"（有 `childSessionId`）；② 新的聚合形态（`reasons[]`）；
 * ③ 引用形态（`sameAsSeq` ⇒ 回台账找那条，展开它的 `reasons[]`）。
 * 引用找不回（被轮转/截断）⇒ **返回空并如实标注**，绝不编造原因。
 */
export function reuseSkippedRowsFromEvents(
  events: readonly { seq: number; type: string; data: Record<string, unknown> }[],
): { rows: { childSessionId: string; role: string; reason: string }[]; unresolvedSameAs: number[] } {
  const bySeq = new Map(events.map((event) => [event.seq, event] as const))
  const expand = (data: Record<string, unknown>, depth = 0): { childSessionId: string; role: string; reason: string }[] => {
    const direct = text(data['childSessionId'])
    if (direct !== '') {
      return [{ childSessionId: direct, role: text(data['role']), reason: text(data['reason']) }]
    }
    const sameAs = data['sameAsSeq']
    if (typeof sameAs === 'number' && depth < 4) {
      const target = bySeq.get(sameAs)
      if (target !== undefined) return expand(target.data, depth + 1)
      return []
    }
    const reasons = data['reasons']
    if (!Array.isArray(reasons)) return []
    const out: { childSessionId: string; role: string; reason: string }[] = []
    for (const item of reasons) {
      const row = item as { reason?: unknown; count?: unknown; sampleChildIds?: unknown; roles?: unknown }
      const reason = text(row.reason)
      const count = typeof row.count === 'number' && row.count > 0 ? row.count : 1
      const samples = Array.isArray(row.sampleChildIds) ? row.sampleChildIds.map((id) => text(id)).filter((id) => id !== '') : []
      const role = Array.isArray(row.roles) && row.roles.length > 0 ? text(row.roles[0]) : ''
      // 展开成 count 行：`applyDeliverySkips` 按子会话逐个标记，所以要的是"每个候选一行"。
      // 样本之外的候选**没有 id**（聚合就是为此）⇒ 用 `sampleChildIds` 里已有的 id 兜底，绝不编 uuid。
      for (let index = 0; index < count; index += 1) {
        const id = samples[index] ?? samples[samples.length - 1] ?? ''
        if (id === '') break
        out.push({ childSessionId: id, role, reason })
      }
    }
    return out
  }
  const rows: { childSessionId: string; role: string; reason: string }[] = []
  const unresolvedSameAs: number[] = []
  for (const event of events) {
    if (event.type !== REUSE_SKIPPED_EVENT) continue
    const got = expand(event.data)
    if (got.length === 0 && typeof event.data['sameAsSeq'] === 'number') unresolvedSameAs.push(event.data['sameAsSeq'] as number)
    rows.push(...got)
  }
  return { rows, unresolvedSameAs }
}

/**
 * **最近一次派发写了多少条台账事件**（`TASK-224` 的"回退可被发现"读数）。
 *
 * 为什么必须有：修前是 82 条/派发，而**没有任何读数说这件事** ⇒ 同类回退无人能发现。
 * 口径：台账尾部同类事件按 `task` 分组，取**最后出现的那张卡**这一组。
 */
export function lastReuseSkippedWriteCount(
  events: readonly { seq: number; type: string; data: Record<string, unknown> }[],
): { task: string; events: number; bytes: number; candidates: number; sameAsSeq: number | undefined } | undefined {
  let lastTask = ''
  for (const event of events) {
    if (event.type !== REUSE_SKIPPED_EVENT) continue
    const task = text(event.data['task'])
    if (task !== '') lastTask = task
  }
  if (lastTask === '') return undefined
  let count = 0
  let bytes = 0
  let candidates = 0
  let sameAsSeq: number | undefined
  for (const event of events) {
    if (event.type !== REUSE_SKIPPED_EVENT) continue
    if (text(event.data['task']) !== lastTask) continue
    count += 1
    bytes += Buffer.byteLength(JSON.stringify(event.data)) + 1
    const many = event.data['candidates']
    if (typeof many === 'number') candidates += many
    const ref = event.data['sameAsSeq']
    if (typeof ref === 'number') sameAsSeq = ref
  }
  return { task: lastTask, events: count, bytes, candidates, sameAsSeq }
}


/**
 * 一个原因分组的理想形态：`原因原话×条数（样本 id … +其余）`，字段名沿用回执行的三个 ASCII 名。
 *
 * **单条分组保持修前的逐条字形**（`childSessionId=<完整 uuid> role=… reason=…`）：归并是
 * "同一句原因被抄 N 遍"的对策，**只有一条**的组没有可归并的东西 ⇒ 原样逐条、一字不改
 * （`DEF-139` 的逐条三字段语义因此对单条候选逐字保留，既有守卫 `M206-06`/`M206-10`/`M206-12`
 * 钉的就是这个形状）。多条分组才走 8 位前缀 + `×N`（与回执其余处的写法同口径）。
 */
function reuseSkipGroupLine(
  role: string,
  reason: string,
  ids: readonly string[],
): string {
  const why = reason.length > REUSE_SKIP_REASON_CHARS ? `${reason.slice(0, REUSE_SKIP_REASON_CHARS)}…` : reason
  if (ids.length === 1) return `childSessionId=${ids[0] ?? ''} role=${role} reason=${why}`
  const sample = ids.slice(0, REUSE_SKIP_IDS_PER_REASON).map((id) => id.slice(0, 8))
  const more = ids.length > sample.length ? ` +${String(ids.length - sample.length)}` : ''
  return `childSessionId=${sample.join(' ')}${more} role=${role} reason=${why}×${String(ids.length)}`
}

/**
 * **被闸门拒的空闲孩子**（`DEF-139` 落点二）：`childSessionId` / `role` / `reason` 三个字段一个都不许少。
 *
 * 为什么这三个字段必须留着：真机回执只印「有 12 个空闲子代理没有被复用」—— 那个数还是**笛卡尔积去重前**的
 * （`R-5B`），于是"为什么没复用"在回执上永远答不了；回执里以前也缺 `role` 这一列，
 * 而跨角色混在一起正是看不清的主因。
 *
 * **有界（`DEF-175` 落点一，`TASK-218`）**：修前是"一个候选一整行"，而历史子会话有上百个
 * （真账 80 条 ⇒ **17419 字符**、被宿主截到 8000，派发结论落在截断之外）。缺省档改成
 * **按（角色, 原因原话）归并**：一个分组一行、样本给前 {@link REUSE_SKIP_IDS_PER_REASON} 个、
 * 原因原话整句保留（只受 {@link REUSE_SKIP_REASON_CHARS} 硬上限约束）、整块受
 * {@link REUSE_SKIP_CHARS} 预算约束 ⇒ 文本长度与候选个数**脱钩**，只剩"原因种数"这一维
 *（`TASK-218` 实测真账 79 个候选只有 2 种原因 ⇒ 整块 665 字符，与候选个数无关）。
 * 砍的是**数量**，不是原因 —— 原因原话是这条读数今天最有价值的部分。
 *
 * 逐条清单仍然要得回来：走**函数级** `options.verbose`（那条路与修前逐字相同）。
 * ⚠️ **`verbose` 不是 `sdo_plan` 的参数**（工具面在 `src/interface/tools.ts`，它的参数表里没有这一项）
 * ⇒ 回执正文**不许**教读者去传它（`REV-093#2` 的教训）；被折叠时改指一条**真有的**出路：
 * 原话逐条躺在台账的 `dispatch/reuse-skipped` 事件里（{@link REUSE_SKIP_REASON_SOURCE}）。
 */
export function reuseSkippedLines(
  rows: readonly { childSessionId: string; role: string; reason: string }[],
  options: ReuseSkipOptions = {},
): string[] {
  if (rows.length === 0) return []
  if (options.verbose === true) {
    // 逐条档：与修前逐字相同（一个候选一行、三字段齐全、原因不截断）
    return rows.map((row) => `childSessionId=${row.childSessionId} role=${row.role} reason=${row.reason}`)
  }
  // 缺省档：按（角色, 原因）归并 —— 跨角色混在一组会让"是哪个角色被拒"重新看不见（`DEF-139` 的原病根）
  const groups = new Map<string, { role: string; reason: string; ids: string[] }>()
  for (const row of rows) {
    const key = `${row.role}\u0000${row.reason}`
    const group = groups.get(key) ?? { role: row.role, reason: row.reason, ids: [] }
    group.ids.push(row.childSessionId)
    groups.set(key, group)
  }
  const lines: string[] = []
  let spent = 0
  let index = 0
  const entries = [...groups.values()]
  for (; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined) break
    const line = reuseSkipGroupLine(entry.role, entry.reason, entry.ids)
    // 第一组**无条件印**：一组都不印，那块读数就等于没解释"为什么没复用"。
    if (lines.length > 0 && spent + line.length + 1 > REUSE_SKIP_CHARS) break
    lines.push(line)
    spent += line.length + 1
  }
  const folded = entries.slice(index)
  if (folded.length > 0) {
    // 折叠时**把被折叠的规模与种数都现算着说出来**（种数用 ASCII：语言包不在本卡写范围）
    const count = folded.reduce((sum, entry) => sum + entry.ids.length, 0)
    lines.push(`…[reasons-not-shown=${String(folded.length)} candidates-not-shown=${String(count)} (full text: ${REUSE_SKIP_REASON_SOURCE})]`)
  }
  return lines
}

/** 满池排队的人读说明（回执用；点名角色与上限，并指向"等谁结算"）。 */
export function poolBlockedReason(admission: PoolAdmission): string | undefined {
  if (admission.blocked.length === 0) return undefined
  const roles = [...new Set(admission.blocked.filter((item) => item.reason === 'pool-full').map((item) => item.task.role))]
  return roles.length > 0 ? roles.join(' / ') : 'global'
}
