## M11 · 写路径工具化与评审视角矩阵

状态：已签（S60）

**开工前提**：M10 门已签 **S59**（overall partial）。M10 收口后本里程碑接管“让 agent 少犯错”的两条主线：**结构性真源只经脚本写**（M11-0/M11-1/M11-5）与**评审要有视角、门禁判据要显式声明**（M11-2/M11-3/M11-4）。

本里程碑回答两个问题：①“agent 改真源时，能不能不手抠结构、只调命令？”②“评审除了‘谁审’，有没有‘看什么’；以及门禁与判据能不能由里程碑显式声明而不是隐式默认？”

背景（M10 实测）：冷启动的 8 类卡点**全部**落在“结构性字段需要手抄模板”的地方（计划索引行、探底行、认领行、阶段序列、冻结 `hash:` 行、门表占位、签文件锚点、读数骨架）。同时，M10 的全局评审证明单靠“非作者”这一维抓不到文档断头路与集成缝。**用户 2026-11-23 裁定**：门禁与判据**必须显式声明**，缺声明要**报错**，不许“不声明就走默认集”（否则简单事被迫走重流程、复杂事可能随便过）。

### M11.0 认领需求

需求：无（M10 仍活跃并认领 R-01、R-02、R-03；本里程碑是流程内部改进，不新增需求。）

**边界：本里程碑期间不归档 M10**。孤儿需求判定读**卡的 `references`**（不是里程碑认领行），M11 六卡只写 `[R-02]`；一旦归档 M10，`--trace` 会立刻报 R-01/R-03 孤儿（2 条）。M11-G 门签前必须复核 `--trace` exit 0。

### M11.1 里程碑与判死读数

探底：
- 探底 R49：在 `/tmp` 空项目按“禁手写结构性字段”任务书走一遍，记录哪些步骤**现在没有命令可用**（预期命中：里程碑骨架、冻结 hash 行、计划索引行、门表、签文件、读数）
- 探底 R50：对现有脚本逐个试幂等（`init` 二次跑、`archive` 二次跑、`ledger add` 同内容），记录哪些会重复写/覆盖
- 探底 R51：手造三类“手写嫌疑”（`.sdo/` 结构性字段里留 `<...>` 占位、未知阶段 id、缺 `hash:` 行），记录当前 `check` 是否能点名；同时统计 `skills/**` 里本就存在的 `<...>` 示例数（用于确定扫描面）
- 探底 R52：`grep -c '视角' .sdo/cards/*.md`，记录现有卡面是否写视角；再看一次门表是否覆盖评审维度
- 探底 R53：列出 `references/02` 里的**规范池**（门 id 列表：现为 `G_req_design`、`G_build_exit`、`G_verify_exit`、`G_integrate`；判据 id 白名单），并实测“冻结段缺 `门禁：`/`判据：`”当前的静默行为（是否默认放行）
- 探底 R54：跑 `--plan` M1–M10、`--trace`、`--presets`、`gate --file .sdo/gates/M10.md`，记录基线

| 读数 | 问题 | 怎么量 | 达标线 |
|---|---|---|---|
| R49 | 结构性真源能不能只靠命令写？ | `/tmp` 空项目 + 禁手写任务书（`.sdo/notes/M11-冷启动任务书.md`）：从 `init` 到 `draft` 全程只用命令；记录每次“不得不手改”的点与文件:行 | 手改结构性字段次数 = 0、卡点 = 0；**若某步确实无命令可用 ⇒ R49 至多 partial**（点名缺口并开后续卡，不许事后补一句“其实可以手写”） |
| R50 | 新命令是否可用且幂等？ | 八条命令各跑两次（`milestone new/freeze`、`baseline init`、`sign new`、`gate init`、`readings init`，加 `init`/`archive` 对照）；第二次执行后 `git diff` 应为空 | 每命令 1 正例产物断言 + 1 反例（缺参 exit 2）+ 1 幂等断言；第二次执行工作树无意外改动 |
| R51 | 手写嫌疑能不能被机检点名？ | 扫描面**只限 `.sdo/` 结构性字段**：计划索引表、里程碑的 `状态/认领需求/探底/门禁/判据/hash:` 行、`readings` 的 `overall`、`gates` 表头；**排除** `skills/**` 与 `.sdo/{cards,notes,review}/**`（这些文件里的 `<...>` 是示例，不是漏填）。手造三类嫌疑各一次 | 三类各报独立错误码（`structural_placeholder_left`、`phase_unknown`、`frozen_hash_missing`），正常树 0 误报 |
| R52 | 评审视角矩阵是否落地？ | ①卡模板含 `- 视角：` 行且 `card.mjs new` 产物带该行；②门表含「评审覆盖」判据；③`.sdo/notes/<M>-黑盒任务书.md` 由模板生成；④本里程碑至少 1 次真实黑盒评审记录 | ①–③结构齐；④有一次记录（含卡点与结论）；黑盒**不得**替代白盒（写进归因原则） |
| R53 | 门禁与判据能不能成为唯一真源并被机检？ | 冻结段**只**写 `门禁：`（有序 gate 列表）与 `判据：`（判据列表）。校验：①缺任一行 ⇒ `gate_criteria_undeclared`（**报错，不 fallback 任何默认集合**）；②声明的 gate ∈ 已知门集合；③声明判据 ∈ 判据池（白名单）；④**不再存在 `preset：` 字段**：preset 降级为“参考模板”，只用于抄写，不参与任何判定；⑤声明行在冻结段内 ⇒ 改它必须追加签 | 五条全成立；缺声明报错；池外判据 ⇒ `criterion_not_whitelisted`；未知门 ⇒ `gate_unknown`；真源里出现 `preset：` 字段 ⇒ `preset_field_removed`；门表缺声明判据 ⇒ `missing_declared_criterion` |
| R54 | 本里程碑改动是否让旧里程碑退化？ | `--plan` M1–M10（归档的应打印“已归档”）、`--trace`、`--presets`、`gate --file .sdo/gates/M10.md` 全跑一遍 | 全部 exit 0（M1–M9 归档跳过）；`check` 0 错 0 警；不改任何已签里程碑正文 |

### M11.2 卡表

| 卡 | 内容 | 依赖 | 写域 |
|---|---|---|---|
| M11-0 | **骨架类命令**：`milestone.mjs new/freeze`、`baseline.mjs init`；`new` 硬编码生成六段含 `门禁：`/`判据：` 两行（不接 `--preset`、不读模板）；幂等、缺参 exit 2、写前打印将写文件；**并把两条命令的正确用法写进 SKILL 步 2/3**（否则 agent 不知道有新命令） | — | `skills/sdo-flow/scripts/`、`skills/sdo-flow/SKILL.md`、`.sdo/cards/M11-0.md` |
| M11-1 | **手写嫌疑机检**：`check` 新增 `structural_placeholder_left`/`phase_unknown`/`frozen_hash_missing`，扫描面限定 `.sdo/` 结构性字段 | M11-0 | `skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/SKILL.md`、`.sdo/cards/M11-1.md` |
| M11-2 | **评审视角矩阵**：卡模板 `- 视角：`、`references/03` 矩阵与固定问题、门表「评审覆盖」判据、黑盒任务书模板 | M11-1 | `skills/sdo-flow/scripts/card.mjs`、`skills/sdo-flow/templates/card.md`、`skills/sdo-flow/templates/blackbox-task.md`、`skills/sdo-flow/references/03-签字与评审.md`、`skills/sdo-flow/SKILL.md`、`.sdo/notes/M11-黑盒记录.md`、`.sdo/cards/M11-2.md` |
| M11-3 | **门禁与判据是唯一真源**：冻结段只写 `门禁：`/`判据：`（缺 ⇒ `gate_criteria_undeclared`，不 fallback）；`preset：` 字段对新签里程碑报 `preset_field_removed`；`--presets` 降级为参考快照（只 WARN）；`gate.mjs` 消费声明并报 `missing_declared_criterion`；规范池写进 `references/02` | M11-1 | `skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/scripts/gate.mjs`、`skills/sdo-flow/references/02-判据与门禁.md`、`skills/sdo-flow/templates/milestone.md`、`.sdo/cards/M11-3.md` |
| M11-5 | **冷启动复跑（禁手写）**：无上下文席位只用命令从 0 走到 `draft`，记录手改次数与卡点 | M11-0、M11-4、M11-2、M11-3 | `.sdo/notes/M11-冷启动任务书.md`、`.sdo/notes/M11-冷启动记录.md`、`.sdo/cards/M11-5.md` |
| M11-4 | **签/门/读数类命令**：`sign new`、`gate init`、`readings init`；幂等、缺参 exit 2、写前打印将写文件 | M11-0 | `skills/sdo-flow/scripts/`、`skills/sdo-flow/templates/`、`.sdo/cards/M11-4.md` |
| M11-8 | **冷启动第三轮缺口**（M11-7 后 手改 0 / 卡点 1）：①`declare --map` 自动把 core 三条并入每个被映射的门（`gate.mjs` 要求每门必备，此前只能靠红字反推）；②草案签下 `check --plan` 给 `plan_sign_unsigned` WARN（“0 漂移”不等于人签）；③`sign.mjs draft` 的 git 根只认项目根本身，否则 `NO_GIT`（不借外层仓库 HEAD）；④SKILL/refs02 写清两处 `--force` 的用途与不覆盖范围；⑤第三轮记录入库 | M11-7 | `skills/sdo-flow/scripts/milestone.mjs`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/scripts/sign.mjs`、`skills/sdo-flow/scripts/lib/paths.mjs`、`skills/sdo-flow/scripts/lib/verdict.mjs`、`skills/sdo-flow/SKILL.md`、`skills/sdo-flow/references/02-判据与门禁.md`、`.sdo/notes/M11-冷启动记录-3.md`、`.sdo/cards/M11-8.md`、`.sdo/cards/M11-7.md`（仅补缺失的「## 临时决策」小节，内容 `- 无`，不改判定/证据/收口；签后补记见台账 D-252） |
| M11-9 | **历史签豁免**（M11-G 读数前 R54 发现 `--plan M10` 报 2 漂移）：①`check` 读冻结段的 `- 声明豁免：M1…M10`（显式声明，不写死代码），列表内缺 `门禁：`/`判据：` 降 WARN、列表外仍 ERROR；②豁免行参与 hash、格式校验（禁 `*`）；③补 M11-8 卡缺的 `## 临时决策`（trace 红）；④新里程碑缺声明仍红 | M11-8 | `skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/templates/milestone.md`、`skills/sdo-flow/SKILL.md`、`skills/sdo-flow/references/02-判据与门禁.md`、`.sdo/cards/M11-8.md`、`.sdo/cards/M11-9.md` |
| M11-10 | **冷启动第四轮缺口**（M11-9 后复跑 手改 0 / 卡点 2）：①`declare --list` 的判据池与 `check` 白名单**同源**（抽 `lib/criteria-pool.mjs`，现状混入 `check.mjs`/`gate.mjs`/`sign.mjs`，抄“合法名单”反被 `criterion_not_whitelisted` 拒）；②任务书/SKILL 明写项目根须先 `git init` + 首次 commit；③`card.mjs evidence` 命令放代码块，不再把 `\|` 转义塞进表格（旧证据不可原样复跑）；④`--list` 与 `declare` 口径一致 | M11-9 | `skills/sdo-flow/scripts/milestone.mjs`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/scripts/card.mjs`、`skills/sdo-flow/scripts/lib/criteria-pool.mjs`、`skills/sdo-flow/SKILL.md`、`.sdo/notes/M11-冷启动任务书.md`、`.sdo/notes/M11-冷启动记录-4.md`、`.sdo/cards/M11-10.md` |
| M11-11 | **无 git 环境下的被签对象**（用户 2026-11-24 裁定：“没法保证用户机器上有 git，skill 也没法要求必须有 git”）：①被签对象两种形态 `git:<sha>` / `tree:<指纹>`，无 git 时签字与 `draft` 仍可用；②指纹单源 `skills/sdo-flow/scripts/lib/fingerprint.mjs`（纯 Node、零依赖、排除 `.git/`/`node_modules/`/`.tmp/`/`.work/`/`.sdo/.index/`）；③锚点两态分派 `SAME`/`DIFF`/`NO_ANCHOR`（git 形态保留 `AHEAD`/`BEHIND`）；④SKILL/任务书/refs03 把 git 改为可选 | M11-10 | `skills/sdo-flow/scripts/sign.mjs`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/scripts/lib/fingerprint.mjs`、`skills/sdo-flow/SKILL.md`、`skills/sdo-flow/references/03-签字与评审.md`、`.sdo/notes/M11-冷启动任务书.md`、`.sdo/notes/M11-冷启动记录-5.md`、`.sdo/cards/M11-11.md` |
| M11-12 | **黑盒三席位暴露的口径不一致**（第 2/3 独立席位冷启动实测，手改均 0）：①`init.mjs` 生成的 `.sdo/意图.md` §12 与 `templates/意图.md` 同名节内容不同；②`view.mjs next` 把「判定：待填」的签显示成「已签」；③门→判据映射缺文档：`declare --list` 给出 15 门/41 判据池，但门表漏判据只报“没有判定”，agent 看不到自己漏了哪条；④`gate.mjs init` 产「判定：待判」，而 `gate --file` 只收 pass/partial/fail，没有命令或文档说怎么补；⑤`sign.mjs draft` 隐含要求 `--write-scope` 命中的文件已入库、且签前必须先 commit（否则 `TREE_MISMATCH`），只写在 SKILL 括号里；⑥在 `sdo-flow/scripts/` 下跑 `init.mjs`/`baseline.mjs init` 会建出嵌套 `.sdo/`，无拒绝；⑦`templates/card.md` 卡面 12 节而 `card.mjs new` 只生成 6 节（含 `认领需求：` 与 `需求：无（…）` 两种占位），文档与产物不一致；⑧`sign.mjs new --force` 重写同一份签时把标题写成下一号 `S2`，与文件自身编号不一致 | M11-11 | `skills/sdo-flow/scripts/init.mjs`、`skills/sdo-flow/scripts/baseline.mjs`、`skills/sdo-flow/scripts/view.mjs`、`skills/sdo-flow/scripts/card.mjs`、`skills/sdo-flow/scripts/gate.mjs`、`skills/sdo-flow/scripts/lib/trace.mjs`、`skills/sdo-flow/scripts/sign.mjs`、`skills/sdo-flow/scripts/lib/verdict.mjs`、`skills/sdo-flow/SKILL.md`、`skills/sdo-flow/references/02-判据与门禁.md`、`skills/sdo-flow/references/03-签字与评审.md`、`skills/sdo-flow/templates/意图.md`、`skills/sdo-flow/templates/card.md`、`.sdo/notes/M11-冷启动任务书.md`、`.sdo/notes/M11-黑盒记录-2.md`、`.sdo/notes/M11-黑盒记录-3.md`、`.sdo/cards/M11-12.md` |
| M11-G | 读数门（R49–R54 + 出口表 + 使用笔记） | M11-0…M11-5、M11-11、M11-12 | `skills/sdo-flow/scripts/gate.mjs`（仅修模板串里的 `\b` 转义，D-261）、`skills/sdo-flow/scripts/check.mjs`（仅把卡级追加签排除出冻结 hash 链条，D-262）、`.sdo/readings/M11.md`、`.sdo/gates/M11.md`、`.sdo/notes/M11-使用笔记.md`、`.sdo/计划.md`、`.sdo/milestones/M11.md`（只改状态行）、`.sdo/cards/M11-G.md` |
| M11-6 | **冷启动缺口补齐**（M11-5 实测手改 5 / 卡点 11 后追加）：①`card.mjs new --write-scope --depends`（卡面写域与依赖由命令写）；②`milestone.mjs new` 写计划索引行（无 preset 列，不再造假绿）；③`milestone.mjs declare --gates --criteria --map`（门禁/判据/映射由命令渲染，内容仍由人/agent 决定）；④`check` 跳过 gitignored 目录（`.tmp/` 被扫导致读数 184→210）；⑤文档四条（映射是必写不是可选、draft 锚点四态词表、`index_stale` 报错给命令、`check --plan` 不校验「判定：待填」写为已知边界） | M11-0、M11-4、M11-5 | `skills/sdo-flow/scripts/card.mjs`、`skills/sdo-flow/scripts/milestone.mjs`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/templates/milestone.md`、`skills/sdo-flow/references/02-判据与门禁.md`、`skills/sdo-flow/SKILL.md`、`.sdo/notes/M11-冷启动记录.md`、`.sdo/cards/M11-6.md` |
| M11-7 | **冷启动第二轮缺口**（M11-6 后复跑 手改 0 / 卡点 4）：①合法门/判据清单命令（`declare --list`）；②`sign.mjs new --force`（只允许覆盖**未人签**的草案，已接受/已拒绝 ⇒ `sign_already_signed`）；③`gate.mjs init --force`（覆盖前打印「将覆盖：」）；④SKILL 补「未签阶段 gate 预期红码」清单；⑤修冷启动任务书两处错误（意图模板文件名、`card.mjs new` 签名）；⑥`check` 的 `skillDirs()` 也跳过 `.tmp`/`.work`（否则 `.tmp` 里放一份 skill 副本会把它的文档算进读数：实测 188→216） | M11-6 | `skills/sdo-flow/scripts/milestone.mjs`、`skills/sdo-flow/scripts/sign.mjs`、`skills/sdo-flow/scripts/gate.mjs`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/SKILL.md`、`.sdo/notes/M11-冷启动任务书.md`、`.sdo/notes/M11-冷启动记录-2.md`、`.sdo/cards/M11-7.md` |

### M11.3 共享写域

| 文件/目录 | 允许改的卡 | 说明 |
|---|---|---|
| `.sdo/台账.md` | 全部 | 只追加 |
| `.sdo/计划.md` | M11-G | 只改本里程碑行与状态 |
| `skills/sdo-flow/scripts/check.mjs` | M11-1、M11-3、M11-6 | M11-6 只加“跳过 gitignored 目录”一行与边界文档 |
| `skills/sdo-flow/scripts/gate.mjs` | M11-3 | 只加声明校验，不改既有判定 |
| `skills/sdo-flow/SKILL.md` | M11-0、M11-1、M11-2、M11-6 | M11-0 只写步 2/3 的新命令用法（两处，先做）；M11-1/M11-2 写判据入口；串行 |
| `skills/sdo-flow/references/` | M11-2、M11-3 | 各自一篇，不改对方 |
| `skills/sdo-flow/templates/` | M11-0、M11-2、M11-5 | 各建自己模板，不改对方 |
| `.sdo/gates/M11.md`、`.sdo/readings/M11.md` | M11-G | 命令验证一律在 `/tmp` 副本，不写本仓结构 |
| `.sdo/notes/` | M11-2、M11-5、M11-6、M11-7、M11-8 | 黑盒记录 / 冷启动任务书与记录，各写各的文件 |
| `.sdo/milestones/M11.md` | M11-G | 只改状态行；正文与冻结段改动须追加签 |
| `skills/sdo-flow/scripts/gate.mjs` | M11-G | 只许修模板串里的 `\b`→`\\b` 一处（D-261），不改既有判定（追加签 S60-I） |
| `skills/sdo-flow/scripts/check.mjs` | M11-G | 只许把“卡级追加签”排除出冻结 hash 链条（追加签 S60-J）；不改既有判定 |

### M11.4 阶段

<!-- 目标状态（M11-3 之后）：真源只有冻结段里的 `门禁：` 与 `判据：` 两行，`preset：` 字段不再是真源字段；
     preset 降级为“参考模板”，只用于抄写。当前保留该字段；M11-3 落地后本文件里的这行**保留为历史记录**（不删），删除需追加签。 -->
preset：incremental
preset 选择理由：三项改进（工具化、视角矩阵、声明式门禁判据）方案已定死，属结构性修补，不需要原型探索；本行保留为历史记录；新增/删除该字段须追加签。

阶段序列：`req_design`→`build`→`verify`→`integrate`

### M11.5 冻结段

- 被签对象：待签时填
- 冻结判据：`check --plan --milestone M11` 0 漂移；`.sdo/review/M11-计划.md` 存在且最后一轮判“可签”
- 门禁：G_req_design → G_build_exit → G_verify_exit → G_integrate
- 声明豁免：M1、M2、M3、M4、M5、M6、M7、M8、M9、M10
- 判据：spec_set.signed、assumption_set.signed、provenance.present、requirement.claimed_or_na、trace.card_coverage、trace.requirement_covered、trace.test_linked、review.independent、readings.recorded、gate.signed
- 基线 hash：466254142e885934b4a6d545c2fedc5ec04ec659c0ae09bb1248f0dbd48188f4
- 追加签：S60-A
- 追加签：S60-B
- 追加签：S60-C
- 追加签：S60-D
- 追加签：S60-E
- 追加签：S68-A
- 追加签：S60-F
- 追加签：S60-G
- 追加签：S60-H
- 追加签：S60-I
- 追加签：S60-J
- 追加签：S60-K
- 追加签：S60-L
- 追加签：S60-M

### M11.6 已知边界

- 声明的判据只验“在池内（`references/02` 白名单）”，**不保证选得合适**；选型由计划评审与人签负责。
- `--trace` 的覆盖判定仍依赖卡的 `references`，与里程碑认领行无关（M11 期间不归档 M10 即无孤儿）。
- 八条新命令的验证一律在 `/tmp` 副本完成；本仓 `.sdo` 结构只由 M11-G 更新状态行。
- 黑盒评审不替代白盒：两者盲区互补，不能互相折算或省略。
- **preset 不是真源**：真源只有 `门禁：`/`判据：`；preset 仅作抄写参考。已签里程碑里的 `preset：` 字段**保留为历史记录**（含本文件这行），check 对“已签里程碑”只做兼容读取、不据此判定；对**新签**里程碑出现该字段才报 `preset_field_removed`。
hash:7801011b40523f964a84727c1871de681e9b7ff47267906bde49f2b574f4b80c
