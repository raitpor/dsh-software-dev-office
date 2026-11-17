/** M4-2 租约：docs/07 §13。租约 TTL 缺省 4h（S30 第 3 条），与锁的 2h 不是同一旋钮（D-136）。 */
export const DEFAULT_LEASE_TTL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_LEASE_TTL_S = DEFAULT_LEASE_TTL_MS / 1000;

export type LeaseStatus = 'active' | 'expired' | 'revoked';

export interface LeaseRow {
  readonly id: string;
  readonly card_id: string;
  readonly actor: string;
  readonly scope: string;
  readonly frontier: string;
  readonly ttl_s: number;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly status: LeaseStatus;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
}
