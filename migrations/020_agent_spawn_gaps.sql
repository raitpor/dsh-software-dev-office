-- SDO v2 · 迁移 020：gaps 接管 M4-7 两类新告警（user_version 19 -> 20）
-- 卡：M4-7（impl-core）。真源：docs/09 §16.5、docs/05 §3 gaps 契约、docs/12 §3。
-- 不改 002（已发布），只重建 gaps 视图并更新 view_catalog 的同一行；
-- 同时登记 M4-7 的告警事件 kind（agent.spawn_streak，ACK，无投影）。
--
-- 两类新 kind：
--   * spawn_streak         —— 同一 actor 连续 3 次新起（事件由 src/db/agent.ts 落），count=连续次数
--   * pick_declined_streak —— 同一 dispatch 出现 >1 条 agent.pick_declined（视图现算），count=declined 条数
-- 三个 event 派生分支共用一个 `alert_events` CTE（event 表只扫一次），
-- 保持 M0-G R1 的结构口径：gaps 的 event 表游标打开次数不随 M4-7 变化（D-193）。
--
-- count 语义（随 kind 变化，读的人别一律当“事件条数”）：
--   query_miss / waiver / redteam_deferred  —— 同 (kind,subject) 的事件出现次数
--   pick_declined_streak                    —— 同一 dispatch 的 agent.pick_declined 条数
--   spawn_streak                            —— 同一 actor 连续新起次数（= 告警事件 payload.count）
-- 等价性证据：test/db/gaps-equivalence.test.ts 在同一批旧来源数据上把 002 的 gaps
-- 原文与当前视图逐行 deepEqual（D-198）。

DROP VIEW gaps;

CREATE VIEW gaps AS
WITH alert_events AS MATERIALIZED (
  SELECT e.kind AS src_kind, e.at AS at, e.payload AS payload
  FROM event e
  WHERE e.kind IN ('query_miss', 'agent.spawn_streak', 'agent.pick_declined')
),
gap_items AS (
  SELECT 'query_miss' AS kind, json_extract(payload, '$.view') AS subject, at AS at, 1 AS n
  FROM alert_events WHERE src_kind = 'query_miss'
  UNION ALL
  SELECT 'spawn_streak' AS kind, json_extract(payload, '$.actor') AS subject, at AS at,
         CAST(json_extract(payload, '$.count') AS INTEGER) AS n
  FROM alert_events WHERE src_kind = 'agent.spawn_streak'
  UNION ALL
  SELECT 'pick_declined_streak' AS kind, json_extract(payload, '$.dispatch_id') AS subject, at AS at, 1 AS n
  FROM alert_events WHERE src_kind = 'agent.pick_declined'
  UNION ALL
  SELECT 'redteam_deferred' AS kind, r.id AS subject, r.at AS at, 1 AS n
  FROM redteam r
  WHERE r.disposition = 'deferred'
  UNION ALL
  SELECT 'waiver' AS kind, COALESCE(json_extract(d.payload, '$.criterion_id'), d.id) AS subject, d.at AS at, 1 AS n
  FROM decision d
  WHERE d.decision_kind = 'waiver' AND d.status = 'valid'
)
SELECT
  kind AS kind,
  subject AS subject,
  CASE WHEN kind = 'spawn_streak' THEN MAX(n) ELSE count(*) END AS count,
  MAX(at) AS last_seen
FROM gap_items
WHERE subject IS NOT NULL
GROUP BY kind, subject
HAVING kind <> 'pick_declined_streak' OR count(*) > 1
ORDER BY count DESC, kind ASC, subject ASC;

UPDATE view_catalog
SET sql = 'WITH alert_events AS MATERIALIZED (
  SELECT e.kind AS src_kind, e.at AS at, e.payload AS payload
  FROM event e
  WHERE e.kind IN (''query_miss'', ''agent.spawn_streak'', ''agent.pick_declined'')
),
gap_items AS (
  SELECT ''query_miss'' AS kind, json_extract(payload, ''$.view'') AS subject, at AS at, 1 AS n
  FROM alert_events WHERE src_kind = ''query_miss''
  UNION ALL
  SELECT ''spawn_streak'' AS kind, json_extract(payload, ''$.actor'') AS subject, at AS at,
         CAST(json_extract(payload, ''$.count'') AS INTEGER) AS n
  FROM alert_events WHERE src_kind = ''agent.spawn_streak''
  UNION ALL
  SELECT ''pick_declined_streak'' AS kind, json_extract(payload, ''$.dispatch_id'') AS subject, at AS at, 1 AS n
  FROM alert_events WHERE src_kind = ''agent.pick_declined''
  UNION ALL
  SELECT ''redteam_deferred'' AS kind, r.id AS subject, r.at AS at, 1 AS n
  FROM redteam r
  WHERE r.disposition = ''deferred''
  UNION ALL
  SELECT ''waiver'' AS kind, COALESCE(json_extract(d.payload, ''$.criterion_id''), d.id) AS subject, d.at AS at, 1 AS n
  FROM decision d
  WHERE d.decision_kind = ''waiver'' AND d.status = ''valid''
)
SELECT
  kind AS kind,
  subject AS subject,
  CASE WHEN kind = ''spawn_streak'' THEN MAX(n) ELSE count(*) END AS count,
  MAX(at) AS last_seen
FROM gap_items
WHERE subject IS NOT NULL
GROUP BY kind, subject
HAVING kind <> ''pick_declined_streak'' OR count(*) > 1
ORDER BY count DESC, kind ASC, subject ASC',
    doc = 'reviewer 的缺口明细：query_miss 聚合、红队 deferred、生效豁免（waiver）、M4-7 的 spawn_streak 与 pick_declined_streak，按 (kind,subject) 聚合。退休候选判据需 caught=0 连续 3 迭代，001 无迭代实体，暂不覆盖（台账 D-007）。'
WHERE name = 'gaps';

INSERT OR IGNORE INTO event_kind (kind, since, note)
VALUES ('agent.spawn_streak', '2026-11-17', 'docs/09 §16.5 判死读数：同一 actor 连续 3 次新起；M4-7 登记');

-- agent.spawned / agent.spawn_streak 是能力事件（网关拒裸 append，unauthorized_agent_event，D-199）。
