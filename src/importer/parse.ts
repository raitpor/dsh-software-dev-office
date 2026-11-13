/**
 * v1 只读导出（`sdo1 export`）的解析层。
 *
 * M0-7 的输入格式**没有真样本**（卡 plan/cards/M0-7.md 假设 A1）：这里按最小字段集
 * 夹具 `test/fixtures/v1-export.json` 定义格式；字段名映射表写进 `src/importer/README.md`。
 * 真样本到了再加一卡兼容，**不猜**。
 *
 * 纪律：
 *   · **fail-closed**：未知 record `kind`、未知 `task_kind`、缺字段、非结论型 claim
 *     一律报错，不猜默认值；错误带 `offset`（record 下标）。
 *   · **只读**：本模块只 `readFileSync`，不写任何文件；写只发生在 CLI 的显式 `--out`
 *     （见 `src/importer/index.ts`）。
 */

import { readFileSync } from 'node:fs';

/** 夹具定义的 v1 导出格式标识（A1：真样本到位后按实际格式再加兼容卡）。 */
export const IMPORT_FORMAT = 'sdo1-export';
export const IMPORT_FORMAT_VERSION = 1;

/** 导出流的 record 判别字段；未知值必须 fail-closed（C4）。 */
export const RECORD_KINDS = ['card', 'claim'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/**
 * v2 `task.kind` 的枚举。口径与 `src/core/fold/reducers/task.ts` 的 `TASK_KINDS` 一致；
 * fold 不导出该常量，这里只读地复制一份（不 import 私有符号）——两边漂移时 fold 会拒绝，
 * 本层只会更保守地拒绝，不会静默放过。
 */
export const TASK_KINDS = ['implement', 'design', 'review', 'docs'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** M0 只认“结论型回执”：predicate=done、value=true。 */
export const CONCLUSION_PREDICATE = 'done';

export type ImportErrorCode =
  | 'io'
  | 'json'
  | 'format'
  | 'unknown_kind'
  | 'field'
  | 'unsupported_conclusion'
  | 'duplicate_claim'
  | 'sample'
  | 'sample_too_small'
  | 'structure'
  | 'rebuild'
  | 'seq_invalid'
  | 'seq_conflict'
  | 'seq_gap'
  | 'invalid_field'
  | 'usage';

export interface ImportErrorDetails {
  /** record 在导出 `records[]` 里的下标（0 起）。 */
  offset?: number;
  /** 相关卡号（seq 回填错误用）。 */
  cardIds?: readonly string[];
  /** 出错的字段路径（如 `records[3].claim_no` 或输入文件路径）。 */
  path?: string;
  /** `sample_too_small`：导出里实际可用的 claim 数。 */
  available?: number;
  /** `sample_too_small`：判据 C2 要求的最小 claim 数。 */
  required?: number;
}

/** 导入器的唯一错误类型：带 `code`/`offset`，CLI 序列化成 stderr JSON。 */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly offset?: number;
  readonly cardIds: readonly string[];
  readonly path?: string;
  readonly available?: number;
  readonly required?: number;

  constructor(code: ImportErrorCode, message: string, details: ImportErrorDetails = {}) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.offset = details.offset;
    this.cardIds = details.cardIds ?? [];
    this.path = details.path;
    this.available = details.available;
    this.required = details.required;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.offset !== undefined) {
      out['offset'] = this.offset;
    }
    if (this.cardIds.length > 0) {
      out['cardIds'] = this.cardIds;
    }
    if (this.path !== undefined) {
      out['path'] = this.path;
    }
    if (this.available !== undefined) {
      out['available'] = this.available;
    }
    if (this.required !== undefined) {
      out['required'] = this.required;
    }
    return out;
  }
}

/** `records[<offset>]` 这一类字段路径的统一写法（测试按它断言 offset）。 */
export function recordPath(offset: number, field?: string): string {
  return field === undefined ? `records[${offset}]` : `records[${offset}].${field}`;
}

export interface ExportCard {
  readonly kind: 'card';
  /** record 在导出流里的下标（错误定位用；不参与回填顺序）。 */
  readonly offset: number;
  readonly card_id: string;
  readonly title: string | null;
  /** 缺 seq ⇒ null（回填输入）；已有 seq 保留并参与冲突/跳号校验。 */
  readonly seq: number | null;
}

export interface ExportClaim {
  readonly kind: 'claim';
  readonly offset: number;
  readonly claim_no: string;
  readonly task_id: string;
  readonly task_title: string;
  readonly task_kind: TaskKind;
  readonly task_seq: number;
  readonly criterion_id: string;
  readonly spec_id: string;
  readonly evidence_id: string;
  readonly artifact_uri: string;
  readonly artifact_sha256: string;
  readonly predicate: string;
  readonly value: true;
  readonly frontier: string;
  readonly renderer: string;
  readonly actor: string;
  readonly at: string;
}

export type ExportRecord = ExportCard | ExportClaim;

export interface ParsedExport {
  readonly format: string;
  readonly format_version: number;
  readonly exported_at: string | null;
  readonly source: string | null;
  readonly records: readonly ExportRecord[];
  readonly cards: readonly ExportCard[];
  readonly claims: readonly ExportClaim[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  code: ImportErrorCode,
  message: string,
  details: ImportErrorDetails = {},
): never {
  throw new ImportError(code, message, details);
}

function fieldFail(offset: number, field: string, message: string): never {
  return fail('field', `${recordPath(offset, field)}: ${message}`, {
    offset,
    path: recordPath(offset, field),
  });
}

function reqString(
  record: Record<string, unknown>,
  field: string,
  offset: number,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    return fieldFail(offset, field, 'must be a non-empty string');
  }
  return value;
}

function optNullableString(
  record: Record<string, unknown>,
  field: string,
  offset: number,
): string | null {
  const value = record[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return fieldFail(offset, field, 'must be a non-empty string when present');
  }
  return value;
}

function reqInteger(
  record: Record<string, unknown>,
  field: string,
  offset: number,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fieldFail(offset, field, 'must be an integer');
  }
  return value;
}

function parseCard(record: Record<string, unknown>, offset: number): ExportCard {
  const card_id = reqString(record, 'card_id', offset);
  const title = optNullableString(record, 'title', offset);
  const rawSeq = record['seq'];
  let seq: number | null;
  if (rawSeq === undefined || rawSeq === null) {
    seq = null;
  } else if (typeof rawSeq !== 'number' || !Number.isInteger(rawSeq)) {
    return fieldFail(offset, 'seq', 'must be an integer or null (null = needs backfill)');
  } else {
    seq = rawSeq;
  }
  return { kind: 'card', offset, card_id, title, seq };
}

function parseClaim(record: Record<string, unknown>, offset: number): ExportClaim {
  const claim_no = reqString(record, 'claim_no', offset);
  const task_kind = reqString(record, 'task_kind', offset);
  if (!(TASK_KINDS as readonly string[]).includes(task_kind)) {
    return fail(
      'unknown_kind',
      `${recordPath(offset, 'task_kind')} ${JSON.stringify(task_kind)} is not one of ${TASK_KINDS.join('|')} (fail-closed: no default)`,
      { offset, path: recordPath(offset, 'task_kind') },
    );
  }
  const task_seq = reqInteger(record, 'task_seq', offset);
  if (task_seq < 1) {
    return fieldFail(offset, 'task_seq', 'must be a positive integer (v2 task seq starts at 1)');
  }
  const predicate = reqString(record, 'predicate', offset);
  if (predicate !== CONCLUSION_PREDICATE) {
    return fail(
      'unsupported_conclusion',
      `${recordPath(offset, 'predicate')} ${JSON.stringify(predicate)} unsupported: M0 importer only rebuilds conclusion receipts (predicate ${CONCLUSION_PREDICATE}); refusing to guess`,
      { offset, path: recordPath(offset, 'predicate') },
    );
  }
  if (record['value'] !== true) {
    return fail(
      'unsupported_conclusion',
      `${recordPath(offset, 'value')} must be boolean true for a conclusion receipt (fail-closed: no default)`,
      { offset, path: recordPath(offset, 'value') },
    );
  }
  return {
    kind: 'claim',
    offset,
    claim_no,
    task_id: reqString(record, 'task_id', offset),
    task_title: reqString(record, 'task_title', offset),
    task_kind: task_kind as TaskKind,
    task_seq,
    criterion_id: reqString(record, 'criterion_id', offset),
    spec_id: reqString(record, 'spec_id', offset),
    evidence_id: reqString(record, 'evidence_id', offset),
    artifact_uri: reqString(record, 'artifact_uri', offset),
    artifact_sha256: reqString(record, 'artifact_sha256', offset),
    predicate,
    value: true,
    frontier: reqString(record, 'frontier', offset),
    renderer: reqString(record, 'renderer', offset),
    actor: reqString(record, 'actor', offset),
    at: reqString(record, 'at', offset),
  };
}

function parseRecord(raw: unknown, offset: number): ExportRecord {
  if (!isRecord(raw)) {
    return fail('field', `${recordPath(offset)} must be a JSON object`, {
      offset,
      path: recordPath(offset),
    });
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(RECORD_KINDS as readonly string[]).includes(kind)) {
    return fail(
      'unknown_kind',
      `${recordPath(offset, 'kind')} ${JSON.stringify(kind)} is not one of ${RECORD_KINDS.join('|')} (fail-closed: no default)`,
      { offset, path: recordPath(offset, 'kind') },
    );
  }
  return kind === 'card' ? parseCard(raw, offset) : parseClaim(raw, offset);
}

/** 解析已读入内存的导出文本（测试与 `readExportFile` 共用）。 */
export function parseExportText(text: string, sourcePath = '<inline>'): ParsedExport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail('json', `input ${sourcePath} is not valid JSON: ${detail}`, { path: sourcePath });
  }
  return parseExport(raw);
}

/** 解析导出对象本身（测试可绕过文件 I/O）。 */
export function parseExport(raw: unknown): ParsedExport {
  if (!isRecord(raw)) {
    return fail('format', 'export must be a JSON object', { path: 'export' });
  }
  const format = reqString(raw, 'format', -1);
  if (format !== IMPORT_FORMAT) {
    return fail(
      'format',
      `export.format must be ${JSON.stringify(IMPORT_FORMAT)}, got ${JSON.stringify(format)}`,
      { path: 'export.format' },
    );
  }
  const format_version = reqInteger(raw, 'format_version', -1);
  if (format_version !== IMPORT_FORMAT_VERSION) {
    return fail(
      'format',
      `export.format_version must be ${IMPORT_FORMAT_VERSION}, got ${format_version}`,
      { path: 'export.format_version' },
    );
  }
  const exported_at = optNullableString(raw, 'exported_at', -1);
  const source = optNullableString(raw, 'source', -1);
  const rawRecords = raw['records'];
  if (!Array.isArray(rawRecords)) {
    return fail('format', 'export.records must be an array', { path: 'export.records' });
  }
  const records: ExportRecord[] = [];
  const cards: ExportCard[] = [];
  const claims: ExportClaim[] = [];
  rawRecords.forEach((item, offset) => {
    const record = parseRecord(item, offset);
    records.push(record);
    if (record.kind === 'card') {
      cards.push(record);
    } else {
      claims.push(record);
    }
  });
  const seenClaims = new Map<string, number>();
  for (const claim of claims) {
    const previous = seenClaims.get(claim.claim_no);
    if (previous !== undefined) {
      return fail(
        'duplicate_claim',
        `claim_no ${claim.claim_no} appears twice (records[${previous}] and records[${claim.offset}]); synthetic event ids are derived from claim_no, so duplicates are refused`,
        { offset: claim.offset, path: recordPath(claim.offset, 'claim_no') },
      );
    }
    seenClaims.set(claim.claim_no, claim.offset);
  }
  return { format, format_version, exported_at, source, records, cards, claims };
}

/** 读导出文件（只读）并解析；I/O 错误也收敛成 `ImportError('io')`。 */
export function readExportFile(path: string): ParsedExport {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail('io', `cannot read input ${path}: ${detail}`, { path });
  }
  return parseExportText(text, path);
}
