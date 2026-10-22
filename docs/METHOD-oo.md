<!-- method-doc: package=oo; basis=dd91f36f8490 -->
# 面向对象方法产物 · 人审文档

> 本文是 **`oo` 方法包的人审文档**（G3 判据 C-2F）。文档头的 `basis` 是本包方法产物在台账里的**内容指纹**：
> 台账里任何产物变更都会让指纹改变，本文即失效，必须重新生成（用 `sdo_design action=method` 取当前指纹）。
> 真源是 `.sdo/design/method-classes.yml`、`method-sequences.yml`、`method-layers.yml`，本文只是它们的**人读视图**。

## 1. 这份文档回答什么

| 问题 | 对应产物 | 本文章节 |
|---|---|---|
| 系统里有哪些类型、各自负责什么、跟谁协作、属于哪一层 | 类/接口清单（43 条） | §2 |
| 关键用例怎么在类型之间跑完（消息的发送者、接收者、触发条件） | 关键用例时序（22 条） | §3 |
| 层与层之间允许谁依赖谁，现状与规则差在哪 | 分层/包依赖规则 | §4 |

**已验证的机械口径**：每个类型必须给出协作方（显式声明 `leaf: true` 的叶子类型豁免）；每条时序的参与者必须已登记为类型；每条功能/界面类 must 需求必须有对应时序（约束/质量类需求豁免）。

## 2. 类与接口清单（43 条）

### 2.1 基础设施层 `infra`（真源与渲染）

| id | 类型 | 职责 |
|---|---|---|
| TYPE-001 | `SdoStore` | 真源读写门面：工作区路径解析、YAML 子集读写、原子写（临时文件 + 改名）、手改真源覆盖前留副本（上限 20 份） |
| TYPE-002 | `SdoJournal` | 追加式事件流：append / read、按序号取最新、尾部半写行截断到最后一个完整事件 |
| TYPE-003 | `SdoYaml` | YAML 子集解析与序列化：标量误写、井号截断、非法缩进的形状提示 |
| TYPE-004 | `SdoIds`（叶子） | 实体 id 发号（REQ / Q / RISK / CR / DES / CT / ADR / QS / TASK / TC / DEF / REV 等） |
| TYPE-005 | `Scalar`（叶子） | 标量、列表、映射的安全取值与形状提示（textOf / textListOf / recordOf / typeNameOf） |
| TYPE-006 | `ProjectionRender` | 派生文档渲染：渲染头（真源位置 + journal 序号）、请勿手改标注、指纹比对 |

### 2.2 领域层 `domain`（业务与流程判定）

| id | 类型 | 职责 |
|---|---|---|
| TYPE-007 | `ProcessCatalog` | 流程即数据：加载 `src/data/processes/*.yml`，解析阶段、门禁、判据、回退边与受审载荷声明；门禁名归一 |
| TYPE-008 | `GateEvaluator` | 判据逐条现算三态、判定留痕、出口门禁现算放行、豁免与回退留痕 |
| TYPE-009 | `DorEvaluator` | 需求就绪判定：评分阈值与零维度、优先级 / 来源 / GWT、未决问题与转风险核对 |
| TYPE-010 | `Scoring` | 八维歧义评分：规则通道（禁词与硬信号）加语义通道，两通道取严并区分来源 |
| TYPE-011 | `ScoringModel`（叶子） | 随包评分卡与禁词表的加载与校验（项目改不动门禁刻度） |
| TYPE-012 | `SignatureLedger` | 签字台账：记录签字与依据、按 journal 序号判失效、依据重放与新鲜度核对 |
| TYPE-013 | `RequirementLedger` | 需求真源全生命周期：捕获 / 更新 / 评分 / 验收标准 / 基线冻结 / 问题账本 |
| TYPE-014 | `ChangeControl` | 变更请求：理由与影响分析、决策、应用字段补丁、批准后强制回退与未消化期封锁 |
| TYPE-015 | `TraceGraph` | 追溯边（六类）、覆盖率与孤儿检测 |
| TYPE-016 | `DesignLedger` | 设计真源：五视图与界面视图元素、契约、确认戳（绑内容指纹）、设计文档渲染 |
| TYPE-017 | `MethodPackages` | 设计方法包与方法产物：选择解析、逐包最小必产项校验、人审文档指纹绑定 |
| TYPE-018 | `PlanDecomposer` | 双通道拆卡与六条机械校验、写范围互斥、容量预算挑卡 |
| TYPE-019 | `Pool` | 子代理池：掩码指纹、复用判定（指纹一致 + 公告面非空）、池位与排队 |
| TYPE-020 | `TestLedger` | 测试域：用例 / 结果 / 缺陷 / 评审与核实（0.1.6 扩七类产物） |
| TYPE-021 | `ReviewPayload` | 受审载荷读取与指纹：按声明逐条读真源、算逐条哈希与整篇指纹、输出逐条索引 |
| TYPE-022 | `ReviewView` | 审核单呈现层：语义标签替换原始键名、代号解析成代号加名称、验收标准表格化、剔除无意义字段 |
| TYPE-029 | `RiskLedger` | 风险台账：等级、概率、影响、缓解、责任人、来源；高与阻塞级必须带缓解与责任人 |
| TYPE-030 | `Applicability` | 设计适用性声明：focus、五视图显式二选一、不做项逐条给理由、用户签字绑定 |
| TYPE-031 | `Wireframe` | 界面线框（ASCII）与 PlantUML 骨架源码生成（只出源码，不出图） |
| TYPE-032 | `MethodDocs` | 人审文档 `docs/METHOD-<包>.md` 的指纹头生成与正文覆盖校验 |
| TYPE-033 | `WriteScope` | 写范围解析与成对互斥判定（含写范围未对账的显式兜底） |
| TYPE-034 | `RoleMasks` | 角色掩码表：公告面与调用面两层语义、掩码指纹计算 |
| TYPE-035 | `DispatchFace` | 派发面组装：按角色收窄工具面（只发 deny 面）、派发观测与汇报落点 |
| TYPE-036 | `Evidence` | 证据账：命令证据（含退出码）、产物哈希、环境指纹、断言面指纹、子代理工具面观测 |
| TYPE-037 | `I18n` | 界面语言：zh-CN 基准与 en 逐键覆盖、缺键回落、标识不翻译 |

### 2.3 接口层 `interface`（模型可见面与命令面）

| id | 类型 | 职责 |
|---|---|---|
| TYPE-023 | `ToolSurface` | 20 个模型工具与 17 条命令的注册、参数解析（复合参数为字符串化 JSON）、回执截断、角色掩码钩子 |
| TYPE-024 | `ArgvParser`（叶子） | 命令分词：`--k=v`、`--k v`、裸 `key=value` 三形态，引号感知，`--` 之后为位置参数 |
| TYPE-025 | `Injector` | 每轮状态注入（限长、仅限被接管会话）与未接管会话的零注入保障 |

### 2.4 集成层 `integration`（宿主适配）

| id | 类型 | 职责 |
|---|---|---|
| TYPE-026 | `DispatchAdapter` | 宿主 `subagents` 适配：起子代理、只下发 deny 面、记录子会话 id 与掩码指纹 |
| TYPE-027 | `CostMeter` | token 计量与预算档位；子代理用量不可见时如实说明 |

### 2.5 客户端半 `client`（浏览器）

| id | 类型 | 职责 |
|---|---|---|
| TYPE-028 | `SidebarClientHalf` | 问答事件旁观者、审核单全文取回与侧边栏镜像、探针五段读数、作答后关闭 |

### 2.6 宿主能力 `host`（不自建，只被适配器依赖）

| id | 类型 | 职责 |
|---|---|---|
| TYPE-038 | `HostSubagents`（叶子） | 宿主子代理注册表（`subagents.start` 的能力提供方） |
| TYPE-039 | `HostTokenMeter`（叶子） | 宿主 token 计量服务 |
| TYPE-040 | `HostWorkspaceFiles`（叶子） | 宿主只读工作区文件 Remote（返回 `RemoteResult` 信封） |
| TYPE-041 | `HostUserQuestions`（叶子） | 宿主问答服务（`user-questions/request` waterfall） |
| TYPE-042 | `HostSidebarRight`（叶子） | 宿主右侧边栏服务（`mounted` 快照、`openResourceIn`、`closeIn`） |

### 2.7 人类使用者 `actor`

| id | 类型 | 职责 |
|---|---|---|
| TYPE-043 | `使用者` | STK-01；人类关口的唯一签字人：门禁签字、计划评审、报告与验收签字 |

## 3. 关键用例时序（22 条）

每条时序都列出**参与者**与**覆盖的需求**；消息三要素（发送者 / 接收者 / 触发条件）在 `.sdo/design/method-sequences.yml` 里逐条可见。

| id | 时序 | 参与者 | 覆盖需求 |
|---|---|---|---|
| SEQ-007 | 项目初始化与接管 | 使用者 → ToolSurface → Injector / RequirementLedger | REQ-001, REQ-013, REQ-031, REQ-032, REQ-033 |
| SEQ-008 | 需求捕获与评分 | ToolSurface / RequirementLedger / Scoring | REQ-002, REQ-004 |
| SEQ-009 | 审讯提问与答复 | RequirementLedger / Scoring / 使用者 | REQ-003 |
| SEQ-010 | 门禁判定、就绪硬拦与豁免 | ToolSurface / GateEvaluator / DorEvaluator / SdoStore / 使用者 | REQ-005, REQ-014 |
| SEQ-011 | 基线冻结与门禁签字 | ToolSurface / GateEvaluator / ReviewPayload / ReviewView / SidebarClientHalf / SignatureLedger / SdoStore / 使用者 | REQ-007, REQ-044 |
| SEQ-004 | 需求变更与强制回退 | 使用者 / ChangeControl / TraceGraph / GateEvaluator / RequirementLedger / PlanDecomposer | REQ-006 |
| SEQ-012 | 设计落笔与关键条目确认 | ToolSurface / DesignLedger / MethodPackages / SdoStore / 使用者 | REQ-008, REQ-009 |
| SEQ-013 | 追溯与孤儿检测 | ToolSurface / TraceGraph / SdoStore | REQ-012 |
| SEQ-014 | 拆卡与派发 | ToolSurface / PlanDecomposer / Pool / DispatchAdapter / HostSubagents | REQ-015, REQ-022, REQ-023, REQ-024 |
| SEQ-015 | 协同状态、看板与状态注入 | 使用者 / PlanDecomposer / ProjectionRender / SdoStore / Injector | REQ-025, REQ-026 |
| SEQ-016 | 渲染与交付打包 | ToolSurface / ProjectionRender / TestLedger / SdoStore | REQ-018, REQ-019, REQ-034 |
| SEQ-017 | 成本计量与预算档位 | 使用者 / ToolSurface / CostMeter / HostTokenMeter | REQ-028, REQ-029, REQ-030 |
| SEQ-018 | 测试方法包与计划评审 | ToolSurface / TestLedger / SdoStore / 使用者 | REQ-045, REQ-046, REQ-047, REQ-048, REQ-056 |
| SEQ-019 | 覆盖读数、未覆盖处置与判定基准 | TestLedger / SdoStore / ToolSurface | REQ-049, REQ-054, REQ-055, REQ-057 |
| SEQ-020 | 准出准则、报告签字、回归与采纳 | TestLedger / ProjectionRender / SignatureLedger / TraceGraph / SdoStore / 使用者 | REQ-050, REQ-051, REQ-052, REQ-053 |
| SEQ-021 | 测试域记录 | ToolSurface / TestLedger / SdoStore | REQ-017 |
| SEQ-022 | 缺陷追溯（孤儿缺陷拦 G5） | 使用者 / ToolSurface / TestLedger / SdoStore / GateEvaluator | REQ-058 |
| SEQ-023 | 测试报告签署与验证门禁放行 | ToolSurface / GateEvaluator / ReviewPayload / SignatureLedger / SdoStore / 使用者 | REQ-059, REQ-051 |
| SEQ-024 | 发布计划层的冻结与门禁分工 | 使用者 / ToolSurface / RequirementLedger / GateEvaluator / SignatureLedger / ChangeControl | REQ-063 |
| SEQ-025 | 子代理并行写：相交可见、副本写、自行合并 | 使用者 / PlanDecomposer / WriteScope / HostSubagents | REQ-066 |
| SEQ-026 | 过程证据随版本周期归档 | 使用者 / Evidence / SdoStore / SdoJournal / TestLedger | REQ-067 |
| SEQ-027 | 评审独立性五项判定 | 使用者 / ReviewPayload / ReviewView / GateEvaluator / HostSubagents | REQ-062 |

**覆盖口径**：全部功能／界面类 must 需求（48 条）都至少出现在一条时序的 `requires` 里；约束与质量类 must 需求（REQ-035…REQ-043）按设计豁免——它们没有可画的关键用例流程，改由质量场景（QS-001…QS-006）与不变量（INV-001…INV-011）承载。

## 4. 分层与包依赖规则

**层**：`actor` → `runtime` → `interface` → `domain` → `infra`，另有 `integration`、`client`、`host`。

**允许的依赖方向**（15 条）：`actor → interface`；`runtime → interface / domain / infra / integration / host / client`；`interface → domain / infra / integration`；`integration → domain / infra / host`；`client → host`；`domain → infra`。**`infra` 与 `host` 不依赖任何上层**。

> `runtime → client` 是 G3 自检（C-2A）逼出来的一条：`SEQ-011 基线冻结与门禁签字` 这条时序要驱动浏览器半（`SidebarClientHalf`）把审核单镜像到右栏，而规则里原先只声明到 `host` —— 自检点名「签字问答与右栏镜像（runtime）→ 客户端半（右侧边栏镜像）（client）」方向违规。**这正是分层规则该有的用法：不是写给人看的装饰，而是能让机器把漏声明的边揪出来。**

**设计取舍**：`runtime` 是新引入的层，专门承载五视图里的运行时流程元素（它们天然跨层编排，故允许向下依赖各层）；`host` 层把宿主提供的能力显式建模，使「不自建」这条边界在依赖图上有位置。

**按真源实测出的两处偏差（`DEBT-003` / `DEBT-004`，本轮不改代码）**：

1. `src/infra` 依赖 `domain`（`../domain/dor.js` 的 `isEffectivelyOpen`）—— 读端口径复用把领域判定下沉到了基础设施层；
2. `src/domain` 依赖 `integration`（`../integration/orchestrator.js` 的 `auditWriteScopes`、`independenceViolations`，`../integration/cost.js` 的 `budgetShapeNotes`）—— 依赖方向与规则相反。

两条都已在技术债台账登记并写明偿还触发器（下一次改动对应路径时按依赖倒置修）。**规则记录的是目标态；现状与规则之差被显式记账，而不是被规则掩盖。**

## 5. 怎么复核这份文档

```bash
# 取本包产物的当前指纹（与文档头 basis 比对，不一致即需重新生成本文）
#   → sdo_design action=method
# 看类/时序/分层的真源
ls .sdo/design/method-classes.yml .sdo/design/method-sequences.yml .sdo/design/method-layers.yml
# 看逐条内容与 id
grep -n "id: TYPE-\|id: SEQ-" .sdo/design/method-classes.yml .sdo/design/method-sequences.yml
# 孤儿与覆盖率（应为 孤儿 0、覆盖率 100%）
#   → sdo_trace action=query
```
