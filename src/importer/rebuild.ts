/**
 * 重建层：把 v1 导出里的「结论型回执（claim）」重建成 v2 fold 能吃的事件流，
 * 再把 fold 物化出来的 `work_unit` 行与导出逐字段比对。
 *
 * 为什么一条 claim 要 4 条事件：v2 的 `work_unit` 由 `task.created` +
 * `task.claimed` + `criterion.registered` + `evidence.attached` 物化
 * （见 `src/core/fold/reducers/workunit.ts`），单条事件没有 work_unit 的物化路径。
 * 这里只是**重建的推演**，不写库、不改 fold。
 *
 * claim 的 subject 约定按 D-008 文本口径：`claim.subject = task.id`；M0 只处理
 * 「结论型」回执（predicate=done / value=true），其他谓词由 parse 层 fail-closed。
 */

import { FoldError, fold, type Event, type FoldState } from '../core/fold/index.js';
import { computeEventHash } from '../core/verify-events.js';
import { CONCLUSION_PREDICATE, ImportError, type ExportClaim } from './parse.js';

export const WORK_UNIT_FIELDS = [
  'id',
  'task_id',
  'criterion_id',
  'spec_id',
  'evidence_id',
  'at',
] as const;
export type WorkUnitField = (typeof WORK_UNIT_FIELDS)[number];
export type WorkUnitRow = Readonly<Record<WorkUnitField, string>>;

/**
 * 独立比较的 claim 投影列：`subject` 由 work_unit.task_id 投影，是重建结果的一部分；
 * `predicate`/`value` 由解析层强制（M0 只认 done/true），不构成独立比较，
 * 报告里单列 `asserted_by_parser`，不计入 `fields_compared`（C2 口径）。
 */
export const INDEPENDENT_CLAIM_FIELDS = ['subject'] as const;
export const PARSER_ASSERTED_CLAIM_FIELDS = ['predicate', 'value'] as const;

/** 差异清单条目：C5 要求 `{path, v1, rebuilt, verdict}` 可判。 */
export interface DiffEntry {
  readonly path: string;
  readonly v1: unknown;
  readonly rebuilt: unknown;
  readonly verdict: 'mismatch' | 'missing';
  readonly reason: string;
}

/** 从 work_unit 行可投影出的 claim 三列（M0 只支持结论型 claim）。 */
export interface ClaimProjection {
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
}

export interface RebuiltClaim {
  readonly claim_no: string;
  readonly work_unit: WorkUnitRow | null;
  /** work_unit 缺失时为 null（差异清单里会有 missing 条目）。 */
  readonly claim: ClaimProjection | null;
}

export interface SampleRebuildResult {
  readonly sample: number;
  readonly claims: readonly RebuiltClaim[];
  readonly diffs: readonly DiffEntry[];
  /** 独立比较次数 = N × (work_unit 6 字段 + subject 投影 1 列)；predicate/value 不计。 */
  readonly fields_compared: number;
}

/**
 * 把一条 claim 重建为 4 条合成事件：
 *   task.created → task.claimed → criterion.registered → evidence.attached
 * 事件 id/request_id 由 claim_no 派生；`prev` 先指 `imp:<claim_no>:root`，
 * 之后逐条链到上一条事件的 hash。同一条 claim 的重建结果完全确定（无时钟）。
 *
 * hash 公式**不在这里自造**：直接复用 `src/core/verify-events.ts` 的
 * `computeEventHash`（`sha256(canonical(body) + prev)`，见 docs/02 §10），
 * 保证 M1 把这些事件落库后 verify 不会全链红。
 */
export function buildClaimEvents(claim: ExportClaim): Event[] {
  interface Seed {
    readonly suffix: string;
    readonly kind: string;
    readonly subject: string;
    readonly payload: Record<string, unknown>;
  }
  const seeds: readonly Seed[] = [
    {
      suffix: 'task.created',
      kind: 'task.created',
      subject: claim.task_id,
      payload: {
        seq: claim.task_seq,
        title: claim.task_title,
        kind: claim.task_kind,
        created_by: claim.actor,
      },
    },
    {
      suffix: 'task.claimed',
      kind: 'task.claimed',
      subject: claim.task_id,
      payload: { owner: claim.actor },
    },
    {
      suffix: 'criterion.registered',
      kind: 'criterion.registered',
      subject: claim.criterion_id,
      payload: {
        spec_id: claim.spec_id,
        remedy: `rebuilt-from-v1-export:${claim.claim_no}`,
        // P1-3 迁移例外：v1 导入没有夹具，legacy 计数由 verify 暴露（M1-6 落库时处理）。
        legacy: true,
      },
    },
    {
      suffix: 'evidence.attached',
      kind: 'evidence.attached',
      subject: claim.evidence_id,
      payload: {
        criterion_id: claim.criterion_id,
        artifact_uri: claim.artifact_uri,
        artifact_sha256: claim.artifact_sha256,
        task_id: claim.task_id,
      },
    },
  ];
  const events: Event[] = [];
  let prev = `imp:${claim.claim_no}:root`;
  for (const seed of seeds) {
    const body: Omit<Event, 'hash'> = {
      id: `imp:${claim.claim_no}:${seed.suffix}`,
      at: claim.at,
      actor: claim.actor,
      kind: seed.kind,
      subject: seed.subject,
      payload: seed.payload,
      caused_by: [] as readonly string[],
      request_id: `imp:${claim.claim_no}`,
      prev,
    };
    const event: Event = { ...body, hash: computeEventHash({ ...body, hash: '' }) };
    events.push(event);
    prev = event.hash;
  }
  return events;
}

/** 导出 claim 按 D-008 约定应物化出的 work_unit 行（独立于 rebuilt 的期望值）。 */
export function expectedWorkUnit(claim: ExportClaim): WorkUnitRow {
  return {
    id: `wu:${claim.task_id}`,
    task_id: claim.task_id,
    criterion_id: claim.criterion_id,
    spec_id: claim.spec_id,
    evidence_id: claim.evidence_id,
    at: claim.at,
  };
}

/** 从 fold 状态读 work_unit 行；不存在返回 null（不抛错，交给差异清单判 missing）。 */
export function materializedWorkUnit(state: FoldState, taskId: string): WorkUnitRow | null {
  const row = state.tables.work_unit[`wu:${taskId}`];
  if (row === undefined) {
    return null;
  }
  return {
    id: String(row['id']),
    task_id: String(row['task_id']),
    criterion_id: String(row['criterion_id']),
    spec_id: String(row['spec_id']),
    evidence_id: String(row['evidence_id']),
    at: String(row['at']),
  };
}

/**
 * 逐字段比较：work_unit 6 列 + claim 投影 3 列（subject/predicate/value）。
 * 纯函数，便于单测直接注入漂移行验证差异清单结构（C5）。
 * 注意：predicate/value 仍做防御性比对，但解析层已强制 done/true，不计入独立比较次数。
 */
export function diffClaim(
  index: number,
  claim: ExportClaim,
  actual: WorkUnitRow | null,
): DiffEntry[] {
  const expected = expectedWorkUnit(claim);
  if (actual === null) {
    return [
      {
        path: `claims[${index}].work_unit`,
        v1: expected,
        rebuilt: null,
        verdict: 'missing',
        reason: `no work_unit row wu:${claim.task_id} was materialized from the synthetic event stream (task/criterion/evidence prerequisite missing)`,
      },
    ];
  }
  const diffs: DiffEntry[] = [];
  for (const field of WORK_UNIT_FIELDS) {
    if (actual[field] !== expected[field]) {
      diffs.push({
        path: `claims[${index}].work_unit.${field}`,
        v1: expected[field],
        rebuilt: actual[field],
        verdict: 'mismatch',
        reason: `rebuilt work_unit.${field} is ${JSON.stringify(actual[field])} but the v1 export maps to ${JSON.stringify(expected[field])}`,
      });
    }
  }
  const rebuiltClaim: ClaimProjection = {
    subject: actual.task_id,
    predicate: CONCLUSION_PREDICATE,
    value: 'true',
  };
  const expectedClaim: ClaimProjection = {
    subject: claim.task_id,
    predicate: claim.predicate,
    value: String(claim.value),
  };
  for (const field of ['subject', 'predicate', 'value'] as const) {
    if (rebuiltClaim[field] !== expectedClaim[field]) {
      diffs.push({
        path: `claims[${index}].claim.${field}`,
        v1: expectedClaim[field],
        rebuilt: rebuiltClaim[field],
        verdict: 'mismatch',
        reason: `claim projection ${field} is ${JSON.stringify(rebuiltClaim[field])} but the v1 export says ${JSON.stringify(expectedClaim[field])}`,
      });
    }
  }
  return diffs;
}

/** 合成事件流 → fold 状态；fold 的拒绝要转成 importer 的可读错误（不吞）。 */
export function rebuildState(claims: readonly ExportClaim[]): FoldState {
  const events = claims.flatMap((claim) => buildClaimEvents(claim));
  try {
    return fold(undefined, events);
  } catch (error) {
    if (error instanceof FoldError) {
      throw new ImportError('rebuild', `fold rejected the synthetic import stream: ${error.message}`, {
        path: 'records',
      });
    }
    throw error;
  }
}

/**
 * 抽样重建：取前 `sample` 条 claim → 一次 fold → 逐条比对。
 *
 * fail-closed：
 *   · `sample` 超过导出里的 claim 数 → `ImportError('sample')`（不静默少建，C2）；
 *   · 两条 claim 指向同一 task → `ImportError('rebuild')`（work_unit 是 UNIQUE(task_id)，
 *     静默折叠会掩盖冲突）。
 */
export function sampleRebuild(
  claims: readonly ExportClaim[],
  sample: number,
): SampleRebuildResult {
  if (!Number.isInteger(sample) || sample < 0) {
    throw new ImportError('sample', `--sample must be a non-negative integer, got ${String(sample)}`);
  }
  if (sample > claims.length) {
    throw new ImportError(
      'sample',
      `requested sample ${sample} but the export has only ${claims.length} claim record(s); refusing to silently rebuild fewer`,
      { path: 'records' },
    );
  }
  const selected = claims.slice(0, sample);
  const taskOwners = new Map<string, ExportClaim>();
  for (const claim of selected) {
    const previous = taskOwners.get(claim.task_id);
    if (previous !== undefined) {
      throw new ImportError(
        'rebuild',
        `claims ${previous.claim_no} and ${claim.claim_no} both reference task ${claim.task_id}; M0 rebuild requires one conclusion receipt per task (work_unit is UNIQUE(task_id))`,
        { path: `records[${claim.offset}]` },
      );
    }
    taskOwners.set(claim.task_id, claim);
  }
  const state = rebuildState(selected);
  const rebuilt: RebuiltClaim[] = [];
  const diffs: DiffEntry[] = [];
  selected.forEach((claim, index) => {
    const row = materializedWorkUnit(state, claim.task_id);
    diffs.push(...diffClaim(index, claim, row));
    if (row === null) {
      rebuilt.push({ claim_no: claim.claim_no, work_unit: null, claim: null });
    } else {
      rebuilt.push({
        claim_no: claim.claim_no,
        work_unit: row,
        claim: {
          subject: row.task_id,
          predicate: CONCLUSION_PREDICATE,
          value: 'true',
        },
      });
    }
  });
  return {
    sample,
    claims: rebuilt,
    diffs,
    fields_compared:
      selected.length * (WORK_UNIT_FIELDS.length + INDEPENDENT_CLAIM_FIELDS.length),
  };
}
