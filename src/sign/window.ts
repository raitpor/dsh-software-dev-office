/**
 * 免密窗口状态机（C6/C7，docs/06 §7 表格；D-051）。
 *
 * 口径（D-060，D-051 作废）：
 *   · TTL=0（缺省）：**单次签发**——一次解锁授权一次签发，签完立即回 locked；
 *   · TTL ∈ {5,15,60}：`window_until` 内且 frontier 不变 ⇒ **可连签**，签发不消费窗口；
 *     到期 / frontier 变 / 手动 lock ⇒ 立即失效（连签的每一条仍要过 D-058 的签前签后双检）。
 * 窗口状态只在 signerd 进程内存里（A4），不落盘、不继承会话。
 */
import { SignError } from './errors.js';

export type WindowTtlMinutes = 0 | 5 | 15 | 60;

export const WINDOW_TTLS: readonly WindowTtlMinutes[] = [0, 5, 15, 60];

export function parseWindowTtl(raw: string | undefined): WindowTtlMinutes {
  if (raw === undefined || raw === '') return 0;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || !WINDOW_TTLS.includes(minutes as WindowTtlMinutes)) {
    throw new SignError(
      'invalid_request',
      `SDO_SIGNERD_WINDOW_TTL_MINUTES 只允许 0/5/15/60，收到 ${String(raw)}`,
    );
  }
  return minutes as WindowTtlMinutes;
}

export interface UnlockWindow {
  readonly actor: string;
  /** 解锁时刻的 frontier；签发前必须与请求一致。 */
  readonly frontier_hash: string;
  readonly opened_at: string;
  readonly ttl_minutes: WindowTtlMinutes;
  /** TTL=0 时为 null（无定时窗口，仅单次授权）。 */
  readonly until: string | null;
}

export function openWindow(input: {
  readonly actor: string;
  readonly frontier: string;
  readonly ttl_minutes: WindowTtlMinutes;
  readonly now: Date;
}): UnlockWindow {
  const until =
    input.ttl_minutes === 0
      ? null
      : new Date(input.now.getTime() + input.ttl_minutes * 60_000).toISOString();
  return {
    actor: input.actor,
    frontier_hash: input.frontier,
    opened_at: input.now.toISOString(),
    ttl_minutes: input.ttl_minutes,
    until,
  };
}

export type WindowCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * 窗口是否仍可用于签发（TTL=0 时一次性；TTL>0 时窗口内可多次）。
 *
 * D-060 实现口径（与 Lead 裁定一致；详见 README）：**TTL>0 的连签必然推进链头**
 * （每次签发都 append decision.valid+signed），signerd 又看不到库链，无法区分
 * “自己签出来的新 frontier”与“外部注入的新 frontier”，因此 TTL>0 时本函数只校验
 * 窗口未到期；frontier 推进的授权由 `decision.ts` 的签前/签后双检负责（D-058），
 * 外部事件注入会让待签项 frontier != 当前链头，由签字页判 `frontier_stale` 并要求重解锁。
 * TTL=0 时窗口是一次性授权，仍严格比 frontier（到期/变化都拒）。
 */
export function checkWindow(window: UnlockWindow, input: { frontier: string; now: Date }): WindowCheck {
  if (window.frontier_hash !== input.frontier) {
    return { ok: false, message: 'frontier 已变化，免密窗口失效（frontier_stale）' };
  }
  if (window.until !== null && input.now.getTime() >= Date.parse(window.until)) {
    return { ok: false, message: `免密窗口已于 ${window.until} 到期` };
  }
  return { ok: true };
}

/** 窗口剩余毫秒；TTL=0 返回 null（无倒计时）。 */
/** TTL>0 的窗口在签发后仍可复用；TTL=0 的解锁是一次性授权。 */
export function windowReusable(window: UnlockWindow): boolean {
  return window.ttl_minutes > 0;
}

export function windowRemainingMs(window: UnlockWindow, now: Date): number | null {
  if (window.until === null) return null;
  return Math.max(0, Date.parse(window.until) - now.getTime());
}
