# S2-A 计划追加签

- 时间：2026-11-19T08:52+08:00
- 选项：**签：复述准确**
- 被签对象：分支 `skill/sdo-flow`，commit `4f07a18`（含本文件后为下一提交）
- 冻结对象：`sdo/01-计划.md`（R4 措辞、新增 R6/R7）、`sdo/00-意图.md`（A7/A8、§10）

## 复述（签的是什么）

1. **口径**：skill 是这套流程的**另一种实现形式**（文件 + 命令 + 人），不是某种实现的降级替代；`SKILL.md`、`README.md`、意图、计划、presets、references、templates 里不再出现“插件版/降级/装不了插件”的表述；三条保证改为“不同载体”，边界逐条写清。
2. **检查器**：`skills/sdo-flow/scripts/check.mjs`，Node 18+、零依赖、Windows/Linux 通用；查台账 7 列 / id 递增 / kind·状态枚举、全仓 Markdown 表格列数与游离行、签字必备字段与三选一、卡必备段落、读数 verdict，`--presets` 与 `main` 的 `docs/08` 比对。
3. **快捷视图**：`skills/sdo-flow/scripts/view.mjs`，六个只读视图（`state`/`queue`/`board`/`ledger`/`signs`/`plan`），`--json` 出结构化数据，未知命令退出码 2。

## 已知边界

- 检查器与视图都需要 Node；没有 Node 的环境退回人工查列数与字段，并在签字文件写“检查方式：人工”（台账 D-6）。
- 两条脚本都只查**格式与结构**，不判断证据真假、不校验签名。
- 视图是文件快照，不是实时状态；文件改了视图才会变。

## 验证（签前实跑）

| 项 | 命令 | 结果 |
|---|---|---|
| 检查器正例 | `node skills/sdo-flow/scripts/check.mjs` | exit 0，29 篇 0 错误 |
| 检查器 preset 比对 | `node skills/sdo-flow/scripts/check.mjs --presets` | exit 0 |
| 负例 ×5 | 台账列数 / id 重复 / 游离表格行 / 签字缺时间 / 卡缺判据段 | 各自 exit 1 且报 `文件:行` |
| 视图 ×6 + json | `view.mjs state\|queue\|board\|ledger\|signs\|plan`、`state --json` | 均有输出；json 可解析 |
| 未知视图 | `view.mjs nope` | exit 2 |

> 按签署者 2026-11-19 要求：本文件签署后做过“去宿主标识”的措辞替换（旧宿主路径 → `skills/sdo-flow/` 等），实质与选项不变；见台账 D-13。
