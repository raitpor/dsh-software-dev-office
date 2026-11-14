import type { ActorKind } from '../sign/protocol.js';
import type { SignChannel } from '../sign/receipt.js';

export interface FreezeSession {
  /** D-056：人签身份由工具层从会话固定，调用方不得从动作 payload 传。 */
  readonly actor: string;
  readonly actor_kind: ActorKind;
  readonly producer: string;
  readonly channel: SignChannel;
}

export interface FreezeDbResult {
  readonly ok: boolean;
  readonly reason_code?: string;
  readonly message?: string;
  readonly reason_codes?: readonly string[];
  readonly baseline?: import('../core/baseline/freeze.js').BaselineRowLike;
  readonly decision_id?: string;
  readonly event_id?: string;
  readonly rejected_event_id?: string;
}
