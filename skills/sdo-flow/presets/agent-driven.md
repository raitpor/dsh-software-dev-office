# agent-driven（agent 驱动）

用途：主要产出由 agent 完成、人只在“立项 / 抽样评审 / 签字”三个点介入的项目。

它和另外三份的关系：**同一套阶段语义，不同的松紧**。waterfall 假设返工贵、prototype 假设需求不清、incremental 假设多条线并行；agent-driven 假设的是——**产出快、记忆短、会过度声称**。所以它的 gate 不加密评审轮次，而是加“可复跑证据 / 反证必红 / 不许自签 / 写域不相交”这四类机械可查的东西。

## 这个 preset 假设了什么（agent 的特点 → 对应的流程约束）

| agent 的特点 | 流程上的约束 |
|---|---|
| 产出快、一次改很多行 | 卡要小：一张卡 ≤ 1 个可独立验收的行为；超过就拆卡（判据里查“卡是否只做一件事”） |
| 跨会话没有记忆 | 状态只认文件：卡 `status`、台账、读数、签字；卡面必须自带“最小上下文”（读哪几个文件就能开工） |
| 容易过度声称“已完成/已验证” | 证据必须是**可复跑命令**或 `文件:行`；且每个 gate 至少一条**反证**（改回去必须红） |
| 不能代表人签字 | 签字阶段只认人：agent 只能准备复述与选项，不能代点、不能自评 pass 当签 |
| 并行成本低、容易撞车 | 计划阶段就要写 `write_scope`；相交的两张卡不许同批开工；共享文件进登记表 |
| 上下文窗口有限 | 产物分层：SKILL 薄、references 按需读、卡短；不靠长对话传状态 |
| 判断力边界不清 | 人只在三处介入：立项/计划签、抽样评审、收口签；其余靠机器 gate |

## 出口勾选表

### `frame[requirement,design]` 出口 `G_frame_exit`

| # | 判据 | 怎么判 |
|---|---|---|
| 1 | `stage.requirement_complete` | 意图段目标/非目标/验收判据齐全 |
| 2 | `intent.restated_consistent` | 复述三条以上与原意一致 |
| 3 | `alignment.examples_present` | 2 正 1 反 |
| 4 | `spec_set.signed`（core） | 计划已人签（S 号） |
| 5 | `scope.present` | 计划写了范围与不做什么 |
| 6 | `intent.explicit_for_risk` | 风险项写死，不写“视情况” |
| 7 | `redteam.disposed` | 反方意见逐条有处置 |
| 8 | `assumption_set.signed`（core） | 假设表每条写“不成立怎么办” |
| 9 | `provenance.present`（core） | 后续每条判定都要有命令或 `文件:行` |
| 10 | `stage.design_traceable` | 每张卡能回指意图条目 |
| 11 | `design.covers_spec` | 卡表覆盖全部验收判据 |
| 12 | `design.no_spec_creep` | 没有卡做意图外的事 |
| 13 | `node.acceptance_bound` | 每个验收点绑到一张卡 |
| 14 | `agent.plan_reviewed` | 计划评审由非作者做，判词在 `.sdo/review/` |
| 15 | `agent.write_scope_disjoint` | 同批开工的卡 `write_scope` 两两不相交；共享文件进登记表 |
| 16 | `agent.cards_have_negative_cases` | 每张卡的判据都写了反例（改回去会怎样） |

### `build[implement]` 出口 `G_agent_build_exit`

| # | 判据 | 怎么判 |
|---|---|---|
| 17 | `task.complete` | 卡上行为全部实现 |
| 18 | `assumption.disposed` | 开工中触发的假设已处置 |
| 19 | `mandate.revalidated` | 授权/边界没被悄悄扩大 |
| 20 | `spec_set.signed`（core） | 同上 |
| 21 | `provenance.present`（core） | 每条完成声明都有命令或 `文件:行` |
| 22 | `assumption_set.signed`（core） | 同上 |
| 23 | `agent.evidence_runnable` | 证据是“能重跑的命令”，不接受“我看过了” |
| 24 | `agent.no_self_sign` | 卡收口前没有任何 agent 自签当通过 |

### `verify[verify]` 出口 `G_agent_verify_exit`

| # | 判据 | 怎么判 |
|---|---|---|
| 25 | `agent.checker_green` | 检查器/测试全绿，输出贴进证据 |
| 26 | `agent.mutation_red` | 至少一条反证：把关键行改回去，对应检查必须红 |
| 27 | `agent.unverified_listed` | 验不了的项列成清单并写原因（不许隐去） |
| 28 | `spec_set.signed`（core） | 同上 |
| 29 | `provenance.present`（core） | 同上 |

### `review[review]` 出口 `G_agent_review_exit`

| # | 判据 | 怎么判 |
|---|---|---|
| 30 | `review.round_bound` | 两轮制：第 1 轮判词 + 复认，绑同一棵树 |
| 31 | `review.required` | 该抽的卡都抽到（抽样号对得上） |
| 32 | `agent.reviewer_not_author` | 评审者 ≠ 作者（非作者即可，复用现有席位） |
| 33 | `agent.findings_disposed` | P0/P1 逐条有修法或台账行，修完由原席位复认 |
| 34 | `spec_set.signed`（core） | 同上 |
| 35 | `provenance.present`（core） | 同上 |

### `sign[vet]` 出口 `G_agent_sign_exit`

| # | 判据 | 怎么判 |
|---|---|---|
| 36 | `agent.human_signed` | 人签文件：复述 + 三选一 + 时间 + 被签对象 + 已知边界 |
| 37 | `agent.known_limits` | 写下“签后仍挡不住什么”，至少一条 |
| 38 | `spec_set.signed`（core） | 签字即本条 |
| 39 | `assumption_set.signed`（core） | 假设表随签确认 |
| 40 | `provenance.present`（core） | 签字引用的证据可复跑 |

### `deliver[deliver]` 出口 `G_agent_deliver_exit`

| # | 判据 | 怎么判 |
|---|---|---|
| 41 | `design.code_matches` | 交付物与卡上判据一致 |
| 42 | `node.integration_listed` | 集成点列清 |
| 43 | `mandate.revalidated` | 交付范围没有越权扩大 |
| 44 | `agent.readings_frozen` | 读数在树冻结后取，写时间与被签树 |
| 45 | `spec_set.signed`（core） | 同上 |
| 46 | `provenance.present`（core） | 同上 |

> 标 `agent.` 的判据是**本 preset 的流程自检项**（不在设计的 24 条判据目录内）：它们由检查器/人按清单判读，不假装是插件强制项。

## 并行在哪

和 incremental 一样，**并行不在 policy 里**：同一 stage 下多张卡同时开工，靠三件事约束——

1. 每张卡写 `owner` 与 `write_scope`；
2. 同批开工卡的写域两两不相交（`agent.write_scope_disjoint`）；共享文件进计划里的「共享写域登记」表；
3. 同步点：`frame` 出口签、`review` 出口复认、`deliver` 前读数门。

## 与其它 preset 的选择规则

- 需求清楚、返工昂贵 ⇒ `waterfall`。
- 需求不清楚、先验证想法 ⇒ `prototype`。
- 多线并行、分批交付、人参与较多 ⇒ `incremental`。
- **主要产出由 agent 完成、人只做三个决定点** ⇒ `agent-driven`（本文件）。
- 一张卡只属于一条阶段序列，不混用。

## 等价 policy

```yaml
policy:
  id: my-agent-driven
  preset: agent-driven
  stages:
    - { id: frame,   kinds: [requirement, design], after: [] }
    - { id: build,   kinds: [implement],           after: [frame] }
    - { id: verify,  kinds: [verify],              after: [build] }
    - { id: review,  kinds: [review],              after: [verify] }
    - { id: sign,    kinds: [vet],                 after: [review] }
    - { id: deliver, kinds: [deliver],             after: [sign] }
  gates:
    frame:   [{ id: G_frame_exit, policy_mode: all_of, waivable: false, criteria: [stage.requirement_complete, intent.restated_consistent, alignment.examples_present, spec_set.signed, scope.present, intent.explicit_for_risk, redteam.disposed, assumption_set.signed, provenance.present, stage.design_traceable, design.covers_spec, design.no_spec_creep, node.acceptance_bound, agent.plan_reviewed, agent.write_scope_disjoint, agent.cards_have_negative_cases] }]
    build:   [{ id: G_agent_build_exit, policy_mode: all_of, waivable: false, criteria: [task.complete, assumption.disposed, mandate.revalidated, spec_set.signed, provenance.present, assumption_set.signed, agent.evidence_runnable, agent.no_self_sign] }]
    verify:  [{ id: G_agent_verify_exit, policy_mode: all_of, waivable: false, criteria: [agent.checker_green, agent.mutation_red, agent.unverified_listed, spec_set.signed, provenance.present] }]
    review:  [{ id: G_agent_review_exit, policy_mode: all_of, waivable: false, criteria: [review.round_bound, review.required, agent.reviewer_not_author, agent.findings_disposed, spec_set.signed, provenance.present] }]
    sign:    [{ id: G_agent_sign_exit, policy_mode: all_of, waivable: false, criteria: [agent.human_signed, agent.known_limits, spec_set.signed, assumption_set.signed, provenance.present] }]
    deliver: [{ id: G_agent_deliver_exit, policy_mode: all_of, waivable: false, criteria: [design.code_matches, node.integration_listed, mandate.revalidated, agent.readings_frozen, spec_set.signed, provenance.present] }]
```

## 什么时候不该用它

- 交付物要承担强合规责任（医疗/金融/安全认证）⇒ 用 waterfall，并把评审强度调高。
- 只有一个人 + 一个 agent 做一次性脚本 ⇒ 用 prototype，别为它背六道 gate。
