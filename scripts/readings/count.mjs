/**
 * 计数“一个查询打开 event 表游标的次数”——按字节码数，不按计划文本猜。
 *
 * 口径（M0-G 第 58/59 轮）：分两个数报，不合并成含糊的“次数”。
 *   - eventTableOpens：`OpenRead/OpenWrite` 且 `p2 = event` 表 rootpage；
 *   - eventIndexOpens：`p2` 属于 `event` 的索引 rootpage（`sqlite_master` 里 type='index'
 *     且 tbl_name='event'，含 sqlite_autoindex_*）。
 * 两者是**结构口径**，不是运行期行访问次数；同一访问可能既有索引段又有表段，
 * 所以两者之和不是“访问点个数”。
 *
 * 这是**结构口径**：它数的是“这条 SQL 结构上打开了几次事件表游标”，
 * 与别名/CTE 名无关，也不代表运行期逐行访问次数（相关子查询结构上仍是 1 次打开，
 * 索引覆盖扫描不打开表游标、因此不计入，
 * 运行期可能每行执行一次）。运行期行访问数属 M1 的真实读数（台账 D-023）。
 */

export function eventRootPage(db) {
  const row = db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'event'").get();
  if (!row) {
    throw new Error('event table not found: readings must run after migrations');
  }
  return Number(row.rootpage);
}

function countOpensOn(db, sql, rootPages) {
  const roots = new Set(rootPages.map(Number));
  const bytecode = db.prepare(`EXPLAIN ${sql}`).all();
  return bytecode.filter(
    (row) => (row.opcode === 'OpenRead' || row.opcode === 'OpenWrite') && roots.has(Number(row.p2)),
  ).length;
}

export function eventIndexRoots(db) {
  return db
    .prepare("SELECT rootpage FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event'")
    .all()
    .map((row) => Number(row.rootpage));
}

export function countEventOpens(db, sql, rootPage = eventRootPage(db)) {
  return countOpensOn(db, sql, [rootPage]);
}

export function countEventIndexOpens(db, sql, roots = eventIndexRoots(db)) {
  return countOpensOn(db, sql, roots);
}

export function eventAccessCounts(db, sql) {
  return { tableOpens: countEventOpens(db, sql), indexOpens: countEventIndexOpens(db, sql) };
}
