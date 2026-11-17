import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { buildMatrixCatalog, type MatrixEntry } from '../../src/core/auth/matrix.js';
import type { Session } from '../../src/core/auth/session.js';
import { bootstrapEnrollActor, bootstrapGrantRight } from '../../src/db/auth-bootstrap.js';
import {
  authorizeWrite,
  type AuthActorContext,
  enrollActor,
  grantRight,
  hasRight,
  readGrants,
  readMatrix,
} from '../../src/db/auth.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withMigratedDb } from './helpers.js';

const REPO_ROOT = process.cwd(); // npm test 从仓库根运行（与 test/db/baseline-freeze.test.ts 同约定）
const DOCS_07 = resolve(REPO_ROOT, 'docs/07-协作-权限-并行与子代理.md');

const ADMIN: AuthActorContext = { by: { id: 'root', kind: 'human' } };

const ALICE: Session = { actor: 'alice', actor_kind: 'human', session_id: 'sess-alice', credential: 'passkey' };
const AGENT: Session = { actor: 'agent-1', actor_kind: 'agent', session_id: 'sess-agent', credential: 'token' };

function docsCatalog(): readonly MatrixEntry[] {
  return buildMatrixCatalog(readFileSync(DOCS_07, 'utf8'));
}

function byAction(entries: readonly MatrixEntry[]): Map<string, MatrixEntry> {
  return new Map(entries.map((entry) => [entry.action, entry]));
}

test('C1：迁移 008 建三张表，user_version=19（当前链头），二次运行 no-op（幂等）', () => {
  withMigratedDb((db) => {
    assert.equal(db.pragma('user_version', { simple: true }), 19, '当前链头（M4-4 追加 019）');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('actor','scope','right') ORDER BY name")
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map((row) => row.name),
      ['actor', 'right', 'scope'],
    );
    const second = runMigrations(db);
    assert.deepEqual(second.applied, []);
    assert.equal(second.userVersion, 19);
    const count = (name: string): number =>
      (db.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n;
    assert.equal(count('right'), 26, '矩阵目录播种 26 个动作');
    assert.equal(count('actor'), 0, '身份层初始为空');
    assert.equal(count('scope'), 0, '授权初始为空');
  });
});

test('C2：DB 目录与 docs/07 §2 机器解析结果逐动作一致（双向）', () => {
  withMigratedDb((db) => {
    const fromDocs = byAction(docsCatalog());
    const fromDb = byAction(readMatrix(db));
    assert.equal(fromDb.size, fromDocs.size, '动作数量必须一致');
    for (const [action, docEntry] of fromDocs) {
      const dbEntry = fromDb.get(action);
      assert.ok(dbEntry !== undefined, `docs 有动作但目录没登记：${action}`);
      assert.deepEqual(dbEntry.required, docEntry.required, `${action} 所需权漂移`);
      assert.equal(dbEntry.self_sign, docEntry.self_sign, `${action} 可自签漂移`);
      assert.equal(dbEntry.dual_human, docEntry.dual_human, `${action} 可双人漂移`);
      assert.equal(dbEntry.boot_only, docEntry.boot_only, `${action} boot 标记漂移`);
      assert.equal(dbEntry.doc_label, docEntry.doc_label, `${action} 标签漂移`);
    }
    for (const action of fromDb.keys()) {
      assert.ok(fromDocs.has(action), `目录有动作但 docs 没有：${action}`);
    }
  });
});

test('C2：文档新增/删除动作时机器比对会红（检测器非空转）', () => {
  const docs = readFileSync(DOCS_07, 'utf8');
  withMigratedDb((db) => {
    const fromDb = byAction(readMatrix(db));

    assert.throws(
      () => buildMatrixCatalog(docs.replace('| 撤签 / 撤销决策 |', '| 新增动作 | `admin@domain` | 不能 | 否 |\n| 撤签 / 撤销决策 |')),
      /行数|登记/,
      'docs/07 多一行而目录没登记 ⇒ 机器比对必须红（变异红证）',
    );
    assert.throws(
      () =>
        buildMatrixCatalog(
          docs
            .split('\n')
            .filter((line) => !line.includes('| 撤签 / 撤销决策 |'))
            .join('\n'),
        ),
      /行数|登记/,
      'docs/07 少一行而目录仍登记 ⇒ 机器比对必须红（变异红证）',
    );
    assert.ok(fromDb.has('revoke_decision'), '目录里仍有 revoke_decision（上面的红来自文档漂移，不是空转）');
  });
});

test('C1/C6：目录与授权表都不接受通配（DB CHECK + 写入口）', () => {
  withMigratedDb((db) => {
    for (const row of db.prepare('SELECT action FROM right').all() as Array<{ action: string }>) {
      assert.ok(!row.action.includes('*'));
    }
    assert.equal(bootstrapEnrollActor(db, { actor: 'alice', kind: 'human' }).ok, true);
    assert.equal(bootstrapEnrollActor(db, { actor: 'root', kind: 'human' }).ok, true);
    assert.equal(
      bootstrapGrantRight(db, { actor: 'root', right: 'admin', scope: 'domain:core', granted_by: 'migration' }).ok,
      true,
    );
    for (const bad of [
      { actor: 'alice', right: 'write', scope: 'module:*', granted_by: 'seed' },
      { actor: 'alice', right: '*', scope: 'module:src', granted_by: 'seed' },
      { actor: 'alice', right: 'write', scope: '*', granted_by: 'seed' },
    ]) {
      const result = grantRight(db, bad, ADMIN);
      assert.equal(result.ok, false, `授权 ${bad.scope}/${bad.right} 必须被拒`);
      if (!result.ok) assert.equal(result.reason_code, 'invalid_field');
    }
    assert.equal(readGrants(db, 'alice').length, 0);
    assert.throws(
      () => db.prepare("INSERT INTO scope (actor, scope, right, granted_by, at) VALUES ('alice','module:*','write','x','t')").run(),
      /CHECK/,
      'DB 层也挡通配（纵深防御）',
    );
    assert.throws(
      () => db.prepare("INSERT INTO right (action, required, self_sign, dual_human, boot_only, doc_row, doc_label, at) VALUES ('*','[]',NULL,'no',0,99,'x','t')").run(),
      /CHECK/,
      'DB 层拒绝 action 通配',
    );
    assert.throws(
      () => db.prepare("INSERT INTO right (action, required, self_sign, dual_human, boot_only, doc_row, doc_label, at) VALUES ('x-y','[{\"right\":\"*\"}]',NULL,'no',0,99,'x','t')").run(),
      /CHECK/,
      'DB 层拒绝 required 里的通配 right（P2-2）',
    );
    assert.throws(
      () => db.prepare("INSERT INTO right (action, required, self_sign, dual_human, boot_only, doc_row, doc_label, at) VALUES ('x-z','[{\"right\":\"plan\",\"scope\":\"module:*\"}]',NULL,'no',0,99,'x','t')").run(),
      /CHECK/,
      'DB 层拒绝 required 里的通配 scope（第 4 轮 P3-1）',
    );
  });
});

test('C1：登记 actor 与授权幂等；未登记 actor 不能授权；同 id 改 kind ⇒ invalid_field', () => {
  withMigratedDb((db) => {
    assert.equal(bootstrapEnrollActor(db, { actor: 'alice', kind: 'human' }).ok, true);
    assert.equal(bootstrapEnrollActor(db, { actor: 'alice', kind: 'human' }).ok, true);
    const changed = bootstrapEnrollActor(db, { actor: 'alice', kind: 'agent' });
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.reason_code, 'invalid_field');
    assert.equal(bootstrapEnrollActor(db, { actor: '', kind: 'human' }).ok, false);
    assert.equal(bootstrapEnrollActor(db, { actor: 'x', kind: 'robot' as never }).ok, false);

    const unregistered = bootstrapGrantRight(db, { actor: 'ghost', right: 'write', scope: 'module:src', granted_by: 'alice' });
    assert.equal(unregistered.ok, false);
    if (!unregistered.ok) assert.equal(unregistered.reason_code, 'invalid_field');

    assert.equal(
      bootstrapGrantRight(db, { actor: 'alice', right: 'write', scope: 'module:src/db', granted_by: 'alice' }).ok,
      true,
    );
    assert.equal(
      bootstrapGrantRight(db, { actor: 'alice', right: 'write', scope: 'module:src/db', granted_by: 'alice' }).ok,
      true,
      '重复授权幂等',
    );
    assert.equal(readGrants(db, 'alice').length, 1);
  });
});

test('P2-3：身份层自己的写路径也要授权——无调用者/无 admin ⇒ no_permission、0 行；admin 放行', () => {
  withMigratedDb((db) => {
    // 工具层没有 `bootstrap` 参数可传（P2-1）：没有 admin 的调用者只能被拒
    const noCaller = enrollActor(db, { actor: 'eve', kind: 'human' }, { by: { id: 'eve', kind: 'human' } });
    assert.equal(noCaller.ok, false);
    if (!noCaller.ok) assert.equal(noCaller.reason_code, 'no_permission');
    assert.equal((db.prepare('SELECT count(*) AS n FROM actor').get() as { n: number }).n, 0);

    assert.equal(bootstrapEnrollActor(db, { actor: 'root', kind: 'human' }).ok, true);
    assert.equal(
      bootstrapGrantRight(db, { actor: 'root', right: 'admin', scope: 'domain:core', granted_by: 'migration' }).ok,
      true,
    );
    const noAdmin = enrollActor(db, { actor: 'eve', kind: 'human' }, { by: { id: 'nobody', kind: 'human' } });
    assert.equal(noAdmin.ok, false, '没有 admin@domain 的调用者不能登记 actor');
    if (!noAdmin.ok) assert.equal(noAdmin.reason_code, 'no_permission');
    assert.equal((db.prepare("SELECT count(*) AS n FROM actor WHERE id = 'eve'").get() as { n: number }).n, 0);

    assert.equal(enrollActor(db, { actor: 'eve', kind: 'human' }, ADMIN).ok, true, 'admin 放行');
    assert.equal(
      grantRight(db, { actor: 'eve', right: 'write', scope: 'module:src', granted_by: 'root' }, ADMIN).ok,
      true,
    );

    db.prepare("UPDATE scope SET revoked_at = '2026-11-15' WHERE actor = 'root' AND right = 'admin'").run();
    const revokedAdmin = enrollActor(db, { actor: 'mallory', kind: 'human' }, ADMIN);
    assert.equal(revokedAdmin.ok, false, '撤销后的 admin 不再能发权');
  });
});

test('边界：hasRight 只判“权”——defect.close/verify_finding 的允许不等于允许写', () => {
  withMigratedDb((db) => {
    bootstrapEnrollActor(db, { actor: 'nobody', kind: 'human' });
    for (const action of ['defect.close', 'verify_finding']) {
      const decision = hasRight(db, { id: 'nobody', kind: 'human' }, action, 'module:src/db');
      assert.equal(decision.ok, true, `${action} 在 M3-0 里是“无额外权”⇒ 有权`);
      // 但矩阵里没有任何字段能表达“verify_run 通过 / producer 本人”这种对象条件：
      const entry = readMatrix(db).find((row) => row.action === action);
      assert.ok(entry !== undefined);
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['action', 'boot_only', 'doc_label', 'doc_row', 'dual_human', 'required', 'self_sign'],
        '矩阵字段只有“权/可自签/可双人/boot”，没有对象条件列（对象条件在 M3-1 动作实现里）',
      );
      assert.deepEqual(entry.required, [], `${action} 的 required 只是权列表（空）`);
    }
  });
});

test('守卫：bootstrap 入口只许迁移/CLI 与 auth 测试引用', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.[cm]?[jt]s$/.test(name)) continue;
      const relative = resolve(path).slice(REPO_ROOT.length + 1);
      const source = readFileSync(path, 'utf8');
      if (!source.includes('auth-bootstrap')) continue;
      if (relative === 'src/db/auth-bootstrap.ts') continue;
      // append-actions.ts 只是调用点登记表里的一个文件名字符串，不是 import。
      if (relative === 'src/db/append-actions.ts') continue;
      if (relative.startsWith('src/')) {
        offenders.push(`${relative}（产品代码不得 import 内部 bootstrap 入口）`);
        continue;
      }
      // append-auth.ts 是夹具播种入口（M4-4 A2：建库预置授权 / 去重背填），
      // 它不暴露给产品代码；auth.test.ts / right-events.test.ts 之外不允许别的测试自建 bootstrap 种子。
      if (relative.startsWith('test/') && relative !== 'test/db/auth.test.ts' && relative !== 'test/db/helpers.ts' && relative !== 'test/db/append-auth.ts' && relative !== 'test/db/right-events.test.ts') {
        offenders.push(`${relative}（测试里只允许 auth.test.ts / append-auth.ts 使用 bootstrap 种子）`);
      }
    }
  };
  walk(join(REPO_ROOT, 'src'));
  walk(join(REPO_ROOT, 'test'));
  assert.deepEqual(offenders, []);
});

test('C4/C5：write 路径唯一入口 hasRight/authorizeWrite（允许 + 拒绝 + 撤销）', () => {
  withMigratedDb((db) => {
    bootstrapEnrollActor(db, { actor: 'alice', kind: 'human' });
    bootstrapEnrollActor(db, { actor: 'bob', kind: 'human' });
    bootstrapEnrollActor(db, { actor: 'agent-1', kind: 'agent' });
    bootstrapGrantRight(db, { actor: 'alice', right: 'write', scope: 'module:src/db', granted_by: 'alice' });

    const allowed = hasRight(db, { id: 'alice', kind: 'human' }, 'defect.record', 'module:src/db/quote.ts');
    assert.equal(allowed.ok, true, JSON.stringify(allowed));

    const denied = hasRight(db, { id: 'bob', kind: 'human' }, 'defect.record', 'module:src/db/quote.ts');
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason_code, 'no_permission');

    const unscoped = hasRight(db, { id: 'alice', kind: 'human' }, 'defect.record', 'module:src/api/x.ts');
    assert.equal(unscoped.ok, false, 'grant 不覆盖兄弟目录');

    db.prepare("UPDATE scope SET revoked_at = '2026-11-15T00:00:00Z' WHERE actor = 'alice'").run();
    const revoked = hasRight(db, { id: 'alice', kind: 'human' }, 'defect.record', 'module:src/db/quote.ts');
    assert.equal(revoked.ok, false, '撤销后的 grant 不算数（right 只增不减，撤销留痕）');

    assert.equal(
      authorizeWrite(db, AGENT, { action: 'defect.record' }, 'defect.record', 'module:src/db/x.ts').ok,
      false,
      'agent 没有 grant ⇒ 拒',
    );
  });
});

test('C3：authorizeWrite 拒 payload 自称 actor；agent 会话身份不被提权', () => {
  withMigratedDb((db) => {
    bootstrapEnrollActor(db, { actor: 'alice', kind: 'human' });
    bootstrapEnrollActor(db, { actor: 'agent-1', kind: 'agent' });
    bootstrapGrantRight(db, { actor: 'alice', right: 'write', scope: 'module:src/db', granted_by: 'alice' });

    const spoofed = authorizeWrite(db, AGENT, { actor: 'alice' }, 'defect.record', 'module:src/db/x.ts');
    assert.equal(spoofed.ok, false);
    if (!spoofed.ok) assert.equal(spoofed.reason_code, 'actor_not_from_session');

    const viaSession = authorizeWrite(db, ALICE, { note: 'x' }, 'defect.record', 'module:src/db/x.ts');
    assert.equal(viaSession.ok, true, JSON.stringify(viaSession));
    if (viaSession.ok) assert.deepEqual(viaSession.actor, { id: 'alice', kind: 'human' });
  });
});

test('C4：产品代码没有散落的 right 字符串比较（静态扫描）', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith('.ts')) continue;
      const relative = resolve(path).slice(REPO_ROOT.length + 1);
      if (
        relative === 'src/core/auth/rights.ts' ||
        relative === 'src/db/auth.ts' ||
        relative === 'src/db/auth-bootstrap.ts'
      ) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      // 启发式扫描（三种常见写法；不等于形式化证明，口径见卡 C4）：
      //   ① obj['right'] === '…'  ② [..].includes(right)  ③ right !== '…'
      const heuristics = [
        /\[\s*['"]right['"]\s*\]\s*===/,
        /\.includes\(\s*right\s*\)/,
        /\bright\s*!==\s*['"]/,
      ];
      for (const line of source.split('\n')) {
        if (heuristics.some((pattern) => pattern.test(line))) offenders.push(`${relative}: ${line.trim()}`);
      }
    }
  };
  walk(resolve(REPO_ROOT, 'src'));
  assert.deepEqual(offenders, [], `权限判定必须只走 hasRight，不许散落 if (right === …)：\n${offenders.join('\n')}`);
});
