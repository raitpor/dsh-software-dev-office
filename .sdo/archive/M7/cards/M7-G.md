# M7-G 读数门（R31–R32）

status: done
owner: impl-core
write_scope: [.sdo/readings/, .sdo/sign/, .sdo/review/, .sdo/gates/, .sdo/milestones/M7.md, skills/sdo-flow/scripts/lib/signed-cards.mjs]
read_refs: [.sdo/cards/, .sdo/sign/, .sdo/gates/]

依赖：M7-0

## 意图

把 M7 的两条判死读数落成可复跑证据，写出口表，走卡签与门签，并把这一轮修好的脚本同步到已安装副本。

## 判据

| 编号 | 判据 | 类型 | 反例 |
|---|---|---|---|
| C1 | `.sdo/readings/M7.md` 里 R31、R32 逐条可复跑，overall 与逐条一致 | 结构 | 把 overall 写成 pass 而某条是 partial ⇒ `check` 报读数不一致 |
| C2 | `.sdo/gates/M7.md` 覆盖本里程碑实际经过的 verify/review 两门；用 `test -f .sdo/gates/M7.md && node skills/sdo-flow/scripts/gate.mjs --file .sdo/gates/M7.md` 判（`gate.mjs` 无 `--milestone`，多余参数会被静默忽略，不能用来证明本表存在） | 结构 | 删一行判据 ⇒ `gate.mjs --file` 报缺行；删整个文件 ⇒ `test -f` 失败 |
| C3 | 门签 `- 范围：M7 里程碑门` 被识别为 `M7-G` 收口签 | 结构 | 门签写成“M7 计划” ⇒ `next` 仍把 M7-G 列待签 |
| C5 | 卡签的范围行用**卡文件路径**指名时（如 `` `.sdo/cards/M7-0.md` ``）也能认出卡号——仅当该签文件标题含「收卡/卡签」；计划签标题不含该词，不得借此兜底 | 结构 | 删掉 `viaPath` 分支 ⇒ S34（范围写路径）认不出，`next` 把 `M7-0` 列回「待签收」 |
| C4 | 按 D-47 同步已安装副本，`diff -r` 无差异，副本自跑 `check` 同为 0 错 | 边界 | 只同步一半文件 ⇒ `diff -r` 有输出 |

## 证据

| 判据 | 命令 | 输出 | 判定 |
|---|---|---|---|
| C1 | exit=0; `node skills/sdo-flow/scripts/check.mjs`；副本把 R31 verdict 改 `partial` 而 overall 留 `pass` 后再跑 | 真仓库 0 错；变异报 `overall=pass 与逐条不一致…`、exit1 | pass |
| C2 | exit=0; `test -f .sdo/gates/M7.md && node skills/sdo-flow/scripts/gate.mjs --file .sdo/gates/M7.md`；副本删 `agent.checker_green` 行 | 真仓库 2 gate 全 pass、exit0；删行后报 `缺判据`、exit1 | pass |
| C3 | exit=0; 副本加 `S999`（`- 范围：M7 里程碑门`）后查 `gateSignInfo` 与 `signedCardIds`；再改成 `M7 计划` 查 | 门签式 `M7-G` 均在两集合；计划签式 `false` | pass |
| C4 | exit=0; `rsync -a --delete skills/sdo-flow/ .dsh/skills/sdo-flow/`；`diff -r`；副本跑 `check` | `diff -r` 无输出；副本 check 0 错 0 警 | pass |
| C5 | exit=0; `view next` ⇒ 待签收无（S34 路径式识别为 M7-0）；副本置 `viaPath=false` 再跑 | 正常无；变异 `待签收 - M7-0` 重现 | pass |
| C5 | exit=0; `/tmp` 负例夹具：标题 `S90 · M7-0 收卡`、范围只写 `.sdo/cards/M7-1.md` | M7-0 与 M7-1 均在「待签收」（跨卡路径不得兜底） | pass |

## 变异

| 判据 | 变异动作 | 应红命令 | 结果 |
|---|---|---|---|
| C1 | 副本把 R31 verdict 改 partial、overall 留 pass | `check` | expected=red actual=red（原版 exit0；变异 `overall=pass 与逐条不一致` exit1） |
| C2 | 副本删 `agent.checker_green` 行 | `gate.mjs --file .sdo/gates/M7.md` | expected=red actual=red（原版 exit0；变异 `缺判据` exit1） |
| C3 | 门签范围写成 `M7 计划` | `next` / `gateSignInfo` | expected=red actual=red（原版 `M7-G` 收口；变异不认识） |
| C4 | 只同步一半文件 | `diff -r` | expected=red actual=red（原版无输出；变异有 diff） |
| C5 | 路径识别不校验目标卡（回到“标题含收卡即认所有路径”） | `/tmp` 负例夹具 `next` ⇒ M7-1 被错认成已签、从待签收消失 | expected=red actual=red |

## 判定

- C1 pass：R31/R32 可复跑，overall=pass 与两条 verdict 一致；改一条 verdict 不更新 overall 即红。
- C2 pass：`.sdo/gates/M7.md` 覆盖 verify/review 两门，`gate.mjs --file` exit0；删判据行/文件即红。
- C3 pass：`- 范围：M7 里程碑门` 经共享 helper 识别为 `M7-G`；写成计划签不识别。
- C4 pass：已安装副本 rsync 后 `diff -r` 空，副本自跑 check 0 错。
- C5 pass：S34 范围写卡文件路径时，标题含「收卡」的卡签经 `viaPath` 认出 M7-0；路径卡号必须等于本签文件的目标卡（标题/范围直指的卡号），否则忽略——负例夹具（标题 M7-0、范围指 M7-1）两卡均保持待签收；计划签不兜底。
- 总体：pass（评审复核）。
语义：不适用（本卡只证读数与门表可复跑，不改变产品行为；解析语义由 M7-0 的 C2–C4 与 C5 承担）

## 评审

- 评审者：
- 第 1 轮：

## 已知边界

- R31/R32 只证“显示与解析一致”，不证“签文件内容为真”；真伪以 `git log` 为准。
- 门签不覆盖实现卡的卡签（D-109），M7-0 必须单独签。
