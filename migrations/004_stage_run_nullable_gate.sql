-- M1-7 C4：stage_run 在 stage.entered 时还没有 gate_id / baseline_hash（判定尚未发生），
-- 001 的 NOT NULL 与折叠口径冲突。按卡里写死的口径改成可空：
--   stage.entered   ⇒ gate_id / baseline_hash 允许为 NULL；
--   gate.judged 后  ⇒ fold 规则强制两者非空（库层不加默认值，不糊过去）。
-- SQLite 不能直接改列约束，按官方姿势重建表。002 有两个视图依赖 stage_run
-- （overview / pm_queue），先摘掉、重建表、再按 002 原文原样装回，保证 sqlite_master
-- 里的视图 SQL 与 view_catalog.sql 逐字一致。

DROP VIEW pm_queue;
DROP VIEW overview;

CREATE TABLE stage_run_new (
  id            TEXT PRIMARY KEY,
  stage         TEXT NOT NULL,
  gate_id       TEXT,
  baseline_hash TEXT,
  entered_at    TEXT NOT NULL,
  exited_at     TEXT,
  verdict       TEXT CHECK (verdict IS NULL OR verdict IN ('pass','changes_requested','na')),
  criteria      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criteria)),
  at            TEXT NOT NULL
);

INSERT INTO stage_run_new (id, stage, gate_id, baseline_hash, entered_at, exited_at, verdict, criteria, at)
  SELECT id, stage, gate_id, baseline_hash, entered_at, exited_at, verdict, criteria, at FROM stage_run;

DROP TABLE stage_run;
ALTER TABLE stage_run_new RENAME TO stage_run;

CREATE VIEW overview AS
SELECT
  COALESCE((SELECT stage FROM stage_run ORDER BY entered_at DESC, id DESC LIMIT 1), 'unset') AS stage,
  (SELECT count(*) FROM task WHERE status = 'in_progress') AS in_flight,
  (SELECT count(*) FROM task WHERE status = 'blocked') AS blocked,
  (SELECT count(*) FROM defect WHERE status = 'open') AS open_defects,
  CASE
    WHEN (SELECT count(*) FROM defect WHERE status = 'open' AND severity = 'high') > 0 THEN 'red'
    WHEN (SELECT verdict FROM stage_run ORDER BY entered_at DESC, id DESC LIMIT 1) = 'changes_requested' THEN 'red'
    WHEN (SELECT count(*) FROM task WHERE status = 'blocked') > 0 THEN 'yellow'
    ELSE 'green'
  END AS health;

CREATE VIEW pm_queue AS
WITH dep_blocked AS (
  SELECT t.id AS id
  FROM task t
  WHERE EXISTS (
    SELECT 1
    FROM json_each(t.blocked_by) dep
    WHERE CASE
      WHEN EXISTS (SELECT 1 FROM task d WHERE d.id = dep.value) THEN
        (SELECT d.status FROM task d WHERE d.id = dep.value) <> 'done'
      WHEN EXISTS (SELECT 1 FROM spec s WHERE s.id = dep.value) THEN
        NOT EXISTS (
          SELECT 1 FROM decision sd, json_each(sd.payload, '$.spec_ids') j
          WHERE sd.decision_kind = 'spec_set' AND sd.status = 'valid' AND j.value = dep.value
        )
      WHEN EXISTS (SELECT 1 FROM goal_node g WHERE g.id = dep.value) THEN
        NOT EXISTS (SELECT 1 FROM claim gc WHERE gc.subject = dep.value AND gc.predicate = 'done' AND gc.value = 'true')
      ELSE 1
    END
  )
)
SELECT 1 AS rank, 'attention' AS kind, a.id AS subject_id,
  COALESCE(t.title, a.question) AS title, 'wait' AS action, 'waiting_human' AS reason_code,
  a.at AS since, t.owner AS owner, t.block_code AS block_code, t.blocked_by AS blocked_by
FROM attention a
JOIN task t ON t.id = a.task_id
WHERE a.state = 'open'
UNION ALL
SELECT 1, 'baseline', e.id,
  '冻结被拒：' || COALESCE(json_extract(e.payload, '$.reason_code'), 'unknown'),
  'escalate', 'waiting_human', e.at, NULL, NULL, '[]'
FROM event e
WHERE e.kind = 'baseline.rejected'
  AND e.at = (SELECT MAX(x.at) FROM event x WHERE x.kind = 'baseline.rejected')
UNION ALL
SELECT 2, 'task', t.id, t.title,
  CASE
    WHEN t.block_code IN ('lease_expired', 'lease_revoked') THEN 'unblock'
    WHEN t.block_code IN ('upstream_changed', 'clause_unjudged') THEN 'rework'
    ELSE 'attention'
  END,
  'blocked',
  COALESCE((SELECT MAX(r.at) FROM report r WHERE r.task_id = t.id), t.at),
  t.owner, t.block_code, t.blocked_by
FROM task t
WHERE t.status = 'blocked'
  AND NOT EXISTS (SELECT 1 FROM attention a2 WHERE a2.task_id = t.id AND a2.state = 'open')
UNION ALL
SELECT 2, 'task', t.id, t.title, 'wait', 'blocked',
  COALESCE((SELECT MAX(r.at) FROM report r WHERE r.task_id = t.id), t.at),
  t.owner, t.block_code, t.blocked_by
FROM task t
WHERE t.status <> 'blocked' AND t.id IN (SELECT id FROM dep_blocked)
UNION ALL
SELECT 3, 'stage_run', sr.id, '阶段判红：' || sr.stage, 'rework', 'gate_red',
  COALESCE(sr.exited_at, sr.entered_at), NULL, NULL, '[]'
FROM stage_run sr
WHERE sr.verdict = 'changes_requested'
UNION ALL
SELECT 4, 'assumption', s.id, s.clause, 'escalate', 'assumption_open',
  s.at, NULL, NULL, '[]'
FROM spec s
WHERE s.kind = 'assumption' AND s.status = 'open'
UNION ALL
SELECT 5, 'task', t.id, t.title, 'dispatch', 'sampled_review',
  t.at, t.owner, t.block_code, t.blocked_by
FROM task t
JOIN (
  SELECT json_extract(policy, '$.review.sample_every') AS sample_every,
         json_extract(policy, '$.review.sample_seed') AS sample_seed
  FROM baseline
  ORDER BY at DESC, id DESC
  LIMIT 1
) p
WHERE t.kind <> 'review'
  AND t.status = 'done'
  AND p.sample_every IS NOT NULL
  AND CAST(p.sample_every AS INTEGER) > 0
  AND ((t.seq - CAST(COALESCE(p.sample_seed, 0) AS INTEGER)) % CAST(p.sample_every AS INTEGER)) = 0
  AND NOT EXISTS (SELECT 1 FROM review_round rr WHERE rr.task_id = t.id)
UNION ALL
SELECT 6, 'task', COALESCE(json_extract(e.payload, '$.change_id'), e.subject),
  '返工未建卡：变更 ' || COALESCE(json_extract(e.payload, '$.change_id'), e.subject),
  'rework', 'rework_pending', e.at, NULL, NULL, '[]'
FROM event e
WHERE e.kind = 'change.applied'
  AND CAST(COALESCE(json_extract(e.payload, '$.rework_units'), 0) AS INTEGER) > 0
  AND NOT EXISTS (
    SELECT 1 FROM task t2, json_each(t2.inputs) j
    WHERE j.value = COALESCE(json_extract(e.payload, '$.change_id'), e.subject)
      AND t2.kind = 'implement'
      AND t2.status IN ('planned', 'ready', 'in_progress', 'blocked')
  )
UNION ALL
SELECT 7, 'task', t.id, t.title, 'dispatch', 'unclaimed',
  t.at, t.owner, t.block_code, t.blocked_by
FROM task t
WHERE t.status = 'ready'
  AND t.id NOT IN (SELECT id FROM dep_blocked)
  AND COALESCE((
    SELECT le.kind FROM event le
    WHERE le.subject = t.id AND le.kind IN ('lease.issued', 'lease.expired', 'lease.revoked')
    ORDER BY le.at DESC, le.id DESC
    LIMIT 1
  ), '') <> 'lease.issued'
ORDER BY 1 ASC, 2 ASC, 3 ASC;
