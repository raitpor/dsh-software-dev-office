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
import type { TaskCard } from '../types.js'

/** 一轮派发（`dispatch/started` + 其结算）。 */
export interface PoolChild {
  childSessionId: string
  role: string
  /** 当前/最后一次承接的卡 */
  task: string
  /** 宿主给的模式；**老事件没有这个字段 ⇒ 按 one-shot 读**（保守：one-shot 不可复用） */
  mode: 'continuable' | 'one-shot'
  state: 'busy' | 'idle'
  /** 同一个子代理承接过的轮数（复用后 > 1；回执用它说明"这是第几轮"） */
  rounds: number
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
      children.set(id, {
        childSessionId: id,
        role: text(event.data['role']),
        task: text(event.data['task']),
        // 老事件没有 `mode` ⇒ one-shot（不可复用）。反过来猜"可复用"会在真机上把卡投进一个已经不存在的子代理。
        mode: text(event.data['mode']) === 'continuable' ? 'continuable' : 'one-shot',
        state: 'busy',
        rounds: (previous?.rounds ?? 0) + 1,
        startedAt: event.at ?? text(event.data['startedAt']),
        finishedAt: '',
        maskHash: text(event.data['maskHash']),
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
    const unusable = continuable
      .map((child) => ({ childSessionId: child.childSessionId, reason: input.reuseBlockedOf?.(child) ?? '' }))
      .filter((item) => item.reason !== '')
    const unusableIds = new Set(unusable.map((item) => item.childSessionId))
    const idle = continuable.filter((child) => !unusableIds.has(child.childSessionId))
    const retired = children.filter((child) => child.state === 'idle' && child.mode !== 'continuable').length
    return { role, cap, busy, idle, stale, retired, unusable, freeSlots: Math.max(0, cap - busy.length - idle.length) }
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
  /** 本轮可派的卡；`reuseChildId` 给了就是「投给这个**已有**子代理」（真复用），没给就是新起一个 */
  dispatch: { task: TaskCard; reuseChildId?: string | undefined }[]
  /** **因为掩码指纹不符/未知而放弃复用**的空闲子代理（SDO-52：不能静默少复用，也不能静默复用旧面） */
  reuseSkipped: { childSessionId: string; role: string; reason: string }[]
  /** 排队但**没被任何预算挡住**的（等下一轮空位） */
  queued: TaskCard[]
  /** 被挡下的卡及原因（池满 / 全局预算满） */
  blocked: { task: TaskCard; reason: 'pool-full' | 'global-budget'; detail: string }[]
  pools: RolePool[]
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
   * **该空闲子代理为什么不能复用**（R-1，与 `rolePools` 同一函数）：返回原因即拒绝复用。
   * office 层接的是"工具面观测"——**观测到零工具 / 没观测到**都不给复用（新起一个永远是对的）。
   */
  reuseBlockedOf?: ((child: PoolChild) => string | undefined) | undefined
}): PoolAdmission {
  const pools = input.pools.map((pool) => ({ ...pool, busy: [...pool.busy], idle: [...pool.idle] }))
  const byRole = new Map(pools.map((pool) => [pool.role, pool]))
  const dispatch: PoolAdmission['dispatch'] = []
  const reuseSkipped: PoolAdmission['reuseSkipped'] = []
  const queued: TaskCard[] = []
  const blocked: PoolAdmission['blocked'] = []
  let room = Math.max(0, Math.floor(input.globalRoom))
  for (const task of input.ready) {
    if (room <= 0) {
      queued.push(task)
      blocked.push({ task, reason: 'global-budget', detail: `全局并行预算已满（进行中 ${0} 张之外无空位）` })
      continue
    }
    const pool = byRole.get(task.role)
    if (pool === undefined) {
      // 该角色今天还没有池 —— 建一个空池再判（不能因为"没出现过"就当成不限量）
      const created: RolePool = { role: task.role, cap: 0, busy: [], idle: [], stale: [], retired: 0, unusable: [], freeSlots: 0 }
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
    const blockedReasonOf = (child: PoolChild): string | undefined => {
      const observed = input.reuseBlockedOf?.(child)
      if (observed !== undefined) return observed
      if (wanted === '' || (child.maskHash ?? '') !== wanted) {
        return (child.maskHash ?? '') === '' ? '旧子代理没有掩码指纹（无法确认其工具面）' : '掩码已变更（该会话的工具面是创建时的旧面）'
      }
      return undefined
    }
    if (input.reuseIdle && pool.idle.length > 0) {
      const index = pool.idle.findIndex((child) => blockedReasonOf(child) === undefined)
      if (index >= 0) {
        const taken = pool.idle.splice(index, 1)[0] as PoolChild
        pool.busy.push({ ...taken, state: 'busy', task: task.id })
        dispatch.push({ task, reuseChildId: taken.childSessionId })
        room -= 1
        continue
      }
      // 有闲置但不可复用：**如实记账**并强制新起（下面走 freeSlots 分支）
      for (const child of pool.idle) {
        reuseSkipped.push({
          childSessionId: child.childSessionId,
          role: pool.role,
          reason: blockedReasonOf(child) ?? '',
        })
      }
    }
    if (pool.freeSlots > 0) {
      pool.freeSlots -= 1
      pool.busy.push({
        childSessionId: '',
        role: pool.role,
        task: task.id,
        mode: 'one-shot',
        state: 'busy',
        rounds: 1,
        startedAt: '',
        finishedAt: '',
      })
      dispatch.push({ task })
      room -= 1
      continue
    }
    queued.push(task)
    blocked.push({
      task,
      reason: 'pool-full',
      detail: `${pool.role} 池满（在飞 ${pool.busy.length}/${pool.cap}${pool.idle.length > 0 ? `，空闲可复用 ${pool.idle.length}` : ''}）`,
    })
  }
  return { dispatch, reuseSkipped, queued, blocked, pools }
}

/** 满池排队的人读说明（回执用；点名角色与上限，并指向"等谁结算"）。 */
export function poolBlockedReason(admission: PoolAdmission): string | undefined {
  if (admission.blocked.length === 0) return undefined
  const roles = [...new Set(admission.blocked.filter((item) => item.reason === 'pool-full').map((item) => item.task.role))]
  return roles.length > 0 ? roles.join(' / ') : 'global'
}
