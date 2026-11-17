/**
 * M4-7/A1+C2+C6：一次派发的区间只定义在这里。
 * 区间 = `lease.issued`（lease id）→ `lease.expired`/`lease.revoked`（同 lease_id）
 * 或该卡的 `task.done`/`task.dropped`（卡收尾）。计数与读数都引用同一个函数。
 */

export interface WindowEvent {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string;
  readonly payload: Record<string, unknown>;
}

export interface DispatchWindow {
  readonly lease_id: string;
  readonly card: string;
  readonly from: string;
  readonly until?: string;
  readonly closed_by?: string;
}

export type DispatchWindowResult =
  | { readonly ok: true; readonly window: DispatchWindow }
  | { readonly ok: false; readonly message: string };

function payloadOf(event: WindowEvent): Record<string, unknown> {
  return event.payload;
}

/** 按 (at,id) 稳定排序，保证重放结果与输入顺序无关。 */
function ordered(events: readonly WindowEvent[]): readonly WindowEvent[] {
  return events
    .slice()
    .sort((left, right) => {
      const byTime = Date.parse(left.at) - Date.parse(right.at);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });
}

export function dispatchWindow(events: readonly WindowEvent[], leaseId: string): DispatchWindowResult {
  const sorted = ordered(events);
  const issued = sorted.find((event) => event.kind === 'lease.issued' && event.id === leaseId);
  if (issued === undefined) return { ok: false, message: `lease.issued event ${leaseId} does not exist` };
  const card = typeof payloadOf(issued)['card'] === 'string' ? String(payloadOf(issued)['card']) : issued.subject;
  const closing = sorted.find((event) => {
    if (Date.parse(event.at) < Date.parse(issued.at)) return false;
    if (event.kind === 'lease.expired' || event.kind === 'lease.revoked') {
      return payloadOf(event)['lease_id'] === leaseId;
    }
    if (event.kind === 'task.done' || event.kind === 'task.dropped') return event.subject === card;
    return false;
  });
  return {
    ok: true,
    window: {
      lease_id: leaseId,
      card,
      from: issued.at,
      ...(closing === undefined ? {} : { until: closing.at, closed_by: closing.id }),
    },
  };
}

export function eventsInWindow(events: readonly WindowEvent[], window: DispatchWindow): readonly WindowEvent[] {
  const from = Date.parse(window.from);
  const until = window.until === undefined ? undefined : Date.parse(window.until);
  return ordered(events).filter((event) => {
    const at = Date.parse(event.at);
    return at >= from && (until === undefined || at <= until) && event.id !== window.lease_id;
  });
}

/** C2：一次派发内 `agent.pick_declined` 的条数。 */
export function pickDeclinedInWindow(events: readonly WindowEvent[], window: DispatchWindow): number {
  const licked = eventsInWindow(events, window).filter(
    (event) => event.kind === 'agent.pick_declined' && event.payload['dispatch_id'] === window.lease_id,
  );
  return licked.length;
}
