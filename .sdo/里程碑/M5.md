## M5 · 去假绿与减重（agent-driven preset）

> 来历：用户 2026-11-20「M5 除了修假绿外也需要考虑后续减重问题（台帐文件数堆积过多，脚本性能自然下降），我的建议是考虑台帐归档」「V1 时期就遇到过性能问题（jsonl 每次全量读），你在设计上要考虑后续台帐会达到同样数量级」「M5 的 preset 可以试试新写的 agent 驱动 preset，同样也观察有哪些使用不方便的地方，记录并与我讨论改善」。
> 本段为追加，不改 M1–M4 冻结段。**preset：agent-driven**（`skills/sdo-flow/presets/agent-driven.md`），六阶段 `frame → build → verify → review → sign → deliver`；本里程碑的出口判据在 `.sdo/gates/M5.md` 里逐条对账。
> 信任前提（本里程碑写入意图 §11）：**假设模型可信——完全按 skill 执行、不代签；问答签字一律视为人签**。因此本里程碑不做密码学/防代签，只做“防自欺（假绿）”与“防退化（增长后变慢/变脆）”。

### M5.1 里程碑与判死读数

| 读数 | 问题 | 怎么量 | 达标线 |
|---|---|---|---|
| R19 | 判定权分离后，原来三类假绿会不会变红？ | 三个 `/tmp` 夹具：①`done` 卡证据表某行空；②证据行手写 `pass`（非脚本生成）；③读数 `overall: pass` 而某条 `partial` | 三例在 `check.mjs` 下各 exit 1，且报错点名具体判据/条目 |
| R20 | 变异红证能否真跑、真红、真恢复？ | 对一张 `done` 卡选一条判据：`card.mjs mutation` 在 `mktemp -d` 副本里改坏一处，跑该判据的命令 | 记录 `expected=red actual=red`；恢复后同一命令 `exit=0`；`git status` 干净 |
| R21 | 里程碑归档能否降低文件数与检查耗时，且不破坏历史？ | 归档 M1–M3 前后各记录一次 `check.mjs` 的扫描文件数与 `time -p` 三次中位；抽查三条历史引用（S8/S10/S13 相关） | 活跃扫描文件数**下降 ≥10%**，且**增长与里程碑数解耦**：在 `/tmp` 副本里从 HEAD 再归档第四个里程碑（模拟 M4）后，扫描数必须等于「归档前 − M4 活跃文件数」（即归档一个就减一批），再新增一个里程碑并归档它后回到原基线；`check` 耗时允许 ≤ +5ms（manifest 校验开销），超出记 gap 并写原因；`view archive M3` 能列出归档内容；0 错 0 警 |
| R22 | 归档是否可逆？ | `archive.mjs restore M3` 后：①逐文件 `sha256sum` 与 `archive/INDEX.md` 的 manifest 比对；②`git status --porcelain`；③`check.mjs`。**R22 全程在 `cp -a` 的 `/tmp` 副本里、从 HEAD 跑 `archive → restore`、不提交任何一步**（真实仓库的归档另有提交），所以副本内 `status` 必须为空 | 每个文件哈希与 manifest 相等（0 个 `MISMATCH`）、`git status --porcelain` 为空、INDEX 标“已恢复”、`check` 0 错 0 警 |
| R23 | 台账到 1 万/10 万行时，脚本还快吗？（V1 教训） | 在 `/tmp` 用内联 `node -e` 生成合成台账（每行 `\| D-<n> \| defect \| - \| 合成行 <n> \| - \| - \| open \|`，行数与卷头由脚本写；索引先 `reindex` 造出来）。1 万/10 万各一份，每档 `ledger add`、`view next`、`check` 各跑 3 次取中位（`time -p`），记录机器型号与 `node -v` | 10 万行：`ledger add` < 100ms、`view next` < 200ms、`check` < 300ms；1 万行：三项各 < 100ms；超预算按 fail 记并写缺口（不许改口径） |
| R24 | 索引漂移能否被发现并修复？ | 手改活跃卷（改一行、删一行）后再跑 `check`；然后 `ledger.mjs reindex` 并再跑一次 `reindex` 比较两次输出 | `check` 报 `index_stale` 并 exit 1；`reindex` 后 0 错、且第二次 `reindex` 输出与第一次相同（索引可由正文完全重建，diff 为空） |
| R25 | agent-driven preset 用起来哪里不顺手？ | 本里程碑全程使用该 preset；**每张卡收口时若遇摩擦就当场追加一条**（写进 `.sdo/notes/M5-使用笔记.md`，格式：现象 / 复现 / 建议）；门签前把清单交给用户讨论 | ≥3 条具体不便（含复现动作与建议改法）；门签时**由人确认讨论结论**并落一条 explain 台账 |

### M5.2 卡表

| 卡 | 内容 | 依赖 | 写域 |
|---|---|---|---|
| M5-0 | 判定权分离：证据列只放命令与输出，`pass/partial/fail` 由评审写；信任前提写入意图与边界 | M4-G | `skills/sdo-flow/templates/card.md`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/SKILL.md`（§5）、`skills/sdo-flow/references/04`、`skills/sdo-flow/references/07`、`.sdo/00-意图.md`（§11）、`.sdo/cards/`（回填 M4 五卡） |
| M5-1 | 证据只由脚本写：`card.mjs evidence` 拒手填、必带命令；手写 `pass` 被检查器拒 | M5-0 | `skills/sdo-flow/scripts/card.mjs`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/templates/card.md`、`skills/sdo-flow/SKILL.md`（§5） |
| M5-2 | 变异红证（卡级）：`card.mjs mutation` 在临时副本真跑，记录 expected/actual；允许「不可变异 + 理由」并由评审确认 | M5-1 | `skills/sdo-flow/scripts/card.mjs`、`skills/sdo-flow/templates/card.md`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/SKILL.md`（§5）、`skills/sdo-flow/references/04` |
| M5-3 | 里程碑归档：`archive.mjs archive/restore/list`、`.sdo/archive/INDEX.md` manifest、`check`/`view` 扫描规则 | M5-1 | `skills/sdo-flow/scripts/archive.mjs`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/scripts/view.mjs`、`skills/sdo-flow/SKILL.md`（§11）、`README.md`、`.sdo/archive/` |
| M5-4 | 台账分卷与索引：卷头元数据、`.sdo/.index/ledger.json`、`rotate`/`reindex`、`index_stale` 检测 | M5-0、M5-3 | `skills/sdo-flow/scripts/ledger.mjs`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/SKILL.md`（§11）、`skills/sdo-flow/templates/台账.md`、`.sdo/.index/`、`.sdo/archive/` |
| M5-5 | 追加签拆分与 `closed` 关闭记录：签字编号 `S<n>-<A..Z>`、关闭行专用 `closed`（不再让 `explain` 兼作关闭） | M5-4 | `skills/sdo-flow/scripts/ledger.mjs`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/SKILL.md`（§6/§11）、`skills/sdo-flow/references/03-签字与评审.md`、`skills/sdo-flow/references/06-偏差台账.md`、`skills/sdo-flow/templates/台账.md`、`skills/sdo-flow/templates/sign.md`、`.sdo/台账.md`、`.sdo/cards/M5-5.md` |
| M5-G | 读数门（R19–R25）+ 评审记录 + 使用笔记 + 出口表 + 门签 | M5-0、M5-1、M5-2、M5-3、M5-4、M5-5 | `.sdo/readings/`、`.sdo/sign/`、`.sdo/review/`、`.sdo/notes/`、`.sdo/gates/`、`.sdo/01-计划.md`（只改本段状态） |

> 依赖理由：M5-1 需要 M5-0 先定“判定列在哪”，否则“拒手填”无从判；M5-2 需要 M5-1 的脚本生成证据；M5-3 与 M5-0 无耦合但排在 M5-1 后，因为 `check` 的扫描规则同时要改；M5-4 依赖 M5-0（`ledger` 与 `check` 共用判定/一致性规则）与 M5-3（归档与分卷共用 INDEX 形态）。

### M5.3 共享写域补充

| 文件/目录 | 允许改的卡 | 说明 |
|---|---|---|
| `skills/sdo-flow/scripts/` | M5-0…M5-4 | **串行链，禁并行**（§11 段落与 `check.mjs` 共用） |
| `skills/sdo-flow/scripts/check.mjs` | M5-0、M5-1、M5-2、M5-3、M5-4 | 同文件多卡改：按依赖顺序，每卡改完即提交 |
| `skills/sdo-flow/SKILL.md`（§5 / §11） | M5-0…M5-4 | 只追加自己那一段 |
| `.sdo/cards/` | M5-0（回填 M4 五卡） | 回填只改证据/判定两列，不改判据文字 |
| `skills/sdo-flow/templates/card.md` | M5-0、M5-1、M5-2 | 模板字段先定（判定列/变异段），后续卡只读不改；要改先在本表登记 |
| `skills/sdo-flow/references/04` | M5-0、M5-2 | 判据写法与变异说明；M5-2 追加变异段 |
| `.sdo/archive/` | M5-3、M5-4 | 归档目录与索引；M5-4 的分卷归档卷也落这里，按里程碑分子目录不互相覆盖 |
| `.sdo/gates/` | M5-G | 出口表 `.sdo/gates/M5.md` 由 M5-G 产出；其它卡只读 |

### M5.4 阶段

`agent-driven`：`frame`（本计划 + 六卡）→ `build`（M5-0…M5-4）→ `verify`（每卡多轮评审 + 变异红证）→ `review`（门签前的独立复认）→ `sign`（S20 计划 / 卡签 / 门签）→ `deliver`（读数门 + 归档 M1–M3 + 同步已安装副本）。

### M5.5 冻结段（S20）

- 被签对象：本段 + `.sdo/cards/M5-0.md`…`M5-G.md` 的提交 `<commit>`（S20 签署时记 `git rev-parse HEAD`）。
- 冻结判据：R19–R25 的“问题 / 怎么量 / 达标线”三列；M5.2 卡表与六卡 `write_scope`、依赖边；M5.3 共享写域登记。
- 签后冻结：本段与六卡判据不再改；要改按“追加签 S20-A”，原段保留。
- 已知边界：
  1. **M1–M3 归档后不再适用 M5 新规则**（M5-0 只回填 M4 五卡；归档正文由 manifest 锁字节，不重新过 `check` 的新判据）。
  2. **索引是派生**：`.sdo/.index/ledger.json` 可由 `reindex` 丢弃重建；台账正文是唯一真源。两边被同时手改成一致时 `check` 不会红，这种改动只能由 append-only 纪律、git 历史与评审兜底。
  3. `--plan --milestone` 只认 `## M<n>` 段；本文件 M1–M3 是 `# 计划：M1` 形态，故对 M1–M3 跑 `--plan` 会 exit 2（不是归档造成的）。
  4. 信任前提（意图 §11）：假设模型可信；问答签字=人签。本里程碑不证明签字真实性。
  5. 性能预算是本机实测口径（记录机器与 Node 版本），不是跨平台保证。
  6. **M4 及以前 done 卡的证据列是历史 baseline，不回填**：M5-1 起的新卡结果列必须是脚本形态；M4/M5-0 的旧证据由 M5-0 人工回填，回填成“脚本形态”等于造假（当时不是 `card.mjs` 写的）。

- 证据格式基线卡（理由：该卡落地早于脚本形态校验，属人工回填）：M5-0
- 变异校验基线卡（理由：该卡早于 M5-2 的变异红证规则落地；只允许引用已签收的旧卡）：M5-0、M5-1

状态：**已签**（S20：2026-11-20T09:52+08:00；S20-A：10:36；S20-B：11:32；S20-C：14:20；S20-D：15:59；门签 S26：同批，接受 overall partial）。
- 门签后补记：M5-5（追加签拆分与 `closed`）在门签前落地，卡签并入 S26 复述（台账 D-108）。
