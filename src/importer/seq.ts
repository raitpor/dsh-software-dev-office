/**
 * seq 回填层：给定导出里的卡记录（`records[].kind === 'card'`），产出一张
 * `card_id → seq` 映射表。**只产表，不写库**（A3 / D-008 口径：M0 不落库）。
 *
 * 判据 C3 的口径（docs/09 §17 card 7）：
 *   · 1..N 唯一、按建卡顺序单调、无空值；
 *   · 已有 seq 原样保留；缺 seq 的卡按导出顺序取剩下的号；
 *   · 冲突/跳号/非正数 → 报错并指出卡号（`ImportError.cardIds`）。
 */

import { ImportError, type ExportCard } from './parse.js';

export interface SeqRow {
  readonly card_id: string;
  readonly seq: number;
  /** existing = 导出里已有 seq；backfilled = 本次按导出顺序补的。 */
  readonly source: 'existing' | 'backfilled';
}

export interface SeqSummary {
  readonly cards: number;
  readonly distinct: number;
  readonly nulls: number;
  readonly min: number;
  readonly max: number;
  readonly monotonic: boolean;
}

export interface SeqBackfill {
  readonly rows: readonly SeqRow[];
  readonly summary: SeqSummary;
}

/**
 * 回填映射。算法：
 *   1. 卡号必须唯一（重复 → seq_conflict，双卡号）；
 *   2. 已有 seq 必须是 1..N 内正整数且不重复（不然 seq_invalid / seq_gap / seq_conflict，
 *      都带卡号）；
 *   3. 1..N 里没被占用的号，按导出顺序升序分给 seq=null 的卡；
 *   4. 回填后整列必须严格递增（否则已有 seq 与导出顺序矛盾 → seq_conflict，双卡号）。
 */
export function backfillSeq(cards: readonly ExportCard[]): SeqBackfill {
  const total = cards.length;
  if (total === 0) {
    throw new ImportError('seq_gap', 'no card records in the export; nothing to backfill', {
      path: 'records',
    });
  }

  const seenIds = new Set<string>();
  for (const card of cards) {
    if (seenIds.has(card.card_id)) {
      throw new ImportError('seq_conflict', `duplicate card_id ${card.card_id} in the export`, {
        cardIds: [card.card_id],
      });
    }
    seenIds.add(card.card_id);
  }

  const assigned = new Map<number, string>();
  for (const card of cards) {
    if (card.seq === null) {
      continue;
    }
    if (!Number.isInteger(card.seq) || card.seq < 1) {
      throw new ImportError(
        'seq_invalid',
        `card ${card.card_id} has seq ${String(card.seq)}; seq must be a positive integer (no default)`,
        { cardIds: [card.card_id] },
      );
    }
    if (card.seq > total) {
      throw new ImportError(
        'seq_gap',
        `card ${card.card_id} has seq ${card.seq} but there are only ${total} card records; required range is 1..${total}`,
        { cardIds: [card.card_id] },
      );
    }
    const previous = assigned.get(card.seq);
    if (previous !== undefined) {
      throw new ImportError(
        'seq_conflict',
        `seq ${card.seq} is claimed by both ${previous} and ${card.card_id}`,
        { cardIds: [previous, card.card_id] },
      );
    }
    assigned.set(card.seq, card.card_id);
  }

  const free: number[] = [];
  for (let seq = 1; seq <= total; seq += 1) {
    if (!assigned.has(seq)) {
      free.push(seq);
    }
  }

  const rows: SeqRow[] = [];
  let cursor = 0;
  for (const card of cards) {
    if (card.seq !== null) {
      rows.push({ card_id: card.card_id, seq: card.seq, source: 'existing' });
      continue;
    }
    const seq = free[cursor];
    if (seq === undefined) {
      throw new ImportError('seq_gap', `ran out of free seq numbers for card ${card.card_id}`, {
        cardIds: [card.card_id],
      });
    }
    cursor += 1;
    rows.push({ card_id: card.card_id, seq, source: 'backfilled' });
  }

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (current.seq <= previous.seq) {
      throw new ImportError(
        'seq_conflict',
        `seq mapping is not strictly increasing in export order: card ${previous.card_id}=${previous.seq} then ${current.card_id}=${current.seq}; existing seq values conflict with the export order`,
        { cardIds: [previous.card_id, current.card_id] },
      );
    }
  }

  const seqs = rows.map((row) => row.seq);
  const distinct = new Set(seqs).size;
  const nulls = rows.reduce((count, row) => (Number.isInteger(row.seq) ? count : count + 1), 0);
  const min = Math.min(...seqs);
  const max = Math.max(...seqs);
  if (distinct !== total || nulls !== 0 || min !== 1 || max !== total) {
    throw new ImportError(
      'seq_gap',
      `seq backfill validation failed: distinct=${distinct}, nulls=${nulls}, range=${min}..${max}, expected 1..${total}`,
      {},
    );
  }

  // 前面的严格递增校验失败即抛错，走到这里必然单调。
  const monotonic = true;
  return {
    rows,
    summary: { cards: total, distinct, nulls, min, max, monotonic },
  };
}
