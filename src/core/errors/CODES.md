# Reason codes（自动生成，勿手改）

由 `src/core/errors/generate-codes.ts` 从 `REASON_CODES` 生成；新增/改名请改码表后重跑。

共 257 个码。

## auth（18）

| code | summary | HTTP | reserved |
|---|---|---|---|
| `actor_not_from_session` | auth 组拒绝码：actor not from session（语义以消费点注释为准） | 403 |  |
| `boot_only` | auth 组拒绝码：boot only（语义以消费点注释为准） |  |  |
| `cross_prefix_denied` | auth 组拒绝码：cross prefix denied（语义以消费点注释为准） |  |  |
| `last_admin_right` | auth 组拒绝码：last admin right（语义以消费点注释为准） | 403 |  |
| `missing_grant` | auth 组拒绝码：missing grant（语义以消费点注释为准） |  |  |
| `no_ownership` | auth 组拒绝码：no ownership（语义以消费点注释为准） |  |  |
| `no_permission` | auth 组拒绝码：no permission（语义以消费点注释为准） | 403 |  |
| `not_a_signer` | auth 组拒绝码：not a signer（语义以消费点注释为准） | 403 |  |
| `unauthorized_agent_event` | auth 组拒绝码：unauthorized agent event（语义以消费点注释为准） |  |  |
| `unauthorized_conflict_detected` | auth 组拒绝码：unauthorized conflict detected（语义以消费点注释为准） |  |  |
| `unauthorized_gate_judgement` | auth 组拒绝码：unauthorized gate judgement（语义以消费点注释为准） |  |  |
| `unauthorized_lease_issue` | auth 组拒绝码：unauthorized lease issue（语义以消费点注释为准） |  |  |
| `unauthorized_renderer_registration` | auth 组拒绝码：unauthorized renderer registration（语义以消费点注释为准） |  |  |
| `unauthorized_right_change` | auth 组拒绝码：unauthorized right change（语义以消费点注释为准） |  |  |
| `unauthorized_root_lock` | auth 组拒绝码：unauthorized root lock（语义以消费点注释为准） |  |  |
| `unauthorized_workcopy_event` | auth 组拒绝码：unauthorized workcopy event（语义以消费点注释为准） |  |  |
| `unknown_action` | auth 组拒绝码：unknown action（语义以消费点注释为准） |  |  |
| `unknown_prefix` | auth 组拒绝码：unknown prefix（语义以消费点注释为准） |  |  |

## write（90）

| code | summary | HTTP | reserved |
|---|---|---|---|
| `append_conflict` | write 组拒绝码：append conflict（语义以消费点注释为准） | 409 |  |
| `assumption_invalidated_is_derived` | write 组拒绝码：assumption invalidated is derived（语义以消费点注释为准） |  |  |
| `assurance_invalid` | write 组拒绝码：assurance invalid（语义以消费点注释为准） |  |  |
| `cascade_conflict` | write 组拒绝码：cascade conflict（语义以消费点注释为准） |  |  |
| `claim_not_found` | write 组拒绝码：claim not found（语义以消费点注释为准） |  |  |
| `content_hash_mismatch` | write 组拒绝码：content hash mismatch（语义以消费点注释为准） |  |  |
| `database_busy` | write 组拒绝码：database busy（语义以消费点注释为准） |  |  |
| `decision_already_signed` | write 组拒绝码：decision already signed（语义以消费点注释为准） |  |  |
| `decision_not_signed` | write 组拒绝码：decision not signed（语义以消费点注释为准） |  |  |
| `diff_already_disposed` | write 组拒绝码：diff already disposed（语义以消费点注释为准） |  |  |
| `diff_conflict` | write 组拒绝码：diff conflict（语义以消费点注释为准） | 409 |  |
| `diff_deferred` | write 组拒绝码：diff deferred（语义以消费点注释为准） |  |  |
| `diff_unprocessed` | write 组拒绝码：diff unprocessed（语义以消费点注释为准） |  |  |
| `disposition_mismatch` | write 组拒绝码：disposition mismatch（语义以消费点注释为准） |  |  |
| `examples_missing` | write 组拒绝码：examples missing（语义以消费点注释为准） |  |  |
| `intent_not_found` | write 组拒绝码：intent not found（语义以消费点注释为准） |  |  |
| `materialize_failed` | write 组拒绝码：materialize failed（语义以消费点注释为准） |  |  |
| `no_lease` | write 组拒绝码：no lease（语义以消费点注释为准） |  |  |
| `no_requirement` | write 组拒绝码：no requirement（语义以消费点注释为准） |  |  |
| `not_covered_by_decision` | write 组拒绝码：not covered by decision（语义以消费点注释为准） |  |  |
| `not_human` | write 组拒绝码：not human（语义以消费点注释为准） |  |  |
| `not_public_face_writer` | write 组拒绝码：not public face writer（语义以消费点注释为准） |  |  |
| `not_reserved_actor` | write 组拒绝码：not reserved actor（语义以消费点注释为准） |  |  |
| `object_condition_failed` | write 组拒绝码：object condition failed（语义以消费点注释为准） |  |  |
| `renderer_conflict` | write 组拒绝码：renderer 注册冲突（语义以消费点注释为准） |  |  |
| `renderer_module_invalid` | write 组拒绝码：renderer 模块非法（语义以消费点注释为准） |  |  |
| `restatement_invalidated` | write 组拒绝码：restatement invalidated（语义以消费点注释为准） |  |  |
| `restatement_missing` | write 组拒绝码：restatement missing（语义以消费点注释为准） |  |  |
| `restatement_not_found` | write 组拒绝码：restatement not found（语义以消费点注释为准） |  |  |
| `restatement_too_late` | write 组拒绝码：restatement too late（语义以消费点注释为准） |  |  |
| `spawn_reason_mismatch` | write 组拒绝码：spawn reason mismatch（语义以消费点注释为准） |  |  |
| `spec_ids_mismatch` | write 组拒绝码：spec ids mismatch（语义以消费点注释为准） |  |  |
| `spec_not_found` | write 组拒绝码：spec not found（语义以消费点注释为准） |  |  |
| `stale_reason` | write 组拒绝码：stale reason（语义以消费点注释为准） |  |  |
| `stale_restatement` | write 组拒绝码：stale restatement（语义以消费点注释为准） |  |  |
| `transaction_in_progress` | write 组拒绝码：transaction in progress（语义以消费点注释为准） |  |  |
| `unknown_event_kind` | write 组拒绝码：unknown event kind（语义以消费点注释为准） |  |  |
| `unmapped_event_kind` | write 组拒绝码：unmapped event kind（语义以消费点注释为准） |  |  |
| `unsupported_scope` | write 组拒绝码：unsupported scope（语义以消费点注释为准） |  |  |
| `writer_exists` | write 组拒绝码：writer exists（语义以消费点注释为准） |  |  |
| `assumption_status_not_backed` | 历史码 assumption_status_not_backed（M4-5 单一码表登记）。 |  |  |
| `awaiting_unlock` | 历史码 awaiting_unlock（M4-5 单一码表登记）。 |  |  |
| `bad_passphrase` | 历史码 bad_passphrase（M4-5 单一码表登记）。 |  |  |
| `card_incomplete` | 历史码 card_incomplete（M4-5 单一码表登记）。 |  |  |
| `dir_perm_insecure` | 历史码 dir_perm_insecure（M4-5 单一码表登记）。 |  |  |
| `duplicate_claim` | 历史码 duplicate_claim（M4-5 单一码表登记）。 |  |  |
| `field` | 历史码 field（M4-5 单一码表登记）。 |  |  |
| `file_perm_insecure` | 历史码 file_perm_insecure（M4-5 单一码表登记）。 |  |  |
| `format` | 历史码 format（M4-5 单一码表登记）。 |  |  |
| `get` | 历史码 get（M4-5 单一码表登记）。 |  |  |
| `invalid_state` | 历史码 invalid_state（M4-5 单一码表登记）。 |  |  |
| `io` | 历史码 io（M4-5 单一码表登记）。 |  |  |
| `json` | 历史码 json（M4-5 单一码表登记）。 |  |  |
| `key_dir_insecure` | 历史码 key_dir_insecure（M4-5 单一码表登记）。 |  |  |
| `key_envelope_invalid` | 历史码 key_envelope_invalid（M4-5 单一码表登记）。 |  |  |
| `key_file_insecure` | 历史码 key_file_insecure（M4-5 单一码表登记）。 |  |  |
| `key_missing` | 历史码 key_missing（M4-5 单一码表登记）。 |  |  |
| `locked` | 历史码 locked（M4-5 单一码表登记）。 |  |  |
| `no_such_seat` | 历史码 no_such_seat（M4-5 单一码表登记）。 |  |  |
| `not_unblockable_by_pm` | 历史码 not_unblockable_by_pm（M4-5 单一码表登记）。 |  |  |
| `open_assumption` | 历史码 open_assumption（M4-5 单一码表登记）。 |  |  |
| `path_is_symlink` | 历史码 path_is_symlink（M4-5 单一码表登记）。 |  |  |
| `path_missing` | 历史码 path_missing（M4-5 单一码表登记）。 |  |  |
| `path_not_directory` | 历史码 path_not_directory（M4-5 单一码表登记）。 |  |  |
| `path_not_regular_file` | 历史码 path_not_regular_file（M4-5 单一码表登记）。 |  |  |
| `path_owner_mismatch` | 历史码 path_owner_mismatch（M4-5 单一码表登记）。 |  |  |
| `platform_unsupported` | 历史码 platform_unsupported（M4-5 单一码表登记）。 |  |  |
| `rate_limited` | 历史码 rate_limited（M4-5 单一码表登记）。 |  |  |
| `rebuild` | 历史码 rebuild（M4-5 单一码表登记）。 |  |  |
| `renderer_views_unknown` | write 组拒绝码：renderer 视图未知（语义以消费点注释为准） |  |  |
| `receipt_not_found` | 历史码 receipt_not_found（M4-5 单一码表登记）。 |  |  |
| `runtime_dir_insecure` | 历史码 runtime_dir_insecure（M4-5 单一码表登记）。 |  |  |
| `sample` | 历史码 sample（M4-5 单一码表登记）。 |  |  |
| `sample_too_small` | 历史码 sample_too_small（M4-5 单一码表登记）。 |  |  |
| `scope_mismatch` | 历史码 scope_mismatch（M4-5 单一码表登记）。 |  |  |
| `seq_conflict` | 历史码 seq_conflict（M4-5 单一码表登记）。 |  |  |
| `seq_gap` | 历史码 seq_gap（M4-5 单一码表登记）。 |  |  |
| `seq_invalid` | 历史码 seq_invalid（M4-5 单一码表登记）。 |  |  |
| `signerd_already_running` | 历史码 signerd_already_running（M4-5 单一码表登记）。 |  |  |
| `signerd_lock_insecure` | 历史码 signerd_lock_insecure（M4-5 单一码表登记）。 |  |  |
| `socket_dir_insecure` | 历史码 socket_dir_insecure（M4-5 单一码表登记）。 |  |  |
| `socket_not_ready` | 历史码 socket_not_ready（M4-5 单一码表登记）。 |  |  |
| `socket_path_too_long` | 历史码 socket_path_too_long（M4-5 单一码表登记）。 |  |  |
| `socket_perm_insecure` | 历史码 socket_perm_insecure（M4-5 单一码表登记）。 |  |  |
| `store_not_initialized` | 历史码 store_not_initialized（M4-5 单一码表登记）。 |  |  |
| `structure` | 历史码 structure（M4-5 单一码表登记）。 |  |  |
| `ttl_requires_window` | 历史码 ttl_requires_window（M4-5 单一码表登记）。 |  |  |
| `unknown_kind` | 历史码 unknown_kind（M4-5 单一码表登记）。 |  |  |
| `unsupported_conclusion` | 历史码 unsupported_conclusion（M4-5 单一码表登记）。 |  |  |
| `usage` | 历史码 usage（M4-5 单一码表登记）。 |  |  |

## gate（85）

| code | summary | HTTP | reserved |
|---|---|---|---|
| `append_failed` | gate 组拒绝码：append failed（语义以消费点注释为准） |  |  |
| `artifact_kinds_incomplete` | gate 组拒绝码：artifact kinds incomplete（语义以消费点注释为准） |  |  |
| `baseline_mismatch` | gate 组拒绝码：baseline mismatch（语义以消费点注释为准） |  |  |
| `baseline_not_frozen` | gate 组拒绝码：baseline not frozen（语义以消费点注释为准） |  |  |
| `baseline_unchanged` | gate 组拒绝码：baseline unchanged（语义以消费点注释为准） |  |  |
| `budget_exceeded` | gate 组拒绝码：budget exceeded（语义以消费点注释为准） |  |  |
| `checked` | gate 组拒绝码：checked（语义以消费点注释为准） |  |  |
| `cooldown_active` | gate 组拒绝码：cooldown active（语义以消费点注释为准） |  |  |
| `cooldown_not_applicable` | gate 组拒绝码：cooldown not applicable（语义以消费点注释为准） |  |  |
| `core_not_effective` | gate 组拒绝码：core not effective（语义以消费点注释为准） |  |  |
| `criterion_invalid` | gate 组拒绝码：criterion invalid（语义以消费点注释为准） |  |  |
| `criterion_not_effective` | gate 组拒绝码：criterion not effective（语义以消费点注释为准） |  |  |
| `criterion_unregistered` | gate 组拒绝码：criterion unregistered（语义以消费点注释为准） |  |  |
| `direction_mismatch` | gate 组拒绝码：direction mismatch（语义以消费点注释为准） |  |  |
| `duplicate_gate_id` | gate 组拒绝码：duplicate gate id（语义以消费点注释为准） |  |  |
| `engine_missing` | gate 组拒绝码：engine missing（语义以消费点注释为准） |  |  |
| `fixture_mismatch` | gate 组拒绝码：fixture mismatch（语义以消费点注释为准） |  |  |
| `fixtures_invalid` | gate 组拒绝码：fixtures invalid（语义以消费点注释为准） |  |  |
| `fixtures_missing` | gate 组拒绝码：fixtures missing（语义以消费点注释为准） |  |  |
| `frontier_stale` | gate 组拒绝码：frontier stale（语义以消费点注释为准） | 409 |  |
| `gate_empty` | gate 组拒绝码：gate empty（语义以消费点注释为准） |  |  |
| `guarantee_invalid` | gate 组拒绝码：guarantee invalid（语义以消费点注释为准） |  |  |
| `guarantee_mismatch` | gate 组拒绝码：guarantee mismatch（语义以消费点注释为准） |  |  |
| `independence_missing` | gate 组拒绝码：independence missing（语义以消费点注释为准） |  |  |
| `independence_unsatisfied` | gate 组拒绝码：independence unsatisfied（语义以消费点注释为准） |  |  |
| `independence_unverifiable` | gate 组拒绝码：independence unverifiable（语义以消费点注释为准） |  |  |
| `invalid_baseline` | gate 组拒绝码：invalid baseline（语义以消费点注释为准） |  |  |
| `invalid_field` | gate 组拒绝码：invalid field（语义以消费点注释为准） |  |  |
| `invalid_policy` | gate 组拒绝码：invalid policy（语义以消费点注释为准） |  |  |
| `missing_required_kind` | gate 组拒绝码：missing required kind（语义以消费点注释为准） |  |  |
| `multiple_gates_unsupported` | gate 组拒绝码：multiple gates unsupported（语义以消费点注释为准） |  |  |
| `na_stages_mismatch` | gate 组拒绝码：na stages mismatch（语义以消费点注释为准） |  |  |
| `no_blind_sign` | gate 组拒绝码：no blind sign（语义以消费点注释为准） |  |  |
| `no_negative_fixture` | gate 组拒绝码：no negative fixture（语义以消费点注释为准） |  |  |
| `no_positive_fixture` | gate 组拒绝码：no positive fixture（语义以消费点注释为准） |  |  |
| `not_enforced_in_m2` | gate 组拒绝码：not enforced in m2（语义以消费点注释为准） |  |  |
| `not_in_gate` | gate 组拒绝码：not in gate（语义以消费点注释为准） |  |  |
| `not_registered` | gate 组拒绝码：not registered（语义以消费点注释为准） |  |  |
| `payload_changed` | gate 组拒绝码：payload changed（语义以消费点注释为准） | 409 |  |
| `payload_mismatch` | gate 组拒绝码：payload mismatch（语义以消费点注释为准） |  |  |
| `policy_mode_any_of` | gate 组拒绝码：policy mode any of（语义以消费点注释为准） |  |  |
| `preview_consumed` | gate 组拒绝码：preview consumed（语义以消费点注释为准） |  |  |
| `preview_expired` | gate 组拒绝码：preview expired（语义以消费点注释为准） |  |  |
| `preview_mismatch` | gate 组拒绝码：preview mismatch（语义以消费点注释为准） |  |  |
| `review_params_invalid` | gate 组拒绝码：review params invalid（语义以消费点注释为准） |  |  |
| `signature_not_from_signerd` | gate 组拒绝码：signature not from signerd（语义以消费点注释为准） |  |  |
| `signature_time_mismatch` | gate 组拒绝码：signature time mismatch（语义以消费点注释为准） |  |  |
| `stage_bad_after` | gate 组拒绝码：stage bad after（语义以消费点注释为准） |  |  |
| `stage_bad_kind` | gate 组拒绝码：stage bad kind（语义以消费点注释为准） |  |  |
| `stage_gap` | gate 组拒绝码：stage gap（语义以消费点注释为准） |  |  |
| `stage_no_gate` | gate 组拒绝码：stage no gate（语义以消费点注释为准） |  |  |
| `stage_not_applicable` | gate 组拒绝码：stage not applicable（语义以消费点注释为准） |  |  |
| `stage_run_missing` | gate 组拒绝码：stage run missing（语义以消费点注释为准） |  |  |
| `stage_unknown` | gate 组拒绝码：stage unknown（语义以消费点注释为准） |  |  |
| `unknown_criterion` | gate 组拒绝码：unknown criterion（语义以消费点注释为准） |  |  |
| `waivable_gate` | gate 组拒绝码：waivable gate（语义以消费点注释为准） |  |  |
| `assumption_decision_invalid` | 历史码 assumption_decision_invalid（M4-5 单一码表登记）。 |  |  |
| `assumption_disposition_missing` | 历史码 assumption_disposition_missing（M4-5 单一码表登记）。 |  |  |
| `baseline_hash_mismatch` | 历史码 baseline_hash_mismatch（M4-5 单一码表登记）。 |  |  |
| `baseline_missing` | 历史码 baseline_missing（M4-5 单一码表登记）。 |  |  |
| `baseline_unfrozen` | 历史码 baseline_unfrozen（M4-5 单一码表登记）。 |  |  |
| `event_parse_failed` | 历史码 event_parse_failed（M4-5 单一码表登记）。 |  |  |
| `fold_failed` | 历史码 fold_failed（M4-5 单一码表登记）。 |  |  |
| `independence_baseline_unbound` | 历史码 independence_baseline_unbound（M4-5 单一码表登记）。 |  |  |
| `lease_actor_mismatch` | 历史码 lease_actor_mismatch（M4-5 单一码表登记）。 |  |  |
| `lease_multiple_active` | 历史码 lease_multiple_active（M4-5 单一码表登记）。 |  |  |
| `legacy_assumption_invalidated` | 历史码 legacy_assumption_invalidated（M4-5 单一码表登记）。 |  |  |
| `lock_leaked` | 历史码 lock_leaked（M4-5 单一码表登记）。 |  |  |
| `projection_check_failed` | 历史码 projection_check_failed（M4-5 单一码表登记）。 |  |  |
| `projection_missing` | 历史码 projection_missing（M4-5 单一码表登记）。 |  |  |
| `projection_unexpected` | 历史码 projection_unexpected（M4-5 单一码表登记）。 |  |  |
| `public_face_request_stale` | 历史码 public_face_request_stale（M4-5 单一码表登记）。 |  |  |
| `public_face_scope_overlap` | 历史码 public_face_scope_overlap（M4-5 单一码表登记）。 |  |  |
| `public_face_writer_extra` | 历史码 public_face_writer_extra（M4-5 单一码表登记）。 |  |  |
| `public_face_writer_mismatch` | 历史码 public_face_writer_mismatch（M4-5 单一码表登记）。 |  |  |
| `public_face_writer_missing` | 历史码 public_face_writer_missing（M4-5 单一码表登记）。 |  |  |
| `right_actor_mismatch` | 历史码 right_actor_mismatch（M4-5 单一码表登记）。 |  |  |
| `right_grant_untracked` | 历史码 right_grant_untracked（M4-5 单一码表登记）。 |  |  |
| `right_projection_extra` | 历史码 right_projection_extra（M4-5 单一码表登记）。 |  |  |
| `right_projection_mismatch` | 历史码 right_projection_mismatch（M4-5 单一码表登记）。 |  |  |
| `right_projection_missing` | 历史码 right_projection_missing（M4-5 单一码表登记）。 |  |  |
| `unauthorized_row` | 历史码 unauthorized_row（M4-5 单一码表登记）。 |  |  |
| `vcs_object_graph_too_large` | 历史码 vcs_object_graph_too_large（M4-5 单一码表登记）。 |  |  |
| `vcs_object_hash_mismatch` | 历史码 vcs_object_hash_mismatch（M4-5 单一码表登记）。 |  |  |
| `vcs_objects_dir_unresolved` | 历史码 vcs_objects_dir_unresolved（M4-5 单一码表登记）。 |  |  |

## sign（4）

| code | summary | HTTP | reserved |
|---|---|---|---|
| `signerd_receipt_replayed` | sign 组拒绝码：signerd receipt replayed（语义以消费点注释为准） |  |  |
| `receipt_chain_broken` | 历史码 receipt_chain_broken（M4-5 单一码表登记）。 |  |  |
| `signature_unverifiable` | 历史码 signature_unverifiable（M4-5 单一码表登记）。 |  |  |
| `signerd_home_insecure` | 历史码 signerd_home_insecure（M4-5 单一码表登记）。 |  |  |

## release（27）

| code | summary | HTTP | reserved |
|---|---|---|---|
| `admission_ambiguous` | release 组拒绝码：admission ambiguous（语义以消费点注释为准） | 409 |  |
| `conflict` | release 组拒绝码：conflict（语义以消费点注释为准） | 409 |  |
| `conflict_already_resolved` | release 组拒绝码：conflict already resolved（语义以消费点注释为准） |  |  |
| `conflict_invalid` | release 组拒绝码：conflict invalid（语义以消费点注释为准） |  |  |
| `conflict_not_found` | release 组拒绝码：conflict not found（语义以消费点注释为准） |  |  |
| `conflict_scope_undeclared` | release 组拒绝码：conflict scope undeclared（语义以消费点注释为准） |  |  |
| `dirty_main_tree` | release 组拒绝码：dirty main tree（语义以消费点注释为准） |  |  |
| `dirty_workcopy` | release 组拒绝码：dirty workcopy（语义以消费点注释为准） |  |  |
| `invalid_args` | release 组拒绝码：invalid args（语义以消费点注释为准） |  |  |
| `lease_expired` | release 组拒绝码：lease expired（语义以消费点注释为准） |  |  |
| `lease_missing` | release 组拒绝码：lease missing（语义以消费点注释为准） |  |  |
| `lease_not_active` | release 组拒绝码：lease not active（语义以消费点注释为准） | 409 |  |
| `lease_not_expired` | release 组拒绝码：lease not expired（语义以消费点注释为准） |  |  |
| `lock_conflict` | release 组拒绝码：lock conflict（语义以消费点注释为准） | 409 |  |
| `lock_missing` | release 组拒绝码：lock missing（语义以消费点注释为准） |  |  |
| `lock_release_failed` | release 组拒绝码：lock release failed（语义以消费点注释为准） |  |  |
| `merge_conflict` | release 组拒绝码：merge conflict（语义以消费点注释为准） |  |  |
| `public_face_readonly` | release 组拒绝码：public face readonly（语义以消费点注释为准） | 403 |  |
| `resolution_not_signed` | release 组拒绝码：resolution not signed（语义以消费点注释为准） |  |  |
| `resolution_payload_mismatch` | release 组拒绝码：resolution payload mismatch（语义以消费点注释为准） |  |  |
| `scope_undeclared` | release 组拒绝码：scope undeclared（语义以消费点注释为准） |  |  |
| `scope_violation` | release 组拒绝码：scope violation（语义以消费点注释为准） |  |  |
| `snapshot_missing` | release 组拒绝码：snapshot missing（语义以消费点注释为准） |  |  |
| `task_not_found` | release 组拒绝码：task not found（语义以消费点注释为准） |  |  |
| `vcs_link_unsupported` | release 组拒绝码：vcs link unsupported（语义以消费点注释为准） |  |  |
| `vcs_object_missing` | release 组拒绝码：vcs object missing（语义以消费点注释为准） |  |  |
| `workcopy_busy` | release 组拒绝码：workcopy busy（语义以消费点注释为准） |  |  |

## query（27）

| code | summary | HTTP | reserved |
|---|---|---|---|
| `claim_conflict` | query 组拒绝码：claim conflict（语义以消费点注释为准） | 409 |  |
| `claim_invalid` | query 组拒绝码：claim invalid（语义以消费点注释为准） |  |  |
| `clause_readings_incomplete` | query 组拒绝码：clause readings incomplete（语义以消费点注释为准） |  |  |
| `clause_unjudged` | query 组拒绝码：clause unjudged（语义以消费点注释为准） |  |  |
| `column_not_found` | query 组拒绝码：column not found（语义以消费点注释为准） |  |  |
| `column_redacted` | query 组拒绝码：column redacted（语义以消费点注释为准） |  |  |
| `event_rejected` | query 组拒绝码：event rejected（语义以消费点注释为准） |  |  |
| `filtered_by_permission` | query 组拒绝码：filtered by permission（语义以消费点注释为准） |  |  |
| `frontier_empty` | query 组拒绝码：frontier empty（语义以消费点注释为准） |  |  |
| `frontier_unknown` | query 组拒绝码：frontier unknown（语义以消费点注释为准） |  |  |
| `invalid_request` | query 组拒绝码：invalid request（语义以消费点注释为准） |  |  |
| `mismatch` | query 组拒绝码：mismatch（语义以消费点注释为准） |  |  |
| `missing` | query 组拒绝码：missing（语义以消费点注释为准） |  |  |
| `not_implemented` | query 组拒绝码：not implemented（语义以消费点注释为准） |  |  |
| `readings_hash_mismatch` | query 组拒绝码：readings hash mismatch（语义以消费点注释为准） |  |  |
| `renderer_unregistered` | query 组拒绝码：renderer unregistered（语义以消费点注释为准） |  |  |
| `result_too_large` | query 组拒绝码：result too large（语义以消费点注释为准） |  |  |
| `stale_as_of` | query 组拒绝码：stale as of（语义以消费点注释为准） |  |  |
| `stale_events` | query 组拒绝码：stale events（语义以消费点注释为准） |  | M4-6 收口（src/preview 禁止 import 码表，见 preview 静态扫描） |
| `unexpected` | query 组拒绝码：unexpected（语义以消费点注释为准） |  |  |
| `unknown_preset` | query 组拒绝码：unknown preset（语义以消费点注释为准） |  |  |
| `unknown_request` | query 组拒绝码：unknown request（语义以消费点注释为准） |  |  |
| `unknown_stage` | query 组拒绝码：unknown stage（语义以消费点注释为准） |  |  |
| `unregistered_renderer` | query 组拒绝码：unregistered renderer（语义以消费点注释为准） |  |  |
| `unsafe_view_sql` | query 组拒绝码：unsafe view sql（语义以消费点注释为准） |  |  |
| `view_not_found` | query 组拒绝码：view not found（语义以消费点注释为准） |  |  |
| `views_not_covered` | query 组拒绝码：views not covered（语义以消费点注释为准） |  |  |

## config（0）

| code | summary | HTTP | reserved |
|---|---|---|---|

## internal（6）

| code | summary | HTTP | reserved |
|---|---|---|---|
| `baseline_append_failed` | internal 组拒绝码：baseline append failed（语义以消费点注释为准） |  |  |
| `event_chain_broken` | internal 组拒绝码：event chain broken（语义以消费点注释为准） |  |  |
| `event_hash_mismatch` | internal 组拒绝码：event hash mismatch（语义以消费点注释为准） |  |  |
| `internal_missing_reason_code` | internal 组拒绝码：internal missing reason code（语义以消费点注释为准） |  |  |
| `runtime_inconsistent` | internal 组拒绝码：runtime inconsistent（语义以消费点注释为准） |  |  |
| `write_failed` | internal 组拒绝码：write failed（语义以消费点注释为准） |  |  |
