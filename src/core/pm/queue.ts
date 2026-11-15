/**
 * M2-5 · 读 `pm_queue` 视图 + reason_code → 动作映射。
 *
 * 硬口径（Lead m03712）：
 * - 队列排序口径属于视图，本模块**不重写**排序/过滤；只调 `src/query/` 的 `query()`
 *   执行 `view_catalog` 里的 SQL（M0-4 D-011：只许执行 catalog.sql 子查询）。
 * - 7 个 reason_code 每个至少映射一个动作（C5）；动作表写进 README。
 */

import type { SdoDatabase } from '../../db/driver.js';
import { query } from '../../query/index.js';
import type { Session } from '../auth/session.js';
import type { Right } from '../../views/catalog.js';
import type { PmFailure } from './types.js';
import { seatViewRight } from './rights.js';

export const PM_REASON_CODES = [
  'waiting_human',
  'blocked',
  'gate_red',
  'assumption_open',
  'sampled_review',
  'rework_pending',
  'unclaimed',
] as const;

export type PmReasonCode = (typeof PM_REASON_CODES)[number];

export const PM_ACTIONS = [
  'wait',
  'unblock',
  'rework',
  'attention',
  'assign',
  'request_sign',
  'escalate',
  'grant',
] as const;

export type PmAction = (typeof PM_ACTIONS)[number];

/** docs/03：只有这两个 block_code 允许 PM 解。 */
export const UNBLOCKABLE_BLOCK_CODES = ['lease_expired', 'lease_revoked'] as const;

export interface PmQueueRow {
  readonly rank: number;
  readonly kind: string;
  readonly subject_id: string;
  readonly title: string;
  /** 视图给出的建议动作（`wait`/`unblock`/`rework`/`attention`/`assign`/`dispatch`）。 */
  readonly action: string;
  readonly reason_code: string;
  readonly since: string;
  readonly owner: string | null;
  readonly block_code: string | null;
  readonly blocked_by: readonly string[];
}

export type PmQueueRead =
  | { readonly ok: true; readonly rows: readonly PmQueueRow[]; readonly asOf: readonly string[]; readonly truncated: boolean }
  | (PmFailure & { readonly reason_code: 'no_permission' | 'invalid_args' });

function toRow(raw: Readonly<Record<string, unknown>>): PmQueueRow {
  const blockedRaw = raw['blocked_by'];
  let blockedBy: readonly string[] = [];
  if (typeof blockedRaw === 'string' && blockedRaw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(blockedRaw);
      if (Array.isArray(parsed)) {
        blockedBy = parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      blockedBy = [];
    }
  }
  return {
    rank: Number(raw['rank']),
    kind: String(raw['kind']),
    subject_id: String(raw['subject_id']),
    title: String(raw['title']),
    action: String(raw['action']),
    reason_code: String(raw['reason_code']),
    since: String(raw['since']),
    owner: typeof raw['owner'] === 'string' ? raw['owner'] : null,
    block_code: typeof raw['block_code'] === 'string' ? raw['block_code'] : null,
    blocked_by: blockedBy,
  };
}

/** 读队列：权限投影来自 `src/query/`；未知/空 actor fail-closed ⇒ no_permission（P2-2）。 */
export function readPmQueue(db: SdoDatabase, actor: string, session?: Session): PmQueueRead {
  const right: Right | undefined = seatViewRight(actor);
  if (right === undefined) {
    return {
      ok: false,
      reason_code: 'no_permission',
      message: `unknown actor ${JSON.stringify(actor)}: no static seat, refusing to read pm_queue`,
    };
  }
  if (session === undefined) {
    return {
      ok: false,
      reason_code: 'no_permission',
      message: 'readPmQueue requires a session: query authorization is session-only',
    };
  }
  const result = query(db, { view: 'pm_queue' }, { session });
  if (result.miss !== undefined) {
    const reason = result.miss.reason === 'filtered_by_permission' ? 'no_permission' : 'invalid_args';
    return {
      ok: false,
      reason_code: reason,
      message: result.miss.hint ?? result.miss.reason,
    };
  }
  return { ok: true, rows: result.rows.map(toRow), asOf: result.as_of, truncated: result.truncated };
}

export function isPmUnblockable(value: string): boolean {
  return (UNBLOCKABLE_BLOCK_CODES as readonly string[]).includes(value);
}

const isBlockedReasonCode = isPmUnblockable;

/** reason_code（+ block_code）→ PM 建议动作；与视图 action 列一致者优先。 */
export function actionFor(reasonCode: string, blockCode: string | null): PmAction {
  switch (reasonCode) {
    case 'waiting_human':
      return 'wait';
    case 'blocked':
      if (blockCode !== null && isBlockedReasonCode(blockCode)) return 'unblock';
      if (blockCode === 'upstream_changed' || blockCode === 'clause_unjudged') return 'rework';
      return 'attention';
    case 'gate_red':
      return 'rework';
    case 'assumption_open':
      return 'attention';
    case 'sampled_review':
      return 'assign';
    case 'rework_pending':
      return 'rework';
    case 'unclaimed':
      return 'assign';
    default:
      return 'attention';
  }
}

/** 需要 PM 写事件的动作；`wait`（等人/等上游）不写事件。 */
export function writableAction(reasonCode: string, blockCode: string | null): PmAction | null {
  const action = actionFor(reasonCode, blockCode);
  return action === 'wait' ? null : action;
}

export function isPmReasonCode(value: string): value is PmReasonCode {
  return (PM_REASON_CODES as readonly string[]).includes(value);
}
