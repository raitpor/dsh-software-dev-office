/** M2-5 测试夹具：一切写入都经 append（唯一写入口）；数据库构建复用 M1-2 的事件种子。 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSdoDatabase } from '../../../src/db/open.js';
import type { SdoDatabase } from '../../../src/db/driver.js';
import type { Session } from '../../../src/core/auth/session.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { seedRights } from '../../db/append-auth.js';
import {
  appendCriterion,
  appendIntent,
  appendRequirement,
  appendSeeds,
  ev,
} from '../../align/helpers.js';

export { appendCriterion, appendIntent, appendRequirement, appendSeeds, ev };

export const PM_PASSPHRASE = 'm2-5-pm-passphrase';

/** PM 测试里会真写事件的 actor（按真实矩阵点状授权，见 `openTempDb`）。 */
const PM_FIXTURE_ACTORS = ['impl-core', 'lead', 'reviewer', 'align-fixture-actor'] as const;

export function eventCount(db: SdoDatabase): number {
  const row = db.prepare('SELECT count(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number };
  return row.n;
}

export function tableCount(db: SdoDatabase, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

export interface TempDb {
  readonly db: SdoDatabase;
  readonly dir: string;
  readonly close: () => void;
}

export function openTempDb(passphrase = PM_PASSPHRASE): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m2-5-pm-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), passphrase);
  runMigrations(db);
  // M3-1：append 现在是鉴权的（D-057/D-097 方式）。PM 测试测业务逻辑，不测授权拒绝；
  // 按真实矩阵点状播种（Lead m06182：优先 `seedRights`，不用大礼包）：
  // M3-1 后动作由 event.kind 映射（`src/core/auth/kind-actions.ts`）：
  // 建卡/提议=plan@domain:core；派发/解阻塞=assign@module:core；
  // 升级=escalate@module:core；撤回=withdraw_attention@module:core；认领=write@module:core。
  // 授权拒绝/矩阵口径由 `test/db/*` 承接，不在这里重复守。
  const grants = PM_FIXTURE_ACTORS.flatMap((actor) => [
    { actor, scope: 'domain:core', right: 'plan' as const },
    { actor, scope: 'module:core', right: 'assign' as const },
    { actor, scope: 'module:core', right: 'escalate' as const },
    { actor, scope: 'module:core', right: 'write' as const },
    { actor, scope: 'domain:core', right: 'read' as const },
    { actor, scope: 'domain:core', right: 'decide' as const },
  ]);
  seedRights(db, grants);
  return {
    db,
    dir,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function pmSession(actor: string): Session {
  return { actor, actor_kind: 'human', session_id: `pm-${actor}`, credential: 'pm-fixture' };
}

export function withPmDb(run: (db: SdoDatabase) => void): void {
  const temp = openTempDb();
  try {
    run(temp.db);
  } finally {
    temp.close();
  }
}

/** 铺最小对齐前置：intent INT-1 → requirement SPEC-1 → criterion CRIT-1（2 正 1 反）。 */
export function seedBase(db: SdoDatabase): void {
  appendIntent(db);
  appendRequirement(db);
  appendCriterion(db, 'CRIT-1', 'SPEC-1');
}
