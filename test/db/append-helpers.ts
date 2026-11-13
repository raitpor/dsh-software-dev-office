import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSdoDatabase } from '../../src/db/open.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { GENESIS_PREV, computeEventHash } from '../../src/core/verify-events.js';
import type { Event } from '../../src/core/fold/types.js';

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
    return { ...event, hash };
  });
}

export function seed(
  n: number,
  kind: string,
  subject: string,
  payload: unknown,
  overrides: Partial<EventSeed> = {},
): EventSeed {
  return {
    id: `e-m1-${n}`,
    at: AT,
    actor: 'actor-1',
    kind,
    subject,
    payload,
    caused_by: [],
    request_id: `req-m1-${n}`,
    ...overrides,
  };
}

/** intent.signed 需要有效 decision(kind='intent')；返回四表链用的完整事件种子。 */
export function fourDomainSeeds(): EventSeed[] {
  return [
    seed(1, 'decision.valid', 'd-int', {
      decision_kind: 'intent',
      payload_hash: 'ph-d-int',
      frontier: 'f-1',
      payload: { kind: 'intent', intent_id: 'INT-1' },
    }),
    seed(2, 'decision.signed', 'd-int', {
      payload_hash: 'ph-d-int',
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
