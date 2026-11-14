---
id: M1-G
seq: 18
milestone: M1
owner: impl-surface
write_scope: [scripts/, package.json, test/readings/, plan/milestone/, plan/cards/M1-G.md]
status: open
created_at: 2026-11-13
---

# M1-G · 里程碑门（七条判死读数）

## 意图

M0 的门解决的是“能不能读、读得对不对”；M1 的门解决的是**“这套东西能不能真的把返工前移”**——`docs/09` §16.2 的七条判死读数就是这个问题的七个可证伪角度。这张卡**不写功能**，只把七条读数做成**可复跑的证据**（脚本 + 生成物 + 一段人签的报告），并且诚实标注哪几条在 M1 只能部分达标。

M0-G 的教训照搬：**读数的测量代码本身就是被测对象**。第一版 M0 R1 数的是 `EXPLAIN QUERY PLAN` 里的字符串，靠 CTE 名凑数，自己给自己发绿；M1 的读数额度更危险——比如读数 ④（分歧前移率）和读数 ⑤（返工数一致）都可以用“自己算给自己看”糊过去。

## 对齐

**复述**：不是“跑七个脚本打七个勾”，而是三件事——① 每条读数都有一条**命令**和一段**原始输出**（不是摘要），任何人拿同一棵树能复跑出同样的数；② 每条读数都写明**它能证到什么、不能证到什么**（比如 ④ 只能证“人能在开工前说出对/不对”，不能证“返工真的少了”）；③ 达不到的读数**不许改口径凑绿**，只能标注部分达标 + 原因，交人签。

**人确认**：confirmed —— Lead（m02863）确认本卡性质为“可复跑证据”并给出三个更新前提（D-038 已 closed、读数②legacy 注册必须 0、读数⑦ 真断言）；读数 ④ 按 A3 降级为“机制可用”已获接受。

**正例 2**
1. `npm run readings:m1` 一次跑完七条，生成 `plan/milestone/M1-读数.{json,md}`；其中读数 ⑦ 的原始输出是 `SELECT count(*) FROM gate` 类表的结果 `0`。
2. 把读数 ⑥ 的 `criteria: []` 再跑一次 ⇒ 输出里 `reason_codes:['gate_empty']` 且 verdict `pass`（读数要求“能拒”，不是“能过”）。

**反例 1**
- 若读数 ① 只报“重建了 20 条”而不给逐条 `claim_id` 与 v1 原值对照 ⇒ 不算达标（无法排伪：可能重建的是空壳）。

## 判据

| # | 判据 | 怎么验 |
|---|---|---|
| C1 | **七条读数各有一条可复跑命令**，脚本一次跑完并生成 `plan/milestone/M1-读数.{json,md}`；每条带 `{id, question, command, raw, verdict, caveat}` | 跑两遍，生成物除 `generatedAt` 外逐字节相同 |
| C2 | ① **`claim` 重建 20/20**：抽 20 条 v1 结论型回执，逐条给 `{claim_no, claim_id, v1 原值, 重建值, equal, frontier_ok}`，汇总 20/20；**证据必须逐条**，不许只报总数 | 脚本内对 20 条逐条断言；**6 列**（subject/predicate/value/derived_by/actor/at）逐字段相等；`as_of_frontier` 不参与 6 列比较，只校验“非空数组且每个事件 id 在 event 表存在”；任一条不等或 frontier 不成立 ⇒ verdict `fail` |
| C3 | ② **无负例 ⇒ 注册被拒**：向**唯一写路径** `append` 一条 2 正 0 反的 `criterion.registered` ⇒ 结构化失败（`materialize_failed`，message 含 `requires fixtures[]`），并在**非空库**上证明失败时一行没写 | 读数主证据走 append；`before.events ≥ 1`（先写合法 task.created）；`registerCriterion` 纯函数返回只作附带证据（`register_api_result`），不作 verdict 依据 |
| C4 | ③ **字段无消费者 ⇒ `dead_field` 红**：`sdo_check --criterion dead_field` 给 `fail` + 列出 `table.column`；再补一条“有消费者”的对照（同列被视图/代码读到 ⇒ `pass`） | 两向都取证（只证红不证绿 = 没法排伪） |
| C5 | ④ **对齐可用**：一个真实意图走完复述 + 2 正 1 反，记录“人第一次说对/不对”的**时点**与当时是否已写代码；分歧前移率 ≥80%（定义写死在脚本里：对齐阶段发现的分歧数 ÷ 总分歧数） | 需要 1 个真实样本 + 计算式；**样本是我们自己的卡**（M1 的卡）不算真实意图 ⇒ 必须标 caveat |
| C6 | ⑤ **返工可见**：每次变更 preview 带 `rework_units`，与事后实际作废数一致（抽样 3 次），逐次给 `{before, preview, actual, equal}` | 3 次抽样，每次**真 append**（D-038 已 closed）；“实际”= 落库后重新 fold 的有效集合差（D-037 口径，非 v1 删除行）⇒ caveat 说明 |
| C7 | ⑥ **静态校验可用**：`criteria: []` ⇒ `gate_empty`；core 三条未有效绑定 ⇒ `core_not_effective`；缺 `engine` ⇒ `engine_missing`（三条各一份夹具文件） | 三份反例文件 + 输出原文；每项断言“期望码必须在 + 允许的伴随码集合 + 不允许的码不得出现”（criteria-empty 实际 `gate_empty+core_not_effective`、core-unbound 实际 `stage_no_gate+core_not_effective`） |
| C8 | ⑦ **判定行零产出**：M1 跑完全部工具后 `gate.judged`（`gate`/`stage_run` 里承载判定的表）行数为 0 | 脚本内 `SELECT count(*) FROM "<表名>"`（表名带引号，防 `gate.judged` 被当 schema.name 解析）；非 0 ⇒ verdict `fail` 并打印行。**实测**：`stage_run` 表存在（真断言 0 行）；`gate`/`gate.judged` 在 migrations 001–005 不存在，按 exists=false + 0 计（M2 建表后必须复跑），caveat 写明。**表名口径**：M2 的判定表叫 `gate` 还是 `gate.judged` 由 M2 卡定；本读数两种名都探测（两种名加引号后计数） |
| C9 | **诚实边界**：报告里逐条写 `caveat`（④ 样本性质、⑤ 对账口径受 D-038 限制、② 只证注册面不证判据本身正确）；**任何一条读数都不许用“配置为真/实现未写”当达标** | 报告人读 + 我逐条核 |
| C10 | 读数脚本不碰生产库：全程临时目录新库，`~/.local/state/sdo/` 不出现新文件 | 跑前后 `ls` 对比 |
| C11 | 冻结区零改动 | `git diff f37f4dc --name-only -- docs design probe` 为空 |

## 假设

| # | 假设 | 状态 | 依据 |
|---|---|---|---|
| A1 | `dead_field` 是**内置硬编码判据**（`docs/04` §2：`security.*`/`release.*`/`dead_field` 随引擎版本，不需项目注册），因此由 `sdo_check` 现算、不进 baseline | confirmed | `docs/04:37`、`docs/04:61` |
| A2 | 读数 ①的 20 条样本 = `test/fixtures/v1-export.json` 里的 20 条 claim（M0-7 已固化） | confirmed | M0-7 卡的 C1 |
| A3 | 读数 ④ 的真实意图样本**不来自本项目**（本项目是工具自身，用它评“分歧前移”是循环论证）；M1 若无真实外部样本，如实标 `caveat` 并降级为“机制可用” | confirmed | 避免自证 |
| A4 | 读数 ⑤ 的“事后实际”在 M1 只能用 fold 重放（D-038） | superseded | **D-038 已 closed**（M1-7 后 `task.*` 可真 append）；本卡 ⑤ 走真 append，口径见 C6 |

## 预览

新增 `scripts/m1-readings.mjs` + `scripts/readings/m1/*.mjs` + `test/readings/m1.test.ts`；`package.json` 加 `"readings:m1": "npm run build && node scripts/m1-readings.mjs"`；生成 `plan/milestone/M1-读数.{json,md}`。读数脚本共用 M0 的 `scripts/readings/{fixtures,count,verdicts}.mjs`（不复制一套）。

## 协作偏差

- **owner 由 impl-core 改派 impl-surface**（2026-11-14，Lead m02863 决定；卡面 `owner` 已改）。
- 卡面 A4 与 C6 的“⑤ 只能 fold 重放”已被 **D-038 closed** 取代：本卡 ⑤ 用真 append 对账，caveat 写清；未改任何口径数字。
- 卡面 C8 说 `gate`/`stage_run` 表在 M1 存在：实测 `stage_run` 存在、`gate` 与 `gate.judged` 不存在（001–005）；按 Lead 要求“不存在也按 0 计、exists=false”，未把不存在当空过。
- 读数②不依赖 v1 导入的 legacy 注册：`legacy_criterion_registrations` 实测 0（导入只写 task.*+claim，M1-6 裁定 E / D-045）；本卡 ② 直接用注册 API 构造 2 正 0 反。

## 准入

- [ ] M1-0/M1-1/M1-2/M1-3/M1-4/M1-5/M1-6/M1-7 全部收卡
- [ ] 人确认复述（收卡前）

## 证据

| # | 时点 | 命令 | 结果 |
|---|---|---|---|
| E1 | 2026-11-14T13:14:52+08:00（树冻结后最终取证） | `npm run readings:m1` | 一次跑完七条；overall **partial**；verdicts `R1 pass / R2 pass / R3 pass / R4 partial / R5 pass / R6 pass / R7 partial`；生成 `plan/milestone/M1-读数.{json,md}`（每条含 `{id,question,command,raw,verdict,caveat}`） |
| E2 | 2026-11-14T13:14:52+08:00（树冻结后最终取证） | 二次 `npm run readings:m1`；`python3` 逐键比对两份 JSON（剔除 `generatedAt`） | 除 `generatedAt` 外**逐键一致**（`identical: True`）；MD 无 `undefined`/`NaN` |
| E3 | 同上 | ① `readings.R1.raw` | `import ok`、`claims_written:20`、`events_written:40`、`claim` 表 20 行；20 条逐条给 `{claim_no,claim_id,v1,rebuilt,equal,frontier_ok}`，`allEqual:true`、`allFrontierOk:true` |
| E4 | 同上 | ② `readings.R2.raw` | 非空库（先 `task.created`，`before.events=1`）上 `append` 2 正 0 反的 `criterion.registered` ⇒ `{ok:false, reason_code:'materialize_failed', message 含 'requires fixtures[]', attempted:1, written:0, rolled_back:true}`；`event 1→1`、`criterion 0→0`（已尝试后回滚、一行没写）；`register_api_result` 只作附带证据（`no_negative_fixture`），**不单独构成 verdict** |
| E5 | 同上 | ③ `readings.R3.raw` | 红：`sdo_check --criterion dead_field` ⇒ `result:'fail'`、fail 列表 **20** 个 `table.column`（`intent.statement` 起）+ **12** 条 info（`why:'no_writer'`）= 32；补 **20** 条 `field_consumer` 后绿：`result:'pass'`（剩 12 条 info） |
| E6 | 同上 | ④ `readings.R4.raw` | 复述 09:00 → 人处置 09:05（d1 accept/d2 accept/d3 reject，**从事件流现算**）→ requirement 09:10；`code_written_at:null`（现查事件链，检查 kind `task.created(payload.kind=implement)`，非字面量）；`alignmentGate ok:true`；分歧 `total:3 / before_code:3 / rate:1`（现算）；verdict **partial**（A3 合成样本，仅证机制可用）。红证：注入 09:03 的代码事件后 `before_code:0 / rate:0` |
| E7 | 同上 | ⑤ `readings.R5.raw` | 两个场景各 3 次真 append：①sole-source `3 → 3 → 3`；②revise-one-of-two-sources `3 → 2 → 2`（作废数不同，排除“恒 3 全等”的常量通过）；每样本 `equal:true`，`invalidatedWorkUnits` 与重算集合逐条相等 |
| E8 | 同上 | ⑥ `readings.R6.raw` | 三份夹具全 hit 且 `unexpected_codes:[]`：`criteria-empty` ⇒ `gate_empty+core_not_effective`；`core-unbound-stage` ⇒ `stage_no_gate+core_not_effective`；`missing-engine` ⇒ `engine_missing` |
| E9 | 同上 | ⑦ `readings.R7.raw` | `stage_run` exists=true rows=0（真断言）；`gate` exists=false、`gate.judged` exists=false（0 行平凡真）⇒ verdict **partial**（不空过）；计数 SQL 统一 `FROM "<表名>"`（防 schema 名解析）；3 个 `sdo_check` 入口均 `preview:true/judged:false/baseline:null`；测试断言“两个表不存在”与 migrations 一致，M2 建表即红逼复跑（表名由 M2 卡定，读数两名称都探测） |
| E10 | 2026-11-14T13:14:52+08:00（树冻结后最终取证） | `npm test`；`npm run typecheck`；`make all`；`git diff f37f4dc --name-only -- docs design probe` | `node --test lib/test/readings/` **8/8**（M1 5 条 + M0 3 条）；`npm test` **621/621**；`npm run typecheck` exit 0；`make all` PASS 25 / GAP 0 / FAIL 0；冻结区 **0 行**；C10 由 `test/readings/m1.test.ts` 用 `HOME=临时目录` + `~/.local/state/sdo` 不存在 + 仓库 `*.db`/`access.log` 前后一致证明 |

## 判定

M1 不绑 baseline，本卡不做机器判定；人工判定 = E1–E10 全绿 + 每条 caveat 经我核对 + reviewer 收卡 + 人签报告。

## 第 1 轮评审修复

- P1-1（R2 量的是纯函数）：R2 主证据改为 `append` 一条 2 正 0 反的 `criterion.registered` ⇒ `materialize_failed` + message 含 `requires fixtures[]`；在**非空库**（先写 `task.created`，before.events=1）上证明前后行数不变；`registerCriterion` 只作 `register_api_result` 附带证据。
- P1-2（R4 关键数字硬编码）：`diff_dispositions` 从事件流现算；`divergence.total/before_code/rate` 现算；`code_written_at` 由事件链现查（检查 `task.created(payload.kind=implement)`，记录 checked kinds）；`test/readings/m1.test.ts` 注入 09:03 代码事件 ⇒ `rate` 从 1 变 0 的红证。
- P2-1 E5 数字按实测改（红 20 + info 12，consumersWritten 20）。
- P2-2 R7 改 `partial`，caveat 写明 gate 表不存在、M2 建表后必须复跑；测试断言 exists=false 与 migrations 一致。
- P2-3 C10：测试把 `HOME` 指向临时目录，断言 `$HOME/.local/state/sdo` 不存在，并对比仓库 `*.db`/`access.log` 前后一致。
- P2-4 R1 卡面改“6 列逐字段 + frontier 只校验事件 id 存在”，measure 增 `frontier_ok`。
- P2-5 R6 改为“期望码必须在 + 允许伴随码 + 不允许码不得出现”。
- P2-6 R5 增第二场景（改 2 条 spec 之一 ⇒ 作废 2 而非常量 3）。
- 重跑：`npm run readings:m1` overall **partial**（④ partial 因 A3；⑦ partial 因 gate 表不存在）。

## 红证（测量代码本身被测量）

- ②：真实反例在**唯一写路径**上（append 2 正 0 反 ⇒ `materialize_failed`），非空库前后行数相等（1→1 event、0→0 criterion）；注册 API 结果只作附带证据。
- ③：同一临时库上先红（32 个 `table.column`）再补 `field_consumer` 转绿，两向都取自 CLI 输出。
- ④：把代码事件注入到处置之前（09:03 < 09:05）⇒ `before_code` 3→0、`rate` 1→0（测试 `test/readings/m1.test.ts` 已固化）。
- ⑤：临时把 `equal` 判定改成 `actualUnits.length + 1` 跑 `--only R5` ⇒ 两个场景全 `equal:false`；还原后全 true（改动只在本地、未提交）。
- ①：临时把逐条 `equal` 强制 false 跑 `--only R1` ⇒ `allEqual:false`；还原后 20/20 true。
- ⑥：三份夹具分别触发三条 reason；⑦：`stage_run` 上真跑 `count(*)`，非 0 即 fail（当前 0）。

## 评审

| 轮次 | 结论 | 要点 |
|---|---|---|
| 自检 | 待 reviewer 收卡 | 七条 verdict 与 caveat 如上；④ 按 A3 降级；⑦ 的 gate/gate.judged 不存在按 partial（M2 建表后必须复跑）；第 2 轮评审确认 overall partial 的两个理由诚实；最终取证 2026-11-14T13:14:52+08:00（树冻结后） |

## 收口

- [x] 判据 C1–C11 全绿（C1–C11 逐条见证据与协作偏差；裁判权在 reviewer）
- [x] 七条读数逐条 verdict + caveat
- [x] 人确认 confirmed（Lead m02863）
- [ ] reviewer 收卡
- [ ] 代码与生成物一笔提交、卡与台账一笔提交
- [ ] 报告交人签（`plan/sign/S-M1.md`）——树冻结后已复跑最终读数（2026-11-14T13:14:52+08:00），待签字

## 待确认

- 读数 ④ 若无真实外部意图样本：是**降级为“机制可用”并人签接受**，还是等有真实样本再签 M1 门？——**已由 Lead m02863 明确：无真实样本就如实降级 + caveat**；本卡按此执行，verdict `partial`。
- 最终取证时点：**树已于 2026-11-14T13:15+08:00 冻结**；本卡 E1–E10 已按冻结后一次 `npm run readings:m1`（generatedAt `2026-11-14T05:14:52.629Z` = 13:14:52+08:00）统一重写，无占位/旧时点。
