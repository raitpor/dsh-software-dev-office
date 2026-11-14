/**
 * M1-2 对齐测试夹具：在临时已迁移库上铺事件（只经 append）。
 * 事件 id 由本文件的计数器保证唯一；时间由调用方显式给，保证 C1/C2 的先后可复现。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSdoDatabase } from '../../src/db/open.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { append, chainHead } from '../../src/db/write.js';
import { chain, seed } from '../db/append-helpers.js';
import type { EventSeed } from '../db/append-helpers.js';

export const PASSPHRASE = 'm1-2-align-passphrase';
/** 默认事件时间：早于下面所有条款的 at，便于“先复述后条款”。 */
export const ALIGN_AT = '2026-11-12T00:00:00Z';
export const SPEC_AT = '2026-11-13T00:00:00Z';

let seq = 0;

export function ev(
  kind: string,
  subject: string,
  payload: unknown,
  overrides: Partial<EventSeed> = {},
): EventSeed {
  seq += 1;
  return seed(seq, kind, subject, payload, {
    id: `e-align-${seq}`,
    at: ALIGN_AT,
    actor: 'align-fixture-actor',
    request_id: `req-align-${seq}`,
    ...overrides,
  });
}

export function appendSeeds(db: SdoDatabase, seeds: readonly EventSeed[]): void {
  const result = append(db, chain(seeds, chainHead(db)));
  if (!result.ok) {
    throw new Error(`fixture append failed: ${result.reason_code ?? 'unknown'} ${result.message ?? ''}`);
  }
}

export function eventCount(db: SdoDatabase): number {
  const row = db.prepare('SELECT count(*) AS n FROM event').get() as { n: number };
  return row.n;
}

export function withAlignDb(run: (db: SdoDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m1-2-align-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface IntentFixture {
  readonly intentId?: string;
  readonly contentHash?: string;
  readonly at?: string;
}

/** decision.valid + decision.signed + intent.signed（intent 只由签字事务落行）。 */
export function appendIntent(db: SdoDatabase, fixture: IntentFixture = {}): string {
  const intentId = fixture.intentId ?? 'INT-1';
  const contentHash = fixture.contentHash ?? 'ch:intent-1';
  const at = fixture.at ?? ALIGN_AT;
  const decisionId = `d-${intentId}`;
  appendSeeds(db, [
    ev('decision.valid', decisionId, {
      decision_kind: 'intent',
      payload_hash: `ph-${intentId}`,
      frontier: 'f-1',
      payload: { kind: 'intent', intent_id: intentId },
    }, { at }),
    ev('decision.signed', decisionId, {
      payload_hash: `ph-${intentId}`,
      signature: 'sig-fixture',
      key_id: 'key-fixture',
      signer: 'alice',
    }, { at }),
    ev('intent.signed', intentId, {
      decision_id: decisionId,
      statement: `${intentId} 的目标`,
      owner: 'alice',
      strength: 'explicit',
      content_hash: contentHash,
      baseline_hash: 'bh-1',
    }, { at }),
  ]);
  return intentId;
}

export interface RequirementFixture {
  readonly specId?: string;
  readonly intentId?: string;
  readonly at?: string;
  readonly contentHash?: string;
}

export function appendRequirement(db: SdoDatabase, fixture: RequirementFixture = {}): string {
  const specId = fixture.specId ?? 'SPEC-1';
  appendSeeds(db, [
    ev('spec.defined', specId, {
      kind: 'requirement',
      clause: `${specId} 的条款`,
      intent_id: fixture.intentId ?? 'INT-1',
      content_hash: fixture.contentHash ?? `ch:${specId}`,
    }, { at: fixture.at ?? SPEC_AT }),
  ]);
  return specId;
}

export type FixturePolarity = 'positive' | 'negative';

export interface FixtureSeed {
  readonly polarity: FixturePolarity;
  readonly input: string;
  readonly expectedStatus?: 'pass' | 'fail' | 'na';
}

/** C5 的默认例子：2 正 1 反（满足门的“每条 requirement 2 正 1 反”）。 */
export const DEFAULT_FIXTURES: readonly FixtureSeed[] = [
  { polarity: 'positive', input: 'positive-input-1' },
  { polarity: 'positive', input: 'positive-input-2' },
  { polarity: 'negative', input: 'negative-input-1' },
];

/**
 * 注册判据时**必须**带上 `fixtures[]`（M1-1 的 `criterion.registered` 事件载体，
 * D-032 裁定 ①）：reducer 同事务写 `criterion_fixture` 行（id `${criterionId}/fx/N`），
 * 门再从物化行里数例子。测试不直插夹具表，只走 `append` 唯一写入口。
 */
export function appendCriterion(
  db: SdoDatabase,
  criterionId: string,
  specId: string,
  at = SPEC_AT,
  fixtures: readonly FixtureSeed[] = DEFAULT_FIXTURES,
): string {
  appendSeeds(db, [
    ev('criterion.registered', criterionId, {
      spec_id: specId,
      kind: 'functional',
      remedy: 'fix it',
      status_enum: 'pass',
      fixtures: fixtures.map((fixture) => ({
        polarity: fixture.polarity,
        input: fixture.input,
        expected_status:
          fixture.expectedStatus ?? (fixture.polarity === 'positive' ? 'pass' : 'fail'),
      })),
    }, { at }),
  ]);
  return criterionId;
}

export function draft(id: string, clause = `${id} 的草案条款`): Record<string, unknown> {
  return { id, clause };
}

export function intentEdge(intentId: string, hash: string): { kind: string; id: string; hash: string } {
  return { kind: 'intent', id: intentId, hash };
}
