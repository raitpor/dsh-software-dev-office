---
id: M1-G
seq: 18
milestone: M1
owner: impl-core
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

**人确认**：pending（收卡前必须确认）

**正例 2**
1. `npm run readings:m1` 一次跑完七条，生成 `plan/milestone/M1-读数.{json,md}`；其中读数 ⑦ 的原始输出是 `SELECT count(*) FROM gate` 类表的结果 `0`。
2. 把读数 ⑥ 的 `criteria: []` 再跑一次 ⇒ 输出里 `reason_codes:['gate_empty']` 且 verdict `pass`（读数要求“能拒”，不是“能过”）。

**反例 1**
- 若读数 ① 只报“重建了 20 条”而不给逐条 `claim_id` 与 v1 原值对照 ⇒ 不算达标（无法排伪：可能重建的是空壳）。

## 判据

| # | 判据 | 怎么验 |
|---|---|---|
| C1 | **七条读数各有一条可复跑命令**，脚本一次跑完并生成 `plan/milestone/M1-读数.{json,md}`；每条带 `{id, question, command, raw, verdict, caveat}` | 跑两遍，生成物除 `generatedAt` 外逐字节相同 |
| C2 | ① **`claim` 重建 20/20**：抽 20 条 v1 结论型回执，逐条给 `{claim_no, claim_id, v1 原值, 重建值, equal}`，汇总 20/20；**证据必须逐条**，不许只报总数 | 脚本内对 20 条逐条断言；任一条不等 ⇒ verdict `fail` |
| C3 | ② **无负例 ⇒ 注册被拒**：注册一条带 2 正 0 反的判据 ⇒ 结构化失败（`no_negative_fixture`），并证明**失败时一行都没写** | 用例 + 读数里贴原始返回 |
| C4 | ③ **字段无消费者 ⇒ `dead_field` 红**：`sdo_check --criterion dead_field` 给 `fail` + 列出 `table.column`；再补一条“有消费者”的对照（同列被视图/代码读到 ⇒ `pass`） | 两向都取证（只证红不证绿 = 没法排伪） |
| C5 | ④ **对齐可用**：一个真实意图走完复述 + 2 正 1 反，记录“人第一次说对/不对”的**时点**与当时是否已写代码；分歧前移率 ≥80%（定义写死在脚本里：对齐阶段发现的分歧数 ÷ 总分歧数） | 需要 1 个真实样本 + 计算式；**样本是我们自己的卡**（M1 的卡）不算真实意图 ⇒ 必须标 caveat |
| C6 | ⑤ **返工可见**：每次变更 preview 带 `rework_units`，与事后实际作废数一致（抽样 3 次），逐次给 `{before, preview, actual, equal}` | 3 次抽样；受 D-038 限制，M1 的“实际”只能用 fold 重放口径 ⇒ **必须写 caveat** |
| C7 | ⑥ **静态校验可用**：`criteria: []` ⇒ `gate_empty`；core 三条未有效绑定 ⇒ `core_not_effective`；缺 `engine` ⇒ `engine_missing`（三条各一份夹具文件） | 三份反例文件 + 输出原文 |
| C8 | ⑦ **判定行零产出**：M1 跑完全部工具后 `gate.judged`（`gate`/`stage_run` 里承载判定的表）行数为 0 | 脚本内 `SELECT count(*)`；非 0 ⇒ verdict `fail` 并打印行 |
| C9 | **诚实边界**：报告里逐条写 `caveat`（④ 样本性质、⑤ 对账口径受 D-038 限制、② 只证注册面不证判据本身正确）；**任何一条读数都不许用“配置为真/实现未写”当达标** | 报告人读 + 我逐条核 |
| C10 | 读数脚本不碰生产库：全程临时目录新库，`~/.local/state/sdo/` 不出现新文件 | 跑前后 `ls` 对比 |
| C11 | 冻结区零改动 | `git diff f37f4dc --name-only -- docs design probe` 为空 |

## 假设

| # | 假设 | 状态 | 依据 |
|---|---|---|---|
| A1 | `dead_field` 是**内置硬编码判据**（`docs/04` §2：`security.*`/`release.*`/`dead_field` 随引擎版本，不需项目注册），因此由 `sdo_check` 现算、不进 baseline | confirmed | `docs/04:37`、`docs/04:61` |
| A2 | 读数 ①的 20 条样本 = `test/fixtures/v1-export.json` 里的 20 条 claim（M0-7 已固化） | confirmed | M0-7 卡的 C1 |
| A3 | 读数 ④ 的真实意图样本**不来自本项目**（本项目是工具自身，用它评“分歧前移”是循环论证）；M1 若无真实外部样本，如实标 `caveat` 并降级为“机制可用” | confirmed | 避免自证 |
| A4 | 读数 ⑤ 的“事后实际”在 M1 只能用 fold 重放（`task.*` 尚不可写，D-038）；M1-7 收口后才可能真 append | confirmed | 台账 D-038 |

## 预览

新增 `scripts/m1-readings.mjs` + `scripts/readings/m1/*.mjs` + `test/readings/m1.test.ts`；`package.json` 加 `"readings:m1": "npm run build && node scripts/m1-readings.mjs"`；生成 `plan/milestone/M1-读数.{json,md}`。读数脚本共用 M0 的 `scripts/readings/{fixtures,count,verdicts}.mjs`（不复制一套）。

## 准入

- [ ] M1-0/M1-1/M1-2/M1-3/M1-4/M1-5/M1-6/M1-7 全部收卡
- [ ] 人确认复述（收卡前）

## 证据

| # | 时点 | 命令 | 结果 |
|---|---|---|---|
| E1 | | `npm run readings:m1` | |
| E2 | | 二次跑，除 `generatedAt` 外一致 | |
| E3 | | ① 20/20 逐条表 | |
| E4 | | ② `no_negative_fixture` | |
| E5 | | ③ `dead_field` 红 + 对照绿 | |
| E6 | | ④ 对齐样本与计算式 | |
| E7 | | ⑤ 3 次抽样对账 | |
| E8 | | ⑥ 三份反例夹具输出 | |
| E9 | | ⑦ 判定行 0 | |
| E10 | | `make all` + 冻结区 diff | |

## 判定

M1 不绑 baseline，本卡不做机器判定；人工判定 = E1–E10 全绿 + 每条 caveat 经我核对 + reviewer 收卡 + 人签报告。

## 评审

| 轮次 | 结论 | 要点 |
|---|---|---|
| | | |

## 收口

- [ ] 判据 C1–C11 全绿
- [ ] 七条读数逐条 verdict + caveat
- [ ] 人确认 confirmed
- [ ] reviewer 收卡
- [ ] 代码与生成物一笔提交、卡与台账一笔提交
- [ ] 报告交人签（`plan/sign/S-M1.md`）

## 待确认

- 读数 ④ 若无真实外部意图样本：是**降级为“机制可用”并人签接受**，还是等有真实样本再签 M1 门？我倾向前者（M0 的 R4 也是部分达标被人签接受），但这是里程碑口径，得你定。
