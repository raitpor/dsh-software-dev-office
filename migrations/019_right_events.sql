-- SDO v2 · 迁移 019：right.granted / right.revoked 事件登记（user_version 18 -> 19）
-- 卡：M4-4（收口 D-113；Lead m04509 A1/A2/A3）。
-- 真源：docs/07 §1（actor ──membership──▶ scope ◀──right── action）、docs/02 §11。
--
-- 本迁移只做一件事：登记两个事件 kind。**不在迁移里伪造事件**（SQL 算不出 hash 链）。
-- 存量 `scope` 行的对齐走一次性维护命令 `sdo-admin backfill-grants`
-- （`src/db/auth-bootstrap.ts` 的 `backfillGrants`，经唯一写入口 `append()` 落事件，幂等）。
-- 背填之前 `verify` 会报 `right_grant_untracked`（诊断，不是破损）；背填后转绿。
--
-- 重跑安全：迁移只执行一次，仍用 INSERT OR IGNORE 保持可重放。

-- scope 表补 revoked_by 列：撤销事件要留“谁撤的”（A1）。ALTER 不可重入，
-- 但迁移只跑一次；新库走 001 建表 + 本 ALTER，老库同样只 ALTER 一次。
ALTER TABLE scope ADD COLUMN revoked_by TEXT;

INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES
  ('right.granted', '2026-11-17', 'M4-4：权限授予事件入口（scope 行的唯一生产者；subject=grantee）');
INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES
  ('right.revoked', '2026-11-17', 'M4-4：权限撤销事件入口（只写 revoked_at/revoked_by，不删行；subject=grantee）');

PRAGMA user_version = 19;
