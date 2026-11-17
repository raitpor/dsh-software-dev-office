import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fold } from '../../../src/core/fold/index.js';
import { chain, seed } from '../../db/append-helpers.js';

const ISSUED = (n: number, scope = 'domain:core', card = 'CARD-1') =>
  seed(n, 'lease.issued', card, {
    card,
    actor: 'alice',
    scope,
    frontier: 'sha256:f',
    ttl_s: 14400,
    expires_at: '2026-11-17T14:00:00Z',
  });

const REVOKED = (n: number, extra: Record<string, unknown> = {}, actor = 'alice') =>
  seed(n, 'lease.revoked', 'CARD-1', {
    lease_id: 'e-m1-1',
    card_id: 'CARD-1',
    scope: 'domain:core',
    revoked_by: actor,
    ...extra,
  }, { actor });

// M4-2 第 4 轮 P2（reviewer）：网关侧对 scope/status 有校验，但 reducer 的防御层没有 fold 级负例——
// 删掉 reducer 里的 `payload.scope === row.scope` 或 `status === 'active'` 两处守卫，全树仍绿。
// 这两条用例直接构造脏事件，绕开网关只测 fold。
test('M4-2/P2: lease.revoked with a scope that differs from the lease row is rejected by fold', () => {
  assert.throws(
    () => fold(undefined, chain([ISSUED(1), REVOKED(2, { scope: 'domain:other' })])),
    /does not match lease .* scope/,
  );
});

test('M4-2/P2: lease.revoked against a lease that is not active is rejected by fold', () => {
  assert.throws(
    () => fold(undefined, chain([ISSUED(1), REVOKED(2), REVOKED(3)])),
    /only active can be revoked/,
  );
});

test('M4-2/P2: lease.revoked against a lease that does not exist is rejected by fold', () => {
  assert.throws(
    () => fold(undefined, chain([ISSUED(1), REVOKED(2, { lease_id: 'e-missing' })])),
    /does not exist/,
  );
});
