---
id: M2-G
seq: 26
milestone: M2
owner: impl-core
write_scope: [scripts/, package.json, test/readings/, plan/milestone/, plan/cards/M2-G.md]
status: open
created_at: 2026-11-14
---

# M2-G · 里程碑门（§16.3 四条读数 + 签字时长 + R7 复跑）

## 意图

M2 的目标不是“有签字”，是“**签字便宜**”。这张卡不写功能，只把 `docs/09` §16.3 的判死读数做成**可复跑证据**（`npm run readings:m2`），并把 M1 遗留的 R7 在这次一并复跑——`gate` 表已由 M2-2 建起，R7 不该再是“0 行平凡真”。

依据：`docs/09` §16.3（四条读数 + 签字中位 ≤10s）、M1-G 的做法（读数必须量到真路径、measurement 本身要被测量）。

## 对齐

**复述**：不是“再写一份报告”，而是**每条读数都能被别人一条命令重跑、并且在代码被改坏时会真的变红**。M1-G 的教训是硬的：第一版 R2 量的是纯函数、R4 是硬编码常量，两轮评审才修干净。这张卡一开始就按“量到真路径 + 变异红证”的要求来。

**人确认**：pending

## 七条读数（`docs/09` §16.3 四条 + 签字时长 + R7）

| # | 问题 | 期望 | 怎么量（必须先定死，再写代码） |
|---|---|---|---|
| R1 | 未解锁时签字 | `awaiting_unlock`，**不产生** decision 行 | 全新库 + 未解锁的 signerd ⇒ 调 `sign`；断言返回码、`decision` 行数 0、**非空库**（先写一条无关事件）以排除空库恒真 |
| R2 | 免密窗口内 frontier 改变后签字 | 要求重新解锁 | 解锁 → 签一条（成功）→ append 一条新事件 → 再签；断言 `frontier_stale`/`awaiting_unlock`、decision 行数不变（不静默续窗） |
| R3 | decision 缺 `proposition` | `no_blind_sign` 红 | 构造缺 `proposition` 的 payload ⇒ 拒；再给一个与 renderer 结果不一致的 `proposition` ⇒ 也拒；两种都断言 0 行 |
| R4 | agent 尝试签字 | 拒 + 告警事件 | 用 agent 凭据调 `sign` ⇒ `not_a_signer`、0 decision 行、**告警事件真实落库**（查事件表，不是看返回码） |
| R5 | 单次签字人工时长中位 ≤10s | 中位 ≤ 10000ms 且样本 ≥5 | 用 M2-6 的测量点跑 ≥5 次（含 1 次需解锁、1 次免密连签）；断言**中位**（不是均值）；样本数不足 ⇒ 如实 `partial`，不许拿 2 次充 5 次 |
| R6 | 免密窗口默认关闭 | 默认配置下第二次签要口令 | 不改配置直接连签两次 ⇒ 第二次要解锁；显式开启后才免密 |
| R7 | M1 遗留：`gate.judged` 行数（`gate` 表已建） | 非平凡断言 | 复用 M1 的 R7 测量，但此时表存在：断言判定行数与 `stage_run` 一致、`verify` 能对账；**M1 的旧断言（表不存在）必须同步改**，并在读数报告里写明“M1 partial → M2 结果” |

## 判据

| # | 判据 | 怎么验 |
|---|---|---|
| C1 | **一条命令可复跑**：`npm run readings:m2` 生成 `plan/milestone/M2-读数.{json,md}`，每条含 `{id, question, command, raw, verdict, caveat}` | 跑两遍；除 `generatedAt` 外逐键一致 |
| C2 | **量到真路径**：每条读数都从产品功能（`signerd`/写网关/门禁）取数，不用测试直插或纯函数自判；**M1-G 的两个假绿（纯函数自判、硬编码常量）不得重演** | reviewer 逐条手工验证“这个数字是怎么来的”；任何字面常量 ⇒ P1 |
| C3 | **变异红证**：关键读数（R1/R2/R3/R4）各做一次变异（如短路解锁检查、把窗口改成一经签发永久有效）⇒ 对应读数必须变红 | 变异在本地做、不提交；把变异后的输出贴进卡 |
| C4 | **非空库与样本量诚实**：R1 在非空库上验；R5 样本 <5 ⇒ `partial` 并说明，不许改分母 | 用例断言库非空、样本数写入 raw |
| C5 | **R7 复跑写清前后**：卡里必须有“M1 读数 ⑦ partial（表不存在）→ M2 读数 ⑦ 结果（表存在）”的对照 | 卡面表格 |
| C6 | **不碰生产库**：所有读数在临时目录新库跑；`~/.local/state/sdo` 与仓库 `*.db` 前后一致 | 用 `HOME=临时目录` 跑 + 前后文件集合比对（M1-G 的 C10 手法） |
| C7 | **树冻结后取证**：宣布冻结 → 单次复跑 → 所有 E 行写同一时点，无占位、无旧数 | 卡面 E 行时点唯一 |
| C8 | **诚实降级**：达不到的读数写 `partial`/`fail` + 原因，不许把失败包装成 pass；overall 取最差值 | reviewer 核 overall 与逐条 verdict 一致 |
| C9 | **拒绝码与文档一致**：读到的码（`awaiting_unlock`/`frontier_stale`/`no_blind_sign`/`not_a_signer`）与 README 错误码表一致 | 断言码集合相等 |
| C10 | 冻结区零改动 | `git diff f37f4dc --name-only -- docs design probe` 为空 |

## 假设

| # | 假设 | 状态 | 依据 |
|---|---|---|---|
| A1 | 签字时长用 M2-6 的测量点；若 M2-6 未落地，本卡不得自行造假数据 ⇒ 读数为 `fail`/`partial` 并列原因 | confirmed | M1-G 的教训 |
| A2 | 样本量 ≥5：1 次首次解锁 + 2 次窗口内连签 + 2 次窗口过期后重签 | pending | 开工前定死，写进卡 |
| A3 | R7 的“非平凡”断言 = `gate.judged` 行数与 `stage_run` 中已判定的行数一致，且 `verify` 绿 | confirmed | M2-2 的 C2/C6 |
| A4 | 读数脚本不引第三方依赖 | confirmed | 与 M1-G 一致 |

## 预览

- 新增：`scripts/m2-readings.mjs`、`scripts/readings/m2/*`、`test/readings/m2.test.ts`、`package.json` 的 `readings:m2`、`plan/milestone/M2-读数.{json,md}`。
- 会改：`scripts/readings/m1/measure.mjs` 的 R7 段（表已建，断言要改）——**这是唯一允许改 M1 读数的地方**，改前在卡里写明。
- 不会改：`src/`（冻结后更不许改）。

## 准入

- [ ] M2-0…M2-6 全部收卡（读数要量的东西得存在）
- [ ] 复述经签署者确认
- [ ] A2 的样本设计定死

## 证据

| # | 时点 | 命令 | 结果 |
|---|---|---|---|
| E1 | 待填 | | |

## 判定

本卡是里程碑门：判定 = 七条读数 + caveat 经核对 + reviewer 收卡 + 人签报告。

## 评审

| 轮次 | 结论 | 要点 |
|---|---|---|
| 待评 | | |

## 收口

- [ ] 判据 C1–C10 全绿（裁判权在 reviewer）
- [ ] 七条读数逐条 verdict + caveat
- [ ] R7 的 M1→M2 对照表
- [ ] 人确认 confirmed
- [ ] reviewer 收卡
- [ ] 代码与生成物一笔提交、卡与台账一笔提交
- [ ] 报告交人签（`plan/sign/S-M2.md`）

## 待确认

- A2 的样本设计（≥5 次、含哪几种情形）——开工前定死。
- M1 的读数报告要不要因 R7 复跑而“重签 M1 门”？——倾向不重签：M1 门签的是当时的树，R7 的复跑记进 M2 读数附录与 M2-2 卡。
