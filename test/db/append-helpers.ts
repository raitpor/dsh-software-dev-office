import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSdoDatabase } from '../../src/db/open.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { canonicalJson, sha256Hex } from '../../src/core/fold/canonical.js';
import { GENESIS_PREV, computeEventHash } from '../../src/core/verify-events.js';
import type { Event } from '../../src/core/fold/types.js';
import { installTestSignerd } from '../sign/fixture-signerd.js';

/** D-055：decision.valid 的 payload_hash 必须覆盖 payload.payload；夹具统一用它算。 */
export function payloadHashOf(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

export const PASSPHRASE = 'm1-write-test-passphrase';
export const AT = '2026-11-13T00:00:00Z';

export type EventSeed = Omit<Event, 'prev' | 'hash'>;

/** 把一串种子按 GENESIS 起链算好 prev/hash；返回可交给 append 的事件。 */
export function chain(seeds: readonly EventSeed[], startPrev = GENESIS_PREV): Event[] {
  let prev = startPrev;
  return seeds.map((seed) => {
    const event = { ...seed, prev } as Event;
    const hash = computeEventHash(event);
    prev = hash;
    const built = { ...event, hash };
    // 没有测试缝：世界链不含 gate.judged，需要判定行的测试走 `judgeStage()` 真路径。
    return built;
  });
}

/**
 * decision.signed 是写网关验签的入口（C8）：夹具必须真签，不能再用 `signature: 'sig'`。
 * 夹具按 payload 里的 payload_hash/frontier/nonce 出真 Ed25519 签名，并落一条回执；
 * 调用方给 `signature`/`key_id` 的假值被忽略（否则测试就在测一个假网关）。
 */
function signedDecisionSeed(
  n: number,
  subject: string,
  payload: unknown,
  overrides: Partial<EventSeed>,
): EventSeed {
  const fixture = installTestSignerd();
  const source = (
    typeof payload === 'object' && payload !== null ? payload : {}
  ) as Record<string, unknown>;
  const payloadHash =
    typeof source['payload_hash'] === 'string' && source['payload_hash'].length > 0
      ? source['payload_hash']
      : `sha256:${'0'.repeat(64)}`;
  const frontier = typeof source['frontier'] === 'string' && source['frontier'].length > 0
    ? source['frontier']
    : 'f-1';
  const nonce = typeof source['nonce'] === 'string' && source['nonce'].length > 0
    ? source['nonce']
    : `nonce-${subject}`;
  const signer = typeof source['signer'] === 'string' && source['signer'].length > 0
    ? source['signer']
    : undefined;
  const signed = fixture.sign({
    decision_id: subject,
    payload_hash: payloadHash,
    frontier,
    nonce,
    ...(signer === undefined ? {} : { signer }),
    at: AT,
  });
  return {
    id: `e-m1-${n}`,
    at: AT,
    actor: 'actor-1',
    kind: 'decision.signed',
    subject,
    payload: signed,
    caused_by: [],
    request_id: `req-m1-${n}`,
    ...overrides,
  };
}

export function seed(
  n: number,
  kind: string,
  subject: string,
  payload: unknown,
  overrides: Partial<EventSeed> = {},
): EventSeed {
  if (kind === 'decision.signed') return signedDecisionSeed(n, subject, payload, overrides);
  let effectivePayload = payload;
  if (kind === 'decision.valid') {
    const source = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    effectivePayload = { ...source, payload_hash: payloadHashOf(source['payload'] ?? {}) };
  }
  return {
    id: `e-m1-${n}`,
    at: AT,
    actor: 'actor-1',
    kind,
    subject,
    payload: effectivePayload,
    caused_by: [],
    request_id: `req-m1-${n}`,
    ...overrides,
  };
}

/** intent.signed 需要有效 decision(kind='intent')；返回四表链用的完整事件种子。 */
export function fourDomainSeeds(): EventSeed[] {
  const intentPayload = { kind: 'intent', intent_id: 'INT-1' };
  const intentHash = payloadHashOf(intentPayload);
  return [
    seed(1, 'decision.valid', 'd-int', {
      decision_kind: 'intent',
      payload_hash: intentHash,
      frontier: 'f-1',
      payload: intentPayload,
    }),
    seed(2, 'decision.signed', 'd-int', {
      payload_hash: intentHash,
      signature: 'sig',
      key_id: 'key-1',
      signer: 'alice',
    }),
    seed(3, 'intent.signed', 'INT-1', {
      decision_id: 'd-int',
      statement: 'intent 1',
      owner: 'alice',
      strength: 'explicit',
      content_hash: 'ch:int-1',
      baseline_hash: 'bh-1',
    }),
    seed(4, 'spec.defined', 'SPEC-1', {
      kind: 'requirement',
      clause: 'clause 1',
      intent_id: 'INT-1',
      content_hash: 'sha256:spec-1',
    }),
    seed(5, 'criterion.registered', 'CRIT-1', {
      fixtures: [
        { polarity: 'positive', input: 'p', expected_status: 'pass' },
        { polarity: 'negative', input: 'n', expected_status: 'fail' },
      ],
      spec_id: 'SPEC-1',
      kind: 'functional',
      remedy: 'fix it',
      status_enum: 'pass',
    }),
    seed(6, 'evidence.attached', 'EVID-1', {
      criterion_id: 'CRIT-1',
      artifact_uri: 'file:///tmp/artifact',
      artifact_sha256: 'sha256:abc',
      command: 'npm test',
    }),
  ];
}

export function withWriteDb(run: (db: SdoDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m1-write-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
