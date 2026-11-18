import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CODE,
  REASON_CODES,
  fail,
  failInternalMissing,
  isReasonCode,
  validateReasonCodes,
  type ReasonCode,
  type ReasonCodeEntry,
} from '../../../src/core/errors/codes.js';
import { requireReasonCode } from '../../../src/core/errors/index.js';
import { append, type AppendAuthz } from '../../../src/db/write.js';
import { revokeLease } from '../../../src/db/lease.js';
import type { Event } from '../../../src/core/fold/types.js';
import { withCleanWriteDb } from '../../db/append-helpers.js';

const GROUPS = new Set(['auth', 'write', 'gate', 'sign', 'release', 'query', 'config', 'internal']);
const CODES_MD = new URL('../../../../src/core/errors/CODES.md', import.meta.url);

test('C1: code table shape is valid and construction rejects duplicates', () => {
  validateReasonCodes(REASON_CODES);
  for (const entry of REASON_CODES) {
    assert.match(entry.code, /^[a-z][a-z0-9_]*$/);
    assert.ok(GROUPS.has(entry.group), entry.code);
    assert.ok(entry.summary.length > 0, entry.code);
    if (entry.http_status !== undefined) assert.ok([403, 409].includes(entry.http_status), entry.code);
    if (entry.reserved === true) assert.ok((entry.reserved_for ?? '').length > 0, entry.code);
  }
  const duplicated: readonly ReasonCodeEntry[] = [...REASON_CODES, { code: CODE.no_permission, group: 'auth', summary: 'dup' }];
  assert.throws(() => validateReasonCodes(duplicated), /duplicate reason code/);
  assert.throws(
    () => validateReasonCodes([{ code: 'Bad-Code', group: 'auth', summary: 'x' }]),
    /invalid reason code/,
  );
  assert.throws(
    () => validateReasonCodes([{ code: CODE.no_permission, group: 'auth', summary: 'x', http_status: 500 }]),
    /http_status/,
  );
});

test('C1: ReasonCode union and CODE constants line up with the table', () => {
  const sample: ReasonCode = CODE.conflict;
  assert.equal(sample, 'conflict');
  assert.equal(REASON_CODES.length, new Set(REASON_CODES.map((entry) => entry.code)).size);
  assert.ok(REASON_CODES.length >= 155);
});

test('C4: representative rejection surfaces all carry a registered code', () => {
  const shapes = [
    { surface: 'write.failure', code: fail(CODE.invalid_field, 'x').reason_code },
    { surface: 'sign.fail', code: fail(CODE.not_a_signer, 'x').reason_code },
    {
      surface: 'verify.problem',
      code: ({ code: CODE.runtime_inconsistent } as { code: ReasonCode }).code,
    },
    { surface: 'internal.missing', code: failInternalMissing('no code').reason_code },
  ];
  for (const shape of shapes) {
    assert.equal(isReasonCode(shape.code), true, shape.surface);
    assert.equal(requireReasonCode(shape.code), shape.code);
  }
  assert.equal(requireReasonCode('not_a_registered_code'), CODE.internal_missing_reason_code);
  assert.equal(isReasonCode(undefined), false);
});

test('C3: generated CODES.md lists every registered code and is in sync', () => {
  const markdown = readFileSync(CODES_MD, 'utf8');
  assert.match(markdown, new RegExp(`共 ${REASON_CODES.length} 个码`));
  for (const entry of REASON_CODES) {
    assert.ok(markdown.includes(`\`${entry.code}\``), `CODES.md missing ${entry.code}`);
  }
});

test('C4: real append without session returns a registered, non-fallback code', () => {
  withCleanWriteDb((db) => {
    const result = append(db, [{} as Event], undefined as unknown as AppendAuthz);
    assert.equal(result.ok, false);
    assert.ok(result.reason_code !== undefined);
    assert.equal(isReasonCode(result.reason_code), true);
    assert.notEqual(result.reason_code, CODE.internal_missing_reason_code);
  });
});

test('C4: revokeLease without assign returns a registered, non-fallback code', () => {
  withCleanWriteDb((db) => {
    db.prepare(
      `INSERT INTO lease (id, card_id, actor, scope, frontier, ttl_s, issued_at, expires_at, status)
       VALUES ('lease-x', 'card-x', 'alice', 'src/x', 'f0', 14400, '2026-01-01T00:00:00.000Z', '2026-01-01T04:00:00.000Z', 'active')`,
    ).run();
    const result = revokeLease(
      db,
      { actor: 'mallory', actor_kind: 'human' },
      'lease-x',
      '2026-01-01T01:00:00.000Z',
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason_code, CODE.no_permission);
    assert.equal(isReasonCode(result.reason_code), true);
    assert.notEqual(result.reason_code, CODE.internal_missing_reason_code);
  });
});

test('P2-1: generate-codes --check accepts the repository state', () => {
  const script = fileURLToPath(new URL('../../../../lib/src/core/errors/generate-codes.js', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
