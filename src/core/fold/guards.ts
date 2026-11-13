import type { Event, FoldWorking, Row, TableName } from './types.js';

export class FoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FoldError';
  }
}

/** C5 fail-closed：错误必须带事件 id 与 kind，禁止静默跳过。 */
export function fail(event: Event, message: string): never {
  throw new FoldError(`fold failed at event ${event.id} (kind ${event.kind}): ${message}`);
}

export function payloadOf(event: Event): Record<string, unknown> {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return fail(event, 'payload must be a JSON object');
  }
  return payload as Record<string, unknown>;
}

export function reqString(event: Event, payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    return fail(event, `payload.${field} must be a non-empty string`);
  }
  return value;
}

export function optString(
  event: Event,
  payload: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = payload[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return fail(event, `payload.${field} must be a string when present`);
  }
  return value;
}

export function reqStringArray(
  event: Event,
  payload: Record<string, unknown>,
  field: string,
): readonly string[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return fail(event, `payload.${field} must be an array of strings`);
  }
  return value as readonly string[];
}

export function optStringArray(
  event: Event,
  payload: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  if (payload[field] === undefined || payload[field] === null) {
    return undefined;
  }
  return reqStringArray(event, payload, field);
}

export function upsert(state: FoldWorking, table: TableName, id: string, row: Row): void {
  state.tables[table][id] = row;
}

export function rowOf(state: FoldWorking, table: TableName, id: string): Row | undefined {
  return state.tables[table][id];
}

/** 更新必须命中的行；缺失说明事件流缺前置，按 fail-closed 炸。 */
export function patchRow(
  state: FoldWorking,
  table: TableName,
  id: string,
  event: Event,
  partial: Row,
): void {
  const existing = state.tables[table][id];
  if (existing === undefined) {
    return fail(event, `${table} row ${id} does not exist (missing prerequisite event)`);
  }
  state.tables[table][id] = { ...existing, ...partial };
}

/** docs/03：处置假设的 decision 必须存在且 status='valid'；否则该条不生效（卡 C2 正例 2）。 */
export function hasValidDecision(state: FoldWorking, decisionId: string): boolean {
  return state.tables.decision[decisionId]?.status === 'valid';
}

export function reqEnum<T extends string>(
  event: Event,
  payload: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = reqString(event, payload, field);
  if (!(allowed as readonly string[]).includes(value)) {
    return fail(event, `payload.${field} must be one of ${allowed.join('|')}`);
  }
  return value as T;
}

export function optEnum<T extends string>(
  event: Event,
  payload: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = optString(event, payload, field);
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    return fail(event, `payload.${field} must be one of ${allowed.join('|')}`);
  }
  return value as T;
}

export function optBool(event: Event, payload: Record<string, unknown>, field: string): boolean | undefined {
  const value = payload[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    return fail(event, `payload.${field} must be a boolean`);
  }
  return value;
}

export function reqInteger(event: Event, payload: Record<string, unknown>, field: string): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail(event, `payload.${field} must be an integer`);
  }
  return value;
}

/** docs/02 §10：subject 就是作用对象 id；空 subject 一律 fail-closed。 */
export function subjectId(event: Event): string {
  if (event.subject.length === 0) {
    return fail(event, 'subject must be a non-empty object id');
  }
  return event.subject;
}
