# repair（维修）

用途：已有系统的缺陷修复/小改动。维修没有“新需求/新设计”，不重复正常里程碑的需求与设计门；组合已在 `.sdo/milestones/M13.md` 的 M13.6 定稿，本文件只做可抄写的参考快照，不重新设计。

## 出口勾选表

### `diagnose[implement]` 出口 `G_repair_diagnose`（7 条）

| # | 判据 |
|---|---|
| 1 | `spec_set.signed`（core） |
| 2 | `assumption_set.signed`（core） |
| 3 | `provenance.present`（core） |
| 4 | `requirement.claimed_or_na`（依据：§12.2） |
| 5 | `scope.present` |
| 6 | `node.acceptance_bound` |
| 7 | `assumption.disposed` |

### `fix[implement]` 出口 `G_repair_fix`（7 条）

| # | 判据 |
|---|---|
| 1 | `spec_set.signed`（core） |
| 2 | `assumption_set.signed`（core） |
| 3 | `provenance.present`（core） |
| 4 | `task.complete` |
| 5 | `trace.test_linked`（依据：§12.2） |
| 6 | `agent.mutation_red` |
| 7 | `agent.write_scope_disjoint` |

### `verify[review]` 出口 `G_repair_verify`（12 条）

| # | 判据 |
|---|---|
| 1 | `spec_set.signed`（core） |
| 2 | `assumption_set.signed`（core） |
| 3 | `provenance.present`（core） |
| 4 | `review.required` |
| 5 | `review.round_bound` |
| 6 | `review.independent` |
| 7 | `agent.reviewer_not_author` |
| 8 | `agent.checker_green` |
| 9 | `agent.findings_disposed` |
| 10 | `agent.evidence_runnable` |
| 11 | `agent.no_self_sign` |
| 12 | `agent.unverified_listed` |

### `integrate[deliver]` 出口 `G_repair_integrate`（8 条）

| # | 判据 |
|---|---|
| 1 | `spec_set.signed`（core） |
| 2 | `assumption_set.signed`（core） |
| 3 | `provenance.present`（core） |
| 4 | `gate.signed` |
| 5 | `node.integration_listed` |
| 6 | `mandate.revalidated` |
| 7 | `readings.recorded` |
| 8 | `agent.known_limits` |

## 不适用/负面清单（19 条，不进维修门）

| 判据 | 为什么不进 |
|---|---|
| `stage.requirement_complete` | 这是“从零做一个东西”的门；维修没有新需求，塞进来只会逼人补假需求文档。 |
| `intent.restated_consistent` | 同上，维修沿用既有意图，不重述。 |
| `alignment.examples_present` | 同上，维修不产新的对齐样例。 |
| `agent.plan_reviewed` | 计划评审是正常里程碑的门；维修按维修组合执行，不另做一轮“从零计划”。 |
| `redteam.disposed` | 红队针对新设计；维修没有新设计，硬塞会造出假红队。 |
| `design.covers_spec` | 维修不产设计；真有设计变更时应升级成正常里程碑。 |
| `design.no_spec_creep` | 同上。 |
| `design.alternatives_declared` | 同上。 |
| `design.artifacts_present` | 同上。 |
| `stage.design_traceable` | 同上。 |
| `trace.requirement_covered` | 维修卡通常不关闭需求；需求覆盖由所属里程碑负责。 |
| `design.code_matches` | 维修项目没有设计稿；涉及设计变更应升级成正常里程碑。 |
| `agent.cards_have_negative_cases` | 那是判据注册门槛；维修卡只要 `trace.test_linked` + `agent.mutation_red`。 |
| `agent.readings_frozen` | 读数冻结属里程碑门层（`readings.recorded` + 门签），不是单卡。 |
| `intent.explicit_for_risk` | 维修没有新意图；需求类判据留在正常流程。 |
| `requirement.baseline_present` | 维修不改需求基线。 |
| `test.design_present` | 维修不要求测试设计文档，只要求测试绑定并能红。 |
| `trace.card_coverage` | 卡覆盖需求是里程碑级追溯要求，维修单卡不承担。 |
| `agent.human_signed` | 维修也要人签，但那是里程碑门签层（`gate.signed` + 门签），不是每张卡都签。 |

## 并行在哪

**不在 policy 里**。维修通常单线；若确有多个互不相交的修复，仍按“同一 stage 下多张卡同时开工”，由写域不相交（`agent.write_scope_disjoint`）与人守。

## 使用约定（不写清就会写成假绿）

1. **“不适用”怎么写**：`gate.mjs` 的判定列只认 `pass/partial/fail`，没有 N/A 位。维修若没有新增假设（基线假设已由 core 的 `assumption_set.signed` 保证），`assumption.disposed` 填 **pass**，并在说明列写「不适用：本次无新增假设，基线假设见 `assumption_set.signed`」，由门签人签确认；不许为了“看起来做了”去编一条假设再处置。说明列必须带证据锚点（例如 `git diff <维修前树> -- .sdo/baseline/` 无新增假设节，或基线假设的 `文件:行`），无锚点的“不适用”门签人不得签。
2. **`agent.checker_green` 的口径**：按“**0 错**，且错/警数**不比维修前基线多**”判；WARN 本身不构成 fail（本仓就长期有 1 条历史 WARN），否则维修项目只能靠造假绿通过。
3. **`review.independent` 在维修门里是“对齐正常流程”的保留项**：它的实质要求由 `agent.reviewer_not_author`（身份）与 `agent.no_self_sign`（不代签）覆盖；见 `references/04` §2（门与 preset 清单）与 `03` §5（评审与签字）。

## 与 incremental 的差异

- 门数同为 4，但少一组需求/设计类判据（负面清单共 19 条，其中 12 条是与 incremental 的差集）。
- `trace.test_linked` 提前到“修复”门。
- `agent.mutation_red`、`agent.write_scope_disjoint` 不在 incremental 的判据表里，是从 `agent-driven` 借入 repair。
- 新增 `agent.evidence_runnable`、`agent.no_self_sign`、`agent.unverified_listed`、`agent.known_limits` 四条维修特有诚实性判据。
- `mandate.revalidated` 不是新增；incremental 也有，用于“越权即停”。

## 等价 policy

```yaml
policy:
  id: my-repair
  preset: repair
  stages:
    - { id: diagnose,  kinds: [implement], after: [] }
    - { id: fix,       kinds: [implement], after: [diagnose] }
    - { id: verify,    kinds: [review],    after: [fix] }
    - { id: integrate, kinds: [deliver],   after: [verify] }
  gates:
    diagnose:  [{ id: G_repair_diagnose,  policy_mode: all_of, waivable: false, criteria: [spec_set.signed, assumption_set.signed, provenance.present, requirement.claimed_or_na, scope.present, node.acceptance_bound, assumption.disposed] }]
    fix:       [{ id: G_repair_fix,       policy_mode: all_of, waivable: false, criteria: [spec_set.signed, assumption_set.signed, provenance.present, task.complete, trace.test_linked, agent.mutation_red, agent.write_scope_disjoint] }]
    verify:    [{ id: G_repair_verify,    policy_mode: all_of, waivable: false, criteria: [spec_set.signed, assumption_set.signed, provenance.present, review.required, review.round_bound, review.independent, agent.reviewer_not_author, agent.checker_green, agent.findings_disposed, agent.evidence_runnable, agent.no_self_sign, agent.unverified_listed] }]
    integrate: [{ id: G_repair_integrate, policy_mode: all_of, waivable: false, criteria: [spec_set.signed, assumption_set.signed, provenance.present, gate.signed, node.integration_listed, mandate.revalidated, readings.recorded, agent.known_limits] }]
```
