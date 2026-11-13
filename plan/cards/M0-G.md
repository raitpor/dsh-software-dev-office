---
id: M0-G
seq: 9
milestone: M0
owner: impl-core
write_scope: [scripts/, package.json, test/readings/, plan/milestone/, plan/cards/M0-G.md]
status: open
created_at: 2026-11-13
---

# M0-G · 里程碑门：四条判死读数

## 意图

M0 的八张卡都收口了，但 `plan/00` §5 有一条硬门：**读数报告没签字不进下一 M**。这张卡不写新功能，只做一件事——用**可复跑**的证据回答 `docs/09` §16.1 的四条判死读数，产出一份人能签字的读数报告。它是 M0 的出口，也是接管方案 G1–G6 里“读数”这套东西的第一次实操。

## 对齐

**复述**：这张卡不是“再写一遍测试”，而是把 M0 已经有的事实翻译成四条读数，每条给出**命令、原始输出、结论（达标/部分达标/不达标）**；数字必须是机器算出来的，不是抄卡面。报告写给人签，签完 M0 才算过门。

**人确认**：pending（收卡前必须确认）

**正例 2**
1. 在干净检出的仓库上 `npm run readings` 一条命令跑完，产出 `plan/milestone/M0-读数.json` 与 `M0-读数.md`，四条读数各有 `measured` 与 `verdict`。
2. 有人把 `src/query/execute.ts` 改成每行查一次事件表（N+1）后，R1 的读数会变红（这条路径会验：把测量函数对着一个故意 N+1 的查询跑，必须报 ≥2 次）。

**反例 1**
- 报告里出现“应该没问题”“测试都绿了”这类结论而没有对应命令输出；或四条读数全靠手工抄写、没有脚本。

## 判据

| # | 判据 | 怎么验 |
|---|---|---|
| C1 | **R1**：`event` 读取次数可测，且一次 status 查询（`overview`）的执行计划里 `event` 出现 **0 次**（上界“1 次”成立） | `scripts/m0-readings.mjs` 对 13 个视图逐条 `EXPLAIN QUERY PLAN`，统计计划行里 `event` 的出现次数；报告给出每个视图的实测值。**并证明测量能红**：对一个故意 N+1 的 SQL（每行子查询 `event`）测得 ≥2 |
| C2 | **R2**：同一 `as_of` 两次查询**逐字节相同** | 同进程连查两次 `JSON.stringify` 相等；再起**两个独立进程**各查一次，stdout 逐字节比对相等 |
| C3 | **R3**：读只留探针线索、写/篡改由 `verify` 发现，都不承诺归因 | 3 次 `query()` ⇒ `access.log` 恰 3 行（库同目录）；用裸连接直改 `task.title` ⇒ `verify` 报 `runtime_inconsistent`；改事件 hash ⇒ `event_hash_mismatch`；报告**不得**出现任何“谁改的”结论 |
| C4 | **R4**：`gaps` 能看到 `query_miss` 的聚合 | 用具名 `query_miss` 事件（合法 hash 链）写入后，`gaps` 按视图名聚合出行；**生产写入路径不在 M0**（D-012），报告必须把这条标为**部分达标**并写清缺什么 |
| C5 | 报告可复跑 | `package.json` 加 `readings` 脚本；`plan/milestone/M0-读数.{json,md}` 由脚本生成；md 里每条读数带命令与原始输出片段 |
| C6 | 不污染冻结区 | `git diff f37f4dc --name-only -- docs design probe` 为空 |

## 假设

| # | 假设 | 状态 | 依据 |
|---|---|---|---|
| A1 | “一次 status 查询”指 `sdo_query` 的一次 `overview` 调用 | confirmed | `docs/09` §16.1 的上下文是“13 视图 + `sdo_query`”；`overview` 是总览读数面 |
| A2 | 直接 `INSERT` 事件行做 R4 夹具是允许的（M0 没有写网关） | confirmed | M0 只读；夹具在临时库上构造，不进仓库数据 |
| A3 | 读数全部在临时目录的新库上跑，不碰 `~/.local/state/sdo/` | confirmed | 沙箱口径（M0-6） |

## 预览

改动面：新增 `scripts/m0-readings.mjs`、`test/readings/`（若需要单测测量函数）、`plan/milestone/`；`package.json` 加一个 script。**不碰** `src/**`（除非测量需要导出内部函数——那种情况先报 Lead）。

## 准入

- [x] 意图与复述已写（人确认 pending，收卡前确认）
- [x] 判据带正负例
- [x] 写域明确，不跨泳道
- [x] 无依赖外部服务

## 证据

| # | 判据 | 命令 | 读数 |
|---|---|---|---|
| E1 | C1 | `npm run readings` | 待填 |
| E2 | C2 | `npm run readings` | 待填 |
| E3 | C3 | `npm run readings` | 待填 |
| E4 | C4 | `npm run readings` | 待填 |
| E5 | C5 | `ls plan/milestone/`、`cat package.json` | 待填 |
| E6 | C6 | `git diff f37f4dc --name-only -- docs design probe` | 待填 |

## 判定

手工（M0 尚无 baseline）：四条读数按上表实测；**任何一条不达标或部分达标都要在报告里显式标出**，不许四舍五入成绿。

## 评审

| 轮 | 结论 | 要点 |
|---|---|---|
| — | — | — |

## 收口

- [ ] 四条读数实测并写进报告
- [ ] 人签（M0 门）
- [ ] 台账无新增 gap（有就登记）

## 待确认

- 人确认复述（收卡前）
- 若 R4 只能“部分达标”：是否接受“视图侧已通、写入路径 M1 补”，还是要求 M0 内补 `query_miss` 写路径
