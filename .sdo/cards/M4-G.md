# M4-G · 读数门（R14–R18）

status: open
owner: lead
write_scope: [.sdo/readings/, .sdo/sign/, .sdo/review/, .sdo/01-计划.md（只改 M4 段状态）]

## 意图
把 M4 五张卡的脚本拿到同一棵树上跑 R14–R18，出读数、请人签门；并记录 M4 的评审过程。

## 风险标记

risk_flags：无

## 对齐
- 该做：写 `.sdo/readings/M4.md`（R14–R18 逐条 verdict + 命令 + 结果）、`.sdo/review/M4-G.md`、请人签 **S19**（门）。
- 不该做：用旧读数给新树签门、把“跑过命令”写成“证明业务为真”。

## 判据
C1 R14：`ledger.mjs` 的 `add`/`close` 各一次，`git diff -- .sdo/台账.md` 只有 `+` 行、旧行不变；`check.mjs` 0 错。
C2 R15：`card.mjs new` 生成卡 `check.mjs` 0 错；`--run` 失败命令 ⇒ 结果 `fail`、脚本 exit 1；`--result pass` ⇒ exit 2。
C3 R16：`sign.mjs draft` 输出无判定句（`grep -E "建议签|可以签|我认为"` 为空）；脏树 ⇒ `DIRTY` + exit 1；不写文件。
C4 R17：`view.mjs next` 五节齐全（按实际渲染断言）；`/tmp` 副本删 sections 项 ⇒ exit 1；删 M4.2 卡表整段 ⇒ exit 2。
C5 R18：`check.mjs --plan` 真仓库 0 漂移；`/tmp` 两条变异（删 M4-0 写域 / 判据改 `src/x.ts`，反例路径）各 exit 1、消息固定；恢复 0。
C6 读数完整性：`.sdo/readings/M4.md` 每条都有 verdict，overall 与逐条一致（任一 fail ⇒ fail；任一 partial ⇒ partial）；树冻结后取证。

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
| C1 | `.sdo/readings/M4.md` R14 表 | add 后 7 列追加；close 只追加 explain 行，`git diff --numstat` = `2 0`（删除 0）；check 0 错 | 若 close 改旧行 ⇒ diff 出现 `-` 行、append-only 破 |
| C2 | R15 表 | `new` exit 0、check 87 篇 0 错；`--run false` ⇒ exit 1 且落 `exit=1` 证据；`--result pass` ⇒ exit 2 | 若接受手填 pass ⇒ 证据可伪造 |
| C3 | R16 表 | 干净树 exit 0、禁词命中 0；脏树 exit 1 + `DIRTY`；跑前后 `git status` 不变 | 若写文件或输出建议句 ⇒ C1/只读破 |
| C4 | R17 表 | 真仓库 5 个 `##`；删 sections 项 ⇒ exit 1 `内部错误：next 五节不完整`；删卡表整段 ⇒ exit 2 | 若只校验内部数组 ⇒ 少打印也 exit 0 |
| C5 | R18 表 | 真仓库 0 漂移；删 M4-0 写域 ⇒ exit 1（C3+C6）；反例：判据改 `src/x.ts` ⇒ exit 1 | 若只比字符串前缀 ⇒ 路径漏报 |
| C6 | `check.mjs` + 本文件 | 87 篇 0 错 0 警；每条 R 都有 verdict，overall=pass 与逐条一致 | 若用旧读数签门 ⇒ 门签与树不符 |

## 判定
- C1–C6 全 pass；读数 `.sdo/readings/M4.md`（树冻结 2026-11-19T23:10+08:00，被签树 `6176efa`）。
- overall = **pass**；四条已知边界见读数末段。

## 评审
- 评审者：待派（非作者、只读）；本轮由 `reviewer-3` 复认读数与证据。
