# M9-G 读数门（R38–R43）

status: open
owner: impl-core
write_scope: [.sdo/readings/, .sdo/gates/M9.md, .sdo/review/, .sdo/sign/, .sdo/notes/M9-使用笔记.md, .sdo/milestones/M9.md, .sdo/cards/M9-G.md]
references: [R-02, R-03]
read_refs: [.sdo/milestones/M9.md, .sdo/gates/]

依赖：M9-0, M9-1, M9-2, M9-3, M9-4

## 意图

按 M9.4 的四门取证：R38–R43 逐条给可复跑命令与首条输出，写出口表、使用笔记，收口并同步已安装副本。

## 判据

| 编号 | 判据 | 类型 | 反例 |
|---|---|---|---|
| C1 | `.sdo/readings/M9.md` 覆盖 R38–R43，每条有命令、首条输出与 verdict；overall 与逐条一致 | 结构 | 改一条 verdict 与逐条不符 ⇒ `check` 报读数不一致 |
| C2 | `.sdo/gates/M9.md` 四门合计 **34 行全在**（16+6+6+6），判定列只允许 pass/partial/fail 三态；确实不适用的判据在**说明列**写 N/A：<依据>（不占判定列），卡面列出允许 N/A 的判据白名单并由评审逐条确认；含一行显式 `trace exit 0`；`gate.mjs --file` exit 0 | 结构 | 删一行 ⇒ `gate` 报缺判据；判定列写 N/A ⇒ `gate` 报“没有判定”，本判据红 |
| C3 | `.sdo/notes/M9-使用笔记.md` ≥3 条摩擦，每条含“现象/命令/结论” | 结构 | 删到 2 条 ⇒ 判据红 |
| C4 | 已安装副本 `.dsh/skills/sdo-flow/` 与本仓库 `diff -r` 无差异 | 结构 | 不同步 ⇒ diff 有输出，判据红 |

## 证据

| 判据 | 命令与输出 | 判定 |
|---|---|---|
| C1 | （待填） | （待填） |
| C2 | （待填） | （待填） |
| C3 | （待填） | （待填） |
| C4 | （待填） | （待填） |

门签前必须 `check`、`--trace`、`--presets`、`--plan --milestone M9` 全绿。

## 变异

| 判据 | 变异动作 | 应红命令 | 结果 |
|---|---|---|---|

## 判定

| 判据 | 判定 | 说明 |
|---|---|---|
| C1 | 未判 | （实现后填） |
| C2 | 未判 | （实现后填） |
| C3 | 未判 | （实现后填） |
| C4 | 未判 | （实现后填） |

## 评审

- 评审者：（待填）
- 判定：（待填）

## 收口

- [ ] 条件与证据齐全
- [ ] 评审为「可收卡」
- [ ] 报告交人签
