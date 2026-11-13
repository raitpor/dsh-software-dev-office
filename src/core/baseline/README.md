# baseline（P15 静态校验，M1-3）

吃一份 baseline JSON，吐 `P15Result`。**纯函数**：不读写文件、不读 env/时钟、不碰数据库（`docs/09` §16.2 的边界）。
不落冻结、不写 `baseline.rejected`、不发事件——那些属于 M2 的冻结事务。

## 入口与文件

- `index.ts` —— 唯一对外入口 `validateBaseline(input: unknown): P15Result`（跨泳道接口，M1-4 消费）。
- `validate.ts` —— 规则计算（逐条 reason code、`guarantee_delta`）。
- `parse.ts` —— 把 `unknown` 收窄成结构化字段，不做 IO；**严格解析**，非法类型/枚举在算 delta 之前短路。
- `graph.ts` —— stage DAG：重复 id、悬空 `after`、环、入口不可达。
- `presets.ts` —— 仅 `waterfall`/`prototype`/`incremental` 三个 preset 键（`docs/08` §1 stage DAG 与 §1.1 gate 目录的快照，`test/core/baseline/presets.test.ts` 机器比对 §1.1）；`lite` 是 **policy 档**、不是 preset 键，示例文件在 `test/fixtures/baseline/lite.policy.json`。
- `types.ts` —— `P15Result` 与 reason code 枚举。

## 结构错 vs 业务码（P2-3 统一口径）

**结构错只出一个码**，且**不产任何业务码/级联码**：

- `reason_codes` 恰为 `['stage_bad_kind']`、`['duplicate_gate_id']` 或 `['invalid_baseline']`；
- `guarantee_delta` 三项统一 `degraded`（fail-closed，不是 EMPTY 的全 `kept`）；
- **不带 `missing`**（结构坏时没有可信的判据级推导）。

分类：

| 结构错 | code |
|---|---|
| stage `id` 空/非字符串、`kinds` 非数组/空/含非法 kind | `stage_bad_kind` |
| 非对象输入、`stages` 非数组或为空、stage/gate 不是对象、`after` 不是非空字符串数组 | `invalid_baseline` |
| `gates` 非数组、gate `id`/`stage` 不是非空字符串 | `invalid_baseline` |
| `criteria` 不是（非空字符串的）数组、`policy_mode ∉ {all_of, any_of}`、`waivable` 非 boolean | `invalid_baseline` |
| `policy.gates` 不是 stage→string[] 映射 | `invalid_baseline` |
| `assurance.na_stages` 不是字符串数组、或含非法 stage kind（与 `kinds` 同一套判定） | `invalid_baseline` |
| `gates[]` 里出现重复 gate `id` | `duplicate_gate_id` |

短路优先级：其余 generic 结构错（先 `return`）> stage 形状错（`stage_bad_kind`）> 重复 gate id（`duplicate_gate_id`）。
stage 形状坏的 stage 不再校验它的 `after`（形状错优先）；别处另有 generic 结构错时以 `invalid_baseline` 为准。
`criteria: []` **不算结构错**（shape 合法）：走业务码 `gate_empty`。
重复 stage id 走业务路径（`stage_bad_kind`，delta 仍按目录计算），与形状短路不同。
业务码只在结构合法时出现。

## reason codes（出处：`docs/04` §5.2 ①–⑪）

| code | 含义 |
|---|---|
| `stage_bad_kind` | stage id 空/重复、`kinds[]` 空或含非法 kind（**对原始值判**，不先过滤） |
| `stage_bad_after` | `after` 悬空、有环、入口不可达 |
| `stage_unknown` | `policy.gates{}` 键或 gate.stage 指向不存在的 stage |
| `stage_no_gate` | 某 stage 没有绑合格 gate |
| `gate_empty` | gate 的 `criteria[]` 为空 |
| `criterion_unregistered` | gate 里的判据不在目录/注册面（id 另见 `unregistered_criteria`） |
| `artifact_kinds_incomplete` | `artifact_kinds` 未覆盖 prototype/product/throwaway |
| `na_stages_mismatch` | `assurance.na_stages[]` 的**值**≠ 由 stages×applies_to 推出的集合（类型/非法 kind 是结构错 `invalid_baseline`，不是本码） |
| `engine_missing` | `engine.version`/`criteria_manifest_hash` 缺失 |
| `review_params_invalid` | `review.sample_every` 不是 [2,10] 整数，或 `sample_seed` 非整数 |
| `core_not_effective` | core 三条的“检查点连续性”不成立（**三种可构造漏法** + C7 的 `missing_required_kind` 前置） |
| `duplicate_gate_id` | `gates[]` 里出现重复 gate `id`（结构错；会让绑定读数含混，故短路拒收） |
| `invalid_baseline` | 结构坏到无法解析（口径见上节；不冒充第 12 条业务规则，台账 D-042） |

## guarantee_delta 口径

- 非 core 判据：按 `docs/04` §6 的五个条件，**存在一个合格 gate** 即算绑定。
- core 三条（`spec_set.signed`/`assumption_set.signed`/`provenance.present`）：按 §5.2 的检查点连续性——**凡 `kinds` 与 `applies_to` 相交的 stage 出口都必须有有效绑定**。
- 文件里手写的 `guarantee_delta` 一律忽略；工具重算。
- `missing` 只在有 `degraded` 时出现；core 缺失用 `core:<code>`。

**lite 的实测口径（P2-1）**：`lite.policy`（req/build/deliver，`na_stages` = design/review）是 **1/2/3 三条保证全 degraded**：

- 保证 1：`stage.design_traceable`/`design.covers_spec`/`design.no_spec_creep`/`node.acceptance_bound` 无 design kind 阶段可绑；
- 保证 2：`design.alternatives_declared` 同样是 design-only 判据，无 design kind 阶段 ⇒ degraded（**不是“1/3 degraded”**）；
- 保证 3：`review.round_bound`/`review.required` 无 review kind 阶段可绑。

lite 仍 `ok: true`：它只是降级，不是拒冻；core 三条在每个存在 stage 的出口仍有效绑定。

## C6 的“漏法”是三种可构造项，不是四种

core 三条的 `applies_to` 都是 `ALL_KINDS`，所以“core 绑到 `na` 阶段”**构造不出来**。可构造的是：

1. core 落在 `any_of` gate（`core-any-of`）；
2. core 落在可豁免 gate（`core-waivable`）；
3. 少绑某个检查点 stage（`core-unbound-stage`；切面表现为 `stage_no_gate`）。

另加**结构性前置**：policy 连 requirement kind 都没有（`lite-no-requirement`）⇒ 直接拒冻，没有“写降级就过”的后门（`docs/04` §5.2 第 6 条 / C7）。

非 core 判据的 `na` 漏法是可构造的：把 `design.covers_spec` 从 design gate 挪进 build gate ⇒ 保证 1 degraded、`missing` 含它，但 `ok: true`、无 reason code（`noncore-na-design`）。

## 反例夹具（`test/fixtures/baseline/`）

合法：`waterfall`、`hand-delta`（手写 delta 被忽略）、`lite.policy`（合法但 1/2/3 全退化）、`lite-handwritten-delta`、`noncore-na-design`（非 core 的 na 漏法）。

结构错（精确码集合 `['invalid_baseline']`，`stage-*` 形状错为 `['stage_bad_kind']`）：
`stage-mixed-kinds`（`["requirement","bogus"]`，证明不过滤）、`stage-bad-kind`、`stage-empty-kinds`、
`gate-policy-mode-bad`、`gate-waivable-string`、`stage-after-string`、`gate-criteria-nonstring`、
`duplicate-gate-id`（精确码集合 `['duplicate_gate_id']`）。

业务码：`criteria-empty`、`cycle`、`island`、`unregistered-criterion`、`missing-engine`、`engine-hash-missing`、
`na-stages-mismatch`、`core-any-of`、`core-waivable`、`core-unbound-stage`、`lite-no-requirement`、
`stage-duplicate-id`、`stage-unknown-gate`、`stage-no-gate`、`stage-dangling-edge`、`review-params-0`、
`review-params-big`、`review-params-seed`、`artifact-kinds-incomplete`。

每个文件对应 `test/core/baseline/validate.test.ts` 里的一条精确码集合断言（`deepEqual(sorted(codes))`，级联码在卡 M1-3 的负例表里列明）。
