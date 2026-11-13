import assert from 'node:assert/strict';
import { test } from 'node:test';

import { columnNames, tableNames, withMigratedDb } from './helpers.js';

/** docs/03 的 25 张表 + docs/02/04/06/07/09/12 的 9 张支撑表。 */
const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  decision: [
    'id', 'decision_kind', 'status', 'payload', 'payload_hash', 'signature',
    'key_id', 'signer', 'frontier', 'at', 'revoked_at', 'revoke_reason',
  ],
  baseline: [
    'id', 'frozen_by', 'engine_version', 'criteria_manifest_hash', 'policy',
    'criteria', 'gates', 'thresholds', 'assurance', 'prev', 'direction', 'hash', 'at',
  ],
  task: [
    'id', 'seq', 'title', 'kind', 'created_by', 'producer', 'owner', 'status',
    'blocked_by', 'scope_paths', 'inputs', 'subject_kind', 'subject_id', 'block_code', 'at',
  ],
  intent: ['id', 'statement', 'source_text', 'owner', 'decision_id', 'strength', 'baseline_hash', 'content_hash', 'at'],
  snapshot: ['id', 'git_oid', 'external_ref', 'at'],
  snapshot_parent: ['snapshot_id', 'parent_id'],
  scenario: ['id', 'steps', 'expected', 'kind'],
  spec: [
    'id', 'intent_id', 'clause', 'kind', 'mech_checkable', 'scenario_id', 'is_core',
    'status', 'blast_radius', 'created_by', 'producer', 'content_hash',
    'design_artifact_sha256', 'code_artifact_sha256', 'code_artifact_ref',
    'risk_flags', 'alternatives', 'no_alternative_reason', 'at',
  ],
  criterion: ['id', 'spec_id', 'kind', 'status_enum', 'remedy'],
  criterion_fixture: ['id', 'criterion_id', 'polarity', 'input', 'expected_status'],
  evidence: ['id', 'criterion_id', 'artifact_uri', 'artifact_sha256', 'command', 'output_digest', 'snapshot_id', 'at'],
  design_lock: ['spec_id', 'spec_version_hash', 'design_sha256', 'at'],
  redteam: ['id', 'subject_kind', 'subject_id', 'criterion_id', 'criterion_fixture_id', 'use_case', 'disposition', 'at'],
  restatement: ['id', 'intent_id', 'draft_specs', 'inputs', 'by', 'at', 'invalid_reason', 'accepted_spec_ids'],
  restatement_diff: ['id', 'restatement_id', 'kind', 'target_ref', 'disposition', 'reason', 'at'],
  claim: ['id', 'subject', 'predicate', 'value', 'as_of_frontier', 'derived_by', 'actor', 'at'],
  receipt: ['id', 'claim_ids', 'renderer', 'bytes', 'at'],
  field_consumer: ['field', 'consumer_kind', 'consumer_id'],
  scope_decl: ['id', 'stage', 'paths', 'created_by', 'at'],
  goal_node: ['id', 'parent_id', 'intent_id', 'decision_id', 'goal', 'kind', 'acceptance_criterion_id', 'scope_paths', 'at'],
  integration: ['id', 'parent_goal_id', 'child_goal_id', 'state', 'evidence_id', 'note', 'at'],
  work_unit: ['id', 'task_id', 'criterion_id', 'spec_id', 'evidence_id', 'at'],
  stage_run: ['id', 'stage', 'gate_id', 'baseline_hash', 'entered_at', 'exited_at', 'verdict', 'criteria', 'at'],
  attention: [
    'id', 'task_id', 'raised_by', 'asked_of', 'question', 'options', 'state',
    'expires_at', 'answered_by', 'withdrawn_by', 'supersedes', 'at',
  ],
  report: ['id', 'task_id', 'state', 'evidence_id', 'note', 'at'],
  review_round: ['id', 'task_id', 'baseline_hash', 'frontier', 'verdict', 'signer', 'at'],
  review: ['id', 'task_id', 'reviewer', 'subject_hash', 'subject_producer', 'finding', 'verified_by', 'verdict', 'reason', 'at'],
  verify_run: ['id', 'at', 'actor_kind', 'actor', 'groups', 'result', 'signed_by', 'note'],
  config: ['key', 'value', 'updated_by', 'updated_at'],
  event_kind: ['kind', 'since', 'note'],
  event: ['id', 'at', 'actor', 'kind', 'subject', 'payload', 'caused_by', 'request_id', 'prev', 'hash'],
  defect: ['id', 'criterion_id', 'spec_id', 'task_id', 'kind', 'severity', 'family', 'status', 'evidence', 'verify_run_id', 'closed_by', 'at'],
  release: ['id', 'package_version', 'status', 'frozen_at', 'frozen_by', 'frontier', 'baseline_hash', 'scope_spec_set', 'note'],
  release_item: ['release_id', 'kind', 'target', 'requirement_id', 'disposition', 'reason', 'defer_count', 'approved_by'],
};

const EXPECTED_TABLES = Object.keys(EXPECTED_COLUMNS).sort();

test('schema: every expected table exists (docs/03 25 + 9 support = 34)', () => {
  withMigratedDb((db) => {
    const actual = tableNames(db);
    assert.equal(actual.length, EXPECTED_TABLES.length, `table count drift: ${JSON.stringify(actual)}`);
    assert.deepEqual(actual, EXPECTED_TABLES, 'migrated table set must match the design');
  });
});

test('schema: every expected column exists (no renamed/missing columns)', () => {
  withMigratedDb((db) => {
    for (const table of EXPECTED_TABLES) {
      const expected = EXPECTED_COLUMNS[table] ?? [];
      assert.deepEqual(columnNames(db, table), [...expected], `column drift on table ${table}`);
    }
  });
});

test('schema: drift detector is not vacuous (missing table / misspelled column)', () => {
  withMigratedDb((db) => {
    const tables = tableNames(db);
    assert.ok(!tables.includes('specc'), 'a misspelled table name must not be reported present');

    const specColumns = columnNames(db, 'spec');
    assert.ok(!specColumns.includes('code_artifact_sha265'), 'a misspelled column must not be reported present');
    assert.ok(specColumns.includes('code_artifact_sha256'), 'the real column must be reported present');
  });
});
