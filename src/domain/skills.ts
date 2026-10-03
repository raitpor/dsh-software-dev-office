/**
 * **角色卡技能**（B2）：把随包的 8 张角色卡注册为**一个索引型 skill**，让执行者按需加载。
 *
 * 为什么是"一个索引"而不是"8 个技能"：技能目录（名字 + 描述）会进入该 profile **每个**会话的
 * 系统提示，注册 8 条就是 8 行常驻 token；索引只占 1 行，而卡片正文仍按需加载。
 *
 * 为什么正文是**现算**的：单一真源是 `src/data/roles.yml`（角色名 / 工具掩码 / 理由）与
 * `skills/role-<code>.md`（卡片正文），索引只是它们的视图 —— 手抄第三份必然会漂移
 * （`test/m7` 与 `test/m23` 就是为"不许两份手抄"立的规矩）。
 *
 * 为什么**不硬依赖** skills 服务：宿主不一定装配该服务（例如精简 preset）。这里用
 * `ctx.get('skills')` 可选探测：有就注册，没有就静默降级（返回原因，不抛错、不阻塞装配）。
 */
import { existsSync, readFileSync } from 'node:fs'

import { packagedPath } from '../infra/data.js'
import { fmt, t } from './i18n.js'
import { listRoleCards, roleCardPath } from './roles.js'
import type { RoleCard } from './roles.js'

/** 注册到宿主技能目录的名字（kebab-case；宿主会校验这个形状）。 */
export const ROLE_CARDS_SKILL_NAME = 'sdo-role-cards'

/** 宿主 skills 服务的最小结构契约（只用到注册；不引入 @deepseek-ai/dsh-skill 依赖）。 */
export interface SkillRegistrationLike {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly provider?: string
  readonly resourceBase?: { readonly kind: 'directory'; readonly path: string }
  readonly content: string
  readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** 宿主 skills 服务的最小接口。 */
export interface SkillsServiceLike {
  register(skill: SkillRegistrationLike): () => void
}

/** 注册结果（回执/日志要用，测试也断言它）。 */
export interface RoleCardsSkillOutcome {
  registered: boolean
  /** 人读原因：注册成功、或为什么没注册 */
  reason: string
  dispose?: (() => void) | undefined
}

function isSkillsServiceLike(value: unknown): value is SkillsServiceLike {
  return typeof value === 'object' && value !== null && typeof (value as SkillsServiceLike).register === 'function'
}

/** 卡片正文（随包 `skills/role-<code>.md`）；缺失即包装错了 —— 抛出而不是静默少一张。 */
export function readRoleCard(code: RoleCard['code']): string {
  const path = packagedPath(roleCardPath(code))
  if (!existsSync(path)) throw new Error(`sdo: packaged role card missing (${roleCardPath(code)})`)
  return readFileSync(path, 'utf8')
}

/**
 * 索引正文：8 张卡"该读哪张 + 硬约束是什么"的视图。
 *
 * 每一行都能追溯到 `roles.yml`（名称 / 理由 / allow / deny），路径能追溯到随包文件；
 * 因此**没有手抄**：改了 `roles.yml`，索引与用例都会跟着变。
 */
export function buildRoleCardsContent(cards: RoleCard[] = listRoleCards()): string {
  const directory = packagedPath('skills')
  const lines: string[] = [
    fmt('skillBody.title', { p1: String(cards.length) }),
    '',
    t('skillBody.intro1'),
    t('skillBody.intro2'),
    '',
    t('skillBody.tableHead'),
    '|---|---|---|---|',
  ]
  for (const card of cards) {
    lines.push(fmt('skillBody.tableRow', { p1: card.code, p2: card.name, p3: card.rationale, p4: roleCardPath(card.code) }))
  }
  lines.push('', t('skillBody.sectionsNote'), '', t('skillBody.maskHead'), '')
  for (const card of cards) {
    lines.push(
      fmt('skillBody.maskLine', {
        p1: card.code,
        p2: card.allow.map((tool) => `\`${tool}\``).join(', '),
        p3: card.deny.map((tool) => `\`${tool}\``).join(', '),
      }),
    )
  }
  lines.push(
    '',
    fmt('skillBody.dirLine', { p1: directory }),
    '',
    t('skillBody.protocolHead'),
    t('skillBody.protocol1'),
    t('skillBody.protocol2'),
    t('skillBody.protocol3'),
    t('skillBody.protocol4'),
  )
  return lines.join('\n')
}

/** 组装要注册的技能（纯函数，便于用例断言形状与内容）。 */
export function buildRoleCardsSkill(cards: RoleCard[] = listRoleCards()): SkillRegistrationLike {
  return {
    name: ROLE_CARDS_SKILL_NAME,
    description: t('uiSkills.roleCardsDescription'),
    whenToUse: t('uiSkills.roleCardsWhenToUse'),
    source: 'bundled',
    provider: 'dsh-software-dev-office',
    resourceBase: { kind: 'directory', path: packagedPath('skills') },
    content: buildRoleCardsContent(cards),
    invocation: { modelInvocable: true, userInvocable: true },
    metadata: { cards: cards.map((card) => card.code).join(',') },
  }
}

/**
 * 把角色卡索引注册进宿主的 skills 服务（**可选依赖**）。
 *
 * 不抛错：服务缺失或形状不对时**降级为不注册**，并返回人读原因（由 `apply` 记进日志）。
 * 调用方用 `ctx.inject(['skills'], …)` 拿到服务后传进来 —— 这样服务在**本插件之后**才注册
 * 也能生效（一次性探测会漏掉那种装配顺序）。
 */
export function registerRoleCardsSkill(service: unknown): RoleCardsSkillOutcome {
  if (!isSkillsServiceLike(service)) {
    return { registered: false, reason: t('uiSkills.skillsMissing') }
  }
  // 服务侧校验（`validateRuntimeSkill`）会抛错：本模块承诺"不阻塞装配"，
  // 因此这里必须兜住 —— 宿主校验规则收紧时只降级为不注册，不影响插件装配。
  try {
    const dispose = service.register(buildRoleCardsSkill())
    return { registered: true, reason: t('uiSkills.roleCardsRegistered'), dispose }
  } catch (error) {
    return { registered: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 本地声明宿主可能提供的 `skills` 服务（**不引入** `@deepseek-ai/dsh-skill` 依赖）。
 *
 * 只为让 `ctx.inject(['skills'], …)` / `ctx.get('skills')` 通过类型检查；`skills` 声明为可选，
 * 因此本插件在**没有**该服务的组合里照常装配（缺失即不注册）。若将来本包真的依赖
 * `@deepseek-ai/dsh-skill`，删掉这段声明即可（那时由该包自己做增强）。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    skills?: SkillsServiceLike
  }
}
