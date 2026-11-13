/**
 * R4：`query_miss` 事件经 `gaps` 聚合；生产写入路径不在 M0 ⇒ 部分达标。
 */

import { verify } from '../../lib/src/core/verify.js';
import { query } from '../../lib/src/query/index.js';
import { appendQueryMisses, insertEvents, insertFoldRows, makeChain, withTempDb } from './fixtures.mjs';

/** R4：`query_miss` 事件经 `gaps` 聚合；生产写入路径不在 M0 ⇒ 部分达标。 */
export function measureR4() {
  return withTempDb(({ db }) => {
    insertEvents(db, appendQueryMisses(makeChain(), ['overview', 'overview', 'gaps']));
    insertFoldRows(db, makeChain());

    // 自证夹具合法：先跑一次 verify，证明写进去的 query_miss 事件满足 hash 链与投影一致。
    const verifyReport = verify(db);
    const result = query(db, { view: 'gaps' }, { right: 'reviewer' });
    const rows = result.rows.filter((row) => row.kind === 'query_miss');
    const totalMisses = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);

    const measured = {
      verify: {
        ok: verifyReport.ok,
        eventCount: verifyReport.eventCount,
        problemCount: verifyReport.problems.length,
        codes: verifyReport.problems.map((problem) => problem.code),
      },
      rows,
      totalMisses,
      missing: 'M1 写网关的 query_miss 生产写入路径（D-012）不在 M0；本读数只证明视图侧聚合可用',
    };

    const verdict =
      verifyReport.ok &&
      verifyReport.eventCount === 9 &&
      rows.length === 2 &&
      totalMisses === 3
        ? 'partial'
        : 'fail';
    return { verdict, measured };
  });
}
