/**
 * seq 回填单测（C3）：1..N 唯一单调；冲突/跳号/非正数都点名卡号。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { backfillSeq } from '../../src/importer/seq.js';
import { ImportError, type ExportCard } from '../../src/importer/parse.js';
import { cardRecord, loadFixture } from './helpers.js';

function catchImportError(run: () => unknown): ImportError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ImportError, `expected ImportError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected ImportError to be thrown');
}

function seqOf(cards: readonly ExportCard[]): number[] {
  return backfillSeq(cards).rows.map((row) => row.seq);
}

describe('importer/seq: 夹具回填', () => {
  it('8 张卡 → 1..8 唯一单调，已有 seq=1 保留，其余按导出顺序补', () => {
    const result = backfillSeq(loadFixture().cards);
    assert.deepEqual(
      result.rows.map((row) => row.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.deepEqual(result.rows.map((row) => row.source), [
      'existing',
      'backfilled',
      'backfilled',
      'backfilled',
      'backfilled',
      'backfilled',
      'backfilled',
      'backfilled',
    ]);
    assert.deepEqual(result.summary, {
      cards: 8,
      distinct: 8,
      nulls: 0,
      min: 1,
      max: 8,
      monotonic: true,
    });
  });

  it('回填后 seq 唯一 == 卡数，空值 0（docs/09 §17 校验口径）', () => {
    const result = backfillSeq(loadFixture().cards);
    const seqs = result.rows.map((row) => row.seq);
    assert.equal(new Set(seqs).size, result.summary.cards);
    assert.equal(result.summary.nulls, 0);
    assert.equal(result.summary.min, 1);
    assert.equal(result.summary.max, result.summary.cards);
  });
});

describe('importer/seq: 正常回填', () => {
  it('全空 → 按导出顺序 1..N', () => {
    const result = backfillSeq([
      cardRecord('A', null),
      cardRecord('B', null),
      cardRecord('C', null),
    ]);
    assert.deepEqual(result.rows.map((row) => row.seq), [1, 2, 3]);
    assert.ok(result.rows.every((row) => row.source === 'backfilled'));
  });

  it('已有 1..N 且顺序正确 → 全部保留', () => {
    const result = backfillSeq([
      cardRecord('A', 1),
      cardRecord('B', 2),
      cardRecord('C', 3),
    ]);
    assert.deepEqual(result.rows.map((row) => row.seq), [1, 2, 3]);
    assert.ok(result.rows.every((row) => row.source === 'existing'));
  });

  it('前面已有 + 后面缺 → 缺的按顺序取剩下的号（仍单调）', () => {
    const result = backfillSeq([
      cardRecord('A', 1),
      cardRecord('B', null),
      cardRecord('C', null),
    ]);
    assert.deepEqual(result.rows.map((row) => row.seq), [1, 2, 3]);
    assert.deepEqual(
      result.rows.map((row) => row.source),
      ['existing', 'backfilled', 'backfilled'],
    );
  });
});

describe('importer/seq: 负例（点名卡号）', () => {
  it('重复 seq → seq_conflict，cardIds 含两张卡', () => {
    const error = catchImportError(() => seqOf([cardRecord('A', 2), cardRecord('B', 2)]));
    assert.equal(error.code, 'seq_conflict');
    assert.deepEqual(error.cardIds, ['A', 'B']);
    assert.match(error.message, /A and B/);
  });

  it('seq 超过卡数（跳号）→ seq_gap，点名卡号', () => {
    const error = catchImportError(() =>
      seqOf([cardRecord('A', 1), cardRecord('B', 2), cardRecord('C', 4)]),
    );
    assert.equal(error.code, 'seq_gap');
    assert.deepEqual(error.cardIds, ['C']);
    assert.match(error.message, /required range is 1\.\.3/);
  });

  it('seq=0 / 负数 → seq_invalid，点名卡号', () => {
    for (const bad of [0, -1]) {
      const error = catchImportError(() => seqOf([cardRecord('A', bad), cardRecord('B', 1)]));
      assert.equal(error.code, 'seq_invalid');
      assert.deepEqual(error.cardIds, ['A']);
    }
  });

  it('非整数 seq → seq_invalid', () => {
    const error = catchImportError(() =>
      seqOf([{ kind: 'card', offset: 0, card_id: 'A', title: null, seq: 1.5 }]),
    );
    assert.equal(error.code, 'seq_invalid');
    assert.deepEqual(error.cardIds, ['A']);
  });

  it('缺号卡夹在已有 seq 之前（无号可补）→ seq_conflict，不硬塞', () => {
    const error = catchImportError(() => seqOf([cardRecord('A', null), cardRecord('B', 1)]));
    assert.equal(error.code, 'seq_conflict');
    assert.deepEqual(error.cardIds, ['A', 'B']);
  });

  it('已有 seq 与导出顺序倒挂 → seq_conflict，双卡号', () => {
    const error = catchImportError(() => seqOf([cardRecord('A', 2), cardRecord('B', 1)]));
    assert.equal(error.code, 'seq_conflict');
    assert.deepEqual(error.cardIds, ['A', 'B']);
    assert.match(error.message, /A=2 then B=1/);
  });

  it('重复 card_id → seq_conflict', () => {
    const error = catchImportError(() => seqOf([cardRecord('A', null), cardRecord('A', null)]));
    assert.equal(error.code, 'seq_conflict');
    assert.deepEqual(error.cardIds, ['A']);
  });

  it('空卡列表 → seq_gap（没有可回填的东西不装成功）', () => {
    const error = catchImportError(() => seqOf([]));
    assert.equal(error.code, 'seq_gap');
  });
});
