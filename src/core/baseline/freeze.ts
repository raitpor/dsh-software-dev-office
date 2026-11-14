/**
 * baseline 冻结的纯逻辑部分（M2-1）：preview 计算 → confirm 绑定 → 事件/decision 载荷。
 *
 * 真源：`docs/05` `baseline_freeze` 两段式、`docs/04` §5.1/§5.2、`docs/06` §5。
 * 本文件不写库、不读时钟；DB 事务与签名在 `src/db/freeze.ts`（core→db 单向）。
 */
import { canonicalJson, sha256Hex } from '../fold/canonical.js';
import { classifyDirection, type DirectionBody, type FreezeDirection } from './direction.js';
import { validateBaseline } from './index.js';
import type { BaselineReasonCode, GuaranteeDelta, P15Result } from './types.js';

export type FreezeReasonCode =
  | BaselineReasonCode
  | 'payload_changed'
  | 'direction_mismatch'
  | 'baseline_unchanged'
  | 'no_blind_sign'
  | 'baseline_append_failed'
  | 'preview_expired'
  | 'preview_consumed'
  | 'preview_mismatch'
  | 'frontier_stale';

export interface BaselineRowLike {
  readonly id: string;
  readonly frozen_by: string;
  readonly engine_version: string;
  readonly criteria_manifest_hash: string;
  readonly policy: unknown;
  readonly criteria: unknown;
  readonly gates: unknown;
  readonly thresholds: unknown;
  readonly assurance: unknown;
  readonly prev: string | null;
  readonly direction: 'tighten' | 'loosen' | null;
  readonly hash: string;
  readonly at: string;
}

export interface BaselinePreview {
  readonly ok: true;
  readonly id: string;
  readonly hash: string;
  readonly direction: FreezeDirection;
  /** DB 行方向：首版 NULL，收紧 `tighten`、放宽 `loosen`（`docs/04` §5.1）。 */
  readonly row_direction: 'tighten' | 'loosen' | null;
  readonly prev: string | null;
  readonly will_change: Readonly<Record<string, unknown>>;
  readonly will_change_hash: string;
  readonly guarantee_delta: GuaranteeDelta;
  readonly missing: P15Result['missing'];
  readonly body: DirectionBody;
  /** 原始 JSON（用于落 baseline 事件；不参与签名）。 */
  readonly raw: Readonly<Record<string, unknown>>;
  /** decision 载荷里的 baseline 子对象（进签名）。 */
  readonly decision_baseline: Readonly<Record<string, unknown>>;
  readonly payload_hash: string;
  /** preview 时的链头；confirm 时链头不同 ⇒ 视为 preview 过期。 */
  readonly frontier: string;
}

export interface FreezeFailure {
  readonly ok: false;
  readonly reason_code: FreezeReasonCode;
  readonly message: string;
  readonly reason_codes?: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function normalizeBody(input: Record<string, unknown>): DirectionBody {
  const policy = isRecord(input['policy']) ? input['policy'] : {};
  const review = isRecord(policy['review']) ? policy['review'] : {};
  const stages = (Array.isArray(policy['stages']) ? policy['stages'] : [])
    .filter(isRecord)
    .map((stage) => ({ id: String(stage['id']), kinds: stringArray(stage['kinds']) }));
  const gates = (Array.isArray(input['gates']) ? input['gates'] : [])
    .filter(isRecord)
    .map((gate) => ({
      id: String(gate['id']),
      stage: String(gate['stage']),
      criteria: stringArray(gate['criteria']),
      policy_mode: String(gate['policy_mode']),
      waivable: gate['waivable'] === true,
    }));
  const criteria = (Array.isArray(input['criteria']) ? input['criteria'] : [])
    .filter(isRecord)
    .map((item) => String(item['id']));
  const engine = isRecord(input['engine']) ? input['engine'] : {};
  const sampleEvery = typeof review['sample_every'] === 'number' ? review['sample_every'] : null;
  return {
    stages,
    gates,
    gatesByStage: {},
    criteria,
    thresholds: isRecord(input['thresholds']) ? input['thresholds'] : {},
    assurance: isRecord(input['assurance']) ? input['assurance'] : {},
    artifactKinds: stringArray(policy['artifact_kinds']),
    sampleEvery,
    engineVersion: String(engine['version'] ?? ''),
    criteriaManifestHash: String(engine['criteria_manifest_hash'] ?? ''),
  };
}

/** C6：hash 覆盖 `docs/04` §5.1 全部字段（含 prev/direction；不含 id/frozen_by/at）。 */
export function baselineHash(input: {
  readonly prev: string | null;
  readonly rowDirection: 'tighten' | 'loosen' | null;
  readonly input: Record<string, unknown>;
}): string {
  const policy = isRecord(input.input['policy']) ? input.input['policy'] : {};
  const payload = {
    prev: input.prev,
    direction: input.rowDirection,
    engine: input.input['engine'] ?? {},
    policy: input.input['policy'] ?? {},
    criteria: input.input['criteria'] ?? [],
    gates: input.input['gates'] ?? [],
    thresholds: input.input['thresholds'] ?? {},
    assurance: input.input['assurance'] ?? {},
    artifact_kinds: policy['artifact_kinds'] ?? [],
  };
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

function computeWillChange(before: DirectionBody | null, after: DirectionBody, direction: ReturnType<typeof classifyDirection>): Record<string, unknown> {
  if (before === null) {
    return {
      first: true,
      gates: { added: after.gates.map((gate) => gate.id), removed: [], changed: [] },
      criteria: { added: after.criteria, removed: [] },
      na: { added: stringArray(after.assurance['na_stages']), removed: [] },
      engine_changed: false,
      direction,
    };
  }
  const oldGates = new Map(before.gates.map((gate) => [gate.id, gate]));
  const newGates = new Map(after.gates.map((gate) => [gate.id, gate]));
  const oldCriteria = new Map(before.gates.map((gate) => [gate.id, new Set(gate.criteria)]));
  const changed: string[] = [];
  for (const [id, gate] of newGates) {
    const old = oldGates.get(id);
    if (old === undefined) continue;
    const oldSet = oldCriteria.get(id) ?? new Set<string>();
    const same = oldSet.size === new Set(gate.criteria).size && gate.criteria.every((code) => oldSet.has(code));
    if (!same || old.policy_mode !== gate.policy_mode || old.waivable !== gate.waivable) changed.push(id);
  }
  return {
    first: false,
    gates: {
      added: [...newGates.keys()].filter((id) => !oldGates.has(id)),
      removed: [...oldGates.keys()].filter((id) => !newGates.has(id)),
      changed,
    },
    criteria: {
      added: after.criteria.filter((code) => !before.criteria.includes(code)),
      removed: before.criteria.filter((code) => !after.criteria.includes(code)),
    },
    na: {
      added: direction.loosen.filter((line) => line.startsWith('assurance.na_stages.')),
      removed: direction.tighten.filter((line) => line.startsWith('assurance.na_stages.')),
    },
    engine_changed:
      before.engineVersion !== after.engineVersion ||
      before.criteriaManifestHash !== after.criteriaManifestHash,
    direction,
  };
}

export function previewBaseline(
  input: unknown,
  options: { readonly current: BaselineRowLike | null; readonly id: string; readonly frozen_by: string; readonly frontier: string },
): BaselinePreview | FreezeFailure {
  const p15 = validateBaseline(input);
  if (!p15.ok) {
    const first = (p15.reason_codes[0] ?? 'invalid_baseline') as FreezeReasonCode;
    return { ok: false, reason_code: first, message: `P15 校验未通过：${p15.reason_codes.join(', ')}`, reason_codes: p15.reason_codes };
  }
  if (!isRecord(input)) return { ok: false, reason_code: 'invalid_baseline', message: 'baseline 必须是对象' };
  const body = normalizeBody(input);
  const before = options.current === null ? null : normalizeBodyFromRow(options.current);
  const verdict = classifyDirection(before, body);
  const rowDirection = verdict.direction === 'tighten' ? 'tighten' : verdict.direction === 'loosen' ? 'loosen' : null;
  const prev = options.current?.id ?? null;
  const hash = baselineHash({ prev, rowDirection, input });
  if (options.current !== null) {
    // “内容没变”要按当前行自己的 prev/direction 复算，而不是把新行的 prev 算进去。
    const sameAsCurrent = baselineHash({
      prev: options.current.prev,
      rowDirection: options.current.direction,
      input,
    });
    if (sameAsCurrent === options.current.hash) {
      return { ok: false, reason_code: 'baseline_unchanged', message: '与当前 baseline 内容完全相同' };
    }
  }
  const will_change = computeWillChange(before, body, verdict);
  const will_change_hash = `sha256:${sha256Hex(canonicalJson(will_change))}`;
  const policy = isRecord(input['policy']) ? input['policy'] : {};
  const decision_baseline = {
    id: options.id,
    hash,
    policy_id: String(policy['id'] ?? ''),
    preset: typeof policy['preset'] === 'string' ? policy['preset'] : null,
    prev,
    direction: rowDirection,
    will_change_hash,
    guarantee_delta: p15.guarantee_delta,
    ...(p15.missing === undefined ? {} : { missing: p15.missing }),
    will_change,
  };
  return {
    ok: true,
    id: options.id,
    hash,
    direction: verdict.direction,
    row_direction: rowDirection,
    prev,
    will_change,
    will_change_hash,
    guarantee_delta: p15.guarantee_delta,
    missing: p15.missing,
    body,
    raw: input,
    decision_baseline,
    payload_hash: `sha256:${sha256Hex(canonicalJson(decision_baseline))}`,
    frontier: options.frontier,
  };
}

export function normalizeBodyFromRow(row: BaselineRowLike): DirectionBody {
  return normalizeBody({
    policy: row.policy,
    criteria: row.criteria,
    gates: row.gates,
    thresholds: row.thresholds,
    assurance: row.assurance,
    engine: { version: row.engine_version, criteria_manifest_hash: row.criteria_manifest_hash },
  });
}

const DECLARED: Readonly<Record<string, FreezeDirection>> = {
  initial: 'initial',
  tighten: 'tighten',
  loosen: 'loosen',
};

export function confirmBaseline(
  preview: BaselinePreview,
  expectedPayloadHash: string,
  declaredDirection?: string,
): BaselinePreview | FreezeFailure {
  if (preview.payload_hash !== expectedPayloadHash) {
    return { ok: false, reason_code: 'payload_changed', message: 'confirm 的 payload_hash 与 preview 不一致' };
  }
  if (declaredDirection !== undefined) {
    const declared = DECLARED[declaredDirection];
    if (declared === undefined || declared !== preview.direction) {
      return {
        ok: false,
        reason_code: 'direction_mismatch',
        message: `调用方声明方向 ${declaredDirection}，工具判定为 ${preview.direction}`,
      };
    }
  }
  const baseline = preview.decision_baseline;
  if (baseline['will_change_hash'] === undefined || baseline['guarantee_delta'] === undefined) {
    return { ok: false, reason_code: 'no_blind_sign', message: 'baseline 签名载荷缺 will_change_hash 或 guarantee_delta' };
  }
  return preview;
}

export function freezeEventKind(direction: FreezeDirection): 'baseline.frozen' | 'baseline.amended' | 'baseline.loosened' {
  if (direction === 'initial') return 'baseline.frozen';
  return direction === 'tighten' ? 'baseline.amended' : 'baseline.loosened';
}

export function baselineEventPayload(preview: BaselinePreview, input: Record<string, unknown>, decisionId: string, frozenBy: string): Record<string, unknown> {
  const policy = isRecord(input['policy']) ? input['policy'] : {};
  return {
    policy: input['policy'] ?? {},
    criteria: input['criteria'] ?? [],
    gates: input['gates'] ?? [],
    thresholds: input['thresholds'] ?? {},
    assurance: input['assurance'] ?? {},
    engine: input['engine'] ?? {},
    artifact_kinds: policy['artifact_kinds'] ?? [],
    prev: preview.prev,
    direction: preview.row_direction,
    hash: preview.hash,
    frozen_by: frozenBy,
    decision_id: decisionId,
    will_change_hash: preview.will_change_hash,
    guarantee_delta: preview.guarantee_delta,
  };
}
