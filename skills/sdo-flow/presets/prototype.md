# prototype（快速原型）

用途：先用最小代价把东西跑起来，再决定要不要产品化。

## 出口勾选表

### `explore[implement]` 出口 `G_explore_exit`（4 条，只判“可观察”）

`task.complete`（含可复跑的观察命令）、`spec_set.signed`、`provenance.present`、`assumption_set.signed`

### `harden[requirement,design,implement,review]` 出口 `G_harden_exit`（23 条，全量）

| # | 判据 |
|---|---|
| 1 | `stage.requirement_complete` |
| 2 | `intent.restated_consistent` |
| 3 | `alignment.examples_present` |
| 4 | `spec_set.signed`（core） |
| 5 | `scope.present` |
| 6 | `intent.explicit_for_risk` |
| 7 | `redteam.disposed` |
| 8 | `assumption_set.signed`（core） |
| 9 | `stage.design_traceable` |
| 10 | `design.covers_spec` |
| 11 | `design.no_spec_creep` |
| 12 | `design.alternatives_declared` |
| 13 | `node.acceptance_bound` |
| 14 | `task.complete` |
| 15 | `assumption.disposed` |
| 16 | `mandate.revalidated` |
| 17 | `review.round_bound` |
| 18 | `review.required` |
| 19 | `provenance.present`（core） |
| 20 | `requirement.baseline_present`（依据：§12.2） |
| 21 | `design.artifacts_present`（依据：§12.1） |
| 22 | `test.design_present`（依据：§12.2） |
| 23 | `trace.requirement_covered` + `trace.test_linked`（依据：§12.2） |

### `deliver[deliver]` 出口 `G_deliver_exit`（6 条）

`design.code_matches`、`node.integration_listed`、`mandate.revalidated`、`spec_set.signed`、`provenance.present`、`assumption_set.signed`

## 边界（不是漏洞）

`explore` 的 gate 里没有 `review.required`。所以**高风险卡、实现类设计条款、与发布相关的卡、被抽样命中的卡，都不许停在 explore**，必须在 `harden` 收口。
判法：开卡时在卡面写 `risk_flags`；非空 ⇒ 出口节点写 `harden`。

## 等价 policy

```yaml
policy:
  id: my-prototype
  preset: prototype
  stages:
    - { id: explore, kinds: [implement], after: [] }
    - { id: harden,  kinds: [requirement, design, implement, review], after: [explore] }
    - { id: deliver, kinds: [deliver], after: [harden] }
  gates:
    explore: [{ id: G_explore_exit, policy_mode: all_of, waivable: false, criteria: [task.complete, spec_set.signed, provenance.present, assumption_set.signed] }]
    harden:  [{ id: G_harden_exit, policy_mode: all_of, waivable: false, criteria: [stage.requirement_complete, intent.restated_consistent, alignment.examples_present, spec_set.signed, scope.present, intent.explicit_for_risk, redteam.disposed, assumption_set.signed, stage.design_traceable, design.covers_spec, design.no_spec_creep, design.alternatives_declared, node.acceptance_bound, task.complete, assumption.disposed, mandate.revalidated, review.round_bound, review.required, provenance.present, requirement.baseline_present, design.artifacts_present, test.design_present, trace.requirement_covered, trace.test_linked] }]
    deliver: [{ id: G_deliver_exit, policy_mode: all_of, waivable: false, criteria: [design.code_matches, node.integration_listed, mandate.revalidated, spec_set.signed, provenance.present, assumption_set.signed] }]
```
