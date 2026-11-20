# M7-G 读数门（R31–R32）

status: open
owner: impl-core
write_scope: [.sdo/readings/, .sdo/sign/, .sdo/review/, .sdo/gates/, .sdo/milestones/M7.md]
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
| C4 | 按 D-47 同步已安装副本，`diff -r` 无差异，副本自跑 `check` 同为 0 错 | 边界 | 只同步一半文件 ⇒ `diff -r` 有输出 |

## 证据

| 判据 | 命令与输出 | 判定 |
|---|---|---|

## 变异

| 判据 | 变异动作 | 应红命令 | 结果 |
|---|---|---|---|

## 判定

| 判据 | 判定（pass/partial/fail） | 说明 |
|---|---|---|

## 评审

- 评审者：
- 第 1 轮：

## 已知边界

- R31/R32 只证“显示与解析一致”，不证“签文件内容为真”；真伪以 `git log` 为准。
- 门签不覆盖实现卡的卡签（D-109），M7-0 必须单独签。
