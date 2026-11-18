import { CODE } from '../../core/errors/codes.js';
/** M3-0 · 身份类型：actor 来自会话，不从 payload 自称（收口 D-056）。 */

export const ACTOR_KINDS = ['human', 'agent', 'service'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** 会话凭据：由工具层在建立会话时构造，`actor/kind` 不接受模型参数（docs/07 §1）。 */
export interface Session {
  /** 已登记 actor id（`actor` 表主键）。 */
  readonly actor: string;
  /** 由凭据决定，不由调用方自称。 */
  readonly actor_kind: ActorKind;
  readonly session_id: string;
  /** 凭据类型（测试/审计用；不落事件）。 */
  readonly credential: string;
}



export interface AuthFailure {
  readonly ok: false;
  readonly reason_code: AuthFailureCode;
  readonly message: string;
}

export interface SessionIdentity {
  readonly ok: true;
  readonly actor: string;
  readonly actor_kind: ActorKind;
}

export function isActorKind(value: unknown): value is ActorKind {
  return typeof value === 'string' && (ACTOR_KINDS as readonly string[]).includes(value);
}

/** 从会话取 actor 身份；会话本身非法 ⇒ invalid_field（fail-closed）。 */
export function identityFromSession(session: Session): SessionIdentity | AuthFailure {
  if (typeof session.actor !== 'string' || session.actor.length === 0) {
    return { ok: false, reason_code: CODE.invalid_field, message: '会话缺少 actor' };
  }
  if (!isActorKind(session.actor_kind)) {
    return { ok: false, reason_code: CODE.invalid_field, message: `会话 actor_kind 非法：${String(session.actor_kind)}` };
  }
  if (typeof session.session_id !== 'string' || session.session_id.length === 0) {
    return { ok: false, reason_code: CODE.invalid_field, message: '会话缺少 session_id' };
  }
  return { ok: true, actor: session.actor, actor_kind: session.actor_kind };
}

/**
 * 写路径的前置拒绝：payload 里出现 `actor` 一律拒（actor_not_from_session）。
 * 只认会话给出的身份——「以 payload 为准」是 M1 之前的漏洞形态（docs/07 §1）。
 */
export function rejectPayloadActor(payload: unknown): AuthFailure | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  if (!Object.hasOwn(payload, 'actor')) return undefined;
  return {
    ok: false,
    reason_code: CODE.actor_not_from_session,
    message: '写路径不接受 payload 的 actor；actor 必须来自会话凭据',
  };
}

/** 写路径的唯一身份入口：先拒 payload 自称，再取会话身份。 */
export function writeIdentity(session: Session, payload: unknown): SessionIdentity | AuthFailure {
  const rejected = rejectPayloadActor(payload);
  if (rejected !== undefined) return rejected;
  return identityFromSession(session);
}


export const AuthFailureCode_CODES = [
  CODE.actor_not_from_session,
  CODE.invalid_field,
] as const;
export type AuthFailureCode = (typeof AuthFailureCode_CODES)[number];
