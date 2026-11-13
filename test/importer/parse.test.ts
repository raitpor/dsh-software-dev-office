/**
 * parse 层单测：夹具正向解析 + C4 fail-closed（未知 kind / 坏字段 / 非结论型 claim）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ImportError,
  parseExport,
  parseExportText,
  type ExportCard,
} from '../../src/importer/parse.js';
import { fixtureDocument, loadFixture } from './helpers.js';

function catchImportError(run: () => unknown): ImportError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ImportError, `expected ImportError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected ImportError to be thrown');
}

describe('importer/parse: 夹具', () => {
  it('解析夹具：28 records = 8 card + 20 claim', () => {
    const parsed = loadFixture();
    assert.equal(parsed.format, 'sdo1-export');
    assert.equal(parsed.format_version, 1);
    assert.equal(parsed.exported_at, '2026-11-12T00:00:00Z');
    assert.equal(parsed.records.length, 28);
    assert.equal(parsed.cards.length, 8);
    assert.equal(parsed.claims.length, 20);
  });

  it('claim 字段全部落到 ExportClaim（含 v1 旧名映射）', () => {
    const parsed = loadFixture();
    const claim = parsed.claims[0];
    assert.ok(claim);
    assert.equal(claim.claim_no, 'RC-2026-0001');
    assert.equal(claim.task_id, 'TASK-001');
    assert.equal(claim.task_kind, 'review');
    assert.equal(claim.task_seq, 1);
    assert.equal(claim.criterion_id, 'CRIT-101');
    assert.equal(claim.spec_id, 'SPEC-001');
    assert.equal(claim.evidence_id, 'EV-001');
    assert.match(claim.artifact_sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(claim.predicate, 'done');
    assert.equal(claim.value, true);
    assert.equal(claim.renderer, 'renderer:gate-result');
    assert.equal(claim.actor, 'alice');
    assert.equal(claim.at, '2026-09-30T08:01:00Z');
  });

  it('card 的 seq 允许 null（回填输入）与已有值并存', () => {
    const parsed = loadFixture();
    assert.equal(parsed.cards[0]?.seq, 1);
    assert.equal(parsed.cards[1]?.seq, null);
    assert.equal(parsed.cards[7]?.seq, null);
  });
});

describe('importer/parse: fail-closed（C4/C2 负例）', () => {
  it('未知 record kind → unknown_kind，带 offset', () => {
    const doc = fixtureDocument();
    doc.records.push({ kind: 'mystery' });
    const error = catchImportError(() => parseExport(doc));
    assert.equal(error.code, 'unknown_kind');
    assert.equal(error.offset, 28);
    assert.match(error.message, /records\[28\]\.kind/);
    assert.match(error.message, /no default/);
  });

  it('无 kind 字段也 fail-closed（不猜 claim/card）', () => {
    const doc = fixtureDocument();
    doc.records.push({ claim_no: 'RC-2026-9999' });
    const error = catchImportError(() => parseExport(doc));
    assert.equal(error.code, 'unknown_kind');
    assert.equal(error.offset, 28);
    assert.match(error.message, /records\[28\]\.kind undefined/);
  });

  it('未知 task_kind → unknown_kind，带 offset', () => {
    const doc = fixtureDocument();
    const claim = doc.records[8];
    assert.ok(claim);
    claim['task_kind'] = 'chore';
    const error = catchImportError(() => parseExport(doc));
    assert.equal(error.code, 'unknown_kind');
    assert.equal(error.offset, 8);
    assert.equal(error.path, 'records[8].task_kind');
  });

  it('缺 evidence_id → field，path 指到 records[8].evidence_id', () => {
    const doc = fixtureDocument();
    const claim = doc.records[8];
    assert.ok(claim);
    delete claim['evidence_id'];
    const error = catchImportError(() => parseExport(doc));
    assert.equal(error.code, 'field');
    assert.equal(error.offset, 8);
    assert.equal(error.path, 'records[8].evidence_id');
  });

  it('非 JSON → json 错误', () => {
    const error = catchImportError(() => parseExportText('not json', 'x.json'));
    assert.equal(error.code, 'json');
    assert.equal(error.path, 'x.json');
  });

  it('format / format_version 不匹配 → format 错误', () => {
    const doc = fixtureDocument();
    doc.records.length = 0;
    const wrongFormat = { ...doc, format: 'something-else' };
    assert.equal(catchImportError(() => parseExport(wrongFormat)).code, 'format');
    const wrongVersion = { ...doc, format_version: 2 };
    assert.equal(catchImportError(() => parseExport(wrongVersion)).code, 'format');
  });

  it('非结论型 claim（predicate ≠ done）→ unsupported_conclusion', () => {
    const doc = fixtureDocument();
    const claim = doc.records[8];
    assert.ok(claim);
    claim['predicate'] = 'in_progress';
    const error = catchImportError(() => parseExport(doc));
    assert.equal(error.code, 'unsupported_conclusion');
    assert.equal(error.offset, 8);
  });

  it('结论型 claim 的 value 必须是布尔 true（不是 "true"）', () => {
    const doc = fixtureDocument();
    const claim = doc.records[8];
    assert.ok(claim);
    claim['value'] = 'true';
    const error = catchImportError(() => parseExport(doc));
    assert.equal(error.code, 'unsupported_conclusion');
    assert.equal(error.offset, 8);
  });

  it('重复 claim_no → duplicate_claim，指出两处 offset', () => {
    const doc = fixtureDocument();
    const claim = doc.records[9];
    assert.ok(claim);
    claim['claim_no'] = 'RC-2026-0001';
    const error = catchImportError(() => parseExport(doc));
    assert.equal(error.code, 'duplicate_claim');
    assert.equal(error.offset, 9);
    assert.match(error.message, /records\[8\] and records\[9\]/);
  });

  it('card seq 非整数 → field 错误', () => {
    const doc = fixtureDocument();
    const card = doc.records[0] as unknown as ExportCard & Record<string, unknown>;
    assert.ok(card);
    doc.records[0] = { ...card, seq: 'one' };
    const error = catchImportError(() => parseExport(doc));
    assert.equal(error.code, 'field');
    assert.equal(error.path, 'records[0].seq');
  });
});
