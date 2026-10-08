# dsh-software-dev-office（SDO）

> **一个 agent software dev office**：在同一个会话里，把「可行性 → 需求 → 架构 → 拆分 → 实现 → 测试 → 交付」
### 9.1b 实现阶段方法包（增量 3）

进**构造阶段**（`construction`；敏捷/螺旋在 `iteration` 里构造）后，**先让流程官决定方法包**，否则**不给认领**：

```text
sdo_plan action=profile packages='["tdd","contract-first"]' derivedFrom='["reqKind=functional(REQ-001)","contractCount=12"]' \
                          reason="12 个契约已冻结，普通规模"        # scope 省略 = all；exempt='[{...}]' 逐项豁免
```

- **模型自选，不问用户**；但 `derivedFrom` **至少一条要能被机械核对**（`reqKind=<kind>(<REQ-id>)` 比对需求台账、
  `contractCount=<n>` 比对契约数、`scale=<档位>` 比对 `.sdo/config.yml`），校验不过**整次拒绝、不写盘**。
- **显式不选任何包**（`packages='[]'` + `reason`）是合法的 N/A：判据 N/A，但理由要留下。
- **哪些会被拦**（开工关 = `claim`）：构造阶段没有 profile → `construction-profile-missing`；
  选了 `contract-first` 而卡所涉契约**没先冻结** → `contract-not-frozen`。
- **收工关 = `done`**：`tdd` 要求该卡覆盖的每条需求**先 fail 后 pass**（读 `.sdo/tests/results/TR-*.yml`，与 C7 同源）；
  `critical` 档位还要**变异自证**（`.sdo/construction/tdd.yml` 里 `killed ≥ 1`）；`contract-first` 要有**契约测试记录**（`.sdo/construction/contract-first.yml`）。
- **变异记录的 `target` 建议写清**（可空、**不判红**）：只写「用某工具杀了 ≥1 个变异」而没说**改了什么**，复核者没法跟着复跑；回执会在 `target` 为空时提示一句。另需知道：`killed`/`survived` 是**自报数**（插件无法独立验证），证据强度取决于谁在做、以及 `target` 是否写得可复跑。
- **怎么记交付物**（可选，也可直接手写这两份 yml）：
  ```text
  sdo_test action=record mutation='{"task":"TASK-004","tool":"node --test","target":"lib/x.js","killed":3,"survived":0}'
  sdo_test action=record contractTest='{"task":"TASK-005","contract":"CT-003","tool":"node --test","cmd":"node --test test/ct003.test.js"}'
  ```
  契约 id 必须在台账里存在（否则**整次拒收、不写盘**）；`killed = 0` 也允许落盘（"变异没杀掉"是有价值的事实，判据自己会判）。
- **结果文件的来源会被核对**：C7 与红→绿时序都读 `.sdo/tests/results/TR-*.yml`，但**文件必须在 journal 里有对应 `test/recorded` 事件** —— 只有文件、没有事件的记录判 `tdd-result-untraceable`（堵住「手写结果文件」这条伪造路）。两条路径用的是同一道核对。
- **交付物只落"无法现算"的事实**：红→绿时序、契约冻结序号都从既有真源现算，不另存一份；
  `.sdo/construction/*.yml` 可手写，也可由既有工具写入（`sdo_test` 的扩展见增量 3 设计文档第 6 步）。
- **复议**：随时可再调 `action=profile`（覆盖选择，把**被覆盖的那次**记进 `history`）；**已完成的卡不追溯判红**。
- **升级影响**：正在构造阶段的项目需要先跑一次 `action=profile`（或显式 `packages='[]'` 表明不启用）；已过 G4/G5 的不追溯。
- **门禁判据**：顺序流程（waterfall/prototype/spiral）在 **G4** 加 `C-33`（方法包已决定）、**G5** 加 `C-43`（范围内已完成卡满足所选包）；
  **agile 没有 construction 阶段**（构造发生在迭代里）⇒ 两条挂在迭代门 **GI**（`C-83`/`C-84`）。显式不选包时两条都是 **N/A**（不计入全绿分子）。
  复议本身不追溯，但要放过历史卡请写**豁免**（`exempt: [{task, check, why}]`，理由必填、且会被判据点名）。

按**门禁**推进；每一步的判据结论、证据、签字都落在可复算的台账里。
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
| **验证** | "记录测试与缺陷" | `sdo_test action=plan`（用例绑定需求）→ `action=record`（通过也要证据）→ `action=defect`（阻塞级缺陷会拦住门禁）→ `sdo_review action=record`（作者 ≠ 评审者）→ `sdo_task action=verify-review`（实现方逐条核实发现）→ `G6` |
| **交付** | "真机跑过再打交付包" | `sdo_deliver action=run`（记一条真机运行：目标/命令/结论/证据/**绑定被运行产物的 sha256**）→ 再 `action=package`（产物 sha256 清单 + **真机运行记录** + 验收矩阵 + 回滚点 + 声明不含原型内容；**缺真机证据则所有 `pass` 降级为 `unverified`**）→ `G7` |
| | | **MC 模组要 `runServer` 与 `runClient` 各一条**；其他系统对应各自的真机启动 |

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
| 卡写错了 | `sdo_task action=update id=… writeScopes='["src/x/"]'`（CAS 可选；写完要重新认领） |
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

### `.sdo/` 谁写谁读（口径）

`.sdo/` 是**插件真源**：由工具写入，人工**只读**。唯一例外是**明确要求用户决策**的文件（例如待你签字的门禁结论、
需要你回答的问题）。因此：证据、测试结果、签字、运行记录都必须由工具记账（journal 里留事件佐证）——
手写或事后改文件会在回执里被点名（D4/D8 的交叉核对就是这么判的）。

**写前快照**（`.sdo/evidence/file-history/`）：直接 `write`/`edit` 覆盖 `.sdo/` 下**手可编辑真源**之前，
插件先把旧内容存一份 `<相对路径>.bak`（名字带毫秒时间戳 + 同毫秒序号，**不会互相覆盖**）；
每个真源只保留**最近 20 份**（`FILE_HISTORY_KEEP`），更早的按时间从最旧删起。它是**观测产物、不是真源**：
既不参与任何判据，也不写 journal 事件（新事件类型会流进"签字失效 / 中性表"，把例行清理变成门禁事件）。

`disciplineTools` / `disciplineAllowPaths`（配置项）目前是**保留未启用**：`strict` 档暂时不据此收窄工具面或写入路径，
README 以前写成"已受约束"是**不准确**的（D12）。要用它们做硬闸门请先明确口径（会在运行中的项目上突然收窄能力）。

### 复合参数的写法（SDO-12）

`steps` / `evidence` / `acceptance` / `alternatives` / `consequences` / `links` / `telos` / `poc` / `mutation` /
`contractTest` / `suggestions` / `deps` 等**复合参数在 schema 里是字符串**：必须传**字符串化的 JSON**
（元素用双引号，例如 `suggestions='[{"title":"…","dod":["…"]}]'`）。直接传数组/对象会被宿主参数校验挡下
（报 `"<参数名>" must be a string`），**不是**插件在拒绝 —— 真机上为此浪费过 6 次调用。
字符串内部要引号时用「」或反引号，别用 ASCII 单引号当 JSON 引号。

## 8. 模型工具速查（20 个）

| 分组 | 工具（动作） |
|---|---|
| 项目与状态 | `sdo_init`、`sdo_status`（含 `rebuild`）、`sdo_project`（update / show）、`sdo_lang`（show / set） |
| 需求 | `sdo_requirement`（capture / grill / answer / update / change / list / baseline / design-questions / applicability / applicability-confirm）、`sdo_redteam`（attack / propose / file / dispose / on / off / status） |
| 可行性 / 风险 | `sdo_feasibility`（assess）、`sdo_risk`（log / update / list / conclude） |
| 架构与设计 | `sdo_design`（view / create / contract / drop-contract / grill / answer / confirm / issues / render / method / artifact / review / waive-plan）、`sdo_adr`（record / list / supersede）、`sdo_quality`（scenario / evaluate / list） |
| 计划与协同 | `sdo_plan`（decompose / iteration / next / profile）、`sdo_task`（list / claim / done / block / drop / release / reassign / update / verify-review）（`update` 改卡字段含写范围；已完成卡不改、有人在做时不得改写范围） |
| 验证与评审 | `sdo_test`（plan / record / defect / list / env）、`sdo_review`（record / rehash / list）—— `rehash` = 给**老格式评审**补记内容指纹（补记之后改 verdict/正文可检出）—— 评审核实在 `sdo_task`（list / … / **verify-review**）：实现方逐条核实评审发现（复现 / 反证），核实过的评审才会被门禁采纳 |
| 追溯与文档 | `sdo_trace`（link / unlink / query / report）、`sdo_render` |
| 门禁与成本 | `sdo_gate`（check / advance / sign / waive / rollback）、`sdo_cost`（report） |
| 交付 | `sdo_deliver`（run / package / show） |

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
- 卡片是纪律、掩码是硬约束。**掩码分两层（2026-10-08 口径纠正）**：
  · **SDO 流程面**（`sdo_*`，本插件自己注册的封闭集合）—— **白名单**：`allow` 里没列的 `sdo_*` 一律下发 deny
    （developer 拿不到 `sdo_gate`、reviewer 拿不到 `sdo_test`…这一层是**职责分离**）；
  · **通用面**（宿主/harness 的 `read`/`write`/`bash`/`skill`/记忆/技能/联网…）—— **黑名单**：
    只有 `roles.yml` 的 `deny` 明写挡住的才挡（谁能写、谁能跑 bash 逐角色写清），其余**继承宿主默认**。
  旧口径把 `allow` 当**整体**白名单下发，等于连通用面一起清空 —— 真机事故：子代理原话
  「**无法使用 `technique_apply`**」（它手里只有角色声明的十几个名字）。掩码表见 `src/data/roles.yml`。
- **执行者禁令（2026-10-08 用户裁定）**：被派发的执行者**不得再起一个 agent 运行** ——
  `subagent` / `subagent_fork` / `workflow` / `sdo_plan` 四件套对子会话一律拒绝。它们起的子代理
  **不带角色掩码**（不经过 `toolFilter`），拿到任何一个就等于**绕开整张掩码表**。
  三层施加：下发 deny 面**无条件**含它（`EXECUTOR_FORBIDDEN_TOOLS`）、钩子按 `MaskContext.executor` 拒绝、
  派发提示与 8 张角色卡都写明。**只对子会话生效**：驾驶舱即使认领了卡也仍能派发（它的本职）。
- **写入控制分两层（2026-10-08 用户裁定）**：① **工具级**——谁能写（`write`/`edit`/`bash`，只读角色一条都没有）；
  ② **路径级**——写得下去写不下去由**路径**决定：必须落在本次**活卡的 `writeScopes`** 内，
  公共面（`disciplineAllowPaths`：`.sdo/` 台账、`docs/` 派生文档、`test/` 用例）不受卡范围约束；
  没认领就只能写公共面。**`write` 与 `edit` 必须同权**：只给 `write` 不给 `edit` 不代表更安全
  （`write` 一样能整篇覆盖、`bash` 更能），只会把「改一处」逼成「读全文 → 整篇写回」——
  真机 architect 正是这么把登记簿覆盖掉、23 条 DEV 正文永久丢失的（SDO-23）。
- **诚实边界**：宿主 `sandbox` 只有**模式级**策略，没有路径白名单 ⇒ **`bash` 的越界写没有机械前置拦得住**，
  只能靠 `done` 时的 A2 写范围对账兜底；要硬拦只有一条路——**角色不给 `bash`**。
- **通用工具也可能被"限定给某角色"**（例：`ask_user_question` **仅 analyst**，2026-10-08 用户裁定）：
  做法是在**其他角色的 `deny`** 里写它 —— 那才是真源（改提示词不算数）。
- **执行者禁用面（2026-10-08 全面审计）**：除了那四件套，执行者还一律拿不到 **平台 / 用户 / 会话 / 共享库**
  层面的能力 —— `plugin_manager`（装卸插件）、`exit_plan_mode`（要用户批准计划）、
  `memory_forget` / `technique_forget`（共享知识库的**不可逆删除**，`"*"` 会全清）、`failure_forgive`
  （给自己豁免纪律）、`create_goal` / `update_goal`（会**自动续轮** ⇒ 自我续命）。见
  `domain/roles.ts` 的 `EXECUTOR_DENIED_TOOLS`（每条都有分类理由），以及
  `test/m75` 的**审计守卫**：宿主工具面逐个归类，新工具出现必须有人做决定；按角色分权的工具
  必须"声明集与 deny 集互补"，否则用例红（"再一个 `ask_user_question`" 会被机械抓住）。

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
| `disciplineTools` | `["write","edit","bash"]` | **保留未启用**：`strict` 档目前**不**据此收窄工具面（口径见 §8 前的说明，D12） |
| `disciplineAllowPaths` | `[".sdo/","docs/","test/"]` | **保留未启用**：`strict` 档目前**不**据此限制写入路径（D12） |
| `commandEcho` | `echo` | 命令结果如何让你看见：`echo` 经 inbox 投递（不唤醒轮次）/ `none` 只回命令面 |
| `orchestrator` | `subagent` | 派发后端：`subagent` / `native-team`（实验）/ `inline` |
| `maxParallelDispatch` | `4` | 并行派发上限（1–8） |
| `dispatchOrphanTtlMinutes` | `60` | 未结算派发的**孤儿 TTL**：`dispatch/started` 之后超过这么久仍无 `dispatch/finished`（子会话被强杀 / 派发丢了）就不再占池位；TTL 内的未结算派发照旧占位（不误伤长任务） |
| `poolCaps` | `{}` | **按角色的子代理池上限**，如 `{ developer: 2, tester: 1 }`；没写的角色用 `maxParallelDispatch`。池满的卡**排队**（不丢卡），等池里有子代理结算后由下一次 `sdo_plan action=next` 放行 |
| `captureWorkspaceChanges` | `true` | 采集 `workspace/changes` 证据 |
| `enforceRoleMask` | `true` | 对**认得出的派发角色**硬拦掩码之外的调用（B6）；关掉只是不拦，掩码声明照旧 |
| `dispatchProvider` | `spawn` | 真派发用的 provider 名（宿主 `subagents.list()` 里的名字；preset 默认装 `spawn`） |
| `dispatchMaxDepth` | `1` | 派发深度上限（子代理不再开子代理） |
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
| `claim` | **存在已批准但未消化的需求变更**（未重新基线，或未重过设计门） | `change-not-digested`（语义 A，见下） |
| `done` | 证据种类 ⊇ 卡上 `evidenceRequired` | `evidence-kind-missing`（A1） |
| `done` | `artifact` 证据的路径**必须真实存在**；给了 `sha256=` / `#<hex>` 就复算比对；越出工作区判红 | `evidence-artifact-missing` / `evidence-artifact-hash` / `evidence-artifact-outside`（A1） |
| `done` | `artifact` 的 `detail` 只能是「路径」或「路径 sha256=<64hex>」——**路径/哈希后面跟说明文字**会被当成路径的一部分 | `evidence-artifact-detail`（A1；文案会指出多出来的那段，并把合法哈希区分开） |
| `done` | `command` 证据带 `exitCode` 时必须为 0（不给则不拦） | `evidence-command-failed`（A1） |
| `done` | **写范围对账**：认领之后本会话真实改动的文件必须落在 `writeScopes` 内 | `write-scope-violation`（A2） |
| `done` | 卡上需求的用例**有结果**：`pass`，或 `skip` + 非空理由 | `test-result-missing`（没跑）/ `test-failing`（fail）/ `test-skip-unjustified`（skip 没写理由）（C7） |
| G5 | `size ≥ medium` 的完成卡必须有 `verdict=pass` 的评审 | `C-42 review.required`（D9） |
| G6 | 所有完成卡都有通过评审，且作者 ≠ 评审者 | `C-52 review.independent`（既有，比 C-42 更全更晚） |

**写范围对账的数据从哪来**：SDO 监听宿主的 `session/event` 追加流，把 `workspace/changes` 事件的
`(sessionId, seq)` 与文件清单记进 `.sdo/evidence/workspace-changes.jsonl`（`captureWorkspaceChanges` 控制开关）。
`claim` 事件自身（带 `sessionId`）当基线，`done` 只比"基线之后"的改动。

**采集与解析是分开的（竞态）**：宿主先 `session.append('workspace/changes', …)`、**之后**才把摘要写进记录，所以采集监听器那一刻拿不到文件清单。SDO 因此只记 `(sessionId, seq)`，并在 **`done` 时**（会话通常还活着）用 `workspaceChanges.summary(sessionId, seq)` 再取一次、**补记**一条带清单的记录；取不到就照旧如实报「未对账」。

**"已对账"的判据是 `audited`，不是"有条目"**（评审 2026-10-03 抓到的 A2 缺陷）：每条命中条目都必须
**带宿主给的摘要**（`summaryAvailable`）才算对过账 —— 宿主没有 `workspaceChanges` 服务、或 `summary()`
返回 `undefined` 时，条目会"存在但没有文件信息"，那种情况**必须**回「写范围未对账」（`uiIndex.kWorkScopeNotAudited`），
不得给出干净回执。旧条目没有该字段 ⇒ 保守当"未对账"。宿主**明确**回了"零改动"（`files: []`）则算已核对。

**数据源的真实边界（实测 2026-10-03，sdo-test 67 个会话记录）**：宿主只为**顶层轮次**公告 `workspace/changes` ——
9 个主会话共 38 个事件，而 **58 个子代理会话 0 个**。所以写范围对账只在「认领会话自己收到过公告」时成立；
**被派发的执行者（子代理）完成的卡会走「写范围未对账」兜底**。要让 A2 覆盖派发卡需要换数据源
（例如按卡的 `writeScopes` 在认领前后比对文件指纹），属设计取舍 —— 当前实现**不假装**覆盖，回执里如实说明。

**证据 JSON 形状**（`sdo_task action=done` 的 `evidence` 参数，写在工具描述里）：

```json
[{"kind":"command","detail":"npm test（423 passed）","exitCode":0},
 {"kind":"artifact","detail":"lib/src/index.js sha256=<64 位十六进制>"},
 {"kind":"workspace-changes","detail":"session-…@42"}]
```

`exitCode` 是**独立字段**：写进 `detail` 文本不会被读到（`detail` 只当人类摘要）。

**派发提示**（B4）：`buildDispatch` 的协议第 0 步就是"先加载角色卡技能 `sdo-role-cards`，再读本角色卡片"，
免得执行者要自己从技能目录里发现它。

### 变更控制：批准的需求变更强制回退（语义 A）

需求基线之后改需求必须走 `sdo_requirement action=change`（变更请求 + 影响分析 + 决策）。
**批准**的变更会立刻把项目**拉回需求阶段**，并要求按顺序做完这三步才能继续开发：

```text
① 更新受影响需求      sdo_requirement action=update id=REQ-…
② 重新冻结 G2（重签）  sdo_requirement action=baseline
③ 重走设计并重过 G3    sdo_gate action=check gate=G3（或 advance）
```

在 ②③ 都完成之前，构造阶段的 `claim` 一律拒绝，错误码 **`change-not-digested`**（回执点名是哪条 CR、哪条需求）。
判定完全从台账现算、不新增真源：**批准之后有覆盖该需求的重新基线**，**且此后设计门有 `passed` / `waived` 的判定** ——
两步缺一不可（只重签 G2 不够：需求变了却不重新设计，那条需求就变成"让模型自由发挥"）。
`rejected` / `deferred` 的变更**不动阶段**；低影响变更也走同一条路（**有意不按影响面分级** —— 分级会引入
"什么算低影响"的判断口子，正是这条纪律要堵的）。
设计依据：[`docs/plan/2026-10-04-需求变更强制回退-设计.md`](docs/plan/2026-10-04-需求变更强制回退-设计.md)。

### 派发：从「打印请求」到「真的起一次」（B4 / P-1）

`buildDispatch` 组装的请求现在**真的交给宿主**：

```
sdo_plan action=next  →  pickBackend →  buildDispatch  →  subagents.start(settings.dispatchProvider, {
    prompt:      [{ type:'text', text: request.prompt }]   // 协议第 0 步就让执行者先加载 sdo-role-cards
    parent:      call.agent                                // 本次调用的发起 agent（宿主要求 live Agent）
    persona:     request.persona
    toolFilter:  { allow: request.toolFilter, deny: 角色 deny }   // ← 下发给宿主；**是否真隐藏取决于 provider 能力**（见下）
    maxDepth:    settings.dispatchMaxDepth                 // 默认 1：子代理不再开子代理
})
```

**"收窄到什么程度"是可观察的（评审 §4.2，第二轮加严）**：子代理每次开新请求都会公告 `request/header`，里面带**它实际拿到的工具清单**。
SDO 只对自己派发出去的子会话（台账 `dispatch/started`）记账，写进 `.sdo/evidence/child-tools.jsonl`，
并在下一次派发回执里如实展示：**「全部在掩码内」**（那就是宿主确实收窄了的证据）或
**「掩码外工具仍可见：…」**（点名越界工具）。这样就不必靠谁的口头断言。

**工具面隐藏没有关闭，而且原因在宿主侧**（真机实测 2026-10-03）：`toolFilter` 我们确实下发了，`spawn` provider 也**声明**
`capabilities.toolFilter: true`（`dsh-subagent-spawn-in-process/lib/index.js:27`），宿主链路里也确实调了
`applyChildComposition(..., {toolFilter})` → `childCtx.tools.restrict(...)` —— **但实测没生效**：sdo-test 派发出去的子代理
**仍能调用**掩码外的 `sdo_plan`/`sdo_review`/`sdo_gate`（全部被**钩子的 B6 拦下**）—— 它的**公告面**其实被收窄了（`request/header` 里只有掩码内 9 个）。疑似「子代理自带 preset 之后注册进来的工具
绕过 `restrict()`」，已另记 `docs/verification/2026-10-03-上游问题-子代理toolFilter未生效.md`。
⇒ 派发回执**只陈述能证明的事**：已下发（附 provider 与它声明的能力值）+ **是否真的收窄，本插件无法自证** + 越界由钩子兜底。
**P-3 仍未关闭**，而这不是接线问题。

成功 → 记 `dispatch/started`（子会话 id）并回执「已真正派发」；失败 → 如实给出原因
（`no-service` / `no-provider`（附可用 provider 列表）/ `no-parent` / `failed`），并退回
「流程官用 `send_message` 转交」的老路径。**绝不假装派出去了**。

### 角色掩码真的生效了吗（B5 / B6）

**B5：先认出「这次工具调用是谁发的」**。宿主在 `ToolExecution.agent` 上给了发起者；据此四态判定：

| 情形 | 角色 | 掩码 |
|---|---|---|
| 该会话**正做着**某张卡（卡 `in-progress` 且 owner 未变） | 卡上的 `role` | **硬拦**（B6） |
| 子会话（`delegationDepth > 0`）但还没认领 | `dispatched`（非驾驶舱） | 不拦（角色未知），但**阶段纪律照走** |
| 根会话（驾驶舱） | `cockpit` | 不拦 |
| 拿不到会话信息 | `cockpit` | 不拦（**fail-open**：认不出人不能变成干不了活） |

归属**只在这张卡正被做着时**成立：卡 `done`/`blocked`/`dropped`、被 `release` 回 ready、或被 `reassign` 换人，该会话立刻回到 `cockpit`（否则单会话模式下驾驶舱会被永久降级成那个角色的工具面，连 `sdo_gate` 都调不了 —— 评审 2026-10-03 F2）。

`sdo_task` 是**协议通道**（claim/done/block 全在它上面），因此 **8 个角色的 `allow` 都必须包含它** —— 缺一个就会「认领即锁死」（评审 2026-10-03 F1）。`m31-04` 直接从派发提示里机械推导用到的工具并逐个核对掩码，以后提示里加了调用而掩码没跟上会立刻红。

**B6：认得出的派发角色，掩码之外的调用当场拒绝**（**同一套两层语义**：`sdo_*` 走 `allow` 白名单，
通用面只有 `deny` 里明写的才拒），开关 `enforceRoleMask`（默认开）。拒绝文案会点名角色、工具、该角色**可用**的工具面与角色卡路径。
角色推导结果按 `roleCacheVersion` 缓存（本进程的认领/回报会失效）+ **5 秒 TTL** 兜底：钩子这个热路径不重读 journal，而台账若被**别的进程/实例**改写，最多陈旧 5 秒。

诚实边界：**钩子拦的是调用**（第二层防线）。工具面**隐藏**由 P-1 接线后的 `toolFilter` 交给宿主施加 ——
现在**只下发 `deny`**（不发 `allow`）：`allow` 一填就把整个通用面挡掉了（见上）。
该下发已在真机上跑通并观测到子会话的公告面（`evidence/child-tools.jsonl`，`violations: []`）。

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
2. **不要手改派生视图**：`project.json`、`docs/*.md`、看板都从真源现算。`docs/DESIGN.md` 的内容判据要求它与「按渲染头序号从当前真源重渲染」的结果一致 —— 改设计后请重新 `sdo_design action=render`，手改正文会被判红（逐字节比对，`docs/DESIGN.md` 顶部的注释区也算在内）。
   如果你在 `docs/DESIGN.md` 里手写了内容，**下一次渲染覆盖它之前会先留副本**（`.sdo/evidence/file-history/`，同一套上限），并把副本落点记进 `design/rendered` 事件的 `snapshot` 字段 —— 手改不会被"静默销毁"。
3. **评审结果要核实才能采纳**：评审（`sdo_review action=record`）记下的发现是**主张**，不是结论。
   要它被门禁采纳（G5 的 C-42 / G6 的 C-52）或被用来闭合改动，必须由**该卡的实现会话**逐条核实：
   `sdo_task action=verify-review id=<卡> review=REV-… index=<第几条，从 1 起> outcome=reproduced|refuted proof="…"`
   —— 照发现能复现就 `reproduced`、复现不了就 `refuted` 并给反证（**空口核实不算**，`evidence` 必填）。
   没核实完的评审在状态块、`action=list`、门禁文案里都会点名（与"没有评审"分开说）；
   卡上最新一条评审还在 `changes-requested` / `reject` 且发现没核实完时，`sdo_task action=done` 会被拒。
   评审**任务卡**的完成不再要求"再被评审"（自我递归没有意义），但它的评审产出同样要按上面这条核实。
4. **签字绑定真源**：签字之后真源再变（改需求 / 设计 / 契约、重建基线等）会让签字失效，需要重新签字；注入块与看板里的「最近判定留痕」只是历史记录，**当前是否通过是现算的**。

## 11. 已知边界

| 边界 | 说明 |
| 工作区不是 git 仓库 | 宿主采不到 `workspace/changes` ⇒ `done` 会**显式**报「写范围未对账」（不等于没有越界，也不据此判越界）。退路：在能采到的会话里重跑，或用 `evidence` 的 `artifact` 逐条列出本轮实际写入的文件再人工比对。**不自动退回 mtime 扫描**（会把上一次中断会话留下的旧文件误判成本轮改动，F-7 事故）。 |
|---|---|
| 派发已接线（P-1），**工具面探针必须带 agent 作用域** | `sdo_plan action=next` 会真的调用宿主 `subagents.start(provider, {prompt, parent, persona, toolFilter: {allow, deny}, maxDepth})` 起子代理，并把子会话 id 记进 `dispatch/started`；宿主没有该服务 / 未注册 provider / 拿不到发起 agent 时**如实回执原因**，退回「流程官用 `send_message` 转交」。**⚠️ 宿主 API 陷阱（D-14 blocker，sdo-test-new 2026-10-08 真机复现）**：`tools.get(name)` **省略 scope 时只查全局层**，而 `sdo-office` preset 的工具注册在 **agent 平面** ⇒ 探针对 15 个名字**全部**返回 undefined，白名单被清成 `[]` 原样下发，子代理**一个工具都没有**（子会话描述符 `toolFilter.allow: []`，整轮只能把工具调用写成正文，卡零变化，而回执仍写"已真正派发"）。现在：探针按 `call.agent` 作用域查（查不到再退回全局视图）；`filterKnownTools` 把"名单非空却全未知"当**探针不可用**（原名单 fail-open，真有未注册名时宿主 `restrict()` 会**当场抛错**），并区分 `applied`（实际下发）与 `kept/dropped`（探针的说法）；回执分开报 **SDO 流程面白名单**与**实际下发的 deny 面**，deny 面为空时**显式告警**；`request/header` 里工具面为空会记 `dispatch/observe-failed`（不再静默）。**并且下发内容已从 `allow` 白名单改成只发 `deny`**（见上面的两层口径）。**工具面隐藏本身仍是宿主行为**：`toolFilter` 已下发、`spawn` 也声明支持，但实测子代理**仍能调用**掩码外工具（被钩子 B6 拒绝）；观测见 `.sdo/evidence/child-tools.jsonl`，上游问题见 `docs/verification/2026-10-03-上游问题-子代理toolFilter未生效.md` |
| **子代理复用的判据：要"有工具"的正面证据** | 复用一个空闲的 continuable 子会话需要**两**条同时成立：① 掩码指纹一致（SDO-52：工具面是**创建会话时**定下的）；② `evidence/child-tools.jsonl` 里**观测到该子会话公告面非空**（R-1：修复前构建创建的零工具子会话 `f4ae86fa` 被复用两次，两次都是"无工具 → 把工具调用写成正文 → 1 轮结束"）。**观测到零工具、或根本没有观测记录 ⇒ 强制新起**（新起永远是对的，复用只是省一次会话创建），原因写进回执（`kReuseSkipped` / `kPoolUnusable`）。这类"永远不会被复用"的空闲会话**不占池位**，否则 `poolCaps` 很窄的角色会永久排队（既不复用它、也没位子新建） |
| 议题"闭环"是**现算**的，文件里的 `status` 是显式处置记录 | C8 用 `issueClosure()` 从「相关质询是否已回答 / 是否已转为风险」**现算**闭环，从不读 `issues/*.yml` 的 `status`；因此"质询都答完了"与"文件还写着 `status: open`"可以同时成立（sdo-test-new 真机就是 6 个议题这个状态）。插件**不自动改写**手可编辑真源（那会把派生结论冒充人工处置），而是给入口 + 说清口径：`sdo_redteam action=dispose id=REQ-ISSUE-00x disposition=risk\|requirement note=…` 把文件追平并留 `issue/closed`，回执区分"这次真的闭环了"与"门禁此前已现算判闭环、本次只是把文件追平" |
| 子代理用量未归集 | `sdo_cost` 只统计驾驶舱会话；子代理会话对象未暴露给插件，回执里明确说明而不是编数 |
| Web 面板未做 | 文本看板（`/sdo-board`）可用；Web 面板（client 插件）尚未实现 |
| 派发子代理的生命周期不可见 | P-1 用宿主 `subagents.start` 起的子会话**不在驾驶舱 `list_agents` 里**；卡停在 `in-progress` 时只能靠读会话文件判断它还活着，**没有超时/回收机制**（与「失联 owner 不自动释放」同类）。台账里有 `dispatch/started`（子会话 id）可作为线索 |
| A2 的数据面很窄（已部分修） | 宿主只为**顶层轮次**公告 `workspace/changes`（实测：9 个主会话 39 事件 / **59 个子代理会话 0 事件**）⇒ 派发卡的写范围对账仍走「未对账」兜底。另有一个**竞态**曾让主会话也拿不到清单：宿主**先 `append` 事件、后写摘要记录**（`dsh-workspace-changes` 相邻两行），采集监听器在 append 那刻必然读到空 ⇒ 现改为「采集只记 `(sessionId, seq)`，`done` 时再取一次并补记」 |
| 工具面隐藏的真机效果（**已部分自证**） | B5/B6 起：钩子用 `ToolExecution.agent` 推角色（认领过的卡 → 卡上的角色），并对**认得出的派发角色**硬拦掩码之外的调用（`enforceRoleMask`，默认开；fail-open；**两层语义同上**）。**角色掩码的真机效果已由 sdo-test 验证**：真派发的子代理会话里出现 `tool/result` 级的拒绝回执（「越界：角色 developer 的工具面里没有 …」，本工作区按首行 `delegationDepth` 复算命中 8 个 depth≥1 会话）；本地单测另覆盖四态推导、掩码判定与真实钩子驱动。**仍待真机逐一核对**的是：P-1 真派发时子代理的**工具面**里确实没有掩码外工具（`toolFilter` 已交给宿主，属宿主行为）。另：角色归属的缓存是**进程内**的（版本号 + 5 秒 TTL），跨进程改台账最多陈旧 5 秒 |
| 命令结果渲染 | Web 客户端不渲染"轮次之外"的命令节点（上游问题，见 `docs/verification/2026-09-29-上游问题-命令结果不渲染.md`）。SDO 用 `commandEcho: echo` 经 `agent.inbox.send(..., wakeup=false)` 投递成插件来源消息：界面可见、不唤醒轮次 |
| 多词值必须加引号 | `--note 见 choice=waive`（未加引号）里 `choice=waive` 是独立 token；要一个多词值就写 `--note "…"`（见 §7） |
| PlantUML 只出源码 | 本仓库不依赖 PlantUML，也没有渲染器：`--puml` 只写 `.puml` 骨架源码，出图请自行拿 PlantUML 处理 |
| 发布 / 运维 | 明确非目标：到「交付包 + 验收矩阵 + 回滚点」为止 |

> 文档索引与权威性（哪些文档是现行、哪些是历史）：见 [`docs/README.md`](docs/README.md)。设计与实现的偏移核实见 [`docs/verification/2026-10-03-设计与实现偏移核实.md`](docs/verification/2026-10-03-设计与实现偏移核实.md)。

### 9.1c 派发汇报（子 agent 取汇报）与子代理复用

- **取汇报（推 + 拉）**：子代理结算后的报告会**自动贴在你下一次调用任何 SDO 工具的回执**上（最多 3 份，送达一次后不再重复；载体是工具回执 —— 宿主没有子会话→父会话的投递通道）；`sdo_status` 同时保留「**最近完成的派发**」块供随时拉取（卡 / 子会话 / 结论 / 耗时 / 报告落点 + 摘要）。子代理结算时（`turn/end`）会写
  `dispatch/finished` 并把它的**最后一条助手消息**落到 `.sdo/evidence/child-reports/<卡>-<子会话前8位>.md`（按卡切，复用时不覆盖；读者按 `dispatch/finished.report` 读回）；派发回执也会给出复用/观测口径。
- **观测失败不再静默**：采集类失败仍 fail-open，但会记一条 `dispatch/observe-failed`（真机上曾丢过三次派发的观测）。
- **复用**：宿主 `subagents.start` 目前**只发 one-shot**（宿主 `Service.start()` 里把描述符写死 `mode: one-shot`），所以每次派发都是新会话、无法复用；
  宿主**已经**提供可续聊入口（`subagents.startContinuable` / `sendMessage`，后者按宿主注释「空闲的目标会起一轮」），
  插件侧已实现**角色池 + 卡队列**：逐角色并行上限（`poolCaps`）、池满排队不丢卡、结算后把下一张卡**投给空闲的同一个子代理**（真复用）。
  投递由驾驶舱触发（`sdo_plan action=next`），插件不自主起代理；宿主不可续聊时如实降级为 one-shot + 并发上限。
- 设计与探测证据见 [`docs/plan/2026-10-04-派发汇报与子代理复用-设计.md`](docs/plan/2026-10-04-派发汇报与子代理复用-设计.md)。

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
