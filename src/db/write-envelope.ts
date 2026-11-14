/**
 * 写网关的信封校验（M1-0）：字段形状 → kind 注册 → 本卡物化范围（`SUPPORTED_KINDS`）。
 * 独立成文件是为了让 `write.ts` 只留事务/链/物化编排（单文件 <200 行）。
 */

import { ACK_KINDS } from '../core/fold/ack.js';
import { REDUCERS } from '../core/fold/registry.js';
import type { Event } from '../core/fold/types.js';
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
