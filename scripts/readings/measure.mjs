/**
 * M0-G 四条读数的测量函数（可被脚本与单测复用）。
 * 每个函数只返回 `{ verdict, measured }`，不写报告；报告由 `m0-readings.mjs` 汇总。
 */

import { spawnSync } from 'node:child_process';

import { readAccessLog } from '../../lib/src/db/access-log.js';
import { openEncryptedDatabase } from '../../lib/src/db/driver.js';
import { verify } from '../../lib/src/core/verify.js';
import { query } from '../../lib/src/query/index.js';
import { countEventIndexOpens, countEventOpens, eventAccessCounts, eventRootPage, eventIndexRoots } from './count.mjs';
import {
  PASSPHRASE,
  insertEvents,
  makeChain,
  withTempDb,
} from './fixtures.mjs';

/**
 * M0 时点快照：`view_catalog` 有 13 个视图（2026-11-13）。
 * 以后加视图 → 必须手动更新本常量与这句话，否则 R1 判 fail（不让数字悄悄漂）。
 */
export const M0_VIEW_COUNT = 13;

/** 红证样例：结构上 1 次打开 vs 2 次打开。两者之差必须被计数器看出来。 */
export const RED_SINGLE_SQL = 'SELECT * FROM event';
export const RED_UNION_SQL =
  'SELECT * FROM event UNION ALL SELECT * FROM event';

/** 覆盖索引样例：max(at) 只开索引、不开表。 */
export const COVERING_INDEX_SQL = 'SELECT max(at) FROM event';

/**
 * R1：按字节码分别数每个视图对 `event` 的“表游标打开”与“索引游标打开”。
 * R1 的上界只约束 status 查询（overview）：表开 0、索引开 0。
 * 另用 redProof / mutation 证明计数器会随结构倍数变化。
 */
export function measureR1(db) {
  const counts = (sql) => {
    const { tableOpens, indexOpens } = eventAccessCounts(db, sql);
    return { eventTableOpens: tableOpens, eventIndexOpens: indexOpens };
  };

  const views = db.prepare('SELECT name, sql FROM view_catalog ORDER BY name').all();
  const perView = {};
  for (const view of views) {
    perView[view.name] = counts(`SELECT * FROM (${view.sql})`);
  }

  const mutationBase = views.find((view) => view.name === 'gaps');
  const mutation = mutationBase
    ? {
        view: 'gaps',
        before: counts(`SELECT * FROM (${mutationBase.sql})`),
        after: counts(
          `SELECT * FROM (${mutationBase.sql}) UNION ALL SELECT * FROM (${mutationBase.sql})`,
        ),
        sql: 'SELECT * FROM (<gaps.sql>) UNION ALL SELECT * FROM (<gaps.sql>)',
      }
    : null;

  const measured = {
    viewCount: views.length,
    perView,
    overview: perView.overview,
    redProof: {
      singleSql: RED_SINGLE_SQL,
      single: counts(RED_SINGLE_SQL),
      unionSql: RED_UNION_SQL,
      union: counts(RED_UNION_SQL),
      coveringIndexSql: COVERING_INDEX_SQL,
      coveringIndex: counts(COVERING_INDEX_SQL),
    },
    mutation,
  };

  const verdict =
    views.length === M0_VIEW_COUNT &&
    perView.overview !== undefined &&
    perView.overview.eventTableOpens === 0 &&
    perView.overview.eventIndexOpens === 0 &&
    measured.redProof.single.eventTableOpens === 1 &&
    measured.redProof.union.eventTableOpens === 2 &&
    measured.redProof.coveringIndex.eventTableOpens === 0 &&
    measured.redProof.coveringIndex.eventIndexOpens === 1 &&
    mutation !== null &&
    mutation.after.eventTableOpens === mutation.before.eventTableOpens + 1
      ? 'pass'
      : 'fail';

  return { verdict, measured };
}

function runChild(scriptPath, dbPath, view, right) {
  return spawnSync(process.execPath, [scriptPath, '--r2-child'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SDO_R2_DB: dbPath,
      SDO_R2_PASSPHRASE: PASSPHRASE,
      SDO_R2_VIEW: view,
      SDO_R2_RIGHT: right,
    },
  });
}

/** R2：13 个视图全量——每视图同进程两次 + 两个独立进程各一次，逐字节比较。 */
export function measureR2(db, dbPath, scriptPath) {
  const views = db.prepare('SELECT name, min_right FROM view_catalog ORDER BY name').all();
  const perView = {};
  let allEqual = views.length === M0_VIEW_COUNT;
  let shapesOk = true;
  let excerpt = '';

  for (const view of views) {
    const right = view.min_right;
    const firstResult = query(db, { view: view.name }, { right });
    const secondResult = query(db, { view: view.name }, { right });
    const first = JSON.stringify(firstResult);
    const second = JSON.stringify(secondResult);
    const childA = runChild(scriptPath, dbPath, view.name, right);
    const childB = runChild(scriptPath, dbPath, view.name, right);
    const inProcessEqual = first === second;
    const twoChildrenEqual = childA.status === 0 && childB.status === 0 && childA.stdout === childB.stdout;
    const crossProcessEqual = twoChildrenEqual && childA.stdout === first;

    // 结果形状断言：全 miss 的 13 个视图会相等却无意义，必须逐视图确认
    // view 名匹配且不是 miss 结果。
    const ownShape = firstResult.view === view.name && firstResult.miss === undefined;
    const childShape =
      childA.status === 0 &&
      childB.status === 0 &&
      JSON.parse(childA.stdout).view === view.name &&
      JSON.parse(childA.stdout).miss === undefined && JSON.parse(childB.stdout).miss === undefined;

    if (!inProcessEqual || !crossProcessEqual || !ownShape || !childShape) {
      allEqual = false;
    }
    if (!ownShape || !childShape) shapesOk = false;
    perView[view.name] = {
      inProcessEqual,
      twoChildrenEqual,
      crossProcessEqual,
      ownShape,
      childShape,
      childAExit: childA.status,
      childBExit: childB.status,
    };
    if (view.name === 'overview') {
      excerpt = first.slice(0, 160);
    }
  }

  const measured = { viewCount: views.length, allEqual, shapesOk, perView, excerpt };
  return { verdict: allEqual ? 'pass' : 'fail', measured };
}

/** R3：3 次 query ⇒ 3 行访问记录；改投影/改 hash 由 verify 发现；不写归因。 */
export function measureR3(db, dbPath) {
  for (let index = 0; index < 3; index += 1) {
    query(db, { view: 'overview' });
  }
  const accessLines = readAccessLog(dbPath).length;

  const raw = openEncryptedDatabase(dbPath, PASSPHRASE);
  raw.prepare("UPDATE task SET title = 'tampered' WHERE id = 'TASK-1'").run();
  raw.close();

  const projectionReport = verify(db);
  const projection = projectionReport.problems.find((problem) => problem.code === 'runtime_inconsistent');

  const hashReport = withTempDb(({ db: hashDb }) => {
    const bad = makeChain();
    bad[1] = { ...bad[1], hash: 'sha256:deadbeef' };
    insertEvents(hashDb, bad);
    return verify(hashDb);
  });
  const hash = hashReport.problems.find((problem) => problem.code === 'event_hash_mismatch');

  const measured = {
    accessLines,
    projection: projection
      ? {
          code: projection.code,
          table: projection.table,
          objectId: projection.objectId,
          detail: projection.detail,
        }
      : null,
    hash: hash ? { code: hash.code, objectId: hash.objectId, detail: hash.detail } : null,
  };
  const verdict = accessLines === 3 && projection !== undefined && hash !== undefined ? 'pass' : 'fail';
  return { verdict, measured };
}
