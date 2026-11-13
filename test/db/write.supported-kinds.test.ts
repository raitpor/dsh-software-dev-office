import assert from 'node:assert/strict';
import { test } from 'node:test';

import { append } from '../../src/db/write.js';
import { SUPPORTED_KINDS } from '../../src/db/write-materialize.js';
import { verify } from '../../src/core/verify.js';
import { chain, fourDomainSeeds, seed, withWriteDb, type EventSeed } from './append-helpers.js';

/**
 * P1（第 63 轮）：17 个 `SUPPORTED_KINDS` 每一个都要有 append 正例——
 * 一条最小合法事件能写入、`verify()` 绿；再追加一条无关第二批仍绿。
 * 这同时证明“supported 分类”不是纸面声明（P2-2）。
 */

type Case = readonly [kind: string, build: () => EventSeed[]];

type Db = Parameters<typeof append>[0];

function row(db: Db, sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
  return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
}

function expectRow(db: Db, sql: string, ...params: unknown[]): Record<string, unknown> {
  const found = row(db, sql, ...params);
  assert.ok(found, `expected materialized row for: ${sql}`);
  return found;
}

/** P1-2：kind → 物化表 + 最小充分列（1:1）。verify 只对账 4 表，抓不到其余 3 张。 */
const PROBES: Readonly<Record<string, (db: Db) => void>> = {
  'decision.valid': (db) => {
    assert.equal(row(db, 'SELECT id FROM decision WHERE id = ?', 'd-v'), undefined, 'valid-only row must not materialize');
  },
  'decision.signed': (db) => assert.equal(expectRow(db, 'SELECT signature FROM decision WHERE id = ?', 'd-s').signature, 'sig-d-s'),
  'decision.revoked': (db) => assert.equal(expectRow(db, 'SELECT status FROM decision WHERE id = ?', 'd-rv').status, 'revoked'),
  'decision.rejected': (db) => assert.equal(expectRow(db, 'SELECT status FROM decision WHERE id = ?', 'd-rj').status, 'invalid'),
  'intent.signed': (db) => assert.equal(expectRow(db, 'SELECT decision_id FROM intent WHERE id = ?', 'INT-1').decision_id, 'd-int'),
  'spec.defined': (db) => assert.equal(expectRow(db, 'SELECT clause FROM spec WHERE id = ?', 'SPEC-1').clause, 'clause 1'),
  'spec.revised': (db) => assert.equal(expectRow(db, 'SELECT clause FROM spec WHERE id = ?', 'SPEC-1').clause, 'clause 2'),
  'assumption.recorded': (db) => {
    const spec = expectRow(db, 'SELECT kind, status FROM spec WHERE id = ?', 'A-1');
    assert.equal(spec.kind, 'assumption');
    assert.equal(spec.status, 'open');
  },
  'assumption.disposed': (db) => assert.equal(expectRow(db, 'SELECT status FROM spec WHERE id = ?', 'A-1').status, 'confirmed'),
  'assumption.invalidated': (db) => assert.equal(expectRow(db, 'SELECT status FROM spec WHERE id = ?', 'A-2').status, 'open'),
  'contract.defined': (db) => assert.equal(expectRow(db, 'SELECT kind FROM spec WHERE id = ?', 'CT-1').kind, 'contract'),
  'criterion.registered': (db) => assert.equal(expectRow(db, 'SELECT remedy FROM criterion WHERE id = ?', 'CRIT-1').remedy, 'fix it'),
  'criterion.revised': (db) => assert.equal(expectRow(db, 'SELECT remedy FROM criterion WHERE id = ?', 'CRIT-1').remedy, 'better'),
  'evidence.attached': (db) => assert.equal(expectRow(db, 'SELECT criterion_id FROM evidence WHERE id = ?', 'EVID-1').criterion_id, 'CRIT-1'),
  'restatement.recorded': (db) => assert.equal(expectRow(db, 'SELECT intent_id FROM restatement WHERE id = ?', 'R-1').intent_id, 'INT-1'),
  'restatement.diff_dispositioned': (db) => assert.equal(expectRow(db, 'SELECT kind FROM restatement_diff WHERE id = ?', 'RD-1').kind, 'agree'),
  'restatement.invalidated': (db) => assert.equal(expectRow(db, 'SELECT invalid_reason FROM restatement WHERE id = ?', 'R-1').invalid_reason, 'stale'),
};

const PH = (suffix: string): string => `ph-${suffix}`;

function decisionValid(id: string, kind: string, payload: unknown, hash = PH(id)): EventSeed {
  return seed(0, 'decision.valid', id, {
    decision_kind: kind,
    payload_hash: hash,
    frontier: `f-${id}`,
    payload,
  });
}

function decisionSigned(id: string, hash = PH(id)): EventSeed {
  return seed(0, 'decision.signed', id, {
    payload_hash: hash,
    signature: `sig-${id}`,
    key_id: 'key-1',
    signer: 'alice',
  });
}

function decisionOf(id: string, kind: string, payload: unknown): EventSeed[] {
  return [decisionValid(id, kind, payload), decisionSigned(id)];
}

const assumption = (id: string): EventSeed =>
  seed(0, 'assumption.recorded', id, {
    intent_id: 'INT-1',
    clause: `clause ${id}`,
    blast_radius: 'low',
    content_hash: `ch:${id}`,
  });

const CASES: readonly Case[] = [
  ['decision.valid', () => [decisionValid('d-v', 'intent', { kind: 'intent' })]],
  ['decision.signed', () => decisionOf('d-s', 'intent', { kind: 'intent' })],
  ['decision.revoked', () => [...decisionOf('d-rv', 'intent', { kind: 'intent' }), seed(0, 'decision.revoked', 'd-rv', { reason: 'superseded' })]],
  ['decision.rejected', () => [...decisionOf('d-rj', 'intent', { kind: 'intent' }), seed(0, 'decision.rejected', 'd-rj', { reason: 'wrong' })]],
  ['intent.signed', () => [...fourDomainSeeds()]],
  ['spec.defined', () => [...fourDomainSeeds()]],
  ['spec.revised', () => [...fourDomainSeeds(), seed(0, 'spec.revised', 'SPEC-1', { reason: 'tighten', clause: 'clause 2' })]],
  ['assumption.recorded', () => [...fourDomainSeeds(), assumption('A-1')]],
  [
    'assumption.disposed',
    () => [
      ...fourDomainSeeds(),
      assumption('A-1'),
      ...decisionOf('d-as', 'assumption_set', {
        spec_ids: ['A-1'],
        dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
      }),
      seed(0, 'assumption.disposed', 'A-1', { decision_id: 'd-as', disposition: 'confirmed' }),
    ],
  ],
  [
    'assumption.invalidated',
    () => [...fourDomainSeeds(), assumption('A-2'), seed(0, 'assumption.invalidated', 'A-2', { reason: 'inputs changed' })],
  ],
  ['contract.defined', () => [...fourDomainSeeds(), seed(0, 'contract.defined', 'CT-1', { intent_id: 'INT-1', clause: 'contract', content_hash: 'ch:ct' })]],
  ['criterion.registered', () => [...fourDomainSeeds()]],
  ['criterion.revised', () => [...fourDomainSeeds(), seed(0, 'criterion.revised', 'CRIT-1', { remedy: 'better' })]],
  ['evidence.attached', () => [...fourDomainSeeds()]],
  ['restatement.recorded', () => [...fourDomainSeeds(), seed(0, 'restatement.recorded', 'R-1', { intent_id: 'INT-1', draft_specs: [], inputs: [] })]],
  [
    'restatement.diff_dispositioned',
    () => [
      ...fourDomainSeeds(),
      seed(0, 'restatement.recorded', 'R-1', { intent_id: 'INT-1', draft_specs: [], inputs: [] }),
      seed(0, 'restatement.diff_dispositioned', 'RD-1', {
        restatement_id: 'R-1',
        kind: 'agree',
        target_ref: 'd1',
        disposition: 'accept',
      }),
    ],
  ],
  [
    'restatement.invalidated',
    () => [
      ...fourDomainSeeds(),
      seed(0, 'restatement.recorded', 'R-1', { intent_id: 'INT-1', draft_specs: [], inputs: [] }),
      seed(0, 'restatement.invalidated', 'R-1', { reason: 'stale' }),
    ],
  ],
];

function numbered(seeds: readonly EventSeed[], prefix = 'sup'): EventSeed[] {
  return seeds.map((event, index) => ({
    ...event,
    id: `e-${prefix}-${index + 1}`,
    request_id: `req-${prefix}-${index + 1}`,
  }));
}

test('P1: SUPPORTED_KINDS has a positive append case for every kind', () => {
  assert.equal(CASES.length, Object.keys(SUPPORTED_KINDS).length);
  for (const [kind] of CASES) {
    assert.ok(Object.hasOwn(SUPPORTED_KINDS, kind), `case ${kind} is not in SUPPORTED_KINDS`);
  }
});

for (const [kind, build] of CASES) {
  test(`P1: supported kind ${kind} appends, verifies, and survives a second batch`, () => {
    withWriteDb((db) => {
      const batch = chain(numbered(build()));
      const first = append(db, batch);
      assert.equal(first.ok, true, `${kind}: ${first.reason_code ?? ''} ${first.message ?? ''}`);
      assert.equal(first.written, batch.length);
      assert.deepEqual(verify(db).problems, [], `${kind}: verify after first batch`);

      const probe = PROBES[kind];
      assert.ok(probe, `missing materialized-row probe for ${kind}`);
      probe(db);

      const head = batch[batch.length - 1]?.hash;
      const second = chain(numbered([decisionValid('d-unrelated', 'intent', { kind: 'intent' })], 'sup2'), head);
      const result = append(db, second);
      assert.equal(result.ok, true, `${kind} second batch: ${result.reason_code ?? ''} ${result.message ?? ''}`);
      assert.deepEqual(verify(db).problems, [], `${kind}: verify after second batch`);
    });
  });
}
