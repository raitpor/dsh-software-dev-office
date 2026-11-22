# M8-G 读数门（R33–R37）与收口

status: done
owner: impl-core
write_scope: [.sdo/readings/, .sdo/gates/M8.md, .sdo/review/, .sdo/sign/, .sdo/notes/M8-使用笔记.md, .sdo/milestones/M8.md, .sdo/cards/M8-G.md]
read_refs: [.sdo/baseline/, .sdo/cards/, .sdo/milestones/]

依赖：M8-0、M8-1、M8-2、M8-3、M8-4

## 意图

按 `prototype` 的三道出口取证：`explore`（原型可观察）、`harden`（四向闭合 + 基线绑定全量判据）、`deliver`（读数与同步）。读数写 `.sdo/readings/M8.md`，出口表写 `.sdo/gates/M8.md`（补齐三门），`gate.mjs` 必须通过。

## 判据

| 编号 | 判据 | 类型 | 反例 |
|---|---|---|---|
| C1 | `.sdo/gates/M8.md` 覆盖 `explore`（4）/ `harden`（24）/ `deliver`（6）三门，`gate.mjs` exit 0 | 结构 | 只写 `harden` 一门 ⇒ `grep -c '^## G_.*_exit' .sdo/gates/M8.md` 得 1（应 3） |
| C2 | R33–R37 逐条 pass 或（人签接受的）partial；每条有可复跑命令与输出 | 结构 | 某条只写“已确认” ⇒ M5-1 规则拒收（证据必须是 `exit=` 开头的命令结果） |
| C3 | 每条读数至少一个反例真红，写在 `.sdo/readings/M8.md` | 结构 | 只有正例 ⇒ 该读数不算判死 |
| C4 | 探索结论收敛：`M8-0` 的「探索结论」表 ≥3 行且每行去向可解析（`M8-1 Cx` / `M8-2 Cx` / `不采纳+理由`） | 语义 | 表里写“后续再看” ⇒ 去向无法解析，等于探索白做 |
| C5 | 收口时同步已安装副本（`.dsh/skills/sdo-flow/` 与宿主副本），`diff -r` 无差异 | 结构 | 只同步仓库内副本、宿主仍旧版 ⇒ 下一次会话用的是旧规则 |
| C6 | 使用笔记 ≥3 条，含至少 1 条对 `prototype` 的摩擦反馈 | 语义 | 只写“一切顺利” ⇒ 无信息量，门不签 |

## 证据

| 判据 | 命令与输出 | 判定 |
|---|---|---|
| C1 | exit=0; `grep -c '^## G_.*_exit' .sdo/gates/M8.md` ⇒ 3；`node skills/sdo-flow/scripts/gate.mjs --file .sdo/gates/M8.md` ⇒ `G_explore_exit pass 4 / G_harden_exit pass 24 / G_deliver_exit pass 6`，exit0 | pass |
| C2 | exit=0; `node skills/sdo-flow/scripts/check.mjs` ⇒ 165 Markdown 0/0；`.sdo/readings/M8.md` R33–R37 逐条四列，overall=partial（R36 partial，其余 pass；`checkReadings` 验证由逐条推出） | partial |
| C3 | exit=0; 每条读数“反例红证”列均含 `/tmp` 副本命令与首条报错：R33 三码、R34 四步、R35 两行结论、R36 孤儿测试、R37 三步 | pass |
| C4 | exit=0; M8-0「探索结论」4 行，去向 `M8-1 C1/C7/C5` 与 `不采纳`；`node skills/sdo-flow/scripts/check.mjs --trace` ⇒ 0 问题 | pass |
| C5 | exit=0; `rsync -a --delete skills/sdo-flow/ .dsh/skills/sdo-flow/` 后 `diff -r skills/sdo-flow .dsh/skills/sdo-flow` 无输出 | pass |
| C6 | exit=0; `.sdo/notes/M8-使用笔记.md` 4 条（`grep -c '^## '` ⇒ 4），其中第 1、2 条为 prototype 摩擦（harden 24 条、explore 4 条太薄） | pass |

## 变异

| 判据 | 变异动作 | 应红命令 | 结果 |
|---|---|---|---|
| C1 | `/tmp` 副本删 `## G_deliver_exit` 整段 | `grep -c '^## G_.*_exit' .sdo/gates/M8.md`（应 3，删后 2） | expected=red actual=red restored=green |
| C2 | `/tmp` 副本把 `.sdo/readings/M8.md` 的 `overall：partial` 改 `pass`（R36 仍 partial） | `node skills/sdo-flow/scripts/check.mjs` | expected=red actual=red restored=green（`overall=pass 与逐条不一致…` exit1） |
| C3 | 不可变异：C3 判的是 `.sdo/readings/M8.md` 内容完整性（每条读数带 `/tmp` 反例），检查器只校验四列格式与 overall 一致、不校验反例真实性，无“改坏实现 ⇒ C3 红”的单点 | — | — |
| C4 | 副本把 `.sdo/gates/M8.md:40` 的 `design.artifacts_present` 改名 | `node skills/sdo-flow/scripts/gate.mjs --file .sdo/gates/M8.md` | expected=red actual=red restored=green（`缺判据 design.artifacts_present`） |
| C5 | 副本改 `.dsh/skills/sdo-flow/SKILL.md` 一行 | `diff -r skills/sdo-flow .dsh/skills/sdo-flow` | expected=red actual=red restored=green（输出 `134a135`） |
| C6 | 副本删 `.sdo/notes/M8-使用笔记.md` 第 1 条（`## 1.` 段） | `grep -c '^## ' .sdo/notes/M8-使用笔记.md`（应 4，删后 3） | expected=red actual=red restored=green |

## 变异确认

- C3：**不可变异**。C3 判的是 `.sdo/readings/M8.md` 的内容完整性（每条读数附 `/tmp` 反例），检查器不校验反例的真实性（它只校验读数四列格式与 overall 一致），所以不存在“改坏实现 ⇒ 该判据红”的单点；真实反例见读数 R33–R37 各条的 `/tmp` 命令与首条报错。不可变异确认 C3：评审批 `reviewer`，2026-11-22 第 2 轮接受（理由：C3 是读数内容完整性，`checkReadings` 只校验四列格式与 overall 一致，无“改坏实现 ⇒ C3 红”的单点；真实反例见读数各条 `/tmp` 命令）。

## 判定

- C1：pass（三门 4/24/6，gate exit0；卡面判据原写 harden 23，已按 preset criteria 改为 24）
- C2：partial（R36 partial：`trace_orphan_card` 码在 M8-1 实现里不存在，只有计数；其余读数 pass）
- C3：pass（五条读数均有 `/tmp` 反例与首条报错）
- C4：pass（探索结论 4 行、去向可解析、`--trace` 0）
- C5：pass（`.dsh` 副本 diff 空）
- C6：pass（4 条笔记，含 prototype 摩擦 2 条）

## 评审

评审者：`reviewer`（独立、只读、非作者）。

- 第 1 轮：改完再审（2 P2：门表/读数误读、C3–C6 缺变异行）。
- 第 2 轮：可提交（收卡）。
- 判定：可收卡

- 不可变异确认 C3：评审 `reviewer`，2026-11-22 第 2 轮接受（理由：C3 是读数内容完整性，`checkReadings` 只校验四列格式与 overall 一致，无“改坏实现 ⇒ C3 红”的单点）。
- 语义自检：C1 三门齐全但“齐全不等于判得严”——`G_explore_exit` 只有 4 条，`stage.requirement_complete` 一类判据在 explore 阶段几乎必然 pass，explore 出口的实际约束力弱于 harden；这一点已写进使用笔记第 2 条，不假装它是严格门。
- 语义自检：C2 的 partial 来自 R36 码缺口，不是读数偷懒；`checkReadings` 能校验“逐条 ⇒ overall”一致，但校验不了反例是否真跑过（见 C3 不可变异理由）。
- 语义自检：C4 的“去向可解析”只证明收敛动作存在，证明不了收敛得对（例如把一条结论派给 M8-1 C5 而 C5 其实不相关）——这只能靠评审。
- 语义自检：C6 的“≥3 条”是数量，笔记质量（是否真摩擦）只能靠评审；本卡第 1、2 条是真摩擦（harden 24 条一次过、explore 4 条太薄），第 3、4 条偏向记录。
- C4：M8-0 的四条结论不是占位，去向分别落到 M8-1 C1/C7/C5 与不采纳；`--trace` 对 done 卡实算，结论行少到 2 行即报 `explore_conclusion_malformed`。
- C6：笔记里的两条 prototype 摩擦是真实复现（gate 24 条、explore 4 条），不是“一切顺利”。
- R36：机器只认 `trace_orphan_test`，孤儿卡停在计数；这是本卡唯一 partial，已在读数与笔记中写明，需门签人确认。

## 临时决策

- 无（本卡不新增临时决策）

## 已知边界

1. 读数门只证“机制生效”，不证“需求写得好”。
2. R36 的 `trace_orphan_card` 码不存在（M8-1 只做计数），R36 判 partial；如需机检该码，M9 补规则并走 M8.1 追加签。
3. M5 仍按计划索引标 `agent-driven` 且未归档，`--presets` 会点名 M5；本卡按已知边界不归档 M5。
4. 卡 C1 原写 harden 23，与 preset criteria 24 冲突；本卡按实际 gate 行数 24 修正判据数字。
2. `prototype` 的 `harden` 出口是 23 条全量判据，本卡按实际经过的 stage 填表。
3. 基线段改动需追加签 S34-A，本卡负责在门签前完成。
