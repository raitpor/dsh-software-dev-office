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
import { ROLES } from './plan.js'
import type { Role } from './plan.js'

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
