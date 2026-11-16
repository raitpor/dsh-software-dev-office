---
id: M4-G
seq: 45
milestone: M4
owner: impl-core
write_scope: [scripts/m4-readings.mjs, scripts/readings/m4/, test/readings/, plan/milestone/, plan/cards/M4-G.md]
status: open
created_at: 2026-11-16
---

# M4-G · 里程碑读数门（§16.5 四条判死读数）

## 意图

M4 的判死读数不是“功能演示”，而是四个**能被别人复算**的数：同文件并发写一成一败、一次派发的 `agent.pick_declined ≤ 1`、连续 3 次新起告警进 `gaps`、预占期认领者必须等于 `reserved_by`（绕过次数应为 0）。外加两条 M3 遗留：R4 人类签字样本（M4-6 供数）、`gate` 表命名（M2-2 的判定实际落 `stage_run`，本门按“两种名都探测”处理）。本卡只做取证，不改产品代码。

## 对齐

**复述**：四条读数 + 两条遗留，全部用**真进程/真库**取证；每条读数必须能被独立复跑（同一命令、同一种子、除时钟与产品随机 id 外逐键一致）；读数默认写仓库但**不得覆盖已签生成物**（D-117）；树冻结后单次取证，生成物哈希进签字记录。

**人确认**：pending

**正例 2**
1. 四条读数全 pass（其中第 4 条的“绕过次数 0”来自 `verify` 每日报，不是脚本自证）。
2. 任一读数不达标 ⇒ 门外报告 `fail`，不写“大体通过”。

**反例 1**
- 把“一成一败”用同进程 Promise 模拟出来 ⇒ 视为假读数（并发必须是两个独立进程）。

## 判据

| # | 判据 | 怎么验 |
|---|---|---|
| C1 | R1 同文件并发写：两个独立进程同库同前缀写 ⇒ 恰 1 成 1 败（`lock_conflict`），活锁 1 行、事件数与失败一致；**pass 条件包含“最终落库值 = 赢家值”** | 读数脚本 + 两份 raw（进程 A/B）；变异：去掉锁 ⇒ 两成或两败 |
| C2 | R2 `agent.pick_declined`：一次派发 ≤ 1 条；给出该派发的 `dispatch` 区间与计数；变异：造 2 条 ⇒ 红 | 读数 + 变异 |
| C3 | R3 连续 3 次新起 ⇒ `gaps` 有 `spawn_streak` 行（`count>=3`）；2 次 ⇒ 无；变异：把阈值改成 4 或删告警 ⇒ 红 | 读数 + 两向变异 |
| C4 | R4 预占：预占期内的认领者 = `reserved_by`；被绕过次数来自 `verify` 的输出（不是脚本自己查表），要求 0；变异：伪造一次绕过 ⇒ `verify` 红 | 读数 + `verify` 原始输出进 raw |
| C5 | 遗留一：人类签字样本（M4-6）≥5 条时把 M2 R5 / M3 R4 改判 pass，并给出样本数、中位、采集时点；不足 ⇒ 照实 partial | 读数 + 样本文件对账 |
| C6 | 遗留二：`gate` 表命名探测——`gate` 与 `stage_run` 两种名都查，命中哪个写明；若建了 `gate` 表则重跑 M2 的 R7 类检查并单独出结论 | 读数 two-name probe |
| C7 | 可复跑：两遍除 `generatedAt` 与墙钟派生字段外逐键一致；随机 id/竞态赢家做归一化（相等归 `<winner>`、不等归 `<MISMATCH>`），且**归一化本身断言等式** | 两遍 diff + 归一化用例 |
| C8 | 生成物不覆盖已签文件：`--out` 指定前缀、默认写 `plan/milestone/M4-*`；已签的 M0/M1/M2/M3 生成物在跑测后**逐字节不变** | 快照守卫用例（D-117） |
| C9 | 树冻结后取证：冻结时点、命令、`npm test`/`make all` 读数、生成物 sha256 全部写进卡与签字记录 | 卡 E 行 + 签字 |
| C10 | 冻结区零改动 | `git diff f37f4dc -- docs design probe` 为空 |

## 假设

| # | 假设 | 状态 | 依据 |
|---|---|---|---|
| A1 | M4 四条读数都能在单机、无网络、临时目录新库上复跑 | confirmed | 前三门同口径 |
| A2 | R4 的“每日 `verify` 报”在 M4 用**一次** `verify` 输出代替“每日”，并在报告里写明“不是连续多日观测” | open | 待定 |
| A3 | 人类样本不足 5 条时，本门 overall 只能是 partial（不许为了过门去催样本） | confirmed | S19/S29 口径 |

## 预览

`scripts/m4-readings.mjs` + `scripts/readings/m4/{helpers,r1,r2,r3,r4,legacy,index}.mjs`、`test/readings/m4.test.ts`、`package.json` 的 `readings:m4`、生成 `plan/milestone/M4-读数.{json,md}`。

## 准入

- [ ] 前置卡 M4-0…M4-7 全部收卡签字
- [ ] 写域在读数与 milestone 之内（不改产品代码）
- [ ] 已读 `docs/09` §16.5、S29 的遗留清单、D-117

## 证据

| # | 时点 | 命令 / 动作 | 读数 |
|---|---|---|---|
| E1 | 待填 | `npm run readings:m4` | 待填（R1–R4 逐条 verdict） |
| E2 | 待填 | `npm test` / `make all` | 待填 |
| E3 | 待填 | 两遍复跑一致性 | 待填 |
| E4 | 待填 | 快照守卫：跑测前后 M0–M3 生成物 sha256 | 待填（不变） |
| E5 | 待填 | `git diff f37f4dc -- docs design probe` | 待填 |

## 判定

手工判定 C1–C10；每条读数给“命令 + 原始输出摘要 + verdict”，partial 必须写清原因。

## 评审

| 轮 | 判决 | 要点 |
|---|---|---|
| 自检 | — | 派工前由 Lead 写判据与假设 |
| 第 1 轮 | 待填 | 待填 |
| 第 2 轮 | 待填 | 待填 |

## 收口

- [ ] 判据全绿（裁判权在 reviewer）
- [ ] 证据行填实测读数
- [ ] 偏差进 `plan/03-偏差台账.md`
- [ ] 复述经签署者确认（`plan/sign/`）

## 待确认

- [ ] **R4 用一次 `verify` 代替“每日报”**（我的倾向：可以，但报告里必须写明是单次观测；真要“每日”就得等连续几天，那会拖门）。
- [ ] **人类样本不足时的门判决**（我的倾向：overall partial 但可以进 **M5（插件化与接管）**——范围见 `plan/00` M5 段（先插件化 adapter → 再评审可安装性与功能满足性 → 通过才装进本 dsh 实例 → 用 SDO 跑本项目的卡）；前提是四条产品读数全 pass，与 S19/S29 同口径）。
