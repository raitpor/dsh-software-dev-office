import { CODE } from '../../core/errors/codes.js';
/**
 * M4-2/C2、C3、C6：task.claimed 的前置（纯函数，输入是逐条推进的 fold state）。
 * 预占 ≠ 授权：预占期内只有 reserved_by 能认领；认领还必须持未过期且 actor/card 匹配的租约。
 */
import type { FoldState } from '../fold/types.js';



export interface ClaimGuardFailure {
  readonly reason_code: ClaimGuardFailureCode;
  readonly message: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function claimGuard(
  state: FoldState,
  cardId: string,
  actor: string,
  at: string,
): ClaimGuardFailure | undefined {
  const task = state.tables.task[cardId];
  if (task === undefined) return undefined; // 行不存在由 task reducer 报错
  const reservedBy = text(task['reserved_by']);
  const reservedUntil = text(task['reserved_until']);
  if (reservedBy !== undefined && reservedUntil !== undefined && Date.parse(reservedUntil) > Date.parse(at) && reservedBy !== actor) {
    return {
      reason_code: CODE.not_reserved_actor,
      message: `task ${cardId} is reserved by ${reservedBy} until ${reservedUntil}; actor ${actor} cannot claim it`,
    };
  }
  let sawLeaseForActor = false;
  let sawExpired = false;
  for (const row of Object.values(state.tables.lease)) {
    if (row['card_id'] !== cardId || row['actor'] !== actor) continue;
    sawLeaseForActor = true;
    const status = row['status'];
    const issuedAt = text(row['issued_at']) ?? '';
    const expiresAt = text(row['expires_at']) ?? '';
    if (status === 'active' && Date.parse(issuedAt) <= Date.parse(at) && Date.parse(at) < Date.parse(expiresAt)) return undefined;
    if (status === 'expired' || (status === 'active' && Date.parse(expiresAt) <= Date.parse(at))) sawExpired = true;
  }
  if (!sawLeaseForActor) {
    return { reason_code: CODE.no_lease, message: `task ${cardId} cannot be claimed by ${actor} without a lease (docs/07 §13)` };
  }
  if (sawExpired) {
    return { reason_code: CODE.lease_expired, message: `lease for task ${cardId} actor ${actor} has expired` };
  }
  return { reason_code: CODE.no_lease, message: `lease for task ${cardId} actor ${actor} is not active` };
}


export const ClaimGuardFailureCode_CODES = [
  CODE.lease_expired,
  CODE.no_lease,
  CODE.not_reserved_actor,
] as const;
export type ClaimGuardFailureCode = (typeof ClaimGuardFailureCode_CODES)[number];
