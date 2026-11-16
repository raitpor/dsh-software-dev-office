---
id: M3-G
seq: 35
milestone: M3
owner: impl-core
write_scope: [scripts/, test/readings/, package.json, plan/milestone/, plan/cards/M3-G.md]
status: done
created_at: 2026-11-15
---

# M3-G · M3 里程碑读数门（§16.4 三条判死 + M2 遗留）

## 意图

不写功能，只把 `docs/09` §16.4 三条判死读数与 M2 遗留项做成**可复跑证据**（`npm run readings:m3`），报告交人签。M2 遗留：R5 人类样本（M3 影子期采集）、`gate` 表命名（M2-2 已落 `stage_run`，若 M3 建表须复跑 R7）。

## 对齐

**复述**：读数必须是测量不是断言：每条给命令、原始输出与数据来源（哪条事件/哪次真实调用），并配变异红证（改注入点 ⇒ 该条变红）。样本不够就报 partial，不许凑数。三条判死读数：①两人并发改同一字段 ⇒ 一成一败（409），`conflicts` 可见双方主张；②版本冻结独立性不成立 ⇒ 门禁红；③撤销权限后待审项消失且显示申请入口。

**人确认**：pending

**正例 2**
1. R1 并发写：两独立进程同时改同一字段 ⇒ `{ok:1, conflict:1}`，`conflicts` 1 行且双方主张可见。
2. R3 撤权：撤销 `decide@release` 后待审项 1→0 且 `apply_entry` 可见（页面渲染断言）。

**反例 1**
- 任一条只写“已验证”而无原始输出 ⇒ 该条不算取证。

## 判据

| # | 判据 | 怎么验 |
|---|---|---|
| C1 | 三条判死读数各一条，带 `{id,question,command,raw,verdict,caveat}` | 生成物结构断言 |
| C2 | 每条能指出数据来源（事件 id / 调用路径） | 脚本字段 + 人工可核 |
| C3 | 变异红证：至少 R1/R2/R3 各一条（改注入点 ⇒ 该条变红） | 变异记录进卡 |
| C4 | 两遍除时钟字段、产品随机 id、R1 竞态赢家外逐键一致（归一化只用于两遍比较；单遍仍断言真实 actor 与值） | 脚本断言 + `comparable()` 注释 |
| C5 | 不写生产库、不写仓库：树快照前后一致（含 `~/.local/state/sdo`） | 断言 |
| C6 | M2 遗留：R5 人类样本若 M3 内采集 ⇒ 重出读数，否则仍 partial 并写明 | 卡记录 |
| C7 | 树冻结后单次取证，时点写进卡 | 卡 E 行 |
| C8 | 冻结区零改动 | `git diff f37f4dc -- docs design probe` 为空 |
| C9 | R2 的“门禁红”= `verdict=changes_requested` 且带 `independence_unsatisfied`；单签失败仍落 1 条判定事件（判定历史是证据，M2-2 语义），不要求 0 行 | 生成物字段 + 卡 E1 |

## 假设

| # | 假设 | 状态 | 依据 |
|---|---|---|---|
| A1 | 三条判死读数口径以 `docs/09` §16.4 为准，不自定义 | confirmed | 文档原文 |
| A2 | R1 用两个独立进程（真并发），不用同进程模拟 | confirmed | 与 M2-G 的“真进程”口径一致 |
| A3 | R5 人类样本只能在影子期采集，M3 内不造假 | confirmed | D-082 |
| A4 | 复用 M1-G/M2-G 的 `verdict/caveat` 结构与脚本骨架 | confirmed | `scripts/readings/` |

## 预览

新增 `scripts/m3-readings.mjs`、`scripts/readings/m3/*.mjs`、`test/readings/m3.test.ts`、`package.json` 的 `readings:m3`、`plan/milestone/M3-读数.{json,md}`；不改 `src/`。

## 准入

- [x] 前置卡 M3-0…M3-6 全部收卡（M3-2/M3-5 已在树上）
- [x] 写域在团队分工之内（`scripts/`、`test/readings/`、`package.json`、`plan/milestone/`、本卡）
- [x] 已读冻结区：`docs/09` §16.4、§14 验收读数、S10/S19 的遗留条

## 证据

| # | 时点 | 命令 / 动作 | 读数 |
|---|---|---|---|
| E1 | 2026-11-16 09:52 +08 | `npm run readings:m3` | `overall=partial`，`{R1:pass,R2:pass,R3:pass,R4:partial}`；R1 `ok_count=1/conflict_count=1`、`conflicts_view_rows=1`、winner/loser actor 与值均可读、detected actor=loser、`stored_clause===JSON.parse(winner_value)`（F1）；R2 B1(dual_human) 绑 stage、B2(solo) 成为链头后单签仍 `changes_requested + independence_unsatisfied`、`freeze_signers=2`、双签 `pass`、`baseline_row_hash===preview.hash`、链头=`B2`、单/双 gate 事件与 freeze 决策行回查存在（F3/F4）；R3 before `{rows:1,apply_entries:0,page_has_apply:false}` → after `{rows:0,hidden:1,apply_entries:1,apply_scopes:['release:R-3'],page_has_apply:true}`，页面撤权后无“要我决定”（F2）；R4 `human_samples=0` ⇒ partial。生成 `plan/milestone/M3-读数.{json,md}` |
| E2 | 2026-11-16T09:58+08:00（树冻结后） | `npm test` / `make all` | `npm test` **983/983** pass（0 fail）；`make all` **EXIT 0**：docs ✓（18 规则，18 篇）、probe PASS 25 / GAP 0 / FAIL 0、design ✓（无漂移）、plan ✓（76 篇表列一致） |
| E3 | 2026-11-16 09:54 +08 | `git diff f37f4dc --name-only -- docs design probe` | 0 行；`git status --porcelain plan/milestone/` 只有本卡新增的 `M3-读数.{json,md}`（未跟踪、不提交） |
| E4 | 2026-11-16 09:52 +08 | 变异红证（同一 bash 调用内改→跑→恢复） | ①R1 worker 删 `field/base_hash` CAS 声明 ⇒ R1 `fail`（`conflict_scope_undeclared`，ok=0 conflict=0）；②R2 counterSign 改同一 actor ⇒ `fail`（`freeze_signers=1`、dual=`changes_requested`）；③R3 跳过撤权 UPDATE ⇒ `fail`（after `rows=1,filtered=false`）；④**F1** 让最终 `spec.clause` 停在 `v0`：旧判据仍 `pass`（假绿复现），新 `stored_clause===winner_value` 判据下 `fail`；⑤**F2** 去掉 `read@domain:pm`：`before.page_has_apply=true` ⇒ R3 `fail`；⑥**F3** 把 `src/core/independence/verify.ts` 的 `baselineAssuranceBound` 改成无视绑定 hash、永远返回链头 assurance ⇒ R2 `fail`（single=`changes_requested`、dual=`changes_requested`、`counter_sign_ok=false`、`freeze_signers=**1**`；B1 绑定版本被 B2 `solo` 覆盖），恢复后 R2 `pass`（signers=2、dual=`pass`）。全部恢复后三读数 `pass` |
| E6 | 2026-11-16T09:58+08:00（树冻结后单次取证） | `npm run readings:m3`（冻结后复跑） | `overall=partial`，`{R1:pass,R2:pass,R3:pass,R4:partial}`；`generatedAt=2026-11-16T01:58:27.817Z`；生成物 sha256：`M3-读数.md` `38f12b81d19edbbec17c5de3511ae93321cddbcdc8a13b6b9c77d1d752d0cc7c`、`M3-读数.json` `63f61b7951d1ccd9605fbb689e7f344372c315db9da8aea1009844de2f30bfa4`；`git diff f37f4dc -- docs design probe` 0 行；`plan/milestone/` 只有本卡新增两文件 |
| E5 | 2026-11-16 09:53 +08 | `node --test lib/test/readings/m3.test.js` | 1/1 pass（约 4.5s）：两遍比较（含 `started_at` 时钟归一）、结构、R1 数据来源与落库值、R2 baseline 行 hash/双 gate 事件 id/两版 baseline、R3 attention_id 与撤权迁移、树快照、overall 最差 verdict |

## 判定

**手工判定（M2 之前不绑 baseline）**：
- C1 pass：R1–R4 均带 `{id,question,command,raw,verdict,caveat}`；`test/readings/m3.test.ts` 断言结构、command 指向真实入口。
- C2 pass：R1 raw 有 `winner_event_id`/`conflict_detected_event_id`/`conflict_row_id`/双方 actor 与值/最终 `stored_clause`；R2 raw 有 `baseline_hash`/`baseline_row_hash`/`second_baseline_hash`/`freeze_decision_id`/单双签 gate 事件 id；R3 raw 有 `attention_id`/前后队列数字/撤权行数/申请条目 scope；测试对上述 id 做“存在且非空”断言。
- C3 pass：R1/R2/R3 各一条变异红证（E4），均在同一 bash 调用内改/跑/恢复，复跑绿。
- C4 pass（口径见 D-115/D-116）：两遍除 `generatedAt`、`started_at`（墙钟屏障后的进程启动时刻）、产品随机 id、R1 竞态赢家外逐键一致；随机 id 是 C2 要求写出的数据来源，R1 赢家是竞态结果。F1 的“落库值==赢家值”等式在归一化中保留（不满足时归一成 `<MISMATCH:...>`）。
- C5 pass（边界见卡「已知边界」与 D-116）：测试前后对仓库树与 `~/.local/state/sdo` 做文件集合+大小+mtime 快照，deepEqual 通过；全程 `mkdtemp` 新库，不连生产库。本机 `~/.local/state/sdo` 不存在时快照只到 `{exists:false}`，能抓“新建生产目录”但抓不到既有目录内容变化；快照跳过 `lib`/`dist`（构建产物）。`npm run readings:m3` 默认会写 `plan/milestone/`，C5 的“不碰仓库”只由测试 `--out` 保证（D-111 同类）。
- C6 pass：`R4` 读 `plan/milestone/M2-读数.json`，`human_samples=0` ⇒ partial + caveat，不改 pass。
- C7 pass：树冻结（`make all` 绿、`git status` 仅本卡新增文件）后单次取证，时点见 E1。
- C8 pass：E3 冻结区 0 行。

## 评审

| 轮 | 判决 | 要点 |
|---|---|---|
| 第 2 轮 | 改完再审 | 复认指出两处“报的改法在代码里不存在/数字不准”，已真做：P2-1 `canonicalizeRace` 改为先算 `JSON.parse(winner_value)===stored_clause`，相等才归一到 `<winner-value>`、不等归 `<MISMATCH:…>`；新增篡改用例（单遍改 `stored_clause` ⇒ 两遍不得相等），并实测“无条件覆盖”变异下该用例红、正确实现下绿。P2-2 F3 变异按实测改卡：`baselineAssuranceBound` 改成永远取链头 assurance 时 R2 `fail`、`freeze_signers=1`、`counter_sign_ok=false`、single/dual 均 `changes_requested`（此前卡面误写 2）。P3：R2 三个 id 回查事件/决策行存在（`*_event_checked`/`freeze_decision_row_checked`）；测试直接断言 `stored_clause===JSON.parse(winner_value)`、`winner_event_id===spec_revised_events[0]`；`winner_event_id` 脱节时归一成 MISMATCH。 |
| 第 1 轮 | 改完再审 | 评审 F1（R1 未断言落库=赢家值）/F2（R3 页面前置申请入口）两点假绿，已修：F1 加 `stored_clause===JSON.parse(winner_value)` 并让归一化保留等式；F2 夹具补 `read@domain:pm`、pass 改“迁移”并断言 after 入口 scope=`release:R-3`。应做项：F3 加 B2(solo) 链头负例并实测“`baselineAssuranceBound` 取链头 ⇒ R2 红”（实测 `freeze_signers=1`、single/dual 均 changes_requested、`counter_sign_ok=false`）；F4 补 R3/R2 数据来源与 baseline 行回查断言；F5 caveat 补 C5/墙钟/默认写仓库三条边界；F6 写明快照跳过 `lib` 的理由。另：D-114 单签仍落 1 条 `gate.judged`（按实测）、D-113 撤权无事件入口、隐藏计数泄露由 M3-7 修（本次测量已无计数，`hidden_count_leak=false`）。 |

## 已知边界

- **撤权目前只有列级表示**（D-113）：`src/` 没有 `right.revoked` 事件 kind，也没有撤销写入口；R3 用同库写者直接 `UPDATE scope SET revoked_at=…` 触发生产读路径（`dbRightsPort` + `readReviewQueueAccess` + 控制台渲染）。v2.1/M4 补事件入口后口径不变，只是改成经网关写入。
- **单签失败仍落一条判定**（D-114）：R2 的“门禁红”读作 `changes_requested` + `independence_unsatisfied`，`gate_judged_after_single=1` 属预期；要“失败不落判定”得另开实现卡改 `src/db/gate.ts`（不在本卡写域）。
- **两遍一致性的归一化**（D-115）：产品事件 id 用 `randomUUID`、R1 赢家是竞态结果，故 `comparable()` 剔除随机 id 并把赢家角色归一；单遍断言仍检查真实 actor 与双方主张可见。R1 墙钟屏障（`startAt=Date.now()+1200`）不是冻结时钟，两进程是否真重叠依赖机器速度（raw 带 `started_at`）。
- **C5 快照边界**（D-116）：本机 `~/.local/state/sdo` 不存在 ⇒ 只断言 `{exists:false}`，能抓“新建生产目录”但抓不到既有目录内容变化（且只比 size+mtime）；仓库快照跳过 `lib`/`dist`（构建产物，非读数写仓库的证据面）。
- **readings 默认写仓库**（D-117）：`npm run readings:m3` 默认写 `plan/milestone/M3-读数.*`；C5“不碰仓库”由测试用 `--out <tmp>` 保证，与 D-111 同类坑。
- R4（M2 遗留 R5）在 M3 内无人类样本 ⇒ 如实 partial（A3/D-082），留给 M3 影子期。

## 收口

- [ ] 判据全绿（裁判权在 reviewer）
- [x] 证据行填实测读数
- [x] 偏差进 `plan/03-偏差台账.md`（D-113/D-114/D-115）
- [ ] 复述经签署者确认（`plan/sign/`）

## 待确认

- [x] **已定（2026-11-15）**：三条判死读数不依赖 M3-6，但 R1 依赖 M3-2、R3 依赖 M3-5，故读数门仍排在最后取证。
