import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizePrefix, prefixesOverlap, ROOT_PREFIX } from '../../../src/core/lock/prefix.js';

/** M4-1 C6：前缀按路径段规范化；非法前缀 structured `invalid_field`。 */
test('C6: normalizePrefix canonicalizes separators, case, dot segments and trailing slash', () => {
  assert.deepEqual(normalizePrefix('src/core'), { ok: true, prefix: 'src/core' });
  assert.deepEqual(normalizePrefix('./src/core/'), { ok: true, prefix: 'src/core' });
  assert.deepEqual(normalizePrefix('SRC/Core'), { ok: true, prefix: 'src/core' });
  assert.deepEqual(normalizePrefix('src//core'), { ok: true, prefix: 'src/core' });
  assert.deepEqual(normalizePrefix('src\\core'), { ok: true, prefix: 'src/core' });
  assert.deepEqual(normalizePrefix('.'), { ok: true, prefix: ROOT_PREFIX });
});

test('C6: illegal prefixes are rejected as invalid_field (never silently clamped)', () => {
  for (const raw of ['', ' ', '/etc', 'C:/tmp', 'C:\\tmp', '..', '../x', 'src/../../etc', 'a\u0000b']) {
    const result = normalizePrefix(raw);
    assert.equal(result.ok, false, `expected ${JSON.stringify(raw)} to be rejected`);
    if (!result.ok) assert.equal(result.reason_code, 'invalid_field');
  }
  assert.equal(normalizePrefix('a/'.repeat(600)).ok, false);
  assert.equal(normalizePrefix(`a/${'b'.repeat(1024)}`).ok, false);
});

test('C2: overlap is segment-wise, not raw string prefix', () => {
  assert.equal(prefixesOverlap('src/core', 'src/core'), true);
  assert.equal(prefixesOverlap('src/core', 'src/core/ui'), true);
  assert.equal(prefixesOverlap('src/core', 'src/core2'), false);
  assert.equal(prefixesOverlap('src/core', 'src/co'), false);
  assert.equal(prefixesOverlap(ROOT_PREFIX, 'src/core'), true);
});

test('C2: normalized equivalent spellings overlap; lookalikes do not', () => {
  assert.equal(prefixesOverlap('SRC/Core/', './src/core/ui'), true);
  assert.equal(prefixesOverlap('src/core', 'src/core-extra'), false);
});
