# waterfall（瀑布）

用途：需求明确、变更昂贵的项目。**做完一段才开下一段。**

## 出口勾选表（就是门禁）

### `req[requirement]` 出口 `G_req_exit`（9 条，全 all_of、不可豁免）

| # | 判据 | 判定 | 证据 |
|---|---|---|---|
| 1 | `stage.requirement_complete` | | |
| 2 | `intent.restated_consistent` | | |
| 3 | `alignment.examples_present` | | |
| 4 | `spec_set.signed`（core） | | |
| 5 | `scope.present` | | |
| 6 | `intent.explicit_for_risk` | | |
| 7 | `redteam.disposed` | | |
| 8 | `provenance.present`（core） | | |
| 9 | `assumption_set.signed`（core） | | |

### `design[design]` 出口 `G_design_exit`（8 条）

`stage.design_traceable`、`design.covers_spec`、`design.no_spec_creep`、`design.alternatives_declared`、`node.acceptance_bound`、`spec_set.signed`、`provenance.present`、`assumption_set.signed`

### `build[implement]` 出口 `G_build_exit`（6 条）

`task.complete`、`assumption.disposed`、`mandate.revalidated`、`spec_set.signed`、`provenance.present`、`assumption_set.signed`

### `verify[review]` 出口 `G_verify_exit`（5 条）

`review.round_bound`、`review.required`、`spec_set.signed`、`provenance.present`、`assumption_set.signed`

### `deliver[deliver]` 出口 `G_deliver_exit`（6 条）

`design.code_matches`、`node.integration_listed`、`mandate.revalidated`、`spec_set.signed`、`provenance.present`、`assumption_set.signed`

判法：每行填 判定（pass/partial/fail）+ 证据（命令或 `文件:行`）；全 pass（或 partial 已被签接受）才开下一段。

## 等价 policy（结构可迁移；`criteria` 已按 §1.1 展开）

```yaml
policy:
  id: my-waterfall
  preset: waterfall
  stages:
    - { id: req,     kinds: [requirement], after: [] }
    - { id: design,  kinds: [design],      after: [req] }
    - { id: build,   kinds: [implement],   after: [design] }
    - { id: verify,  kinds: [review],      after: [build] }
    - { id: deliver, kinds: [deliver],     after: [verify] }
  gates:
    req:     [{ id: G_req_exit, policy_mode: all_of, waivable: false, criteria: [stage.requirement_complete, intent.restated_consistent, alignment.examples_present, spec_set.signed, scope.present, intent.explicit_for_risk, redteam.disposed, provenance.present, assumption_set.signed] }]
    design:  [{ id: G_design_exit, policy_mode: all_of, waivable: false, criteria: [stage.design_traceable, design.covers_spec, design.no_spec_creep, design.alternatives_declared, node.acceptance_bound, spec_set.signed, provenance.present, assumption_set.signed] }]
    build:   [{ id: G_build_exit, policy_mode: all_of, waivable: false, criteria: [task.complete, assumption.disposed, mandate.revalidated, spec_set.signed, provenance.present, assumption_set.signed] }]
    verify:  [{ id: G_verify_exit, policy_mode: all_of, waivable: false, criteria: [review.round_bound, review.required, spec_set.signed, provenance.present, assumption_set.signed] }]
    deliver: [{ id: G_deliver_exit, policy_mode: all_of, waivable: false, criteria: [design.code_matches, node.integration_listed, mandate.revalidated, spec_set.signed, provenance.present, assumption_set.signed] }]
```
