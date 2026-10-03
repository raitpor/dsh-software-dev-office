# 更新日志

本文件记录 **dsh-software-dev-office（SDO）** 的显著变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。
**0.x 阶段提示**：次版本号可能包含破坏性变更，升级前建议通读本文件。

## [Unreleased]

### 修复

- **评审 2026-10-03 报告的 A2 真缺陷（已自行复现后修）**：`done` 的写范围对账把"**采到条目但没有文件信息**"误当成"已对账、零越界"。可达路径是"宿主没有 `workspaceChanges` 服务 / `summary()` 返回 `undefined`"（本插件的可选依赖常态）。修法：采集条目新增 `summaryAvailable`（宿主到底给没给摘要），`changedFilesSince` 增加 `audited`（**每条**命中条目都必须带摘要；旧条目缺字段 ⇒ 保守当未对账），`done` 的 `checked` 改用 `audited`。**对照用例**：宿主明确回"零改动"（`files: []`）仍算已核对 —— 与"没有摘要"必须区分。用例 `M30-13`；变异 ㉟（把 `audited` 退回 `entries>0`）→ M30-13 红。
- **minor 1：C7 失败文案把状态说错**。`skip` 但没写理由时会被归进 failing 桶，回执却说"用例结果是 **fail**"。新增缺口类型 `skip-unjustified` 与失败码 `test-skip-unjustified`，文案改为「用例是 skip 但**没写理由**」；`fail` 与"skip 无理由"同时存在时仍优先报 `test-failing`。用例 `M30-10`（断言失败码与文案，并断言**不得**出现"结果是 fail"）；变异 ㊱′ → M30-10 红。
- **minor 2：`exitCode` 检查"存在但调用方够不着"**。`exitCode` 是**字段**，写进 `detail` 文本不会被读到 —— 而工具描述只说 `[{"kind","detail"}]`。现在把完整形状（含 `exitCode` 是独立字段、`sha256=<hex>` 写法）写进工具参数描述（语言包键 `param.evidence`，zh/en 各一份），并加守卫 `M30-14`（断言模型看得到的描述里含 `exitCode` / 独立字段 / `sha256`）；变异 ㊲′ → M30-14 红。
- **修 minor 2 时我自己踩了一个坑（已修并加守卫）**：`param.evidence` **已存在**，我"新增"了一个同名键 ⇒ YAML 后者静默覆盖前者，新文案根本没到模型面前 —— 正是 `M30-14` 当场抓出来的。改为替换既有值，并新增语言包**重复键守卫**（`M25`，逐段扫描 zh/en）：变异 ㊳（塞入重复键）→ M25 红。


### 新增

- **开发阶段加固（五项，按确认的计划 A1 → B4 → A2 → C7 → D9 全部落地）**。核心思路：卡已经把纪律写清楚，但**执行者唯一必经的关口是 `claim` / `done`**，所以新机制全部贴着这两个关口做，能机械判定的才做，判不了的不硬编（避免逼人编造）。
  - **A1 `done` 的证据与卡对齐**（`src/domain/evidence.ts` + `collab.report`）：① 证据种类必须覆盖卡上声明的 `evidenceRequired`；② `artifact` 证据的路径必须**真实存在**（支持 `path` / `path sha256=<hex>` / `path #<hex>`，给了哈希就复算比对；越出工作区的路径判红）；③ `command` 证据若带 `exitCode` 必须为 0。**反向也测**：不给哈希、不给退出码都不拦。
  - **B4 派发提示先让执行者加载角色卡**：`buildDispatch` 的协议多了第 0 步（取 `sdo-role-cards` 索引 → 读本角色卡片），并断言"提示承诺的技能必须在工具面里"（8 个角色逐一核对）。
  - **A2 接线 `workspace/changes` 采集 + 写范围对账**：`apply` 监听宿主的 `session/event` 追加流，对已存在 `.sdo/` 的工作区把 `(sessionId, seq)` 记进 `.sdo/evidence/workspace-changes.jsonl`（`captureWorkspaceChanges` 这个此前**没人读**的配置项现在真的生效）；`claim` 事件本身（带 `sessionId`）当基线，`done` 时用 `auditWriteScopes` 比对**认领之后本会话真实改动的文件**，越界即判红并点名文件。**采不到数据时不判红也不冒充已核对** —— 回执会明写「写范围未对账」（`uiIndex.kWorkScopeNotAudited`）。
  - **C7 测试先行**（`src/domain/testFirst.ts`）：`normal`/`critical` 档的项目里，带需求的卡**认领前必须有用例计划**（`test-case-missing`），**完成前必须有结果** —— `pass`，或 `skip` + 非空理由（`test-result-missing` / `test-failing`）。`trivial` 档与无需求的卡豁免（有意的豁免，而不是悄悄跳过）。
  - **D9 G5 新增判据 `C-42 review.required`**（waterfall/prototype/spiral 三个流程都加）：`size ≥ medium` 的完成卡在**开发完成门禁**就要有 `verdict=pass` 的评审，否则判红并点名。与 G6 的 `C-52 review.independent`（所有完成卡 + 作者≠评审者）分工：G5 更早更窄，G6 更晚更全。
- **用例**：新增 `test/m30.test.ts`（12 条）覆盖 A1（5）/A2（3）/C7（3）/D9（1），B4 的断言进 `test/m4.test.ts`。**每一条都做双向**（该拦的拦、不该拦的不拦）。既有夹具按新契约更新（证据指向真实产物、先计划用例再认领/完成）。
- **变异自证 7/7**：㉘ 去掉种类覆盖→M30-01 红 ㉙ 让产物存在性恒不触发→M30-02 红 ㉚ 让写范围对账看到零改动→M30-08 红 ㉛ 让采集忽略总开关→M30-06 红 ㉜ 让测试先行恒无缺口→M30-09/10 红 ㉝ 让 `C-42` 忽略卡规模→M30-12 红 ㉞ 改掉派发提示里的技能名→m4 派发用例红。（另有两条变异是我自己写错锚点/名字仍含子串，重做后才咬住 —— 已在过程中修正。）
- **角色卡同步**：developer 卡去掉已经过时的「写范围对账尚未接线」并写清 `done` 的五条机器校验；tester 卡写明 C7 的两个硬关口；reviewer 卡写明 G5 的 `C-42`；office 卡在 DoD 里补上证据对账、写范围对账与 `C-42`。


### 修复

- **卡片 footer 去掉过度承诺（独立审计发现的同类问题，已逐条复核代码）**：八张卡原写「真正的硬约束是派发时由流程官施加的 `toolFilter`」——核实后**不成立**：`roleToolFilter` 只被 `buildDispatch` 用来**生成派发请求/回执**（`orchestrator.ts:15,142`），全仓**没有** `subagents.start` 调用；阶段纪律钩子又把 role **硬编码成 `cockpit`**（`src/index.ts` 的 pre-step 钩子），而 `evaluateDiscipline` 对 cockpit **首行放行**（`discipline.ts:39`）；`auditWriteScopes` 同样没有生产调用点。⇒ 今天**没有任何运行时机制在挡越界**。八张卡的 footer 改成如实描述（设计意图 + 当前实现状态 + "禁止事项靠自律、越界由流程官事后对账"）。
- **按独立审计的代码事实补正的卡片细节（每条都在本仓复核过）**：analyst 不能自撰 `Q-*`（问题由 `grill`/红队产生，`REQUIREMENT_ACTIONS` 无 author 类动作）、未授权假设仍算未决；architect 的 `req-des` 边**必须显式建**（`sdo_design action=create` 没有 `requires` 参数，只有拆卡时会自动建 `req-task`）、`sdo_adr action=supersede` 不带被取代 id 会**静默退化成新增**、判据随流程裁剪（`C-22` 敏捷无、`C-30` 螺旋无）、`action=review` 记录的是**用户结论**而非自签；reviewer 的记录 id 形如 `REV-*` 且 **`taskId` 必填**、findings 是 JSON 字符串数组、只有 `pass` 算已评审、独立性只挡「评审人 ≠ 卡 owner」；tester 的 `write` **仍在**（无路径守卫，只挡了 `edit`）、用例计划属开发前的 G4（`C-32`）；delivery 的真源是 `.sdo/delivery/DLV-<n>.yml`（manifest 是指针）、验收矩阵三条机械要求、"不得发布"其实是**不存在**该动作、并有**两个静默陷阱**（`artifacts.kind` 非法归 `source`、`verdict` 非 `fail`/`waived` 当 `pass`）；office 的看板入口是命令面 `/sdo-board --write`。


### 修复

- **八张角色卡与 0.1.2 的能力对齐（用户诉求：卡片和需求/设计阶段有出入）**：审计发现卡片停在 0.1.2 之前 —— **几乎不提任何动作名**，模型拿到卡也不知道该调 `sdo_design action=confirm` 还是 `sdo_gate action=sign`、更不知道 0.1.2 新增的计划评审前置（`needs-plan-mode` → `action=review` / `waive-plan`）、**方法包产物与人审文档**（`action=method|artifact`，G3 `C-29`/`C-2F`）、**适用性声明**（`sdo_requirement action=applicability`/`applicability-confirm`，`C-2C`）、界面视图的区域声明、签字范围与失效语义（`C-2D`）。八张卡按实现重写，并新增一段 **`## 我实际要走的动作`**（逐条写清工具 + 动作 + 回执里要看什么），DoD 段改为引用**真实判据 id**（G2 的 `C1-dor-per-requirement`…`C9-ac-ids-unique`、G3 的 `C-20`…`C-2E`、G5/G6/G7 各条）。
- **顺带修掉一个真缺陷：红队角色没有自己的工具**。设计初稿 §8.2 的掩码表写明「#5（`sdo_redteam`）归 red-team」，analyst 行也写着"不得自跑红队：#5 归 red-team"，但实现里 `red-team` 的 allow 漏了它 —— 被派发后**干不了自己的活**（而卡片输出契约写着产 `REQ-ISSUE-*`）。已在 `src/data/roles.yml` 补回，并把 rationale 写清"只许用 `sdo_requirement` 的 `list` 读，不许 capture/update/change/baseline"（工具级白名单表达不了动作级限制，因此写进卡与 rationale）。
- **新增守卫 `test/m29.test.ts`（5 条，两个方向）**：① 八张卡必须具备七段结构（含新增的动作段）；② **声称要做的**：动作段里的 `sdo_*` 必须在**本角色掩码**内、`action=x` 必须是该工具真实存在的动作；③ **声称做不到的**：被写成"不在我的工具面里/不可见"的工具必须**真的**不在 allow 里；④ 卡片引用的**判据 id / 门禁 id / 产物名**必须真实存在（引用不存在的判据会误导执行者）；⑤ `skills/role-*.md` 与八个角色一一对应。变异自证 **6/6**：㉒ 动作段写掩码外工具→红 ㉓ 写不存在的动作→红 ㉔ 引用 `C-99`→红 ㉗ 引用 `C-2G`→红 ㉕ 把其实有的工具说成不可用→红 ㉖ 删掉动作段→红。
- **卡片里的诚实说明**（避免卡片承诺机器其实没拦的东西）：developer 卡写明"写范围的自动对账尚未接线（`auditWriteScopes` 目前只有单测）"；reviewer 卡写明其评审记录是**按任务卡**的、且没有 `sdo_design`（设计确认与签字不由它落账）；tester 卡写明 `edit` 不可见（只许新建测试文件）。
  - 观察（未改，待用户裁定）：设计初稿 §8.2 的掩码表已落后于实现（office 现在有 `sdo_redteam`/`sdo_task`/`sdo_render`/`sdo_deliver` 等，analyst 有 `sdo_project`，且表里没有 `sdo_lang` 等后加工具）——实现看起来是"单会话驾驶舱"口径的有意演化，但文档与代码不一致这件事本身需要决定往哪边收敛。


### 修复

- **语言包重载键串位（我在核实 `k105` 文案时踩到，已修；并顺带发现一条既有 en 缺陷）**：`k105` 这个键名在 `uiDescribe` / `uiIndex` / `uiGates` **三个段里复用**（与 F-3 同型的重载键）。我按"文件里第一条 `k105`"替换，在 en 包里改到的其实是 **`uiGates.k105`** —— 把英文的**门禁失败**文案覆盖成了派发文案，而真正要改的 `uiDescribe.k105` 没动。已恢复 `uiGates.k105`（门禁文案），并把 `uiDescribe.k105` 改为澄清版（点明是**驾驶舱会话**）。核实过程中另发现**既有缺陷**：en 的 `uiMethod.selectionMissing` 让英文用户去跑 `sdo_design action=grill`，而中文与代码实现都是需求阶段的 `sdo_requirement action=design-questions`（方法选择题确实在需求阶段提出）——已按实现纠正。
- **新增守卫（抓这一类，不针对个案）**：`test/m25.test.ts` 断言**两包的 snake_case 标识符集合逐一对应**。依据：snake_case 跨语言**不翻译**（`send_message` / `sdo_requirement` / `journal.jsonl`），两包出现不同集合就是真写错；而散文、标点、尖括号占位符（`…` vs `...`、`<区域名>` vs `<region name>`）属于正常翻译差异，**不在**守卫范围。实测本仓 1482 个共有键里它只命中上面这 2 处、零误报。变异自证 2/2：⑳ 把派发文案塞回 `uiGates.k105` → 红；㉑ 把 `selectionMissing` 退回旧错 → 红。
  - 我事后做了系统性扫描（逐键比对两包的 ASCII 标识符），确认除这两处外其余 28 条差异都是翻译风格差异，没有第三处串位。


### 修复

- **守卫表里的"惰性条目"（复审 2026-10-02 23:24 §3 的 minor）**：`test/m28.test.ts` 的 `TOOL_PROVIDER` 登记了 `send_message` / `list_agents`，但 `roles.yml` 里**没有任何角色** allow 它们 ⇒ M28-02 的循环永远碰不到这两条 —— "守卫表声称守住了、实际没守"。处置选**评审的选项②**（角色不该有这些工具）：卡片角色由设计元素类型映射（`plan.ts` 的 `VIEW_KIND_OF_ELEMENT`，兜底 `developer`），`office` 从不被派发；"派发 / 转交 / 观察子代理"是**驾驶舱会话**的能力（主会话工具面里确有它们，那几行被挂载由 M28-01 守住）。
  - 新增 **M28-05（惰性条目杀手）**：`TOOL_PROVIDER` 的键集必须 ⊆ `roles.yml` 真正出现的工具名集合 —— 表里不许有"永远不会被断言用到"的条目。**这条守卫一上线就比评审多抓出两条**：`read_image` 与 `subagent`（同样不属于任何角色），一并清掉；表收敛为 roles.yml 真正用到的 8 个名字。
  - 文案随之区分主体：`k105`（中英）与 README「已知边界」都点明是**驾驶舱会话**（被派发的角色没有 `send_message`），避免模型让子代理去用不存在的工具。
  - 变异自证 2/2：⑱ 往表里塞一条角色用不到的条目 → `M28-05` 红（复现评审那条 minor）；⑲ 给角色加一个已挂载之外的工具名 → `M28-02` 红。


### 修复

- **preset 整个注册失败（会话里选不到 sdo-office）—— 我的错，已修**：上一轮照抄官方 preset 的 `tool-fs-search` 行时**只抄了 `id`/`name`，漏掉它下面的 `config` 块**。该包的 `sampleOverCapGlobResults` 是**必填、无默认值**，缺了它挂载期校验直接抛：
  ```text
  tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config:
    - $sampleOverCapGlobResult missing required value (at sampleOverCapGlobResult)
  ```
  而 preset 里**任何一行挂不起来，整个 preset 就注册失败**（DEF-03 那类事故的通用形态）。修法：补上 `config: { sampleOverCapGlobResults: false }`（与官方 standard / ptc / cordis 三个 preset 逐字节一致；`false` = glob 超上限时保留前 N 条、不跨顶层采样）。
  - **同路径本地验证**（不用重启）：拿该包自己的 schema 校验我写的值 —— `Config({sampleOverCapGlobResults:false})` 通过并展开出全部默认值（`globMaxResults:100` / `grepMaxMatches:250` / `timeoutMs:30000` …）；而 `Config({})` 复现出与线上**同一字段**的报错 `$.sampleOverCapGlobResults missing required value`。
  - **对账**：把本 preset 的每一行与官方 `standard.patch.yml` 按 id 逐行比 config —— 触及的作业行全部一致；仅 3 处**有意**不同（SDO 自己的 persona 文案、delegation 只挂需要子集、不挂 model-selection-settings）。
  - **守卫补强（这次不再用正则逐行匹配）**：`test/m28.test.ts` 新增 **M28-04**，按**行块**（`- id: X` 起、缩进更深的所有行）断言：① `tool-fs-search` 的块里必须有 `config:` 且 `sampleOverCapGlobResults: false`；② `tool-subagent` 必须有 `provider`（schema 里 `required()`）；③ 反向 —— `tool-skill` / `tool-subagent-control` / `list-agents` / `tool-fs` / `tool-bash` / `tool-ask-user` **不得**带 config（官方也裸挂，多给会掩盖 schema 变更）。成因就是"守卫只看行在不在、名字对不对，看不见 config 缺不缺"，所以断言必须落在整块上。变异自证 2/2：⑯ 删掉 config 块 → 红；⑰ 把 `false` 写成 `true` → 红。


### 修复

- **同一根因的两处未挂行（复审 2026-10-02 22:48 的 §2 同类审计）** —— 上轮只修了 `tool-skill`，复审把规则一般化（宿主 `dsh-web-app/cordis.patch.yml` 有意 `disabled: true` 的 24 行必须由 preset 补挂）后发现两处缺口：
  - **`tool-fs-search` 未挂 ⇒ 会话里没有 `glob`/`grep`**：`tool-fs` 只注册 `read`/`write`/`edit`/`read_image`，搜索族在另一个包；而 `roles.yml` 八个角色的 allow 里都写着 `grep`/`glob`（**死允许项**）。已补挂。
  - **`tool-subagent-control` 未挂 ⇒ 会话里没有 `send_message`/`interrupt_agent`**：SDO 自己的回执 `k105` 与 README「已知边界」都写着"当前由流程官用 `send_message` 把提示词交给执行者"，`tool-subagent` 的工具描述也提到它 —— 是**承诺落空**。已在 delegation 组内补挂（与 `tool-subagent` 同 isolate 域），并补挂配套的 `list-agents` 行（与 standard preset 同源）。
  - **新增守卫 `test/m28.test.ts`（3 条，两个方向）**：① 集合方向 —— preset 挂载的行 ⊇ "宿主关闭且我们需要"的清单（每项写明为什么需要，含层位/包名/去重检查）；② 功能方向 —— `roles.yml` 里每个非本插件工具名都必须有**已挂载**的提供行（新增角色工具而忘了挂行会当场红）；③ 反向 —— 不得挂 `skill-filesystem`/`skill-badge`，且 preset 里不许出现"没写清用途"的行。三行新行同时登记进 `test/m7.ts` 的 DEF-03 解析清单（登记依据：官方 standard/ptc preset 同挂 + harness 可安装包清单 + 以 loader 自身为基准的 `createRequire` 实测，含子路径 `.../list-agents`）。
  - 顺带更正 `presets/sdo-office.patch.yml` 里 `plan-mode` 的历史注释：原写"preset 引用它会解析失败"**未留存证据**，本轮机械实测显示该包与 `dsh-tool-skill` 同形、从 loader 基准可解析；是否改成一行声明需一次真机实测，**现在保持现状**（能用且已验证）。


### 修复

- **角色卡技能（B2）可达性 blocker（评审员 22:40 评审）**：上一轮把 8 张角色卡注册成索引技能 `sdo-role-cards`，但**在 sdo-office 会话里无人可见** —— 宿主层 `dsh-web-app/cordis.patch.yml` **有意**把 `tool-skill` 与 `skill-filesystem` 关掉（注释原文：`tool-skill` is what a preset mounts to give its agent the catalog and loader at all），而本插件的 preset 里**没有这一行** ⇒ 该会话既没有技能目录、也没有 `skill` 工具。修法：`presets/sdo-office.patch.yml` 的 presets 段加一行 `- id: tool-skill` / `name: '@deepseek-ai/dsh-tool-skill'`（落 preset 层；与官方 standard/ptc/cordis 三个 preset 同形；该包与已工作的 `dsh-tool-fs`/`dsh-tool-bash` 同在 dsh 应用依赖里，解析路径同源）；**不挂** `skill-filesystem`（SDO 是程序化注册，挂文件发现会让 8 张卡各占一个目录项）。
  - 上一轮我把"可达性"定义为"掩码里有 `skill`"就收工，**并据此向你承诺"重启后目录里就会出现该技能"** —— 那是错的：掩码只是必要条件之一，preset 挂载才是让目录与加载器存在的那一步。本轮把断言补齐：新增 **M27-08** 直接读 preset 文件，断言 `tool-skill` 落在 `preset-sdo-office` 的 `config.plugins` 之内（缩进判层位，避免有人加到 profile 层造成全局泄漏）、包名正确、且**不得**挂 `skill-filesystem`。
- **`register()` 未兜住宿主校验（评审 minor 2）**：`registerRoleCardsSkill` 现在把 `service.register(...)` 包进 try/catch，宿主校验规则收紧时降级为"不注册 + 带原因的日志"，不冒泡进插件装配（兑现"不阻塞装配"）。
- **disposer 归属（评审 minor 1）**：`skills.register()` 的 effect 挂在**技能服务自己的 ctx** 上，返回值不会被本插件 fiber 回收（热重载后目录里可能留旧正文，同层同名又是"首个胜出"）。改为 `skillsCtx.effect(() => { …; return dispose }, 'sdo:role-cards-skill')`，让 disposer 随本插件 fiber 逆序执行。


### 新增

- **角色卡技能（B2，开发阶段接线）**：把随包的 8 张角色卡（`skills/role-*.md`）注册为宿主的**一个索引型技能** `sdo-role-cards`，让派发出去的执行者**按需加载**，而不是把八张卡正文塞进每次派发。
  - **为什么是一条索引而不是 8 个技能**：技能目录（名字 + 描述）会进入该 profile **每个会话**的系统提示，注册 8 条就是 8 行常驻 token；索引只占 1 行，卡片正文仍按需加载。
  - **索引正文现算**（`src/domain/skills.ts`）：角色名 / 掩码理由 / allow / deny 取自 `src/data/roles.yml`，卡片路径取自随包文件 —— 单真源、不手抄（改了角色表，索引与用例同步变）；正文中英各一份，走语言包 `skillBody.*`。
  - **可达性是硬前提**：`src/data/roles.yml` 的 8 个角色白名单统一加 `skill`（只读工具）—— 否则"注册成功但执行者调不到"。`src/index.ts` 用 `ctx.inject(['skills'], …)`（与 `planMode` / `subagents` 同一先例）注册，并保留返回的 disposer。
  - **可选依赖、不阻塞装配**：本包**不引入** `@deepseek-ai/dsh-skill`（本地声明可选服务类型 + 最小结构契约）；宿主没装配 skills 服务时静默降级为不注册，只记一条 debug 原因。
  - 测试 `test/m27.test.ts`（7 条）：技能形状符合宿主契约（kebab 名 / 描述非空 / 目录资源 / 可调用）、索引覆盖 8 张卡且每条路径都读得到、注册成功路径与 disposer、**缺服务静默降级**、8 角色白名单含 `skill`、README 记载、描述取自语言包。变异自证 **5/5**：① 索引漏一张卡→红 ② 某角色去掉 `skill`→红 ③ 缺服务时抛错→红 ④ 注册 8 条而非 1 条→红 ⑤ 描述硬编码→红。


### 新增

- **方法包人审文档**（用户要求：设计阶段各方法包的结果要成**文档**供人工审核，而不是只有 `.yml` 台账；文档内容**由模型撰写**）：
  - 选中某个方法包 → 必须有一份 `docs/METHOD-<包>.md`（`structured` / `oo` / `evolutionary` / `porting` 各一份；内容自己写，表格/图/说明都行，例如 OO 出类图与时序图、结构化出 DFD 与 ERD、迁移出映射表）。
  - 文档首行必须是 `<!-- method-doc: package=<包>; basis=<12 位指纹> -->`，指纹按该包产物的**台账内容**现算；`sdo_design action=method` 的回执会逐包给出**当前指纹**与可直接抄的文档头。
  - 新判据 **C-2F `design.method-docs`**（随包四套流程的 G3 同步挂载，与 `design.method-products` 并列）：① 缺文档 → 判红并点名路径与当前指纹；② 文档头指纹与台账不符（**台账改了没重新生成**）→ 判红；③ 正文没覆盖该包每个条目 id → 判红并逐个点名；④ 显式 `none` 或未选包 → N/A（不拦）；⑤ 未回答/非法选择 → N/A（由方法选择判据报红，不重复报）。
  - 新增 `src/domain/methodDocs.ts`（指纹 / 文档状态 / 条目 id 覆盖）与测试支撑 `test/support/method-doc-fixture.ts`；`test/m26.test.ts` 6 条用例（缺文档、齐全后**改台账即判红**再重生成恢复、漏条目、指纹写错、缺文档头、`none` 为 N/A、回执给出指纹）。变异自证 4/4：分别关掉"存在性 / 指纹 / 覆盖"三查与把判据从流程数据摘掉 → 对应用例全部变红。

### 修复

- **修 Windows CI 假红（tag `v0.1.2` 上 windows × node20/22 均失败在"构建并运行测试"）**：复现方式 —— 用 `core.autocrlf=true` 检出（GitHub Windows runner 的默认行为）后跑全量，唯一红项是 **R-6（CHANGELOG 结构）**：它对文件内容做"整行相等"与位置判断，行尾多出的 `\r` 让"等于『修复』小节标题"、"等于『升级须知』小节标题"这类断言全部落空（ubuntu 侧因为检出是 LF 而全绿，所以只在 Windows 暴露）。修法两层：① 用例先把行尾归一（`\r\n?` → `\n`），并且**对 LF 与 CRLF 两种形态各断言一遍** —— 这样"必须归一"在 Linux 上就能被守住，不会再以 Windows-only 的形式回归；② 新增 `.gitattributes`（`* text=auto eol=lf`）统一仓库行尾，从源头消除平台差异。


- **实测评审批次的三条观察（2026-10-02 16:03 / 16:16 评审员）** —— 前两份报告确认 F-1…F-6 与四套流程的 C-2F 均已修，这三条是它们新提的 minor：
  - **观察 1：同一屏两种口径**。立项回执打出 `流程 waterfall ｜ 规模 normal ｜ 阶段 intake`（生 id），而同屏的注入块与 `sdo_status` 用的是本地化标签（瀑布模型 / 中（常规）/ 立项）。现在 `describeInit` 改走同一套 `label()` / `phaseText()`。
  - **观察 2（§2.5/§3.4）：签字范围要写在用户可见处**。签字回执新增一行：签字范围 = 设计真源（视图/元素/契约/ADR/追溯边）；**质量属性场景（`quality/recorded`、ATAM）属补充证据，不在签字范围内**（追加它们不会让签字失效）。实现口径不变（`quality/recorded` 仍在中性表，P-16 实测依据不变），只是把"签了字覆盖什么"说清。
  - **观察 3（§3.5）：流程声明的产物无人校验**。核实结果：`artifacts:` 在**四套流程的每个阶段**都有（VISION.md / SRS.md / SDD.md / PLAN.md / DELIVERABLE.md …），但**没有任何消费者**（`ProcessDef` 类型里都没有这个字段）——即 30 处声明全是装饰。收尾选择"**把语义写实**"而不是"给 16 个文件都加门禁"：字段改名为 **`suggestedArtifacts`** 并在四份流程数据顶部注明「建议产物、不入门禁；真正可强制的是项目自己的设计适用性声明（G3 的 C-2C 逐条校验存在性）」。理由：给所有阶段的建议产物加存在性门禁会逼人造假（例如 TRACE.md / BACKLOG.md），而 C-2C 已经提供了"逐项目显式声明 + 逐条 why"的可强制路径。
  - **`trace/unlinked` 是否中性（观察 2）**：**维持**"让 G3 签字失效"（撤销/新增追溯边会改变 C-21 覆盖率与孤儿判定，属设计承诺变更），并在 `types.ts` 的中性事件表上方写明这条判断的依据与"若将来改判该怎么做"。
  - 回归：`test/m25.test.ts` 增 3 条（生 id 消失 / 签字范围行 / 流程数据不得再有裸 `artifacts`），变异自证 3/3（分别回退 → 对应用例变红）。

### 修复

- **sdo-test 回归报告（2026-10-02，立项到设计；F-1…F-6：1 blocker + 2 major + 3 minor）** —— 全部经评审员在台账副本上复现为真；其中 **F-3 的根因按评审员的更正**处理（不是"没走 fmt() 管线"，而是语言包键被两个功能**共用且语义冲突**）：
  - **F-1（blocker）`render --puml` 让 C-25 假红并反过来指控用户伪造**：一次渲染会写**两条**同 `seq` 的 `design/rendered` 事件（文档一条带 `phase`、puml 骨架一条**不带**），而 C-25 只按 `type + seq` 过滤后取 `.at(-1)` → 后写的 puml 事件顶替了文档事件，`phase` 为空即判"头里的阶段被改过"，用户按 remedy 再渲染也修不好（自愈只是巧合）。现在：**只让文档自己那条事件参与背书**（`kind === 'DESIGN.md'`），并给 puml 事件同样补上 `phase`（双层）；`kDesignDocPhaseForged` 文案去指控化（改为陈述"头与事件不一致"）。
  - **F-2（major，评审员建议按 blocker 排期）线框图按数量均分把栏目排错区域**：`regionBuckets()` 只按"栏目数 ÷ 区域数"切分，于是**每个区域数 ≠ 栏目数 的屏都是错的**（实测 5 栏 3 区把「出发站/到达站」排进页头；7 栏 7 区整体错位一格）。现在：`UiColumn` 支持 `region` **显式声明**（必须是本屏 `layout.regions` 里的名字，声明优先）；全部未声明才退回均分，且**必须在图里标注"这是猜测"**（ASCII 线框图与 `.puml` 骨架同口径）；声明了不存在的区域名 → 在图里**点名**栏目/声明值/可用区域。
  - **F-3（major）`sdo_init` 回执占位符漏出 + 首行与事实矛盾**：`uiDescribe.m1..m7` 被**三个消费者共用**（立项回执 / `sdo_project action=update` 的"没写入任何字段" / 设计门禁回执的「…设计被拒：<原因>」+「查看」「进入」），于是立项回执打出"本次没有写入任何字段""已记录质量场景 waterfall""{p2} 已渲染 .sdo → `{p2}`"这类语义错位文本；`uiIndex.k7` 又被 `t()` 调用而文案带两个占位符（回执尾行变成"已建立 {p1} 条追溯边"）。现在：立项回执有**自己的**一组键（`uiDescribe.init*`），`m1..m7` 回归各自的消费者，`uiIndex.k3/k7` 改成无占位符文案；另修掉一处**插错段位**的键（`uiDescribe.k9Unverified` 落到了 `uiTools`，导致降级回执漏出键名）。
  - **F-4（minor）签字引用对不上时不给替代通道**：`kSignQuoteMismatch` 现在明说"若用户是通过提问选项表态的，改用 `channel=question` 记录所选选项原文"。
  - **F-5（minor，比报告更硬）`des-ct` 是**永远建不起来**的死类型**：`link()` 把 `DES-` 与 `CT-` 一起拿去和"设计元素全集"比对，而契约存在 `<dir>/contracts/` → `CT-*` 永远命中不了。现在**按 id 前缀选全集**（`DES-` → 设计元素，`CT-` → 契约，报错也点名是哪一类），并补 `sdo_trace action=unlink`（撤销追溯边：`links.jsonl` 里的**坏行原样保留**，不顺手抹掉追溯坏行的证据）。
  - **F-6（minor）方法产物重写即重新编号、旧追溯边悬空**：id 只在条目**自己声明**时才稳定，未声明者每次写入按 `usedEntryIds` 往后发号（`PROC-001…→PROC-007…`）。现在：未声明 id 时**先按 `name` 复用盘上同 kind 同名字段的 id**（DFD 加工与时序这两条独立发号路径也一并接上），复用不到才发新号。
  - **新增类级守卫**（`test/m25.test.ts`）：① 从**编译产物**提取所有 `t()/fmt()` 调用，断言键在中英两包都取得到 —— 这条守卫当场抓出上面那处插错段位的键（旧守卫只扫 `t()` 字面量，`fmt()` 完全没人守）；② 断言 `t()` 调用的文案**不含 `{pN}`** —— 这类"必然漏出占位符"的写法从此会被自动拦下。变异自证 7/7：F-1（按原始缺陷形态回退：无 phase + `at(-1)`）、F-2、F-3、F-4、F-5、F-6、语言包守卫各有一条用例变红。


- **评审员核实 第 5 轮（2026-10-02，§4 注入块口径 + CHANGELOG 编号统一）**：
  - **§4 三面口径补齐**：注入块的截断告警此前只说"真源损坏 + 派生投影不重建"，**少了**"以事件流为证据的判定一律「无法判定」"那半句（回执与看板都有）—— 而注入块正是**模型每轮真正读到的东西**，`CHANGELOG` 却已经声称三面都写了。现在三面同口径，并由用例一次性断言三面（注入块/回执/看板）。
  - **CHANGELOG 编号统一**：此前 `### 修复` 下混用两套编号（`第四轮复审` 指 sdo-test **缺陷复审报告**轮次；`第五/六/七/八轮复审` 指**评审员核实**轮次），且排序不单调（前段最新在前、后段最新在后）—— 评审员已被这套编号误导过一次。现在统一为 `缺陷复审报告 第 N 轮` 与 `评审员核实 第 N 轮` 两套明确前缀，整段严格**最新在前**，并由 `test/m23.test.ts` 的 R-6 用例**断言单调性**（不再只是"每轮只出现一次"）。
  - **诚实记录：本次编号统一时脚本写坏过 CHANGELOG，已按字符流原样恢复**。归一脚本的解析器只认 `- ` 与 `  - ` 两种缩进，把 4 空格缩进的嵌套项（第 4 轮的 ③a/③b/顺带核实）**静默丢弃**；随后的写回又因一处 Python 错误把区域按"每行一个字符"展开（换行丢失、连续空格被折叠）。恢复方式：该次损坏**可逆**（区域内的字符序列完整），按字符流重建区域、按已知的 11 个组头重新切分并恢复缩进，被丢弃的三条嵌套项按作者原文补回。恢复后自证：组头 11 ／ 子项 61 ／ 嵌套 3，编号单调，R-6 用例与全量测试通过。教训：**改 CHANGELOG 这种长文档要先用解析器往返验证（读回后逐项比对），不要直接就地重排**。

- **评审员核实 第 4 轮（2026-10-02，展示面口径 +「先核实再改」三项）**：
    - **③a `gates/*.json` 写坏**：核实结果 —— `status()`/`boardModelFor()` 早已兜住（回执点名 `gates/G2.json`、看板给 `readError`），但**公开只读入口 `office.gateOverview()` 未兜**（`gatesFor()` 裸抛）。已改为可读失败（`gate.unreadable`）。**随后按用户裁决删除该方法**：核实确认它没有设计依据（设计初稿的动作表只有 `check`/`advance`/`waive`，后补 `sign`/`rollback`），文档（`docs/**`、README）零引用，git 全历史只有引入提交 `a4d97e8 推进M2`、**从未有过调用方**；其能力今天由 `boardModelFor`（`boardGates` + `currentExitGates`）、`gatesFor()` 与 `sdo_status` 承担。用例改为打**存活路径**（status 的 `truthError`、回执、看板装配的 `readError`，以及"域层按分层约定仍抛"这条边界）。
    - **③b `--rebuild` 的回执**：核实结果 —— 旧实现把 `office.rebuild()` 的返回值**丢掉**，于是用户显式强制重建后，回执既不说明「已强制重建」，也不说明「真源残缺、本次只折叠到最后一致前缀、阶段可能回退」（而且这一次读取的 `status.rebuilt` 必然是 false，看起来像什么都没发生）。现在回执显式说明这两点（健康真源与残缺真源分别措辞，含坏行号）。
    - 顺带核实到一条**与报告不符**的事实（已用探针反证）：评审员 §3.3 说「`gatesFor` 排序键 / 最近判定留痕在截断期会静默冻结在坏行之前」——**不成立**：`gates/*.json` 是文件、`lastGate`/`gatesFor` 由文件派生，journal 中段坏行**不改变**它们的输出（探针：损坏前后 `lastGate` 逐字节相同）。真正会冻结的只有"事件流"那一族，已在上轮 fail-closed 修掉。
  - **①写回执逐条提示**：按裁决**不做**（截断告警已在注入块/回执/看板三面统一给出）。
  - **②展示面与判定面一致（已做）**：看板自己的截断提示此前是旧口径（「journal **尾部**损坏…看板只反映最后一个一致前缀」），与判定面（"事件流类判定一律无法判定"）**说法不一致**，且「尾部」对中段坏行不准确。现在看板提示与注入块/回执同口径：点名坏行、说明**以事件流为证据的判定此刻一律「无法判定」**、并声明看板上的记录**不代表当前判定**。
  - **③ 两项未核实项：先核实，再按核实结果修** ——

- **评审员核实 第 3 轮（2026-10-02，§3 截断期 fail-closed）** —— 上一轮 §4（投影静默回退）已被确认修好（验收探针第一组 6/6 PASS）；这一轮修的是同一根因在**判定侧**的第二半：
  - **§3 截断期「以事件流为证据」的判定不得自信作答**：`journal` 遇坏行只返回「最后一致前缀」，而坏行之后的事件照样写入。旧实现据此**自信作答**，实测两条假结论：① 截断期改需求后 **G3/G2 签字仍报 `valid`**（签字失效机制静默失效，正是 D1/N-7 承诺的东西）；② 截断期**合法重渲染**后 C-25 反而宣布「journal 里没有任何 `design/rendered` 事件」，而按它的 remedy 再渲染一次也修不好（新事件仍落在坏行之后）。
  - **顺带修掉同根因的 `seq` 分配缺陷**（本轮双向断言逼出来的）：截断期 `append()` 用「截断前缀长度 + 1」分配 `seq`，会与既有事件**重复**、破坏本条真源「seq 单调」的硬不变量，而且让基于 seq 比较的失效判定在修好 journal 之后**仍然看不见**那次变更。现在分配 `seq` 取「前缀长度」与「**盘上全文最大 seq**」的较大者 + 1。
  - **口径选择（记录在案）**：没有采用评审员建议一的「截断期一律拒绝写」—— 那会把"视图陈旧"变成"**部分写入**"（真源文件已改、事件被拒），风险更大；采用建议二（判据 fail-closed）+ 修 `seq` 单调性，`journal` 修好后写入的事件自然被看见（用例已断言：修好坏行后签字**必须**变 `stale`）。 - 文案对齐：注入块与 `sdo_status` 回执的截断告警不再说「**尾部**损坏」（中段同样触发），并写明「在修好之前，以事件流为证据的判定一律**无法判定**，派生投影也不会被重建」。

- **评审员核实 第 2 轮（2026-10-02，§4.4／§4.5）** —— 前三条（§5.1/§5.2/§5.3）已确认修好；这一轮修的是本轮核实中**新发现**的一条无声缺陷：
  - **§4.4（重要）`journal` 中段坏行 + 任一写操作 ⇒ 派生投影被静默回退**：`append()` 追加事件后**无条件** `rebuild()`，而 `rebuild()` 折叠的是 `read()`——它遇坏行即截断。于是崩溃半写留下的**一行**坏 JSON，会让任何一次写操作把"截断前缀"折叠结果**覆盖**进 `project.json`，实测阶段从 `architecture` 打回 `intake`（评审员的验收探针 6/6 写入口全部复现），而盘上 journal 里坏行之后的事件其实都还在 —— 正是本项目最忌讳的"无声状态回退"。现在：`read().truncated` 时**拒绝覆盖已有投影**（保留最后一份良好投影 + 保留截断告警），只有**显式**入口（`sdo_status --rebuild`，`office.rebuild` 传 `force`）才允许在"真源不完整"的前提下强制重建；投影缺失且 journal 被截断时也只给内存视图、**不落盘**（不把截断前缀固化成事实）。
  - **§4.5 投影重建留痕**：注入块新增一行「投影已由 journal 重建（上一次读取时它不可用）」——避免"读真源失败的告警莫名消失"让人误以为问题自己好了。 - 截断告警文案改准：不再说"**尾部**损坏"（中段坏行同样触发），并写明「**派生投影不会被重建**（保留最后一次一致状态）」与强制重建入口。 - 验收：评审员自带的探针 `.review/probes/projection-rollback.mjs`（6 个写入口 × 全新副本）从 **6/6 FAIL 转为 6/6 PASS**（`--line=40` 变体同样 PASS）；`test/m23.test.ts` 增加该形态的回归（含反向：只有显式 `--rebuild` 才会按截断真源重建）。

- **评审员核实 第 1 轮（2026-10-02，§5.1／§5.2／§5.3）** —— 这一轮修的是"降级路径上仍在**说假话**与**裸抛**"：
  - **§5.1「读不出」不得渲染成「没有」**：`project.json` 坏掉时（它是**可重建的派生投影**），注入块与 `sdo_status` 回执会断言「当前目录尚未初始化 / 当前工作目录下没有 `.sdo/`」——`.sdo/` 明明在（实测 861 条事件），而且告警的**早返回顺序**还把 `truthError` 吃掉了。现在两处都先打告警、并把结论改准：**「项目投影读不出，无法确认是否初始化」+「这不等于没有 `.sdo/`」**，同时说明恢复路径（派生投影由 journal 重建；手写真源才需要按相对路径修）。这与 G-07（工作区未知时不得断言尚未初始化）是同一类纪律。
  - **§5.2 `checkGate` 的降级分支自身裸抛**：它在失败分支里**又读了一次 `contextFor`**（正是刚失败的那一步），于是 `sdo_gate action=check`（用户卡住时最该能用的入口）以 `SyntaxError` 收场。改用最小路径落盘并整段兜底；落不下也照样返回 `gate.unreadable`，并在 detail 里注明「本次未落盘」。
  - **§5.3 `boardModelFor` 的流程读取未兜底**：`office.process(call)` 会让 `/sdo-board` 整条失败。现在**全部**读取（requirements/process/gates/tasks/iteration）统一走同一个包装，读不动就用回退值（流程退回随包瀑布）+ 顶部告警，看板照常出图。
  - **顺带补一个报告没提、用例逼出来的缺口**：`SdoStore.readJson` 的 `JSON.parse` 报错**没有文件名**（`readYaml` 早有 R-14 那层补丁）。现在 `project.json`/`gates/*.json`/成本快照等 JSON 真源的报错同样带**相对路径**。 - 另按评审员建议：域层列表方法（`requirements`/`questions`/`risks`/`issues`/`boardRequirements`）补**分层注释**（不吞异常是有意的，兜底在工具/看板调用面）；`journal` 截断告警上移到计数之前，与 `truthError` 并排。 - 如实记一条**自愈**行为（评审员矩阵顺带暴露）：`Journal.append()` 会 `rebuild()`，所以坏掉的 `project.json` 在下一次真源写入后会被按 journal 自动重建 —— 派生投影不必手改，这一点已写进告警文案与用例。

- **缺陷复审报告 第 4 轮（2026-10-02，R-1…R-14：2 blocker + 1 major + 11 minor）** —— 这一轮的性质与前三轮不同：**上一轮修好的机制又被一个不安全的前提放回了旧洞**：
  - **R-1（blocker）渲染缓存重新打开了"假绿"**：缓存键只看 journal，而它的安全论证"任何真源写入都会留一条 journal 事件"**是错的** —— `.sdo/` 下的 `*.yml` 是**给人手改的真源**，手改不产生事件。实测：手改 `design/component.yml` 里一个文档可见字段后，缓存把编辑前的渲染端了上来，C-25 拿旧正文与盘上旧文档比对 → **PASS**（假绿），而"按当前真源真渲染"与盘上文档并不一致。现把**全部手写真源的指纹**（`count:size:maxMtime`，递归 `.sdo/`、排除 journal 与临时文件）纳入缓存键 —— 约 1ms，相比 52ms 的重渲染依然划算，且把"手改"这条路径补上。
  - **R-7（blocker）异常兜底装错了层**：`evaluateGate` 内部的两层 try/catch 挡不住 `gateContext` —— 它在调用 `evaluateGate` **之前**就读四类真源。实测：把 `.sdo/requirements|questions|risks|issues` 任一 YAML 写坏 → `status()`（**注入状态块**）/`evaluate()`/`advance()` **全部抛异常**。另一侧：判据循环**之后**的形状提示收集没有兜底，坏 `design/*.yml` 会冒泡到外层 → **G3 的 14 条判据塌成 1 条 `gate.internal`**，与 remedy 承诺的"其余判据照常判定"相反。现在：① 新增 `safeGateContext` 兜底（`evaluate`/`checkGate`/`currentExitGates`/`advance`/`gateOverview` 全覆盖），读不动就返回可读判红 `gate.unreadable`；② `status()` 整体兜底为**降级快照**（新增 `truthError`，且待判定门禁取**最保守**的第一个出口门禁，绝不显示成"全绿"）；③ 形状提示收集单独兜底（判据照常逐条判定，只在该判据 detail 里写"形状提示查不动"）；④ `waiveGate` 改用轻量上下文（豁免是用户此时的自救手段，不该被别的真源写坏牵连）；⑤ **可见性（评审员 §4.1/§4.2）**：`truthError` 此前只是 API 字段 —— 注入块/看板/`sdo_status` 一个字都不显示（「读不出真源」在模型看来与正常无异），且 `office.requirements()`/`boardRequirements()` 这类**只读列表入口仍裸抛**（`sdo_requirement action=list`、`/sdo-board` 会以异常收场）。现在三处渲染都显式告警（带**相对路径**，并说明「下面的计数/门禁状态不可信」），只读列表入口统一转为可读失败，看板装配抽成 `boardModelFor()`（读不动也能出图 + 顶部告警，且因此变得可测）。
  - **R-2（major）C9 的 remedy 不可执行**：`update` 的 `acceptance` 是**追加**语义、全仓没有改号/删除入口 → 存量重号按提示做**永远修不完**（传新号只是又追加一份）。新增 `acceptanceMode=append|replace`（工具 schema + handler + 域层 `replaceAcceptance`），remedy 同时指向"整份替换"与"手工编辑 requirements YAML"。
  - **R-8**：内容判定**优先于** `patch.status`（旧写法允许"改内容 + `status: baselined`"绕过 P-12）。
  - **R-9**：`update` 改内容（已冻结 → `changed`）**同时递增版本号** —— 与"版本号只表达内容改过"（M3）对齐；此前只有 `change` 路径会涨版本。
  - **R-10**：渲染头里的 `phase` 也必须有白名单（此前语言有、阶段没有）—— 实测把头改成 `delivery` / `99` 照样判绿，于是文档在审计上可以说"我是在交付阶段渲染的"。
  - **R-12**：比对前归一行尾（CRLF → LF）—— Windows 编辑器保存整份文档会"什么都没改却一直红"，而文案只说"被手工改过"。
  - **R-14**：YAML 报错**带上相对路径**（`store.readYaml` 统一补，NFR-009：只写相对路径），并在判据 detail 与 `gate/result` 里用 `unjudged` 区分"**查不动**"与"**判不过**"。
  - **R-11 / R-13**：回退留痕的判据明细补 `desc`、按"审计是否关心"裁剪体积（通过的判据只留 id/ok），并把文档里的键名改准为 `invalidatedDetails[].criteria`。
  - **R-3**：缓存依赖清单写全（R-1 的真源指纹已覆盖 `project.json` 重建这条路径）。
  - **R-4**：命令面补读 `--turn`（文档已宣传、实现却静默丢弃 —— P-18 的反向形态）。
  - **R-5**：`method.ts` 改 `import { isEffectivelyOpen } from './dor.js'`，去掉第三份手抄（N-1/P-6 的成因正是"同一概念多份手抄"）。
  - **R-6**：CHANGELOG 排版与计数改准（第二轮那条从「升级须知」下移回「修复」；`P-1…P-18（P-4 空缺）`）。

- **缺陷复审报告 第 3 轮（2026-10-02，P-1…P-18，P-4 空缺，共 17 条）** —— 上一轮把"机制的强度"补上，这一轮把**剩下的缝**补上：
  - **P-15 文档绑定从"正文"改成"整份文件"**：旧实现比对时剥掉开头连续的 `<!--` 注释行，于是任何人（或模型）都能在文档顶部写任意声明（实测 `<!-- 已人工核对… -->`）而门禁一个字都不看。现在整份文件必须等于"按头里的元信息重渲染"的结果（语言、阶段都取头里声明的值，所以推进/切语言不会假红）；渲染头声明的语言必须是随包语言，否则报"头在撒谎"而不是误导性的"缺章节"。
  - **P-14 让"渲染过"可证**：新增校验 `journal` 里必须有 `design/rendered` 事件、其载荷 `seq` 与头里的序号一致 —— 旧实现只认头里的数字，"声称渲染过"与"真的渲染过"在判据眼里没有区别。
  - **P-11 检查器异常不再让门禁"说不出话"**：手写真源写坏（YAML 缩进/类型）会让检查器抛 `YamlSubsetError`，而 `evaluateGate` 的调用方没有 try/catch —— 连**注入状态块**都会一起失败。现在逐判据捕获 → 该判据判红并带上异常信息与补救，其余判据照常判定。
  - **P-12（N-14 的副作用）改了内容必须退出"已冻结"**：`update` 改内容时旧实现不碰 `status`，于是 N-14 的"已冻结就跳过"会让**冻结事实停在旧内容版本上**（`baseline.{at,by,evidence}` 与真实版本不符，且不写 `requirement/baselined`）。现在内容字段（title/kind/statement/rationale/priority/source/acceptance）变更会把 `baselined` 需求退回 `changed`（评分/问题账本这类投影不算内容变更）。
  - **P-5 存量 AC 重号现在查得出**：N-2 只堵了"以后写不进来"。新增 G2 判据 **C9**（`dor.ac_ids_unique`，随包四套流程同步）—— 一次 `sdo_gate action=check gate=G2` 即点名每个重号与其归属。
  - **P-6 "未决"口径收敛到一处**：SRS 的两处计数/清单、`DESIGN.md` 的未决数、`grill` 的三处"问过没"过滤、红队防重问，全部改走 `isEffectivelyOpen`（未获用户授权的 `assumed` 仍算未决）—— 此前门禁说"有 1 条未决"而文档写"（无）"。
  - **P-16 黑名单补上"写入但不改文档"的三类**：`redteam/*`、`issue/*`、`quality/recorded`（实测：固定同一 seq 重渲染，正文逐字节不变；对照的 `adr/recorded`、`contract/recorded`、`question/answered` 都会变），避免设计阶段跑一轮红队/记一条质量场景就要重签；`design/grill` 与 `question/*` 仍让签字失效。
  - **P-17 回退留痕把承诺说准**：`gates/*.json` 删除后 journal 只能复原**结论与清单**、复原不了判据明细 —— 现在删之前把 `criteria`（detail/remedy）写进 `phase/rolled-back`，注释与 CHANGELOG 同步改准。
  - **P-1 给 `design.doc` 的重渲染加进程内缓存**：键含 `journal` 文件的 size+mtime（重建工作区/追加都能区分），只用于**只读判据路径**；此前每轮注入都要重渲染一份 70KB 文档（实测约 52ms/次）。
  - **P-3 验收矩阵必须引用真实存在的 AC**：`deliveryCompleteness` 此前只查"每条 must 需求有验收行"，不看 `row.criterion` —— 引用 `AC-999` 或指错需求照样绿。现在逐行校验编号存在且属于该需求。
  - **P-7 `--channel` 非法值报错而不是静默降级**：`--channel=wechat` 曾被当成"会话明确表述"（那套语义更严：引用必须能在会话记录里找到）。
  - **P-8 `tests.passed` 补坏行前置检查**：追溯坏行的检查抽成一处（`traceBadLinesFailure`），三条读 `report()` 的判据统一调用，不再"同族两套口径"。
  - **P-9 `readLinks` 标 `@deprecated`**：它丢掉坏行计数，留着是"下次再犯"的入口；凡喂判据/报告的调用一律走 `readLinksChecked`。
  - **P-10 `change.ts` 收敛到同一份解析器**：此前它自己抄了一份（只查 `from`/`to`、不查 `kind`），于是一行"缺 kind"的边在影响分析里算正常边、在追溯判据里算坏行。
  - **P-13 签字失效理由列前 3 条 + 标注未分类事件**：只报第一条会把读者指向"早已无关的旧事件"，而真因可能是一条尚未分类的新事件（黑名单口径下按保守处理）。
  - **P-18 命令面文档与排序键**：README 与双语 `command.sdo-gate` 补上 `--sign/--quote/--channel/--rollback/--to`；`gatesFor` 的排序键从 `startsWith('gate/')` 收成只认 `gate/result`（`gate/signed` 不再冒充"最近判定留痕"）。
  - **M1 / Z-5 两条口径决策维持不变**（用户已拍板）：语义分仍只由陈述/理由/验收标准与显式 `dimensions` 组成（口径已写进 README「设计要点」）；非视图工件的"两处都没列即 N/A"不对称保持（desc 已同源）。

- **缺陷复审报告 第 2 轮（2026-10-01，N-1…N-14 + 回归猎手 R-7，共 15 条）** —— 逐条都是"把变严/新加的机制从**自证**改成**绑定**，并把诊断层跟上"：
  - **N-8 / Z-2（X-1 的残留）文档即证据必须绑内容**：C-25 此前只做 `event.seq > seq` 的**单侧**比较，于是把渲染头伪造成**未来序号**（`journal seq 99999999`）就能让陈旧文档永久判绿；章节检查又只是"11 个标题字符串包含"，**331 字节的空壳文档**（伪头 + 11 行标题）照样 PASS。现在：① 渲染序号必须有上界（`1 ≤ seq ≤ journal 末事件`）；② 保留"渲染后有内容类事件 → 陈旧"的**精确**报错；③ **正文必须与「按渲染头序号从当前真源重渲染」的结果逐字节一致** —— 空壳、手改正文、伪造序号一并判红。为使这条判据成立，`DESIGN.md` 正文不再写"当前阶段"（易变元数据挪进渲染头注释），文档因此成为设计真源的**纯函数**。
  - **N-11 切界面语言不再假红**：渲染头新增 `<!-- meta: lang … ; phase … -->`；C-25 按**渲染时的语言**校验标题并重渲染正文（新增 `withLocale()`），中文文档在 `en` 会话、英文文档回到 `zh-CN` 都判绿。
  - **N-7（Y-2 的残留）签字失效改黑名单**：G3 此前是白名单，漏掉 `adr/recorded`（喂 C-22）与 `trace/linked`（喂 C-21）——独立复核实证"签字后新增一条只写结论的 ADR，C-2D 仍 PASS"。现改为**黑名单**（`SIGNATURE_NEUTRAL_EVENTS`：只有纯读/渲染/计量/记账类事件不作废），**新增事件类型默认失效**，并顺带堵上 `quality/recorded`。G2 仍用白名单（改设计不该作废需求基线签字）。
  - **N-9（B1 的副作用）拦得住也要说得清**：`baseline` 失败回执此前只印 DoR 的 7 条，于是"DoR 全绿 + C8 红队议题未闭环"时用户看到"7 条全 ✅ 却过不去、没有原因也没有 remedy"。现在失败结果带上门禁现算结果，回执单列**不在 DoR 里的**判红判据与其 remedy。
  - **N-10（D2 的副作用）看板与状态必须同源**：看板此前直接印 `gates/*.json` 留痕，同一次渲染里会出现"待判定 G3"（现算）与"已通过 … G3"（留痕）两个相反结论。现抽出门禁装配 `boardGates()`：**当前阶段的出口门禁走现算**，其余（历史、已不再是出口门禁）仍按留痕。
  - **N-5 状态块标注留痕语义**：`最近判定：…` 改为 `最近判定留痕：…（留痕 ≠ 当前判定）`。
  - **N-1 未决口径统一到第三处**：`redteam.closed`（G2 的 C8）此前只看 `status === 'open'`，而 C2 用 `isEffectivelyOpen` —— 手把质询问题改成未授权 `assumed` 时，同一门禁里两条判据对同一份数据给出相反语义。现共用同一把尺子，并把"已降级为未授权假设"与"已回答"在理由里分开说。
  - **N-2 AC 编号唯一性收口**：M8 只堵了"自动发号不查全局"，**显式给号**仍可跨需求重号（C3 不查唯一性 → 交付验收矩阵错配）。现在落盘前机械拒绝（点名冲突号与占用它的需求），不静默改名。
  - **N-3 追溯坏行不得静默**：`trace.ts` 的 `catch {}` 连计数都没有，而"靠 total 与文件行数对不上被发现"的前提不成立（report 从不给行数）——一行坏 JSON 就能让覆盖率/孤儿在**不完整的图**上判绿。现如实回报坏行数，`trace.orphans` / `trace.coverage` 在坏行存在时**判红并点名**。
  - **N-14 重新基线不再顺手作废 G3 签字**：`baseline` 对**全部**需求无条件写 `requirement/baselined`，而它在 G3 的失效集合里 —— 用户在架构阶段做一次"与我无关的重新基线"，已签好的设计签字就废了。现只对**真正需要冻结**（尚未冻结）的需求写该事件；内容变更仍由 `requirement/updated` 背书。
  - **N-13 序号口径写清**：渲染头写的是"渲染**前**的最后一条事件"，正文里那一行与文案一并说明。
  - **N-12 C-20 的 desc 与实现同源**：四套流程的 desc 从"五视图齐备"改为"声明里要做的视图齐备（五视图非空；声明要做界面视图时须有界面证据）"，成功文案同步（`en` 的 `criterion.C-20` 一并改）。
  - **N-4 `/sdo-gate` 补 `--sign/--quote/--channel/--rollback/--to`**：B2/D1 之后需求基线签字只能走工具面，命令面这条入口根本完成不了流程（不是绕过，是死角）。
  - **R-7 原话核对不得静默降级**：拿不到会话历史时旧实现 `return true`，防线悄悄退化成"引用非空"。现把核对口径落进签字台账与事件（`basisChecked: session | unavailable`），**回执当场告警**，且 C7/C-2D 的 detail 与有效理由都带上"本次未经过会话历史核对"。
  - **Z-4 判据强度写进 detail**：`phase.rollback-recorded` 标注"合法性来源 = 各回退事件自带的 `legalAtThatTime` 自证（强度等于'事件不可伪造'）"。
  - **M1 评分口径正式声明**（不改评分实现）：八维语义分只由陈述/理由/验收标准与显式 `dimensions` 组成，**审讯回答正文不参与评分**；这条口径写进 README「设计要点」，回执继续每次说明。
  - **N-6 老台账的语义分界**：`.sdo/journal.jsonl` 里 M4 之前的 `gate/result` 记录可能出现 `passed` 与 `failed: [...]` 并存（旧构建产物），而 `gates/<id>.json` 可能已被后续 `check` 重写 —— **审计以 `gates/<id>.json` 的最近一次判定为准**；journal 是追加式真源、不回溯改写，本版起新记录不再产生这种矛盾。

- **注入块/看板的"待判定门禁"与 `advance` 判据不同源（D2 收尾）**：`office.status().pendingGate` 此前按 `gates/*.json` 判定留痕算（"盘上有没有一条 `passed`/`waived` 记录"），而 D2 之后 `advance` 是**现算**出口门禁 —— 于是真源变坏、还没显式 `check` 时，注入块（模型的主要指引）与看板仍说"门禁都过了"，`advance` 却当场拦人。现改为复用同一个 `evaluateGate` 现算口径（新增 `office.currentExitGates()`），`pendingGateOf` 也改为**只接受现算结果**（传留痕会在注释里被明确禁止），并补一条双向用例：真源变坏 + 盘上留着陈旧 `passed` 时，`status().pendingGate` 必须点名 G2，且与 `blockedBy` 一致。

- **回退回执漏报"仍处于豁免状态"的门禁**：`tailoring.waivedGates` 是用户的显式决定，回退**有意**不撤销它 —— 但回执只说"目标阶段及其之后的出口门禁已失效，必须重新通过：G4 G5 G6 G7"，用户会以为豁免也被作废。现 `rollbackPhase` 回报 `stillWaivedGates`（并写进 `phase/rolled-back` 事件），回执多一行"其中 G4 G5 G6 G7 仍处于豁免状态（豁免是你先前的决定，回退不撤销它），回来时不会重新判红"。**语义不变，只补可见性。**

- **补一条"回退后未豁免的门禁必须被重判"的独立用例（M14-10）**：既有回退用例的夹具为了走到交付阶段把 G4–G7 **豁免**掉了，"回退后必须重判 G4"这条语义在那里根本无法表达（G4 恒为 `waived`）。新用例走 normal 档（不豁免任何门禁）、先把 G4 真源做到全绿 → 交付 → 退回详细设计（G4 留痕被作废）→ 把契约作废并**手工放一条陈旧 `passed` G4 记录**：`advance` 必须现算成 `blockedBy=G4` 并把留痕覆盖成 `failed`；把契约补回来后重判通过、可推进。

### 文档

- **README 重写为「介绍 + 用法」**（用户要求：不写设计决策与决策理由）：
  - **删掉**了 `为什么需要它`（原则/动机表）、`设计要点（为什么这么做）` 两节，以及散落各处的理由句（"这是刻意的入口设计""这是**有意**的口径""三条硬规矩都是真机教训"的论证、CI 的"历史（值得留档）"段、C-26 合并史、安装示例里过期的 `0.1.1` 版本号）。
  - **保留并补全**"用法必须知道的东西"：preset 的选择方式与限制、按阶段的操作表、常用操作表（含签字/豁免/回退/推进/渲染/改号/看板/语言/预算）、命令参数写法与**引号规则**、20 个工具的动作清单、配置键与默认值、`.sdo/` 台账与 `docs/` 派生产物、"不要手改派生视图""签字绑定真源""留痕 ≠ 当前判定"三条操作规则、**真源坏了怎么办**（手写 YAML / `journal` 坏行 / `project.json` 坏掉三种情况的可读回执与修复动作）、已知边界、开发与发布。
  - **新增文档守卫用例 `test/m24.test.ts`**（4 条）：README 必须与实现同源 —— 20 个工具的动作清单（兼容 schema 的 `enum` 与 `description` 两种落地形态：`attack / propose / …` 与 `'show' | 'set'. …`）、17 条斜杠命令、`config.ts` 里**全部带默认值的配置键**；并且**不得再出现**"设计决策 / 为什么这么做"这类小节。变异自证 5/5：漏动作（enum 型 / description 型）、写错动作（引号型）、漏命令、漏配置键 → 各自变红。
  - 守卫当场抓出两条 README 与实现不一致：`sdo_requirement` 少列 3 个动作、`sdo_design` 少列 5 个动作；以及配置表缺 `promptOrder` / `board`（已补）。

### 升级须知

- **`docs/DESIGN.md` 升级后会立刻判红**：C-25 现在要求"整份文件 == 当前真源按头里元信息重渲染的结果"。跑一次 `sdo_design action=render` 即可（`design/rendered` 属中性事件，**不需要重签**）。
- **签字失效口径**：G3 改为**黑名单** —— 除纯读/渲染/计量/记账类事件、以及 `redteam/*`、`issue/*`、`quality/recorded`（实测不改设计正文）外，任何真源写入都让签字失效。新增事件类型**默认失效**（保守）。
- **AC 编号**：新增 G2 判据 C9 会报出**存量重号**；已冻结需求若被 `update` 改了内容会退回 `changed`，需重新基线。
- **重新基线**不再对"已冻结且内容未变"的需求写 `requirement/baselined`，因此不会再顺手作废已签好的 G3 签字。
- **`docs/DESIGN.md` 的行尾**：CRLF 与 LF 视为同一份文档（Windows 编辑器保存不再造成"什么都没改却一直红"）；但**任何人工批注/正文改动**仍会判红（派生视图请勿手改）。
- **手写真源写坏不再是异常，而且看得见**：`.sdo/` 下任一 YAML 被写坏时，`sdo_status` / `advance` / `sdo_gate action=check` 给**可读判红**（判据 id `gate.unreadable` + `unjudged: true`，报错带**相对路径**）；**注入状态块、看板、`sdo_status` 回执**都会在顶部显式告警「读真源失败，以下状态不可信」；只读列表入口（如 `sdo_requirement action=list`、`/sdo-board`）返回可读失败而不是抛异常。**坏的是 `project.json` 时**：三处都会说「项目投影读不出，无法确认是否初始化」（不再断言"没有 `.sdo/`"），而它是派生投影 —— 删掉它或做一次真源写入即可按 journal 重建，不必手改。**`journal.jsonl` 出现坏行时**：投影**不会**被任何写操作重建（保留最后一次一致状态，避免把截断前缀当成新事实）；修好那一行后，若要按现有真源强制重建，跑一次 `sdo_status --rebuild`。**此期间以事件流为证据的判定（签字失效 / 渲染佐证 / 红队记录 / 回退留痕）一律报「无法判定」**（不报 `valid`、也不报「没有事件」）；修好那一行后判据自动恢复，截断期写入的事件也会被看见。
- **验收标准改号/删除**：`sdo_requirement action=update … acceptance=[…] acceptanceMode=replace` 可整份替换（改号修复 C9 重号用这个；不传 `acceptanceMode` 仍只追加）。

## [0.1.2] - 2026-10-01

### 新增

- **设计阶段交互闭环**（针对"设计全靠 agent 自己脑补、没有文档可审"的整改）：`sdo_design` 新增 `grill`（机械缺口检测器出题，每题带**选项 + 代价 + 建议**）· `answer`（记录答复，含"按你的建议办"的授权式假设）· `confirm`（用户逐条签字）· `issues`（开放问题 + **待确认条目清单**）· `render`（生成人读的 `docs/DESIGN.md`：初为 11 章，0.1.2 起为 11 章 + 需求↔设计追溯矩阵 + 待确认清单，文档只是派生视图、不反向写台账）。架构阶段注入块会主动提示"有 N 个待你确认的设计问题"，**没和用户交流过的设计 G3 不放行**。
- **界面/交互设计视图**：第 6 个设计视图 `ui` —— 风格 · 每页栏目 · 每页布局 · 响应式断点 · 无障碍 · 空态/错态。**是否含 UI 由需求真源现算**（`kind: ui` 或项目 `surfaces`）：判真则三者缺一即门禁失败；判假则相关判据为 **N/A（既不是失败也不是通过，回执显式标注 N/A + 理由）**，需求后补 UI 时判定立刻翻真。
- **设计方法论必须选择**：需求阶段过后**必须**回答"用哪种设计方法"，且问题必须附带**模型基于需求给出的推荐与理由**；未回答 G3 不放行。
- **5 条设计命令**：`/sdo-design-grill` · `/sdo-design-answer` · `/sdo-design-confirm` · `/sdo-design-issues` · `/sdo-design-render`（与工具走**同一个依赖函数**，不复制逻辑；均不受 plan-mode / 设计前置门禁阻塞）。
- **三套设计方法包**（结构化 / 面向对象 / 敏捷-演进式）：每套都有**最小必产项**（结构化 = 数据字典 + 分层 DFD + ERD；面向对象 = 类/接口清单 + 关键用例时序 + 分层依赖规则；演进式 = 技术债台账 + 决策可逆性分级 + 迭代设计增量）与**机械检查器**；其余产物只作建议、不卡门禁。
- **方法选择与堵漏**：`design.method-selected` 对"未回答 / 答案非法"**判失败**，只有显式选择 `none` 才合法（此时产物判据为 N/A + 理由）——**不允许"不选就没要求"蒙过去**；未选中的方法包判据一律 **N/A**（既不失败也不通过，回执逐包显示理由）；支持**组合**（多选，最小必产项取并集）。
- **跨产物一致性** `design.method-consistency`：数据字典必须覆盖 DFD 上每个流名、类协作方/时序参与者/ERD 端点必须真实存在、类引用的数据项必须在字典里、分层依赖做方向性检查；方法产物条目纳入**既有**追溯孤儿检查（不新造判据）。
- **`docs/DESIGN.md` 扩到 11 章**（新增"设计方法与选型理由""各方法产物"），工具新增 `sdo_design action=method|artifact`。
- **界面线框图**：`sdo_design action=render` 会从 `ui` 视图**机械推导** ASCII 线框图写进 `docs/DESIGN.md`（栏目/顺序/布局区域逐项对应，中英混排按双宽对齐，栏目为空即不画并给提示）；可选 `--puml[=<路径>]` 另外写出 PlantUML 骨架文件 —— **本仓库没有渲染器，只写文件不出图**，且路径限工作区内（绝对路径/`..`/盘符一律拒绝、不落盘）。
- **设计适用性声明**：需求阶段由模型起草 `focus` / `viewsPresent` / `viewsAbsent`（逐条理由）/ `artifacts`，并在**注入块 · `sdo_design action=issues` · `docs/DESIGN.md`** 三处向用户明示"哪些视图做、哪些不做及理由"；门禁按声明判（present 须非空、absent 判 N/A + 理由），**不做"项目性质 → 判据"的机械映射**。
- **门禁级用户签字**：`sdo_gate action=sign`（另有人机关口问答通道）；**未签字则 G3 不可通过**（其余判据全绿也不行）；签字必须带**用户原话或所选选项原文**（空引用直接拒绝落盘，无引用的记录判红），并可在拿得到会话历史时做原话核对；签字后需求或声明再变 → 按 journal 序号判定**签字自动失效**，需重新签字。
- **阶段回退**：`sdo_gate action=rollback to=<阶段> reason=…`（reason 必填）；合法回退边由流程数据声明（不硬编码）；回退会**删除被退回阶段的出口门禁记录**，因此"G2 必须重新通过"是事实而非提示。
- **第 4 套方法包 `porting`**（与结构化 / 面向对象 / 敏捷-演进式并列）：最小必产项 = **旧→新映射表**（含被否决备选，目标侧必须引用真实存在的模块/类型）+ **不变量清单**（行为 / 数值 / 存档格式 / 协议与 id，**每条带验证方法**）+ **差分验证策略**（同输入同输出 + 基线来源）。
- **五视图按声明裁剪**：`viewsPresent` 的视图只需非空（受影响部分有内容即可）；`viewsAbsent` 的视图判 N/A + 理由；**每个视图必须显式二选一**（不许沉默略过）。
- **口径统一**：`prototype.*` 判据的"不适用"由 `ok` 改为 **N/A + 理由**，与 `ui.*` 一致。
- **修复口径分叉**：`office.methodProducts()` 查询路径未传 workspace，导致比门禁路径更松 —— 现已一致。
- **阶段回退不可用（R-1，blocker，sdo-test 实测）**：四套流程的 `rollback:` 段补上**终止阶段**的出边（waterfall/prototype/spiral 为 `delivery: [verification, architecture]`；agile 按自身阶段名 `delivery: [release, architecture]`）。此前交付阶段**没有任何出边** → 已交付项目根本无法回退，而"交付后发现问题要改"恰恰是回退最需要的场景。边集**刻意不含 `requirements`**：改需求应走变更控制（`sdo_requirement action=change`），列进回退边等于诱导绕过它。
- **回退后门禁失效不完整（R-2，major）**：回退现在作废**目标阶段及其之后所有阶段**的出口门禁（此前只删目标阶段的出口门禁，G4–G7 的陈旧 `passed` 会让下一次 `advance` 直接放行）；回退回执逐条列出被作废的门禁，journal 的 `phase/rolled-back` 一并记录该清单。
- **回退留痕判据偏弱（R-3，minor）**：`phase.rollback-recorded`（C-2E）改为**逐条校验全部**回退事件（此前只看最后一条），并把"回退当时合法的边集合"写进事件（`legalAtThatTime`）自证 —— 流程数据后来改名/删边不会把历史回退**追溯**判成非法；老事件缺该字段时按旧行为退化，不误判。
- **方法产物写不进去（F-7，blocker，sdo-test 工具通道实测）**：`sdo_design` 的 JSON schema 缺 `artifactKind`/`artifactData` 两个属性，宿主按 schema 过滤入参 → handler 收到空种类 → **任何方法产物都无法写入**，C-29/C-2A 恒红、G3 不可通过。已补齐 schema 并对齐 handler。
- **界面视图无写入入口（F-9，blocker，同上）**：`ui` 视图此前只能读不能写（`action=create` 只认五视图、schema 里的 `ui` 参数无人消费、`writeUiView` 无调用者）→ 含界面项目 C-27 永久红；文档给的补救提示本身也是错的。现在 `action=create` 在 `kind` 校验前分流 `ui` 正文（同给 `kind` 则显式报冲突，不静默丢弃），并把所有错误提示改成真实可用的调用方式。
- **`ui` 进 `viewsPresent` 被静默丢弃（F-8，major）**：新增 `APPLICABILITY_VIEW_KINDS`（五视图 + `ui`）；任何不认识的视图名不再被丢掉，而是进入 `ignoredViews` 并被 C-2B 判红报出。
- **设计草案的来源需求误报（F-4）**：草案来源改用**追溯图**（与 C-21 同源）解析，置信度按解析出的来源现算——不再依赖元素自带的 `requires` 字段。
- **grill 重问已定案的问题（F-5）**：新增 ADR 比对（只认 `proposed`/`accepted`），命中时题目带「已有决策：ADR-xxx（本次仅确认）」；关键词表放在随包数据 `src/data/decided-hints.yml`（中英双语）。
- **推荐与理由是兜底值（F-6）**：方法论/适用性建议区分「模型给出的理由」与「插件兜底建议」，兜底时明确写「模型未提供理由，以下为插件兜底建议，请勿据此决策」。
- **新增机械守卫（防这一类再犯）**：从**编译产物**静态提取 handler 对 `args.<name>` 的读取，断言每个都出现在对应工具的 JSON schema `properties` 里（含未登记模块、陈旧 allowlist 检测与自证用例）——F-7 正是"三处声明、唯独 schema 漏"造成的，这道守卫在本轮已用反例实测能拦住它。
- **时序需求字段有两套、追溯只认一套（F-11，major，假红）**：`requirement` 与 `requires` 并存而孤儿检查只读后者（实测同一批时序先报 9 个假孤儿，补上另一字段后立刻变 100% 覆盖）。现写入归一、追溯与 must 覆盖、一致性检查三处**都按并集**读。
- **C-29 对约束型需求要求时序（F-13，major，逼人造假）**：`constraint` / `quality` 类需求没有"流程"可画。现按需求 `kind` 豁免这两类（`functional`/`ui` 仍要求），且**豁免理由逐条写进门禁回执与只读回执**。
- **C-29 要求"每个类型都有协作方"与分层方向规则互斥（F-14，major，叶子层恒红）**：改为只要求**非叶子**类型给出协作方；叶子身份必须在产物里**显式声明**（`leaf: true`，缺省视为非叶子——不按"没协作方/位于末端"推断），回执列出被当作叶子的类型；叶子若声明违规方向的协作方，一致性检查照样判红。
- **线框图方向与 `grid` 声明相反（F-15）**：新增显式 `layout.stack: vertical|horizontal`，**缺省按纵向**渲染（不再猜 `grid` 自由文本），图旁注明方向来源（声明/缺省），非法取值当面报错；PlantUML 骨架同样注明。
- **C-25 文案过时（F-12）**：判据校验的是 **11** 章，而成功文案与注释写 9 —— zh/en 与代码注释一并改为 11（另有 `docs/plan` 三处以"增量 1 时的章数、增量 2 起为 11 章"加注修正，不改写历史）。
- **方法产物形状未文档化、未知字段被静默忽略（F-10）**：工具参数描述里逐 kind 列出正文形状（`dictionary`/`dfd`/`erd`/`classes`/`sequences`/`layers→{rules:{…}}`/`debt`/`reversibility`/`increments`/`mapping`/`invariants`/`diffVerify`）；写错形状时**点名被忽略的字段并给出期望字段**，一个期望字段都没给且盘上无既有产物时**拒绝落半成品**。
- **动作清单三处漂移（F-17 / F-18，sdo-test 实测复现）**：`sdo_requirement` 的 **schema 声明 / 实现分支 / 报错列表**三份清单互不同步（schema 漏 `change`；报错列表反向漏 `design-questions`/`applicability`/`applicability-confirm`）；排查后 `sdo_gate` 更严重（schema 与报错两处都漏 `sign`/`rollback`）。现改为**单点动作常量**（18 个带 action 的工具，照 `METHOD_ARTIFACT_KINDS` 的做法），schema 与报错回执都由常量生成，并加机械守卫：从**编译产物**抽取 handler 分支集合，断言「常量集合 == 分支集合 == schema 描述」，附自证用例（改名 `case` 必须报漂移）。
- **逐条确认戳不绑定内容（F-19，major，sdo-test 实测复现）**：确认过 DES-001 后原地改写内容，`missing` 仍为空、旧戳原样生效 —— 等于"用户确认"可被内容替换绕过。现确认戳绑定被确认内容的**指纹**（按 target 类别做内容投影 + 规范化 JSON + sha256，显式排除 `at`/`updatedAt` 等元数据，前缀 `sha256:` 以免纯数字被 YAML 解析成 number 造成活锁）；内容变更 → 该确认**自动失效**并要求重新确认，门禁 C-24/C-27 把「未确认」与「内容已变、确认失效」**分开报**，写入回执点名本次新失效的条目；旧确认戳（无指纹）一律视为未绑定、需重新确认。
- **契约名与字段方向矛盾无检测（F-16，只报不改）**：全仓库原无一致性检查，覆盖判定还用 `name.includes(producer)` 兜底把矛盾记录算作"已覆盖"。现新增只读检测：`action=contract` 回执、只读视图与 G4/C-30 详情都会警示"名字与字段矛盾 = 两者之一错了"。**刻意不做自动纠正** —— 报告自身已证明形式矛盾推不出哪边错，自动对调会改错一半。
- **手写 YAML 的类型假设（F-20）**：把契约字段写成未加引号的数字（`retry: 2`）会让 YAML 解析成 number，覆盖判定随即**抛异常**（`retry.trim is not a function`）而不是给出可读结论。现新增边界助手 `src/infra/scalar.ts`：number/boolean 字符串化（`2` → `"2"`，**不判红**）、null/undefined 视为空、object/array 视为**不可用**（可读失败而非崩溃），并在**契约写入回执、只读视图、C-30 详情**三处点名「哪个契约、哪个字段、什么类型、建议写成 `retry: '2'`」。同时系统排查同类假设，收敛十余个模块（风险、grill、计划、协同、交付清单、签字、适用性、方法产物、门禁、渲染、评分、设计视图）；手写 `dependsOn: api`（标量）不再让视图渲染崩溃，且该边保留为单元素列表（不静默丢边）。
- **手写 YAML 的容器形状（F-21）**：上一轮只修了标量类型假设，容器形状（列表位置被写成标量/映射、映射位置被写成标量）仍会崩或静默判错。现系统排查 848 处容器消费点、按数据源分类，对 **17 类手写真源实体**在 `readXxx` 边界统一归一：列表位置的标量 → **单元素列表**（保留作者意图，不静默丢）、映射位置 → 空 + **可读提示**（不猜）；并顺带修掉两处「不崩但静默判错」（ADR 备选/变更影响的 `.length` 把字符串长度当条目数、预算 `tiers` 标量被展开成字符）。提示经 `src/domain/shapeNotes.ts` 统一落到**写入回执、只读视图、相关门禁详情**三处，绝不静默。
- **门禁可信度（流程复评批次：blocker 2 条 + major 13 条 + minor 若干）**：`baseline` 不再自建门禁记录，改为与 `advance` 同源调用 `evaluateGate`（红队议题闭环 C8 此前**永不参与放行判定**；DoR 判据改按 `check` 键挂载，不再按 id 劫持，改 `check` 真的生效）；`docs/DESIGN.md` 增加渲染标记（`<!-- source: .sdo/design @ seq N -->`），C-25 要求文档不早于最后一次**会改变内容**的真源事件 —— 陈旧文档不再判绿，只有 11 行标题的假文档判红（`phase/*` 有意排除，避免每次推进/回退都翻红）。
- **签字与确认的洞**：契约变更纳入签字失效白名单（改完契约门禁不再谎报"签字有效"）；`confirm` 不再为不可解析的目标写一个永不被承认的假戳（`target=ui` 裸放行已删），有效目标绑定内容指纹；退出关键条目集合的旧确认戳不再静默（列为 orphan 并在回执/C-24 detail 点名，但不判红）。
- **不再静默、不再假绿（一批）**：契约覆盖改为归一后的**等值配对**（删掉 `name.includes()` 子串匹配造成的假覆盖）；声明"要做界面视图"但真源无界面证据 → C-20 判红；方法产物缺 `rules` / `allowed` 为空 → 一致性判据判红（**零约束 ≠ 通过**）；已有产物但字段全部写错位 → 拒绝写入且盘上原值与 journal 都不变；手写 `assumed` 未经用户授权不再绕过 G2（与设计侧合并成同一口径）；AC 编号全局唯一；越界选项拒绝记账；需求版本号只在内容真的改过时才 `+0.1`；若干"文案与实现同源"（C2 / C-06 / C-21 / C-25 / C-2C 的描述改为实际口径，而不是承诺实现里没有的行为）。
- **诚实回执**：`/sdo-answer` 补 `--dimensions` 并明确"答案正文不参与评分"；`create` / `contract` 上不被消费的 `by`/`note` 在回执里点名；`journal` 的门禁结果里 N/A 与 failed 不再混合。
- **待拍板五问已全部拍板并落地（D 批）**：
  - **D1 需求基线签字以签字台账为准**：C7 的唯一放行依据改为 `gates/signatures.yml` 里**带用户原话引用**的 G2 签字（由 `signatureState` 投影，`signoffInput()` 单点复用），`approvedBy` 字符串**不再能让 C7 变绿**、降级为 detail 里的附加信息；`baseline` 不再要求 `approvedBy`，冻结事实 `baseline.by` 改记**台账签字人**（此前"必填却无用"属误导）。签字**失效事件集合按门禁分开**：G2 有自己的 `G2_SIGNATURE_INVALIDATING_EVENTS`（需求/项目/裁剪/问题/风险/红队/议题），改这些真源后按 **journal 序号**自动失效、需重新签字；有意不列 `requirement/baselined`（否则"内容未改重新冻结"永远过不去）、`phase/*`、`gate/*` 与全部 `design/*`、`contract/*`（改设计不该作废需求签字）。集合写进代码注释、C7 detail、签字回执与失败 remedy 四处，承诺与判定同源。
  - **D2 `advance` 现算出口门禁**：对当前阶段**每个出口门禁**现调 `evaluateGate`，只有 `passed`/`waived` 才放行；`gates/*.json` 与 `gate/result` 退化为**判定留痕**（照写不误，供审计与看板使用，但不再参与放行）。此前"曾经通过"的记录并集是**永久通行证** —— 基线之后把需求改坏、只要不显式 `check`，`advance` 仍放行。`waiveGate` 仍是合法豁免出口。
  - **D3 评分不纳入答案正文**（维持原口径）：核对实现与文案同源（规则通道文本 = `statement + rationale + acceptance`），新增测试固化"答案正文塞满毫秒/QPS/状态机等可测关键词也**逐维不改分**"，并断言 remedy 文案同时含"答案正文本身不改分"与 `dimensions`。
  - **D4 "P1 未决必须转风险"真的判**：四个流程 yml 的 desc 早已承诺"且转风险"，实现此前**完全不读风险台账**。现逐条要求存在 `origin` 指向该问题的风险登记（按**空白分隔 token 全等**匹配：`Q-0035`、`Q-0035 redteam` 都算，`Q-003` **不**匹配 `Q-0035` —— 子串匹配会假绿、全等又漏多来源写法），缺处置即 C2 判红并**点名**缺哪几条 `Q-xxxx`，remedy 给出 `sdo_risk action=log origin=<Q id>`。
  - **D5 "不做"的工件必须写理由**：真源新增 `applicability.artifactsAbsent: [{kind, why}]`（另有 `ignoredArtifacts` 承接不认识的名字）；C-2C 对"声明不做却没写理由 / 又做又不做"判红，只声明"不做"且逐条带理由 → 通过（detail 原样展示理由），两处都没列 → 仍 **N/A**（不放松既有口径）；手写标量写法 → 单条目 + 形状提示（可读失败，不崩溃）。注入块 / `action=issues` / `docs/DESIGN.md` 三处同源渲染。
- **`dropped` 只认布尔、但绝不静默（F-21 ②）**：`dropped: yes`（字符串）此前既不当作放弃、也毫无提示 ✗。现统一走 `droppedFlag()`：**只有 `dropped: true` 才算放弃**（不替用户猜 ✗），字段存在且非布尔时**大声点名**「哪个实体、字段 `dropped`、实际类型/值、建议写成 `dropped: true|false`」；同一助手也接到另外三处布尔位置（需求 `source.prototype`、交付 `prototypeExcluded`、方法产物 `types[].leaf`——`yes` 不再静默放行/静默豁免）。

### 修复

- **命令参数解析**：`/sdo-budget` 的参数解析接受裸 `key=value` 形态——此前 README 与命令描述写的是 `--decide choice=add-budget`、`--set total=100 currency=CNY tiers=50,80,100`，而代码只认 `--choice=` / `--total=`，照文档写的命令会**静默取不到值**（落到"需要 `--choice=…`"的提示）。现在 `--key=value` / `--key value` / 裸 `key=value` 三种形态都生效，**旧写法保持向后兼容**；非法值（如 `choice=bogus`）仍被拒绝且**不落盘**。README 与语言包提示统一改写为规范形态并注明旧写法仍可用。
- **预算回执抽成 `src/interface/budgetReceipt.ts`**：`--set` / `--decide` 的校验、留痕与文案从 `src/index.ts` 抽出，测试可直接复用同一份实现（与 `designReceipt.ts` 同一先例）。
- **命令参数解析换成真正的分词解析器**（`src/interface/argv.ts`）：一次扫描切 token（引号感知、`--` 之后全为位置参数），`--k=v` / `--k v` / 裸 `k=v` 三种形态行为保持一致；**修掉残留边界** —— 纯布尔开关（`--decide`/`--set`/`--assume` 等）之后的自由文本值里形如 `choice=waive` 的内容只作为**值**，不再被误认成选项。边界如实记录：多词自由文本必须加引号。
- **合并重复判据**：删掉 C-26（`design.method-chosen`）及其 3 个语言包键，G3 的方法选择只保留 C-28（`design.method-selected`：未回答/空/非法 → 失败；显式 `none` → 通过），回执不再并列出现两条相关判据。

- **变更/更新会抹掉模型通道语义分（§6.7，sdo-test 实测）**：`office.change` 重算评分时不传模型维度 → `Ambiguity.dimensions`（合成值）退回规则基线（实测 15 → 9，`data`/`interface` 归零），"变更 → 重新基线"随即被 C1 误拦。根因是该字段是"规则基线 / 硬上限 / 模型分"取严后的**合成值**，分不出哪一维来自模型。现把模型通道**原始输入**落到 `ambiguity.modelDimensions`（读写往返 + 形状提示），`change` / `update` / `rescore` / `setOpenQuestions` 统一"**规则维度按新内容重算、模型维度沿用**"，回执如实回报 `dimensionsFrom: explicit | carried | none`，`sdo_requirement action=change` 也支持显式重给 `dimensions`（不再静默）。

## [0.1.1] - 2026-09-30

**首个公开发布。** SDO 把「可行性 → 需求 → 架构 → 拆分 → 实现 → 测试 → 交付」做成**门禁驱动、证据可查**的流程，全部跑在**同一个会话**里；到「可部署产物」为止，发布与运维是明确的非目标。

### 新增

- **流程即数据**：瀑布 / 快速原型 / 敏捷 / 螺旋 4 个流程，阶段与专属门禁由 `src/data/processes/*.yml` 定义（含 `GP` 原型验收、`GI` 迭代 DoD、`GR` 风险象限）。
- **8 道门禁**：`G0` 立项 → `G1` 可行性 → `G2` 需求基线 → `G3` 架构 → `G4` 详细设计与计划 → `G5` 开发完成 → `G6` 验证 → `G7` 交付；**逐条判据**，且**未实现的检查器一律判失败**（绝不允许"查不到就算过"）。
- **20 个模型工具 + 12 个斜杠命令**（完整清单见 [README](README.md)）。
- **需求工程**：捕获（自动八维歧义评分）、**审讯式提问**（每题带选项与代价）、假设登记、**红队对抗**（题库 `attack` + 模型生成 `propose`/`file`，回填必须引用需求原文用词）、变更控制（影响分析 + 决策）、基线冻结。
- **架构工作**：五视图设计元素、跨组件契约（超时 / 重试 / 幂等）、ADR（**必须**给出被否决的备选与接受的后果）、质量属性场景 + 轻量 ATAM、追溯图（孤儿检测与覆盖率）。
- **计划与协同**：双通道拆卡（结构通道按追溯图 + 模型通道吃建议，**每元素一张卡**）+ 六条机械校验（单角色 / DoD / 无环 / 规模 / 写范围互斥 / 证据要求）、按容量预算派发、CAS 认领、**完成必须带证据**、显式放弃与回收路径。
- **验证与交付**：测试计划 / 结果 / 缺陷（阻塞级缺陷拦门禁）、**评审独立性**（作者 ≠ 评审者，机械校验）、交付包（产物 sha256 清单 + 验收矩阵 + 回滚点 + 原型排除声明）。
- **成本监视**：只统计 token；单价由用户手填，没填就**不猜金额**，金额一律标注「估算」；超预算**不会中断开发**，只按档位提醒并记录决策。
- **界面语言可选**：`lang: zh-CN | en` —— `zh-CN` 是基准语言（永远完整），目标语言**逐键覆盖**它、缺键**回落中文**，未知语言回落基准；标识（`G0`/`REQ-001`/`in-progress`）不翻译。三条切换路径：聊天里说 / `/sdo-lang en` / `config.lang` 或环境变量 `SDO_LANG`。
- **离线安装包**：`npm run pack:offline` 产出 `*-offline.tar.gz` + `*-offline.zip` + `SHA256SUMS`；装机器**无需联网**，用 `install.sh` / `install.ps1`（支持 `--dry-run` / `--verify` / `--uninstall`）。安装器会把**宿主的 peer 实例链接**进 profile（保证只有一份服务注册表）。
- **CI/CD**：GitHub Actions —— 矩阵 CI（`ubuntu-latest` + `windows-latest` × node 20/22：`typecheck` + `test`）、tag 发布（`v*` → 两个 OS 打包 → `gh release create` 发布离线包与校验和）。
- **可复现安装**：提交 `package-lock.json`，CI 与本地统一用 `npm ci`。

### 修复

下列缺陷均为**真实项目跑完整流程**时暴露，逐条证据（现象 / 根因 / 验证）见 [缺陷记录](docs/verification/2026-09-30-缺陷记录.md)：

- **门禁判据**：`checkGate` 曾用**原始入参**当落盘文件名（回执与实际不符）；`tests.passed`（C-50）**名不符实** —— 现在真的校验"每条 must 需求都有通过的用例"；门禁名支持带编号的中文全名（`交付门禁（G7）`）；"最近判定"改为按 journal 序号取最新（不再按文件名字典序）。
- **拆卡通道**：批内重复建卡、凭空发明写范围（`src/<slug>/`）、建错卡**没有回收路径** → 改为**每元素一张卡** + 写范围**声明优先**（否则按元素派生并提示）+ `sdo_task action=drop`（留痕回收）。
- **`dropped` 语义统一**：曾被计入完成率分母（G5 死结）、被成对写范围校验误报（47 项幻觉冲突）、完成的卡**永久占用**写范围 → 统一为"只有**未放弃**的卡参与判定"，`done`/`verified` 释放写范围。
- **契约通道**：口径未说明（按自然语义填会 0/17 覆盖）、自动命名方向与字段语义相反、只能追加不能更新 → 明确口径 + `producer → consumer` + 按 `id` 原地更新 + `sdo_design action=drop-contract` 作废留痕。
- **会话与上下文**：注入块解析不出工作区（宿主给的 `scope` **就是 agent 对象**，此前 `String(scope)` 恒为 `[object Object]`）；preset 缺少压缩行 + 工具回执无上限导致**上下文爆掉**（补齐官方 `compaction` 组 + 回执统一截断）。
- **语言包**：覆盖率读数出现 `980 / 951`（分子分母口径不一致）；扫描器把正则里的反引号当模板起点，导致**幻影字面量**（并因此改坏过一个源文件）。

### 文档

- [README](README.md) 重写为「介绍 → 快速开始 → 使用教程 → 命令与工具速查 → 配置 → 设计要点 → 已知边界 → 开发与发布」。
- [设计初稿](docs/design/2026-09-29-dsh-software-dev-office设计初稿.md)（含 C-01…C-09 约束与 D-01…D-07 偏离登记）、[开发任务计划](docs/plan/2026-09-29-SDO开发任务计划.md)、[验证与缺陷记录](docs/verification/)（DEF-01…42）。
- 新增 MIT 协议（作者 [raitpor](https://github.com/raitpor)）。

### 已知限制

见 README 的「已知边界（诚实清单）」：派发宿主的 `SubagentRuntime.start` 真实调用未接线、子代理用量未归集、Web 面板未实现、L3 纪律守卫的 deny 分支未做真机实测。

[Unreleased]: https://github.com/raitpor/dsh-software-dev-office/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/raitpor/dsh-software-dev-office/releases/tag/v0.1.2
[0.1.1]: https://github.com/raitpor/dsh-software-dev-office/releases/tag/v0.1.1
