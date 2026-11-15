/**
 * 写网关的信封校验（M1-0）：字段形状 → kind 注册 → 本卡物化范围（`SUPPORTED_KINDS`）。
 * 独立成文件是为了让 `write.ts` 只留事务/链/物化编排（单文件 <200 行）。
 */

import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';
import { ACK_KINDS } from '../core/fold/ack.js';
import { REDUCERS } from '../core/fold/registry.js';
import type { Event } from '../core/fold/types.js';
import { checkDecisionSignedProvenance } from '../sign/provenance.js';
import { MATERIALIZED_TABLES, SUPPORTED_KINDS, requiredTable } from './write-materialize.js';
import { failure, type AppendFailure } from './write-types.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function checkEnvelope(event: Event): AppendFailure | undefined {
  if (!isNonEmptyString(event.id)) return failure('invalid_field', 'event.id must be a non-empty string');
  for (const field of ['at', 'actor', 'kind', 'subject', 'request_id', 'prev', 'hash'] as const) {
    if (!isNonEmptyString(event[field])) {
      return failure('invalid_field', `${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(event.caused_by) || event.caused_by.some((item) => typeof item !== 'string')) {
    return failure('invalid_field', 'caused_by must be an array of event ids');
  }
  // Object.hasOwn 防原型链：kind='toString' 不能命中 Object.prototype。
  if (!Object.hasOwn(REDUCERS, event.kind) && !Object.hasOwn(ACK_KINDS, event.kind)) {
    return failure('unknown_event_kind', `unknown event kind ${event.kind}`);
  }
  // C8：decision.signed 必须带 signerd 的可验证回执（受信公钥 + Ed25519 + 回执逐字段一致）。
  // 只有裸 append 的“随便一个 signature 字符串”在这里被拒，0 行落库。
  if (event.kind === 'decision.signed') {
    const check = checkDecisionSignedProvenance({
      decision_id: event.subject,
      payload: event.payload,
      event_at: event.at,
    });
    if (!check.ok) {
      const code = check.reason === 'signature_time_mismatch' ? 'signature_time_mismatch' : 'signature_not_from_signerd';
      return failure(`${code}`, `decision.signed 未通过 signerd 验签：${check.message ?? 'unknown'}`);
    }
  }
  // D-055：decision.valid 的 payload_hash 必须覆盖 payload.payload 的真实内容。
  // 否则“签过的内容”与库里的内容可以对不上而无人发现（canonicalJson 复用 core，不另写一套）。
  if (event.kind === 'decision.valid') {
    const payload = event.payload as unknown;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return failure('invalid_field', 'decision.valid.payload must be an object');
    }
    const record = payload as Record<string, unknown>;
    const declared = record['payload_hash'];
    if (!isNonEmptyString(declared)) {
      return failure('invalid_field', 'decision.valid.payload_hash must be a non-empty string');
    }
    const inner = record['payload'];
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
      return failure('invalid_field', 'decision.valid.payload.payload must be an object');
    }
    const expected = `sha256:${sha256Hex(canonicalJson(inner))}`;
    if (declared !== expected) {
      return failure(
        'invalid_field',
        `decision.valid.payload_hash 与 payload 内容不一致（D-055）：declared=${declared} expected=${expected}`,
      );
    }
  }
  // M2-3/C4 + D-078：`assumption.invalidated` 语义上是 fold 派生读数（inputs hash 变化时自动回 open），
  // 不是可写事件。kind 仍保留在 003 种子里仅为旧库兼容，任何写入入口都前置拒绝（fold 里同样拒）。
  if (event.kind === 'assumption.invalidated') {
    return failure(
      'assumption_invalidated_is_derived',
      'assumption.invalidated 是 fold 派生读数，不是可写事件；失效由 inputs hash 变化自动产生（D-078）',
    );
  }
  // ACK kind（audit-only，如 security.alert/auth.failed）：append 成功即写 event，不投影业务表（C12）。
  if (Object.hasOwn(ACK_KINDS, event.kind)) return undefined;
  if (!Object.hasOwn(SUPPORTED_KINDS, event.kind)) {
    const project = requiredTable(event.kind) ?? 'no fold projection (ACK kind)';
    return failure(
      'unsupported_scope',
      `event kind ${event.kind} projects to ${project}; ` +
        `materialized tables are ${MATERIALIZED_TABLES.join('/')} (C5)`,
    );
  }
  return undefined;
}

/** BUSY 与 LOCKED 同属“别的连接占着库”，都归 `database_busy`（P2-1）。 */
export function isLockMessage(message: string): boolean {
  return /database is locked|database is busy|database table is locked|database schema is locked|SQLITE_BUSY|SQLITE_LOCKED/iu.test(message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
