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
import { createHash } from 'node:crypto'
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
/**
 * **只读检视类工具 = 所有角色的基础工具面**（真机缺陷的机制化修复）。
 *
 * 真机症状（TASK-183 原话）：「**developer 角色掩码里没有 `read_image`**（这是插件的角色掩码决定的，
 * 不是模型不支持），所以我**看不了截图**」—— 而那张卡要的证据恰恰是客户端渲染对不对。
 * 根因不是"漏了一个工具"，而是**掩码是白名单**：谁忘了往 `roles.yml` 里补一条，谁就在某个角色上
 * **静默**丢掉一项基础能力，而执行者只会说"我没有这个工具"。所以这里把只读检视工具**并入每个角色的面**
 * （`deny` 仍然优先，写类/流程类工具照旧逐条列举）。
 *
 * **只列宿主确实注册的工具名**：这份名单会进宿主的 `toolFilter`，而宿主 `tools.restrict()` 对
 * **未注册的名字直接抛错**（`names unknown global tool "pdf"`）⇒ 整份工具面失效、连 `read_image`
 * 一起丢（真机回归：曾把 `pdf` 当"检视工具"加进来，子代理反而报「没有 pdf 导致拿不到 read_image」）。
 * 所以：**这里不许凭想象加名字**；不确定的走 {@link filterKnownTools} 在运行期按宿主注册表过滤。
 */
export const READ_ONLY_INSPECTION_TOOLS = ['read', 'grep', 'glob', 'read_image'] as const

/**
 * **SDO 流程面**：本插件自己注册的工具（`sdo_*`）。这是一份**我们完全掌握**的封闭集合，
 * 角色职责分离（developer 不许 `sdo_gate`、reviewer 不许 `sdo_test`…）只在这份集合上有意义。
 *
 * 与**通用面**（宿主/harness 给的 `read`/`write`/`bash`/`skill`/`memory_*`/`technique_*`/`web_*`/
 * `todo_write`/`subagent`…）区分开，是 2026-10-08 真机缺陷的要害（见 {@link maskAllows}）。
 */
export function isSdoTool(name: string): boolean {
  return name.startsWith('sdo_')
}

/**
 * 某角色的**声明工具面**（`roles.yml` 的 allow ∪ 只读检视工具）。
 *
 * ⚠️ 它**不再**是下发给宿主的 allow 白名单（那会把整个通用面一起挡掉，见 {@link maskAllows}）。
 * 现在的用途：掩码指纹、自检、回执里说明"这个角色声明了哪些工具"。
 */
export function toolAllowList(code: Role): string[] {
  const card = roleCard(code)
  if (card === undefined) return []
  return [...new Set<string>([...READ_ONLY_INSPECTION_TOOLS, ...card.allow])]
}

/**
 * **该角色在 SDO 流程面可用的工具**（`allow ∩ sdo_*`；只读检视工具不是 sdo 工具，天然人人可用）。
 * 这是流程面的**白名单** —— 不在这里的 `sdo_*` 一律进 deny 面。
 */
export function sdoAllowList(code: Role, sdoNames: readonly string[]): string[] {
  const card = roleCard(code)
  if (card === undefined) return []
  return sdoNames.filter((name) => card.allow.includes(name))
}

/**
 * **执行者禁令**：被派发的执行者**不得再起一个 agent 运行**。
 *
 * 为什么是安全边界而不是洁癖：`subagent` / `subagent_fork` / `workflow` 起出来的子代理**不带角色掩码**
 * （它们不经过 `toolFilter`），于是任何一个角色子代理只要拿到这几个工具，就能派出一个"什么都能调"的
 * 子代理 —— **等于绕开整张掩码表**（2026-10-08 用户点名）。
 * `sdo_plan` 是同一个口子的插件侧入口（它内部就调 `startDispatch`）。
 *
 * 施加方式：① 只对**子会话**生效（`MaskContext.executor`）—— 驾驶舱即使认领了某张卡也仍要能派发；
 * ② **下发的 deny 面无条件含它**（`toolDenyList`：那份面只会发给被派发的子会话）；
 * ③ 钩子按 `executor` 判（`maskAllows` / `roleMaskDecision`），两层都拦。
 *
 * 不在名单里的 `send_message` / `list_agents` / `interrupt_agent`：它们**起不了新的运行**，
 * 目标也被宿主限死在"自己的直接子代理/父会话"，不构成"换个不带掩码的 agent 干活"的机械绕过。
 */
export const EXECUTOR_FORBIDDEN_TOOLS = ['subagent', 'subagent_fork', 'workflow', 'sdo_plan'] as const

/**
 * **执行者禁用面**：被派发的执行者**一律不许**用的工具（= {@link EXECUTOR_FORBIDDEN_TOOLS} ∪ 下面五类）。
 *
 * 为什么要有这张表（而不是只挡"能起 agent 的"那几个）：**通用面改成黑名单语义之后，凡是没人
 * 在 `roles.yml` 里声明过的宿主工具，都会自动落到每个角色子代理手里** —— 这是黑名单的预期行为，
 * 但其中有一批根本不属于"干这张卡"，而属于**平台 / 用户 / 会话 / 共享库**层面。
 * 2026-10-08 的全面审计（对着宿主的 `Tool.listTools` 逐个分类）把这类逐条找了出来：
 *
 *   ② **平台管理**：`plugin_manager`（装/禁用插件 —— 能被用来把 SDO 自己关掉）。
 *   ③ **用户交互与会话模式**：`exit_plan_mode`（把计划推给用户批准；问用户是 analyst 的 `ask_user_question`，
 *      会话模式归驾驶舱）。
 *   ④ **共享知识库的不可逆删除**：`memory_forget` / `technique_forget`（都支持 `"*"` 全清，
 *      而且**跨项目共享**）—— 孩子只该**贡献**（`memory_save`/`technique_save`/`technique_apply` 保留）。
 *   ⑤ **纪律豁免**：`failure_forgive`（"这次算了"必须由**用户**批准，不是执行者自己说了算）。
 *   ⑥ **会话生命周期**：`create_goal` / `update_goal`（会触发**自动续轮** ⇒ 执行者可以自我续命、脱离驾驶舱）。
 *
 * **有意不挡**（审计结论，附理由，避免下次又有人当成漏的）：
 *   · `memory_search`/`technique_search`/`technique_get`/`failure_list`/`get_goal` —— 只读；
 *   · `memory_save`/`technique_save`/`technique_apply`/`failure_resolve`/`technique_learn`/`technique_export`
 *     —— 沉淀与上报（用户点名要回的正是 `technique_apply`）；
 *   · `send_message`/`list_agents`/`interrupt_agent` —— **起不了新的运行**，目标被宿主限死在
 *     "自己的直接子代理/父会话"，不构成"换个不带掩码的 agent 干活"的机械绕过；
 *   · `web_search`/`web_fetch`/`todo_write`/`present`/`skill`/`read`/`grep`/`glob`/`read_image`
 *     —— 干活要用（`read` 系与 `skill` 是设计上人人可用的基础面）。
 */
export const EXECUTOR_DENIED_TOOLS = [
  ...EXECUTOR_FORBIDDEN_TOOLS,
  // ② 平台管理
  'plugin_manager',
  // ③ 用户交互 / 会话模式
  'exit_plan_mode',
  // ④ 共享知识库的不可逆删除
  'memory_forget',
  'technique_forget',
  // ⑤ 纪律豁免
  'failure_forgive',
  // ⑥ 会话生命周期（自动续轮）
  'create_goal',
  'update_goal',
] as const

/**
 * 掩码判定的**上下文**。
 *
 * `executor: true` = 调用方是**被派发的执行者**（子会话）。它与"驾驶舱认领了某张卡被归属成某角色"
 * 必须分开：驾驶舱是流程官，派发是它的本职（`sdo_plan`），不能被自己的角色归属锁死
 * （真机 F2 就是"单会话模式下驾驶舱被永久降级成那个角色的工具面"）。
 */
export interface MaskContext {
  executor?: boolean | undefined
}

/**
 * **该角色的 deny 面**（下发给宿主的**唯一**工具面内容）。
 *
 * = `roles.yml` 的 `deny`（通用面的硬禁止：谁能写、谁能跑 bash，逐角色写清）
 *   ∪ 「SDO 流程面里**不属于**本角色的工具」（白名单的补集）。
 *
 * 为什么不是 allow 白名单：真机事故（TASK-023 子代理原话「无法使用 `technique_apply`」）——
 * 白名单语义下，**宿主/harness 的通用面全被挡掉**，子代理连技能沉淀、记忆、联网都没有；
 * 而新加一个宿主工具时，8 个角色的 allow 全都要跟着改，谁忘了谁就静默少一项能力。
 * 角色职责分离真正需要的只是"SDO 流程面按角色分权"，通用面该由**黑名单**（`deny`）来挡。
 */
export function toolDenyList(code: Role, sdoNames: readonly string[]): string[] {
  // **执行者禁用面无条件并入**：这份面只会下发给被派发的子会话（见 `EXECUTOR_DENIED_TOOLS`）
  const forbidden = [...EXECUTOR_DENIED_TOOLS]
  const card = roleCard(code)
  // 角色认不出（掩码表缺失/角色名写错）⇒ **整个 SDO 流程面一律挡住**。
  // 方向必须是 fail-closed：这一层是职责分离，不是便利功能（旧实现读不到数据就退回"内置兜底名单"）。
  if (card === undefined) return [...new Set<string>([...sdoNames, ...forbidden])]
  const allowed = new Set(sdoAllowList(code, sdoNames))
  const deniedSdo = sdoNames.filter((name) => !allowed.has(name) && !(READ_ONLY_INSPECTION_TOOLS as readonly string[]).includes(name))
  return [...new Set<string>([...card.deny, ...deniedSdo, ...forbidden])]
}

/**
 * **派发前的静态可行性**（R-14，sdo-test-new 2026-10-08）：这张卡要求的**动作**，这个角色的掩码允许吗？
 *
 * 真机两次都栽在这：`reviewer` 被要求"复现"（跑命令）⇒ 它的 deny 面里有 `bash`；又被要求"产出文档"
 * ⇒ deny 面里有 `write`。而矛盾**只在子会话动手失败之后**才浮出来（代价一整轮）。
 * 这里只做**机械可判**的两条（文本里的 DoD 自由表述不猜）：
 *   · `evidenceRequired` 含 `command` ⇒ 需要 `bash`（要交命令证据就得能跑命令）；
 *   · `writeScopes` 非空 ⇒ 需要 `write` 或 `edit`（有写范围就得能落盘）。
 * 返回**码**（`needs-bash` / `needs-write`），文案由界面层出 —— 域层不塞用户可见中文。
 */
export type CapabilityGapCode = 'needs-bash' | 'needs-write'

export function capabilityGaps(
  card: { evidenceRequired?: readonly unknown[] | undefined; writeScopes?: readonly unknown[] | undefined },
  role: string,
): CapabilityGapCode[] {
  if (!isRole(role)) return []
  const allow = toolAllowList(role)
  const gaps: CapabilityGapCode[] = []
  const evidence = (card.evidenceRequired ?? []).map((item) => String(item).trim())
  if (evidence.includes('command') && !allow.includes('bash')) gaps.push('needs-bash')
  const scopes = (card.writeScopes ?? []).map((item) => String(item).trim()).filter((item) => item !== '')
  if (scopes.length > 0 && !allow.includes('write') && !allow.includes('edit')) gaps.push('needs-write')
  return gaps
}

/** 该角色是否可见某工具（白名单语义：不在 allow 里就不可见；只读检视工具人人可见）。 */
/**
 * 按**宿主已知工具**过滤工具面（送进 `tools.restrict()` 之前必须过这一道）。
 *
 * `isKnown` 由调用方从宿主的 `tools` 服务拿（`tools.get(name)` 能解析出来 ⇒ 一定已知）。
 * 返回 `dropped` 是为了**如实报告**：被剔掉的名字要出现在回执里，绝不静默改小工具面。
 */
/**
 * 角色掩码的**指纹**（SDO-52）：把「allow ∪ deny ∪ 基础面」排序后取哈希。
 *
 * 用途：派发时把指纹记进 `dispatch/started`；**复用一个空闲子代理之前先比对**——
 * 工具面是**创建会话时**定下的，掩码改过之后旧会话拿到的还是旧面（真机上同一子会话被复用约 137 张卡，
 * 后补的 `read_image` 始终拿不到）。指纹不一致或缺失 ⇒ **强制新起**，并如实回报。
 */
export function maskFingerprint(code: Role): string {
  const card = roleCard(code)
  if (card === undefined) return ''
  // **R-7（sdo-test-new 2026-10-08，major）**：指纹必须覆盖**有效的 deny 面** —— 执行者禁用面
  // （`EXECUTOR_DENIED_TOOLS`）是**代码层**的常量，`roles.yml` 里没有这些名字，所以旧实现算出的指纹
  // 在"禁令上线"前后**完全一样** ⇒ 上线前创建的旧会话被判"指纹一致 ⇒ 可复用"，而它公告面里
  // 仍握着 `exit_plan_mode`/`memory_forget`/`technique_forget`/`failure_forgive`（真机 `4e7ea6d8`）
  // —— 复用判据把禁令绕过去了。
  // 连同"白名单补集"一起算进指纹（`sdo_*` 的收窄历史也是复用必须失效的理由）。
  const names = [...new Set<string>([...toolAllowList(code), ...card.deny, ...EXECUTOR_DENIED_TOOLS])].sort()
  return createHash('sha1').update(names.join('|')).digest('hex').slice(0, 12)
}

export interface KnownToolsFilter {
  /** 探针判为「宿主已知」的名字（**探针原样结果**，不掺 fail-open）。 */
  kept: string[]
  /** 探针判为「宿主未知」的名字。 */
  dropped: string[]
  /**
   * **探针盲**：名单非空，但探针把**每一个**名字都判成未知。
   *
   * **D-14（sdo-test-new 2026-10-08，blocker）**：宿主 `tools.get(name)` **省略 scope 时只查全局层**，
   * 而本插件的工具面挂在 agent/preset 平面（`dsh-tools` 源码自陈：preset 工具是 "ANCESTOR contribution"）
   * ⇒ 15 个名字**一个都查不到**，旧实现把这读成「宿主不认识这些名字」，`kept=[]` 原样下发，
   * 子代理拿到 **0 个工具**（子会话描述符 `toolFilter.allow=[]`，整轮只能把工具调用写成正文，卡零变化）。
   * 一个真实部署不可能「整份名单一个都不认识」——把这种态当成事实，就是**把探针故障说成客观结论**。
   */
  blind: boolean
  /** **实际可以下发**的名单：盲态保持原名单（fail-open），其余情况 = `kept`。 */
  applied: string[]
}

/**
 * 按宿主已知工具过滤工具面（送进 `tools.restrict()` 之前必须过这一道）。
 *
 * `isKnown` 由调用方从宿主的 `tools` 服务拿；**必须带上调用方 agent 的作用域**（见 D-14 注释）。
 * 返回值把「探针说什么」（`kept`/`dropped`）与「实际发什么」（`applied`）分开，
 * 并单独标出 `blind` —— 三者都不是同一件事，回执里也必须分开说。
 */
export function filterKnownTools(names: readonly string[], isKnown: (name: string) => boolean): KnownToolsFilter {
  const kept: string[] = []
  const dropped: string[] = []
  for (const name of names) {
    if (isKnown(name)) kept.push(name)
    else dropped.push(name)
  }
  // 名单非空却「全未知」= 探针不可用，不是「宿主不认识」。宁可少拦（原样下发，宿主 `restrict()` 会
  // 对真正未注册的名字**抛错**⇒ 失败是响的），也不能静默把白名单清空成一个没有工具的子代理。
  const blind = names.length > 0 && kept.length === 0
  return { kept, dropped, blind, applied: blind ? [...names] : kept }
}

/**
 * 该角色是否**允许**调用某工具（**两层语义**，2026-10-08 真机口径纠正）：
 *
 *   ① **通用面**（非 `sdo_*`：`read`/`write`/`bash`/`skill`/`memory_*`/`technique_*`/`web_*`/…）
 *      —— **黑名单**：只有 `roles.yml` 的 `deny` 明写挡住的才不许（谁能写、谁能跑 bash 已逐角色写清），
 *      其余**继承宿主默认**。
 *   ② **SDO 流程面**（`sdo_*`）—— **白名单**：只有 `allow` 里列了的才许（职责分离的硬要求）。
 *
 * 为什么通用面必须改成黑名单：真机事故（TASK-023 子代理原话「**无法使用 `technique_apply`**」）。
 * 白名单语义下，`toolFilter.allow` 只列了角色声明的十几个名字，宿主因此把**整个通用面**也隐藏了 ——
 * 子代理没有技能沉淀、没有记忆、没有联网，而它还**只会说"我没有这个工具"**（能力缺失被表达成事实）。
 * 更糟的是它的失效方向：宿主/harness 每加一个工具，8 个角色的 allow 都得跟着改，谁忘了谁就静默少一项。
 * 角色职责分离真正要护的是 **SDO 流程面**（developer 不许改门禁、reviewer 不许写、tester 不许碰需求），
 * 那一份是我们**完全掌握**的封闭集合，用白名单；通用面用黑名单，缺省继承。
 */
export function maskAllows(code: Role, tool: string, context: MaskContext = {}): boolean {
  const card = roleCard(code)
  if (card === undefined) return false
  // deny 永远优先（两层都算）
  if (card.deny.includes(tool)) return false
  // **执行者禁令**：被派发的子会话不得起新的 agent 运行（那会绕开掩码）。驾驶舱不算执行者。
  if (context.executor === true && (EXECUTOR_DENIED_TOOLS as readonly string[]).includes(tool)) return false
  if ((READ_ONLY_INSPECTION_TOOLS as readonly string[]).includes(tool)) return true
  // SDO 流程面：白名单（只列了的才许）
  if (isSdoTool(tool)) return card.allow.includes(tool)
  // 通用面：黑名单（没被 deny 就继承宿主默认）
  return true
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
  /**
   * `cardId` 可缺：**血缘兜底**（卡已离开 in-progress，只能从 `dispatch/started` 认角色）时
   * 没有"活的认领卡"，此时角色仍然确定（这就是要点），卡 id 只是附加信息。
   */
  | { kind: 'dispatched'; role: Role; cardId?: string | undefined }
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
  /** 父会话 id（宿主 `session.header.parentSession`）；空/缺省 = 根会话 */
  parentSessionId?: string | undefined
  claims: SessionClaim[]
  /**
   * **血缘角色**（第一轮整仓评审 §2 第 1 条）：这个会话**被我们派发出去时**记在 `dispatch/started` 里的角色。
   *
   * 为什么必须有它：`claims` 只在"认领事件的卡**仍然 `in-progress`**"时成立（见 `claimsBySession`），
   * 卡一旦 done / dropped / blocked / ready，归属就失效 ⇒ 旧实现在这里退回 `unclaimed-child`、
   * **整段跳过掩码**。实测（等过 5 秒角色缓存 TTL）：驾驶舱把卡 `drop` 掉之后，仍在飞的 reviewer
   * 子会话调 `write` 从 DENY 变成 **ALLOW** —— 掩码取决于**可手改的卡状态**，而不是"我是谁"。
   * 派发时记下的角色来自追加式真源、不随卡状态改变，用它兜底即可（复用时取最新一条派发）。
   */
  dispatchedRole?: string | undefined
}): RoleAttribution {
  const sessionId = input.sessionId
  if (sessionId === undefined || sessionId === '') return { kind: 'unknown', role: 'cockpit' }
  // **血缘优先（R-1，2026-10-05 真机）**：**根会话永远是驾驶舱**（office / 流程官）。
  //
  // 旧实现先看 `claims`：父会话只要认领过一张 developer 卡（真机台账里 `owner=cockpit` 很常见），
  // 就被判成 `dispatched / developer` ⇒ **掩码开始拦它自己的工具调用**（回执写着"以 developer 身份"），
  // 而它本该是流程官。**认领事实只决定"这张卡归谁"，不决定"我是谁"** —— 身份由血缘决定。
  //
  // 判据用两个独立信号：没有父会话 **且** `delegationDepth` 为 0（缺省按 0）⇒ 根会话。
  // 子会话无论 header 有没有带 `parentSession`，都会走下面的 claims 分支（老口径不变）。
  const parent = input.parentSessionId ?? ''
  if (parent === '' && (input.delegationDepth ?? 0) === 0) return { kind: 'cockpit', role: 'cockpit' }
  const claim = input.claims.filter((item) => item.sessionId === sessionId).pop()
  if (claim !== undefined) {
    if (isRole(claim.role)) return { kind: 'dispatched', role: claim.role, cardId: claim.cardId }
    // 认领过但卡上的 role 不是八个角色之一（真源被手改坏）：不施加掩码，但仍按非驾驶舱走阶段纪律
    return { kind: 'unclaimed-child', role: 'dispatched' }
  }
  // 走到这里说明它是**子会话**（有父会话或 depth > 0）但**没有活的认领**（没认领过，或卡已离开 in-progress）。
  // 有血缘角色 ⇒ 按派发时记下的角色施加掩码（fail-closed）；认不出的会话保持原口径 fail-open。
  if (input.dispatchedRole !== undefined && isRole(input.dispatchedRole)) {
    return { kind: 'dispatched', role: input.dispatchedRole }
  }
  return { kind: 'unclaimed-child', role: 'dispatched' }
}

/**
 * **B6：掩码判定**（白名单语义：不在 allow 里就拒绝）。
 *
 * `cockpit` 与未识别角色返回 allow（驾驶舱看全集；掩码只约束**认得出的派发角色**）。
 * 返回结构化结果，文案由接口层按语言包组织（域层不写用户可见中文）。
 */
export function roleMaskDecision(
  role: string,
  tool: string,
  context: MaskContext = {},
): { kind: 'allow' } | { kind: 'deny'; role: Role; tool: string; reason?: 'executor-forbidden' | 'executor-denied' | undefined } {
  if (role === 'cockpit' || role === '' || !isRole(role)) return { kind: 'allow' }
  if (maskAllows(role, tool, context)) return { kind: 'allow' }
  if (context.executor === true) {
    if ((EXECUTOR_FORBIDDEN_TOOLS as readonly string[]).includes(tool)) return { kind: 'deny', role, tool, reason: 'executor-forbidden' }
    if ((EXECUTOR_DENIED_TOOLS as readonly string[]).includes(tool)) return { kind: 'deny', role, tool, reason: 'executor-denied' }
  }
  return { kind: 'deny', role, tool }
}

/** 该角色的工具面（供回执/文档展示；不含驾驶舱）。 */
export function maskedToolFace(role: Role): string[] {
  return toolAllowList(role)
}
