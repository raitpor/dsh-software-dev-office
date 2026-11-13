import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectFoldFail, TestFolder, validDecision } from './folder.js';

test('规则 attention.withdrawn：正例提出人撤回；反例他人撤回被拒', () => {
  const ok = new TestFolder();
  ok.push('attention.raised', 'ATT-1', {
    task_id: 'TASK-1', asked_of: 'alice', question: 'q', expires_at: '2026-01-02T00:00:00Z',
  });
  ok.push('attention.withdrawn', 'ATT-1', {});
  assert.equal(ok.fold().tables.attention['ATT-1']?.['state'], 'withdrawn');

  const bad = new TestFolder();
  bad.push('attention.raised', 'ATT-1', {
    task_id: 'TASK-1', asked_of: 'alice', question: 'q', expires_at: '2026-01-02T00:00:00Z',
  });
  bad.push('attention.withdrawn', 'ATT-1', { withdrawn_by: 'bob' });
  expectFoldFail(() => bad.fold(), /withdrawn_by must equal raised_by/);
});

test('规则 defect.closed：正例 pass verify + 同 actor；反例 fail verify 被拒', () => {
  const ok = new TestFolder();
  ok.push('criterion.registered', 'CRIT-1', { spec_id: 'SPEC-1', remedy: 'r' });
  ok.push('defect.recorded', 'DEF-1', { criterion_id: 'CRIT-1', kind: 'criterion', severity: 'high' });
  ok.push('verify.passed', 'VR-1', { actor_kind: 'service', actor: 'ci' });
  ok.push('defect.closed', 'DEF-1', { verify_run_id: 'VR-1', closed_by: 'ci' });
  assert.equal(ok.fold().tables.defect['DEF-1']?.['status'], 'closed');

  const failRun = new TestFolder();
  failRun.push('criterion.registered', 'CRIT-1', { spec_id: 'SPEC-1', remedy: 'r' });
  failRun.push('defect.recorded', 'DEF-1', { criterion_id: 'CRIT-1', kind: 'criterion', severity: 'high' });
  failRun.push('verify.failed', 'VR-1', { actor_kind: 'service', actor: 'ci' });
  failRun.push('defect.closed', 'DEF-1', { verify_run_id: 'VR-1', closed_by: 'ci' });
  expectFoldFail(() => failRun.fold(), /result = pass/);
});

test('规则 release.frozen/delivered：正例先冻后交付；反例不存在 release 直接交付被拒', () => {
  const ok = new TestFolder();
  ok.push('baseline.frozen', 'B-1', {
    hash: 'h-baseline',
    engine: { version: 'sdo-engine/1', criteria_manifest_hash: 'cm-1' },
    policy: {}, criteria: [], gates: {}, thresholds: {}, assurance: {},
  });
  ok.push('release.frozen', 'REL-1', {
    package_version: '1.0.0', frontier: 'f-1', baseline_hash: 'h-baseline', scope_spec_set: 's-1',
    items: [
      { kind: 'spec', target: 'SPEC-1', requirement_id: 'REQ-1', disposition: 'in' },
      { kind: 'defect', target: 'DEF-1', requirement_id: 'REQ-1', disposition: 'out', reason: 'deferred' },
    ],
  });
  ok.push('release.delivered', 'REL-1', {});
  assert.equal(ok.fold().tables.release['REL-1']?.['status'], 'delivered');

  const bad = new TestFolder();
  bad.push('release.delivered', 'REL-1', {});
  assert.throws(() => bad.fold(), /does not exist/);
});

test('规则 decision.revoked：正例撤销；反例撤销后再签被拒', () => {
  const ok = new TestFolder();
  validDecision(ok);
  ok.push('decision.revoked', 'd-1', { reason: 'compromised' });
  assert.equal(ok.fold().tables.decision['d-1']?.['status'], 'revoked');

  const bad = new TestFolder();
  validDecision(bad);
  bad.push('decision.revoked', 'd-1', { reason: 'compromised' });
  bad.push('decision.signed', 'd-1', {
    decision_kind: 'intent', payload_hash: 'p2', signature: 's2', key_id: 'k', signer: 'alice',
  });
  expectFoldFail(() => bad.fold(), /revoked/);
});

test('规则 review.round_closed：正例全部 finding 已核实后 pass；反例未核实被拒', () => {
  const base = (t: TestFolder, verify: boolean) => {
    t.push('review.recorded', 'REV-1', {
      task_id: 'TASK-1', reviewer: 'bob', subject_hash: 'h', subject_producer: 'alice',
      finding: 'f', verdict: 'reproduced',
    });
    if (verify) {
      t.push('review.finding_verified', 'REV-1', { verified_by: 'alice' });
    }
    t.push('review.round_closed', 'ROUND-1', {
      task_id: 'TASK-1', baseline_hash: 'b-hash', frontier: 'f', verdict: 'pass', signer: 'bob',
    });
  };
  const ok = new TestFolder();
  base(ok, true);
  assert.equal(ok.fold().tables.review_round['ROUND-1']?.['verdict'], 'pass');

  const bad = new TestFolder();
  base(bad, false);
  expectFoldFail(() => bad.fold(), /every finding verified/);
});

test('规则 config.changed：正例合法键；反例非白名单键 / 过小 payload 上限被拒', () => {
  const ok = new TestFolder();
  ok.push('config.changed', 'limits.max_members', { actor: 'admin', after: 8 });
  assert.equal(ok.fold().tables.config['limits.max_members']?.['value'], 8);

  const badKey = new TestFolder();
  badKey.push('config.changed', 'limits.unknown', { actor: 'admin', after: 1 });
  expectFoldFail(() => badKey.fold(), /whitelist/);

  const badValue = new TestFolder();
  badValue.push('config.changed', 'limits.max_payload_bytes', { actor: 'admin', after: 100 });
  expectFoldFail(() => badValue.fold(), />= 1024/);
});

test('规则 stage.entered/exited 与 evidence.attached：正例进/出阶段并挂证据；反例缺 sha 被拒', () => {
  const t = new TestFolder();
  t.push('stage.entered', 'STAGE-1', { stage: 'design', criteria: ['C1'] });
  t.push('stage.exited', 'STAGE-1', { verdict: 'pass' });
  t.push('criterion.registered', 'CRIT-1', { spec_id: 'SPEC-1', remedy: 'r' });
  t.push('evidence.attached', 'EV-1', { criterion_id: 'CRIT-1', artifact_uri: 'file://x', artifact_sha256: 'sha' });
  const state = t.fold();
  assert.equal(state.tables.stage_run['STAGE-1']?.['verdict'], 'pass');
  assert.equal(state.tables.evidence['EV-1']?.['artifact_sha256'], 'sha');

  const bad = new TestFolder();
  bad.push('evidence.attached', 'EV-1', { criterion_id: 'CRIT-1', artifact_uri: 'file://x' });
  expectFoldFail(() => bad.fold(), /artifact_sha256/);
});
