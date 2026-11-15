-- SDO v2 · 迁移 011：登记 conflicts 视图 + 投影守卫（user_version 10 -> 11）
-- 卡：M3-4。真源：docs/05 §2/§3（视图是数据，查询面只执行 view_catalog.sql）、
-- docs/02 §3（409 冲突，不做自动合并）。D-089 把 conflicts 的登记推给本卡收口；
-- 本迁移让「目录 = 原生视图集合」，并给 renderer_catalog 的投影加库层守卫（P1-3）。
--
-- 1) conflicts（009 建的原生视图）进目录：SQL 与 009 的视图 body 逐字一致，
--    这样 `test/db/migrate.test.ts` 的 body 比对对 14 条都成立。
-- 2) projection_guard：每张“只能由 append 事务内投影写”的表一行 sentinel。
--    物化器在 append 事务里把 active 置 1、提交前复位；非活跃期任何直写（INSERT/
--    UPDATE/DELETE）被触发器 ABORT。renderer.registered 是 ACK 事件，不经过
--    `write-materialize` 的 fold 投影，故由 src/db/renderer.ts 的
--    `applyRendererRegistrations()` 在 append 事务内显式投影（同一哨兵协议）。
--    其它投影表的同缺口见台账 D-095，M4 统一套这套守卫。

INSERT OR IGNORE INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'conflicts',
  'SELECT id, subject, field, base_hash, current_hash, winner_actor, loser_actor,
       winner_value, loser_value, status, resolution_decision_id, resolved_by, resolved_at, at
FROM conflict',
  '[{"name":"id","label":"冲突号","type":"text"},{"name":"subject","label":"对象（表/行 id）","type":"text"},{"name":"field","label":"冲突字段","type":"text"},{"name":"base_hash","label":"失败方基线版本","type":"text"},{"name":"current_hash","label":"胜出方当前版本","type":"text"},{"name":"winner_actor","label":"胜出方","type":"text"},{"name":"loser_actor","label":"失败方","type":"text"},{"name":"winner_value","label":"胜出值","type":"object"},{"name":"loser_value","label":"失败值","type":"object"},{"name":"status","label":"状态（open/resolved）","type":"text"},{"name":"resolution_decision_id","label":"裁决决定 id","type":"text"},{"name":"resolved_by","label":"裁决人","type":"text"},{"name":"resolved_at","label":"裁决时刻","type":"text"},{"name":"at","label":"检测时刻","type":"text"}]',
  '并发写冲突可见面（M3-2）：同一对象同一字段的 409 冲突，一行 = 一次检测；裁决只走人签 decision(kind=sign + conflict_resolution)，本视图只读。',
  'reader',
  200
);

CREATE TABLE IF NOT EXISTS projection_guard (
  name   TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);

INSERT OR IGNORE INTO projection_guard (name, active) VALUES ('renderer_catalog', 0);

CREATE TRIGGER IF NOT EXISTS renderer_catalog_projection_insert
BEFORE INSERT ON renderer_catalog
WHEN (SELECT active FROM projection_guard WHERE name = 'renderer_catalog') IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'renderer_catalog is a projection: write via append');
END;

CREATE TRIGGER IF NOT EXISTS renderer_catalog_projection_update
BEFORE UPDATE ON renderer_catalog
WHEN (SELECT active FROM projection_guard WHERE name = 'renderer_catalog') IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'renderer_catalog is a projection: write via append');
END;

CREATE TRIGGER IF NOT EXISTS renderer_catalog_projection_delete
BEFORE DELETE ON renderer_catalog
WHEN (SELECT active FROM projection_guard WHERE name = 'renderer_catalog') IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'renderer_catalog is a projection: write via append');
END;

PRAGMA user_version = 11;
