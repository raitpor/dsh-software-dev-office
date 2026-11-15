/**
 * M2-4 C5 · `spec_set` 集合签字载荷的**工具渲染**（模型无写入口）。
 *
 * `docs/06` §5：`clause_readings[]` 只能是工具从当前条款版本与 pre-work 判据读数渲染出来的，
 * 模型只能选 `spec_ids`；`readings_hash` 是 `clause_readings` 的规范化哈希，
 * `content_hash` 必须覆盖 `readings_hash`。任何一项被人手改 ⇒ 两处哈希对不上 ⇒ 签名作废。
 *
 * 本模块只做“渲染 + 校验”；不 append、不读 sqlite、不 import `src/core/gate`。
 */
import type { FoldState } from '../core/fold/types.js';
import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';
import { preWorkReadingsForSpec, specVersionHash, type PreWorkReading } from './clause.js';

/** `docs/06` §5 的六字段（A4 待确认的最小形状）。 */
export interface ClauseReading {
  readonly spec_id: string;
  readonly spec_version_hash: string;
  readonly criterion: string;
  readonly verdict: string;
  readonly stage_run_id: string;
  readonly data_hash: string;
}

export interface SpecSetRenderInput {
  readonly spec_ids: readonly string[];
  readonly as_of_frontier: readonly string[];
  readonly dispositions?: readonly unknown[];
}

export interface SpecSetPayload {
  readonly decision_kind: 'spec_set';
  readonly spec_ids: readonly string[];
  readonly dispositions: readonly unknown[];
  readonly clause_readings: readonly ClauseReading[];
  readonly readings_hash: string;
  readonly content_hash: string;
  readonly as_of_frontier: readonly string[];
}

export type SpecSetRenderFailure = {
  readonly ok: false;
  readonly reason_code:
    | 'invalid_field'
    | 'spec_ids_mismatch'
    | 'spec_not_found'
    | 'clause_unjudged'
    | 'no_requirement';
  readonly message: string;
};

export type SpecSetRenderResult = { readonly ok: true; readonly payload: SpecSetPayload } | SpecSetRenderFailure;

const FORBIDDEN = ['clause_readings', 'readings_hash', 'content_hash'] as const;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}

/** 当前全部 requirement 条款 id（排序；C5 `spec_ids` 必须与它相等）。 */
export function currentRequirementSpecIds(state: FoldState): string[] {
  return Object.values(state.tables.spec)
    .filter((row) => row['kind'] === 'requirement')
    .map((row) => text(row['id']))
    .filter((id) => id.length > 0)
    .sort();
}

/**
 * 每条 requirement 的 pre-work 读数（每个 criterion 取最新一条），排序确定。
 * 无读数/条款不存在 ⇒ 结构化失败 `clause_unjudged`（与 C4 同一读数来源，不造第二套）。
 */
export function collectClauseReadings(
  state: FoldState,
  specIds: readonly string[],
): { ok: true; readings: ClauseReading[] } | SpecSetRenderFailure {
  const readings: ClauseReading[] = [];
  for (const specId of [...specIds].sort()) {
    if (state.tables.spec[specId] === undefined) {
      return { ok: false, reason_code: 'spec_not_found', message: `spec ${specId} not found` };
    }
    const version = specVersionHash(state, specId);
    if (version === undefined) {
      return { ok: false, reason_code: 'spec_not_found', message: `spec ${specId} not found` };
    }
    const byCriterion = new Map<string, PreWorkReading>();
    for (const reading of preWorkReadingsForSpec(state, specId)) {
      byCriterion.set(reading.criterion, reading);
    }
    if (byCriterion.size === 0) {
      return {
        ok: false,
        reason_code: 'clause_unjudged',
        message: `requirement ${specId} has no pre-work reading; every requirement must be judged before signing`,
      };
    }
    for (const criterion of [...byCriterion.keys()].sort()) {
      const reading = byCriterion.get(criterion);
      if (reading === undefined) continue;
      readings.push({
        spec_id: specId,
        spec_version_hash: version,
        criterion: reading.criterion,
        verdict: reading.verdict,
        stage_run_id: reading.stage_run_id,
        data_hash: reading.data_hash,
      });
    }
  }
  return { ok: true, readings };
}

export function readingsHashOf(readings: readonly ClauseReading[]): string {
  return `sha256:${sha256Hex(canonicalJson(readings))}`;
}

export function specSetContentHashOf(input: {
  readonly spec_ids: readonly string[];
  readonly dispositions: readonly unknown[];
  readonly readings_hash: string;
  readonly as_of_frontier: readonly string[];
}): string {
  const covered = {
    decision_kind: 'spec_set',
    spec_ids: [...input.spec_ids].sort(),
    dispositions: input.dispositions,
    readings_hash: input.readings_hash,
    as_of_frontier: input.as_of_frontier,
  };
  return `sha256:${sha256Hex(canonicalJson(covered))}`;
}

/**
 * C5：渲染 `spec_set` 载荷。
 *
 * 调用方只能给 `spec_ids` / `as_of_frontier` / `dispositions`；
 * 传入 `clause_readings`/`readings_hash`/`content_hash` 一律 `invalid_field`（模型没有写入口）。
 * `spec_ids` 必须恰好是当前全部 requirement（漏一条/多一条都拒）——防止“只签看过的部分”。
 */
export function renderSpecSetPayload(state: FoldState, input: unknown): SpecSetRenderResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason_code: 'invalid_field', message: 'spec_set payload input must be an object' };
  }
  const raw = input as Record<string, unknown>;
  for (const key of FORBIDDEN) {
    if (Object.hasOwn(raw, key)) {
      return {
        ok: false,
        reason_code: 'invalid_field',
        message: `renderSpecSetPayload renders ${key} itself; the caller must not supply it`,
      };
    }
  }
  const specIds = asStringArray(raw['spec_ids']);
  if (specIds === undefined) {
    return { ok: false, reason_code: 'invalid_field', message: 'spec_ids must be a string array' };
  }
  const frontier = asStringArray(raw['as_of_frontier']);
  if (frontier === undefined) {
    return { ok: false, reason_code: 'invalid_field', message: 'as_of_frontier must be a string array' };
  }
  const dispositions = raw['dispositions'] === undefined ? [] : raw['dispositions'];
  if (!Array.isArray(dispositions)) {
    return { ok: false, reason_code: 'invalid_field', message: 'dispositions must be an array' };
  }
  const expected = currentRequirementSpecIds(state);
  const wanted = [...specIds].sort();
  if (expected.length === 0) {
    return { ok: false, reason_code: 'no_requirement', message: 'there is no requirement spec to sign' };
  }
  if (wanted.length !== expected.length || wanted.some((id, index) => id !== expected[index])) {
    return {
      ok: false,
      reason_code: 'spec_ids_mismatch',
      message: `spec_ids must cover exactly the current requirements: expected [${expected.join(', ')}]`,
    };
  }
  const collected = collectClauseReadings(state, expected);
  if (!collected.ok) return collected;
  const readings = collected.readings;
  const covered = [...new Set(readings.map((reading) => reading.spec_id))].sort();
  if (covered.length !== expected.length || covered.some((id, index) => id !== expected[index])) {
    return {
      ok: false,
      reason_code: 'clause_unjudged',
      message: `clause_readings must cover every requirement: expected [${expected.join(', ')}]`,
    };
  }
  if (readings.length === 0) {
    return {
      ok: false,
      reason_code: 'clause_unjudged',
      message: 'no pre-work reading for the current requirements',
    };
  }
  const readingsHash = readingsHashOf(readings);
  const contentHash = specSetContentHashOf({
    spec_ids: expected,
    dispositions,
    readings_hash: readingsHash,
    as_of_frontier: frontier,
  });
  return {
    ok: true,
    payload: {
      decision_kind: 'spec_set',
      spec_ids: expected,
      dispositions,
      clause_readings: readings,
      readings_hash: readingsHash,
      content_hash: contentHash,
      as_of_frontier: frontier,
    },
  };
}

export type SpecSetVerifyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason_code:
        | 'invalid_field'
        | 'readings_hash_mismatch'
        | 'content_hash_mismatch'
        | 'spec_ids_mismatch'
        | 'clause_readings_incomplete';
      readonly message: string;
    };

/**
 * C5：校验（人签前/verify 时复算）。手改 `clause_readings` 任一字段 ⇒ `readings_hash_mismatch`；
 * 手改 `spec_ids`/`dispositions`/`readings_hash` ⇒ `content_hash_mismatch`（或前者先报）。
 */
export function verifySpecSetPayload(payload: unknown): SpecSetVerifyResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason_code: 'invalid_field', message: 'payload must be an object' };
  }
  const raw = payload as Record<string, unknown>;
  const specIds = asStringArray(raw['spec_ids']);
  const frontier = asStringArray(raw['as_of_frontier']);
  const readings = raw['clause_readings'];
  const dispositions = raw['dispositions'];
  const readingsHash = text(raw['readings_hash']);
  const contentHash = text(raw['content_hash']);
  if (specIds === undefined || frontier === undefined || !Array.isArray(readings) || !Array.isArray(dispositions)) {
    return { ok: false, reason_code: 'invalid_field', message: 'payload shape is invalid' };
  }
  // P1：载荷必须覆盖 spec_ids 里的每一条 requirement；缺一条都拒（防“签了未判条款”）。
  const covered = [
    ...new Set(
      readings.map((reading) =>
        reading !== null && typeof reading === 'object' ? text((reading as Record<string, unknown>)['spec_id']) : '',
      ),
    ),
  ]
    .filter((id) => id.length > 0)
    .sort();
  const wanted = [...specIds].sort();
  if (covered.length !== wanted.length || covered.some((id, index) => id !== wanted[index])) {
    return {
      ok: false,
      reason_code: 'clause_readings_incomplete',
      message: `clause_readings must cover every spec_id: expected [${wanted.join(', ')}]`,
    };
  }
  const recomputedReadings = readingsHashOf(readings as ClauseReading[]);
  if (recomputedReadings !== readingsHash) {
    return { ok: false, reason_code: 'readings_hash_mismatch', message: 'clause_readings do not match readings_hash' };
  }
  const recomputedContent = specSetContentHashOf({
    spec_ids: specIds,
    dispositions,
    readings_hash: recomputedReadings,
    as_of_frontier: frontier,
  });
  if (recomputedContent !== contentHash) {
    return { ok: false, reason_code: 'content_hash_mismatch', message: 'payload does not match content_hash' };
  }
  return { ok: true };
}
