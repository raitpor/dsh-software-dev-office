# M8-G 读数门（R33–R36）与收口

status: open
owner: impl-core
write_scope: [.sdo/readings/, .sdo/gates/M8.md, .sdo/review/, .sdo/sign/, .sdo/notes/M8-使用笔记.md, .sdo/milestones/M8.md, .sdo/cards/M8-G.md]
read_refs: [.sdo/baseline/, .sdo/cards/, .sdo/milestones/]

依赖：M8-0、M8-1、M8-2、M8-3、M8-4

## 意图

按 `prototype` 的三道出口取证：`explore`（原型可观察）、`harden`（四向闭合 + 基线绑定全量判据）、`deliver`（读数与同步）。读数写 `.sdo/readings/M8.md`，出口表写 `.sdo/gates/M8.md`（补齐三门），`gate.mjs` 必须通过。

## 判据

| 编号 | 判据 | 类型 | 反例 |
|---|---|---|---|
| C1 | `.sdo/gates/M8.md` 覆盖 `explore`（4）/ `harden`（23）/ `deliver`（6）三门，`gate.mjs` exit 0 | 结构 | 只写 `harden` 一门 ⇒ `grep -c '^### .*G_.*_exit' .sdo/gates/M8.md` 得 1（应 3） |
| C2 | R33–R36 逐条 pass 或（人签接受的）partial；每条有可复跑命令与输出 | 结构 | 某条只写“已确认” ⇒ M5-1 规则拒收（证据必须是 `exit=` 开头的命令结果） |
| C3 | 每条读数至少一个反例真红，写在 `.sdo/readings/M8.md` | 结构 | 只有正例 ⇒ 该读数不算判死 |
| C4 | 探索结论收敛：`M8-0` 的「探索结论」表 ≥3 行且每行去向可解析（`M8-1 Cx` / `M8-2 Cx` / `不采纳+理由`） | 语义 | 表里写“后续再看” ⇒ 去向无法解析，等于探索白做 |
| C5 | 收口时同步已安装副本（`.dsh/skills/sdo-flow/` 与宿主副本），`diff -r` 无差异 | 结构 | 只同步仓库内副本、宿主仍旧版 ⇒ 下一次会话用的是旧规则 |
| C6 | 使用笔记 ≥3 条，含至少 1 条对 `prototype` 的摩擦反馈 | 语义 | 只写“一切顺利” ⇒ 无信息量，门不签 |

## 证据

| 判据 | 命令与输出 | 结果 |
|---|---|---|

## 变异

| 判据 | 变异动作 | 应红命令 | 结果 |
|---|---|---|---|

## 判定

（收卡时填写：判定由评审判，逐条写 pass/partial/fail；证据列只放命令与输出，不放结论）

## 评审

## 语义自检

（实现后填写：C4/C6 是“探索是否真的收敛”，结构判据只能证“文件写了”）

## 已知边界

1. 读数门只证“机制生效”，不证“需求写得好”。
2. `prototype` 的 `harden` 出口是 23 条全量判据，本卡按实际经过的 stage 填表。
3. 基线段改动需追加签 S34-A，本卡负责在门签前完成。
