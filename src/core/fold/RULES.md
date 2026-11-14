# fold 规则表（M0-2）

真源：`docs/02` §10（信封）、§11（事件类型全量登记）、§12（折叠），以及 `docs/03`/支撑表的列约束、`design/02` 的状态机与不变量。

- 入口：`fold(prev, events)`；`prev` 为空 = 全量重放，非空 = 增量重放（已见事件按 `id` 跳过）。
- 排序：调用方负责按 `caused_by` 拓扑序 + 提交序传入；fold 不重排（`at` 只做展示）。
- 确定性：reducer 只读事件与当前行；行字段按固定顺序构造；`canonical.ts` 的规范化序列化用于 hash（对象键排序）。
- fail-closed：未知 `kind`、信封字段缺失、`payload` 非对象、缺字段、枚举越界、前置行不存在、业务不变量被破坏 ⇒ 抛 `FoldError`（消息含 id 与 kind）。
- 幂等键：事件 `id`；`inputs` 边失效另用 `(spec_id, input_id, 旧 hash)`。

## 一、受投影的事件（reducer，56 个）

| kind | 目标表 | 关键规则（正例 / 反例） |
|---|---|---|
| `intent.signed` | intent | **intent 行唯一创建者**：`decision_id`（必须 valid 且 kind=intent）、`content_hash`、`statement/owner/strength` 必填；`source_text` 缺省回退 `statement` / 重复签字、缺字段、decision 无效拒 |
| `spec.defined` | spec | `kind/clause` 必填；`mech_checkable=1 ⇒ scenario_id` / 已存在行拒（改走 `spec.revised`） |
| `spec.revised` | spec | `reason` 必填；只改载荷给出的字段，未重给的保留旧值（不重建整行），assumption 保留原 status / 不存在的 spec 拒 |
| `assumption.recorded` | spec | 只建 `status='open'` + `blast_radius`；`inputs[]` 记为派生边，且目标行已存在时 `hash` 必须等于 `rowHash(当前行)` / 带 `payload.status`、hash 不符拒 |
| `assumption.disposed` | spec | 覆盖名单**只认签名载荷**：decision 必须 valid + `kind='assumption_set'`，`payload.spec_ids[]` 含本条、`payload.dispositions[]` 处置一致 ⇒ 写 status / 无效、不覆盖、事件自带 `covered_spec_ids`/`dispositions` ⇒ FoldError |
| `assumption.invalidated` | spec | 行必须是 assumption，`reason` 必填，回 open / 对非 assumption 拒 |
| `contract.defined` | spec | kind=contract，`clause` 必填 / 已存在行拒 |
| `scope.declared` | scope_decl | `stage/paths` 必填 / 缺 paths 拒 |
| `design.locked` | design_lock | `spec_id/spec_version_hash/design_sha256` 必填 / 缺字段拒 |
| `restatement.recorded` | restatement | `intent_id` 必填，`by` 默认 actor / 缺 intent_id 拒 |
| `restatement.diff_dispositioned` | restatement_diff | 四枚举必填 / 越界拒 |
| `restatement.invalidated` | restatement | `reason` 写 invalid_reason / 不存在行拒 |
| `goal.declared` | goal_node | 根 `kind=intent` 必带 `intent_id` + **已签名** `decision(kind='plan')`；载荷 `node_ids[]` 含该节点、`tree[]` 同 id 节点的 `parent_id/kind/goal/acceptance_criterion_id` 与事件逐字段相等；每 intent 至多一根 / 第二个根、树缺失、字段不一致拒 |
| `goal.reparented` | goal_node | 必须带**已签名** `decision(kind='plan')`，并把它**写回节点 `decision_id`**；载荷树同 id 节点的 `parent_id/acceptance_criterion_id` 与事件/当前行一致；part 不许 reparent 成 null；新 parent 存在且不成环；根不能有 parent / 缺 decision、树不一致、环、根加 parent 拒 |
| `goal.integrated` | integration | 双端节点存在、state 枚举 / 缺节点拒 |
| `task.created` | task | `seq/title/kind` 必填，status 默认 planned / 缺 seq、非法 kind、重复 id 拒 |
| `task.claimed` | task | 只允许 planned/ready ⇒ in_progress + owner / blocked/in_progress/done/dropped 拒 |
| `task.assigned` | task | 只写预占（`reserved_by/reserved_until`），不改 status；只允许 planned/ready/in_progress / 缺 assignee、done/dropped 拒 |
| `task.unassigned` | task | 清预占；只允许 planned/ready/in_progress 且行上确有预占 / 无预占、done/dropped 拒 |
| `task.blocked` | task | 只允许 planned/ready/in_progress；八枚举 `block_code`，status=blocked / 非法 code、done/dropped 拒 |
| `task.unblocked` | task | 只允许 blocked；回 `ready` 并清预占（解阻塞≠恢复授权）/ 非 blocked 拒 |
| `task.done` | task | 要求 in_progress；写 producer=owner；带 `criterion_id+evidence_id` 时物化 work_unit / 非 in_progress 拒 |
| `task.reopened` | task | 要求 done，`reason` 必填 / 非 done、缺 reason 拒 |
| `task.dropped` | task | 只许 `ready→dropped`（`never_done`）或 `done→dropped`（`delivered_deferred` + `credential`）；`drop_kind + reason` 必填 / planned/blocked/in_progress/dropped、done+never_done、缺 credential 拒 |
| `task.dependencies_changed` | task | 改 `blocked_by`，写路径环检测 / 成环拒（`dependency cycle`） |
| `report.recorded` | report | state 五枚举 / 非法 state 拒 |
| `attention.raised` | attention | `task_id/asked_of/question/expires_at` 必填 / 缺字段拒 |
| `attention.answered` | attention | 行必须 `state='open'`，`answer` 必填 / 非 open、缺 answer 拒 |
| `attention.withdrawn` | attention | 行必须 open；`withdrawn_by = raised_by` / 他人撤回、非 open 拒 |
| `defect.recorded` | defect | kind/severity 枚举，status=open / 越界拒 |
| `defect.closed` | defect | 行必须 open；需 pass 的 `verify_run` 且 `closed_by = verify.actor` / 非 open、fail run、actor 不符拒 |
| `criterion.registered` | criterion | `spec_id/remedy` 必填（remedy 非空） / 缺 remedy、重复 id 拒（改走 `criterion.revised`） |
| `criterion.revised` | criterion | 改 remedy/status / 不存在行拒 |
| `evidence.attached` | evidence | `criterion_id/artifact_uri/artifact_sha256` 必填；带 `task_id` 时物化 work_unit / 缺 sha、重复 id 拒 |
| `stage.entered` | stage_run | `stage` 必填，verdict 初始 null / 缺 stage 拒 |
| `stage.exited` | stage_run | verdict ∈ pass/changes_requested/na / 越界拒 |
| `gate.judged` | stage_run | 同 verdict 枚举 / 越界拒 |
| `review.recorded` | review | 必填 + verdict ∈ reproduced/refuted；重复 id 拒 / 越界拒 |
| `review.finding_verified` | review | 写 `verified_by` / 不存在 finding 拒 |
| `review.round_closed` | review_round | `baseline_hash/frontier` 必填；pass 需全部 finding 已核实 / 未核实拒 |
| `redteam.recorded` | redteam | subject_kind ∈ spec/task，双 criterion 必填 / 越界拒 |
| `redteam.disposed` | redteam | disposition 三枚举 / 越界拒 |
| `decision.valid` / `decision.signed` | decision | 两事件状态机：`valid` 建行（signature=null；已存在拒），`signed` 要求行存在、valid、未签名且 `payload_hash` 与 valid 相同，只写 `signature/key_id/signer`；**授权只认 signed**（消费处用 `requireSignedDecision`，只 valid 不 signed 一律拒）/ 重复 valid、无 valid 直接 signed、二次 signed、hash 不符拒 |
| `decision.revoked` | decision | 只允许从 valid；status=revoked + reason / 不存在行、非 valid 拒 |
| `decision.rejected` | decision | 只允许从 valid；status=invalid / 不存在行、非 valid 拒 |
| `baseline.frozen` | baseline | 只允许库里**没有任何 baseline** 时首次冻结；`hash` + `engine{version,criteria_manifest_hash}` 必填；落新行（direction=null）/ 二次 frozen、同 id 重冻、缺 engine 拒 |
| `baseline.amended` | baseline | 只收收紧：`direction='tighten'` + `prev` 必填且**等于当前 head**；**新行 append，旧行 hash 不动** / direction=loosen、缺 prev、prev 非 head 拒 |
| `baseline.loosened` | baseline | 放宽：`direction='loosen'` + **已签名** `decision(kind='baseline')` + `prev` 必填且**等于当前 head**；新行 append；多 head 直接 fail（不挑一个）/ direction 不符、无已签名 decision、缺 prev、prev 非 head、多 head 拒 |
| `release.frozen` | release (+release_item) | `frontier/baseline_hash/scope_spec_set/items[]` 必填；`package_version` 可空；items 逐项物化 / 重复 freeze、缺字段、非 requirement 缺 requirement_id、out 缺 reason 拒 |
| `release.delivered` | release | 只能从 frozen；可补写 package_version / 未冻结拒 |
| `release.superseded` | release | 只允许 frozen/delivered；必须带**已签名** `decision(kind='rollback')`，载荷 `release_id` 指向本版、`frontier` 字符串且 **= release 行 frontier**；delivered 必须带非空 `artifact_sha256` 且与 decision 载荷一致，frozen 必须为 null；只改 status='rolled_back' / 缺 decision、指向别版、frontier 不符、产物不符、draft 拒 |
| `verify.passed` / `verify.failed` | verify_run | actor_kind 枚举 + actor 必填，result 由 kind 定 / 缺字段拒 |
| `config.changed` | config | 四键白名单、value≥1、max_payload_bytes≥1024 / 非法键、过小值拒 |
| `snapshot.taken` | snapshot (+snapshot_parent) | `git_oid` 必填；`parent_ids[]` 逐条建链 / 缺 git_oid 拒 |

合计：56 个受投影 kind + 35 个 ack = **91**，与 `docs/02` §11 登记数一致。本轮把 `intent.proposed` 从投影移到 ack（intent 行只由签字事务产生），另补了 `baseline.loosened`。

## 二、已知但不物化的事件（`ack.ts`，35 个）

`intent.proposed`（草稿不落 intent 行，行由 `intent.signed` 写；proposed 态由事件流读出）、`workcopy.created/removed`、`actor.enrolled`、`auth.login/unlock/failed`、`query_miss`、`schema.migrated`、`backup.taken`、`restore.done`、`store.unlocked/open_suspected`、`lock.acquired/released`、`lease.issued/expired/revoked`、`agent.spawned/reused/pick_declined/compaction_attempted/report_compaction/parked/retired/handoff`、`change.proposed/applied`、`node.reset`、`act.cancelled`、`boundary.violation`、`admission.rejected`、`orphan.expired`、`redaction.applied`、`i18n.fallback`、`baseline.rejected`。理由逐条写在 `src/core/fold/ack.ts`。

## 三、本卡未物化的表（明确列出，不假装覆盖）

`event`（输入日志本身，fold 不复制）、`event_kind`（参考表，由迁移/写入路径维护）、`claim`、`receipt`、`field_consumer`、`criterion_fixture`、`scenario`——`docs/02` §11 没有独立事件；由 M-5/M-10 的视图/写入路径或后续卡补齐。`work_unit` 与 `release_item` 已在本轮由 `task.claimed`/`evidence.attached`、`release.frozen` 物化。

## 四、assumption 的 inputs 失效（P1-5）

**hash 来源与信任边界**：`inputs[].hash` 是写入方在边建立时对上游行做的 `rowHash`（规范化 JSON 的 sha256）。fold 只负责“边上的 hash 与当前行不一致 ⇒ 失效”，不证明写入方当初算得对；写入方若预先把“未来的 hash”写进边，fold 在目标行真正变成那个内容前不会报——这是写路径的信任边界（M1 写网关校验），不是 fold 能单方面兜住的。

`assumption.recorded` 的 `inputs[]`（`{kind,id,hash}`）记入 fold 状态；每个事件之后 `propagate.ts` 比较每条边的目标行当前 hash（`rowHash` = 规范化 JSON 的 sha256）：

- 不等 ⇒ 该 assumption 回 `status='open'`，写 `invalidated_reason='inputs hash changed'`、`invalidated_at`；
- 幂等键 `(spec_id, input_id, 旧 hash)`，同一对只落一次；回 open 后按新 hash 重建边，下一次上游变化又是新键；
- 不按事件类型枚举（“枚举必漏”），只看 hash 是否变化。

## 五、行字段与 DDL 对齐

- `baseline` 行 = `id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria, gates, thresholds, assurance, prev, direction, hash, at`（无 `frozen_at`/内嵌 `engine`）。
- `release` 行 = `id, package_version, status, frozen_at, frozen_by, frontier, baseline_hash, scope_spec_set, note`（无 `delivered_at`/`superseded_by` 等 DDL 外字段）；`frozen_by` 是 JSON 字符串数组（≥2 human，DDL `json_valid`），由 `release.frozen` 写入字符串化的数组，物化时按 JSON 列落库（M1-7 C3）。
- `restatement_diff` 是 append-only 投影：同 id 同内容幂等、不同内容由 reducer 显式冲突（D-039），不走静默 upsert。
- `intent` 行只由 `intent.signed` 创建，`decision_id`/`content_hash` 强制非空，与 001 DDL 的 NOT NULL 一致（D-015 已 accepted：fold 收紧，不需要改 DDL）。`intent.status` 是 `design/02` 的生命周期读数，001 DDL 无 `status` 列——这是唯一残留张力，记 `plan/03` D-014（M-5 写路径/视图从 `decision` 折叠派生 status，或 v2.1 加列，二选一未定）。
- `review_round` 的 `baseline_hash/frontier` 改为必填。

## 六、与卡 C4 的指针偏差（报 Lead）

卡 C4 写“`docs/02` §6 的折叠规则”，但 §6 是“风险与对策”；折叠规则实际在 §10/§11/§12。本表按 §10–§12 实现，未改 `docs/`。

## 七、边界

- fold 是读侧投影：不校验 hash 链/`prev`/`caused_by` 拓扑、不验签——这些是 verify（M-10）与写入路径的职责。
- `decision` 的“有效”在 fold 里看 `status='valid'`；本轮对 `assumption_set`/`baseline`/`plan` 已加 kind 与载荷覆盖校验，但 `frontier` 闭包仍留给 verify。
- `baseline` 旧行 hash “永远可复算”依赖行不被改写：fold 侧 append 语义 + 库层触发器双保险。
- `spec.revised` 的载荷契约是“只改给出的字段”，未给字段保留旧值——想清空某字段必须显式给 null。
- `goal_node` 叶节点必须绑 `acceptance_criterion_id`（`docs/03:30`）本卡不查：叶/非叶随子节点增减而变，fold 单事件无法判定最终树；留给 M-10 verify。记 `plan/03` D-017。
