# M6-G 读数门（R26–R30）+ 出口表 + 门签

status: open
owner: lead
write_scope: [.sdo/readings/, .sdo/sign/, .sdo/review/, .sdo/gates/, .sdo/01-计划.md]
read_refs: [skills/sdo-flow/scripts/, .sdo/cards/, .sdo/台账.md]

## 意图

在冻结树上逐条取证 R26–R30，写读数与出口表，交人签 M6 门。

## 风险标记

release_touching：门签后 M6 段与五卡冻结，读数即最终证据。

## 对齐（复述）

- 一句话：本卡不做新功能，只做“可复跑的证据 + 老实写 partial”。
- 做：跑 R26–R30、写 `.sdo/readings/M6.md`、写 `.sdo/gates/M6.md`、写评审记录、请门签 S28。
- 不做：不改脚本；读数不过就记 partial/fail，不改达标线。
- 正例：五条读数各带命令与输出、overall 与逐条一致。
- 反例：`overall：pass` 而某条 `partial` ⇒ `check` 红。

## 预览

预计读数 1 份、出口表 1 份、评审记录 1 份、门签 1 份。

## 准入

依赖：M6-0、M6-1、M6-2、M6-3。

## 判据

| 编号 | 判据 | 反例 |
|---|---|---|
| C1 | R26–R30 逐条有命令、输出、判定；overall 由逐条推出 | 任一条缺输出 ⇒ `check` 红 |
| C2 | 出口表 `.sdo/gates/M6.md` 覆盖 agent-driven 的六门，`gate.mjs` exit 0 | 缺一门的判据 ⇒ `gate.mjs` 红 |
| C3 | 读数与门表引用同一被签树（提交后 `git rev-parse HEAD` 一致） | 读数里写的树 ≠ 提交树 ⇒ 评审打回 |
| C4 | 两条 partial 若存在，必须在门签复述里明说并让人接受 | 悄悄改写成 pass ⇒ 评审打回 |

## 证据

| 判据 | 命令与输出 | 判定 |
|---|---|---|
| C1 |  |  |
| C2 |  |  |
| C3 |  |  |
| C4 |  |  |

## 变异

| 判据 | 变异 | 期望 |
|---|---|---|
|  |  |  |

## 评审

- 评审者：
- 判定：

## 判定

- 待评。
