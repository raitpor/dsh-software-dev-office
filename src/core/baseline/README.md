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

## M2-1 冻结事务（P15 → preview → confirm → 人签 → 新行）

纯逻辑在 `freeze.ts`，DB 事务在 `src/db/freeze.ts`；`index.ts` 同时导出两者。

- **方向（`direction.ts`）**：首版 `initial`（行 `direction IS NULL`、`prev IS NULL`）；收紧 `tighten`、放宽 `loosen`。可判定子集：gate/criterion 增删、`policy_mode`、`waivable`、stage/kinds、`criteria[]`、`thresholds` 数值、`na_stages`、`artifact_kinds`、`sample_every`、`db_confidentiality`；引擎版本/hash 不可判定 ⇒ **按放宽**（A2，事前签，不做事后追认）。
- **哈希（C6）**：`baselineHash = sha256(canonicalJson({prev,direction,engine,policy,criteria,gates,thresholds,assurance,artifact_kinds}))`——`prev` 与 `direction` 在 hash 内（卡面列表漏了这两项，按 `docs/04` §5.1 的超集实现）。旧行 hash 永远可从行内字段复算。
- **两段式（C2，评审 P1-1 后）**：preview 在服务端 registry 落一条记录（进程内 Map，TTL 10 分钟、最多 64 条），对外只给 `preview_id` + 展示内容。confirm 只认 `preview_id`；取不到 ⇒ `preview_expired`，已用 ⇒ `preview_consumed`。**confirm 时服务端重跑 P15**（用 registry 里的 raw；不过 ⇒ `baseline.rejected` + 0 行），并重算 `baselineHash`/`decision_baseline`/`will_change_hash`/`guarantee_delta` 与 preview 期保存值逐字段比对（不等 ⇒ `preview_mismatch`）；`payload_hash` 从现算 payload 重算后交签名。链头在 preview 后变化 ⇒ `payload_changed`；签名期间链被其他写入推进 ⇒ `frontier_stale`。
- **首次/重复（C9）**：与当前 head 内容相同 ⇒ `baseline_unchanged`（拒绝，不幂等返回）；同 hash 已冻结的重放 confirm 幂等返回已有行。
- **拒绝码**：`stage_bad_kind`/`stage_bad_after`/`stage_unknown`/`stage_no_gate`/`gate_empty`/`criterion_unregistered`/`artifact_kinds_incomplete`/`na_stages_mismatch`/`engine_missing`/`review_params_invalid`/`core_not_effective`/`invalid_baseline`（来自 P15）+ `payload_changed`/`direction_mismatch`/`baseline_unchanged`/`no_blind_sign` + `preview_expired`/`preview_consumed`/`preview_mismatch`/`frontier_stale`。
- **签名载荷（C3）**：`decision(kind='baseline')` 的 payload 顶层 `baseline` 对象 = `{id,hash,policy_id,preset,prev,direction,will_change_hash,guarantee_delta,missing?,will_change}`；`extra` 同时带人读 `will_change: string[]` 与 `guarantee_delta`（M2-6 签名闸门要求）；`payload_hash` 与签名载荷逐字节一致（D-055 网关复核），写网关另逐字段比对 hash/prev/direction/will_change_hash/guarantee_delta（P2-2）。
- **append 失败（P2）**：签名成功但 baseline append 撞 id/被拒 ⇒ `baseline_append_failed`，**不可重放恢复**，需重新 preview；已签 decision 留作审计。签名前会预占事件 id，避免浪费签名。
- **D-056**：`actor/actor_kind` 由 `FreezeSession`（工具层会话）固定，动作 payload 不得传。
- **C8 verify（`verify-references.ts`）**：按**被引用的那一版**复算 hash（不与当前 head 比），检查 frozen 事件存在、`stage_run`/`release` 的 `baseline_hash` 有对应冻结行；问题码 `baseline_hash_mismatch`/`baseline_unfrozen`/`baseline_missing`，已接进产品 `verify()`（P1-2）。
- **已知边界（D-064）**：preview registry 只在进程内；进程重启或跨进程 confirm ⇒ `preview_expired`。库内尚无任何 baseline 行时 `verify` 跳过引用对账（M0/M1 旧库），出现第一版后即生效。
