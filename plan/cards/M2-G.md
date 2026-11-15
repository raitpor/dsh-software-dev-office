---
id: M2-G
seq: 26
milestone: M2
owner: impl-core
write_scope: [scripts/, package.json, test/readings/, plan/milestone/, plan/cards/M2-G.md]
status: done
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
| R5 | 单次签字工具侧时长（unlock_wait+sign）中位 ≤10s；**无人类样本 ⇒ partial** | 中位 ≤ 10000ms 且样本 ≥5；`unlock_wait` 有正样本、`sign_ms` 非零 | 用 M2-6 的测量点跑 ≥5 次（TTL=0 ⇒ 每条重新解锁，真墙钟；注入 `signDelayMs=20` 让 `sign_ms` 可观测）；断言**中位**（不是均值）；**没有人类样本**（不含人思考），G4“人签中位 ≤10s”在 M2 不可测 ⇒ verdict 固定 `partial`，等 M3 影子期样本；样本数不足同样 `partial`，不许凑数 |
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
| A2 | 样本量 ≥5：TTL=0 下 5 条各自重新解锁（真墙钟） | confirmed（第 1 轮评审 P1-1 改口径） | 定死为：TTL=0、5 条样本，每条 `createRequest → unlock → confirm`；真实墙钟；注入 `signDelayMs=20` 使 `sign_ms` 可见；raw 记每样本 `unlock_wait_ms/sign_ms` 与正等待样本数；**无窗口连签样本**（TTL=0 本身不需要），caveat 不声称窗口复用 |
| A3 | R7 的“非平凡”断言 = `gate.judged` 行数与 `stage_run` 中已判定的行数一致，且 `verify` 绿 | confirmed | M2-2 的 C2/C6 |
| A4 | 读数脚本不引第三方依赖 | confirmed | 与 M1-G 一致 |

## 预览

- 新增：`scripts/m2-readings.mjs`、`scripts/readings/m2/*`、`test/readings/m2.test.ts`、`package.json` 的 `readings:m2`、`plan/milestone/M2-读数.{json,md}`。
- 会改：`scripts/readings/m1/measure.mjs` 的 R7 段（表已建，断言要改）——**这是唯一允许改 M1 读数的地方**，改前在卡里写明。
- 不会改：`src/`（冻结后更不许改）。

## 准入

- [ ] M2-0…M2-6 全部收卡（读数要量的东西得存在）
- [ ] 复述经签署者确认
- [x] A2 的样本设计定死（第 1 轮评审改为：TTL=0 五条各自重新解锁、真实墙钟、注入 `signDelayMs=20`；无窗口连签样本）

## 证据

| # | 时点 | 命令 | 结果 |
|---|---|---|---|
| E1 | 2026-11-15T10:11+08:00（最终取证） | `npm run readings:m2` | overall **partial**（R5 无人类样本）；R1–R4/R6/R7 pass，R5 partial；生成 `plan/milestone/M2-读数.{json,md}`。R5 raw：`samples=5, decisions=5, per_sample=[{unlock_wait:1,sign:21},{1,20},{1,20},{1,21},{1,21}]ms, median=22ms, unlock_wait_positive=5/5, sign_ms_positive=5/5, human_samples=0`；R1 `awaiting_unlock/0`；R2 `frontier_stale/decisions 1→1/locked`；R3 两例 `no_blind_sign/0`；R4 `not_a_signer/0 decision/security.alert=1`；R6 `ttl0 第二条 awaiting_unlock；ttl5 两连签 decisions=2，第二条 unlock_wait=0`；R7 `gate.judged=1/stage_run=1/verify ok`（R5 数值为实际一次测量，逐样本见生成物） |
| E2 | 2026-11-15T09:17+08:00 | `node --test lib/test/readings/m2.test.js` | tests 1 / pass 1；两遍读数除 `generatedAt` 逐键一致；JSON/MD 无字符串 `undefined`；仓库无新增 `*.db`；`~/.local/state/sdo` 前后一致；字段齐全、verdict 合法 （C1/C4/C6 的自动守卫（不靠人工比对）） |
| E3 | 2026-11-15T09:17+08:00 | R1 变异：`src/sign/signerd.ts` 的 sign 分支短路解锁检查（锁定态自动用夹具口令 `store.unlock`） | `--only R1` ⇒ `{"reason_code":"ok","decisions":1,"events_before":1,"events_after":3}` ⇒ **R1 变红（fail）**；恢复后 `awaiting_unlock/0` （C3 变异红证 #1） |
| E4 | 2026-11-15T09:17+08:00 | R2 变异：`src/sign/window.ts` 的 `checkWindow` 不再比较 frontier（窗口一经签发永久有效） | `--only R2` ⇒ `{"first_sign":"ok","decisions_after_first":1,"second_sign":"ok","decisions_after_second":2,"window_locked_after":false}` ⇒ **R2 变红**；恢复后 `frontier_stale/1→1` （C3 变异红证 #2） |
| E5 | 2026-11-15T09:17+08:00 | R3 变异：`src/sign/page.ts` 的 confirm 不比对提交的 proposition | `--only R3` ⇒ 两例都变成 `awaiting_unlock`（不是 `no_blind_sign`）⇒ **R3 变红**；恢复后两例 `no_blind_sign` （C3 变异红证 #3） |
| E6 | 2026-11-15T09:17+08:00 | R4 变异：`src/sign/decision.ts` 的 `stageDecision` 跳过 agent 拒绝分支 | `--only R4` ⇒ `{"reason_code":"not_a_signer","decisions":0,"security_alert_events":0}` ⇒ **R4 变红（告警没落库）**；恢复后 `security_alert_events=1` （C3 变异红证 #4） |
| E7 | 2026-11-15T10:11+08:00（最终取证） | `make all` / 冻结区 / 全树 | `make all` EXIT 0：docs 17 篇 ✓、probe PASS 25 / GAP 0 / FAIL 0、design ✓、plan 检查通过（56 篇）；`git diff f37f4dc --name-only -- docs design probe` 为空。全树 `npm test` 809 tests / 809 pass / 0 fail（M2-4 已落地、工作树冻结，含 `src/core/review/`、`src/review/` 全部改动）；本卡读数测试 1/1、M2-G 相关全绿 （C7/C8/C10） |
| E8 | 2026-11-15T09:55+08:00 | 变异：`timing.mjs` 的 `SIGN_DELAY_MS` 由 20 改 0 后跑 `node scripts/m2-readings.mjs --only R5` | `median_total_ms` 22→1、`sign_ms` 20–21→0–1（`sign_ms_positive_samples` 2/5）；证明 R5 的数值来自真实注入而不是恒 0/恒 pass；已还原 （P1-1 变异自证） |
| E9 | 2026-11-15T10:11+08:00（最终取证） | `node --test lib/test/readings/m2.test.js` | 1/1 pass：两遍除 generatedAt/R5 墙钟外逐键一致；`overall===partial`（最差 verdict）；两遍比较的豁免显式限定为 generatedAt 与 R5 墙钟派生 4 字段（`per_sample`/`median_total_ms`/`unlock_wait_positive_samples`/`unlock_wait_zero_samples`），其余逐键一致；树快照对仓库根与 `~/.local/state/sdo` 比较 `(相对路径,size,mtimeMs)`（目录不存在也记 `exists:false`）；R5 样本/正等待断言通过 （P1-1/P2-2/P2-3/P3） |
| E10 | 2026-11-15T10:11+08:00 | 最终取证：先 `node scripts/m2-readings.mjs` 重生成 repo 产物，再 `node scripts/m2-readings.mjs --out node_modules/.tmp/m2-run2` 跑第二遍 | 两遍比较：除 `generatedAt` 与 R5 墙钟派生 4 字段（`per_sample`/`median_total_ms`/`unlock_wait_positive_samples`/`unlock_wait_zero_samples`）外逐键一致 = true；7 条 verdict 与上一版逐条相同（R1–R4/R6/R7 pass、R5 partial），无因 M2-4 落地意外变红；overall=partial （C1/C5/C8） |

## 判定

本卡是里程碑门：判定 = 七条读数 + caveat 经核对 + reviewer 收卡 + 人签报告。

- **overall = partial**（R5 无人类样本；overall 取最差值 partial）。
- R1 pass：未解锁 confirm ⇒ `awaiting_unlock`、0 decision；库非空（先经写网关落 task.created 1 条）。变异红证 E3。
- R2 pass：窗口内 frontier 改变后再签 ⇒ `frontier_stale`、decision 1→1、signerd 已锁；不静默续窗。变异红证 E4。
- R3 pass：缺/空 proposition 与伪造 proposition 均 `no_blind_sign`、0 decision。变异红证 E5。
- R4 pass：agent 凭据 confirm ⇒ `not_a_signer`、0 decision、`security.alert` 真落库（event 表计 1）。变异红证 E6。
- R5 **partial**：样本 5（A2 定死），工具侧中位 22ms ≤ 10000ms，**其中 20ms 是注入延迟（`injected_delay_ms=20`）、不是产品耗时**；每样本 `unlock_wait` 1ms（5/5 正等待）、`sign_ms` 20–21ms；**没有人类样本**（不含思考时间），G4“人签中位 ≤10s”在 M2 内不可测，等 M3 影子期，因此如实 partial；5 个样本全部来自 signerd 回执。
- R6 pass：默认 TTL=0 下第二次签要重新解锁（`awaiting_unlock`）；显式 TTL>0 时同批两条一次解锁连签（第二条 unlock_wait=0）。
- R7 pass：`gate.judged` 事件 1 条、`stage_run` 已判定行 1 条、`verify().ok=true`；报告内含“M1 partial（表不存在）→ M2 pass（表存在、非平凡）”对照（`m1_verdict/m1_reason` 由脚本真读 `plan/milestone/M1-读数.json`）。
- **第 1 轮审核处置**（lead m07378，E8/E9）：P1-1 R5 去冻结时钟，用真墙钟 + `signDelayMs=20` 注入，5 样本各自解锁（`unlock_wait` 1ms×5），verdict 固定 `partial`（无人类样本）；P2-1 R7 的 `m1_verdict/m1_reason` 由脚本真读 M1 读数文件；P2-2 零变化断言升级为 `(相对路径,size,mtimeMs)` 树快照（含非 db 文件、目录不存在也记 `exists:false`）；P2-3 caveat 与样本计数一致（TTL=0 无窗口连签样本）；P3 md 文案改“进程内 startSignerd（真 socket+真 client）”、测试补 `overall===最差 verdict`、`command` 断言升级为“入口文件真实存在”；`SKIP_DIRS` 加 `artifacts`/`__pycache__`。
- caveat（诚实）：R5 只证明**工具侧**（unlock_wait+sign）可测且 ≤10s，不含人类思考；G4 的人签时延留 M3 影子期，故 verdict=partial，签字者需在 S19 接受这一点（见台账 D-082）。R7 的 `m1_verdict`/`m1_reason` 由脚本真读 `plan/milestone/M1-读数.json`（不是字面常量）。
- 第 2 轮 P3：R5 raw 增 `injected_delay_ms=20`；22ms 中位含注入延迟，非产品耗时；两遍一致性豁免写明“除 generatedAt 与 R5 墙钟派生 4 字段外逐键一致”。
- A2 的样本设计：**已改口径**（第 1 轮评审 P1-1）：TTL=0、5 条各自重新解锁、真墙钟、注入 `signDelayMs=20`；无窗口连签样本；每样本耗时写入 raw。
- M1 的读数报告要不要因 R7 复跑而“重签 M1 门”？**不重签**：M1 门签的是当时的树；R7 复跑记进 M2 读数与 M2-2 卡（M2-2 已把 M1 R7 的“表不存在”断言改为真查询，这是唯一被授权改 M1 读数的地方）。
- **最终取证（第 2 轮，树冻结）**：工作树冻结于 M2-4 收卡前，含 `src/core/review/`、`src/review/` 全部改动；全树 `npm test` 809/809、`test/core/review` 17/17、`make all` EXIT 0、冻结区 0。最终一遍重新生成 `plan/milestone/M2-读数.{json,md}`：overall 仍 **partial**（R5 无人类样本、措辞未改），7 条 verdict 与上一版逐条相同；两遍除 `generatedAt` 与 R5 墙钟派生 4 字段外逐键一致。
