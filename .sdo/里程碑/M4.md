## M4 · 用起来的手感（脚本化的五件事）

> 来历：用户 2026-11-19 17:05「你在使用这个 skill 中发现有什么不方便的可以报给我，然后讨论如何改善」，并在选项里勾了 A/B/C/D/E 五项；本条只做脚本与模板，不改流程规则本身。
> 计划评审第 1 轮（`reviewer-3`）：1 P0 + 4 P1 + 4 P2 —— 已按判词改：`close` 改追加式、`draft` 只出事实材料、R17/R18 写死夹具与期望文本、文档写域补 `SKILL.md`/`README.md`、五卡写域落到单文件、依赖边按真实耦合重排。

### M4.1 里程碑与判死读数

| 读数 | 问题 | 怎么量 | 达标线 |
|---|---|---|---|
| R14 | `ledger.mjs` 能否把“追加一行台账/关闭一行”变成不会错列的动作，且不破坏 append-only？ | 在 `/tmp` 副本跑 `node <skill>/scripts/ledger.mjs add --kind defect --where x --what y --impact z --fix w`；再 `node <skill>/scripts/ledger.mjs close D-1 --fix "已修"`；两次都 `git diff -- .sdo/台账.md` | ①追加后 `check.mjs` 0 错；②D 编号自增、列数=7、表内无空行；③`close` **只追加一行**（kind 固定 `explain`，语义=关闭记录；status=fixed、处置写「关闭 D-1」），旧行字节不变，`git diff` 只有 `+` 行；④不改旧行状态 |
| R15 | `card.mjs` 能否生成合规卡骨架并把证据行落到正确表格？ | `node <skill>/scripts/card.mjs new M9-0 --owner lead --intent "x" --criteria "C1:y"`；`node <skill>/scripts/card.mjs evidence M9-0 --criterion C1 --cmd "node --test" --run`（`--run` 真跑命令并记 stdout 末行；不给 `--run` 则结果写「未跑待复跑」） | ①生成后 `check.mjs` 0 错（四段 + `status/owner`）；②证据行落在「## 证据」表、首格 `C1`；③不给 `--run` 时结果不能写 `pass`（脚本拒绝 `--result pass`）；④`--run` 失败 ⇒ 记 `fail` 且退出码 1 |
| R16 | `sign.mjs draft` 能否把“签字前该核对的事实”摊出来，而**不代写判定**？ | `node <skill>/scripts/sign.mjs draft --milestone M4` | ①输出只含事实：`文件:行`、可复跑命令、HEAD/`git rev-parse`、`git status --porcelain` 是否为空；②**不出现**「我认为/建议签/判定 pass」这类句子（脚本模板里就没有这句）；③工作树脏 ⇒ 输出顶部标 `DIRTY` 且退出码 1；④不写任何签字文件 |
| R17 | `view.mjs next` 能否回答“现在能开工什么、还缺什么”？ | 在 `/tmp` 夹具（一张 `open` 卡依赖未 done、一份读数缺 overall、一条 open 台账、一份卡 done 但无签收）跑 `node <skill>/scripts/view.mjs next` | 输出**五个小节**：可开工卡 / 被依赖卡住 / 待签收（卡 done 无 sign）/ 待签文件（计划/门）/ 未修台账；五项缺一即 exit 1；每项为空写「无」而不是省略 |
| R18 | `check.mjs --plan` 能否发现计划与卡面漂移？ | `cp -a` 本仓库到 `/tmp/pl`；①删掉 `.sdo/cards/M4-0.md` 的 `write_scope` 中 `templates/台账.md`；②把某卡判据点名的 `skills/sdo-flow/scripts/ledger.mjs` 改到 `.sdo/readings/x.md`；两次 `node <skill>/scripts/check.mjs --plan` | ①两次各 exit 1；②消息形如 `ERROR .sdo/cards/M4-0.md:<行>: 判据点名的路径不在 write_scope：…`（②的变异**固定用 M4-0**，`文件:行` 格式固定）；③恢复后 exit 0 |

### M4.2 卡表

| 卡 | 内容 | 依赖 | 写域 |
|---|---|---|---|
| M4-0 | `scripts/ledger.mjs`（add/close/list）+ `templates/台账.md` 注释 + §11 一行 | M3-G | `skills/sdo-flow/scripts/ledger.mjs`、`skills/sdo-flow/templates/台账.md`、`skills/sdo-flow/SKILL.md`（§11）、`README.md` |
| M4-1 | `scripts/card.mjs`（new/evidence）+ `templates/card.md` + §11 一行 | M4-0 | `skills/sdo-flow/scripts/card.mjs`、`skills/sdo-flow/templates/card.md`、`skills/sdo-flow/SKILL.md`（§11）、`README.md` |
| M4-2 | `scripts/sign.mjs`（draft）+ `templates/sign.md` + §11 一行 | M4-1 | `skills/sdo-flow/scripts/sign.mjs`、`skills/sdo-flow/templates/sign.md`、`skills/sdo-flow/SKILL.md`（§11）、`README.md` |
| M4-3 | `view.mjs next` + §11 一行 | M4-1 | `skills/sdo-flow/scripts/view.mjs`、`skills/sdo-flow/SKILL.md`（§11）、`README.md` |
| M4-4 | `check.mjs --plan` + §11 一行 | M4-1、M4-3 | `skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/SKILL.md`（§11）、`README.md` |
| M4-G | 读数门（R14–R18）+ 评审记录 + 签字 | M4-0、M4-1、M4-2、M4-3、M4-4 | `.sdo/readings/`、`.sdo/sign/`、`.sdo/review/`、`.sdo/01-计划.md`（只改本段状态） |

> 依赖重排理由：`M4-1` 保留对 `M4-0` 的依赖**只为 §11/README 的串行追加**（`card.mjs` 不读写台账）；`sign.mjs`/`view next`/`check --plan` 都需要**卡解析**（`M4-1`），不需要彼此。写域括号表示“只改该小节”，比对时只看路径部分。

### M4.3 共享写域补充

| 文件/目录 | 允许改的卡 | 说明 |
|---|---|---|
| `skills/sdo-flow/scripts/` | M4-0…M4-4 | **串行链，禁并行**（同目录不同文件仍按依赖顺序提交，避免 §11 段落互相覆盖） |
| `skills/sdo-flow/SKILL.md` §11 | M4-0…M4-4 | 每卡只加自己那一段命令，按依赖顺序追加 |
| `README.md`（用法节） | M4-0…M4-4 | 同上 |

### M4.4 阶段

`incremental` 简化版：写卡（req_design）→ 实现（build）→ 多轮评审（verify）→ 读数与门（integrate）。每张卡先卡后写。

### M4.5 冻结段

- 被签对象：`6f7067f`（S13，2026-11-19T17:26+08:00 签）。
- 本段已签（S13）并冻结；之后改动按 S6 的边界重签。
- 状态：**已签**（S13，2026-11-19T17:26+08:00）。
  - 补记（2026-11-19）：此前漏写「状态：」行，`view.mjs next` 会把本段判为「未知状态」；此行只补事实，不改 S13 冻结内容（台账 D-58）。
- 三条硬规则：脚本只读写 `.sdo/` 与 `skills/sdo-flow/` 内的文件；不自动提交、不自动签字（`sign.mjs` 只出事实材料）；`--run` 之外不把结果写成 `pass`。

---
