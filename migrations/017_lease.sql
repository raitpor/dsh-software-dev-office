-- M4-2（docs/07 §13）：派发租约。lease.issued 是唯一入口（网关能力 + reducer）；
-- 活租约互斥由 DB 层部分唯一索引保证，claim 必须在网关按 fold 活租约校验。
CREATE TABLE lease (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  scope       TEXT NOT NULL,
  frontier    TEXT NOT NULL,
  ttl_s       INTEGER NOT NULL CHECK (ttl_s > 0),
  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  revoked_at  TEXT,
  revoked_by  TEXT,
  expired_at  TEXT
);

-- 同卡只能有一条活租约（C7：同卡多条活 lease ⇒ 红；回收/重派发先把旧租约置 expired/revoked）。
CREATE UNIQUE INDEX ux_lease_active_card ON lease(card_id) WHERE status = 'active';
CREATE INDEX ix_lease_actor_status ON lease(actor, status);

INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES
  ('lease.issued', 'M4-2', '派发租约（dispatch 唯一入口；网关校验一次性能力）'),
  ('lease.expired', 'M4-2', '租约过期（工具按 expires_at 落；卡回 ready）');
