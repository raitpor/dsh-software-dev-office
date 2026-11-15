-- SDO v2 · 迁移 009：冲突可见（user_version 8 -> 9）
-- 卡：M3-2。真源：docs/02 §3（409 conflict、不做自动合并）、docs/07 §6.1/§11。
-- `conflict` 是真表；行由事件 `conflict.detected` / `conflict.resolved` 投影（见 fold reducer）。
-- `conflicts` 视图是查询面（供 UI/控制台），不是第二份真源。
-- 事件 actor = 失败写入方（便于追责；检测器不额外要权）——卡 M3-2 / D-089。

CREATE TABLE conflict (
  id                     TEXT PRIMARY KEY,
  subject                TEXT NOT NULL,                 -- <table>/<object id>
  field                  TEXT NOT NULL,
  base_hash              TEXT NOT NULL,                 -- 失败方声称基于的版本（M1-5 rowHash 口径）
  current_hash           TEXT NOT NULL,                 -- 胜出方的当前版本
  winner_actor           TEXT NOT NULL,
  loser_actor            TEXT NOT NULL,
  winner_value           TEXT NOT NULL CHECK (json_valid(winner_value)),
  loser_value            TEXT NOT NULL CHECK (json_valid(loser_value)),
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution_decision_id TEXT REFERENCES decision(id),
  resolved_by            TEXT,
  resolved_at            TEXT,
  at                     TEXT NOT NULL
);

CREATE INDEX ix_conflict_subject ON conflict(subject, field);
CREATE INDEX ix_conflict_status ON conflict(status);

CREATE VIEW conflicts AS
SELECT id, subject, field, base_hash, current_hash, winner_actor, loser_actor,
       winner_value, loser_value, status, resolution_decision_id, resolved_by, resolved_at, at
FROM conflict;

-- docs/02 §11：新增事件类型 = 插一行（登记表就是数据）。
INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES
  ('conflict.detected', '2026-11-15', 'M3-2：检测到同一对象同一字段的并发写冲突（actor = 失败写入方）'),
  ('conflict.resolved', '2026-11-15', 'M3-2：人签 decision(kind=sign + conflict_resolution 载荷) 裁决冲突');

PRAGMA user_version = 9;
