import { fail, optString, payloadOf, reqEnum, reqString, rowOf, subjectId, upsert } from '../guards.js';
import { requireSignedDecision } from '../decisions.js';
import type { Event, FoldWorking } from '../types.js';

const DIRECTIONS = ['tighten', 'loosen'] as const;

/** docs/04 §5.1：engine 只保留 version 与 criteria_manifest_hash 两个字段。 */
function engineFields(event: Event): { engine_version: string; criteria_manifest_hash: string } {
  const engine = payloadOf(event)['engine'];
  if (engine === null || typeof engine !== 'object' || Array.isArray(engine)) {
    return fail(event, 'baseline requires payload.engine {version, criteria_manifest_hash}');
  }
  const source = engine as Record<string, unknown>;
  const version = source['version'];
  const manifest = source['criteria_manifest_hash'];
  if (typeof version !== 'string' || typeof manifest !== 'string') {
    return fail(event, 'payload.engine.version and criteria_manifest_hash must be strings');
  }
  return { engine_version: version, criteria_manifest_hash: manifest };
}

/** docs/04 §5.2：链只能沿当前 head 前进；有分叉或回指祖先都说明绕过了签字。 */
function baselineHead(state: FoldWorking, event: Event): string | null {
  const referenced = new Set<string>();
  for (const row of Object.values(state.tables.baseline)) {
    const prev = row['prev'];
    if (typeof prev === 'string') {
      referenced.add(prev);
    }
  }
  const heads = Object.keys(state.tables.baseline).filter((id) => !referenced.has(id));
  if (heads.length > 1) {
    return fail(event, `baseline chain has multiple heads: ${heads.join(', ')}`);
  }
  return heads[0] ?? null;
}

/** 落点是新行，不是原地改：收紧/放宽都 append，旧行 hash 永远可复算（docs/04 §5.2）。 */
function appendBaseline(
  state: FoldWorking,
  event: Event,
  direction: 'tighten' | 'loosen' | null,
  requirePrev: boolean,
): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  if (rowOf(state, 'baseline', id) !== undefined) {
    return fail(event, `baseline ${id} already exists; amendments are new rows`);
  }
  const prev = optString(event, payload, 'prev') ?? null;
  if (requirePrev && prev === null) {
    return fail(event, 'baseline amendments require payload.prev');
  }
  if (prev !== null && rowOf(state, 'baseline', prev) === undefined) {
    return fail(event, `prev baseline ${prev} does not exist`);
  }
  if (requirePrev && prev !== null) {
    const head = baselineHead(state, event);
    if (head === null) {
      return fail(event, 'baseline chain has no head; cannot amend');
    }
    if (prev !== head) {
      return fail(event, `prev baseline ${prev} is not the current head ${head}`);
    }
  }
  const engine = engineFields(event);
  upsert(state, 'baseline', id, {
    id,
    frozen_by: optString(event, payload, 'frozen_by') ?? event.actor,
    ...engine,
    policy: payload['policy'] ?? {},
    criteria: payload['criteria'] ?? [],
    gates: payload['gates'] ?? {},
    thresholds: payload['thresholds'] ?? {},
    assurance: payload['assurance'] ?? {},
    prev,
    direction,
    hash: reqString(event, payload, 'hash'),
    at: event.at,
  });
}

export function baselineFrozen(state: FoldWorking, event: Event): void {
  if (Object.keys(state.tables.baseline).length > 0) {
    return fail(event, 'baseline.frozen is only for the first baseline; use amended/loosened');
  }
  appendBaseline(state, event, null, false);
}

export function baselineAmended(state: FoldWorking, event: Event): void {
  const direction = reqEnum(event, payloadOf(event), 'direction', DIRECTIONS);
  if (direction !== 'tighten') {
    return fail(event, 'baseline.amended only records tighten; use baseline.loosened');
  }
  appendBaseline(state, event, 'tighten', true);
}

/** 放宽必须事前人签（decision kind='baseline'）；落新行。 */
export function baselineLoosened(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const direction = reqEnum(event, payload, 'direction', DIRECTIONS);
  if (direction !== 'loosen') {
    return fail(event, 'baseline.loosened requires direction=loosen');
  }
  const decisionId = reqString(event, payload, 'decision_id');
  requireSignedDecision(state, event, decisionId, 'baseline');
  appendBaseline(state, event, 'loosen', true);
}

export const BASELINE_REDUCERS = {
  'baseline.frozen': baselineFrozen,
  'baseline.amended': baselineAmended,
  'baseline.loosened': baselineLoosened,
} as const;
