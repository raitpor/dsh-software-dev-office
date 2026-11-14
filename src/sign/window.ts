/**
 * 免密窗口状态机（C6/C7，docs/06 §7 表格；D-051）。
 *
 * 口径：**单次签发**——一次解锁只允许一次签发，签完立即回 locked。
 * TTL 缺省 0（关）：不提供定时窗口，解锁授权只被“下一次签发或 frontier 变化”消费；
 * TTL ∈ {5,15,60} 时额外要求签发发生在 `opened_at + TTL` 内，否则 `awaiting_unlock`。
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

/** 窗口是否仍可用于**这一次**签发。失效（frontier 变或 TTL 到期）⇒ 调用方统一 `frontier_stale`，窗口随即 lock。 */
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
export function windowRemainingMs(window: UnlockWindow, now: Date): number | null {
  if (window.until === null) return null;
  return Math.max(0, Date.parse(window.until) - now.getTime());
}
