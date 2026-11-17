import { grantFixtureRoster } from './append-auth.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fold } from '../../src/core/fold/index.js';
import { valueHash } from '../../src/core/conflict/hash.js';
import { CONFLICT_TRACKED_FIELDS } from '../../src/core/conflict/scope.js';
import { requiredTable } from '../../src/db/write-materialize.js';
import { openSdoDatabase } from '../../src/db/open.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { canonicalJson, sha256Hex } from '../../src/core/fold/canonical.js';
import { GENESIS_PREV, computeEventHash } from '../../src/core/verify-events.js';
import type { Event, FoldState } from '../../src/core/fold/types.js';
import { installTestSignerd } from '../sign/fixture-signerd.js';
import { readEvents } from '../../src/core/verify-events.js';
import { chainHead } from '../../src/db/write.js';
import { buildEvent } from '../../src/db/freeze-store.js';
import { dispatchLease } from '../../src/db/lease.js';
import { appendAs } from './append-auth.js';

/** D-055：decision.valid 的 payload_hash 必须覆盖 payload.payload；夹具统一用它算。 */
export function payloadHashOf(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

export const PASSPHRASE = 'm1-write-test-passphrase';
export const AT = '2026-11-13T00:00:00Z';

export type EventSeed = Omit<Event, 'prev' | 'hash'>;

/** 当前库的折叠态：第二批次续写受管 kind 时传给 `chain(seeds, head, currentState(db))`。 */
export function currentState(db: SdoDatabase): FoldState {
  return fold(undefined, readEvents(db, []));
}

/**
 * 把一串种子按 GENESIS 起链算好 prev/hash；返回可交给 append 的事件。
 *
 * M3-2/P1-2：受管 kind 必须声明 `field`/`base_hash`。夹具层按 fold 逐条推进
 * 自动补 `base_hash = valueHash(当前字段值)`（显式声明优先），旧用例因此只
 * 需关心业务字段。第二批次从既有链头续写时传 `startState`（当前折叠态），
 * 否则从空态起算会得到假冲突。
 */
let ACTIVE_DB: SdoDatabase | undefined;

export function chain(
  seeds: readonly EventSeed[],
  startPrev?: string,
  startState?: FoldState,
): Event[] {
  const anchored = startPrev === undefined && ACTIVE_DB !== undefined;
  const resolvedPrev = startPrev ?? (ACTIVE_DB === undefined ? GENESIS_PREV : chainHead(ACTIVE_DB));
  let prev = resolvedPrev;
  let state: FoldState | undefined = startState;
  if (state === undefined && resolvedPrev === GENESIS_PREV) {
    try {
      state = fold(undefined, []);
    } catch {
      state = undefined;
    }
  } else if (state === undefined && anchored) {
    try {
      state = fold(undefined, readEvents(ACTIVE_DB!, []));
    } catch {
      state = undefined;
    }
  }
  return seeds.map((seed) => {
    let current = seed;
    const field = Object.hasOwn(CONFLICT_TRACKED_FIELDS, seed.kind) ? CONFLICT_TRACKED_FIELDS[seed.kind] : undefined;
    const payload = typeof seed.payload === 'object' && seed.payload !== null
      ? (seed.payload as Record<string, unknown>)
      : undefined;
    if (field !== undefined && payload !== undefined && payload['base_hash'] === undefined && state !== undefined) {
      const table = requiredTable(seed.kind);
      const row = table === undefined ? undefined : state.tables[table][seed.subject];
      current = {
        ...seed,
        payload: { ...payload, field, base_hash: valueHash(row?.[field] ?? null) },
      };
    }
    const event = { ...current, prev } as Event;
    const hash = computeEventHash(event);
    const built = { ...event, hash };
    try {
      state = fold(state, [built]);
    } catch {
      // 故意非法的种子（网关负例）无法推进折叠态；后续事件不再自动补声明。
      state = undefined;
    }
    prev = hash;
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
  // 第 2 轮 P1-1：decision.signed 的 event.at 必须等于 signerd 回执 at。
  // 夹具把签名时间与事件时间绑定（覆盖 at 时两边一起改），不是放宽网关校验。
  const eventAt = typeof overrides.at === 'string' ? overrides.at : AT;
  const signed = fixture.sign({
    decision_id: subject,
    payload_hash: payloadHash,
    frontier,
    nonce,
    ...(signer === undefined ? {} : { signer }),
    at: eventAt,
  });
  return {
    id: `e-m1-${n}`,
    at: eventAt,
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
    // P3-3：producer 是审计归属；夹具给未登记 actor（软校验放行），避免被误判成 human 产出。
    effectivePayload = {
      ...source,
      payload_hash: payloadHashOf(source['payload'] ?? {}),
      producer: source['producer'] ?? 'seed-agent',
    };
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

/** 同 withWriteDb，但不播种 fixture roster：给「拒绝路径」用例一个干净的授权库。 */
export function withCleanWriteDb(run: (db: SdoDatabase) => void): void {
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

export function withWriteDb(run: (db: SdoDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m1-write-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    ACTIVE_DB = db;
    try {
      run(db);
    } finally {
      ACTIVE_DB = undefined;
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * M4-2 裁定 A：认领必须经真派发链（claim 闸恒开）。先 dispatchLease（工具能力，
 * 不伪造 lease 事件），再 append(task.claimed)，两者都用执行时链头，不做 rechain。
 * 返回 step 级结果，便于测试断言失败码。
 */
let LEGACY_CLAIM_SEQ = 0;
export function claimWithLease(
  db: SdoDatabase,
  input: {
    card: string;
    actor: string;
    at: string;
    scope?: string;
    ttl_s?: number;
    payload?: Record<string, unknown>;
  },
): { lease: ReturnType<typeof dispatchLease>; claim: ReturnType<typeof appendAs> } {
  const scope = input.scope ?? 'domain:core';
  const lease = dispatchLease(db, { actor: 'fixture-root', actor_kind: 'service' }, {
    card: input.card,
    actor: input.actor,
    scope,
    ttl_s: input.ttl_s ?? 4 * 60 * 60,
    at: input.at,
  });
  if (!lease.ok) throw new Error(`claimWithLease dispatch failed: ${lease.reason_code} ${lease.message ?? ''}`);
  const event = buildEvent({
    id: `e-claim-${input.card}-${input.at}${LEGACY_CLAIM_SEQ++}`,
    kind: 'task.claimed',
    subject: input.card,
    actor: input.actor,
    at: input.at,
    caused_by: [],
    request_id: `req-claim-${input.card}`,
    payload: input.payload ?? {},
  }, chainHead(db));
  return { lease, claim: appendAs(db, [event]) };
}

/** 授权事件是建库预置（A2），断言业务事件数时显式排除。 */
export const AUTH_EVENT_KINDS = ['right.granted', 'right.revoked'] as const;

export function countEventsExcluding(
  db: SdoDatabase,
  kinds: readonly string[] = AUTH_EVENT_KINDS,
): number {
  const marks = kinds.map(() => '?').join(',');
  const row = db.prepare(`SELECT count(*) AS n FROM event WHERE kind NOT IN (${marks})`).get(...kinds) as { n: number };
  return row.n;
}
