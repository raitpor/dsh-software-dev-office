/**
 * 角色卡与工具掩码（设计 §8.1 / §8.2 / §9.1）。
 *
 * 两层：
 *   · **提示层**：`skills/role-<code>.md`（SKILL.md 风格，随包交付，可注册为 skill）；
 *   · **硬约束**：本模块从 `src/data/roles.yml` 读出的 `allow`/`deny` 掩码——派发时由流程官施加，
 *     角色**看不到** allow 之外的工具（这是"角色不是会话、而是一次派发运行"的落点）。
 *
 * 一致性由测试保证：8 个角色恰好等于 `domain/plan.ts` 的 `ROLES`，
 * 且 `allow` 与 `integration/orchestrator.ts` 的 `TOOL_FILTER_BY_ROLE` 一致（避免两份真相）。
 */
import { loadPackagedYaml } from '../infra/data.js'
import { ROLES, isRole, listTasks } from './plan.js'
import type { Role } from './plan.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'

export interface RoleCard {
  code: Role
  name: string
  /** 白名单：只能看到这些（其余一律不可见） */
  allow: string[]
  /** 必须显式挡住的越界工具（allow 之外也写清，便于测试与说明） */
  deny: string[]
  rationale: string
}

interface RolesFile {
  roles: { code: string; name: string; allow: string[]; deny: string[]; rationale: string }[]
}

/** 角色掩码表（从随包数据加载；加载失败即报错——随包数据不该缺）。 */
export function listRoleCards(): RoleCard[] {
  const file = loadPackagedYaml<RolesFile>('src/data/roles.yml')
  if (file === undefined || !Array.isArray(file.roles)) {
    throw new Error('sdo: 随包角色掩码数据缺失（src/data/roles.yml）')
  }
  return file.roles.map((role) => ({
    code: role.code as Role,
    name: role.name,
    allow: role.allow,
    deny: role.deny,
    rationale: role.rationale,
  }))
}

export function roleCard(code: Role): RoleCard | undefined {
  return listRoleCards().find((role) => role.code === code)
}

/** 某角色的工具白名单（派发时作为 `toolFilter` 的 allow 部分）。 */
export function toolAllowList(code: Role): string[] {
  return roleCard(code)?.allow ?? []
}

/** 该角色是否可见某工具（白名单语义：不在 allow 里就不可见）。 */
export function maskAllows(code: Role, tool: string): boolean {
  const card = roleCard(code)
  if (card === undefined) return false
  if (card.deny.includes(tool)) return false
  return card.allow.includes(tool)
}

/** 掩码自检：deny 与 allow 不得同时包含同一工具（否则规则自相矛盾）。 */
export function maskConflicts(cards: RoleCard[] = listRoleCards()): { code: string; tool: string }[] {
  const conflicts: { code: string; tool: string }[] = []
  for (const card of cards) {
    for (const tool of card.deny) {
      if (card.allow.includes(tool)) conflicts.push({ code: card.code, tool })
    }
  }
  return conflicts
}

/** 角色卡文件相对路径（随包 `skills/`）。 */
export function roleCardPath(code: Role): string {
  return `skills/role-${code}.md`
}

/** 角色编号是否与流程引擎的角色集一致（8 个，不多不少）。 */
export function rolesConsistent(cards: RoleCard[] = listRoleCards()): { missing: string[]; extra: string[] } {
  const codes = cards.map((card) => card.code)
  return {
    missing: ROLES.filter((role) => !codes.includes(role)),
    extra: codes.filter((code) => !(ROLES as readonly string[]).includes(code)),
  }
}

// —————————————————————— B5/B6：把角色掩码从"声明"变成"运行时" ——————————————————————

/**
 * **B5：谁在调工具？** 从"会话 → 认领过的卡"推出真实角色。
 *
 * 老实现把 `tools/pre-execute` 钩子里的 role 写死成 `cockpit`，而 `evaluateDiscipline` 对 cockpit
 * **首行放行** ⇒ 阶段纪律与角色掩码两条都不生效。宿主的 `ToolExecution.agent` 给了"这次调用是谁发的"
 * （`exec.agent.session.header`），据此就能把角色认出来。
 *
 * 四态（**都保留 fail-open**：认不出来就按驾驶舱放行，纪律不能变成"插件认不出人就干不了活"）：
 *   · `dispatched`        —— 该会话认领过某张卡 ⇒ 角色 = 卡上的 `role`，**掩码硬拦**
 *   · `unclaimed-child`   —— 子会话但还没认领 ⇒ 角色未知 ⇒ **不施加掩码**，但按非驾驶舱走**阶段纪律**
 *   · `cockpit`           —— 根会话（驾驶舱）⇒ 不拦
 *   · `unknown`           —— 拿不到会话信息 ⇒ 按驾驶舱放行（fail-open）
 */
export type RoleAttribution =
  | { kind: 'dispatched'; role: Role; cardId: string }
  | { kind: 'unclaimed-child'; role: 'dispatched' }
  | { kind: 'cockpit'; role: 'cockpit' }
  | { kind: 'unknown'; role: 'cockpit' }

export interface SessionClaim {
  sessionId: string
  cardId: string
  role: string
}

/**
 * 汇总「哪个会话此刻正做着哪张卡」（取每个会话**最后一次**认领；卡上的角色以真源为准）。
 *
 * **只在卡"正被做着"期间成立**（评审 2026-10-03 F2）：老实现只翻历史 `task/claimed` 事件，
 * 卡一旦 `done`/`blocked`/`dropped`（或被 `reassign` 换人）归属仍粘着该会话 ⇒ 单会话模式下驾驶舱
 * 会被永久降级成那个角色的工具面（连 `sdo_gate`/`sdo_status` 都调不了）。所以这里用**卡的当前状态 +
 * 当前 owner** 过滤：只有 `in-progress` 且 owner 与认领时一致的卡才算数。
 */
export function claimsBySession(store: SdoStore, journal: Journal): SessionClaim[] {
  const cards = new Map(listTasks(store).map((task) => [task.id, task]))
  const latest = new Map<string, SessionClaim>()
  for (const event of journal.read().events) {
    if (event.type !== 'task/claimed') continue
    const sessionId = typeof event.data.sessionId === 'string' ? event.data.sessionId : ''
    const cardId = typeof event.data.id === 'string' ? event.data.id : ''
    const owner = typeof event.data.owner === 'string' ? event.data.owner : ''
    if (sessionId === '' || cardId === '') continue
    const card = cards.get(cardId)
    // 卡已离开"进行中"（done/blocked/dropped/ready）→ 归属失效；被换人（owner 变了）→ 同样失效
    if (card === undefined || card.status !== 'in-progress') continue
    if (owner !== '' && card.owner !== undefined && card.owner !== owner) continue
    latest.set(sessionId, { sessionId, cardId, role: String(card.role) })
  }
  return [...latest.values()]
}

/** 按（会话 id、委派深度）判定角色。`delegationDepth > 0` 表示这是一个被派发的子会话。 */
export function attributeRole(input: {
  sessionId?: string | undefined
  delegationDepth?: number | undefined
  claims: SessionClaim[]
}): RoleAttribution {
  const sessionId = input.sessionId
  if (sessionId === undefined || sessionId === '') return { kind: 'unknown', role: 'cockpit' }
  const claim = input.claims.filter((item) => item.sessionId === sessionId).pop()
  if (claim !== undefined) {
    if (isRole(claim.role)) return { kind: 'dispatched', role: claim.role, cardId: claim.cardId }
    // 认领过但卡上的 role 不是八个角色之一（真源被手改坏）：不施加掩码，但仍按非驾驶舱走阶段纪律
    return { kind: 'unclaimed-child', role: 'dispatched' }
  }
  return (input.delegationDepth ?? 0) > 0 ? { kind: 'unclaimed-child', role: 'dispatched' } : { kind: 'cockpit', role: 'cockpit' }
}

/**
 * **B6：掩码判定**（白名单语义：不在 allow 里就拒绝）。
 *
 * `cockpit` 与未识别角色返回 allow（驾驶舱看全集；掩码只约束**认得出的派发角色**）。
 * 返回结构化结果，文案由接口层按语言包组织（域层不写用户可见中文）。
 */
export function roleMaskDecision(role: string, tool: string): { kind: 'allow' } | { kind: 'deny'; role: Role; tool: string } {
  if (role === 'cockpit' || role === '' || !isRole(role)) return { kind: 'allow' }
  return maskAllows(role, tool) ? { kind: 'allow' } : { kind: 'deny', role, tool }
}

/** 该角色的工具面（供回执/文档展示；不含驾驶舱）。 */
export function maskedToolFace(role: Role): string[] {
  return toolAllowList(role)
}
