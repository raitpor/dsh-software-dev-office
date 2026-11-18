/**
 * M4-5 单一 reason code 码表（唯一来源）。
 *
 * - 产品代码的 `reason_code` 必须引用 `CODE.<key>`，不得写裸字面量（C2）。
 * - `ReasonCode` 是全部码的联合类型；分组 auth/write/gate/sign/release/query/config/internal。
 * - `http_status` 只给明确 HTTP 语义的少数码；其余由控制台侧映射。
 * - 新增码：加 entry + 用例，并跑 `node lib/src/core/errors/generate-codes.js` 重生成 CODES.md。
 * - 未消费的码要标 `reserved: true` 与 `reserved_for`（C6）。
 */

export type ReasonGroup = 'auth'|'write'|'gate'|'sign'|'release'|'query'|'config'|'internal';

export interface ReasonCodeEntry {
  readonly code: string;
  readonly group: ReasonGroup;
  readonly summary: string;
  readonly http_status?: number;
  readonly reserved?: true;
  readonly reserved_for?: string;
}

const ENTRIES = [
  { code: 'actor_not_from_session', group: 'auth', summary: 'auth 组拒绝码：actor not from session（语义以消费点注释为准）', http_status: 403 },
  { code: 'admission_ambiguous', group: 'release', summary: 'release 组拒绝码：admission ambiguous（语义以消费点注释为准）', http_status: 409 },
  { code: 'append_conflict', group: 'write', summary: 'write 组拒绝码：append conflict（语义以消费点注释为准）', http_status: 409 },
  { code: 'append_failed', group: 'gate', summary: 'gate 组拒绝码：append failed（语义以消费点注释为准）' },
  { code: 'artifact_kinds_incomplete', group: 'gate', summary: 'gate 组拒绝码：artifact kinds incomplete（语义以消费点注释为准）' },
  { code: 'assumption_invalidated_is_derived', group: 'write', summary: 'write 组拒绝码：assumption invalidated is derived（语义以消费点注释为准）' },
  { code: 'assurance_invalid', group: 'write', summary: 'write 组拒绝码：assurance invalid（语义以消费点注释为准）' },
  { code: 'baseline_append_failed', group: 'internal', summary: 'internal 组拒绝码：baseline append failed（语义以消费点注释为准）' },
  { code: 'baseline_mismatch', group: 'gate', summary: 'gate 组拒绝码：baseline mismatch（语义以消费点注释为准）' },
  { code: 'baseline_not_frozen', group: 'gate', summary: 'gate 组拒绝码：baseline not frozen（语义以消费点注释为准）' },
  { code: 'baseline_unchanged', group: 'gate', summary: 'gate 组拒绝码：baseline unchanged（语义以消费点注释为准）' },
  { code: 'boot_only', group: 'auth', summary: 'auth 组拒绝码：boot only（语义以消费点注释为准）' },
  { code: 'budget_exceeded', group: 'gate', summary: 'gate 组拒绝码：budget exceeded（语义以消费点注释为准）' },
  { code: 'cascade_conflict', group: 'write', summary: 'write 组拒绝码：cascade conflict（语义以消费点注释为准）' },
  { code: 'checked', group: 'gate', summary: 'gate 组拒绝码：checked（语义以消费点注释为准）' },
  { code: 'claim_conflict', group: 'query', summary: 'query 组拒绝码：claim conflict（语义以消费点注释为准）', http_status: 409 },
  { code: 'claim_invalid', group: 'query', summary: 'query 组拒绝码：claim invalid（语义以消费点注释为准）' },
  { code: 'claim_not_found', group: 'write', summary: 'write 组拒绝码：claim not found（语义以消费点注释为准）' },
  { code: 'clause_readings_incomplete', group: 'query', summary: 'query 组拒绝码：clause readings incomplete（语义以消费点注释为准）' },
  { code: 'clause_unjudged', group: 'query', summary: 'query 组拒绝码：clause unjudged（语义以消费点注释为准）' },
  { code: 'column_not_found', group: 'query', summary: 'query 组拒绝码：column not found（语义以消费点注释为准）' },
  { code: 'column_redacted', group: 'query', summary: 'query 组拒绝码：column redacted（语义以消费点注释为准）' },
  { code: 'conflict', group: 'release', summary: 'release 组拒绝码：conflict（语义以消费点注释为准）', http_status: 409 },
  { code: 'conflict_already_resolved', group: 'release', summary: 'release 组拒绝码：conflict already resolved（语义以消费点注释为准）' },
  { code: 'conflict_invalid', group: 'release', summary: 'release 组拒绝码：conflict invalid（语义以消费点注释为准）' },
  { code: 'conflict_not_found', group: 'release', summary: 'release 组拒绝码：conflict not found（语义以消费点注释为准）' },
  { code: 'conflict_scope_undeclared', group: 'release', summary: 'release 组拒绝码：conflict scope undeclared（语义以消费点注释为准）' },
  { code: 'content_hash_mismatch', group: 'write', summary: 'write 组拒绝码：content hash mismatch（语义以消费点注释为准）' },
  { code: 'cooldown_active', group: 'gate', summary: 'gate 组拒绝码：cooldown active（语义以消费点注释为准）' },
  { code: 'cooldown_not_applicable', group: 'gate', summary: 'gate 组拒绝码：cooldown not applicable（语义以消费点注释为准）' },
  { code: 'core_not_effective', group: 'gate', summary: 'gate 组拒绝码：core not effective（语义以消费点注释为准）' },
  { code: 'criterion_invalid', group: 'gate', summary: 'gate 组拒绝码：criterion invalid（语义以消费点注释为准）' },
  { code: 'criterion_not_effective', group: 'gate', summary: 'gate 组拒绝码：criterion not effective（语义以消费点注释为准）' },
  { code: 'criterion_unregistered', group: 'gate', summary: 'gate 组拒绝码：criterion unregistered（语义以消费点注释为准）' },
  { code: 'cross_prefix_denied', group: 'auth', summary: 'auth 组拒绝码：cross prefix denied（语义以消费点注释为准）' },
  { code: 'database_busy', group: 'write', summary: 'write 组拒绝码：database busy（语义以消费点注释为准）' },
  { code: 'decision_already_signed', group: 'write', summary: 'write 组拒绝码：decision already signed（语义以消费点注释为准）' },
  { code: 'decision_not_signed', group: 'write', summary: 'write 组拒绝码：decision not signed（语义以消费点注释为准）' },
  { code: 'diff_already_disposed', group: 'write', summary: 'write 组拒绝码：diff already disposed（语义以消费点注释为准）' },
  { code: 'diff_conflict', group: 'write', summary: 'write 组拒绝码：diff conflict（语义以消费点注释为准）', http_status: 409 },
  { code: 'diff_deferred', group: 'write', summary: 'write 组拒绝码：diff deferred（语义以消费点注释为准）' },
  { code: 'diff_unprocessed', group: 'write', summary: 'write 组拒绝码：diff unprocessed（语义以消费点注释为准）' },
  { code: 'direction_mismatch', group: 'gate', summary: 'gate 组拒绝码：direction mismatch（语义以消费点注释为准）' },
  { code: 'dirty_main_tree', group: 'release', summary: 'release 组拒绝码：dirty main tree（语义以消费点注释为准）' },
  { code: 'dirty_workcopy', group: 'release', summary: 'release 组拒绝码：dirty workcopy（语义以消费点注释为准）' },
  { code: 'disposition_mismatch', group: 'write', summary: 'write 组拒绝码：disposition mismatch（语义以消费点注释为准）' },
  { code: 'duplicate_gate_id', group: 'gate', summary: 'gate 组拒绝码：duplicate gate id（语义以消费点注释为准）' },
  { code: 'engine_missing', group: 'gate', summary: 'gate 组拒绝码：engine missing（语义以消费点注释为准）' },
  { code: 'event_chain_broken', group: 'internal', summary: 'internal 组拒绝码：event chain broken（语义以消费点注释为准）' },
  { code: 'event_hash_mismatch', group: 'internal', summary: 'internal 组拒绝码：event hash mismatch（语义以消费点注释为准）' },
  { code: 'event_rejected', group: 'query', summary: 'query 组拒绝码：event rejected（语义以消费点注释为准）' },
  { code: 'examples_missing', group: 'write', summary: 'write 组拒绝码：examples missing（语义以消费点注释为准）' },
  { code: 'filtered_by_permission', group: 'query', summary: 'query 组拒绝码：filtered by permission（语义以消费点注释为准）' },
  { code: 'fixture_mismatch', group: 'gate', summary: 'gate 组拒绝码：fixture mismatch（语义以消费点注释为准）' },
  { code: 'fixtures_invalid', group: 'gate', summary: 'gate 组拒绝码：fixtures invalid（语义以消费点注释为准）' },
  { code: 'fixtures_missing', group: 'gate', summary: 'gate 组拒绝码：fixtures missing（语义以消费点注释为准）' },
  { code: 'frontier_empty', group: 'query', summary: 'query 组拒绝码：frontier empty（语义以消费点注释为准）' },
  { code: 'frontier_stale', group: 'gate', summary: 'gate 组拒绝码：frontier stale（语义以消费点注释为准）', http_status: 409 },
  { code: 'frontier_unknown', group: 'query', summary: 'query 组拒绝码：frontier unknown（语义以消费点注释为准）' },
  { code: 'gate_empty', group: 'gate', summary: 'gate 组拒绝码：gate empty（语义以消费点注释为准）' },
  { code: 'guarantee_invalid', group: 'gate', summary: 'gate 组拒绝码：guarantee invalid（语义以消费点注释为准）' },
  { code: 'guarantee_mismatch', group: 'gate', summary: 'gate 组拒绝码：guarantee mismatch（语义以消费点注释为准）' },
  { code: 'independence_missing', group: 'gate', summary: 'gate 组拒绝码：independence missing（语义以消费点注释为准）' },
  { code: 'independence_unsatisfied', group: 'gate', summary: 'gate 组拒绝码：independence unsatisfied（语义以消费点注释为准）' },
  { code: 'independence_unverifiable', group: 'gate', summary: 'gate 组拒绝码：independence unverifiable（语义以消费点注释为准）' },
  { code: 'intent_not_found', group: 'write', summary: 'write 组拒绝码：intent not found（语义以消费点注释为准）' },
  { code: 'internal_missing_reason_code', group: 'internal', summary: 'internal 组拒绝码：internal missing reason code（语义以消费点注释为准）' },
  { code: 'invalid_args', group: 'release', summary: 'release 组拒绝码：invalid args（语义以消费点注释为准）' },
  { code: 'invalid_baseline', group: 'gate', summary: 'gate 组拒绝码：invalid baseline（语义以消费点注释为准）' },
  { code: 'invalid_field', group: 'gate', summary: 'gate 组拒绝码：invalid field（语义以消费点注释为准）' },
  { code: 'invalid_policy', group: 'gate', summary: 'gate 组拒绝码：invalid policy（语义以消费点注释为准）' },
  { code: 'invalid_request', group: 'query', summary: 'query 组拒绝码：invalid request（语义以消费点注释为准）' },
  { code: 'last_admin_right', group: 'auth', summary: 'auth 组拒绝码：last admin right（语义以消费点注释为准）', http_status: 403 },
  { code: 'lease_expired', group: 'release', summary: 'release 组拒绝码：lease expired（语义以消费点注释为准）' },
  { code: 'lease_missing', group: 'release', summary: 'release 组拒绝码：lease missing（语义以消费点注释为准）' },
  { code: 'lease_not_active', group: 'release', summary: 'release 组拒绝码：lease not active（语义以消费点注释为准）', http_status: 409 },
  { code: 'lease_not_expired', group: 'release', summary: 'release 组拒绝码：lease not expired（语义以消费点注释为准）' },
  { code: 'lock_conflict', group: 'release', summary: 'release 组拒绝码：lock conflict（语义以消费点注释为准）', http_status: 409 },
  { code: 'lock_missing', group: 'release', summary: 'release 组拒绝码：lock missing（语义以消费点注释为准）' },
  { code: 'lock_release_failed', group: 'release', summary: 'release 组拒绝码：lock release failed（语义以消费点注释为准）' },
  { code: 'materialize_failed', group: 'write', summary: 'write 组拒绝码：materialize failed（语义以消费点注释为准）' },
  { code: 'merge_conflict', group: 'release', summary: 'release 组拒绝码：merge conflict（语义以消费点注释为准）' },
  { code: 'mismatch', group: 'query', summary: 'query 组拒绝码：mismatch（语义以消费点注释为准）' },
  { code: 'missing', group: 'query', summary: 'query 组拒绝码：missing（语义以消费点注释为准）' },
  { code: 'missing_grant', group: 'auth', summary: 'auth 组拒绝码：missing grant（语义以消费点注释为准）' },
  { code: 'missing_required_kind', group: 'gate', summary: 'gate 组拒绝码：missing required kind（语义以消费点注释为准）' },
  { code: 'multiple_gates_unsupported', group: 'gate', summary: 'gate 组拒绝码：multiple gates unsupported（语义以消费点注释为准）' },
  { code: 'na_stages_mismatch', group: 'gate', summary: 'gate 组拒绝码：na stages mismatch（语义以消费点注释为准）' },
  { code: 'no_blind_sign', group: 'gate', summary: 'gate 组拒绝码：no blind sign（语义以消费点注释为准）' },
  { code: 'no_lease', group: 'write', summary: 'write 组拒绝码：no lease（语义以消费点注释为准）' },
  { code: 'no_negative_fixture', group: 'gate', summary: 'gate 组拒绝码：no negative fixture（语义以消费点注释为准）' },
  { code: 'no_ownership', group: 'auth', summary: 'auth 组拒绝码：no ownership（语义以消费点注释为准）' },
  { code: 'no_permission', group: 'auth', summary: 'auth 组拒绝码：no permission（语义以消费点注释为准）', http_status: 403 },
  { code: 'no_positive_fixture', group: 'gate', summary: 'gate 组拒绝码：no positive fixture（语义以消费点注释为准）' },
  { code: 'no_requirement', group: 'write', summary: 'write 组拒绝码：no requirement（语义以消费点注释为准）' },
  { code: 'not_a_signer', group: 'auth', summary: 'auth 组拒绝码：not a signer（语义以消费点注释为准）', http_status: 403 },
  { code: 'not_covered_by_decision', group: 'write', summary: 'write 组拒绝码：not covered by decision（语义以消费点注释为准）' },
  { code: 'not_enforced_in_m2', group: 'gate', summary: 'gate 组拒绝码：not enforced in m2（语义以消费点注释为准）' },
  { code: 'not_human', group: 'write', summary: 'write 组拒绝码：not human（语义以消费点注释为准）' },
  { code: 'not_implemented', group: 'query', summary: 'query 组拒绝码：not implemented（语义以消费点注释为准）' },
  { code: 'not_in_gate', group: 'gate', summary: 'gate 组拒绝码：not in gate（语义以消费点注释为准）' },
  { code: 'not_public_face_writer', group: 'write', summary: 'write 组拒绝码：not public face writer（语义以消费点注释为准）' },
  { code: 'not_registered', group: 'gate', summary: 'gate 组拒绝码：not registered（语义以消费点注释为准）' },
  { code: 'not_reserved_actor', group: 'write', summary: 'write 组拒绝码：not reserved actor（语义以消费点注释为准）' },
  { code: 'object_condition_failed', group: 'write', summary: 'write 组拒绝码：object condition failed（语义以消费点注释为准）' },
  { code: 'payload_changed', group: 'gate', summary: 'gate 组拒绝码：payload changed（语义以消费点注释为准）', http_status: 409 },
  { code: 'payload_mismatch', group: 'gate', summary: 'gate 组拒绝码：payload mismatch（语义以消费点注释为准）' },
  { code: 'policy_mode_any_of', group: 'gate', summary: 'gate 组拒绝码：policy mode any of（语义以消费点注释为准）' },
  { code: 'preview_consumed', group: 'gate', summary: 'gate 组拒绝码：preview consumed（语义以消费点注释为准）' },
  { code: 'preview_expired', group: 'gate', summary: 'gate 组拒绝码：preview expired（语义以消费点注释为准）' },
  { code: 'preview_mismatch', group: 'gate', summary: 'gate 组拒绝码：preview mismatch（语义以消费点注释为准）' },
  { code: 'public_face_readonly', group: 'release', summary: 'release 组拒绝码：public face readonly（语义以消费点注释为准）', http_status: 403 },
  { code: 'readings_hash_mismatch', group: 'query', summary: 'query 组拒绝码：readings hash mismatch（语义以消费点注释为准）' },
  { code: 'renderer_conflict', group: 'write', summary: 'write 组拒绝码：renderer 注册冲突（语义以消费点注释为准）' },
  { code: 'renderer_module_invalid', group: 'write', summary: 'write 组拒绝码：renderer 模块非法（语义以消费点注释为准）' },
  { code: 'renderer_unregistered', group: 'query', summary: 'query 组拒绝码：renderer unregistered（语义以消费点注释为准）' },
  { code: 'resolution_not_signed', group: 'release', summary: 'release 组拒绝码：resolution not signed（语义以消费点注释为准）' },
  { code: 'resolution_payload_mismatch', group: 'release', summary: 'release 组拒绝码：resolution payload mismatch（语义以消费点注释为准）' },
  { code: 'restatement_invalidated', group: 'write', summary: 'write 组拒绝码：restatement invalidated（语义以消费点注释为准）' },
  { code: 'restatement_missing', group: 'write', summary: 'write 组拒绝码：restatement missing（语义以消费点注释为准）' },
  { code: 'restatement_not_found', group: 'write', summary: 'write 组拒绝码：restatement not found（语义以消费点注释为准）' },
  { code: 'restatement_too_late', group: 'write', summary: 'write 组拒绝码：restatement too late（语义以消费点注释为准）' },
  { code: 'result_too_large', group: 'query', summary: 'query 组拒绝码：result too large（语义以消费点注释为准）' },
  { code: 'review_params_invalid', group: 'gate', summary: 'gate 组拒绝码：review params invalid（语义以消费点注释为准）' },
  { code: 'runtime_inconsistent', group: 'internal', summary: 'internal 组拒绝码：runtime inconsistent（语义以消费点注释为准）' },
  { code: 'scope_undeclared', group: 'release', summary: 'release 组拒绝码：scope undeclared（语义以消费点注释为准）' },
  { code: 'scope_violation', group: 'release', summary: 'release 组拒绝码：scope violation（语义以消费点注释为准）' },
  { code: 'signature_not_from_signerd', group: 'gate', summary: 'gate 组拒绝码：signature not from signerd（语义以消费点注释为准）' },
  { code: 'signature_time_mismatch', group: 'gate', summary: 'gate 组拒绝码：signature time mismatch（语义以消费点注释为准）' },
  { code: 'signerd_receipt_replayed', group: 'sign', summary: 'sign 组拒绝码：signerd receipt replayed（语义以消费点注释为准）' },
  { code: 'snapshot_missing', group: 'release', summary: 'release 组拒绝码：snapshot missing（语义以消费点注释为准）' },
  { code: 'spawn_reason_mismatch', group: 'write', summary: 'write 组拒绝码：spawn reason mismatch（语义以消费点注释为准）' },
  { code: 'spec_ids_mismatch', group: 'write', summary: 'write 组拒绝码：spec ids mismatch（语义以消费点注释为准）' },
  { code: 'spec_not_found', group: 'write', summary: 'write 组拒绝码：spec not found（语义以消费点注释为准）' },
  { code: 'stage_bad_after', group: 'gate', summary: 'gate 组拒绝码：stage bad after（语义以消费点注释为准）' },
  { code: 'stage_bad_kind', group: 'gate', summary: 'gate 组拒绝码：stage bad kind（语义以消费点注释为准）' },
  { code: 'stage_gap', group: 'gate', summary: 'gate 组拒绝码：stage gap（语义以消费点注释为准）' },
  { code: 'stage_no_gate', group: 'gate', summary: 'gate 组拒绝码：stage no gate（语义以消费点注释为准）' },
  { code: 'stage_not_applicable', group: 'gate', summary: 'gate 组拒绝码：stage not applicable（语义以消费点注释为准）' },
  { code: 'stage_run_missing', group: 'gate', summary: 'gate 组拒绝码：stage run missing（语义以消费点注释为准）' },
  { code: 'stage_unknown', group: 'gate', summary: 'gate 组拒绝码：stage unknown（语义以消费点注释为准）' },
  { code: 'stale_as_of', group: 'query', summary: 'query 组拒绝码：stale as of（语义以消费点注释为准）' },
  { code: 'stale_events', group: 'query', summary: 'query 组拒绝码：stale events（语义以消费点注释为准）' , reserved: true, reserved_for: 'M4-6 收口（src/preview 禁止 import 码表，见 preview 静态扫描）' },
  { code: 'stale_reason', group: 'write', summary: 'write 组拒绝码：stale reason（语义以消费点注释为准）' },
  { code: 'stale_restatement', group: 'write', summary: 'write 组拒绝码：stale restatement（语义以消费点注释为准）' },
  { code: 'task_not_found', group: 'release', summary: 'release 组拒绝码：task not found（语义以消费点注释为准）' },
  { code: 'transaction_in_progress', group: 'write', summary: 'write 组拒绝码：transaction in progress（语义以消费点注释为准）' },
  { code: 'unauthorized_agent_event', group: 'auth', summary: 'auth 组拒绝码：unauthorized agent event（语义以消费点注释为准）' },
  { code: 'unauthorized_conflict_detected', group: 'auth', summary: 'auth 组拒绝码：unauthorized conflict detected（语义以消费点注释为准）' },
  { code: 'unauthorized_gate_judgement', group: 'auth', summary: 'auth 组拒绝码：unauthorized gate judgement（语义以消费点注释为准）' },
  { code: 'unauthorized_lease_issue', group: 'auth', summary: 'auth 组拒绝码：unauthorized lease issue（语义以消费点注释为准）' },
  { code: 'unauthorized_renderer_registration', group: 'auth', summary: 'auth 组拒绝码：unauthorized renderer registration（语义以消费点注释为准）' },
  { code: 'unauthorized_right_change', group: 'auth', summary: 'auth 组拒绝码：unauthorized right change（语义以消费点注释为准）' },
  { code: 'unauthorized_root_lock', group: 'auth', summary: 'auth 组拒绝码：unauthorized root lock（语义以消费点注释为准）' },
  { code: 'unauthorized_workcopy_event', group: 'auth', summary: 'auth 组拒绝码：unauthorized workcopy event（语义以消费点注释为准）' },
  { code: 'unexpected', group: 'query', summary: 'query 组拒绝码：unexpected（语义以消费点注释为准）' },
  { code: 'unknown_action', group: 'auth', summary: 'auth 组拒绝码：unknown action（语义以消费点注释为准）' },
  { code: 'unknown_criterion', group: 'gate', summary: 'gate 组拒绝码：unknown criterion（语义以消费点注释为准）' },
  { code: 'unknown_event_kind', group: 'write', summary: 'write 组拒绝码：unknown event kind（语义以消费点注释为准）' },
  { code: 'unknown_prefix', group: 'auth', summary: 'auth 组拒绝码：unknown prefix（语义以消费点注释为准）' },
  { code: 'unknown_preset', group: 'query', summary: 'query 组拒绝码：unknown preset（语义以消费点注释为准）' },
  { code: 'unknown_request', group: 'query', summary: 'query 组拒绝码：unknown request（语义以消费点注释为准）' },
  { code: 'unknown_stage', group: 'query', summary: 'query 组拒绝码：unknown stage（语义以消费点注释为准）' },
  { code: 'unmapped_event_kind', group: 'write', summary: 'write 组拒绝码：unmapped event kind（语义以消费点注释为准）' },
  { code: 'unregistered_renderer', group: 'query', summary: 'query 组拒绝码：unregistered renderer（语义以消费点注释为准）' },
  { code: 'unsafe_view_sql', group: 'query', summary: 'query 组拒绝码：unsafe view sql（语义以消费点注释为准）' },
  { code: 'unsupported_scope', group: 'write', summary: 'write 组拒绝码：unsupported scope（语义以消费点注释为准）' },
  { code: 'vcs_link_unsupported', group: 'release', summary: 'release 组拒绝码：vcs link unsupported（语义以消费点注释为准）' },
  { code: 'vcs_object_missing', group: 'release', summary: 'release 组拒绝码：vcs object missing（语义以消费点注释为准）' },
  { code: 'view_not_found', group: 'query', summary: 'query 组拒绝码：view not found（语义以消费点注释为准）' },
  { code: 'views_not_covered', group: 'query', summary: 'query 组拒绝码：views not covered（语义以消费点注释为准）' },
  { code: 'waivable_gate', group: 'gate', summary: 'gate 组拒绝码：waivable gate（语义以消费点注释为准）' },
  { code: 'workcopy_busy', group: 'release', summary: 'release 组拒绝码：workcopy busy（语义以消费点注释为准）' },
  { code: 'write_failed', group: 'internal', summary: 'internal 组拒绝码：write failed（语义以消费点注释为准）' },
  { code: 'writer_exists', group: 'write', summary: 'write 组拒绝码：writer exists（语义以消费点注释为准）' },
  { code: 'assumption_decision_invalid', group: 'gate', summary: '历史码 assumption_decision_invalid（M4-5 单一码表登记）。' },
  { code: 'assumption_disposition_missing', group: 'gate', summary: '历史码 assumption_disposition_missing（M4-5 单一码表登记）。' },
  { code: 'assumption_status_not_backed', group: 'write', summary: '历史码 assumption_status_not_backed（M4-5 单一码表登记）。' },
  { code: 'awaiting_unlock', group: 'write', summary: '历史码 awaiting_unlock（M4-5 单一码表登记）。' },
  { code: 'bad_passphrase', group: 'write', summary: '历史码 bad_passphrase（M4-5 单一码表登记）。' },
  { code: 'baseline_hash_mismatch', group: 'gate', summary: '历史码 baseline_hash_mismatch（M4-5 单一码表登记）。' },
  { code: 'baseline_missing', group: 'gate', summary: '历史码 baseline_missing（M4-5 单一码表登记）。' },
  { code: 'baseline_unfrozen', group: 'gate', summary: '历史码 baseline_unfrozen（M4-5 单一码表登记）。' },
  { code: 'card_incomplete', group: 'write', summary: '历史码 card_incomplete（M4-5 单一码表登记）。' },
  { code: 'dir_perm_insecure', group: 'write', summary: '历史码 dir_perm_insecure（M4-5 单一码表登记）。' },
  { code: 'duplicate_claim', group: 'write', summary: '历史码 duplicate_claim（M4-5 单一码表登记）。' },
  { code: 'event_parse_failed', group: 'gate', summary: '历史码 event_parse_failed（M4-5 单一码表登记）。' },
  { code: 'field', group: 'write', summary: '历史码 field（M4-5 单一码表登记）。' },
  { code: 'file_perm_insecure', group: 'write', summary: '历史码 file_perm_insecure（M4-5 单一码表登记）。' },
  { code: 'fold_failed', group: 'gate', summary: '历史码 fold_failed（M4-5 单一码表登记）。' },
  { code: 'format', group: 'write', summary: '历史码 format（M4-5 单一码表登记）。' },
  { code: 'get', group: 'write', summary: '历史码 get（M4-5 单一码表登记）。' },
  { code: 'independence_baseline_unbound', group: 'gate', summary: '历史码 independence_baseline_unbound（M4-5 单一码表登记）。' },
  { code: 'invalid_state', group: 'write', summary: '历史码 invalid_state（M4-5 单一码表登记）。' },
  { code: 'io', group: 'write', summary: '历史码 io（M4-5 单一码表登记）。' },
  { code: 'json', group: 'write', summary: '历史码 json（M4-5 单一码表登记）。' },
  { code: 'key_dir_insecure', group: 'write', summary: '历史码 key_dir_insecure（M4-5 单一码表登记）。' },
  { code: 'key_envelope_invalid', group: 'write', summary: '历史码 key_envelope_invalid（M4-5 单一码表登记）。' },
  { code: 'key_file_insecure', group: 'write', summary: '历史码 key_file_insecure（M4-5 单一码表登记）。' },
  { code: 'key_missing', group: 'write', summary: '历史码 key_missing（M4-5 单一码表登记）。' },
  { code: 'lease_actor_mismatch', group: 'gate', summary: '历史码 lease_actor_mismatch（M4-5 单一码表登记）。' },
  { code: 'lease_multiple_active', group: 'gate', summary: '历史码 lease_multiple_active（M4-5 单一码表登记）。' },
  { code: 'legacy_assumption_invalidated', group: 'gate', summary: '历史码 legacy_assumption_invalidated（M4-5 单一码表登记）。' },
  { code: 'lock_leaked', group: 'gate', summary: '历史码 lock_leaked（M4-5 单一码表登记）。' },
  { code: 'locked', group: 'write', summary: '历史码 locked（M4-5 单一码表登记）。' },
  { code: 'no_such_seat', group: 'write', summary: '历史码 no_such_seat（M4-5 单一码表登记）。' },
  { code: 'not_unblockable_by_pm', group: 'write', summary: '历史码 not_unblockable_by_pm（M4-5 单一码表登记）。' },
  { code: 'open_assumption', group: 'write', summary: '历史码 open_assumption（M4-5 单一码表登记）。' },
  { code: 'path_is_symlink', group: 'write', summary: '历史码 path_is_symlink（M4-5 单一码表登记）。' },
  { code: 'path_missing', group: 'write', summary: '历史码 path_missing（M4-5 单一码表登记）。' },
  { code: 'path_not_directory', group: 'write', summary: '历史码 path_not_directory（M4-5 单一码表登记）。' },
  { code: 'path_not_regular_file', group: 'write', summary: '历史码 path_not_regular_file（M4-5 单一码表登记）。' },
  { code: 'path_owner_mismatch', group: 'write', summary: '历史码 path_owner_mismatch（M4-5 单一码表登记）。' },
  { code: 'platform_unsupported', group: 'write', summary: '历史码 platform_unsupported（M4-5 单一码表登记）。' },
  { code: 'projection_check_failed', group: 'gate', summary: '历史码 projection_check_failed（M4-5 单一码表登记）。' },
  { code: 'projection_missing', group: 'gate', summary: '历史码 projection_missing（M4-5 单一码表登记）。' },
  { code: 'projection_unexpected', group: 'gate', summary: '历史码 projection_unexpected（M4-5 单一码表登记）。' },
  { code: 'public_face_request_stale', group: 'gate', summary: '历史码 public_face_request_stale（M4-5 单一码表登记）。' },
  { code: 'public_face_scope_overlap', group: 'gate', summary: '历史码 public_face_scope_overlap（M4-5 单一码表登记）。' },
  { code: 'public_face_writer_extra', group: 'gate', summary: '历史码 public_face_writer_extra（M4-5 单一码表登记）。' },
  { code: 'public_face_writer_mismatch', group: 'gate', summary: '历史码 public_face_writer_mismatch（M4-5 单一码表登记）。' },
  { code: 'public_face_writer_missing', group: 'gate', summary: '历史码 public_face_writer_missing（M4-5 单一码表登记）。' },
  { code: 'rate_limited', group: 'write', summary: '历史码 rate_limited（M4-5 单一码表登记）。' },
  { code: 'rebuild', group: 'write', summary: '历史码 rebuild（M4-5 单一码表登记）。' },
  { code: 'renderer_views_unknown', group: 'write', summary: 'write 组拒绝码：renderer 视图未知（语义以消费点注释为准）' },
  { code: 'receipt_chain_broken', group: 'sign', summary: '历史码 receipt_chain_broken（M4-5 单一码表登记）。' },
  { code: 'receipt_not_found', group: 'write', summary: '历史码 receipt_not_found（M4-5 单一码表登记）。' },
  { code: 'right_actor_mismatch', group: 'gate', summary: '历史码 right_actor_mismatch（M4-5 单一码表登记）。' },
  { code: 'right_grant_untracked', group: 'gate', summary: '历史码 right_grant_untracked（M4-5 单一码表登记）。' },
  { code: 'right_projection_extra', group: 'gate', summary: '历史码 right_projection_extra（M4-5 单一码表登记）。' },
  { code: 'right_projection_mismatch', group: 'gate', summary: '历史码 right_projection_mismatch（M4-5 单一码表登记）。' },
  { code: 'right_projection_missing', group: 'gate', summary: '历史码 right_projection_missing（M4-5 单一码表登记）。' },
  { code: 'runtime_dir_insecure', group: 'write', summary: '历史码 runtime_dir_insecure（M4-5 单一码表登记）。' },
  { code: 'sample', group: 'write', summary: '历史码 sample（M4-5 单一码表登记）。' },
  { code: 'sample_too_small', group: 'write', summary: '历史码 sample_too_small（M4-5 单一码表登记）。' },
  { code: 'scope_mismatch', group: 'write', summary: '历史码 scope_mismatch（M4-5 单一码表登记）。' },
  { code: 'seq_conflict', group: 'write', summary: '历史码 seq_conflict（M4-5 单一码表登记）。' },
  { code: 'seq_gap', group: 'write', summary: '历史码 seq_gap（M4-5 单一码表登记）。' },
  { code: 'seq_invalid', group: 'write', summary: '历史码 seq_invalid（M4-5 单一码表登记）。' },
  { code: 'signature_unverifiable', group: 'sign', summary: '历史码 signature_unverifiable（M4-5 单一码表登记）。' },
  { code: 'signerd_already_running', group: 'write', summary: '历史码 signerd_already_running（M4-5 单一码表登记）。' },
  { code: 'signerd_home_insecure', group: 'sign', summary: '历史码 signerd_home_insecure（M4-5 单一码表登记）。' },
  { code: 'signerd_lock_insecure', group: 'write', summary: '历史码 signerd_lock_insecure（M4-5 单一码表登记）。' },
  { code: 'socket_dir_insecure', group: 'write', summary: '历史码 socket_dir_insecure（M4-5 单一码表登记）。' },
  { code: 'socket_not_ready', group: 'write', summary: '历史码 socket_not_ready（M4-5 单一码表登记）。' },
  { code: 'socket_path_too_long', group: 'write', summary: '历史码 socket_path_too_long（M4-5 单一码表登记）。' },
  { code: 'socket_perm_insecure', group: 'write', summary: '历史码 socket_perm_insecure（M4-5 单一码表登记）。' },
  { code: 'store_not_initialized', group: 'write', summary: '历史码 store_not_initialized（M4-5 单一码表登记）。' },
  { code: 'structure', group: 'write', summary: '历史码 structure（M4-5 单一码表登记）。' },
  { code: 'ttl_requires_window', group: 'write', summary: '历史码 ttl_requires_window（M4-5 单一码表登记）。' },
  { code: 'unauthorized_row', group: 'gate', summary: '历史码 unauthorized_row（M4-5 单一码表登记）。' },
  { code: 'unknown_kind', group: 'write', summary: '历史码 unknown_kind（M4-5 单一码表登记）。' },
  { code: 'unsupported_conclusion', group: 'write', summary: '历史码 unsupported_conclusion（M4-5 单一码表登记）。' },
  { code: 'usage', group: 'write', summary: '历史码 usage（M4-5 单一码表登记）。' },
  { code: 'vcs_object_graph_too_large', group: 'gate', summary: '历史码 vcs_object_graph_too_large（M4-5 单一码表登记）。' },
  { code: 'vcs_object_hash_mismatch', group: 'gate', summary: '历史码 vcs_object_hash_mismatch（M4-5 单一码表登记）。' },
  { code: 'vcs_objects_dir_unresolved', group: 'gate', summary: '历史码 vcs_objects_dir_unresolved（M4-5 单一码表登记）。' },
] as const;

export type ReasonCode = (typeof ENTRIES)[number]['code'];

export function validateReasonCodes(entries: readonly ReasonCodeEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(entry.code)) throw new Error(`invalid reason code: ${entry.code}`);
    if (seen.has(entry.code)) throw new Error(`duplicate reason code: ${entry.code}`);
    seen.add(entry.code);
    const g = entry.group;
    if (!['auth','write','gate','sign','release','query','config','internal'].includes(g)) throw new Error(`bad group: ${entry.code}`);
    if (entry.summary.length === 0) throw new Error(`missing summary: ${entry.code}`);
    if (entry.http_status !== undefined && entry.http_status !== 403 && entry.http_status !== 409) throw new Error(`http_status must be 403 or 409: ${entry.code}`);
    if (entry.reserved === true && !entry.reserved_for) throw new Error(`reserved code needs reserved_for: ${entry.code}`);
  }
}

validateReasonCodes(ENTRIES);

export const REASON_CODES: readonly ReasonCodeEntry[] = ENTRIES;

export const CODE = Object.fromEntries(ENTRIES.map((e) => [e.code, e.code])) as { readonly [K in ReasonCode]: K };

const CODE_SET: ReadonlySet<string> = new Set(ENTRIES.map((e) => e.code));

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && CODE_SET.has(value);
}

export interface ReasonFailure {
  readonly ok: false;
  readonly reason_code: ReasonCode;
  readonly message: string;
}

export function fail(code: ReasonCode, message: string): ReasonFailure {
  return { ok: false, reason_code: code, message };
}

export function failInternalMissing(message: string): ReasonFailure {
  return fail('internal_missing_reason_code', message);
}
