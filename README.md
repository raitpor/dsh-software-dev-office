# dsh-software-dev-office（SDO）

> **一个 agent software dev office**：在同一个会话里，把「可行性 → 需求 → 架构 → 拆分 → 实现 → 测试 → 交付」按**门禁**推进；每一步的判据结论、证据、签字都落在可复算的台账里。
> 基于 **dsh `0.2.0`**（deepseek-harness 原生 Cordis 插件）。覆盖到「可部署产物 + 验收矩阵 + 回滚点」为止，**发布与运维不是它的范围**。

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.1-green)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

---

## 1. 它能做什么

| 能力 | 内容 |
|---|---|
| 开发流程 | 4 套可选：瀑布 `waterfall` / 快速原型 `prototype` / 敏捷 `agile` / 螺旋 `spiral` |
| 阶段与门禁 | 瀑布 8 阶段（立项 → 可行性 → 需求 → 架构 → 详细设计 → 开发 → 验证 → 交付）× 门禁 `G0`–`G7`；原型 / 敏捷 / 螺旋另加 `GP` 原型验收、`GI` 迭代完成、`GR` 风险象限 |
| 需求工程 | 捕获 + 八维歧义评分 · 审讯式提问（≤4 问，每题带选项与代价）· 假设登记 · 红队对抗提问 · 基线冻结 + **人类签字** |
| 设计与架构 | 五视图 + 界面视图 · 跨组件契约（超时 / 重试 / 幂等）· ADR · 质量场景（可测度量 + ATAM-lite）· 设计方法包最小必产项 · 界面 ASCII 线框图 + PlantUML 骨架源码 |
| 计划与开发 | 按追溯图拆卡（每元素一张）· CAS 领卡 · 8 张角色卡 + 工具掩码派发 · 完成必须带证据 |
| 验证与交付 | 测试计划 / 结果 / 缺陷 · 独立评审（作者 ≠ 评审者）· 交付包 + sha256 清单 + 验收矩阵 + 回滚点 |
| 台账与产物 | `.sdo/` 台账（追加式真源 + 派生投影）· `docs/*.md` 人读文档 · 文本看板 |
| 界面语言 | `zh-CN`（基准，永远完整）/ `en`；未知语言回落基准 |
| 成本监视 | 只统计 token；金额要你手填单价、处处标注「估算」；超预算**不中断开发**，按档位提醒你选追加 / 豁免 / 收敛 |
| 门禁语义 | 每条判据**逐条**判定；未实现的检查器一律判失败；读不到真源一律判红并标「无法判定」，**不静默通过** |

## 2. 安装

### A. 离线安装包（推荐，装机器无需联网）

从 [Releases](https://github.com/raitpor/dsh-software-dev-office/releases) 下载对应产物（每个版本改了什么见 [CHANGELOG.md](CHANGELOG.md)）：

```text
Linux / macOS ：dsh-software-dev-office-<版本>-offline.tar.gz
Windows       ：dsh-software-dev-office-<版本>-offline.zip   （也可用 tar.gz，Win10+ 自带 tar）
```

解压后执行：

```sh
./install.sh --profile web                  # Linux / macOS
.\install.ps1 --profile web                 # Windows PowerShell

node install.mjs --profile web --dry-run    # 先看计划，不落盘
node install.mjs --profile web --verify     # 只校验
node install.mjs --profile web --uninstall  # 卸载（精确回收它装过的东西）
```

安装器会：① 用离线 npm 把插件与依赖闭包装进 `<profile>/node_modules`；② 把宿主的 `@deepseek-ai/*` 实例链接进 profile（保证只有一份服务注册表）；③ 把插件登记进 profile 的 `dsh.profile.bundles`（改前留 `.bak-offline-<时间戳>` 备份）；④ 校验（模块可 import + 组合树可见）。**装完请重启 dsh。**

### B. 源码安装（开发态）

```bash
git clone https://github.com/raitpor/dsh-software-dev-office.git
cd dsh-software-dev-office
npm install && npm run build
dsh plugin --profile web add dsh-software-dev-office@file:$PWD   # 或手工写 file: 依赖
```

并在 profile 的 `package.json` 里把它列入 bundles：

```jsonc
{
  "dependencies": { "dsh-software-dev-office": "file:/abs/path/to/dsh-software-dev-office" },
  "dsh": { "profile": { "bundles": [ /* … */ "dsh-software-dev-office" ] } }
}
```

## 3. 启用：在会话里选择 preset

SDO **不是**默认加载的插件。它随包提供一个 preset（显示名 **SDO 研发办公室（驾驶舱）**）：

- **只有显式选择该 preset 的会话才被接管**；未选择的会话完全不加载。
- **不能中途接管**已开始的会话 —— 切换 preset 需要**新建一个空白会话**。
- preset 由 `dsh-web-app` 的 `agent-preset-registry` 消费：Web / CLI 会话可用；headless / ACP 环境只能用工具面（没有斜杠命令与状态块注入）。

## 4. 五分钟跑通一轮（需求阶段为例）

```text
你：我要做一个铁路订票系统（Web + SQLite，单机 Docker 部署，只做内网演示）
   ↓ 模型调用 sdo_init
SDO：缺关键参数 ⇒ 先给问询单（项目名 / 开发流程 / 规模档 / 干系人）
你：（确认四项）
SDO：PRJ-001 已立项 → 阶段 feasibility
   ↓ sdo_feasibility（五维评估 + 结论 + 高风险项的 PoC 建议）、sdo_risk（风险登记）
SDO：G1 可行性门禁 ✅
   ↓ sdo_requirement action=capture（捕获需求，自动八维歧义评分）
SDO：REQ-001 已落账（八维评分：数据 / 接口维度偏弱）
   ↓ sdo_requirement action=grill → 审讯式提问（每题带选项与代价）
SDO：Q-0001 单日峰值订单量级？（选项 A/B/C，各自代价）
你：（回答；或"不知道"→ 记为假设，仍是开环问题）
   ↓ sdo_redteam action=attack（红队质询）→ sdo_requirement action=answer
   ↓ sdo_risk action=log origin=Q-000x …（未决 P1 必须先转风险，否则 C2 判红并点名）
   ↓ sdo_gate action=sign gate=G2 quote="<你的原话>"
   ↓ sdo_requirement action=baseline
SDO：G2 需求基线门禁 ✅（需求冻结为 v0.2）
```

## 5. 按阶段使用

| 阶段 | 你可以说 | 会发生什么（主要工具动作） |
|---|---|---|
| **立项** | "立项：<一句话项目>" | `sdo_init`（缺参数先问询）→ `G0` 判据：范围 / 非目标 / 干系人 / 成功度量 |
| **可行性** | "做可行性评估" | `sdo_feasibility action=assess` + `sdo_risk action=log` → `G1`（只认 `go`；高风险必须有缓解与责任人） |
| **需求** | "捕获需求 / 继续问我" | `sdo_requirement action=capture` → `action=grill` → `action=answer`（可记假设）→ `sdo_redteam action=attack/propose/file` → `action=baseline` → `G2` |
| **架构** | "开始架构设计" | 先**计划评审**（通过后由 `exit_plan_mode` 结束）→ `sdo_design action=create`（五视图 / 界面视图）→ `action=contract` → `sdo_adr action=record` → `sdo_quality action=scenario` → `action=artifact`（按所选方法包补齐最小必产项）→ `sdo_trace action=link` → `G3` |
| **详细设计与计划** | "拆任务" | `sdo_plan action=decompose`（结构通道按追溯图 + 模型通道吃建议；每元素一张卡；六条机械校验：单角色 / DoD / 无环 / 规模 / 写范围互斥 / 证据要求）→ `G4` |
| **开发** | "下一步做什么" | `sdo_plan action=next`（按容量预算挑卡 + 派发请求）→ `sdo_task action=claim`（CAS，版本对不上即冲突）→ 一次派发运行 = 一个角色 → `sdo_task action=done`（**必须带证据**）→ `G5` |
| **验证** | "记录测试与缺陷" | `sdo_test action=plan`（用例绑定需求）→ `action=record`（通过也要证据）→ `action=defect`（阻塞级缺陷会拦住门禁）→ `sdo_review action=record`（作者 ≠ 评审者）→ `G6` |
| **交付** | "打交付包" | `sdo_deliver action=package`（产物 sha256 清单 + 验收矩阵 + 回滚点 + 声明不含原型内容）→ `G7` |

## 6. 常用操作

| 我想… | 怎么做 |
|---|---|
| 看现在到哪了 | `/sdo-status`（阶段 / 门禁缺口 / 计数）；`/sdo-board --expand` 看需求、卡、门禁、成本一屏 |
| 知道门禁为什么不过 | `sdo_gate action=check gate=架构门禁`（中文名或 `G3` 都能传）—— 逐条列出缺口与补救 |
| 确有正当理由要跳过 | `sdo_gate action=waive gate=G3 reason=… approver=…`（显式豁免并留痕） |
| 推进到下一阶段 | `sdo_gate action=advance`（当前阶段出口门禁全绿 / 已豁免后才推进） |
| 记录用户签字 | `sdo_gate action=sign gate=G2 quote="用户原话"`（无人机对话通道时用 `channel=question`；无引用一律拒绝） |
| 退回某个阶段 | `sdo_gate action=rollback to=详细设计 reason=…`（回执会说明哪些豁免仍然保留） |
| 需求变了 | `sdo_requirement action=change id=REQ-002 …`（影响分析 + 决策），或 `action=update`（改内容会退回 `changed` 并涨版本号） |
| 改验收标准编号 / 删除 | `sdo_requirement action=update … acceptance=[…] acceptanceMode=replace`（整份替换；不传则只追加） |
| 卡建错了 | `sdo_task action=drop id=…`（留痕，不再计入完成率） |
| 契约写错了 | `sdo_design action=contract id=CT-00x …`（原地更新）或 `action=drop-contract`（作废留痕） |
| 写人读文档 | `sdo_design action=render` → `docs/DESIGN.md`；`sdo_render` → `docs/SRS.md`；`/sdo-board --write` → `docs/BOARD.md` |
| 切界面语言 | 聊天里说"切换成英文"（`sdo_lang`）或 `/sdo-lang en`；持久化用 config 的 `lang` 或环境变量 `SDO_LANG` |
| 看成本 | `sdo_cost action=report`；预算用 `/sdo-budget --set --total=100 --currency=CNY --tiers=50,80,100` |

**真源坏了怎么办**（三种情况都有可读回执，都点名**相对路径**）：

```text
手写 YAML 写坏了（缩进/类型）  → 判据判红并标注「无法判定（查不动）」；按回执点名的那份 YAML 修好，再重判
journal.jsonl 有坏行        → 以事件流为证据的判定（签字失效/渲染佐证/红队记录/回退留痕）一律报「无法判定」；
                             派生投影不会被自动重建；修好那一行后判据自动恢复，要按现有真源强制重建才跑
                             `sdo_status --rebuild`
project.json（派生投影）坏掉 → 三处显示都会说「项目投影读不出，无法确认是否初始化」；
                             它是可重建的：删掉它或做一次真源写入即可按 journal 重建
```

## 7. 命令速查（17 条，交互式会话，不进模型）

| 命令 | 用途 |
|---|---|
| `/sdo-init` | 初始化项目：`--name=… [--process=waterfall\|prototype\|agile\|spiral] [--scale=trivial\|normal\|critical] [--stakeholders=…]` |
| `/sdo-status` | 阶段、门禁缺口、需求与问题计数；`--rebuild` 从 journal 重建投影 |
| `/sdo-board` | 文本看板；`--expand` 明细、`--all` 不受保留窗口限制、`--write` 落盘 `docs/BOARD.md` |
| `/sdo-list` | 需求清单（ID / 优先级 / 状态 / 歧义评分 / 未决问题数） |
| `/sdo-grill` | 生成下一批审讯问题（≤4，带选项与代价）；`--id=REQ-001`、`--quick` |
| `/sdo-answer` | 回答问题：`--id=Q-0001 --answer="…" [--option=0] [--dimensions=…]`；不知道时 `--assume`（记为假设） |
| `/sdo-redteam` | `--attack` 生成质询；`--off` / `--on` 切换本会话红队（留痕） |
| `/sdo-gate` | `--gate=G0` 判定留痕；`--sign --gate=G2 --quote=用户原话 [--channel=statement\|question]` 记录用户签字（无引用一律拒绝）；`--rollback --to=阶段 --reason=…` 阶段回退；`--waive --gate=G2 --reason=… --approver=…` 显式豁免 |
| `/sdo-next` | 推进到下一阶段（出口门禁须已通过 / 豁免） |
| `/sdo-budget` | `--show`｜`--set --total=100 [--currency=CNY] [--tiers=50,80,100]`｜`--decide --choice=add-budget\|waive\|narrow-scope` |
| `/sdo-render` | 把真源渲染成文档：`--target=srs` → `docs/SRS.md` |
| `/sdo-lang` | 查看 / 切换界面语言：`/sdo-lang en` |
| `/sdo-design-grill` | 设计提问（含方法论选择题）：`--method=… --rationale=…`、`--round=N`（≡ `sdo_design action=grill`） |
| `/sdo-design-answer` | 设计答复：`--id=Q-0001 --choice=0\|选项原文 [--note=…]`；授权按建议办时 `--assume`（≡ `action=answer`） |
| `/sdo-design-confirm` | 确认关键条目：`--target=DES-001\|CT-001\|ui:UI-001:style\|SCR-001:columns\|SCR-001:layout [--note=…]`（≡ `action=confirm`） |
| `/sdo-design-issues` | 设计问题 + **必须确认但尚未确认**的关键条目清单；`--state=all` 连已答复的一起列（≡ `action=issues`） |
| `/sdo-design-render` | 写 `docs/DESIGN.md` 并回报路径与字节数（≡ `action=render`）；`--puml[=相对路径]` 额外写一份 PlantUML **骨架源码**（默认 `.sdo/design/ui.puml`） |

**参数写法**：同时接受 `--flag=value` 与 `--flag value`；历史形态**裸 `flag=value`**（如 `/sdo-budget --decide choice=…`）也被接受，新文档一律写前两种。

- 值里含空格或 `=` 时**必须加引号**：`--note "见 choice=waive"` 是一个值；`--note 见 choice=waive`（未加引号）里 `见` 是值、`choice=waive` 是独立 token。
- 纯布尔开关（`--decide` / `--set` / `--waive` / `--rebuild` / `--assume` / `--quick` / `--attack` / `--off` / `--on` / `--expand` / `--all` / `--write`）**不吞**下一个 token。
- 显式 `--k=` 优先于裸 `k=v`，且与出现顺序无关。
- `--` 之后全部作为位置参数；`"…"` / `'…'` 内的空白不切分，引号会被剥掉。

## 8. 模型工具速查（20 个）

| 分组 | 工具（动作） |
|---|---|
| 项目与状态 | `sdo_init`、`sdo_status`（含 `rebuild`）、`sdo_project`（update / show）、`sdo_lang`（show / set） |
| 需求 | `sdo_requirement`（capture / grill / answer / update / change / list / baseline / design-questions / applicability / applicability-confirm）、`sdo_redteam`（attack / propose / file / on / off / status） |
| 可行性 / 风险 | `sdo_feasibility`（assess）、`sdo_risk`（log / update / list / conclude） |
| 架构与设计 | `sdo_design`（view / create / contract / drop-contract / grill / answer / confirm / issues / render / method / artifact / review / waive-plan）、`sdo_adr`（record / list / supersede）、`sdo_quality`（scenario / evaluate / list） |
| 计划与协同 | `sdo_plan`（decompose / iteration / next）、`sdo_task`（list / claim / done / block / drop / release / reassign） |
| 验证与评审 | `sdo_test`（plan / record / defect / list）、`sdo_review`（record / list） |
| 追溯与文档 | `sdo_trace`（link / unlink / query / report）、`sdo_render` |
| 门禁与成本 | `sdo_gate`（check / advance / sign / waive / rollback）、`sdo_cost`（report） |
| 交付 | `sdo_deliver`（package / show） |

### 设计方法包（`sdo_design action=grill` 的 `design:method` 题）

取值 `structured` / `oo` / `evolutionary` / `porting` / `none`，**可多选**（用 `+` 连接，如 `structured+oo`，组合 = 各包最小必产项的并集）。选中的包必须交付最小必产项，未选中的包一律 **N/A + 理由**（既不失败也不算通过，回执逐包显示）；**未回答 / 空答案 / 无法解析 = 判失败**，只有**显式** `none` 合法。

| 方法包 | 最小必产项（缺任一即 G3 判红） |
|---|---|
| `structured` | 数据字典（名称 / 类型 / 来源 / 去向 / 校验）+ 分层 DFD（≥2 层、每加工有输入输出、父子平衡）+ ERD（实体主标识 + 关系基数） |
| `oo` | 类 / 接口清单（职责 + 协作方；叶子类型需显式 `leaf: true` 才豁免协作方）+ 关键用例时序（覆盖 must 需求、消息含发送者 / 接收者 / 触发条件）+ 分层依赖规则 |
| `evolutionary` | 技术债台账（类型 / 影响面 / 偿还触发器 / 计划）+ 可逆性分级（不可逆必须写"为何现在定"）+ 迭代设计增量 |
| `porting` | 旧→新映射表（含被否决备选，目标侧必须引用真实存在的模块 / 类型）+ 不变量清单（行为 / 数值 / 存档格式 / 协议与 id，每条带验证方法）+ 差分验证策略（同输入同输出 + 基线来源） |

**每个选中的包都要有一份人审文档**（内容自己写：表格、图、说明都行 —— OO 出类图与时序图、结构化出 DFD 与 ERD、迁移出映射表）：

```text
docs/METHOD-structured.md · docs/METHOD-oo.md · docs/METHOD-evolutionary.md · docs/METHOD-porting.md

第一行必须是（指纹从 `sdo_design action=method` 回执里抄）：
<!-- method-doc: package=oo; basis=<12 位指纹> -->
```

规则：① 选中的包没有对应文档 → G3 判红（点名路径与当前指纹）；② 文档头指纹与台账不符（台账改了没重新生成）→ 判红；③ 正文必须覆盖该包每个条目 id（缺哪个点名哪个）；④ 显式 `none` 或未选包 → N/A。

写法：`sdo_design action=artifact artifactKind=<dictionary|dfd|erd|classes|sequences|layers|debt|reversibility|increments|mapping|invariants|diffVerify> artifactData=<JSON>`（落 `.sdo/design/method-<kind>.yml`；`sdo_design action=method` 只读查看逐包状态）。`artifactData` 的公共字段只有 `summary` / `requires`，正文必须放在本 kind 的字段下：`dictionary→{dictionary:[…]}`、`dfd→{levels:[…]}`、`erd→{entities:[…],relations:[…]}`、`classes→{types:[…]}`、`sequences→{sequences:[…]}`、`layers→{rules:{layers,assignments,allowed}}`、`debt→{debts:[…]}`、`reversibility→{decisions:[…]}`、`increments→{increments:[…]}`、`mapping→{mappings:[…]}`、`invariants→{invariants:[…]}`、`diffVerify→{diffVerify:{…}}`。字段放错不会被静默忽略：回执点名被忽略的字段与本 kind 期望的字段；若一个期望字段都没给且盘上还没有该产物，写入被拒绝。

## 8.1 角色与角色卡（按需加载）

SDO 把每个**派发运行**的角色纪律写成卡片，随包放在 `skills/role-<角色>.md`（8 张，SKILL.md 风格）；插件启动时把它们注册成**一条**技能目录项，执行者按需加载，而不是把八张卡的正文塞进每次派发：

```text
技能名：sdo-role-cards   （宿主 skills 服务；缺失该服务的组合里静默降级，不影响装配）
内容：该读哪张卡（角色 → 卡片路径 → 掩码理由）+ 执行协议（claim → 写范围内 → 带证据 done → 卡住就 block）
卡片：`skills/role-analyst.md` · `role-red-team` · `role-architect` · `role-office`
      · `role-developer.md` · `role-tester.md` · `role-reviewer.md` · `role-delivery.md`
```

- 只注册**一条**目录项：技能目录（名字 + 描述）会进每个会话的系统提示，8 条就是 8 行常驻 token。
- 索引正文**现算**自 `src/data/roles.yml` 与卡片文件（单真源，不手抄）；改了角色表，索引与用例同步变。
- **两个前提缺一不可**：① 执行者的工具白名单里有 `skill`（8 个角色都加了）；② **preset 挂载了 `tool-skill`**（本 preset 已加）。只做①会出现"注册成功但无人可见"。
- 这条规则是**通用的**：宿主层 `dsh-web-app` 有意 `disabled: true` 的行（共 24 条，含 `tool-fs-search`、`tool-subagent-control`、`tool-skill`）**必须由 preset 自己补挂**，否则该能力在 sdo-office 会话里根本不存在，而插件文案/角色 allow 却假定它有 —— 会变成"死允许项"。本 preset 需要的那批行有机械守卫（`test/m28.test.ts`：集合方向 + `roles.yml` 每个工具名都要有已挂载的提供行）。
- 只挂 `tool-skill`、**不挂** `skill-filesystem`：SDO 走程序化注册（runtime 层），挂文件发现会把 `skills/` 下 8 张卡各变成一个目录项。
- 卡片是纪律、掩码是硬约束：`allow` 之外的工具角色看不到（掩码表见 `src/data/roles.yml`）。

## 9. 配置

全部配置写在 **preset 行的 `config`** 里（见 `presets/sdo-office.patch.yml`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `lang` | `zh-CN` | 界面语言：`zh-CN`（基准，永远完整）/ `en`；未知语言回落基准 |
| `projectDir` | `.sdo` | 项目台账目录（相对会话工作目录） |
| `injectStatus` | `true` | 是否每轮注入 `<SDO 状态>` 背景块 |
| `promptOrder` | `240` | 状态块的注入顺序（越小越靠前） |
| `statusChars` | `1500` | 状态块字符上限（200–4000）；超出截断并提示用 `sdo_status` 看全量 |
| `gateLevel` | `enforce` | `suggest` 只提示 / `enforce` 门禁前置 / `strict` 追加拦截写类工具 |
| `disciplineTools` | `["write","edit","bash"]` | `strict` 下受纪律守卫约束的工具 |
| `disciplineAllowPaths` | `[".sdo/","docs/","test/"]` | `strict` 下允许写入的路径前缀 |
| `commandEcho` | `echo` | 命令结果如何让你看见：`echo` 经 inbox 投递（不唤醒轮次）/ `none` 只回命令面 |
| `orchestrator` | `subagent` | 派发后端：`subagent` / `native-team`（实验）/ `inline` |
| `maxParallelDispatch` | `4` | 并行派发上限（1–8） |
| `captureWorkspaceChanges` | `true` | 采集 `workspace/changes` 证据 |
| `registerTools` / `registerCommands` | `true` | 是否注册工具 / 斜杠命令（headless 可只留工具面） |
| `board` | `{ text: true, panel: false }` | 看板后端：文本看板默认开；Web 面板未实现 |
| `cost` | 见 §6 | 成本监视与预算 |

界面语言的三种切换路径：

```text
① 聊天里说「切换成英文」   → 模型调 sdo_lang（立即生效，进程内）
② /sdo-lang en            → 斜杠命令（立即生效）
③ config.lang 或 SDO_LANG=en → 持久（重启后仍生效；env 优先于配置）
```

标识（`G0` / `REQ-001` / `in-progress`）**不翻译** —— 它们进出台账、命令参数与追溯图。

## 9.1 开发阶段的机器校验（A1 / B4 / A2 / C7 / D9）

开发阶段的一切都落在两个关口上：**`sdo_task action=claim`（开工）** 与 **`sdo_task action=done`（收工）**。
凡是能机械判定的都在这两处拦，判不了的（比如"证据够不够好"）留给评审员 —— 不硬编，避免逼人编造。

| 关口 | 校验 | 失败码 / 判据 |
|---|---|---|
| `claim` | 卡上有需求、且项目档位不是 `trivial` 时**必须先有用例计划** | `test-case-missing`（C7） |
| `claim` | CAS 版本、状态可认领、写范围不与在进行的卡冲突 | `revision-mismatch` / `not-claimable` / `write-scope-conflict`（既有） |
| `done` | 证据种类 ⊇ 卡上 `evidenceRequired` | `evidence-kind-missing`（A1） |
| `done` | `artifact` 证据的路径**必须真实存在**；给了 `sha256=` / `#<hex>` 就复算比对；越出工作区判红 | `evidence-artifact-missing` / `evidence-artifact-hash` / `evidence-artifact-outside`（A1） |
| `done` | `command` 证据带 `exitCode` 时必须为 0（不给则不拦） | `evidence-command-failed`（A1） |
| `done` | **写范围对账**：认领之后本会话真实改动的文件必须落在 `writeScopes` 内 | `write-scope-violation`（A2） |
| `done` | 卡上需求的用例**有结果**：`pass`，或 `skip` + 非空理由 | `test-result-missing`（没跑）/ `test-failing`（fail）/ `test-skip-unjustified`（skip 没写理由）（C7） |
| G5 | `size ≥ medium` 的完成卡必须有 `verdict=pass` 的评审 | `C-42 review.required`（D9） |
| G6 | 所有完成卡都有通过评审，且作者 ≠ 评审者 | `C-52 review.independent`（既有，比 C-42 更全更晚） |

**写范围对账的数据从哪来**：SDO 监听宿主的 `session/event` 追加流，把 `workspace/changes` 事件的
`(sessionId, seq)` 与文件清单记进 `.sdo/evidence/workspace-changes.jsonl`（`captureWorkspaceChanges` 控制开关）。
`claim` 事件自身（带 `sessionId`）当基线，`done` 只比"基线之后"的改动。

**"已对账"的判据是 `audited`，不是"有条目"**（评审 2026-10-03 抓到的 A2 缺陷）：每条命中条目都必须
**带宿主给的摘要**（`summaryAvailable`）才算对过账 —— 宿主没有 `workspaceChanges` 服务、或 `summary()`
返回 `undefined` 时，条目会"存在但没有文件信息"，那种情况**必须**回「写范围未对账」（`uiIndex.kWorkScopeNotAudited`），
不得给出干净回执。旧条目没有该字段 ⇒ 保守当"未对账"。宿主**明确**回了"零改动"（`files: []`）则算已核对。

**证据 JSON 形状**（`sdo_task action=done` 的 `evidence` 参数，写在工具描述里）：

```json
[{"kind":"command","detail":"npm test（423 passed）","exitCode":0},
 {"kind":"artifact","detail":"lib/src/index.js sha256=<64 位十六进制>"},
 {"kind":"workspace-changes","detail":"session-…@42"}]
```

`exitCode` 是**独立字段**：写进 `detail` 文本不会被读到（`detail` 只当人类摘要）。

**派发提示**（B4）：`buildDispatch` 的协议第 0 步就是"先加载角色卡技能 `sdo-role-cards`，再读本角色卡片"，
免得执行者要自己从技能目录里发现它。

## 10. 台账与产物

```text
<projectDir>/（默认 .sdo/）
├── journal.jsonl          追加式**真源**（每个版本改了什么、谁写的、什么结论都在这里）
├── project.json           项目投影（派生，可重建）
├── config.yml             项目级配置（可手改）
├── requirements/ questions/ risks/ issues/ changes/   需求、问题、风险、议题、变更
├── design/ contracts/ decisions/ quality/             设计元素/视图、契约、ADR、质量场景
├── tasks/ tests/ defects/ reviews/ evidence/          卡、测试、缺陷、评审、证据
├── gates/                 <门禁>.json 判定留痕 + signatures.yml 签字台账
└── delivery/              交付包与验收矩阵

docs/  SRS.md · DESIGN.md · TESTPLAN.md · TRACE.md · DELIVERY.md · BOARD.md（都是**派生视图**）
skills/ 8 张角色卡（analyst / architect / red-team / developer / tester / reviewer / delivery / office）
```

三条操作规则：

1. **手写真源**（`<projectDir>/` 下的 `*.yml`）可以手改，但必须是合法 YAML 子集（用空格缩进）；写坏会判红并点名相对路径。
2. **不要手改派生视图**：`project.json`、`docs/*.md`、看板都从真源现算。`docs/DESIGN.md` 的内容判据要求它与「按渲染头序号从当前真源重渲染」的结果一致 —— 改设计后请重新 `sdo_design action=render`，手改正文会被判红。
3. **签字绑定真源**：签字之后真源再变（改需求 / 设计 / 契约、重建基线等）会让签字失效，需要重新签字；注入块与看板里的「最近判定留痕」只是历史记录，**当前是否通过是现算的**。

## 11. 已知边界

| 边界 | 说明 |
|---|---|
| 派发宿主调用未接线 | `sdo_plan action=next` 会选后端、生成带 CAS 版本的派发请求并留痕；宿主 `SubagentRuntime.start` 的真实调用尚未接线。当前由流程官（**驾驶舱会话**）用 `send_message` 转交（该工具已由 preset 挂载；**被派发的角色没有它** —— 转交与观察子代理是驾驶舱的能力），或按 `inline` 就地执行。派发提示里已含「先加载角色卡技能」的第 0 步（B4）；**角色 `toolFilter` 仍只是算出来写进请求**，未真正施加 |
| 子代理用量未归集 | `sdo_cost` 只统计驾驶舱会话；子代理会话对象未暴露给插件，回执里明确说明而不是编数 |
| Web 面板未做 | 文本看板（`/sdo-board`）可用；Web 面板（client 插件）尚未实现 |
| L3 纪律守卫未实测 | 策略与钩子已就位（fail-open，仅 `gateLevel: strict` 时拦）；deny 分支在本环境未做实测 |
| 命令结果渲染 | Web 客户端不渲染"轮次之外"的命令节点（上游问题，见 `docs/verification/2026-09-29-上游问题-命令结果不渲染.md`）。SDO 用 `commandEcho: echo` 经 `agent.inbox.send(..., wakeup=false)` 投递成插件来源消息：界面可见、不唤醒轮次 |
| 多词值必须加引号 | `--note 见 choice=waive`（未加引号）里 `choice=waive` 是独立 token；要一个多词值就写 `--note "…"`（见 §7） |
| PlantUML 只出源码 | 本仓库不依赖 PlantUML，也没有渲染器：`--puml` 只写 `.puml` 骨架源码，出图请自行拿 PlantUML 处理 |
| 发布 / 运维 | 明确非目标：到「交付包 + 验收矩阵 + 回滚点」为止 |

## 12. 开发与发布

```bash
npm run build          # tsc → lib/
npm run typecheck      # 只做类型检查
npm test               # build + node --test（测试入口 scripts/run-tests.mjs）
npm run pack:offline   # 产出离线安装包 → dist/offline/
```

### 流水线（GitHub Actions，只用官方 action）

| 文件 | 触发 | 做什么 |
|---|---|---|
| `.github/workflows/ci.yml` | push（各分支）/ PR / 手动 | 矩阵 ubuntu + windows × node 20/22：`npm ci`（或回退 `npm install`）→ `typecheck` → `test` |
| `.github/workflows/release.yml` | tag `v*` / 手动 | 两 OS 各跑测试并 `pack:offline` → artifact → `gh release create` 发布离线包与 `SHA256SUMS`（已存在则 `--clobber`） |

发布：

```bash
git tag -a v0.1.2 -m "SDO v0.1.2" && git push origin v0.1.2
```

### 离线安装包

`npm run pack:offline` 产出 `dist/offline/`：

| 产物 | 说明 |
|---|---|
| `dsh-software-dev-office-<版本>-offline.tar.gz` | Linux / macOS；Win10+ 自带 `tar` 也可解 |
| `dsh-software-dev-office-<版本>-offline.zip` | Windows 可直接右键解压（ZIP 由脚本自写，不依赖外部 `zip`） |
| `SHA256SUMS` | 校验上面两个归档 |

包内：`tarballs/`（插件 + 运行时依赖闭包）、`npm-cache/`（构建期预填，装机器离线用）、`install.mjs` + `install.sh` / `install.ps1`、`manifest.json`、`README-offline.md`。离线包装依赖的三条要点：只打包 `dependencies` 的传递闭包、排除 `peerDependencies`（`@deepseek-ai/*` 由安装器链接宿主实例）；peer 用链接而不是拷贝；安装器在临时前缀装好再合并，卸载按安装记录精确回收（不要在 profile 里直接 `npm install`）。

CI 与本地一致地装依赖：

```bash
npm ci            # 按 package-lock.json 装，含 devDependencies
```

---

## 13. 协议与作者

MIT License © 2026 [raitpor](https://github.com/raitpor) —— 见 [LICENSE](LICENSE)。

变更历史：见 [CHANGELOG.md](CHANGELOG.md)。
