import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeCursor, encodeCursor, sameCursorArgs, type CursorPayload } from '../../src/query/index.js';

const PAYLOAD: CursorPayload = {
  v: 1,
  args: { view: 'board', limit: 7, select: ['task_id', 'status'] },
  as_of: ['E1', 'E2'],
  offset: 7,
  last_row_hash: '0123456789abcdef0123456789abcdef',
};

function encodeRaw(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function assertRejects(raw: string, pattern: RegExp): void {
  assert.throws(() => decodeCursor(raw), pattern);
}

test('游标 round-trip：编码再解码后参数、快照与边界摘要都一致', () => {
  const decoded = decodeCursor(encodeCursor(PAYLOAD));
  assert.deepEqual(decoded, PAYLOAD);
});

test('游标 fail-closed：非 base64url/JSON、非对象、版本不对都在解码时抛错', () => {
  assertRejects('not-a-cursor', /base64url-encoded JSON/);
  assertRejects(encodeRaw([1, 2]), /must be an object/);
  assertRejects(encodeRaw({ ...PAYLOAD, v: 2 }), /unsupported cursor version/);
});

test('游标 fail-closed：第 54 轮前的旧游标（带 last_row 整行、无 last_row_hash）直接失效', () => {
  const legacy = {
    v: 1,
    args: { view: 'board', limit: 7 },
    as_of: [],
    offset: 7,
    last_row: { task_id: 'T07' },
  };
  assertRejects(encodeRaw(legacy), /last_row_hash must be 32 lowercase hex/);
});

test('游标 fail-closed：as_of 必须是字符串数组', () => {
  assertRejects(encodeRaw({ ...PAYLOAD, as_of: 'E1' }), /as_of must be a string array/);
  assertRejects(encodeRaw({ ...PAYLOAD, as_of: [1] }), /as_of must be a string array/);
});

test('游标 fail-closed：offset 必须是非负整数', () => {
  assertRejects(encodeRaw({ ...PAYLOAD, offset: -1 }), /non-negative integer/);
  assertRejects(encodeRaw({ ...PAYLOAD, offset: 1.5 }), /non-negative integer/);
  assertRejects(encodeRaw({ ...PAYLOAD, offset: '7' }), /non-negative integer/);
});

test('游标 fail-closed：last_row_hash 必须是 32 位小写十六进制（续查边界核对的基础）', () => {
  assertRejects(encodeRaw({ ...PAYLOAD, last_row_hash: undefined }), /last_row_hash must be 32 lowercase hex/);
  assertRejects(encodeRaw({ ...PAYLOAD, last_row_hash: null }), /last_row_hash must be 32 lowercase hex/);
  assertRejects(encodeRaw({ ...PAYLOAD, last_row_hash: 'ABCDEF0123456789abcdef0123456789' }), /last_row_hash must be 32 lowercase hex/);
  assertRejects(encodeRaw({ ...PAYLOAD, last_row_hash: 'abc123' }), /last_row_hash must be 32 lowercase hex/);
  assertRejects(encodeRaw({ ...PAYLOAD, last_row_hash: { task_id: 'T07' } }), /last_row_hash must be 32 lowercase hex/);
});

test('游标 fail-closed：args 的 view/limit/select 形状', () => {
  assertRejects(encodeRaw({ ...PAYLOAD, args: {} }), /args.view must be a non-empty string/);
  assertRejects(encodeRaw({ ...PAYLOAD, args: { view: '', limit: 7 } }), /args.view must be a non-empty string/);
  assertRejects(encodeRaw({ ...PAYLOAD, args: { view: 'board' } }), /args.limit must be a positive integer/);
  assertRejects(encodeRaw({ ...PAYLOAD, args: { view: 'board', limit: 0 } }), /args.limit must be a positive integer/);
  assertRejects(
    encodeRaw({ ...PAYLOAD, args: { view: 'board', limit: 7, select: ['task_id', 1] } }),
    /args.select must be a string array/,
  );
});

test('sameCursorArgs：select 顺序参与比较，limit/view 参与比较', () => {
  assert.equal(
    sameCursorArgs({ view: 'board', limit: 7 }, { view: 'board', limit: 7 }),
    true,
  );
  assert.equal(
    sameCursorArgs({ view: 'board', limit: 7, select: ['a', 'b'] }, { view: 'board', limit: 7, select: ['b', 'a'] }),
    false,
  );
  assert.equal(sameCursorArgs({ view: 'board', limit: 7 }, { view: 'board', limit: 8 }), false);
  assert.equal(sameCursorArgs({ view: 'board', limit: 7 }, { view: 'plan', limit: 7 }), false);
});
