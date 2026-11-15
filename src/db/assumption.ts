/**
 * M2-3 假设处置链的写动作（docs/03:66-77、docs/04 §5.2、docs/06:189）。
 *
 * 职责边界：
 * - `previewAssumptionSet(db)`：给**人**渲染待签清单（open 假设 + inputs 边 + 建议载荷骨架）；
 * - `disposeAssumptionSet(db, …)`：拿一条**已签名**的 `decision(kind='assumption_set')`，
 *   按签名载荷的 `spec_ids[]`/`dispositions[]` 把全部 `assumption.disposed` 一次 append。
 *
 * 三条硬约束：
 * 1. 事件 payload 不携带覆盖名单（不在 `src/db` 里回填 `covered_spec_ids`），覆盖只认签名载荷。
 * 2. 整批只调用一次 `append()`；任一处置不合法 ⇒ 0 行生效（C7 原子性）。
 * 3. 状态迁移只经事件：本模块不写 `spec` 表，投影交给 fold/materialize。
 *
 * 分层：`src/db/` 可 import `src/core/`；不 import `src/align/`、`src/check/`。
 */

import type { SdoDatabase } from './driver.js';
import { randomUUID } from 'node:crypto';

import { append, chainHead } from './write.js';
import type { Event } from '../core/fold/types.js';
import { fold } from '../core/fold/index.js';
import type { FoldState, Row } from '../core/fold/types.js';
import { computeEventHash, readEvents } from '../core/verify-events.js';
import type { VerifyProblem } from '../core/verify-types.js';
import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';
import { dispositionEntries, parseDispositionsStrict, specIdsOfDecision } from '../core/assumption/index.js';

export type AssumptionWriteReason =
  | 'decision_not_signed'
  | 'not_covered_by_decision'
  | 'disposition_mismatch'
  | 'cascade_conflict'
  | 'invalid_request'
  | 'write_failed';

export interface AssumptionWriteFailure {
  readonly ok: false;
  readonly reason_code: AssumptionWriteReason;
  readonly message: string;
}

export interface AssumptionPreviewItem {
  readonly spec_id: string;
  readonly clause: string;
  readonly blast_radius: string;
  readonly status: string;
  readonly inputs: readonly { readonly kind: string; readonly id: string; readonly hash: string }[];
  readonly content_hash: string;
}

export interface AssumptionSetPreview {
  /** 供人签的 payload 骨架：`spec_ids` 由当前 open 集合生成，`dispositions` 留空待人填。 */
  readonly payload: {
    readonly spec_ids: readonly string[];
    readonly dispositions: readonly never[];
    readonly readings_hash: string;
  };
  readonly items: readonly AssumptionPreviewItem[];
  readonly render: string;
}

export type PreviewResult =
  | { readonly ok: true; readonly preview: AssumptionSetPreview }
  | AssumptionWriteFailure;

export interface DisposeAssumptionSetInput {
  readonly decision_id: string;
  readonly actor: string;
  readonly at?: string;
  readonly eventIds?: readonly string[];
  readonly requestId?: string;
}

export interface DisposeAssumptionSetResult {
  readonly ok: true;
  readonly decision_id: string;
  readonly disposed: readonly string[];
  readonly event_ids: readonly string[];
  readonly chain_head: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function failure(reason_code: AssumptionWriteReason, message: string): AssumptionWriteFailure {
  return { ok: false, reason_code, message };
}

function stateOf(db: SdoDatabase, problems: VerifyProblem[] = []): FoldState {
  const events = readEvents(db, problems);
  return fold(undefined, events);
}

function rowPayload(row: Row): Record<string, unknown> {
  const payload = row['payload'];
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function itemOf(state: FoldState, specId: string): AssumptionPreviewItem | undefined {
  const row = state.tables.spec[specId];
  if (row === undefined || row['kind'] !== 'assumption') return undefined;
  return {
    spec_id: specId,
    clause: text(row['clause']),
    blast_radius: text(row['blast_radius']),
    status: text(row['status']),
    inputs: (state.inputs[specId] ?? []).map((edge) => ({ kind: edge.kind, id: edge.id, hash: edge.hash })),
    content_hash: text(row['content_hash']),
  };
}

/** 渲染待签清单；不读 decision、不写事件。 */
export function previewAssumptionSet(db: SdoDatabase): PreviewResult {
  const problems: VerifyProblem[] = [];
  const state = stateOf(db, problems);
  if (problems.length > 0) {
    return failure('invalid_request', `事件链/折叠失败：${problems[0]?.detail ?? 'unknown'}`);
  }
  const items: AssumptionPreviewItem[] = [];
  for (const id of Object.keys(state.tables.spec).sort()) {
    const item = itemOf(state, id);
    if (item !== undefined && item.status === 'open') items.push(item);
  }
  const specIds = items.map((item) => item.spec_id);
  const readingsHash = `sha256:${sha256Hex(canonicalJson(items.map((item) => ({
    spec_id: item.spec_id,
    inputs: item.inputs,
    content_hash: item.content_hash,
  }))))}`;
  const render = [
    '待处置假设清单（签的是这份清单，不是当前 open 集合的自动回填）：',
    ...items.map(
      (item) =>
        `- ${item.spec_id} [${item.blast_radius || '?'}] ${item.clause || '(clause?)'} (inputs: ${
          item.inputs.length === 0 ? '(none)' : item.inputs.map((edge) => `${edge.kind}/${edge.id}`).join(', ')
        })`,
    ),
  ].join('\n');
  return {
    ok: true,
    preview: {
      payload: { spec_ids: specIds, dispositions: [], readings_hash: readingsHash },
      items,
      render,
    },
  };
}

interface DecisionCheck {
  readonly decisionKind: string;
  readonly status: string;
  readonly signature: string;
  readonly specIds: readonly string[];
  readonly dispositions: readonly { readonly spec_id: string; readonly disposition: string }[];
}

function checkDecision(state: FoldState, decisionId: string): DecisionCheck | AssumptionWriteFailure {
  const row = state.tables.decision[decisionId];
  if (row === undefined) {
    return failure('decision_not_signed', `decision ${decisionId} 不存在；先签 assumption_set 再处置`);
  }
  const kind = text(row['decision_kind']);
  const status = text(row['status']);
  const signature = text(row['signature']);
  if (kind !== 'assumption_set') {
    return failure('not_covered_by_decision', `decision ${decisionId} 的 kind 是 ${kind || '(空)'}，不是 assumption_set`);
  }
  if (status !== 'valid') {
    return failure('cascade_conflict', `decision ${decisionId} 状态是 ${status}；已撤销/失效的 decision 不能处置`);
  }
  if (signature.length === 0 || text(row['key_id']).length === 0 || text(row['signer']).length === 0) {
    return failure('decision_not_signed', `decision ${decisionId} 尚未签名，不能作为处置授权`);
  }
  const payload = rowPayload(row);
  const parsed = parseDispositionsStrict(payload['dispositions']);
  if (!parsed.ok) {
    return failure('disposition_mismatch', `decision ${decisionId} 载荷不合法：${parsed.message}`);
  }
  if (parsed.entries.length === 0) {
    return failure('disposition_mismatch', `decision ${decisionId} 没有 dispositions，无法处置任何假设`);
  }
  return {
    decisionKind: kind,
    status,
    signature,
    specIds: specIdsOfDecision(row),
    dispositions: parsed.entries.map((entry) => ({ spec_id: entry.spec_id, disposition: entry.disposition })),
  };
}

/** 构造事件（同批内 prev 顺序链接；hash 用与写网关相同的规范）。 */
function makeEvent(
  draft: Omit<Event, 'prev' | 'hash'>,
  prev: string,
): Event {
  const base = { ...draft, prev };
  return { ...base, hash: computeEventHash({ ...base, hash: '' }) };
}

/**
 * 一次 append 落全部 `assumption.disposed`。失败时**不写任何事件**（C7）。
 */
export function disposeAssumptionSet(db: SdoDatabase, input: DisposeAssumptionSetInput): DisposeAssumptionSetResult | AssumptionWriteFailure {
  if (typeof input.decision_id !== 'string' || input.decision_id.length === 0) {
    return failure('invalid_request', 'decision_id 必须是非空字符串');
  }
  if (typeof input.actor !== 'string' || input.actor.length === 0) {
    return failure('invalid_request', 'actor 必须是非空字符串');
  }
  const problems: VerifyProblem[] = [];
  const state = stateOf(db, problems);
  if (problems.length > 0) {
    return failure('invalid_request', `事件链/折叠失败：${problems[0]?.detail ?? 'unknown'}`);
  }
  const checked = checkDecision(state, input.decision_id);
  if ('ok' in checked) return checked;

  const entries = dispositionEntries(rowPayload(state.tables.decision[input.decision_id] as Row));
  const events: Event[] = [];
  let prev = chainHead(db);
  const at = input.at ?? new Date().toISOString();
  for (const [index, entry] of entries.entries()) {
    const row = state.tables.spec[entry.spec_id];
    if (row === undefined || row['kind'] !== 'assumption') {
      return failure('not_covered_by_decision', `decision ${input.decision_id} 覆盖的 ${entry.spec_id} 不是假设`);
    }
    if (!checked.specIds.includes(entry.spec_id)) {
      return failure('not_covered_by_decision', `decision ${input.decision_id} 的 spec_ids 不含 ${entry.spec_id}`);
    }
    const status = text(row['status']);
    if (status !== 'open') {
      return failure('cascade_conflict', `假设 ${entry.spec_id} 当前是 ${status || '(空)'}，只能处置 open`);
    }
    const eventId = input.eventIds?.[index] ?? `assumption-disposed-${randomUUID()}`;
    const event = makeEvent(
      {
        id: eventId,
        at,
        actor: input.actor,
        kind: 'assumption.disposed',
        subject: entry.spec_id,
        payload: {
          decision_id: input.decision_id,
          disposition: entry.disposition,
          ...(entry.successor_ref === undefined ? {} : { successor_ref: entry.successor_ref }),
        },
        caused_by: [],
        request_id: input.requestId ?? `req-${input.decision_id}`,
      },
      prev,
    );
    events.push(event);
    prev = event.hash;
  }

  const result = append(db, events);
  if (!result.ok) {
    return {
      ok: false,
      reason_code: 'write_failed',
      message: `${String(result.reason_code)}：${result.message ?? 'append rejected'}`,
    };
  }
  return {
    ok: true,
    decision_id: input.decision_id,
    disposed: events.map((event) => event.subject),
    event_ids: events.map((event) => event.id),
    chain_head: prev,
  };
}

