import assert from 'node:assert/strict';
import { test } from 'node:test';

// 故意会红的负例：只由 test/negative-sample.test.ts 的子进程调用。
// 它不在 `node --test lib/test/` 的发现范围里（不在 lib/ 下），也不参与 tsc。
test('NEGATIVE FIXTURE: deliberate failure (never green)', () => {
  assert.strictEqual(2 + 2, 5, 'NEGATIVE FIXTURE: 2 + 2 !== 5 (this red is deliberate)');
});
