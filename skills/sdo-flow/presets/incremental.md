# incremental（增量）

用途：需求/设计先做一次，实现与验证分批走。

## 出口勾选表

### `req_design[requirement,design]` 出口 `G_req_design`（14 条）

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
| 9 | `provenance.present`（core） |
| 10 | `stage.design_traceable` |
| 11 | `design.covers_spec` |
| 12 | `design.no_spec_creep` |
| 13 | `design.alternatives_declared` |
| 14 | `node.acceptance_bound` |

### `build[implement]` 出口 `G_build_exit`（6 条）

`task.complete`、`assumption.disposed`、`mandate.revalidated`、`spec_set.signed`、`provenance.present`、`assumption_set.signed`

### `verify[review]` 出口 `G_verify_exit`（5 条）

`review.round_bound`、`review.required`、`spec_set.signed`、`provenance.present`、`assumption_set.signed`

### `integrate[deliver]` 出口 `G_integrate`（6 条）

`node.integration_listed`、`design.code_matches`、`mandate.revalidated`、`spec_set.signed`、`provenance.present`、`assumption_set.signed`

## 并行在哪

**不在 policy 里**。多线并行是“同一 stage 下多张卡同时开工”，属于派发层：
- 每张卡写 `owner` 与 `write_scope`；写域相交的两张卡不许同时开工（无锁环境，靠人守）。
- 同步点：`req_design` 出口、每次 `integrate`。

## 等价 policy

```yaml
policy:
  id: my-incremental
  preset: incremental
  stages:
    - { id: req_design, kinds: [requirement, design], after: [] }
    - { id: build,      kinds: [implement],          after: [req_design] }
    - { id: verify,     kinds: [review],             after: [build] }
    - { id: integrate,  kinds: [deliver],            after: [verify] }
  gates:
    req_design: [{ id: G_req_design, policy_mode: all_of, waivable: false, criteria: [stage.requirement_complete, intent.restated_consistent, alignment.examples_present, spec_set.signed, scope.present, intent.explicit_for_risk, redteam.disposed, assumption_set.signed, provenance.present, stage.design_traceable, design.covers_spec, design.no_spec_creep, design.alternatives_declared, node.acceptance_bound] }]
    build:      [{ id: G_build_exit, policy_mode: all_of, waivable: false, criteria: [task.complete, assumption.disposed, mandate.revalidated, spec_set.signed, provenance.present, assumption_set.signed] }]
    verify:     [{ id: G_verify_exit, policy_mode: all_of, waivable: false, criteria: [review.round_bound, review.required, spec_set.signed, provenance.present, assumption_set.signed] }]
    integrate:  [{ id: G_integrate, policy_mode: all_of, waivable: false, criteria: [node.integration_listed, design.code_matches, mandate.revalidated, spec_set.signed, provenance.present, assumption_set.signed] }]
```
