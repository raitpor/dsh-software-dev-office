# dsh-software-dev-office（SDO）

> **一个 agent software dev office**：把「可行性 → 需求 → 架构 → 拆分 → 实现 → 测试 → 交付」做成**门禁驱动、证据可查**的流程，全部跑在**同一个会话**里。
> 基于 **dsh `0.2.0`**（deepseek-harness 原生 Cordis 插件）；到「可部署产物」为止，**发布与运维是明确的非目标**。

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.1-green)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

---

## 为什么需要它

让 agent 写代码，瓶颈通常不在"写不出来"，而在**"做什么"没定清楚**：需求含糊、边界没人拍、做完没有可判定的验收。

SDO 的做法是把这件事变成**机械可判**的流程：

| 原则 | 含义 |
|---|---|
| **门禁驱动** | 8 道门（`G0` 立项 → `G1` 可行性 → `G2` 需求基线 → `G3` 架构 → `G4` 详细设计与计划 → `G5` 开发完成 → `G6` 验证 → `G7` 交付），每条判据**逐条**判定；**未实现的检查器一律判失败**（绝不允许"查不到就算过"） |
| **证据可查** | 任务卡完成必须带证据（产物路径/命令输出/改动引用）；评审必须**作者 ≠ 评审者**（机械校验，不靠自觉） |
| **单一真源** | `.sdo/journal.jsonl` 是追加式真源，其余文件都是**派生投影**、随时可重建；`sdo-board`/`sdo-status` 只读展示 |
| **确定性引擎** | **插件本身不调用模型**：它负责流程、门禁、台账与校验；模型产出的内容（红队质询、设计建议）必须经插件校验后才落库 |
| **成本只监视、不硬停** | 只统计 token，金额要你手填单价、且处处标注「估算」；超预算**不会中断开发**，只提醒你选追加/豁免/收敛 |
| **单会话原则** | 全部流程在同一会话（驾驶舱）完成；「角色」不是会话，而是**一次派发运行**（带工具掩码的 subagent） |

---

## 快速开始

### 1) 安装

#### A. 离线安装包（推荐，装机器**无需联网**）

从 [Releases](https://github.com/raitpor/dsh-software-dev-office/releases) 下载对应产物（每个版本改了什么见 [CHANGELOG.md](CHANGELOG.md)）：

```text
Linux / macOS ：dsh-software-dev-office-0.1.1-offline.tar.gz
Windows       ：dsh-software-dev-office-0.1.1-offline.zip   （也可用 tar.gz，Win10+ 自带 tar）
```

解压后执行：

```sh
./install.sh --profile web                  # Linux / macOS
.\install.ps1 --profile web                 # Windows PowerShell

node install.mjs --profile web --dry-run    # 先看计划，不落盘
node install.mjs --profile web --verify     # 只校验
node install.mjs --profile web --uninstall  # 卸载（精确回收它装过的东西）
```

安装器会：① 用**离线 npm** 把插件与依赖闭包装进 `<profile>/node_modules`；② 把**宿主的 `@deepseek-ai/*` 实例链接**进 profile（保证只有一份服务注册表）；③ 把插件登记进 profile 的 `dsh.profile.bundles`（改前留 `.bak-offline-<时间戳>` 备份）；④ 校验（模块可 import + 组合树可见）。**装完请重启 dsh。**

#### B. 源码安装（开发态）

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

### 2) 打开会话：**必须显式选择 preset**

SDO **不是**默认加载的插件。它随包提供一个 preset（显示名 **SDO 研发办公室（驾驶舱）**）：**只有显式选择它的会话才被接管**，未选择的会话完全不加载，也**无法中途接管**已开始的会话 —— 切换 preset 需要**新建空白会话**。

> 这是刻意的入口设计：不是所有会话都该被流程接管。
> 另注：preset 由 `dsh-web-app` 提供的 `agent-preset-registry` 消费，因此 SDO 在 Web/CLI 会话里可用；headless/ACP 环境只能用工具面。

### 3) 第一次 5 分钟：立项 → 可行性 → 需求

```text
你：我要做一个铁路订票系统（Web + SQLite，单机 Docker 部署，只做内网演示）
   ↓ 模型会调 sdo_init
SDO：缺关键参数 ⇒ 先给一张问询单（项目名 / 开发流程 / 规模档 / 干系人）——**不会拿默认值悄悄立项**
你：（确认四项）
SDO：PRJ-001 已立项 → 阶段 feasibility
   ↓ sdo_feasibility（TELOS 五维 + 结论 + 高风险项的 PoC 建议）、sdo_risk（风险登记）
SDO：G1 可行性门禁 ✅
   ↓ sdo_requirement action=capture（捕获需求，自动做八维歧义评分）
SDO：REQ-001 已落账（八维评分：数据/接口维度偏弱）
   ↓ sdo_requirement action=grill → **审讯式提问**（每题带选项与代价）
SDO：Q-0001 单日峰值订单量级？（选项 A/B/C，各自代价）
你：（回答，或"不知道"→ 记为**假设**，仍是开环问题）
   ↓ sdo_redteam action=attack（红队对抗式提问）→ sdo_requirement action=answer
   ↓ sdo_requirement action=baseline --approvedBy=raitpor
SDO：G2 需求基线门禁 ✅（需求冻结为 v0.2）
```

## 使用教程（按阶段）

| 阶段 | 你可以说 | 会发生什么 |
|---|---|---|
| **立项** | "立项：<一句话项目>" | `sdo_init`（缺参数先问询）→ `G0` 判据：范围/非目标/干系人/成功度量 |
| **可行性** | "做可行性评估" | `sdo_feasibility`（TELOS 五维）+ `sdo_risk` → `G1`（只认 `go`；高风险必须有缓解与责任人） |
| **需求** | "捕获需求 / 继续问我" | `capture`（八维评分）→ `grill`（≤4 问，带选项与代价）→ `answer`（可 `assume` 记假设）→ 红队 `attack`/`propose`+`file` → `baseline` → `G2` |
| **架构** | "开始架构设计" | 先**计划评审**（SDO 主动进 plan mode；通过后由 `exit_plan_mode` 结束）→ `sdo_design action=create`（五视图）→ `contract`（超时/重试/幂等）→ `sdo_adr`（必须含**被否决的备选**与后果）→ `sdo_quality`（可测度量 + ATAM-lite）→ `sdo_trace` → `G3` |
| **详细设计与计划** | "拆任务" | `sdo_plan action=decompose`（结构通道按追溯图 + 模型通道吃建议；**每元素一张卡**；六条机械校验：单角色/DoD/无环/规模/写范围互斥/证据要求）→ `G4` |
| **开发** | "下一步做什么" | `sdo_plan action=next`（按容量预算挑卡 + 派发请求）→ `sdo_task action=claim`（CAS，版本对不上即冲突）→ 一次派发运行 = 一个角色 → `sdo_task action=done`（**必须带证据**） |
| **验证** | "记录测试与缺陷" | `sdo_test action=plan`（用例绑定需求）→ `action=record`（通过也要证据）→ `action=defect`（阻塞级缺陷会拦住门禁）→ `sdo_review`（作者≠评审者）→ `G6` |
| **交付** | "打交付包" | `sdo_deliver action=package`（产物 sha256 清单 + 验收矩阵 + 回滚点 + 声明不含原型内容）→ `G7`。**发布与运维不做** |

**卡住时怎么办**：

```text
sdo_gate action=check gate=架构门禁      # 逐条列出缺口与补救（中文名或 G3 都能传）
sdo_gate action=waive  gate=G3 reason=…  # 确有正当理由 → 显式豁免并留痕（不静默跳过）
sdo_gate action=advance                  # 当前阶段出口门禁全绿后推进阶段
/sdo-board --expand                      # 文本看板：需求/卡/门禁/成本一屏
```

**常见中途调整**：需求变了走 `sdo_requirement action=change`（影响分析 + 决策）；卡建错了 `sdo_task action=drop`（留痕，不再计入完成率）；契约写错了 `sdo_design action=contract id=CT-00x`（原地更新）或 `action=drop-contract`（作废留痕）。

## 命令与工具速查

### 斜杠命令（交互式会话，不进模型）

| 命令 | 用途 |
|---|---|
| `/sdo-init` | 初始化项目：`--name=… [--process=waterfall\|prototype\|agile\|spiral] [--scale=trivial\|normal\|critical] [--stakeholders=…]` |
| `/sdo-status` | 阶段、门禁缺口、需求与问题计数；`--rebuild` 从 journal 重建投影 |
| `/sdo-board` | 文本看板；`--expand` 明细、`--all` 不受保留窗口限制、`--write` 落盘 `docs/BOARD.md` |
| `/sdo-list` | 需求清单（ID/优先级/状态/歧义评分/未决问题数） |
| `/sdo-grill` | 生成下一批审讯问题（≤4，带选项与代价）；`--id=REQ-001`、`--quick` |
| `/sdo-answer` | 回答问题：`--id=Q-0001 --answer="…" [--option=0]`；不知道时 `--assume`（记为假设） |
| `/sdo-redteam` | `--attack` 生成质询；`--off`/`--on` 切换本会话红队（留痕） |
| `/sdo-gate` | `--gate=G0` 判定留痕；`--waive --gate=G2 --reason=… --approver=…` 显式豁免 |
| `/sdo-next` | 推进到下一阶段（出口门禁须已通过/豁免） |
| `/sdo-budget` | `--show`｜`--set total=100 [currency=CNY] [tiers=50,80,100]`｜`--decide choice=add-budget\|waive\|narrow-scope`（**不会自动停**） |
| `/sdo-render` | 把真源渲染成文档：`--target=srs` → `docs/SRS.md` |
| `/sdo-lang` | 查看/切换界面语言：`/sdo-lang en`（详见「界面语言」） |

### 模型工具（20 个，聊天里让模型调用即可）

| 分组 | 工具 |
|---|---|
| 项目与状态 | `sdo_init`、`sdo_status`、`sdo_project`、`sdo_lang` |
| 需求 | `sdo_requirement`（capture/grill/answer/update/change/list/baseline）、`sdo_redteam` |
| 可行性 / 风险 | `sdo_feasibility`、`sdo_risk` |
| 架构 | `sdo_design`（create/contract/view/review/waive-plan/**drop-contract**）、`sdo_adr`、`sdo_quality` |
| 计划与协同 | `sdo_plan`（decompose/iteration/next）、`sdo_task`（claim/done/block/drop/release/reassign/list） |
| 验证与评审 | `sdo_test`（plan/record/defect）、`sdo_review` |
| 追溯与文档 | `sdo_trace`、`sdo_render` |
| 门禁与成本 | `sdo_gate`（check/advance/waive）、`sdo_cost` |
| 交付 | `sdo_deliver`（package） |

## 配置

全部配置写在 **preset 行的 `config`** 里（见 `presets/sdo-office.patch.yml`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `lang` | `zh-CN` | 界面语言：`zh-CN`（基准，永远完整）/ `en`；未知语言回落基准 |
| `projectDir` | `.sdo` | 项目台账目录（相对会话工作目录） |
| `injectStatus` | `true` | 是否每轮注入 `<SDO 状态>` 背景块（≤1500 字符） |
| `statusChars` | `1500` | 状态块上限；超出截断并提示用 `sdo_status` 看全量 |
| `gateLevel` | `enforce` | `suggest` 只提示 / `enforce` 门禁前置 / `strict` 追加拦截写类工具 |
| `commandEcho` | `echo` | 命令结果如何让用户看见：`echo` 经 inbox 投递（不唤醒轮次）/ `none` 只回命令面 |
| `orchestrator` | `subagent` | 派发后端：`subagent` / `native-team`（实验）/ `inline` |
| `maxParallelDispatch` | `4` | 并行派发上限（自我容量预算） |
| `captureWorkspaceChanges` | `true` | 采集 `workspace/changes` 证据 |
| `cost` | 见下 | 成本监视与预算 |

### 界面语言

```yaml
- id: sdo
  config:
    lang: en        # 默认 zh-CN
```

三条切换路径（都有判别性测试守着）：

```text
① 聊天里说「切换成英文」         → 模型调 sdo_lang（立即生效，进程内）
② /sdo-lang en                  → 斜杠命令（立即生效）
③ config.lang 或 SDO_LANG=en    → 持久（重启后仍生效；env 优先于配置）
```

规则：**`zh-CN` 是基准语言，永远完整**；目标语言**逐键覆盖**它、缺键**回落中文**（因此可以渐进补译，绝不出现空白或键名）；未知语言一律回落基准语言。标识（`G0`/`REQ-001`/`in-progress`）**不翻译** —— 它们进出 journal、命令参数与追溯图。

### 成本与预算（只监视，不硬停）

```text
sdo_cost action=report                              # 只报 token（没填单价就不猜金额）
/sdo-budget --set total=100 currency=CNY tiers=50,80,100
```

金额一律标注「估算」；超预算**不会中断**，按档位（默认 50/80/100%）**每档只问一次**，你选追加 / 豁免 / 收敛范围，决策写进 `budget/decision`，**开发继续**。

## 设计要点（为什么这么做）

- **流程即数据**：`src/data/processes/*.yml` 定义 4 个流程（瀑布 / 快速原型 / 敏捷 / 螺旋）的阶段与门禁（含 `GP` 原型验收、`GI` 迭代 DoD、`GR` 风险象限）。
- **门禁即判据**：每条准则都有实现与正向不变量测试；判定结果写进 `.sdo/gates/<id>.json` 与 journal 留痕。
- **单一真源**：`journal.jsonl` 追加式；`project.json`/看板/报告都是派生投影（可重建）。**显式放弃（dropped）不参与门禁判据** —— 放弃越多不该越难过门禁。
- **确定性引擎**：插件不调用模型；模型产出的红队质询必须**引用需求原文用词**、以问号结尾、不重复，才被接受。
- **角色是一次运行**：8 张角色卡（`skills/role-*.md`）+ `src/data/roles.yml` 的 `allow`/`deny` 掩码在派发时作为 `toolFilter` 施加 —— 角色**看不到**越界工具（`analyst` 不得自跑红队、`developer` 不可见评审、`tester` 无编辑工具）。

## 已知边界（诚实清单）

| 边界 | 说明 |
|---|---|
| 派发宿主调用未接线 | `sdo_plan action=next` 会选后端、生成带 CAS 版本的派发请求并留痕；宿主 `SubagentRuntime.start` 的**真实调用尚未接线**（起一次模型运行需要凭据）。当前由流程官用 `send_message` 转交，或按 `inline` 就地执行 |
| 子代理用量未归集 | `sdo_cost` 只统计驾驶舱会话；子代理会话对象未暴露给插件，回执里**明确说明**而不是编数 |
| Web 面板未做 | 文本看板（`/sdo-board`）可用；Web 面板（client 插件）尚未实现 |
| L3 纪律守卫未实测 | 策略与钩子已就位（fail-open，仅 `gateLevel: strict` 时拦）；deny 分支在本环境**未做实测** |
| 命令结果渲染 | Web 客户端不渲染"轮次之外"的命令节点（上游问题，见 `docs/verification/2026-09-29-上游问题-命令结果不渲染.md`）。SDO 用 `commandEcho: echo` 经 `agent.inbox.send(..., wakeup=false)` 投递成**插件来源**消息：界面可见、不唤醒轮次 |
| 发布/运维 | 明确非目标：到「交付包 + 验收矩阵 + 回滚点」为止 |

## 开发与发布

```bash
npm run build          # tsc → lib/
npm run typecheck      # 只做类型检查
npm test               # build + node --test lib/test/
npm run pack:offline   # 产出离线安装包 → dist/offline/
```

### 流水线（GitHub Actions，只用官方 action）

| 文件 | 触发 | 做什么 |
|---|---|---|
| `.github/workflows/ci.yml` | push（各分支）/ PR / 手动 | 矩阵 **ubuntu + windows × node 20/22**：`npm ci`（或回退 `npm install`）→ `typecheck` → `test` |
| `.github/workflows/release.yml` | tag `v*` / 手动 | 两 OS 各跑测试并 `pack:offline` → artifact → `gh release create` 发布离线包与 `SHA256SUMS`（已存在则 `--clobber`） |

发布流程：

```bash
git tag -a v0.1.1 -m "SDO v0.1.1" && git push origin v0.1.1
```

### 离线安装包

`npm run pack:offline` 产出 `dist/offline/`：

| 产物 | 说明 |
|---|---|
| `dsh-software-dev-office-<版本>-offline.tar.gz` | Linux/macOS；Win10+ 自带 `tar` 也可解 |
| `dsh-software-dev-office-<版本>-offline.zip` | Windows 可直接右键解压（**ZIP 由脚本自写**，不依赖外部 `zip`） |
| `SHA256SUMS` | 校验上面两个归档 |

包内：`tarballs/`（插件 + **运行时依赖闭包**）、`npm-cache/`（构建期预填，装机器离线用）、`install.mjs` + `install.sh`/`install.ps1`、`manifest.json`、`README-offline.md`。

**三条硬规矩（都是真机教训）**：
1. **只打包 `dependencies` 的传递闭包，排除 `peerDependencies`** —— 把 `@deepseek-ai/*`（尤其 `cordis`）也打进离线包会产生**第二份服务注册表**，服务查找会静默错乱。
2. **peer 用链接、绝不用拷贝** —— 安装器把宿主 store 里的实例软链进 profile（实测安装处与宿主处 realpath 完全相同）。
3. **不在 profile 里直接 `npm install`** —— npm 会 reify 整棵树、连别人的 `file:` 依赖也想动 ✗。改为临时前缀装好再合并，卸载按安装记录**精确回收**。

### CI 怎么装依赖

标准做法：仓库提交 `package-lock.json`，CI 用 **`npm ci`**（`setup-node` 开 `cache: npm`）。

```bash
npm ci            # CI 与本地一致：按锁文件装，含 devDependencies
```

> **历史（值得留档）**：这里一度用"`vendor/` 离线依赖闭包 + 自写安装器"绕过 `npm ci`，
> 理由是"官方 `@deepseek-ai/*` 可能不在公开源上、且没有锁文件"。后来实测发现**两个前提都不成立**
> （registry 探测：`@deepseek-ai/dsh-plan-mode`、`cordis`、`typescript@7.0.2` 等全部在公开源上；
> 而"本机无网"更是误判 —— 真正的报错是 npm 写不了 `~/.npm` 的 `EROFS`）。
> 因此那套机制已删除，改回标准做法；**离线包产线（`pack:offline`）不受影响**，它本来就是给装机器用的。

---

## 协议与作者

MIT License © 2026 [raitpor](https://github.com/raitpor) —— 见 [LICENSE](LICENSE)。

变更历史：见 [CHANGELOG.md](CHANGELOG.md)（首个公开发布为 **0.1.1**）。
