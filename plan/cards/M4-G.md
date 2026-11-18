---
id: M4-G
seq: 45
milestone: M4
owner: impl-core
write_scope: [scripts/m4-readings.mjs, scripts/readings/m4/, test/readings/, plan/milestone/, plan/cards/M4-G.md, plan/03-偏差台账.md]
status: done
created_at: 2026-11-16
---

# M4-G · 里程碑读数门（§16.5 四条判死读数）

## 意图

M4 的判死读数不是“功能演示”，而是四个**能被别人复算**的数：同文件并发写一成一败、一次派发的 `agent.pick_declined ≤ 1`、连续 3 次新起告警进 `gaps`、预占期认领者必须等于 `reserved_by`（绕过次数应为 0）。外加两条 M3 遗留：R4 人类签字样本（M4-6 供数）、`gate` 表命名（M2-2 的判定实际落 `stage_run`，本门按“两种名都探测”处理）。本卡只做取证，不改产品代码。

## 对齐

**复述**：四条读数 + 两条遗留，全部用**真进程/真库**取证；每条读数必须能被独立复跑（同一命令、同一种子、除时钟与产品随机 id 外逐键一致）；读数默认写仓库但**不得覆盖已签生成物**（D-117）；树冻结后单次取证，生成物哈希进签字记录。

**人确认**：confirmed（S39）

**正例 2**
1. 四条读数里 **R2/R3/R4 三条 pass**，**R1（C1）照实判 partial**——R1 的两进程冲突实际命中的是主树**根锁**（`ROOT_PREFIX=''`，D-135 设计），路径前缀粒度未被这条读数覆盖；第 4 条的“绕过次数 0”是事件级现算，`verify` 只作旁证。
2. 任一读数不达标 ⇒ 门外报告 `fail`，不写“大体通过”。

**反例 1**
- 把“一成一败”用同进程 Promise 模拟出来 ⇒ 视为假读数（并发必须是两个独立进程）。

## 判据

| # | 判据 | 怎么验 |
|---|---|---|
| C1 | R1 真路径同文件并发写：两个独立进程各建工作副本、写同一主树路径后同时 admit ⇒ 恰 1 成 1 败（`lock_conflict`）、争用期活锁 1 行、**主树文件字节 = 赢家写入内容**（从文件系统读回）；另测不相交路径，若仍被主树根锁串行化则照实 partial（C1 证据来自根锁，路径前缀粒度未被覆盖） | 读数 + 两份 raw；变异：`beforeRewrite` 释放根锁 ⇒ 不再恰 1 成 1 败 ⇒ fail |
| C2 | R2 `agent.pick_declined`：一次派发 ≤ 1 条；给出该派发的 `dispatch` 区间与计数；变异：造 2 条 ⇒ 红 | 读数 + 变异 |
| C3 | R3 连续 3 次新起 ⇒ `gaps` 有 `spawn_streak` 行（`count>=3`）；2 次 ⇒ 无；变异：把阈值改成 4 或删告警 ⇒ 红 | 读数 + 两向变异 |
| C4 | R4 预占：预占期 `task.claimed.actor` 与 claim 前 `task.assigned` 的 `reserved_by` 事件级逐条比对，绕过=0；`verify` 仅旁证（其 `lease_actor_mismatch` 量 claim/租约 actor，不是 `reserved_by`） | 读数 + 事件级 claims[]；变异：伪造 bob 在 alice 预占下 claim ⇒ bypass=1 ⇒ fail |
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
| A2 | R4 的“每日 `verify` 报”在 M4 用**一次** `verify` 输出代替“每日”，且 `verify` 只作旁证（事件级 `reserved_by` 比对为主判据）；raw 写明“不是连续多日观测” | confirmed | 第 1 轮评审后按 P2 收窄；raw 的 `observation`/`verify_scope_note` 字段写明 |
| A3 | 人类样本不足 5 条时，本门 overall 只能是 partial（不许为了过门去催样本） | confirmed | S19/S29 口径 |

## 预览

`scripts/m4-readings.mjs` + `scripts/readings/m4/{helpers,r1,r2,r3,r4,legacy,index}.mjs`、`test/readings/m4-g.test.ts`（避免与 M4-7 既有 `m4.test.ts` 重名）、`package.json` 的 `readings:m4`、生成 `plan/milestone/M4-读数.{json,md}`。

## 准入

- [ ] 前置卡 M4-0…M4-7 全部收卡签字
- [ ] 写域在读数与 milestone 之内（不改产品代码）
- [ ] 已读 `docs/09` §16.5、S29 的遗留清单、D-117

## 证据

| # | 时点 | 命令 / 动作 | 读数 |
|---|---|---|---|
| E1 | 2026-11-18 11:05 | `node scripts/m4-readings.mjs`（树冻结后复跑） | exit 0；overall **partial**；R1 **partial**（S1 pass：恰 1 成 1 败 `lock_conflict`+争用期活锁 1 行 prefix `''`+主树字节=赢家；S2 不相交路径仍撞根锁） / R2 pass / R3 pass / R4 pass / R-legacy1 partial / R-legacy2 partial / R-pick pass / R-human partial；生成 `plan/milestone/M4-读数.{json,md}` |
| E2 | 2026-11-18 11:05 | `npm test`；`make all` | **1146 pass / 0 fail**（18 suites；跑测时不得把日志写进仓库树）；`make all`：PASS 25 / GAP 0 / FAIL 0，design 无漂移，plan 102 篇通过 |
| E3 | 2026-11-18 11:05 | `node --test lib/test/readings/` | **28/28 pass**（含 M4-G 7/7；C7 两遍 `--out` 临时前缀，**归一化后** `deepEqual`——差异仅 `generatedAt`、R1 竞态字段与嵌套 `R-human.raw.generatedAt`；R1 归一化把 card/value/main_tree_bytes 归为 `<winner>/<loser>` 与 `<bytes>`，并断言 S1 字节=赢家；R2 `dispatch_id` 确定性） |
| E4 | 2026-11-18 11:05 | `sha256sum plan/milestone/M[0-3]-读数.* plan/milestone/M4-读数.*` + 测试 C8 前后比对 | M0–M3 8 文件哈希跑测前后逐字节不变（M0 json `c4ce083b…`、md `e1e5ca2d…`；M1 json `72fdba30…`、md `88011437…`；M2 json `ac6c2bdd…`、md `c066d47c…`；M3 json `63f61b79…`、md `38f12b81…`）；M4 生成物 sha256：json `b0cc6be9…`、md `8aab53df…` |
| E5 | 2026-11-18 11:05 | `git diff --stat f37f4dc -- docs design probe`；`git status --short` | 冻结三区无差异（0 行）；工作树 14 项改动/新增全部在写域：`scripts/m4-readings.mjs`、`scripts/readings/m4/*`、`test/readings/m4-g.test.ts`、`plan/milestone/M4-读数.*`、本卡、台账 |

## 判定

| # | 判定 | 依据 |
|---|---|---|
| C1 | partial | S1：两个独立 node 子进程各自 `createWorkcopy`→写主树 `src/app.ts` 不同内容→commit→READY/START 后同时 `admitWorkcopy`；恰 1 胜 1 败（败者 `lock_conflict`，`path prefix . is held`）、争用期 `lock` 活锁 1 行（`path_prefix=''`）、主树字节 `winner-b`=赢家内容、`snapshot.taken`/`workcopy.removed` delta 各 1。S2 `src/app.ts` vs `docs/x.md` 在赢家持根锁窗口内（`beforeRewrite` 等父进程 900ms）放行第二进程，仍 1 胜 1 败（`lock_conflict`）⇒ 照实 partial：产品 `admitWorkcopy` 在 merge 前只取主树根锁（ROOT_PREFIX=''），**C1 证据来自根锁，路径前缀粒度未被这条读数覆盖**。变异 `M4_G_MUTATION=R1` 在 `beforeRewrite` 释放根锁 ⇒ S1 不再同时满足“恰 1 成 1 败+活锁”，verdict fail；红因可能是 `dirty_main_tree` 或锁窗口不稳下的 `lock_conflict`，raw `mutation_red_reasons` 照实记录，不冒充锁冲突。 |
| C2 | pass | R2：`dispatch_id=lease-CARD-M4G-R2-…-worker-r2`、窗口 `from=2026-11-17T10:00:01Z`、`pick_declined_in_dispatch=1`；变异造 2 条 ⇒ count=2、verdict fail、exit 1 |
| C3 | pass | R3：3 次新起 ⇒ `gaps.spawn_streak` count=3；2 次 ⇒ 无行；变异阈值改 4 ⇒ 3 次场景不满足、fail |
| C4 | pass | claim 前 `reserved_by='alice'`；`claims=[{actor:'alice', reserved_by_before_claim:'alice', bypass:false}]`、`bypass_count=0`；`verify_ok=true`、`verify_problems=[]`，raw 明文写 `verify` 的 `lease_actor_mismatch` 量 lease/claim actor、**不是 reserved_by**。变异注入伪造 `task.claimed` bob（绕过产品写路径，检验读数的事件级比对）⇒ `bypass_count=1`、`claims[0].actor='bob'`、verdict fail；verify 另报 `event_hash_mismatch`/`runtime_inconsistent` 作旁证。 |
| C5 | partial | `M4-人类样本.json` 0 条、distinct_decisions=0，故 M2 R5 / M3 R4 维持 partial；overall partial。按 A3 不造样本 |
| C6 | partial | 两表名探测：命中 `['stage_run']`，`gate_table=false`；M2-2 判定落在 `stage_run`，按 C6 记 partial + caveat，未伪造 `gate` |
| C7 | pass | C7 用例两遍 `--out`：归一化后 `deepEqual`；R1 按场景归一化 `card/value/expected_path/main_tree_bytes`（`<winner>/<loser>`、`<path>`、`<bytes>`），赢家身份与路径身份不参与相等比较；S2 用 S1 同款 hold 屏障+900ms 窗口保证每次都能观测到根锁串行化，事件计数稳定；`generatedAt` 为唯一剔除字段。 |
| C8 | pass | 测试全部用 `--out` 临时前缀；脚本默认写 `plan/milestone/M4-读数`；C8 用例断言跑测前后 M0–M3 8 个生成物 sha256 数组完全相等 |
| C9 | pass | 树冻结时点 **2026-11-18T11:05:13+08:00**；冻结后复跑 `node scripts/m4-readings.mjs`（exit 0）、`node --test lib/test/readings/`（28/28）、`npm test`（1146/1146，18 suites）、`make all`（PASS 25/GAP 0/FAIL 0，plan 102）；生成物 sha256（以提交物为准）：`M4-读数.json` `8ed959edb0193f7853ebd716d21ac567b2e6004008e89cb3cb7df5d833e7ff8b`、`M4-读数.md` `9ddf4610ade336ebe77aad2228bd17de5a1aec56e121fe6a75ce83389a5364aa`；冻结区 0 行。取证时脚本另跑过两遍（`b0cc6be9…`/`8aab53df…`、`860376ba…`/`062f6c92…`），两次的差异**只在** `generatedAt` 与 R1 竞态字段（赢家、`lock_rows_during[].card_id`）与嵌套 `R-human.raw.generatedAt`，C7 用归一化比较并先断言 `stored=winner` |
| C10 | pass | `git diff f37f4dc -- docs design probe` 为空 |

**overall = partial**：四条产品读数中 **R2/R3/R4 pass**，**R1 判 partial**——R1 的两进程冲突实际命中的是主树**根锁**（`ROOT_PREFIX=''`，D-135 设计），所以“路径前缀粒度”这条未被读数覆盖，C1 照实降 partial（不是把 pass 改写成 pass-lite，而是这条读数确实只说清了一部分）；另加人类签字样本 0 条（C5）与 `gate` 表命名（C6）两条遗留 partial。按 A3 与 M3-G 同口径，不足以判 pass。

## 协作偏差

| # | 偏差 | 处置 |
|---|---|---|
| 1 | `test/readings/m4-g.test.ts`（卡预览原写 `m4.test.ts`） | M4-7 已有 `test/readings/m4.test.ts`（R-pick/R-human 全跑断言），同名会覆盖/冲突；改名并在卡预览/写域覆盖范围内 |
| 2 | R1 改为真文件路径：workcopy（`createWorkcopy`→写 `.work/<card>/src/app.ts`→`commitWorkcopy`→`admitWorkcopy`） | 第 1 轮评审 P1：`config.changed` 不是“同文件”；`spec.revised` 需 intent/decision 整链，`publicface` 只落事件无文件路径，故选 workcopy。S2 发现 `admitWorkcopy` 只取主树根锁（D-135），不相交路径也串行化 ⇒ C1 记 partial 并按卡要求写明“证据来自根锁”。 |
| 3 | R4 主判据改为事件级 `actor` vs claim 前 `reserved_by`，`verify` 仅旁证 | 第 1 轮评审 P2：`lease_actor_mismatch` 量的是 claim/租约 actor，不对 `reserved_by`；变异改为注入伪造 `task.claimed` bob（绕过写路径），读数按 `claims[].bypass` 判红。 |
| 4 | `--only` 的 exit code 改为 fail ⇒ 1，partial/pass ⇒ 0 | 便于变异用例断言红；全量 `overall` 仍由 `overallFor` 决定（partial 时 exit 0，与 M3-G 一致） |

## 评审

| 轮 | 判决 | 要点 |
|---|---|---|
| 自检 | — | 派工前由 Lead 写判据与假设 |
| 第 1 轮 | 改完再审 | 1 P1（R1 用 `config.changed` 冒充“同文件写”）+ 1 P2（R4 的绕过计数没对 `reserved_by`）+ 3 P3；返工后 R1 改真 workcopy 主树文件、S2 证明命中根锁 ⇒ C1 降 partial；R4 改事件级 |
| 第 2 轮（delta） | 可提交 + 1 P2 | R1/R4 机制闭合、S2 降级诚实、变异红因如实记录；P2=卡面 overall 仍写“四条全 pass”（Lead 已改）；P3=R4 pass 条件硬编码夹具名（已改为事件级） |
| 第 3 轮（收口确认） | 改完再审 → 已修 | 卡面三处“四条全 pass”表述（`:24`/`:88`/`:95` 待确认前提）、冻结树未提交、C9 哈希与提交物不符、“same except generatedAt”表述不准（实际还有 R1 竞态字段与嵌套 generatedAt）⇒ 全部修：卡面改“3 pass + C1 partial”、哈希改提交物、C7 写“归一化后一致” |

## 收口

- [x] 判据全绿（裁判权在 reviewer）——第 2 轮 delta 可提交
- [x] 证据行填实测读数（E1–E5，冻结后时点）
- [x] 偏差进 `plan/03-偏差台账.md`（D-213…D-221）
- [x] 复述经签署者确认（`plan/sign/S39.md`，2026-11-18T11:20）

## 待确认

- [ ] **R4 用一次 `verify` 代替“每日报”**（我的倾向：可以，但报告里必须写明是单次观测；真要“每日”就得等连续几天，那会拖门）。
- [ ] **人类样本不足时的门判决**（我的倾向：overall partial 但可以进 **M5（插件化与接管）**——范围见 `plan/00` M5 段（先插件化 adapter → 再评审可安装性与功能满足性 → 通过才装进本 dsh 实例 → 用 SDO 跑本项目的卡）；前提改为“R2/R3/R4 三条产品读数 pass + C1 的根锁/路径粒度缺口已记账”，与 S19/S29 同口径）。
