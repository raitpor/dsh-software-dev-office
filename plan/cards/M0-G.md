---
id: M0-G
seq: 9
milestone: M0
owner: impl-core
write_scope: [scripts/, package.json, test/readings/, plan/milestone/, plan/cards/M0-G.md, plan/03-偏差台账.md]
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
2. 把某个视图的 SQL 结构改成读两次 `event`（UNION ALL 两份）后，R1 对该视图的读数从 n 变 n+1（实测：`gaps` 1→2）。测量本身用“单表=1 / UNION 两份=2”证明计数器随结构倍数变化，不是常量；相关子查询这类“结构 1 次打开、运行期逐行访问”的形态**不在本口径内**（边界见报告与 D-023）。

**反例 1**
- 报告里出现“应该没问题”“测试都绿了”这类结论而没有对应命令输出；或四条读数全靠手工抄写、没有脚本。

## 判据

| # | 判据 | 怎么验 |
|---|---|---|
| C1 | **R1**：`event` 游标**打开次数**分表/索引两数测量（结构口径、不相加），且一次 status 查询（`overview`）为 `{eventTableOpens:0, eventIndexOpens:0}`（上界“1 次”成立） | `scripts/readings/count.mjs`：`eventTableOpens` = `EXPLAIN` 里 `OpenRead/OpenWrite` 且 `p2 = event` 表 rootpage；`eventIndexOpens` = `p2` ∈ event 索引 rootpage。13 个视图逐个给二元组。**证明测量能红且随结构变化**：`SELECT * FROM event` 表开 1、UNION ALL 两份表开 2；`SELECT max(at) FROM event` 表开 0/索引开 1；把 `gaps` 的 SQL 复制成两份，表开 1→2 |
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
| E1 | C1 | `npm run readings`、`node --test lib/test/readings/` | **pass（字节码口径，表/索引分报、不相加）**。perView（表开/索引开）：overview=**0/0**；agents=1/0；board=1/1；gaps=1/1；pm_gaps=1/1；**pm_queue=3/4**；其余全 0。红证（均在报告 `redProof` 里，不只单测）：`SELECT * FROM event`=1/0、UNION 两份=2/0、`max(at)`=0/1（只走覆盖索引）；变异演示：gaps 复制成两份 ⇒ 表开 **1→2**。单测固化 `pm_queue {3,4}`、`max(at) {0,1}`。`pm_queue` 有 **4 个事件访问点**：baseline `e`（索引+表）、内层 `MAX(x.at)`（**唯一的覆盖索引、无表游标**）、change.applied `e`（索引+表）、lease（索引+表）；`eventIndexOpens=4` = ix_event_kind_at×3 + ix_event_subject_at×1（同一访问点的索引段与表段各计一次，**不要相加**）。属 D-022/D-023 观察项。 |
| E2 | C2 | `npm run readings` | **pass**。13 个视图全量：每视图同进程两次 `JSON.stringify` 相等=true，且**两个独立 node 子进程** stdout 互比相等、再与父进程结果逐字节相等=true（每视图 childA/childB 都 exit 0）；另断言结果形状：每视图 `result.view` 等于视图名且 `miss` 不存在（防“13 视图全 miss 也相等”假 pass），`shapesOk=true`；perView 表见 `plan/milestone/M0-读数.{json,md}`。 |
| E3 | C3 | `npm run readings` | **pass**。3 次 `query()` ⇒ `access.log` 3 行；裸连接改 `task.title` ⇒ `runtime_inconsistent table=task objectId=TASK-1 detail=column title differs`；坏 hash 链 ⇒ `event_hash_mismatch objectId=e-m0g-2`；报告无归因结论。 |
| E4 | C4 | `npm run readings` | **partial（显式标出）**。写入夹具后先 `verify` 自证合法：`ok=true`、`eventCount=9`、`problems=0`；3 条 `query_miss` 经 `gaps`（reviewer）聚合出 2 组：overview=2、gaps=1，total=3；**生产写入路径缺**（`src/query/miss.ts` 默认 no-op，M1 写网关，D-012）。 |
| E5 | C5 | `ls plan/milestone/`、`node scripts/m0-readings.mjs` | 产出 `M0-读数.json` + `M0-读数.md`；`package.json` 增 `"readings": "npm run build && node scripts/m0-readings.mjs"`；md 每条读数带命令与原始输出（perView JSON、R3 problem、R4 rows/verify）；退出码：任一 `fail` ⇒ 非 0，由纯函数 `scripts/readings/verdicts.mjs` 的 `exitCodeFor(verdicts)` 实现，单测覆盖 `fail⇒1`/`partial⇒0`/全 pass⇒0；另 `test/readings/artifacts.test.ts` 重跑读数并断言 JSON/MD 不含字符串 `undefined`。 |
| E6 | C6 | `git diff f37f4dc --name-only -- docs design probe` | 空（冻结区零改动）。 |

## 判定

手工（M0 尚无 baseline），按上表实测：

| 读数 | verdict | 依据 |
|---|---|---|
| R1 event 游标打开次数（结构） | **pass** | overview `{eventTableOpens:0, eventIndexOpens:0}`（≤1 上界成立）；红证表开 1 vs 2、变异 1→2；pm_queue={3,4}，与 4 个事件访问点的关系见 E1 与报告 |
| R2 as_of 逐字节相同 | **pass** | 同进程 + 跨进程 stdout 均逐字节相等 |
| R3 探针/verify | **pass** | access.log 3 行；投影直改/事件 hash 改都由 `verify` 发现；无归因 |
| R4 gaps 聚合 query_miss | **partial** | 视图侧聚合已通；生产写入路径属 M1（D-012），不标绿 |

**结论：3 条达标 + 1 条部分达标（R4）。** R4 的缺口不是实现 bug，是 M0 范围（只读、无写网关）；是否接受“视图侧已通、写入路径 M1 补”由人签（见「待确认」）。

## 协作偏差

- 本卡不动 `src/**`：四条读数全部通过公开入口（`query()`/`verify()`/裸连接夹具）取证，没有为了测量改任何产品代码。
- 台账行 D-022（R1 观察项：`pm_queue`/`board` 的常量倍数事件访问）与 D-023（R1 边界：结构打开次数 ≠ 运行期行访问数）由 **Lead 记录**，本卡只在报告/卡内引用，不自行改 `plan/03` 的语义。
- `plan/03` 写进 write_scope，是因为这两行需要与本卡的读数口径同源。
- Lead 直接改的两处（记录在此）：`scripts/readings/fixtures.mjs` 的 `withTempDb` 把 `openSdoDatabase` 移进 `try`（open 抛错时临时目录也要清）；`plan/03` D-022 的旧文本口径补“已废弃”说明。

## 评审

| 轮 | 结论 | 要点 |
|---|---|---|
| 第 58 轮 | **改完再审**（2 P1 + 5 P2） | P1-1：R1 数的是 `EXPLAIN QUERY PLAN` 文本里的 `event` 子串——`agents` 的 `SCAN e` 漏计、`board` 的 `MATERIALIZE task_events` 假阳性；P1-2：N+1 红证是两条独立子查询凑出的常量 2，属自证。改法：换字节码口径（`OpenRead/OpenWrite` 且 `p2 = event.rootpage`），红证改真倍数（单表 1 / UNION 2）+ 视图变异演示 |
| 第 59 轮 | **收卡**（无 P0/P1，5 P2） | 字节码口径成立（与别名/CTE 无关，评审独立打印字节码核对 `p2=73`）；余 P2：生成物红证写着 `undefined`、`pm_queue` 归因写错、`max(at)` 只在单测里、R2 缺形状断言、退出码无测试 |
| 第 60 轮 | **可签** | 5 个 P2 逐条复核成立；独立复跑 `overall=partial`、`npm test` 249/249、`node --test lib/test/readings/` 3/3；残留 3 个 P3（早期口径说明、`withTempDb` 的 open 未进 try、`artifacts.test.ts` 会重写生成物），前两个已修 |

## 收口

- [x] 四条读数实测并写进报告（3 pass + 1 partial，R4 显式标 partial）
- [x] 评审三轮（58 改完再审 → 59 收卡 → 60 可签）
- [ ] 人签（M0 门）——等签署者确认
- [x] 台账无新增 gap（D-022/D-023 为 Lead 记录的观察项，本卡引用不新增 gap）

## 待确认

- 人确认复述（收卡前）
- 若 R4 只能“部分达标”：是否接受“视图侧已通、写入路径 M1 补”，还是要求 M0 内补 `query_miss` 写路径
