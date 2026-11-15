# src/core/gate/ — M2-2 门禁判定（纯函数层）

判定的“尺子”来自**已冻结 baseline 行**的 policy JSON（stages + gates 定义），
结果落 `stage_run`（`gate_id`/`baseline_hash`/`verdict`/`criteria`），写入口唯一：
`src/db/gate.ts` 的 `judgeStage()`。

## 纪律

- 纯函数：本目录不 import `src/db/`、`src/check/`；输入只有 fold 状态 + baseline 行。
- 有效绑定**现算**，复用 M1-1 `evaluateBinding`（五条件）与 `evaluateCoreBinding`
  （检查点连续性），不照抄 P15 结论。
- core 三条（`spec_set.signed`/`assumption_set.signed`/`provenance.present`）
  未生效 ⇒ 判定 `changes_requested` + `core_not_effective`，没有降级后门。
- 只支持**单 gate**：同一 stage 配了多个 gate ⇒ 判定记 `changes_requested` +
  `multiple_gates_unsupported`（`gate_ids` 全量记录，不静默丢），`judgeStage()` 也以
  `multiple_gates_unsupported` 结构化拒（一码一处，compile 的 throw 只是防御性不可达），
  M3 再补多 gate 聚合。
- 其余目录判据在 M2 记 `na`（M3 补求值器）。`na` 不是 pass，也不是“没算”：
  `readings[].reason_code` 恒为 `not_enforced_in_m2`（机器可见），且必须在
  `reasons[]` 同时出现；判定行的 schema 保留该字段，不靠自由文本。
- 判定行不可伪造：裸 `append(gate.judged)` 被写网关拒
  （`unauthorized_gate_judgement`）；授权只由 `judgeStage()` 登记，进程内有效
  （重启即失效，D-066）。这是**已知边界**：判定是“算一次、写一次”的动作，进程重启后
  重新算即可，不是能力缺失；但进程内恶意代码不在本层防。
- 能力是**一次性 + 内容绑定**的 `(eventId, payload_hash, stage_run_id)` 三元组：
  写网关先按 schema 校验载荷，再消费能力（删后比对：错配也烧掉能力，fail-closed）；
  消费后同 id 再用必拒。mint 只在 `judgeStage()` 内部调用、**不导出**——**没有测试缝**：
  需要 `gate.judged` 行的测试走真路径 `judgeStage()`，world-seeds 不再造该 kind
  （第 2 轮评审判定：任何导出的 mint 都等于公开 API）。
- 判定版本绑定 `stage.entered` 时记下的 `baseline_hash`（P2-1）：缺省取它；显式传入
  必须相等，否则 `baseline_mismatch`。fold 层另做语义对账（P2 第 2 轮）：`gate.judged`
  的 `baseline_hash` 必须等于该 `stage_run` 行的进入版本，否则 `materialize_failed`
  （整批回滚，消息含 `entry version`）。`at` 必须满足 `entered_at ≤ at ≤ 注入时钟`
  （两侧越界均 `invalid_field`）。改基线后要按新基线判，须新开 stage_run；
  `verify()` 现在也对账 `stage_run`（手改 `baseline_hash` ⇒ `runtime_inconsistent`）。
- C10 码表：`baseline_not_frozen` / `baseline_mismatch` / `core_not_effective` /
  `gate_empty` / `unauthorized_gate_judgement`。**没有** `judgement_mismatch`：
  判定读数由门禁自己现算、不接受外部传入，没有“不一致”的触发点。

## C6 对账

`test/core/gate/compare-check.test.ts` 用同一 fold 状态比对 `src/check/evaluate.ts`
的三态；两边实现独立（分层不破），core 三条必须一致。
M2 的 `gate.judged.criteria[]` 三态以本目录为准，`sdo_check` 仍是只读预览。
