-- M4-1：锁表（docs/07 §13）+ 两个 lock 事件的 event_kind 登记。
-- 活锁互斥由 DB 层保证：path_prefix 主键 + 部分唯一索引（只约束 active 行），
-- 配合 acquire 的 BEGIN IMMEDIATE 事务，并发进程不可能同时写出两条相交活锁。
-- 行保留 release 证据：status/released_at/released_by；lease.revoked 只改 released_by，
-- 不把行变 released（C4：同 actor 可重认领、别的 actor 仍被挡）。
CREATE TABLE lock (
  path_prefix  TEXT PRIMARY KEY,
  card_id      TEXT NOT NULL,
  actor        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active','released')),
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  released_at  TEXT,
  released_by  TEXT,
  CHECK (status = 'active' OR released_at IS NOT NULL),
  CHECK (released_by IS NULL OR released_by IN ('released','lease_revoked'))
);

-- 一个前缀同一时刻只允许一条活锁；released 行不参与唯一性，允许重新认领覆盖。
CREATE UNIQUE INDEX ux_lock_active_prefix ON lock(path_prefix) WHERE status = 'active';

-- event_kind 已在 003 登记过 lock.acquired/lock.released；这里 OR IGNORE 保持幂等并补 note。
INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES
  ('lock.acquired', '2026-11-16', 'M4-1：认领时占前缀；由 fold 投影到 lock'),
  ('lock.released', '2026-11-16', 'M4-1：释放前缀；行保留状态');
