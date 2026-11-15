import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { buildMatrixCatalog, type MatrixEntry } from '../../../src/core/auth/matrix.js';
import {
  hasRight,
  isRightName,
  parseScope,
  scopeCovers,
  type GrantView,
} from '../../../src/core/auth/rights.js';

const REPO_ROOT = process.cwd(); // npm test 从仓库根运行
const MATRIX: readonly MatrixEntry[] = buildMatrixCatalog(
  readFileSync(resolve(REPO_ROOT, 'docs/07-协作-权限-并行与子代理.md'), 'utf8'),
);

function grant(right: string, scope: string, actor = 'alice', revoked_at: string | null = null): GrantView {
  return { actor, right, scope, revoked_at };
}

const alice = { id: 'alice', kind: 'human' as const };

test('C5：唯一入口允许——覆盖 scope 的 grant 放行，并返回目录里的自签/双人信息', () => {
  const decision = hasRight(alice, 'defect.record', 'module:src/db/x.ts', {
    matrix: MATRIX,
    grants: [grant('write', 'module:src/db')],
  });
  assert.equal(decision.ok, true, JSON.stringify(decision));
  if (decision.ok) {
    assert.equal(decision.action, 'defect.record');
    assert.deepEqual(decision.required, [{ right: 'write', scope: 'module' }]);
  }

  const freeze = hasRight({ id: 'bob', kind: 'human' }, 'freeze', 'release:1.0.0', {
    matrix: MATRIX,
    grants: [grant('decide', 'release:1.0.0', 'bob'), grant('sign', 'release:1.0.0', 'bob')],
  });
  assert.equal(freeze.ok, true, JSON.stringify(freeze));
  if (freeze.ok) {
    assert.equal(freeze.self_sign, false, '冻结版本不能自签');
    assert.equal(freeze.dual_human, 'independence');
  }
});

for (const scenario of [
  { name: '未登记动作', action: 'not_registered', scope: 'module:src/db', grants: [grant('write', 'module:src')] },
  { name: '未知 scope 前缀', action: 'defect.record', scope: 'foo:bar', grants: [grant('write', 'foo:bar')] },
  { name: '没有任何 grant', action: 'defect.record', scope: 'module:src/db', grants: [] },
  { name: 'grant 已撤销', action: 'defect.record', scope: 'module:src/db', grants: [grant('write', 'module:src', 'alice', '2026-11-15')] },
  { name: 'grant 的 scope 不覆盖目标（同一前缀但非边界）', action: 'defect.record', scope: 'module:src/database', grants: [grant('write', 'module:src/db')] },
  { name: 'grant 的前缀类型不匹配', action: 'defect.record', scope: 'module:src/db', grants: [grant('write', 'domain:src')] },
  { name: '权名不匹配', action: 'defect.record', scope: 'module:src/db', grants: [grant('review', 'module:src')] },
  { name: '别人的 grant 不算数', action: 'defect.record', scope: 'module:src/db', grants: [grant('write', 'module:src', 'mallory')] },
]) {
  test(`C5 fail-closed：${scenario.name} ⇒ no_permission（带 action/scope/actor_kind）`, () => {
    const decision = hasRight(alice, scenario.action, scenario.scope, { matrix: MATRIX, grants: scenario.grants });
    assert.equal(decision.ok, false, `${scenario.name} 必须拒`);
    if (!decision.ok) {
      assert.equal(decision.reason_code, 'no_permission');
      assert.equal(decision.action, scenario.action);
      assert.equal(decision.scope, scenario.scope);
      assert.equal(decision.actor_kind, 'human');
      assert.ok(decision.message.length > 0);
    }
  });
}

for (const scopeText of ['', '*', 'module:*', 'module', 'module:/x', 'module:x/', 'module:src db', 'Module:src']) {
  test(`C6/形状：scope ${JSON.stringify(scopeText)} ⇒ invalid_field`, () => {
    const decision = hasRight(alice, 'defect.record', scopeText, {
      matrix: MATRIX,
      grants: [grant('write', 'module:src')],
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.reason_code, 'invalid_field');
  });
}

test('C6：动作/actor 通配或空 ⇒ invalid_field（无通配授权）', () => {
  for (const action of ['', '*', 'defect.*']) {
    const decision = hasRight(alice, action, 'module:src', { matrix: MATRIX, grants: [] });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.reason_code, 'invalid_field');
  }
  for (const actor of ['', '*']) {
    const decision = hasRight({ id: actor, kind: 'human' }, 'defect.record', 'module:src', { matrix: MATRIX, grants: [] });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.reason_code, 'invalid_field');
  }
});

test('C5：boot 动作只允许 boot 系统 actor（config.bootstrap）', () => {
  const human = hasRight(alice, 'config.bootstrap', 'domain:core', { matrix: MATRIX, grants: [] });
  assert.equal(human.ok, false);
  if (!human.ok) assert.equal(human.reason_code, 'no_permission');

  const migration = hasRight({ id: 'migration', kind: 'service' }, 'config.bootstrap', 'domain:core', {
    matrix: MATRIX,
    grants: [],
  });
  assert.equal(migration.ok, true, JSON.stringify(migration));
});

test('C5：多权动作缺一即拒（freeze 需要 decide@release + sign@release）', () => {
  const onlyDecide = hasRight(alice, 'freeze', 'release:1.0.0', {
    matrix: MATRIX,
    grants: [grant('decide', 'release:1.0.0')],
  });
  assert.equal(onlyDecide.ok, false);
  if (!onlyDecide.ok) {
    assert.equal(onlyDecide.reason_code, 'no_permission');
    assert.equal(onlyDecide.missing_right, 'sign');
  }
  const both = hasRight(alice, 'freeze', 'release:1.0.0', {
    matrix: MATRIX,
    grants: [grant('decide', 'release:1.0.0'), grant('sign', 'release:1.0.0')],
  });
  assert.equal(both.ok, true, JSON.stringify(both));
});

test('P1-1（D-086）：跨前缀一律拒（不猜 module↔domain 归属）', () => {
  // 评审实测场景 1：create 需要 plan@domain，目标是 module:…（grant 在别的 domain 也不行）
  const createOnModule = hasRight(alice, 'create', 'module:src/db', {
    matrix: MATRIX,
    grants: [grant('plan', 'domain:other')],
  });
  assert.equal(createOnModule.ok, false, '跨前缀必须拒');
  if (!createOnModule.ok) {
    assert.equal(createOnModule.reason_code, 'no_permission');
    assert.equal(createOnModule.reason, 'cross_prefix_denied');
  }

  // 评审实测场景 2：write@module 的 grant 不能放行 release 目标
  const writeOnRelease = hasRight(alice, 'defect.record', 'release:1.0.0', {
    matrix: MATRIX,
    grants: [grant('write', 'module:src/db')],
  });
  assert.equal(writeOnRelease.ok, false, '跨前缀必须拒');
  if (!writeOnRelease.ok) assert.equal(writeOnRelease.reason, 'cross_prefix_denied');

  // 同前缀类型但目标是 domain：grant 覆盖 domain 才放行
  const planOnDomain = hasRight(alice, 'create', 'domain:core', {
    matrix: MATRIX,
    grants: [grant('plan', 'domain:core')],
  });
  assert.equal(planOnDomain.ok, true, JSON.stringify(planOnDomain));
});

test('P1-2：dependencies 只要求 plan@domain（文档否定句里的 write@module 不参与解析）', () => {
  const planOnly = MATRIX.find((entry) => entry.action === 'dependencies');
  assert.deepEqual(planOnly?.required, [{ right: 'plan', scope: 'domain' }]);
  const allowed = hasRight(alice, 'dependencies', 'domain:core', {
    matrix: MATRIX,
    grants: [grant('plan', 'domain:core')],
  });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
});

test('scope 覆盖规则：同前缀路径边界；跨前缀不覆盖；parseScope/scopeCovers 一致', () => {
  assert.equal(scopeCovers('module:src/db', 'module:src/db'), true);
  assert.equal(scopeCovers('module:src/db', 'module:src/db/x.ts'), true);
  assert.equal(scopeCovers('module:src/db', 'module:src/database'), false);
  assert.equal(scopeCovers('module:src', 'module:src'), true);
  assert.equal(scopeCovers('module:src', 'domain:src'), false);
  assert.equal(scopeCovers('release:1.0.0', 'release:1.0.0'), true);
  assert.equal(scopeCovers('release:1.0.0', 'release:1.0.1'), false);

  const parsed = parseScope('module:src/db');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { prefix: 'module', path: 'src/db' });
  assert.equal(parseScope('nope:x').ok, false);
});

test('right 名闭集', () => {
  assert.equal(isRightName('decide'), true);
  assert.equal(isRightName('sign'), true);
  assert.equal(isRightName('root'), false);
});
