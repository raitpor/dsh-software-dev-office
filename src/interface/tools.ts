/**
 * 暴露给模型的原生 dsh 工具（设计 §9.1）。
 *
 * M0：`sdo_init` / `sdo_status`；M1：`sdo_requirement` / `sdo_redteam` / `sdo_render`，
 * 以及一个**被 G2 门禁拦截**的 `sdo_design`（真正实现在 M2，这里先立好门禁与负例路径）。
 *
 * 本模块只声明**工具契约**（名称、参数、输出渲染），行为委托给 {@link OfficeToolDeps}。
 * 复杂结构（八维评分、验收标准）用 **JSON 字符串**传参，避免工具 schema 嵌套带来的歧义。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * **列表型参数的声明形态**（DEF-073 / DEF-065 / DEF-077）：字符串 JSON 文本**或**真数组都收。
 *
 * 为什么必须这样：模型天然按自然形态传数组，而参数若声明成纯 `string`，**宿主在 schema 校验阶段
 * 就拒签** —— 插件根本收不到这次调用（这是本项目复发次数最高的一类故障；描述里写
 * 「Do NOT pass an array」是**规避**，不是修复）。归一仍复用既有的 `compositeArg`。
 *
 * **DEF-077（第四批 §3.2）**：这里原来是**名单**（`LIST_PARAM_NAMES` + 注册前统一升级）——
 * 「名单内 + 声明为纯 `string`」才升成联合，于是**每新增一个列表型参数，不加名单就静默退回纯 string**
 * （`unfrozen` 就是这么漏的；同族的 `impact`/`landing` 因为手写联合而逃过名单，另有一半在名单外边）。
 * 现在改为**声明即承诺**：列表形态就在**参数声明处**（本助手），schema 面与调用面都从**这一份声明**推导
 * ⇒ 两处判据不可能分叉（`DEF-044` 的教训），也没有第二份名单可漏。
 */
export interface ListParamDecl {
  /** 字符串 JSON 文本**或**真数组。作者侧 `type:'json'` 由 `defineTool` 编译成"仅注解的空 schema"。 */
  oneOf: readonly [{ type: 'string' }, { type: 'array'; items: { type: 'json' } }]
  description: string
}

/**
 * 列表型参数的**声明**（唯一写法）。注册出口从它推导调用面归一集合。
 *
 * 描述里那句「not an array」在 Declaration 处被抹掉（与旧名单路径逐字一致）：联合形态本来就**收**数组，
 * 留着会与 schema 互相打脸。
 */
export function listDecl(description: string): ListParamDecl {
  return {
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'json' } }],
    description: description
      .replace(/\s*Do NOT pass an array\.?/giu, '')
      // 大小写都抹（`Not an array.` 与 `not an array.`）：联合形态本来就**收**数组，留着就是与 schema 互相打脸
      .replace(/\s*not an array\.?/giu, '')
      .trim(),
  }
}

/**
 * **从声明推导列表参数名**（不再有名单）：凡是声明了 `oneOf` 且含 `array` 分支 ⇒ 调用面需要归一。
 *
 * 一个判据、两个消费者（schema 面已是声明本身；调用面由本函数给出）—— 这是 DEF-077 的结构性修复：
 * "声明可以接受数组"与"调用面会把数组归一"从**同一处**读出，不存在"升了 schema 却漏了归一"的中间态。
 */
export function listParamNames(properties: Record<string, unknown>): string[] {
  return Object.entries(properties)
    .filter(([, raw]) => {
      const branches = (raw ?? {}) as { oneOf?: unknown }
      return Array.isArray(branches.oneOf)
        && (branches.oneOf as { type?: unknown }[]).some((branch) => branch?.type === 'array')
    })
    .map(([name]) => name)
}

/**
 * **一处归一（调用面）**：把真数组转成 JSON 文本再交给既有解析器。
 *
 * `names` 由 {@link listParamNames} 从**已声明的 schema** 推导（不再有人工名单）。
 * 只动"传了数组"这种情况；字符串原样透传。
 */
export function withListArgs(args: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args }
  for (const name of names) {
    const value = out[name]
    if (Array.isArray(value)) out[name] = JSON.stringify(value)
  }
  return out
}


import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { fmt, t } from '../domain/i18n.js'
import { digestArtifact } from '../domain/evidence.js'
// 判定基准的**词表只有一份**（`evidence.ts` 的 `ORACLE_KINDS`）：schema 的 `enum` 直接由它派生 ——
// 在这里再抄一遍四类取值，词表一改就会出现"工具面认、域层不认"的两份真值。
import { ORACLE_KINDS } from '../domain/evidence.js'
import type { OfficeCall } from '../office.js'
import {
  ADR_ACTIONS,
  COST_ACTIONS,
  DELIVER_ACTIONS,
  DESIGN_ACTIONS,
  FEASIBILITY_ACTIONS,
  GATE_ACTIONS,
  LANG_ACTIONS,
  PLAN_ACTIONS,
  PRIORITIES,
  PROJECT_ACTIONS,
  QUALITY_ACTIONS,
  REDTEAM_ACTIONS,
  REQUIREMENT_ACTIONS,
  REQUIREMENT_KINDS,
  REVIEW_ACTIONS,
  RISK_ACTIONS,
  SCALES,
  TASK_ACTIONS,
  TEST_ACTIONS,
  TRACE_ACTIONS,
  actionList,
} from '../types.js'
import type { Priority, RequirementKind, Scale } from '../types.js'
import { sessionIdOf } from '../interface/scope.js'

/** 工具行为依赖，由插件入口注入。 */
export interface LangArgs {
  action?: string | undefined
  lang?: string | undefined
}

/**
 * 门禁签字的**人机关口问答**通道（§7.2 来源②）。
 *
 * 工具自己把"是否签字"问给用户，并把**用户所选选项的原文**原样取回 ——
 * 引用文本因此不经过模型之手，这是本方案里"防代签"最关键的一环。
 * 宿主没装配该通道时返回 `undefined`（回执要求改用 `channel=statement` + 原话）。
 */
export interface GateSignAnswer {
  /** 用户所选选项的**原文**（直接落 basis，模型无法编造） */
  selectedLabel: string
  /** 用户自填的自由文本（选择"其他"时） */
  custom?: string | undefined
}

export interface OfficeToolDeps {
  init(call: OfficeCall, args: InitArgs): Promise<string>
  lang(call: OfficeCall, args: LangArgs): Promise<string>
  status(call: OfficeCall, args: { rebuild?: boolean | undefined }): Promise<string>
  project(call: OfficeCall, args: ProjectArgs): Promise<string>
  gate(call: OfficeCall, args: GateArgs): Promise<string>
  /**
   * 门禁签字的**人机关口问答**通道（§7.2 来源②）。
   *
   * 工具自己把"是否签字"问给用户，并把**用户所选选项的原文**原样取回 ——
   * 引用文本因此不经过模型之手，这是本方案里"防代签"最关键的一环。
   * 宿主没装配该通道时返回 `undefined`（回执要求改用 `channel=statement` + 原话）。
   */
  gateSignQuestion?(call: OfficeCall, gate: string): Promise<GateSignAnswer | undefined>
  feasibility(call: OfficeCall, args: FeasibilityArgs): Promise<string>
  risk(call: OfficeCall, args: RiskArgs): Promise<string>
  requirement(call: OfficeCall, args: RequirementArgs): Promise<string>
  redteam(call: OfficeCall, args: RedTeamArgs): Promise<string>
  render(call: OfficeCall, args: { target?: string | undefined }): Promise<string>
  design(call: OfficeCall, args: DesignArgs): Promise<string>
  adr(call: OfficeCall, args: AdrArgs): Promise<string>
  quality(call: OfficeCall, args: QualityArgs): Promise<string>
  trace(call: OfficeCall, args: TraceArgs): Promise<string>
  plan(call: OfficeCall, args: PlanArgs): Promise<string>
  task(call: OfficeCall, args: TaskArgs): Promise<string>
  test(call: OfficeCall, args: TestArgs): Promise<string>
  review(call: OfficeCall, args: ReviewArgs): Promise<string>
  deliver(call: OfficeCall, args: DeliverArgs): Promise<string>
  cost(call: OfficeCall, args: { action: string }): Promise<string>
}

export interface InitArgs {
  name?: string | undefined
  process?: string | undefined
  scale?: Scale | undefined
  scopeIn?: string[] | undefined
  scopeOut?: string[] | undefined
  stakeholders?: string[] | undefined
  /** 项目级界面面（§2.1）：comma-separated web/desktop/mobile */
  surfaces?: string[] | undefined
}

export interface ProjectArgs {
  action: string
  name?: string | undefined
  process?: string | undefined
  scale?: Scale | undefined
  scopeIn?: string[] | undefined
  scopeOut?: string[] | undefined
  stakeholders?: string[] | undefined
  metricsSuccess?: string[] | undefined
  /** JSON：{"术语":"定义"} */
  glossary?: Record<string, string> | undefined
  /** 项目级界面面（§2.1）：web / desktop / mobile */
  surfaces?: string[] | undefined
}

export interface GateArgs {
  action: string
  /** check / waive / sign 时的门禁 id（advance / rollback 不用） */
  gate?: string | undefined
  /** 人类签字（G2 的签字准则；advance 时也用于临时判定） */
  approvedBy?: string | undefined
  reason?: string | undefined
  approver?: string | undefined
  /** 螺旋流程：本圈风险结论（仅在 gate=GR 时使用） */
  conclusion?: 'continue' | 'adjust' | 'stop' | undefined
  /** 结论理由 */
  rationale?: string | undefined
  /**
   * **门禁签字来源通道**（§7.2）：
   *   · `statement` = 用户在会话中**明确表述**过签字确认（模型须给出 `quote` 原话，
   *     工具会拿去**会话记录**里核对，对不上即拒绝 —— 防模型凭空代签）；
   *   · `question`  = 走**人机关口问答**让用户亲自选（工具自己发问，不接受模型自述的引用）。
   */
  channel?: 'statement' | 'question' | undefined
  /** `channel=statement` 时的**用户原话引用**（必填） */
  quote?: string | undefined
  /** 会话轮次引用（可选，落 journal 便于审计） */
  turn?: string | undefined
  /** 阶段回退的目标阶段（action=rollback） */
  to?: string | undefined
  /**
   * 调用方 agent（**只为签字通道传**：人机关口问答必须带上活的 agent 才能问出去）。
   * 不解读它，原样交给 handler。
   */
  agent?: unknown
}

export interface FeasibilityArgs {
  action: string
  /** JSON：[{"dimension":"technical","verdict":"Go","rationale":"…"}] */
  telos?: string | undefined
  verdict?: 'go' | 'no-go' | 'conditional' | undefined
  rationale?: string | undefined
  /** JSON 字符串数组：PoC / 验证建议 */
  poc?: string | undefined
  by?: string | undefined
}

export interface RiskArgs {
  action: string
  id?: string | undefined
  title?: string | undefined
  level?: 'low' | 'medium' | 'high' | 'blocker' | undefined
  probability?: 'low' | 'medium' | 'high' | undefined
  impact?: string | undefined
  mitigation?: string | undefined
  owner?: string | undefined
  /** 关联来源（例如红队议题 REQ-ISSUE-001） */
  origin?: string | undefined
  status?: 'open' | 'mitigated' | 'closed' | undefined
  conclusion?: 'continue' | 'adjust' | 'stop' | undefined
  rationale?: string | undefined
}

export interface DesignArgs {
  action: string
  /** 视图：context | component | runtime | data | deployment | ui */
  kind?: string | undefined
  /** 元素 id（更新既有元素时给） */
  id?: string | undefined
  name?: string | undefined
  elementKind?: string | undefined
  responsibility?: string | undefined
  /** 逗号分隔的**元素名**（依赖谁） */
  dependsOn?: string | undefined
  summary?: string | undefined
  /** action=contract */
  producer?: string | undefined
  consumer?: string | undefined
  schema?: string | undefined
  contractKind?: string | undefined
  /**
   * **action=contract：本契约挂在哪条需求上**（DEF-056）：JSON **文本**或逗号分隔的需求 id。
   * 判据 `contract-test-missing` 用它判"这张卡有没有契约对象"—— 不写就等于该契约对所有卡都不算对象。
   */
  requires?: string | undefined
  timeout?: string | undefined
  retry?: string | undefined
  idempotency?: string | undefined
  approvedBy?: string | undefined
  note?: string | undefined
  by?: string | undefined
  reason?: string | undefined
  // —————————————— 增量 1：设计交互闭环 ——————————————
  /** action=grill：模型基于需求给出的**设计方法推荐**（§1.3 要求必须带推荐与理由） */
  method?: string | undefined
  /** action=grill：推荐理由 */
  rationale?: string | undefined
  /** action=grill：本轮最多新增几个问题（不填 = 一次给全） */
  round?: number | undefined
  /** action=answer：问题 id */
  questionId?: string | undefined
  /** action=answer：选项下标（0 基）或选项原文，也可以是自定义答复 */
  choice?: string | undefined
  /** action=answer：用户明确授权"按你的建议办"（未授权不得自问自答） */
  assume?: boolean | undefined
  /** action=confirm：元素/契约/界面条目 id */
  target?: string | undefined
  /** action=issues：open | all */
  state?: string | undefined
  /** view=create 时：界面视图 JSON（风格/页面/断点/无障碍） */
  ui?: string | undefined
  // —————————————— 增量 2：设计方法论方法包 ——————————————
  /** action=artifact：方法产物种类（dictionary|dfd|erd|classes|sequences|layers|debt|reversibility|increments） */
  artifactKind?: string | undefined
  /** action=confirm：用户授权原话（SDO-25：旧实现忽略它，事件里只能留下工具自己的文案） */
  basis?: string | undefined
  /** action=confirm：`user`（本人确认，默认）或 `proxy`（代盖）—— SDO-48 */
  basisSource?: string | undefined
  /** action=artifact：产物正文 JSON */
  artifactData?: string | undefined
  // —————————————— 界面线框图 / PlantUML 骨架 ——————————————
  /**
   * `action=render`：**可选**。`true` 走默认落点 `.sdo/design/ui.puml`，也可以给相对路径。
   *
   * ⚠️ 只写 `.puml` **骨架源码**（本仓库没有 PlantUML 渲染器，不出图）；不能是绝对路径或 `..`。
   */
  puml?: string | undefined
}

export interface AdrArgs {
  action: string
  id?: string | undefined
  title?: string | undefined
  context?: string | undefined
  decision?: string | undefined
  /** JSON：[{"option":"…","pros":"…","cons":"…"}] */
  alternatives?: string | undefined
  /** JSON：["…"] */
  consequences?: string | undefined
  /** 取代哪条 ADR */
  supersedes?: string | undefined
}

export interface QualityArgs {
  action: string
  attribute?: string | undefined
  stimulus?: string | undefined
  response?: string | undefined
  measure?: string | undefined
  priority?: 'high' | 'medium' | 'low' | undefined
  targets?: string | undefined
  /** action=evaluate：JSON 数组 */
  risks?: string | undefined
  sensitivities?: string | undefined
  tradeoffs?: string | undefined
  by?: string | undefined
}

export interface TraceArgs {
  action: string
  from?: string | undefined
  to?: string | undefined
  /** req-des | req-task | req-tc | des-task | des-ct */
  kind?: string | undefined
  /** JSON 数组：一次建多条边 */
  links?: string | undefined
}

export interface PlanArgs {
  action: string
  /** decompose：只拆这些需求（JSON 数组） */
  requirements?: string | undefined
  /** decompose：模型通道的卡片建议（**JSON 文本或数组**，见 schema 的 `oneOf` —— DEF-065） */
  suggestions?: unknown
  /** iteration：迭代目标 */
  goal?: string | undefined
  /** next：派发几条 */
  limit?: number | undefined
  /** next：**孤儿 TTL 覆盖（分钟）** —— 卡被未结算派发冻住时不必改 preset 重启（R-9） */
  orphanTtlMinutes?: number | undefined
  /** next：后端偏好 auto | subagent | native-team | inline */
  backend?: string | undefined
  /** action=next：**强制新起**子代理（不复用空闲者；真机上单一子代理被复用 19 轮至上下文耗尽） */
  freshChild?: boolean | undefined
  /** action=next：**只输出诊断**（SDO-54：真机上「见下」的 10 条诊断被看板淹没） */
  why?: boolean | undefined
  /** profile：选中的方法包（JSON 数组，取值见 CONSTRUCTION_PACKAGES） */
  packages?: string | undefined
  /** profile：范围 —— `all` 或任务 id 的 JSON 数组 */
  scope?: string | undefined
  /** profile：决策依据（JSON 数组；至少一条要能被机械核对） */
  derivedFrom?: string | undefined
  /** profile：给人看的理由 */
  reason?: string | undefined
  /** profile：逐检查项的豁免（JSON 数组：`{task, check, why, approvedBy?, impact?}` —— 后两键是 DEF-030 新增的必署名面） */
  exempt?: string | undefined
}

export interface TaskArgs {
  action: string
  id?: string | undefined
  owner?: string | undefined
  expectedRevision?: number | undefined
  /** done 的证据（JSON 数组：[{"kind":"artifact","detail":"…"}]） */
  evidence?: string | undefined
  note?: string | undefined
  /**
   * `release` / `reassign` / `block` 的说明，**以及 `unblock` 的必填恢复理由**（DEF-049 / TASK-078）。
   *
   * `unblock` 明确**不复用 `note`**：`note` 在 `block` 上是"阻塞原因"，两个语义落同一字段会让
   * 台账读不出因果（谁因何而停、又因何而复）。恢复理由必须进回执与 `task/unblocked` 事件。
   */
  reason?: string | undefined
  actor?: string | undefined
  /**
   * **`DEF-118`（第十三批 §1.2）**：`reopen` / `restore` 的**署名批准人**（与 `reason` 一样必填）。
   * 恢复是"向上改写历史"，没有理由/没有批准人就不许发生。
   */
  approvedBy?: string | undefined
  /** action=update：要改的字段（都给 JSON 数组/字符串；SDO-14(3)/SDO-15(3)） */
  title?: string | undefined
  dod?: string | undefined
  writeScopes?: string | undefined
  /**
   * **执行者自报的实际写入文件**（**DEF-016** 降级路径）：JSON 数组文本或真数组都收。
   * 子会话收不到宿主的 `workspace/changes`（上游能力边界）⇒ 用它把写范围对账从「人工比对」拉回机械核对。
   */
  reportedFiles?: string | unknown[] | undefined
  /**
   * **本次 `done` 未冻结的兄弟卡**（DEF-033 / 第三批 §3.13）：在飞卡 id 列表（JSON 文本或真数组）。
   * 逐条点名"哪些在飞卡的工作没有并进来" —— 每条必须**存在且当前确实在飞**，否则可读拒绝。
   */
  unfrozen?: string | unknown[] | undefined
  /**
   * **追加**写范围（DEF-012）：JSON 数组文本**或真数组**（宿主宽松路径）—— 与 `writeScopes` 互斥。
   * 语义（谁能追加 / 必须带 reason / 不得与在飞卡相交）在 `collab.updateTask` 里可读拒绝。
   */
  addWriteScopes?: string | unknown[] | undefined
  blockedBy?: string | undefined
  evidenceRequired?: string | undefined
  requirements?: string | undefined
  /**
   * **本卡声称修好的缺陷 id**（`DEF-050` / TASK-072）：JSON 数组文本，整份替换。
   * 校验（重复 / 空串 / 台账里不存在）在 `collab.updateTask` 里**可读拒绝**，不静默丢弃。
   */
  fixes?: string | undefined
  /** **本卡声明的变异自证条数**（DEF-027）：缺省 = 不声明。 */
  mutationExpected?: number | undefined
  /**
   * **本卡声称消除的风险 id**（`DEF-051` / TASK-080）：JSON 数组文本，整份替换。
   * 形状校验（重复 / 空串）在 `collab.updateTask` 里**可读拒绝**，不静默丢弃；
   * "台账里没有这条风险"不在这里拒绝（风险可能由同批另一张卡先登记），由判据 `C-64` 判红点名。
   */
  mitigates?: string | undefined
  /** **仍要开着的风险及其署名理由**（`DEF-051` / TASK-080）：JSON 数组文本，整份替换。 */
  mitigatesWaiver?: string | undefined
  /**
   * **本卡点名的影响面**（DEF-036 / §3E 族 1）：字符串或 JSON 数组文本，整份替换。
   * 形状校验（重复 / 空串）在 `collab.updateTask` 里**可读拒绝**，不静默丢弃；
   * "该声明却没声明"由拆卡期判据 `impact-undeclared` 判红点名（见 `updateTask` 的注释）。
   */
  impact?: string | unknown[] | undefined
  /** **影响面推不出来的显式声明**（DEF-036）：与 `impact` 二者有其一即视为已声明；空串 = 撤回。 */
  undecidable?: string | undefined
  /**
   * **update：本卡是否产出/改动「用户可见文案」**（DEF-055）：`true` ⇒ 判据 `ui-text-scope` 要求
   * 写范围含**项目声明的文案面**（`.sdo/config.yml` 的 `plan.textPaths`）；`false` = 撤回声明。
   */
  uiText?: boolean | undefined
  /**
   * **update：本卡声称要落地的路径**（DEF-018）：JSON **text** 或真数组；整份替换。
   * 由 `sdo_plan` 的判据 `landing-outside-scope` 逐条核对是否落在本卡写范围内。
   */
  landing?: string | unknown[] | undefined
  /**
   * **update：本卡要独占的窗口组名**（DEF-007）：同组同时只能有一张卡在跑。
   * 自由文本（插件不内置任何组名）；空串 = 撤回声明。
   */
  exclusive?: string | undefined
  size?: string | undefined
  /** verify-review：要核实的评审 id（`REV-*`） */
  review?: string | undefined
  /** verify-review：发现序号（**1 起**，与回执里印的「第 N 条」一致） */
  index?: number | undefined
  /** verify-review：核实结论 —— `reproduced`（复现）/ `refuted`（反驳，不采信该条） */
  outcome?: 'reproduced' | 'refuted' | undefined
  /** verify-review：复现命令与结果 / 反驳的反证（必填，空口核实不算） */
  proof?: string | undefined
  /** verify-review：允许覆盖同一 `(评审, 发现)` 上已有的核实（缺省拒绝再次核实，R-19 A） */
  revise?: boolean | undefined
}

export interface TestArgs {
  action: string
  title?: string | undefined
  kind?: 'unit' | 'integration' | 'e2e' | undefined
  requirement?: string | undefined
  /** plan：步骤（**JSON 文本或真数组**，见 schema 的 `oneOf` —— R11/§3.2）；`append`/`record` 路径同样收 */
  steps?: string | unknown[] | undefined
  expected?: string | undefined
  caseId?: string | undefined
  status?: string | undefined
  evidence?: string | undefined
  severity?: 'blocker' | 'major' | 'minor' | undefined
  /** defect：更新既有缺陷的状态时给 id */
  defectId?: string | undefined
  /** defect：更正原因 —— **原样写进 `defect/updated` 事件**（2026-10-07 追加实测：载荷曾被静默丢弃） */
  reason?: string | undefined
  // —————— §REQ-055（TASK-039）：缺陷**根因面**三字段 ——————
  // 这三个字段只在**新建**缺陷时可用（`DefectUpdate` 里没有它们 —— 域模型的边界不在本卡里动），
  // 因此 `action=defect` 且带 `defectId` 时给了它们会**可读拒绝**，而不是静默丢弃。
  /** defect：**根因**（REQ-055）—— 与缺陷一起落进 append-only 的 `defect/recorded` 事件；不给就不落键 */
  rootCause?: string | undefined
  /** defect：**发现级别**（词表 `DEFECT_DISCOVERY_LEVELS`：评审/单元/集成/系统/验收/生产）—— 取值非法判红并**点名合法集合** */
  discoveryLevel?: string | undefined
  /** defect：**是否逃逸**（本该被更早的验证面逮住却漏到后面）；只认真正的布尔值，认不出的不落键（**不假装 false**） */
  escaped?: boolean | undefined
  /**
   * **record：这条结论自称覆盖「全量」**（DEF-033 第三面 / 第四批 §3.5）。
   *
   * `done` 的语义是「本卡范围绿」，`unfrozen` 记下还有谁在飞 ⇒「全局冻结了没有」只能靠一次覆盖全量的跑来回答。
   * 哪条结论覆盖全量必须**结构化声明**（不许插件去认某条命令 —— DoD 明令不硬编码跑法）。
   * 判据 `defects.unfrozen-full-green`（C-67，G7）读它：有未冻结完成的卡时，要有一条晚于最后一次这类 `done`
   * 的 `pass` + `fullSuite` 结论。
   */
  fullSuite?: boolean | undefined
  // —————— §DEF-038（TASK-063）：**免责依据**两字段 ——————
  // 与根因面三字段**同族同纪律**（可选、空串不落键、逐字段搬进域层），但**更新路径上受理**
  // （`DefectUpdate` 也有它们）：根因是"怎么进来的"（历史事实，事后改＝篡改），免责依据是
  // "现在要不要放过它、谁拍的板"（一个**决定**，本就会被补、被改、被撤销）。契约见
  // `src/domain/records.ts` 的 `DefectUpdate` 注释。
  /** defect：**免责理由**（"为什么不修"，DEF-038）—— 与 `waiveApprovedBy` 齐备才算阻塞级 wontfix 的免责成立；`status≠wontfix` 时**读了也白读**（判据不读这两字段） */
  waiveReason?: string | undefined
  /** defect：**免责批准人**（谁批准不修，DEF-038）—— 与 `waiveReason` 缺一不可；空白串会被**可读拒绝**（空串不等于填了） */
  waiveApprovedBy?: string | undefined
  // —————— §REQ-053（TASK-039）：结果的**执行者 / 采纳者** ——————
  /** record：**执行者**（REQ-053）—— 独立性判据的一端，进 append-only 的 `test/recorded` 事件 */
  executedBy?: string | undefined
  /** record：**采纳者**（REQ-053）—— 与执行者不同才算独立采纳；给了就由记录端盖上采纳时刻 */
  adoptedBy?: string | undefined
  /** env/record：**环境指纹**（SDO-57），如 `jdk=21.0.2; probe=run_checks.py@v3` */
  env?: string | undefined
  /** record：**被检产物**（相对路径）——记录时绑定 sha256，交付时重算比对 */
  artifact?: string | undefined
  /**
   * record：**调用方手里那个哈希**（DEF-011）：给了就必须与现算值一致（不一致 ⇒ 可读拒绝并点名两值），
   * 一致 ⇒ 记它；不给 ⇒ 由插件现算（旧行为）。
   */
  artifactSha256?: string | undefined
  /**
   * record：**这条结论依据于哪些已修缺陷**（DEF-075）：缺陷 id 列表（JSON 文本或数组，如
   * `["DEF-001","DEF-002"]`）。绑上一条 `pass` 结论 ⇒ 该 `fixed` 缺陷才算有依据；未知 id 会被可读拒绝。
   */
  defects?: unknown
  /** record：**断言面指纹**（R-3）—— 红与绿必须同指纹，否则"改断言转绿"与"改实现转绿"无法区分 */
  harness?: string | undefined
  /**
   * plan / record：**判定基准来源（oracle）**（REQ-054）。
   *
   * JSON 字符串（复合参数一律字符串化 —— 工具 schema 上不嵌套对象）：
   *   · `{"kind":"acceptance","ref":"REQ-054","criterion":"AC-212"}`（AC 编号须属于该需求）
   *   · `{"kind":"contract","ref":"CT-001"}`（契约须存在且有失败语义）
   *   · `{"kind":"baseline","ref":"dist/old.js","baselineSha256":"<64 位十六进制>"}`（**现算比对**）
   *   · `{"kind":"expert","expert":"张三"}`（须写明判断人）
   *
   * `record` 时它是**结果级**判定基准（同一条用例换环境要改判时用它）；没给就回落到用例上
   * 登记的那份 —— 回落顺序 `result.oracle ?? testCase.oracle` 只有 `isAdopted()` 一处实现。
   */
  oracle?: string | undefined
  /** record：进度 3 的**变异自证**交付物（JSON 对象：{task, tool, target?, killed, survived?}） */
  mutation?: string | undefined
  /** record：增量 3 的**契约测试**交付物（JSON 对象：{task, contract, tool, cmd}） */
  contractTest?: string | undefined
}

export interface ReviewArgs {
  action: string
  taskId?: string | undefined
  reviewer?: string | undefined
  verdict?: 'pass' | 'changes-requested' | 'reject' | undefined
  /** record / append：发现项（**JSON 文本或数组**，见 schema 的 `oneOf` —— DEF-065）；`append` 只收**新增**的那些 */
  findings?: unknown
  /** rehash：要给哪条**老格式**评审补记内容指纹（`REV-*`）；append：追加到哪条**既有**评审（`REV-*`） */
  id?: string | undefined
  /** rehash / append：补记人 / 追加者（缺省 human） */
  actor?: string | undefined
  /**
   * **append：本次补录的是原文的第几条**（DEF-072，1 起）：与 `originalTotal` **必须成对**。
   * 声明之后，"重号 / 跳号 / 超界"在写盘前被**可读拒绝**；不声明 = 维持旧口径（存量不追溯）。
   */
  originalIndex?: number | undefined
  /** **append：原文（来源评审）共几条**（DEF-072）：与 `originalIndex` 成对，用来判超界。 */
  originalTotal?: number | undefined
  /**
   * **record：一条当前仍然失败的复现命令**（DEF-048）：非 `pass` 的待修主张**二选一**必填之一 ——
   * 后人照着跑就能看见"现在还坏着"，不再靠"当时确实坏了"的口头记忆。
   */
  repro?: string | undefined
  /** **record：显式声明"无法复现"+为什么**（DEF-048）：与 `repro` 二选一（两个都给会被可读拒绝）。 */
  unreproducible?: string | undefined
  /**
   * **record：这条评审点名的缺陷**（DEF-076 / 第四批 §3.3，一个或多个）：`DEF-*`。
   *
   * 为什么必须有：缺陷的"已评审"过去**没有结构化真源**（评审只能绑卡）⇒ `fixed` 缺陷可以跳过评审直接
   * 拿 `pass` 测试结论并 `closed`。每个 id 必须**真实存在**（否则可读拒绝、零写盘）；门禁
   * `defects.fixed-reviewed`（C-66）据此判「先评审、后测试」。
   */
  defectId?: string | unknown[] | undefined
}

export interface DeliverArgs {
  action: string
  /** action=run：运行目标（server / client / desktop / device…）—— 通用系统同样适用 */
  target?: string | undefined
  /** action=run：真实执行的命令（要可复跑） */
  command?: string | undefined
  /** action=run：pass | fail */
  outcome?: string | undefined
  /** action=run：运行证据（日志路径 / 截图 / 人工确认说明） */
  evidence?: string | undefined
  /** action=run：被运行的产物（相对路径）—— 记录时**绑定当时的 sha256** */
  artifact?: string | undefined
  /** action=run：**调用方手里那个哈希**（DEF-011）：一致 ⇒ 记它；不一致 ⇒ 可读拒绝并点名两值 */
  artifactSha256?: string | undefined
  /** action=run：退出码（有就写） */
  exitCode?: string | undefined
  /** action=package：本次交付要求覆盖的真机运行目标（如 "server,client"） */
  runsRequired?: string | undefined
  /** JSON：[{"path":"src/x.ts","kind":"source"}] */
  artifacts?: string | undefined
  /** JSON：[{"requirement":"REQ-001","criterion":"…","evidence":"…","verdict":"pass"}] */
  acceptance?: string | undefined
  rollbackPoint?: string | undefined
  by?: string | undefined
  notes?: string | undefined
}

export interface RequirementArgs {
  action: string
  id?: string | undefined
  title?: string | undefined
  statement?: string | undefined
  rationale?: string | undefined
  kind?: RequirementKind | undefined
  priority?: Priority | undefined
  sourceStakeholder?: string | undefined
  sourceRaw?: string | undefined
  /** JSON：{"goal":2,...} 八维语义分（模型通道） */
  dimensions?: string | undefined
  /** JSON：[{"given":"","when":"","then":""}] 追加的验收标准 */
  acceptance?: string | undefined
  /** `append`（默认，追加）或 `replace`（整份替换，用于改号/删除存量验收标准 —— R-2） */
  acceptanceMode?: string | undefined
  answer?: string | undefined
  pickedOption?: number | undefined
  assume?: boolean | undefined
  /** 记为\"假设\"时必须为 true（表示**用户授权**，否则拒绝） */
  authorizedByUser?: boolean | undefined
  /** 回答者（默认 human） */
  by?: string | undefined
  /** 基线签字人（人类） */
  approvedBy?: string | undefined
  /** 来源：`prototype` 表示原型回填；否则视为干系人 id（STK-xx） */
  source?: string | undefined
  /** 变更理由（action=change） */
  reason?: string | undefined
  /** 变更决策（action=change）：approved 才应用 */
  decision?: 'approved' | 'rejected' | 'deferred' | undefined
  decidedBy?: string | undefined
  limit?: number | undefined
  quick?: boolean | undefined
  // —————— §7.1 设计适用性声明（需求阶段产出） ——————
  /** 声明：本项目性质与设计重点（自由文本，模型起草） */
  focus?: string | undefined
  /** 声明要做的视图（JSON 数组：["context","component",…]） */
  viewsPresent?: string | undefined
  /** 声明不做的视图 + 理由（JSON 数组：[{"kind":"data","why":"…"}]） */
  viewsAbsent?: string | undefined
  /** 声明必需的非视图工件（JSON 数组：["invariants","mapping","diffVerify"]） */
  artifacts?: string | undefined
  /**
   * 声明**不做**的非视图工件 + 理由（D5；JSON 数组：[{"kind":"mapping","why":"…"}]）。
   * 与 `viewsAbsent` 同口径：逐条 `why` 必填，缺理由 C-2C 判红。
   */
  artifactsAbsent?: string | undefined
  /** 用户签字绑定声明的依据（用户原话／所选选项原文；action=applicability-confirm 必填） */
  basis?: string | undefined
}

export interface RedTeamArgs {
  action: string
  ids?: string[] | undefined
  limit?: number | undefined
  reason?: string | undefined
  requirementId?: string | undefined
  questions?: string | undefined
  /** **D-5**：`action=dispose` 要处置的议题 id（`REQ-ISSUE-00x`） */
  id?: string | undefined
  /** **D-5**：处置去向 —— 转为风险 / 回到需求 */
  disposition?: string | undefined
  /** **D-5**：处置理由（写入议题文件与 `issue/closed`） */
  note?: string | undefined
}

/** 从一次工具执行里取出调用上下文（会话身份 + 不透明的 agent 引用，后者供 plan mode 适配器用）。 */
export function callOf(exec: ToolRunContext): OfficeCall {
  const agent = exec.agent
  if (agent === undefined) return {}
  // cwd 尽量从 agent 上现取（比"创建会话时记录"更新、更可靠），多处字段容错
  // **实测结论（dsh-agent 0.2.0-rc.1）**：Agent 上**没有** `cwd`/`workspace.cwd`/`session.cwd`；
  // 会话工作目录在 `agent.session.header.cwd`。此前读错字段 → 工作区恒为 undefined
  // （症状：requireWorkspace 抛「无法确定本会话的工作区」）。旧字段作为兜底保留，代价为零。
  const holder = agent as unknown as {
    cwd?: unknown
    workspace?: { cwd?: unknown }
    session?: { cwd?: unknown; header?: { cwd?: unknown } }
  }
  const cwd = [holder.session?.header?.cwd, holder.cwd, holder.workspace?.cwd, holder.session?.cwd].find(
    (value): value is string => typeof value === 'string' && value !== '',
  )
  // 会话 id 与采集/归属**读同一个字段**（见 sessionIdOf）；取不到就**省略**，绝不写 "undefined"
  const sessionId = sessionIdOf(agent)
  return { ...(sessionId === undefined ? {} : { sessionId }), agent, ...(cwd === undefined ? {} : { cwd }) }
}

/** 宽松解析枚举；非法值返回 undefined（由行为层决定是否报错）。 */
export function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

export function parseScale(value: unknown): Scale | undefined {
  return parseEnum(value, SCALES)
}

/** 把逗号/分号分隔的文本解析为列表（中文标点也接受）。 */
export function parseList(value: unknown): string[] | undefined {
  // **R-18**：`["a","b"]` 这种 JSON 文本不许被逗号切碎（真机：`dod` 用数组传被拒、用 JSON 文本传才对，
  // 而 JSON 文本到了这里又会被逗号切开 ⇒ 两头都不对）
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.startsWith('[') && text.endsWith(']')) {
      const parsed = parseJson<unknown>(text)
      if (Array.isArray(parsed)) {
        const items = parsed.map((item) => String(item).trim()).filter((item) => item !== '')
        return items.length > 0 ? items : undefined
      }
    }
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value
    .split(/[,，;；]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * **复合参数归一**（R-18，sdo-test-new 2026-10-08）：schema 声明的是 **JSON 文本**（`type: 'string'`），
 * 但宿主在某些路径上会把**数组原样透传**（真机：同一调用时好时坏 —— 按 schema 校验时返回
 * `invalid arguments: "x" must be a string`，宽松时数组到达插件又被 `typeof === 'string'` 静默丢弃）。
 * 两种形态都收：字符串原样、数组转成 JSON 文本交下游解析。
 */
export function compositeArg(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return JSON.stringify(value)
  return undefined
}

/** 解析 JSON 字符串参数；**也接受已经解好的对象/数组**（宿主宽松路径）；失败返回 undefined。 */
export function parseJson<T>(value: unknown): T | undefined {
  if (typeof value === 'object' && value !== null) return value as T
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

const OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

/** 创建 SDO 的工具定义数组。 */
/**
 * **注册出口的列表参数归一**（DEF-073；DEF-077 起按声明推导）：调用面把真数组转成 JSON 文本。
 *
 * 为什么不逐个手改声明、也不在 `defineTool` 处包一层：前者必然分叉（历史上只改了
 * `findings`/`suggestions`），后者会把 `defineTool` 的**字面量 schema 推断**打塌（实测塌成 `never`）。
 * 这里是工具定义**建好之后、注册之前**的唯一出口，类型面最小。
 * **归一集合**由 {@link listParamNames} 从各工具**已声明的** `properties` 推导 —— 不再有人工名单。
 */
function withListParamTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => {
    const schema = tool.parameters as unknown as { properties?: Record<string, unknown> } & Record<string, unknown>
    if (schema === null || typeof schema !== 'object' || schema.properties === undefined) return tool
    const names = listParamNames(schema.properties)
    const original = tool.execute as unknown as (args: Record<string, unknown>, ctx: ToolRunContext) => unknown
    return {
      ...tool,
      parameters: tool.parameters,
      execute: ((args: Record<string, unknown>, ctx: ToolRunContext) =>
        original(withListArgs(args, names), ctx)) as ToolDefinition['execute'],
    }
  })
}

export function createOfficeTools(deps: OfficeToolDeps): ToolDefinition[] {
  const asArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined

  const tools: ToolDefinition[] = [
    defineTool({
      name: 'sdo_init',
      description: t('tool.sdo_init'),
      parameters: {
        name: { type: 'string', description: t('param.name') },
        process: { type: 'string', description: "Process: 'waterfall' (default), 'prototype', 'agile' or 'spiral'." },
        scale: { type: 'string', description: "Scale: 'trivial', 'normal' (default) or 'critical'. Drives tailoring and the red-team default." },
        scopeIn: { type: 'string', description: t('param.scopeIn') },
        scopeOut: { type: 'string', description: t('param.scopeOut') },
        stakeholders: { type: 'string', description: t('param.stakeholders') },
        surfaces: { type: 'string', description: t('param.surfaces') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.init(callOf(exec), {
          name: typeof args.name === 'string' ? args.name : undefined,
          process: typeof args.process === 'string' ? args.process : undefined,
          scale: parseScale(args.scale),
          scopeIn: parseList(args.scopeIn),
          scopeOut: parseList(args.scopeOut),
          stakeholders: parseList(args.stakeholders),
          surfaces: parseList(args.surfaces),
        })
      },
    }),

    defineTool({
      name: 'sdo_lang',
      description: t('tool.sdo_lang'),
      parameters: {
        action: { type: 'string', required: true, description: `${actionList(LANG_ACTIONS)} ${t('param.langAction')}` },
        lang: { type: 'string', description: t('param.lang') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.lang(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'show',
          lang: typeof args.lang === 'string' ? args.lang : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_status',
      description: t('tool.sdo_status'),
      parameters: {
        rebuild: { type: 'boolean', description: t('param.rebuild') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.status(callOf(exec), { rebuild: args.rebuild === true })
      },
    }),

    defineTool({
      name: 'sdo_project',
      description: t('tool.sdo_project'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(PROJECT_ACTIONS) },
        name: { type: 'string', description: t('param.name') },
        process: { type: 'string', description: "Process: 'waterfall' | 'prototype' | 'agile' | 'spiral'." },
        scale: { type: 'string', description: "Scale: 'trivial' | 'normal' | 'critical' (drives tailoring and the red-team default)." },
        scopeIn: { type: 'string', description: t('param.scopeIn') },
        scopeOut: { type: 'string', description: t('param.scopeOut') },
        stakeholders: { type: 'string', description: t('param.stakeholders') },
        metricsSuccess: { type: 'string', description: t('param.metricsSuccess') },
        glossary: { type: 'string', description: t('uiTools.k1') },
        surfaces: { type: 'string', description: t('param.surfaces') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const parsed = parseJson<Record<string, string>>(args.glossary)
        return deps.project(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'show',
          name: typeof args.name === 'string' ? args.name : undefined,
          process: typeof args.process === 'string' ? args.process : undefined,
          scale: parseScale(args.scale),
          scopeIn: parseList(args.scopeIn),
          scopeOut: parseList(args.scopeOut),
          stakeholders: parseList(args.stakeholders),
          metricsSuccess: parseList(args.metricsSuccess),
          glossary: parsed,
          surfaces: parseList(args.surfaces),
        })
      },
    }),

    defineTool({
      name: 'sdo_requirement',
      description: t('tool.sdo_requirement'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(REQUIREMENT_ACTIONS) },
        id: { type: 'string', description: t('param.id') },
        title: { type: 'string', description: t('param.title') },
        statement: { type: 'string', description: t('uiTools.k2') },
        rationale: { type: 'string', description: t('param.rationale') },
        kind: { type: 'string', description: "'functional' (default) | 'quality' | 'constraint' | 'ui' (declares a UI/screen surface; drives the UI gate)." },
        priority: { type: 'string', description: "MoSCoW: 'must' | 'should' | 'could' | 'wont'. Required for DoR." },
        sourceStakeholder: { type: 'string', description: t('param.sourceStakeholder', 'Stakeholder id such as STK-01 (traceability source).') },
        sourceRaw: listDecl(t('param.sourceRaw', 'The raw ask, in the requester\'s own words.')),
        dimensions: listDecl('JSON object of the eight semantic dimension scores, e.g. {"goal":2,"user":1,...}. The deterministic rule channel caps these; stricter wins. **Two failure shapes**: (1) *wrong shape* (not valid JSON: not an array, stray comma, bare newline in a string) => reported as a shape error; (2) *value cut off* (an unescaped ASCII quote inside the value - by far the most common here, since citing identifiers/commands/paths needs quotes) => the error names the character position. **Recommended**: use CJK quotes (or escape per JSON rules) inside values, never bare ASCII quotes; and do not send several long JSON arguments in one message (that also interrupts the call).'),
        acceptance: listDecl('JSON **text** (a string), e.g. \'[{"given":"…","when":"…","then":"…"}]\' — not an array. Consumed by action=capture, action=update and action=change (a change request may carry acceptance criteria; they are applied only when decision=approved). **Two failure shapes**: (1) *wrong shape* (not valid JSON: not an array, stray comma, bare newline in a string) => reported as a shape error; (2) *value cut off* (an unescaped ASCII quote inside the value - by far the most common here, since citing identifiers/commands/paths needs quotes) => the error names the character position. **Recommended**: use CJK quotes (or escape per JSON rules) inside values, never bare ASCII quotes; and do not send several long JSON arguments in one message (that also interrupts the call).'),
        acceptanceMode: { type: 'string', enum: ['append', 'replace'], description: 'How `acceptance` is applied: append (default) or replace (use replace to renumber/remove existing criteria, e.g. when C9 reports duplicate AC ids). Honoured by action=update and action=change.' },
        limit: { type: 'number', description: t('param.limit') },
        quick: { type: 'boolean', description: t('param.quick') },
        answer: { type: 'string', description: t('param.answer') },
        pickedOption: { type: 'number', description: t('param.pickedOption', 'Zero-based index of the chosen option; recorded together with the answer.') },
        assume: { type: 'boolean', description: t('param.assume') },
        authorizedByUser: { type: 'boolean', description: t('uiTools.k3') },
        by: { type: 'string', description: 'Who answered (default "human").' },
        approvedBy: { type: 'string', description: t('param.approvedBy') },
        source: { type: 'string', description: "Provenance: 'prototype' marks the requirement as backfilled from a throwaway prototype (design §7.2); any other value is treated as a stakeholder id such as STK-01." },
        reason: { type: 'string', description: t('param.reason') },
        decision: { type: 'string', description: "Change decision (action=change): 'approved' applies the change; 'rejected'/'deferred' only files the request." },
        decidedBy: { type: 'string', description: t('param.decidedBy') },
        focus: { type: 'string', description: t('uiTools.kApplicabilityFocus') },
        viewsPresent: { type: 'string', description: t('uiTools.kApplicabilityPresent') },
        viewsAbsent: { type: 'string', description: t('uiTools.kApplicabilityAbsent') },
        artifacts: listDecl(t('uiTools.kApplicabilityArtifacts')),
        artifactsAbsent: { type: 'string', description: t('uiTools.kApplicabilityArtifactsAbsent') },
        basis: { type: 'string', description: t('uiTools.kApplicabilityBasis') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.requirement(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          id: typeof args.id === 'string' ? args.id : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          statement: typeof args.statement === 'string' ? args.statement : undefined,
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
          kind: parseEnum(args.kind, REQUIREMENT_KINDS),
          priority: parseEnum(args.priority, PRIORITIES),
          sourceStakeholder: typeof args.sourceStakeholder === 'string' ? args.sourceStakeholder : undefined,
          sourceRaw: typeof args.sourceRaw === 'string' ? args.sourceRaw : undefined,
          dimensions: typeof args.dimensions === 'string' ? args.dimensions : undefined,
          acceptance: typeof args.acceptance === 'string' ? args.acceptance : undefined,
          acceptanceMode: typeof args.acceptanceMode === 'string' ? args.acceptanceMode : undefined,
          answer: typeof args.answer === 'string' ? args.answer : undefined,
          pickedOption: typeof args.pickedOption === 'number' ? args.pickedOption : undefined,
          assume: args.assume === true,
          authorizedByUser: args.authorizedByUser === true,
          by: typeof args.by === 'string' ? args.by : undefined,
          approvedBy: typeof args.approvedBy === 'string' ? args.approvedBy : undefined,
          source: typeof args.source === 'string' ? args.source : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          decision: parseEnum(args.decision, ['approved', 'rejected', 'deferred'] as const),
          decidedBy: typeof args.decidedBy === 'string' ? args.decidedBy : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          quick: args.quick === true,
          focus: typeof args.focus === 'string' ? args.focus : undefined,
          viewsPresent: typeof args.viewsPresent === 'string' ? args.viewsPresent : undefined,
          viewsAbsent: typeof args.viewsAbsent === 'string' ? args.viewsAbsent : undefined,
          artifacts: typeof args.artifacts === 'string' ? args.artifacts : undefined,
          artifactsAbsent: typeof args.artifactsAbsent === 'string' ? args.artifactsAbsent : undefined,
          basis: typeof args.basis === 'string' ? args.basis : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_redteam',
      description: t('tool.sdo_redteam'),
      parameters: {
        action: { type: 'string', required: true, description: `${actionList(REDTEAM_ACTIONS)} ${t('param.redteamAction')}` },
        requirementId: { type: 'string', description: t('param.requirementId') },
        questions: { type: 'string', description: t('param.questions') },
        ids: { type: 'string', description: t('param.ids', 'Comma-separated requirement ids to attack (default: all requirements).') },
        limit: { type: 'number', description: t('param.limit') },
        reason: { type: 'string', description: t('param.reason') },
        id: { type: 'string', description: t('param.issueId', 'Issue id to dispose (only action=dispose): REQ-ISSUE-001.') },
        disposition: { type: 'string', description: t('param.disposition', "Where the issue goes: 'risk' (converted into a risk) or 'requirement' (settled back into the requirements). Only action=dispose.") },
        note: { type: 'string', description: t('param.disposeNote', 'Why it is disposed — written into the issue file and the `issue/closed` event. Only action=dispose.') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.redteam(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'status',
          ids: asArray(args.ids) ?? parseList(args.ids),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          requirementId: typeof args.requirementId === 'string' ? args.requirementId : undefined,
          questions: typeof args.questions === 'string' ? args.questions : undefined,
          id: typeof args.id === 'string' ? args.id : undefined,
          disposition: typeof args.disposition === 'string' ? args.disposition : undefined,
          note: typeof args.note === 'string' ? args.note : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_render',
      description: t('tool.sdo_render'),
      parameters: {
        target: {
          type: 'string',
          description:
            "What to render: 'srs' (default, requirements spec), 'decisions' (ADR log → docs/DECISIONS.md), 'quality' (quality scenarios + ATAM → docs/QUALITY.md).",
        },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.render(callOf(exec), { target: typeof args.target === 'string' ? args.target : undefined })
      },
    }),

    defineTool({
      name: 'sdo_plan',
      description: t('tool.sdo_plan'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(PLAN_ACTIONS) },
        requirements: listDecl(t('param.requirements')),
        // **DEF-065 落点一**：`suggestions` / `findings` 原先声明成 `type: 'string'`，于是**数组形态在
        // 宿主 schema 校验阶段就被拒**（`ToolArgsError: invalid arguments: "suggestions" must be a string`），
        // 插件**收不到那次调用** —— 调用方看到的是"写不进去"，台账里连痕迹都没有。
        // 宿主 schema 子集**支持 `oneOf`**（`dsh-tools` 的 `assertSupportedJsonSchema`：`type`/`oneOf`/
        // `properties`/`required`/`additionalProperties`/`items`/`enum`/`const` + 注解；
        // 且 `compilePropertyMap` 允许属性节点带 `required` + `oneOf`）⇒ 这里**声明联合**：
        // 分支一是 JSON 文本（本仓的既有口径），分支二是数组（宿主宽松路径的真实形态）。
        // 两分支互斥，恰好命中一个（字符串不会同时是数组），下游仍由 `compositeArg` 归一。
        // **R11（第五批 §3.3）**：手写 `oneOf` → `listDecl`（行为一字不变，只是把"列表记号"统一到一处，
        // 消费面推导判据按这个记号核；`DEF-065` 当时就是手写的，所以它一直没进统一口径）。
        suggestions: listDecl(t('param.suggestions')),
        goal: { type: 'string', description: t('param.goal') },
        limit: { type: 'number', description: t('param.limit') },
        orphanTtlMinutes: { type: 'number', description: 'next: override the orphan dispatch TTL (minutes) for this call — a card held by an unsettled dispatch becomes dispatchable without editing the preset (R-9).' },
        backend: { type: 'string', description: "next: 'auto' | 'subagent' | 'native-team' | 'inline'." },
        freshChild: { type: 'boolean', description: t('param.planFreshChild') },
        why: { type: 'boolean', description: 'next: print ONLY the diagnostics (no board) — use it when nothing was dispatched and you need the reason.' },
        // `profile` 动作的入参（增量 3 的**决策入口**）：与 `TestArgs` 同理 —— 工具边界上没有的字段会被静默丢掉。
        packages: listDecl("profile: JSON **text** (a string) of method packages to enable, e.g. '[\"tdd\",\"contract-first\"]'. Empty array = explicit opt-out (then `reason` is required). Not an array."),
        scope: listDecl("profile: 'all' (default) or JSON **text** (a string) of task ids, e.g. '[\"TASK-001\"]' — a real array is also accepted."),
        derivedFrom: listDecl("profile: JSON **text** (a string) of the basis for the choice, e.g. '[\"scale=normal\",\"contractCount=12\"]'; at least one must be machine-checkable. Not an array."),
        reason: { type: 'string', description: 'profile: human-readable reason for the choice (required when `packages` is empty).' },
        exempt: listDecl("profile: JSON **text** (a string) of per-check exemptions, e.g. '[{\"task\":\"TASK-007\",\"check\":\"tdd-mutation-missing\",\"why\":\"docs-only card\",\"approvedBy\":\"who approved this exemption\",\"impact\":\"what this waiver gives up\"}]'. `approvedBy` and `impact` are the two keys **DEF-030** added and both are **plain strings** (unlike `impact` on a task card, which is a list): a **new** exemption **must carry both** — a missing key, a non-string value or a blank string makes the whole call **rejected** with a readable message naming the entry and the missing field, and **nothing is written** (the write face enforces it). **Older** entries are read tolerantly on the **read** face (a missing key reads as an empty string and the receipt shows it as unsigned) — tolerance is for history, never for what you write today."),
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.plan(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'next',
          freshChild: args.freshChild === true,
          why: args.why === true,
          requirements: typeof args.requirements === 'string' ? args.requirements : undefined,
          // **DEF-065 同族第二处**：旧写法 `typeof args.suggestions === 'string' ? args.suggestions : undefined`
          // 会在**数组原样到达**时把它**静默丢成 undefined**（宿主宽松路径的真实形态，回执看不出）。
          // 统一走本文件既有的 `compositeArg`（字符串原样 / 数组转 JSON 文本）—— 与 `findings` 同源，不另造第二份归一。
          suggestions: compositeArg(args.suggestions),
          goal: typeof args.goal === 'string' ? args.goal : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          orphanTtlMinutes: typeof args.orphanTtlMinutes === 'number' ? args.orphanTtlMinutes : undefined,
          backend: typeof args.backend === 'string' ? args.backend : undefined,
          // profile 动作的入参：**必须逐字段搬进来**（漏一行 = 工具层静默丢弃；B1 与 PLAN-1 都是这么死的）
          packages: typeof args.packages === 'string' ? args.packages : undefined,
          scope: typeof args.scope === 'string' ? args.scope : undefined,
          derivedFrom: typeof args.derivedFrom === 'string' ? args.derivedFrom : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          exempt: typeof args.exempt === 'string' ? args.exempt : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_task',
      description: t('tool.sdo_task'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(TASK_ACTIONS) },
        title: { type: 'string', description: 'update: new title.' },
        dod: listDecl('update: JSON **text** of DoD items, e.g. \'["a","b"]\' — or a real array (the declaration accepts both).'),
        writeScopes: listDecl('update: JSON **text** of write scopes, e.g. \'["lib/"]\' (refused while another owner is working the card). Do NOT pass an array.'),
        addWriteScopes: listDecl("update: **append** write scopes instead of replacing them (DEF-012). Accepts a JSON text like '[\"src/domain/\"]' or a real array. Allowed while the card is in progress, for the process officer (human/office/cockpit) or the card owner, and **requires `reason`**. The appended paths must not intersect any in-progress card's scopes (that would create two writers) — rejected with the overlapping path named. Full replacement via `writeScopes` still requires releasing first."),
        blockedBy: listDecl('update: JSON **text** of blocking task ids, e.g. \'["TASK-001"]\' (supports ["*"] = after every other card). Do NOT pass an array.'),
        evidenceRequired: listDecl('update: JSON **text** of required evidence kinds, e.g. \'["command"]\'. Do NOT pass an array.'),
        unfrozen: listDecl('done: JSON **text** (or a real array) of the sibling cards whose work is **not frozen into this completion** (DEF-033), e.g. \'["TASK-002"]\'. `done` means *this card scope is green* — not *the whole project is frozen*. Every in-flight sibling must be named here: an unknown id, a card that is no longer in progress, this card itself, or an in-flight sibling you leave out makes the whole call **rejected with a readable message naming the ids** and **nothing is written** (omitting `unfrozen` while a sibling is in flight is rejected too — declare it, or wait for it to settle).'),
        reportedFiles: listDecl('done: JSON **text** (or a real array) of the files this session actually wrote — the host does not announce workspace/changes for child sessions (upstream limit, DEF-016), so the write-scope reconciliation uses this **self-report**; the receipt always says it is a self-report and never claims host observation.'),
        requirements: listDecl('update: JSON **text** (a string) of requirement ids, e.g. \'["REQ-001"]\' — not an array. **Two failure shapes**: (1) *wrong shape* (not valid JSON: not an array, stray comma, bare newline in a string) => reported as a shape error; (2) *value cut off* (an unescaped ASCII quote inside the value - by far the most common here, since citing identifiers/commands/paths needs quotes) => the error names the character position. **Recommended**: use CJK quotes (or escape per JSON rules) inside values, never bare ASCII quotes; and do not send several long JSON arguments in one message (that also interrupts the call).'),
        fixes: listDecl('update: JSON **text** (a string) of the defect ids this card claims to fix, e.g. \'["DEF-050"]\' — not an array. Replaces the whole declaration (an empty array withdraws it). Each entry must be an existing `DEF-xxx` id; a duplicate, a blank string or an unknown id is **rejected with a readable message** (never silently dropped). Criterion C-63 then requires every such defect to be `fixed`/`closed`, or `wontfix` with both `waiveReason` and `waiveApprovedBy` filled in (the DEF-038 basis) once this card reaches done/verified.'),
        mutationExpected: { type: 'number', description: t('param.mutationExpected') },
        // **R11（第五批 §3.3）**：列表形态的**显式记号**统一成 `listDecl`（原先这里手写 `oneOf`）——
        // 消费面推导判据（`test/m176` M176-05）按"`compositeArg(args.<名>)` ⇒ 声明处必须是 `listDecl(`"核，
        // 记号不统一就会让判据把这一类误判成"没声明"（手写 oneOf 与 listDecl 的行为一模一样）。
        impact: listDecl('update: the **impact surface** this card names (DEF-036) — the files/cases its change will affect. Accepts a JSON text like \'["test/m94.test.ts"]\' or a real array. Replaces the whole declaration; a blank or duplicate entry is **rejected with a readable message** (never silently dropped). The plan criterion `impact-undeclared` is red while a card that changes existing behaviour (it declares `fixes`, or its write scope intersects an already landed card) names neither `impact` nor `undecidable` — so scan the call sites of what you are changing first and list the fixtures/guards that can turn red.'),
        undecidable: {
          type: 'string',
          description:
            'update: an explicit **cannot-be-determined** declaration for the impact surface (DEF-036), reused verbatim from the change-request vocabulary: state **why** the affected files/cases cannot be worked out. Either `impact` or this one satisfies the criterion; defaulting to «no impact» is not allowed. An empty string **withdraws** the declaration.',
        },
        landing: listDecl('update: the **landing paths this card claims it will write** (DEF-018), given as JSON **text** (e.g. \'["src/domain/plan.ts"]\') or as a real array. Replaces the whole declaration. Plan criterion `landing-outside-scope` reconciles every declared path against the card write scope and is red when a path falls outside it, naming that path. Declaring nothing means the card claims no landing paths (existing cards are unaffected).'),
        uiText: {
          type: 'boolean',
          description:
            'update: declare that **this card produces or changes user-visible text** (DEF-055). The plan criterion `ui-text-scope` then reconciles the card write scope against the **text surface declared by the project** (`.sdo/config.yml` → `plan.textPaths`) and is red when nothing matches; its remedy names that config line, because the plugin deliberately hardcodes no path of its own. Omit = the card does not touch user-visible text; `false` **withdraws** the declaration.',
        },
        exclusive: {
          type: 'string',
          description:
            'update: the **exclusive-window group name** this card claims (DEF-007), free text — the plugin hardcodes no group name. Cards sharing a group name never run **at the same time**: dispatch serialises them (`sdo_plan` then names the card in the way) and the receipt lists the blocked ones. Static plan validation is unchanged — several cards of one group may exist, since queueing them in order is the point. An empty string **withdraws** the declaration.',
        },
        size: { type: 'string', description: 'update: small | medium | large.' },
        mitigates: listDecl('update: JSON **text** (a string) of the risk ids this card claims to eliminate, e.g. \'["RISK-001"]\' — not an array. Replaces the whole declaration (an empty array withdraws it). A duplicate id or a blank string is **rejected with a readable message** (never silently dropped); an id missing from `.sdo/risks/` is NOT rejected here (a sibling card in the same batch may log that risk afterwards) but criterion C-64 names it. C-64 requires every declared risk to be `mitigated`/`closed`, or to be covered by a `mitigatesWaiver` entry, once this card reaches done/verified.'),
        mitigatesWaiver: listDecl('update: JSON **text** (a string) of the waivers for risks that must stay open, e.g. \'[{"id":"RISK-001","waiveReason":"why it stays open","waiveApprovedBy":"who approved"}]\' — not an array of arguments. Replaces the whole declaration. The two keys are reused verbatim from the defect-waiver basis (DEF-038): both must be non-blank after trimming, otherwise criterion C-64 is red and names the missing field. Use CJK quotes (or escape per JSON rules) inside values, never bare ASCII quotes.'),
        id: { type: 'string', description: t('param.id') },
        owner: { type: 'string', description: t('param.owner') },
        expectedRevision: { type: 'number', description: t('param.expectedRevision') },
        evidence: { type: 'string', description: t('param.evidence') },
        note: { type: 'string', description: t('param.note') },
        reason: { type: 'string', description: t('param.reason') },
        actor: { type: 'string', description: t('param.actor') },
        approvedBy: { type: 'string', description: t('param.approvedBy') },
        review: { type: 'string', description: t('param.reviewId') },
        index: { type: 'number', description: t('param.reviewIndex') },
        outcome: { type: 'string', description: t('param.reviewOutcome') },
        proof: { type: 'string', description: t('param.reviewProof') },
        revise: { type: 'boolean', description: 'verify-review: allow overwriting an existing verification of the same (review, finding). By default a second verification is refused (it would silently replace the first one).' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.task(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          title: typeof args.title === 'string' ? args.title : undefined,
          dod: compositeArg(args.dod),
          writeScopes: compositeArg(args.writeScopes),
          // **DEF-012**：追加通道也要过这里（execute 映射是与 schema/类型并列的第三处，缺它参数会被静默丢掉 —— tq_ff348198）
          addWriteScopes: compositeArg(args.addWriteScopes),
          // **DEF-016**：自报清单（execute 映射是与 schema/类型并列的第三处，缺它参数会被静默丢掉）
          reportedFiles: compositeArg(args.reportedFiles),
          unfrozen: compositeArg(args.unfrozen),
          blockedBy: compositeArg(args.blockedBy),
          evidenceRequired: compositeArg(args.evidenceRequired),
          requirements: typeof args.requirements === 'string' ? args.requirements : undefined,
          fixes: typeof args.fixes === 'string' ? args.fixes : undefined,
          mitigates: typeof args.mitigates === 'string' ? args.mitigates : undefined,
          mitigatesWaiver: typeof args.mitigatesWaiver === 'string' ? args.mitigatesWaiver : undefined,
          mutationExpected: typeof args.mutationExpected === 'number' ? args.mutationExpected : undefined,
          // **DEF-036**：影响面声明同理必须过 execute 映射（第三处；缺它参数会被静默丢掉 — tq_ff348198）
          impact: compositeArg(args.impact),
          undecidable: typeof args.undecidable === 'string' ? args.undecidable : undefined,
          // **DEF-055**：布尔参数照样必须过 execute 映射（第四处；缺它参数被静默丢掉 — tq_ff348198）
          uiText: typeof args.uiText === 'boolean' ? args.uiText : undefined,
          // **DEF-018**：落点声明照样必须过 execute 映射（第四处；缺它参数被静默丢掉 — tq_ff348198）
          landing: compositeArg(args.landing),
          // **DEF-007**：独占组名照样必须过 execute 映射（缺它参数会被静默丢掉 — tq_ff348198）
          exclusive: typeof args.exclusive === 'string' ? args.exclusive : undefined,
          size: typeof args.size === 'string' ? args.size : undefined,
          id: typeof args.id === 'string' ? args.id : undefined,
          owner: typeof args.owner === 'string' ? args.owner : undefined,
          expectedRevision: typeof args.expectedRevision === 'number' ? args.expectedRevision : undefined,
          evidence: typeof args.evidence === 'string' ? args.evidence : undefined,
          note: typeof args.note === 'string' ? args.note : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          // **`DEF-118`（第十三批 §1.2）**：恢复动作的署名批准人（缺它参数会被静默丢掉 — tq_ff348198）
          approvedBy: typeof args.approvedBy === 'string' ? args.approvedBy : undefined,
          actor: typeof args.actor === 'string' ? args.actor : undefined,
          review: typeof args.review === 'string' ? args.review : undefined,
          index: typeof args.index === 'number' ? args.index : undefined,
          outcome: parseEnum(args.outcome, ['reproduced', 'refuted'] as const),
          proof: typeof args.proof === 'string' ? args.proof : undefined,
          revise: typeof args.revise === 'boolean' ? args.revise : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_test',
      description: t('tool.sdo_test'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(TEST_ACTIONS) },
        title: { type: 'string', description: t('param.title') },
        kind: { type: 'string', description: "plan: 'unit' | 'integration' | 'e2e'." },
        requirement: { type: 'string', description: t('param.requirement') },
        // **R11 / 第六批 §3.2**：语义上是列表、却声明成纯 `string` 的**活标本** —— 改用 `listDecl`（声明处给联合）
        steps: listDecl(t('param.steps')),
        expected: { type: 'string', description: t('param.expected') },
        caseId: { type: 'string', description: t('param.caseId') },
        status: { type: 'string', description: "record: 'pass' | 'fail' | 'skip'. defect: 'open' | 'fixed' | 'closed' | 'wontfix'." },
        evidence: { type: 'string', description: t('param.evidence') },
        severity: { type: 'string', description: "defect: 'blocker' | 'major' | 'minor'." },
        defectId: { type: 'string', description: t('param.defectId') },
        reason: { type: 'string', description: 'defect: correction reason — recorded verbatim in the defect/updated event (evidence is recorded the same way).' },
        // **REQ-055（TASK-039）**：缺陷根因面三字段 —— 与 `defect/recorded` 事件一起落盘。
        // 参数名必须写在这里：工具边界上没有的字段会被**静默丢掉**（模型照卡写也写不进去）。
        rootCause: {
          type: 'string',
          description:
            'defect (create only): **root cause** (REQ-055) — stored with the defect and written into the append-only `defect/recorded` event. '
            + 'Omitting it writes no key at all (an empty string is not the same as "no value").',
        },
        discoveryLevel: {
          type: 'string',
          description:
            'defect (create only): **discovery level** — one of the ledger word list (review / unit / integration / system / acceptance / production), '
            + 'stored verbatim in the ledger language. Any other value is REJECTED and the receipt names the whole legal set (a free-text level cannot be machine-checked).',
        },
        escaped: {
          type: 'boolean',
          description:
            'defect (create only): did this defect **escape** an earlier verification face that should have caught it? '
            + 'Only a real boolean is recorded; anything else is left unwritten (never silently coerced to false — that would flip the escape verdict).',
        },
        // **DEF-038（TASK-063）**：免责依据两字段 —— 与上面三个"根因面"字段同族。
        // 参数名必须写在这里：工具边界上没有的字段会被**静默丢掉**（裁决 A 的一手证据：
        // `waiveReason` 曾不在 schema 里，C-51 判红后给出的修法在工具面上**没有出口** = 假修法）。
        waiveReason: {
          type: 'string',
          description:
            'defect (create and update): **why this defect will not be fixed** (DEF-038) — semantically distinct from `rootCause` '
            + '(how it got in). Only meaningful with `status=wontfix`; on a blocker a wontfix is released ONLY when this AND '
            + '`waiveApprovedBy` are both non-empty, otherwise C-51 fails and names the defect. A blank string is REJECTED '
            + '(empty is not the same as filled in); omitting it writes no key at all.',
        },
        waiveApprovedBy: {
          type: 'string',
          description:
            'defect (create and update): **who approved not fixing it** (DEF-038) — the other half of the waiver basis; '
            + 'non-blocker wontfix defects are unaffected and never read these two fields. '
            + 'A blank string is REJECTED; omitting it writes no key at all.',
        },
        executedBy: {
          type: 'string',
          description:
            'record: who **executed** this run (REQ-053) — one end of the independence check, written into the append-only `test/recorded` event. '
            + 'Without it (and without adoptedBy) the result can never count as independently adopted (C-50 will name it).',
        },
        adoptedBy: {
          type: 'string',
          description:
            'record: who **adopted** the result (REQ-053) — must differ from executedBy; the adoption timestamp is stamped by the recorder (you do not have to remember it).',
        },
        env: { type: 'string', description: 'env/record: environment fingerprint, e.g. "jdk=21.0.2; probe=run_checks.py@v3". Recorded with the result so staleness is machine-checkable (SDO-57).' },
        artifact: { type: 'string', description: 'record: the artifact this result was produced against (relative path) — its sha256 is bound now and re-checked at delivery.' },
        fullSuite: { type: 'boolean', description: t('param.fullSuite') },
        defects: listDecl('record: **the fixed defects this conclusion covers** (DEF-075), as JSON **text** (a string) or a real array, e.g. \'["DEF-001","DEF-002"]\'. Every `fixed` defect must be bound by at least one passing result (criterion `defects.fixed-tested` at the verification gate); an unknown defect id is rejected readably.'),
        artifactSha256: { type: 'string', description: 'record: **the hash you already have** for that artifact (DEF-011). If given it must equal the freshly computed value, otherwise the call is **rejected with both values named** and nothing is written; if omitted the plugin computes it as before.' },
        // **R-3**：断言面指纹 —— 红与绿必须同指纹，否则"改断言转绿"与"改实现转绿"在台账上等价
        harness: { type: 'string', description: 'record: assertion-surface fingerprint (e.g. sha256 of the test harness, or a stable id like "node --test test/x.test.js"). The tdd red->green check requires the failing and the passing run of a case to carry the SAME fingerprint.' },
        // **REQ-054（TASK-054）**：判定基准的**参数面** —— 少了这一行，`oracle` 就在工具边界上被静默丢掉
        // （回执说"已记录"，而 `isAdopted()` 永远报"判定基准不成立" ⇒ C-50 的补救动作没有出口）。
        // 注意：**不写 `enum`** —— 这个参数是"JSON 文本"，合法取值不是四个字面量而是四类**形状**；
        // 写成 `enum: ['expert', …]` 反而误导（模型会传裸字面量 `"expert"`，解析必然失败）。
        // 词表本身仍只有一处（`ORACLE_KINDS`），这里把它渲染进说明里，两边不会各说一套。
        oracle: {
          type: 'string',
          description:
            `plan / record: **judgement basis (oracle)** (REQ-054) — a JSON **text** (a string), not an object. `
            + `\`kind\` must be one of ${ORACLE_KINDS.join(' / ')}: `
            + '{"kind":"acceptance","ref":"REQ-054","criterion":"AC-212"} (the AC id must belong to that requirement) / '
            + '{"kind":"contract","ref":"CT-001"} (the contract must exist AND carry failure semantics) / '
            + '{"kind":"baseline","ref":"dist/old.js","baselineSha256":"<64 hex>"} (re-hashed on the spot) / '
            + '{"kind":"expert","expert":"<who judged>"}. '
            + 'On `record` it is the RESULT-level basis (it overrides the case-level one: `result.oracle ?? testCase.oracle`). '
            + 'An illegal kind, missing field or broken reference is REJECTED with the legal set named — a case without a working basis does NOT count as passed (G6 / C-50 will name it).',
        },
        // 增量 3 的**交付物通道**：与"用例结果"在同一动作里分流（caseId/status 对它们非必填）。
        // 参数名与形状必须写在这里 —— 工具边界上没有的字段会被**静默丢掉**（模型照 README 写也写不进去）。
        mutation: {
          type: 'string',
          description:
            "record: JSON string for **mutation evidence** (deliverable, not a case result) - "
            + '{"task":"TASK-004","tool":"node --test","target":"lib/x.js","killed":3,"survived":0}. '
            + "`target` is optional but recommended. Required at scale=critical / for tdd package.",
        },
        contractTest: {
          type: 'string',
          description:
            "record: JSON string for a **contract test** record (deliverable) - "
            + '{"task":"TASK-005","contract":"CT-003","tool":"node --test","cmd":"node --test test/ct003.test.js"}. '
            + "The contract id must exist in the ledger. Required for the contract-first package.",
        },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.test(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          kind: parseEnum(args.kind, ['unit', 'integration', 'e2e'] as const),
          requirement: typeof args.requirement === 'string' ? args.requirement : undefined,
          // **R11 / §3.2**：调用面走 `compositeArg`（字符串原样 / 真数组转 JSON 文本）—— 旧口径对非 string **静默丢成 undefined**
          steps: compositeArg(args.steps),
          expected: typeof args.expected === 'string' ? args.expected : undefined,
          caseId: typeof args.caseId === 'string' ? args.caseId : undefined,
          status: typeof args.status === 'string' ? args.status : undefined,
          evidence: typeof args.evidence === 'string' ? args.evidence : undefined,
          severity: parseEnum(args.severity, ['blocker', 'major', 'minor'] as const),
          defectId: typeof args.defectId === 'string' ? args.defectId : undefined,
          // **REQ-055（TASK-039）**：根因面三字段与执行者/采纳者 —— 逐字段搬进 `deps.test`，漏一行
          // 就等于工具层**静默丢弃**（域层收不到、回执还说成功；τ_ff348198 那次就是这么死的）。
          rootCause: typeof args.rootCause === 'string' ? args.rootCause : undefined,
          discoveryLevel: typeof args.discoveryLevel === 'string' ? args.discoveryLevel : undefined,
          // `escaped` 只认真布尔：字符串 `'true'` / `'yes'` 一律当"没给"（宁可不写，也不要把逃逸判反）
          escaped: typeof args.escaped === 'boolean' ? args.escaped : undefined,
          // **DEF-038（TASK-063）**：免责依据两字段 —— 同样必须逐字段搬（漏这一行 = 工具层静默丢弃：
          // 域层收不到、C-51 永远说"依据不齐备"，而调用方照回执去补也补不进去）。新建与更新两条路径共用。
          waiveReason: typeof args.waiveReason === 'string' ? args.waiveReason : undefined,
          waiveApprovedBy: typeof args.waiveApprovedBy === 'string' ? args.waiveApprovedBy : undefined,
          executedBy: typeof args.executedBy === 'string' ? args.executedBy : undefined,
          adoptedBy: typeof args.adoptedBy === 'string' ? args.adoptedBy : undefined,
          env: typeof args.env === 'string' ? args.env : undefined,
          artifact: typeof args.artifact === 'string' ? args.artifact : undefined,
          // **DEF-011**：声明的产物哈希照样必须过 execute 映射（缺它 = 参数被静默丢弃 — tq_ff348198）
          artifactSha256: typeof args.artifactSha256 === 'string' ? args.artifactSha256 : undefined,
          // **DEF-075**：绑定的缺陷 id 列表（数组或 JSON 文本；缺它 = 参数被静默丢弃）
          fullSuite: args.fullSuite === true ? true : undefined,
          defects: args.defects,
          // **R-3**：断言面指纹（红绿必须同指纹）—— 必须进映射，否则工具边界上被静默丢掉
          harness: typeof args.harness === 'string' ? args.harness : undefined,
          // **REQ-054（TASK-054）**：判定基准 —— 同样必须逐字段搬（漏一行 = 静默丢弃，
          // 真机后果是 REQ-053 的独立性判据永远差最后一条、`passedAdopted` 恒为 0）
          oracle: typeof args.oracle === 'string' ? args.oracle : undefined,
          // 交付物通道：**必须逐字段搬进来**（漏一行 = 工具层静默丢弃，B1 那次就是这么死的）
          mutation: typeof args.mutation === 'string' ? args.mutation : undefined,
          contractTest: typeof args.contractTest === 'string' ? args.contractTest : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_review',
      description: t('tool.sdo_review'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(REVIEW_ACTIONS) },
        taskId: { type: 'string', description: t('param.taskId') },
        reviewer: { type: 'string', description: t('param.reviewer') },
        verdict: { type: 'string', description: "'pass' | 'changes-requested' | 'reject'." },
        // **DEF-048**：待修主张必须带"当前仍失败的复现命令"或显式声明"无法复现"（二选一）
        repro: { type: 'string', description: "record: **a command that still fails right now** (DEF-048). A non-`pass` verdict (changes-requested / reject) must carry either this or `unreproducible` — otherwise the call is rejected with both ways out named and nothing is written." },
        unreproducible: { type: 'string', description: "record: **explicit declaration that it cannot be reproduced**, plus why (DEF-048). The alternative to `repro`; giving both is rejected (the reader could not tell which one holds)." },
        // **DEF-065 落点一**：与 `sdo_plan.suggestions` 同源同修 —— 原先是 `type: 'string'`，
        // 数组在这条工具上被宿主校验拒（`"findings" must be a string`）。联合声明见上。
        findings: listDecl(t('param.findings')),
        id: { type: 'string', description: t('param.reviewId') },
        actor: { type: 'string', description: t('param.actor') },
        originalIndex: { type: 'number', description: t('param.originalIndex') },
        originalTotal: { type: 'number', description: t('param.originalTotal') },
        // **DEF-076（第四批 §3.3）**：评审可**点名缺陷**（列表声明，走 DEF-077 的 `listDecl`）——
        // 没有这个入口，「先评审、后测试」就只有散文可依（`defects.fixed-reviewed` / C-66 判不了）。
        defectId: listDecl(t('param.reviewDefectId')),
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.review(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
          reviewer: typeof args.reviewer === 'string' ? args.reviewer : undefined,
          verdict: parseEnum(args.verdict, ['pass', 'changes-requested', 'reject'] as const),
          findings: compositeArg(args.findings),
          // **DEF-048**：两条出路照样要过 execute 映射（缺它 = 参数被静默丢弃 —— tq_ff348198）
          repro: typeof args.repro === 'string' ? args.repro : undefined,
          unreproducible: typeof args.unreproducible === 'string' ? args.unreproducible : undefined,
          id: typeof args.id === 'string' ? args.id : undefined,
          actor: typeof args.actor === 'string' ? args.actor : undefined,
          // **DEF-072**：条号声明必须过 execute 映射（第四处；缺它参数被静默丢掉 — tq_ff348198）
          originalIndex: typeof args.originalIndex === 'number' ? args.originalIndex : undefined,
          originalTotal: typeof args.originalTotal === 'number' ? args.originalTotal : undefined,
          // **DEF-076**：点名的缺陷也要过 execute 映射（第四处；缺它 = 参数被静默丢弃 — `tq_ff348198`）
          defectId: compositeArg(args.defectId),
        })
      },
    }),

    defineTool({
      name: 'sdo_deliver',
      description: t('tool.sdo_deliver'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(DELIVER_ACTIONS) },
        target: { type: 'string', description: "run: runtime target (server / client / desktop / device ...)." },
        command: { type: 'string', description: 'run: the real command you executed (must be re-runnable).' },
        outcome: { type: 'string', enum: ['pass', 'fail'], description: "run: did the real run succeed? REQUIRED for run (omitting it is rejected — a forgotten verdict must not be recorded as pass). Not schema-`required` on purpose: package/show do not use it and the host validates per tool, not per action (R4)." },
        evidence: { type: 'string', description: 'run: evidence path or note (log / screenshot / manual confirmation).' },
        artifact: { type: 'string', description: 'run: the artifact you actually ran (relative path); its sha256 is bound at record time.' },
        exitCode: { type: 'string', description: 'run: exit code, if any.' },
        artifactSha256: { type: 'string', description: 'run: **the hash you already have** for that artifact (DEF-011). If given it must equal the freshly computed value, otherwise the call is **rejected with both values named** and nothing is written; if omitted the plugin computes it as before.' },
        runsRequired: listDecl(t('param.runsRequired')),
        artifacts: listDecl('JSON **text** (a string), e.g. \'[{"path":"src/x.ts","kind":"source|docs|config|schema|test"}]\' — not an array. **Two failure shapes**: (1) *wrong shape* (not valid JSON: not an array, stray comma, bare newline in a string) => reported as a shape error; (2) *value cut off* (an unescaped ASCII quote inside the value - by far the most common here, since citing identifiers/commands/paths needs quotes) => the error names the character position. **Recommended**: use CJK quotes (or escape per JSON rules) inside values, never bare ASCII quotes; and do not send several long JSON arguments in one message (that also interrupts the call).'),
        acceptance: listDecl('JSON **text** (a string), e.g. \'[{"requirement":"REQ-001","criterion":"AC-001","evidence":"…","verdict":"pass"}]\' — not an array. Verdicts: pass | pass-with-deviation | fail | unverified | blocked | waived. **pass-with-deviation** (accept with a known deviation) REQUIRES a non-empty `deviation` field (what the deviation is, why it is accepted, who approved it) — it is rendered into DELIVERY.md and reported as a warning by the delivery gate. **Two failure shapes**: (1) *wrong shape* (not valid JSON: not an array, stray comma, bare newline in a string) => reported as a shape error; (2) *value cut off* (an unescaped ASCII quote inside the value - by far the most common here, since citing identifiers/commands/paths needs quotes) => the error names the character position. **Recommended**: use CJK quotes (or escape per JSON rules) inside values, never bare ASCII quotes; and do not send several long JSON arguments in one message (that also interrupts the call).'),
        rollbackPoint: { type: 'string', description: t('param.rollbackPoint') },
        by: { type: 'string', description: 'Who packages it (default "human").' },
        notes: { type: 'string', description: t('param.notes') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.deliver(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'show',
          target: typeof args.target === 'string' ? args.target : undefined,
          command: typeof args.command === 'string' ? args.command : undefined,
          outcome: typeof args.outcome === 'string' ? args.outcome : undefined,
          evidence: typeof args.evidence === 'string' ? args.evidence : undefined,
          artifact: typeof args.artifact === 'string' ? args.artifact : undefined,
          // **DEF-011**：声明的产物哈希照样必须过 execute 映射（缺它 = 参数被静默丢弃 — tq_ff348198）
          artifactSha256: typeof args.artifactSha256 === 'string' ? args.artifactSha256 : undefined,
          exitCode: typeof args.exitCode === 'string' ? args.exitCode : undefined,
          runsRequired: typeof args.runsRequired === 'string' ? args.runsRequired : undefined,
          artifacts: typeof args.artifacts === 'string' ? args.artifacts : undefined,
          acceptance: typeof args.acceptance === 'string' ? args.acceptance : undefined,
          rollbackPoint: typeof args.rollbackPoint === 'string' ? args.rollbackPoint : undefined,
          by: typeof args.by === 'string' ? args.by : undefined,
          notes: typeof args.notes === 'string' ? args.notes : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_cost',
      description: t('tool.sdo_cost'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(COST_ACTIONS) },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.cost(callOf(exec), { action: typeof args.action === 'string' ? args.action : 'report' })
      },
    }),

    defineTool({
      name: 'sdo_gate',
      description: t('tool.sdo_gate'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(GATE_ACTIONS) },
        gate: {
          type: 'string',
          description:
            t('uiTools.k4')
            + t('uiTools.k5')
            + t('uiTools.k6'),
        },
        approvedBy: { type: 'string', description: t('param.approvedBy') },
        reason: { type: 'string', description: t('param.reason') },
        approver: { type: 'string', description: t('param.approver') },
        conclusion: { type: 'string', description: "Spiral GR gate: this round's risk conclusion — 'continue' | 'adjust' | 'stop'." },
        rationale: { type: 'string', description: t('param.rationale') },
        channel: { type: 'string', description: t('uiTools.kGateChannel') },
                quote: { type: 'string', description: t('param.signQuote') },
        turn: { type: 'string', description: t('uiTools.kGateTurn') },
        to: { type: 'string', description: t('uiTools.kGateRollbackTo') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.gate(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'check',
          gate: typeof args.gate === 'string' ? args.gate : undefined,
          approvedBy: typeof args.approvedBy === 'string' ? args.approvedBy : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          approver: typeof args.approver === 'string' ? args.approver : undefined,
          conclusion:
            args.conclusion === 'continue' || args.conclusion === 'adjust' || args.conclusion === 'stop'
              ? args.conclusion
              : undefined,
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
          channel: args.channel === 'statement' || args.channel === 'question' ? args.channel : undefined,
          quote: typeof args.quote === 'string' ? args.quote : undefined,
          turn: typeof args.turn === 'string' ? args.turn : undefined,
          to: typeof args.to === 'string' ? args.to : undefined,
          // 人机关口问答通道需要活的 agent 与取消信号（由调用方注入的 answerer 处理）
          agent: exec.agent,
        })
      },
    }),

    defineTool({
      name: 'sdo_feasibility',
      description: t('tool.sdo_feasibility'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(FEASIBILITY_ACTIONS) },
        telos: { type: 'string', description: t('uiTools.k7') },
        verdict: { type: 'string', description: "'go' | 'no-go' | 'conditional'." },
        rationale: { type: 'string', description: t('param.rationale') },
        poc: { type: 'string', description: t('uiTools.k8') },
        by: { type: 'string', description: 'Who assessed (default "human").' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.feasibility(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'assess',
          telos: typeof args.telos === 'string' ? args.telos : undefined,
          verdict: parseEnum(args.verdict, ['go', 'no-go', 'conditional'] as const),
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
          poc: typeof args.poc === 'string' ? args.poc : undefined,
          by: typeof args.by === 'string' ? args.by : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_risk',
      description: t('tool.sdo_risk'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(RISK_ACTIONS) },
        id: { type: 'string', description: t('param.id') },
        title: { type: 'string', description: t('param.title') },
        level: { type: 'string', description: "'low' | 'medium' | 'high' | 'blocker'." },
        probability: { type: 'string', description: "'low' | 'medium' | 'high'." },
        impact: { type: 'string', description: t('param.impact') },
        mitigation: { type: 'string', description: t('param.mitigation') },
        owner: { type: 'string', description: t('param.owner') },
        origin: { type: 'string', description: t('param.origin') },
        status: { type: 'string', description: "'open' | 'mitigated' | 'closed' (update)." },
        conclusion: { type: 'string', description: "Spiral per-round risk conclusion ('conclude'): 'continue' | 'adjust' | 'stop'." },
        rationale: { type: 'string', description: t('param.rationale') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.risk(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          id: typeof args.id === 'string' ? args.id : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          level: parseEnum(args.level, ['low', 'medium', 'high', 'blocker'] as const),
          probability: parseEnum(args.probability, ['low', 'medium', 'high'] as const),
          impact: typeof args.impact === 'string' ? args.impact : undefined,
          mitigation: typeof args.mitigation === 'string' ? args.mitigation : undefined,
          owner: typeof args.owner === 'string' ? args.owner : undefined,
          origin: typeof args.origin === 'string' ? args.origin : undefined,
          status: parseEnum(args.status, ['open', 'mitigated', 'closed'] as const),
          conclusion: parseEnum(args.conclusion, ['continue', 'adjust', 'stop'] as const),
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_design',
      description: t('tool.sdo_design'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(DESIGN_ACTIONS) },
        kind: { type: 'string', description: t('param.designKind') },
        id: { type: 'string', description: t('param.id') },
        name: { type: 'string', description: t('param.name') },
        elementKind: { type: 'string', description: t('param.elementKind') },
        responsibility: { type: 'string', description: t('param.responsibility') },
        dependsOn: { type: 'string', description: t('param.dependsOn') },
        summary: { type: 'string', description: t('param.summary') },
        producer: { type: 'string', description: t('param.producer') },
        consumer: { type: 'string', description: t('param.consumer') },
        schema: { type: 'string', description: t('param.schema') },
        contractKind: { type: 'string', description: "'http' | 'event' | 'rpc' | 'schema' (contract)." },
        requires: { type: 'string', description: t('param.contractRequires') },
        timeout: { type: 'string', description: t('param.timeout') },
        retry: { type: 'string', description: t('param.retry') },
        idempotency: { type: 'string', description: t('param.idempotency') },
        method: { type: 'string', description: t('param.designMethod') },
        rationale: { type: 'string', description: t('param.designRationale') },
        round: { type: 'number', description: t('param.designRound') },
        questionId: { type: 'string', description: t('param.designQuestionId') },
        choice: { type: 'string', description: t('param.designChoice') },
        assume: { type: 'boolean', description: t('param.designAssume') },
        target: { type: 'string', description: t('param.designTarget') },
        state: { type: 'string', description: t('param.designState') },
        ui: { type: 'string', description: t('param.designUi') },
        // F-7：这两个参数此前只在 TS 类型与 handler 里存在，schema 里漏了 → 宿主按 schema
        // 过滤入参后 handler 收到空种类，`action=artifact` 在工具通道上根本不可用。
        // 由 `test/m15.test.ts` 的「schema ↔ handler」机械守卫防回归。
        artifactKind: { type: 'string', description: t('param.designArtifactKind') },
        basis: { type: 'string', description: t('param.designConfirmBasis') },
        basisSource: { type: 'string', enum: ['user', 'proxy'], description: t('param.designBasisSource') },
        artifactData: { type: 'string', description: t('param.designArtifactData') },
        puml: { type: 'string', description: t('param.designPuml') },
        approvedBy: { type: 'string', description: t('param.approvedBy') },
        note: { type: 'string', description: t('param.note') },
        by: { type: 'string', description: t('param.by') },
        reason: { type: 'string', description: t('param.reason') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.design(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'view',
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          id: typeof args.id === 'string' ? args.id : undefined,
          name: typeof args.name === 'string' ? args.name : undefined,
          elementKind: typeof args.elementKind === 'string' ? args.elementKind : undefined,
          responsibility: typeof args.responsibility === 'string' ? args.responsibility : undefined,
          dependsOn: typeof args.dependsOn === 'string' ? args.dependsOn : undefined,
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          producer: typeof args.producer === 'string' ? args.producer : undefined,
          consumer: typeof args.consumer === 'string' ? args.consumer : undefined,
          schema: typeof args.schema === 'string' ? args.schema : undefined,
          contractKind: typeof args.contractKind === 'string' ? args.contractKind : undefined,
          // **DEF-056**：写侧第三道（execute 映射）—— 缺它参数会被静默丢掉（知识库 tq_ff348198 的形态）
          requires: typeof args.requires === 'string' ? args.requires : undefined,
          timeout: typeof args.timeout === 'string' ? args.timeout : undefined,
          retry: typeof args.retry === 'string' ? args.retry : undefined,
          idempotency: typeof args.idempotency === 'string' ? args.idempotency : undefined,
          method: typeof args.method === 'string' ? args.method : undefined,
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
          round: typeof args.round === 'number' ? args.round : undefined,
          questionId: typeof args.questionId === 'string' ? args.questionId : undefined,
          choice: typeof args.choice === 'string' ? args.choice : undefined,
          assume: args.assume === true,
          target: typeof args.target === 'string' ? args.target : undefined,
          state: typeof args.state === 'string' ? args.state : undefined,
          ui: typeof args.ui === 'string' ? args.ui : undefined,
          artifactKind: typeof args.artifactKind === 'string' ? args.artifactKind : undefined,
          basis: typeof args.basis === 'string' ? args.basis : undefined,
          basisSource: typeof args.basisSource === 'string' ? args.basisSource : undefined,
          artifactData: typeof args.artifactData === 'string' ? args.artifactData : undefined,
          puml: typeof args.puml === 'string' ? args.puml : undefined,
          approvedBy: typeof args.approvedBy === 'string' ? args.approvedBy : undefined,
          note: typeof args.note === 'string' ? args.note : undefined,
          by: typeof args.by === 'string' ? args.by : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_adr',
      description: t('tool.sdo_adr'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(ADR_ACTIONS) },
        // `supersede`/定位既有 ADR 要用 id：**工具边界上必须有**，否则这条动作不可达（与 B1/PLAN-1 同类）
        id: { type: 'string', description: t('param.id') },
        title: { type: 'string', description: t('param.title') },
        context: { type: 'string', description: t('param.context', 'The forces at play: what makes this a decision at all.') },
        decision: { type: 'string', description: t('param.decision') },
        alternatives: listDecl('JSON **text** (a string), e.g. \'[{"option":"…","pros":"…","cons":"…"}]\' — not an array. **Two failure shapes**: (1) *wrong shape* (not valid JSON: not an array, stray comma, bare newline in a string) => reported as a shape error; (2) *value cut off* (an unescaped ASCII quote inside the value - by far the most common here, since citing identifiers/commands/paths needs quotes) => the error names the character position. **Recommended**: use CJK quotes (or escape per JSON rules) inside values, never bare ASCII quotes; and do not send several long JSON arguments in one message (that also interrupts the call).'),
        consequences: { type: 'string', description: t('param.consequences') },
        supersedes: { type: 'string', description: t('param.supersedes') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.adr(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          title: typeof args.title === 'string' ? args.title : undefined,
          context: typeof args.context === 'string' ? args.context : undefined,
          decision: typeof args.decision === 'string' ? args.decision : undefined,
          alternatives: typeof args.alternatives === 'string' ? args.alternatives : undefined,
          consequences: typeof args.consequences === 'string' ? args.consequences : undefined,
          id: typeof args.id === 'string' ? args.id : undefined,
          supersedes: typeof args.supersedes === 'string' ? args.supersedes : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_quality',
      description: t('tool.sdo_quality'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(QUALITY_ACTIONS) },
        attribute: { type: 'string', description: "Quality attribute: 'performance' | 'security' | 'reliability' | 'maintainability' | … (scenario)." },
        stimulus: { type: 'string', description: t('param.stimulus') },
        response: { type: 'string', description: t('param.response') },
        measure: { type: 'string', description: t('uiTools.k9') },
        priority: { type: 'string', description: "'high' | 'medium' | 'low'." },
        targets: { type: 'string', description: t('param.targets') },
        risks: { type: 'string', description: t('param.risks') },
        sensitivities: { type: 'string', description: t('param.sensitivities') },
        tradeoffs: { type: 'string', description: t('param.tradeoffs') },
        by: { type: 'string', description: 'Who evaluated (default "human").' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.quality(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          attribute: typeof args.attribute === 'string' ? args.attribute : undefined,
          stimulus: typeof args.stimulus === 'string' ? args.stimulus : undefined,
          response: typeof args.response === 'string' ? args.response : undefined,
          measure: typeof args.measure === 'string' ? args.measure : undefined,
          priority: parseEnum(args.priority, ['high', 'medium', 'low'] as const),
          targets: typeof args.targets === 'string' ? args.targets : undefined,
          risks: typeof args.risks === 'string' ? args.risks : undefined,
          sensitivities: typeof args.sensitivities === 'string' ? args.sensitivities : undefined,
          tradeoffs: typeof args.tradeoffs === 'string' ? args.tradeoffs : undefined,
          by: typeof args.by === 'string' ? args.by : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_trace',
      description: t('tool.sdo_trace'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(TRACE_ACTIONS) },
        from: { type: 'string', description: t('param.from') },
        to: { type: 'string', description: t('param.to') },
        kind: { type: 'string', description: "'req-des' | 'req-task' | 'req-tc' | 'des-task' | 'des-ct'." },
        links: listDecl('JSON **text** (a string) for batch linking, e.g. \'[{"from":"REQ-001","to":"DES-001","kind":"req-des"}]\' — not an array. **Two failure shapes**: (1) *wrong shape* (not valid JSON: not an array, stray comma, bare newline in a string) => reported as a shape error; (2) *value cut off* (an unescaped ASCII quote inside the value - by far the most common here, since citing identifiers/commands/paths needs quotes) => the error names the character position. **Recommended**: use CJK quotes (or escape per JSON rules) inside values, never bare ASCII quotes; and do not send several long JSON arguments in one message (that also interrupts the call).'),
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.trace(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'query',
          from: typeof args.from === 'string' ? args.from : undefined,
          to: typeof args.to === 'string' ? args.to : undefined,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          links: typeof args.links === 'string' ? args.links : undefined,
        })
      },
    }),

    defineTool({
      // **DEF-017 / §3E 族 3**：给评审者（掩码 deny 里有 `bash`、且唯一的哈希入口 `sdo_test` 也被 deny）
      // 一条**只读窄入口** —— 只现算，不写台账、不落事件；不是把 `bash` 放开。
      name: 'sdo_hash',
      description: t('tool.sdo_hash'),
      parameters: {
        path: { type: 'string', required: true, description: t('param.hashPath') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const outcome = digestArtifact(callOf(exec).cwd ?? '', typeof args.path === 'string' ? args.path : '')
        if (!outcome.ok) {
          return fmt('uiIndex.kHashRejected', { p1: outcome.code, p2: typeof args.path === 'string' ? args.path : '' })
        }
        return fmt('uiIndex.kHashResult', {
          p1: outcome.path,
          p2: outcome.sha256,
          p3: outcome.mtime,
          p4: String(outcome.bytes),
        })
      },
    }),
  ]

  return withListParamTools(tools)
}
