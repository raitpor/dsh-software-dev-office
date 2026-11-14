/**
 * M1-6：从**已有事件**重算 claim 行（不产生新事件）。
 *
 * claim 是事件派生的投影（`derived_by` 渲染器，docs/03 §3）。导入时会出现
 * “事件已 append、claim 行未写”的中间态；正确恢复姿势是重跑渲染
 * （`renderClaimsFromEvents`），不是重跑导入——导入会重算新 hash 并撞
 * `event_rejected / already exists with a different hash`。
 *
 * M1 的注册面只有 `renderer:gate-result`：它把 `request_id = imp:<claim_no>`
 * 的 task.created/task.claimed 事件折叠成一条结论型 claim。M2 接 renderer_catalog
 * 后可把本函数换成通用调度，`ClaimRow` 契约不变。
 */
import { canonicalJson } from '../core/fold/canonical.js';
import type { SdoDatabase } from '../db/driver.js';
import type { ClaimRow } from './types.js';

export const RENDER_GATE_RESULT = 'renderer:gate-result';

interface RawEvent {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string;
  readonly request_id: string;
}

function frontierIdsOf(raw: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  return parsed.every((id) => typeof id === 'string' && id.length > 0) ? (parsed as string[]) : undefined;
}

export function parseFrontier(raw: string): readonly string[] | undefined {
  return frontierIdsOf(raw);
}

/** 读全量事件，按 `imp:<claim_no>` 分组，重算渲染器当前会产出的 claim 行（幂等、纯读）。 */
export function renderClaimRows(db: SdoDatabase): ClaimRow[] {
  const events = db
    .prepare('SELECT id, at, actor, kind, subject, request_id FROM event ORDER BY rowid')
    .all() as RawEvent[];
  const groups = new Map<string, RawEvent[]>();
  for (const event of events) {
    if (!event.request_id.startsWith('imp:')) continue;
    if (event.kind !== 'task.created' && event.kind !== 'task.claimed') continue;
    const group = groups.get(event.request_id) ?? [];
    group.push(event);
    groups.set(event.request_id, group);
  }
  const rows: ClaimRow[] = [];
  for (const [requestId, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const created = group.find((event) => event.kind === 'task.created');
    if (created === undefined) continue;
    const claimNo = requestId.slice('imp:'.length);
    if (claimNo.length === 0) continue;
    const last = group[group.length - 1] as RawEvent;
    rows.push({
      id: `claim:${claimNo}`,
      subject: created.subject,
      predicate: 'done',
      value: canonicalJson({ code: 'done', value: true }),
      as_of_frontier: canonicalJson(group.map((event) => event.id)),
      derived_by: RENDER_GATE_RESULT,
      actor: last.actor,
      at: last.at,
    });
  }
  return rows;
}

export { frontierIdsOf };
