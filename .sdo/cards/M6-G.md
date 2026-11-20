# M6-G 读数门（R26–R30）+ 出口表 + 门签

status: done
owner: lead
write_scope: [skills/sdo-flow/scripts/check.mjs, .sdo/readings/, .sdo/sign/, .sdo/review/, .sdo/gates/, .sdo/milestones/M6.md]
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

> 口径修订（采集前，见台账 D-132）：原 C2 写“覆盖 agent-driven 六门”，但本里程碑只经过 `verify`/`deliver` 两个出口（frame/build/sign 是产品交付阶段，本里程碑无对应交付物）；若硬凑六门，只能给四门填“不适用”假 partial。改为“覆盖本里程碑实际经过的出口（verify/deliver）且 `gate.mjs` exit 0”。

| 编号 | 判据 | 类型 | 反例 |
|---|---|---|---|
| C1 | R26–R30 逐条有命令、输出、判定；`overall` 由逐条推出 | 语义 | 任一条判 `fail` 或 `partial`，而 overall 写 `pass` ⇒ `check` 红 |
| C2 | 出口表 `.sdo/gates/M6.md` 覆盖 agent-driven 六门，`gate.mjs` exit 0 | 结构 | 缺一门判据 ⇒ `gate.mjs` 红 |
| C3 | 读数与门表引用同一被签树（提交后 `git rev-parse HEAD` 一致） | 边界 | 读数里的树 ≠ 提交树 ⇒ 评审打回 |
| C4 | 若存在 partial，门签复述必须明说并由人接受 | 语义 | 悄悄改写成 pass ⇒ 评审打回 |

## 证据

| 判据 | 命令与输出 | 判定 |
|---|---|---|
| C1 | exit=0; `.sdo/readings/M6.md` R26–R30 五节；`overall：pass` 与逐条一致（R26–R30 全 pass，无 partial） | pass |
| C2 | exit=0; `node skills/sdo-flow/scripts/gate.mjs --milestone M6` → `门禁检查通过`（WARN 2 条：`assumption_set.signed` 为 core 判据、preset 未列，属预期）；出口表 verify 6 行 / deliver 7 行 | pass |
| C3 | exit=0; 读数 `M6.md:3` 记被取证树 `853c8ee`，与门签被签对象一致；读数与出口表同批提交后 `git rev-parse HEAD` 记录在 S30 | pass |
| C4 | exit=0; 无 partial（R26–R30 全 pass），故无需“明说 partial 并由人接受”；R30 的行为不可机检已写 caveat 与门签边界 | pass |

## 变异

| 判据 | 变异动作 | 应红命令 | 结果 |
|---|---|---|---|
| C1 | 副本把 `overall：pass` 改成与逐条不一致（某条改 partial 而 overall 不动） | `check.mjs` | expected=red actual=red（`overall=pass 与逐条不一致`） |
| C2 | 副本删掉 `## G_agent_deliver_exit` 整节 | `gate.mjs --milestone M6` | expected=red actual=red（找不到 gate 勾选表） |
| C3 | 副本把读数里的被取证树改成别的 hash | 人工比对读数与 S30 被签对象 | expected=red actual=red（评审打回，机检不覆盖——已在边界写明） |
| C4 | 副本把某条读数 verdict 改 partial 而 overall 保持 pass | `check.mjs` | expected=red actual=red（同 C1 机制） |

## 评审

- 评审者：`reviewer`（独立、只读、非作者）
- 判定：可签字（第 2 轮）
- 交集：第 1 轮「改完再审」（P1 首条报错顺序 + P2 六门口径 + P2 overall 自证）；第 2 轮「可签字」（读数、出口表、被签树三者一致）
- 语义自检：C1/C4 的“读数与 overall 一致”由机检兜（逐条 verdict 与 overall 交叉校验）；但“读数是否真在冻结树上取、命令是否真跑过”机检验不了，只能靠 tree/时间戳与评审复跑——这一点已写进卡「已知边界」与门签边界。

## 已知边界

- 读数“在冻结树上取”由时间戳与被取证树声明保证，机检不比对工作树是否被改过（门签时以 `git status` 干净为准）。
- 出口表的“证据”列是声明式引用，`gate.mjs` 只校验非空非占位，不打开文件核对行号。
- R30 只证明文本存在，不证明行为被遵守。
- 门签签收 `M6-G`，不覆盖 M6-0/M6-1 的实现质量（它们由本门签的“门卡收口”语义统一收口，见 D-109）。

## 判定

- C1 pass：`overall：pass` 与 R26–R30 逐条一致，无 partial。
- C2 pass：出口表 12 行判据、`gate.mjs` 通过（2 条预期 WARN）。
- C3 pass：读数记 `853c8ee`，与门签被签对象一致。
- C4 pass：无 partial 需要接受；不可机检项已写 caveat。
- 总体：pass（评审复核）。
