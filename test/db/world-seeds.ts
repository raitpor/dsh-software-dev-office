import { seed, type EventSeed } from './append-helpers.js';

/**
 * 覆盖全部 56 个 supported kind 的一条合法事件链（M1-7 C6）。
 * 链内每个 kind 至少出现一次；`decision.valid` 按 D-019 只在 signed 后物化。
 * 不是“每个 kind 的最小链”，而是可执行的全量对账样本（依赖顺序按 reducer 前置）。
 */
export function worldSeeds(): EventSeed[] {
  const s: EventSeed[] = [];
  const add = (...xs: EventSeed[]): void => {
    for (const x of xs) s.push(x);
  };
  const dec = (n: number, id: string, kind: string, payload: unknown = {}, hash = `ph-${id}`): EventSeed[] => [
  seed(n, 'decision.valid', id, { decision_kind: kind, payload_hash: hash, frontier: `f-${id}`, payload }),
  seed(n + 1, 'decision.signed', id, { payload_hash: hash, signature: `sig-${id}`, key_id: 'key-1', signer: 'alice' }),
  ];
  const plan = (ids: string[], tree: unknown[]): Record<string, unknown> => ({ node_ids: ids, tree });
  add(...dec(1, 'd-int', 'intent', { intent_id: 'INT-1', kind: 'intent' }));
  add(seed(3, 'intent.signed', 'INT-1', { decision_id: 'd-int', statement: 'root intent', owner: 'alice', strength: 'explicit', content_hash: 'ch:int', baseline_hash: 'bh-1' }));
  add(seed(4, 'spec.defined', 'SPEC-1', { kind: 'requirement', clause: 'c1', intent_id: 'INT-1', content_hash: 'ch:spec-1' }));
  add(seed(5, 'criterion.registered', 'CRIT-1', { fixtures: [{ polarity: 'positive', input: 'p', expected_status: 'pass' }, { polarity: 'negative', input: 'n', expected_status: 'fail' }], spec_id: 'SPEC-1', kind: 'functional', remedy: 'fix' }));
  add(seed(6, 'evidence.attached', 'EVID-1', { criterion_id: 'CRIT-1', artifact_uri: 'file:///a', artifact_sha256: 'sha256:a', command: 'true' }));
  add(seed(7, 'scope.declared', 'SC-1', { stage: 'req', paths: ['src/'] }));
  add(seed(8, 'design.locked', 'DL-1', { spec_id: 'SPEC-1', spec_version_hash: 'v1', design_sha256: 'sha256:d' }));
  add(seed(9, 'contract.defined', 'CT-1', { intent_id: 'INT-1', clause: 'contract clause', content_hash: 'ch:ct' }));
  add(seed(10, 'spec.revised', 'SPEC-1', { reason: 'tighten' }));
  add(seed(11, 'assumption.recorded', 'A-1', { intent_id: 'INT-1', clause: 'a1', blast_radius: 'low', content_hash: 'ch:a1' }));
  add(...dec(12, 'd-as', 'assumption_set', { spec_ids: ['A-1'], dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }] }).map((e, i) => ({ ...e, id: `e-m1-${12 + i}` })));
  add(seed(14, 'assumption.disposed', 'A-1', { decision_id: 'd-as', disposition: 'confirmed' }));
  add(seed(15, 'assumption.recorded', 'A-2', { intent_id: 'INT-1', clause: 'a2', blast_radius: 'low', content_hash: 'ch:a2' }));
  add(seed(16, 'assumption.invalidated', 'A-2', { reason: 'inputs changed' }));
  add(seed(17, 'restatement.recorded', 'R-1', { intent_id: 'INT-1', draft_specs: [], inputs: [] }));
  add(seed(18, 'restatement.diff_dispositioned', 'RD-1', { restatement_id: 'R-1', kind: 'agree', target_ref: 'd1', disposition: 'accept' }));
  add(seed(19, 'restatement.recorded', 'R-2', { intent_id: 'INT-1', draft_specs: [], inputs: [] }));
  add(seed(20, 'restatement.invalidated', 'R-2', { reason: 'superseded' }));
  const tree1 = plan(['GOAL-1', 'GOAL-2', 'GOAL-3'], [
  { id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' },
  { id: 'GOAL-2', parent_id: 'GOAL-1', kind: 'part', goal: 'part two' },
  { id: 'GOAL-3', parent_id: 'GOAL-1', kind: 'part', goal: 'part three' },
  ]);
  add(seed(21, 'decision.valid', 'd-plan', { decision_kind: 'plan', payload_hash: 'ph-d-plan', frontier: 'f', payload: tree1 }));
  add(seed(22, 'decision.signed', 'd-plan', { payload_hash: 'ph-d-plan', signature: 'sig', key_id: 'k', signer: 'alice' }));
  add(seed(23, 'goal.declared', 'GOAL-1', { kind: 'intent', intent_id: 'INT-1', decision_id: 'd-plan', goal: 'root' }));
  add(seed(24, 'goal.declared', 'GOAL-2', { kind: 'part', parent_id: 'GOAL-1', decision_id: 'd-plan', goal: 'part two' }));
  add(seed(25, 'goal.declared', 'GOAL-3', { kind: 'part', parent_id: 'GOAL-1', decision_id: 'd-plan', goal: 'part three' }));
  const tree2 = plan(['GOAL-1', 'GOAL-2', 'GOAL-3'], [
  { id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' },
  { id: 'GOAL-2', parent_id: 'GOAL-1', kind: 'part', goal: 'part two' },
  { id: 'GOAL-3', parent_id: 'GOAL-2', kind: 'part', goal: 'part three' },
  ]);
  add(seed(26, 'decision.valid', 'd-plan2', { decision_kind: 'plan', payload_hash: 'ph-d-plan2', frontier: 'f', payload: tree2 }));
  add(seed(27, 'decision.signed', 'd-plan2', { payload_hash: 'ph-d-plan2', signature: 'sig', key_id: 'k', signer: 'alice' }));
  add(seed(28, 'goal.reparented', 'GOAL-3', { parent_id: 'GOAL-2', decision_id: 'd-plan2' }));
  add(seed(29, 'goal.integrated', 'INTG-1', { parent_goal_id: 'GOAL-1', child_goal_id: 'GOAL-2', state: 'connected', evidence_id: 'EVID-1' }));
  add(seed(30, 'task.created', 'TASK-1', { seq: 1, title: 't1', kind: 'implement' }));
  add(seed(31, 'task.claimed', 'TASK-1', {}));
  add(seed(32, 'task.assigned', 'TASK-1', { assignee: 'bob', reserved_until: '2026-12-01T00:00:00Z' }));
  add(seed(33, 'task.unassigned', 'TASK-1', {}));
  add(seed(34, 'task.blocked', 'TASK-1', { block_code: 'upstream_changed', reason: 'x' }));
  add(seed(35, 'task.unblocked', 'TASK-1', {}));
  add(seed(36, 'task.claimed', 'TASK-1', {}));
  add(seed(37, 'task.done', 'TASK-1', { evidence_id: 'EVID-1', criterion_id: 'CRIT-1' }));
  add(seed(38, 'task.reopened', 'TASK-1', { reason: 'rework' }));
  add(seed(39, 'task.dependencies_changed', 'TASK-1', { blocked_by: ['TASK-2'] }));
  add(seed(40, 'task.created', 'TASK-2', { seq: 2, title: 't2', kind: 'implement', status: 'ready' }));
  add(seed(41, 'task.dropped', 'TASK-2', { drop_kind: 'never_done', reason: 'cancelled' }));
  add(seed(42, 'task.created', 'TASK-3', { seq: 3, title: 't3', kind: 'implement' }));
  add(seed(43, 'task.claimed', 'TASK-3', {}));
  add(seed(44, 'task.done', 'TASK-3', {}));
  add(seed(45, 'task.dropped', 'TASK-3', { drop_kind: 'delivered_deferred', reason: 'later', credential: 'EVID-1' }));
  add(seed(46, 'report.recorded', 'REP-1', { task_id: 'TASK-1', state: 'progress', note: 'ok' }));
  add(seed(47, 'attention.raised', 'ATT-1', { task_id: 'TASK-1', asked_of: 'bob', question: 'which?', options: ['a', 'b'], expires_at: '2026-12-01T00:00:00Z' }));
  add(seed(48, 'attention.answered', 'ATT-1', { answer: 'a' }));
  add(seed(49, 'attention.raised', 'ATT-2', { task_id: 'TASK-1', asked_of: 'bob', question: 'again?', expires_at: '2026-12-01T00:00:00Z' }));
  add(seed(50, 'attention.withdrawn', 'ATT-2', {}));
  add(seed(51, 'review.recorded', 'REV-1', { task_id: 'TASK-1', reviewer: 'carol', subject_hash: 'sh1', subject_producer: 'alice', finding: 'looks ok', verdict: 'reproduced' }));
  add(seed(52, 'review.finding_verified', 'REV-1', { verified_by: 'dave' }));
  add(seed(53, 'review.round_closed', 'RC-1', { task_id: 'TASK-1', verdict: 'pass', baseline_hash: 'bh-1', frontier: 'f', signer: 'carol' }));
  add(seed(54, 'redteam.recorded', 'RT-1', { subject_kind: 'spec', subject_id: 'SPEC-1', criterion_id: 'CRIT-1', criterion_fixture_id: 'CRIT-1/fx/1', use_case: 'uc1' }));
  add(seed(55, 'redteam.disposed', 'RT-1', { disposition: 'accepted' }));
  add(seed(56, 'stage.entered', 'SR-1', { stage: 'req' }));
  add(seed(57, 'gate.judged', 'SR-1', { gate_id: 'G_req_exit', baseline_hash: 'bh-1', verdict: 'pass' }));
  add(seed(58, 'stage.exited', 'SR-1', { verdict: 'pass' }));
  add(seed(59, 'verify.passed', 'VR-1', { actor_kind: 'human', actor: 'ci', groups: [], result: 'pass' }));
  add(seed(60, 'verify.failed', 'VR-2', { actor_kind: 'human', actor: 'ci', groups: [], result: 'fail' }));
  add(seed(61, 'defect.recorded', 'DEF-1', { criterion_id: 'CRIT-1', task_id: 'TASK-1', kind: 'criterion', severity: 'low' }));
  add(seed(62, 'defect.closed', 'DEF-1', { verify_run_id: 'VR-1', closed_by: 'ci' }));
  add(seed(100, 'criterion.revised', 'CRIT-1', { remedy: 'better' }));
  add(seed(63, 'baseline.frozen', 'B-1', { frozen_by: 'alice', engine: { version: 'e1', criteria_manifest_hash: 'cmh' }, policy: {}, criteria: [], gates: {}, thresholds: {}, assurance: {}, hash: 'bh-1' }));
  add(seed(64, 'baseline.amended', 'B-2', { prev: 'B-1', direction: 'tighten', frozen_by: 'alice', engine: { version: 'e1', criteria_manifest_hash: 'cmh' }, policy: {}, criteria: [], gates: {}, thresholds: {}, assurance: {}, hash: 'bh-2' }));
  add(seed(65, 'decision.valid', 'd-base', { decision_kind: 'baseline', payload_hash: 'ph-d-base', frontier: 'f', payload: { baseline_id: 'B-3' } }));
  add(seed(66, 'decision.signed', 'd-base', { payload_hash: 'ph-d-base', signature: 'sig', key_id: 'k', signer: 'alice' }));
  add(seed(67, 'baseline.loosened', 'B-3', { prev: 'B-2', direction: 'loosen', decision_id: 'd-base', frozen_by: 'alice', engine: { version: 'e1', criteria_manifest_hash: 'cmh' }, policy: {}, criteria: [], gates: {}, thresholds: {}, assurance: {}, hash: 'bh-3' }));
  add(seed(68, 'release.frozen', 'REL-1', { frozen_by: ['alice', 'bob'], package_version: '0.2.0', frontier: 'f', baseline_hash: 'bh-3', scope_spec_set: 'ss1', items: [{ kind: 'requirement', target: 'SPEC-1', disposition: 'in' }] }));
  add(seed(69, 'release.delivered', 'REL-1', {}));
  add(seed(70, 'release.frozen', 'REL-2', { frozen_by: ['alice', 'bob'], frontier: 'f', baseline_hash: 'bh-3', scope_spec_set: 'ss2', items: [{ kind: 'spec', target: 'SPEC-1', requirement_id: 'SPEC-1', disposition: 'out', reason: 'deferred' }] }));
  add(seed(71, 'decision.valid', 'd-rb', { decision_kind: 'rollback', payload_hash: 'ph-d-rb', frontier: 'f', payload: { release_id: 'REL-2', frontier: 'f', artifact_sha256: null } }));
  add(seed(72, 'decision.signed', 'd-rb', { payload_hash: 'ph-d-rb', signature: 'sig', key_id: 'k', signer: 'alice' }));
  add(seed(73, 'release.superseded', 'REL-2', { release_id: 'REL-2', decision_id: 'd-rb', frontier: 'f', artifact_sha256: null }));
  add(seed(74, 'config.changed', 'limits.max_payload_bytes', { after: 4096, actor: 'alice' }));
  add(seed(101, 'snapshot.taken', 'SNAP-0', { git_oid: 'base0' }));
  add(seed(75, 'snapshot.taken', 'SNAP-1', { git_oid: 'abc123', parent_ids: ['SNAP-0'] }));
  add(seed(76, 'decision.valid', 'd-rv', { decision_kind: 'intent', payload_hash: 'ph-d-rv', frontier: 'f', payload: {} }));
  add(seed(77, 'decision.signed', 'd-rv', { payload_hash: 'ph-d-rv', signature: 'sig', key_id: 'k', signer: 'alice' }));
  add(seed(78, 'decision.revoked', 'd-rv', { reason: 'revoked' }));
  add(seed(79, 'decision.valid', 'd-rj', { decision_kind: 'intent', payload_hash: 'ph-d-rj', frontier: 'f', payload: {} }));
  add(seed(80, 'decision.rejected', 'd-rj', { reason: 'no' }));
  return s;
}
