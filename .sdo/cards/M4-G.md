# M4-G · 读数门（R14–R18）

status: open
owner: lead
write_scope: [.sdo/readings/, .sdo/sign/, .sdo/review/, .sdo/01-计划.md（只改 M4 段状态）]

## 意图
把 M4 五张卡的脚本拿到同一棵树上跑 R14–R18，出读数、请人签门；并记录 M4 的评审过程。

## 风险标记

risk_flags：无

## 对齐
- 该做：写 `.sdo/readings/M4.md`（R14–R18 逐条 verdict + 命令 + 结果）、`.sdo/review/M4-*.md`、请人签 S14。
- 不该做：用旧读数给新树签门、把“跑过命令”写成“证明业务为真”。

## 判据
C1 R14：`ledger.mjs` 的 `add`/`close` 各一次，`git diff -- .sdo/台账.md` 只有 `+` 行、旧行不变；`check.mjs` 0 错。
C2 R15：`card.mjs new` 生成卡 `check.mjs` 0 错；`--run` 失败命令 ⇒ 结果 `fail`、脚本 exit 1；`--result pass` ⇒ exit 2。
C3 R16：`sign.mjs draft` 输出无判定句（`grep -E "建议签|可以签|我认为"` 为空）；脏树 ⇒ `DIRTY` + exit 1；不写文件。
C4 R17：五小节齐全；`check.mjs --plan` 的两次 `/tmp` 变异各 exit 1、消息格式固定；恢复 0。
C5 R18：本卡读数中每条都有 verdict，overall 与逐条一致（任一 fail ⇒ fail；任一 partial ⇒ partial）；树冻结后取证。

## 假设
A1：五张卡的脚本都已收卡（否则 M4-G 只能 partial 并写缺口）。
A2：读数门只证“命令在这棵树上成立”，不证业务正确。

## 预览
预计改：新增 `.sdo/readings/M4.md`、`.sdo/review/M4-评审.md`、`.sdo/sign/S14.md`；计划 M4 段状态。
验：`check.mjs` 0 错 + `gate.mjs`（若建 M4 出口表）。

## 准入
依赖：M4-0、M4-1、M4-2、M4-3、M4-4

## 证据
| 判据 | 命令 | 输出摘要 | 改回去会怎样 |
|---|---|---|---|

## 判定
待评审后填。

## 评审
- 评审者：待派（非作者、只读）
