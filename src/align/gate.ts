/**
 * 对齐三件套（M1-2）：复述 / 例子 / 回指。
 *
 * 本文件只做「读 + 判定 + 共享工具」：
 * - 读：事件链 → `fold` 后的内存状态（`restatement`/`restatement_diff` 不在物化清单，见 README）；
 * - 判定：`alignmentGate()` 按卡的 C1–C6 给出结构化结果；
 * - 共享工具：写动作（`restatement.ts` / `diff.ts`）用它构造事件、做参数与状态前置校验。
 *
 * 写入不在这里发生：所有写动作只调 `src/db/write.ts` 的 `append()`。
 * docs/13-阶段作业单.md:40-52、docs/03:44-45、docs/01:442 是判据来源。
 */

import { randomUUID } from 'node:crypto';

import { fold } from '../core/fold/index.js';
import type { Event, FoldState, Row } from '../core/fold/types.js';
import { computeEventHash, readEvents } from '../core/verify-events.js';
import type { VerifyProblem } from '../core/verify-types.js';
import type { SdoDatabase } from '../db/driver.js';
import { chainHead } from '../db/write.js';

/** 门与写动作的结构化失败码（对齐相关；`invalid_args` 也覆盖草案/参数形状）。 */
export type AlignReason =
  | 'invalid_args'
  | 'not_human'
  | 'intent_not_found'
  | 'restatement_not_found'
  | 'restatement_missing'
  | 'restatement_too_late'
  | 'restatement_invalidated'
  | 'stale_restatement'
  | 'diff_unprocessed'
  | 'diff_deferred'
  | 'diff_already_disposed'
  | 'diff_conflict'
  | 'examples_missing'
  | 'stale_reason'
  | 'write_failed';

export const DIFF_KINDS = ['agree', 'missing', 'extra', 'conflict'] as const;
export const DIFF_DISPOSITIONS = ['accept', 'reject', 'defer'] as const;
export const ACTOR_KINDS = ['human', 'agent', 'service'] as const;

export type DiffKind = (typeof DIFF_KINDS)[number];
export type DiffDisposition = (typeof DIFF_DISPOSITIONS)[number];
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** docs/11 的输入边形状；复述只绑一条 intent 边。 */
export interface AlignmentInputEdge {
  readonly kind: string;
  readonly id: string;
  readonly hash: string;
}

export interface RestatementView {
  readonly id: string;
  readonly intent_id: string;
  readonly draft_specs: readonly unknown[];
  readonly inputs: readonly AlignmentInputEdge[];
  readonly by: string | null;
  readonly at: string;
  readonly invalid_reason: string | null;
  readonly accepted_spec_ids: readonly string[];
}

export interface RestatementDiffView {
  readonly id: string;
  readonly restatement_id: string;
  readonly kind: DiffKind;
  readonly target_ref: string;
  readonly disposition: DiffDisposition;
  readonly reason: string | null;
  readonly at: string;
}

/** 门输出形状定死（M1-G 读数与 M2 门禁复用，卡 A4）。 */
export interface AlignmentGateResult {
  readonly ok: boolean;
  readonly reason_code?: AlignReason;
  readonly pending: readonly string[];
  readonly specIds: readonly string[];
  readonly staleReason?: string;
}

export interface AlignmentGateOptions {
  /** 不传则取 at 最新的一条复述。 */
  readonly restatementId?: string;
}

export type AlignWriteResult =
  | { readonly ok: true; readonly event_id: string; readonly event_count: number }
  | {
      readonly ok: false;
      readonly reason_code: AlignReason;
      readonly message: string;
      readonly staleReason?: string;
    };

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * 解析带时区的 ISO-8601 时间（必须带 `Z` 或 `±hh:mm`，否则视为非法输入）。
 * 字符串直接比较会把 `2025-12-31T23:00:00-05:00` 误判为早于 `2026-01-01T00:00:00Z`。
 *
 * 另外做“回读分量”校验：`Date.parse('2026-02-30T00:00:00Z')` 会归一化成 3 月 2 日，
 * 因此把解析结果按同一偏移换回本地分量，与输入的年月日时分秒逐项比对，不一致即非法
 * （第 2 轮评审 P3-1）。
 */
export function isoTimestampMs(value: string): number | undefined {
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null) {
    return undefined;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  const sign = match[9];
  const offsetHours = Number(match[10] ?? '0');
  const offsetMinutes = Number(match[11] ?? '0');
  let offset = 0;
  if (sign === '+') offset = offsetHours * 60 + offsetMinutes;
  if (sign === '-') offset = -(offsetHours * 60 + offsetMinutes);
  const local = new Date(ms + offset * 60_000);
  const expectedMillis = fraction === undefined ? 0 : Number(fraction.padEnd(3, '0').slice(0, 3));
  const matches =
    local.getUTCFullYear() === year &&
    local.getUTCMonth() === month - 1 &&
    local.getUTCDate() === day &&
    local.getUTCHours() === hour &&
    local.getUTCMinutes() === minute &&
    local.getUTCSeconds() === second &&
    local.getUTCMilliseconds() === expectedMillis;
  return matches ? ms : undefined;
}

export function writeFailure(
  reason_code: AlignReason,
  message: string,
  staleReason?: string,
): AlignWriteResult {
  return {
    ok: false,
    reason_code,
    message,
    ...(staleReason === undefined ? {} : { staleReason }),
  };
}

export function gateFailure(
  reason_code: AlignReason,
  pending: readonly string[] = [],
  specIds: readonly string[] = [],
  staleReason?: string,
): AlignmentGateResult {
  return {
    ok: false,
    reason_code,
    pending,
    specIds,
    ...(staleReason === undefined ? {} : { staleReason }),
  };
}

export function textCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 按真实时刻排序（第 2 轮评审 P2-1）：`at` 不可解析的排最前（= 永远不会被当成 latest），
 * 同刻用 id 文本兜底。门的“最新复述”取排序结果最后一个。
 */
export function compareByAtThenId(
  left: { readonly at: string; readonly id: string },
  right: { readonly at: string; readonly id: string },
): number {
  const leftMs = isoTimestampMs(left.at) ?? Number.NEGATIVE_INFINITY;
  const rightMs = isoTimestampMs(right.at) ?? Number.NEGATIVE_INFINITY;
  if (leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  return textCompare(left.id, right.id);
}

function rowString(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
}

function rowStringArray(row: Row, key: string): string[] {
  const value = row[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function toInputEdges(value: unknown): AlignmentInputEdge[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const edges: AlignmentInputEdge[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const kind = entry['kind'];
    const id = entry['id'];
    const hash = entry['hash'];
    if (typeof kind === 'string' && typeof id === 'string' && typeof hash === 'string') {
      edges.push({ kind, id, hash });
    }
  }
  return edges;
}

export function toRestatementView(row: Row): RestatementView {
  return {
    id: rowString(row, 'id') ?? '',
    intent_id: rowString(row, 'intent_id') ?? '',
    draft_specs: Array.isArray(row['draft_specs']) ? (row['draft_specs'] as unknown[]) : [],
    inputs: toInputEdges(row['inputs']),
    by: rowString(row, 'by') ?? null,
    at: rowString(row, 'at') ?? '',
    invalid_reason: rowString(row, 'invalid_reason') ?? null,
    accepted_spec_ids: rowStringArray(row, 'accepted_spec_ids'),
  };
}

function toDiffView(row: Row): RestatementDiffView | undefined {
  const id = rowString(row, 'id');
  const restatementId = rowString(row, 'restatement_id');
  const kind = rowString(row, 'kind');
  const targetRef = rowString(row, 'target_ref');
  const disposition = rowString(row, 'disposition');
  const at = rowString(row, 'at');
  if (
    id === undefined || restatementId === undefined || kind === undefined ||
    targetRef === undefined || disposition === undefined || at === undefined
  ) {
    return undefined;
  }
  if (!(DIFF_KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }
  if (!(DIFF_DISPOSITIONS as readonly string[]).includes(disposition)) {
    return undefined;
  }
  return {
    id,
    restatement_id: restatementId,
    kind: kind as DiffKind,
    target_ref: targetRef,
    disposition: disposition as DiffDisposition,
    reason: rowString(row, 'reason') ?? null,
    at,
  };
}

/**
 * 读事件链并折成内存状态。链/哈希有问题直接抛错（状态不可信时任何判定都不成立）。
 * `restatement`/`restatement_diff` 只在 fold 状态里，数据库里没有物化行。
 */
export interface AlignmentSnapshot {
  readonly state: FoldState;
  readonly events: readonly Event[];
}

/**
 * 读事件链 + 折成内存状态。门要同时看**事件流**（D-039：fold 对同 subject 的
 * `restatement_diff` 是 upsert，重复事件会被静默覆盖，只看折叠行会漏掉冲突）。
 */
export function readAlignmentSnapshot(db: SdoDatabase, problems: VerifyProblem[] = []): AlignmentSnapshot {
  const events = readEvents(db, problems);
  if (problems.length > 0) {
    const first = problems[0];
    throw new Error(`对齐状态不可读：事件链校验失败（${first?.code ?? 'unknown'}：${first?.detail ?? ''}）`);
  }
  return { state: fold(undefined, events), events };
}

export function readAlignmentState(db: SdoDatabase, problems: VerifyProblem[] = []): FoldState {
  return readAlignmentSnapshot(db, problems).state;
}

/** 按 `(restatement_id, target_ref)` 数处置事件出现次数（事件流口径，不折叠）。 */
export function countDiffDispositionEvents(
  events: readonly Event[],
  restatementId: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 'restatement.diff_dispositioned') {
      continue;
    }
    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      continue;
    }
    const record = payload as Record<string, unknown>;
    if (record['restatement_id'] !== restatementId) {
      continue;
    }
    const targetRef = record['target_ref'];
    if (typeof targetRef !== 'string') {
      continue;
    }
    counts.set(targetRef, (counts.get(targetRef) ?? 0) + 1);
  }
  return counts;
}

export function listRestatements(state: FoldState): RestatementView[] {
  const rows = Object.values(state.tables['restatement']).map(toRestatementView);
  return rows.sort(compareByAtThenId);
}

export function listDiffs(state: FoldState, restatementId?: string): RestatementDiffView[] {
  const rows: RestatementDiffView[] = [];
  for (const row of Object.values(state.tables['restatement_diff'])) {
    const view = toDiffView(row);
    if (view === undefined) continue;
    if (restatementId !== undefined && view.restatement_id !== restatementId) continue;
    rows.push(view);
  }
  return rows.sort(compareByAtThenId);
}

export type EarliestSpecResult =
  | { readonly ok: true; readonly earliest?: { readonly at: string; readonly ms: number } }
  | { readonly ok: false; readonly badAt: string };

/** 该 intent 下最早一条 spec 的 `at`（按真实时刻比较）；条款时间不可解析时 fail-closed。 */
export function earliestSpecForIntent(state: FoldState, intentId: string): EarliestSpecResult {
  let earliest: { at: string; ms: number } | undefined;
  for (const row of Object.values(state.tables['spec'])) {
    if (rowString(row, 'intent_id') !== intentId) continue;
    const at = rowString(row, 'at');
    if (at === undefined) continue;
    const ms = isoTimestampMs(at);
    if (ms === undefined) {
      return { ok: false, badAt: at };
    }
    if (earliest === undefined || ms < earliest.ms) {
      earliest = { at, ms };
    }
  }
  return earliest === undefined ? { ok: true } : { ok: true, earliest };
}

export interface EventDraft {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string;
  readonly payload: unknown;
  readonly requestId: string;
  readonly causedBy?: readonly string[];
  readonly prev?: string;
  readonly hash?: string;
}

/** 在当前链头上构造一条带正确 prev/hash 的事件（写动作只把它交给 append）。 */
export function buildEvent(db: SdoDatabase, draft: EventDraft): Event {
  const prev = draft.prev ?? chainHead(db);
  const base = {
    id: draft.id,
    at: draft.at,
    actor: draft.actor,
    kind: draft.kind,
    subject: draft.subject,
    payload: draft.payload,
    caused_by: draft.causedBy ?? [],
    request_id: draft.requestId,
    prev,
  };
  const hash = draft.hash ?? computeEventHash({ ...base, hash: '' });
  return { ...base, hash };
}

export function newEventId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 门判定的唯一入口；顺序见 README（失效/时限 → 差异 → 例子）。 */
export function alignmentGate(
  db: SdoDatabase,
  options: AlignmentGateOptions = {},
): AlignmentGateResult {
  let snapshot: AlignmentSnapshot;
  try {
    snapshot = readAlignmentSnapshot(db);
  } catch (error) {
    // 事件链/哈希不可信时，门不能“照旧判绿”，也不能把异常抛给编排层。
    return gateFailure('stale_reason', [], [], error instanceof Error ? error.message : String(error));
  }
  const state = snapshot.state;

  const restatements = listRestatements(state);
  const target =
    options.restatementId === undefined
      ? restatements[restatements.length - 1]
      : restatements.find((row) => row.id === options.restatementId);

  if (target === undefined) {
    if (options.restatementId !== undefined) {
      return gateFailure('restatement_not_found', [], [], `没有找到复述 ${options.restatementId}`);
    }
    const detail = '该库还没有复述；先 proposeRestatement 记录 agent 的独立复述';
    return gateFailure('restatement_missing', [], [], detail);
  }

  const restatementMs = isoTimestampMs(target.at);
  if (restatementMs === undefined) {
    return gateFailure(
      'invalid_args',
      [],
      [],
      `复述 ${target.id} 的 at 不是带时区的 ISO-8601：${target.at}`,
    );
  }

  const intent = state.tables['intent'][target.intent_id];
  if (intent === undefined) {
    return gateFailure('intent_not_found', [], [], `复述 ${target.id} 指向的 intent ${target.intent_id} 不存在`);
  }

  if (target.invalid_reason !== null) {
    return gateFailure(
      'restatement_invalidated',
      [],
      [],
      `复述 ${target.id} 已作废：${target.invalid_reason}`,
    );
  }

  const edge = target.inputs[0];
  if (
    target.inputs.length !== 1 || edge === undefined || edge.kind !== 'intent' ||
    edge.id !== target.intent_id
  ) {
    return gateFailure(
      'restatement_invalidated',
      [],
      [],
      'restatement.inputs 必须只含一条 {kind:"intent", id:<intent_id>, hash} 边',
    );
  }

  const currentHash = rowString(intent, 'content_hash');
  if (currentHash === undefined) {
    return gateFailure('intent_not_found', [], [], `intent ${target.intent_id} 没有 content_hash，无法校验复述版本`);
  }
  if (edge.hash !== currentHash) {
    return gateFailure(
      'restatement_invalidated',
      [],
      [],
      `复述记录的 intent hash ${edge.hash} 与当前 intent.content_hash ${currentHash} 不一致；旧复述作废，须重跑`,
    );
  }

  const specTimes = earliestSpecForIntent(state, target.intent_id);
  if (!specTimes.ok) {
    return gateFailure(
      'invalid_args',
      [],
      [],
      `spec.at 不是带时区的 ISO-8601：${specTimes.badAt}`,
    );
  }
  const earliest = specTimes.earliest;
  if (earliest !== undefined && restatementMs >= earliest.ms) {
    return gateFailure(
      'restatement_too_late',
      [],
      [],
      `复述时间 ${target.at} 不早于该 intent 下最早条款 ${earliest.at}；复述必须早于条款（docs/03:44）`,
    );
  }

  const draftIds: string[] = [];
  for (const entry of target.draft_specs) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return gateFailure('invalid_args', [], [], '复述的 draft_specs 必须是对象数组');
    }
    const id = (entry as Record<string, unknown>)['id'];
    if (!isNonEmptyString(id)) {
      return gateFailure('invalid_args', [], [], '复述的 draft_specs 每条都要有非空字符串 id');
    }
    if (!draftIds.includes(id)) {
      draftIds.push(id);
    }
  }

  // P1（第 2 轮）：只看折叠行不够——fold 对同 subject 的 restatement_diff 是 upsert，
  // 同一 targetRef 的第二次处置会静默覆盖第一次（D-039）。这里直接数事件流。
  const dispositionEventCounts = countDiffDispositionEvents(snapshot.events, target.id);
  for (const [targetRef, count] of dispositionEventCounts) {
    if (count > 1) {
      return gateFailure(
        'diff_conflict',
        [targetRef],
        [],
        `同一 (restatement_id, target_ref) = (${target.id}, ${targetRef}) 有 ${count} 条处置事件；处置必须唯一（fold upsert 静默覆盖同 subject 事件，D-039）`,
      );
    }
  }

  const diffByTarget = new Map<string, RestatementDiffView[]>();
  for (const diff of listDiffs(state, target.id)) {
    const bucket = diffByTarget.get(diff.target_ref) ?? [];
    bucket.push(diff);
    diffByTarget.set(diff.target_ref, bucket);
  }
  // 第 1 轮评审 P1-2：同一 targetRef 多条处置 = 写入/重放冲突，不能静默取最早一条。
  for (const [targetRef, bucket] of diffByTarget) {
    if (!draftIds.includes(targetRef)) {
      return gateFailure(
        'invalid_args',
        [],
        [],
        `差异 target_ref ${targetRef} 不属于复述 ${target.id} 的 draft_specs`,
      );
    }
    if (bucket.length > 1) {
      return gateFailure(
        'diff_conflict',
        [targetRef],
        [],
        `同一 targetRef ${targetRef} 有 ${bucket.length} 条处置；处置必须唯一（折叠行已出现多条，说明用了不同 subject 绕过；门同时扫事件流，见 D-039）`,
      );
    }
  }

  const pending = draftIds.filter((id) => !diffByTarget.has(id));
  if (pending.length > 0) {
    return gateFailure(
      'diff_unprocessed',
      pending,
      [],
      `还有 ${pending.length} 条差异没有处置：${pending.join(', ')}`,
    );
  }

  // 卡 C3 / Lead 口径：defer 视为“未处置”，挡住门（docs/13 没有“我看过了”这种处置）。
  const deferred = draftIds.filter((id) => diffByTarget.get(id)?.[0]?.disposition === 'defer');
  if (deferred.length > 0) {
    return gateFailure(
      'diff_deferred',
      deferred,
      [],
      `还有 ${deferred.length} 条差异被 defer（视为未处置）：${deferred.join(', ')}`,
    );
  }

  const requirements = Object.values(state.tables['spec'])
    .filter((row) => rowString(row, 'kind') === 'requirement' && rowString(row, 'intent_id') === target.intent_id)
    .map((row) => rowString(row, 'id') ?? '')
    .filter((id) => id.length > 0)
    .sort(textCompare);

  const fixtureCounts = countFixtures(state);
  const missing = requirements.filter((specId) => {
    const counts = fixtureCounts.get(specId);
    return counts === undefined || counts.positive < 2 || counts.negative < 1;
  });
  if (missing.length > 0) {
    return gateFailure(
      'examples_missing',
      [],
      missing,
      `以下条款缺少例子（每条要 2 正 1 反）：${missing.join(', ')}`,
    );
  }

  return { ok: true, pending: [], specIds: [] };
}

interface FixtureCounts {
  positive: number;
  negative: number;
}

/**
 * 从 fold 的事件态数例子（`state.tables['criterion_fixture']` join `criterion` 行）。
 * 卡 A3：例子只认 `criterion_fixture`；但**只有事件能影响门**——物化表可被直插/直删，
 * 读表会把 C5 的证据链截断在表上（第 2 轮复认 P1）。因此这里不碰 `db`。
 */
function countFixtures(state: FoldState): Map<string, FixtureCounts> {
  const counts = new Map<string, FixtureCounts>();
  const criteria = state.tables['criterion'];
  for (const fixture of Object.values(state.tables['criterion_fixture'])) {
    const criterionId = rowString(fixture, 'criterion_id');
    if (criterionId === undefined) continue;
    const criterion = criteria[criterionId];
    if (criterion === undefined) continue;
    const specId = rowString(criterion, 'spec_id');
    if (specId === undefined) continue;
    const polarity = rowString(fixture, 'polarity');
    const entry = counts.get(specId) ?? { positive: 0, negative: 0 };
    if (polarity === 'positive') entry.positive += 1;
    else if (polarity === 'negative') entry.negative += 1;
    counts.set(specId, entry);
  }
  return counts;
}
