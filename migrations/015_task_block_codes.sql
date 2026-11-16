-- D-124：docs/07:342/398 要求 block(merge_conflict)/block(dirty_workcopy)，
-- 但 docs/03 §4 的 block_code 枚举漏了这两码。SQLite 不能就地改 CHECK，重建 task 表。
-- 重建依赖 task 的视图（DROP TABLE task 前必须移除；定义与 002/004 最终版逐字一致）。
DROP VIEW IF EXISTS review_queue;
DROP VIEW IF EXISTS board;
DROP VIEW IF EXISTS plan;
DROP VIEW IF EXISTS team;
DROP VIEW IF EXISTS overview;
DROP VIEW IF EXISTS pm_queue;
CREATE TABLE task_new (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('implement','design','review','docs')),
  created_by   TEXT NOT NULL,
  producer     TEXT,
  owner        TEXT,
  status       TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','ready','in_progress','blocked','done','dropped')),
  blocked_by   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blocked_by)),
  scope_paths  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scope_paths)),
  inputs       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(inputs)),
  subject_kind TEXT CHECK (subject_kind IS NULL OR subject_kind IN ('task','spec')),
  subject_id   TEXT,
  block_code   TEXT CHECK (block_code IS NULL OR block_code IN
                 ('lease_expired','lease_revoked','upstream_changed','clause_unjudged',
                  'awaiting_signature','verify_failed','dirty_main_tree','redteam_deferred',
                  'merge_conflict','dirty_workcopy')),
  at           TEXT NOT NULL
);

INSERT INTO task_new (id, seq, title, kind, created_by, producer, owner, status, blocked_by,
                      scope_paths, inputs, subject_kind, subject_id, block_code, at)
SELECT id, seq, title, kind, created_by, producer, owner, status, blocked_by,
       scope_paths, inputs, subject_kind, subject_id, block_code, at
FROM task;

DROP TABLE task;
ALTER TABLE task_new RENAME TO task;
CREATE INDEX ix_task_status ON task(status);

-- 视图重建（002 最终版）
CREATE VIEW review_queue AS
SELECT
  a.id AS item_id,
  a.question AS proposition,
  COALESCE((
    SELECT json_group_array(eid) FROM (
      SELECT DISTINCT r.evidence_id AS eid
      FROM report r
      WHERE r.task_id = a.task_id AND r.evidence_id IS NOT NULL
      ORDER BY r.evidence_id
    )
  ), '[]') AS evidence_refs,
  CASE
    WHEN t.status = 'blocked'
      THEN '阻塞「' || t.title || '」（' || COALESCE(t.block_code, 'unknown') || '）'
    ELSE '待答「' || t.title || '」'
  END AS impact,
  a.options AS options
FROM attention a
JOIN task t ON t.id = a.task_id
WHERE a.state = 'open'
ORDER BY a.expires_at ASC, a.id ASC;

CREATE VIEW board AS
WITH task_events AS (
  SELECT subject AS task_id, kind, at, id,
         ROW_NUMBER() OVER (PARTITION BY subject ORDER BY at DESC, id DESC) AS rn
  FROM event
  WHERE subject IN (SELECT id FROM task)
), task_reports AS (
  SELECT task_id, state, at, id,
         ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY at DESC, id DESC) AS rn
  FROM report
)
SELECT
  t.id AS task_id,
  t.title AS title,
  t.status AS status,
  t.owner AS owner,
  COALESCE(ev.kind, '') AS last_action,
  COALESCE(rep.state, '') AS last_report,
  t.block_code AS block_code
FROM task t
LEFT JOIN task_events ev ON ev.task_id = t.id AND ev.rn = 1
LEFT JOIN task_reports rep ON rep.task_id = t.id AND rep.rn = 1
ORDER BY t.seq ASC;

CREATE VIEW plan AS
SELECT
  t.id AS task_id,
  t.status AS status,
  t.blocked_by AS blocked_by,
  t.scope_paths AS scope
FROM task t
ORDER BY t.seq ASC;

CREATE VIEW team AS
WITH actor_ids AS (
  SELECT signer AS actor_id FROM decision WHERE status = 'valid'
  UNION
  SELECT owner AS actor_id FROM task WHERE owner IS NOT NULL
  UNION
  SELECT created_by AS actor_id FROM task
  UNION
  SELECT producer AS actor_id FROM task WHERE producer IS NOT NULL
  UNION
  SELECT producer AS actor_id FROM spec
  UNION
  SELECT created_by AS actor_id FROM spec
  UNION
  SELECT raised_by AS actor_id FROM attention
  UNION
  SELECT asked_of AS actor_id FROM attention WHERE asked_of IS NOT NULL
), scoped AS (
  SELECT t.owner AS actor_id, je.value AS scope
  FROM task t, json_each(t.scope_paths) je
  WHERE t.owner IS NOT NULL
  UNION
  SELECT t.created_by AS actor_id, je.value AS scope
  FROM task t, json_each(t.scope_paths) je
  UNION
  SELECT sd.created_by AS actor_id, je.value AS scope
  FROM scope_decl sd, json_each(sd.paths) je
), signed_rights AS (
  SELECT signer AS actor_id, decision_kind AS right_kind
  FROM decision WHERE status = 'valid'
)
SELECT
  a.actor_id AS actor_id,
  CASE WHEN EXISTS (SELECT 1 FROM signed_rights r WHERE r.actor_id = a.actor_id) THEN 'human' ELSE 'agent' END AS kind,
  COALESCE((SELECT json_group_array(x.scope) FROM (SELECT DISTINCT s.scope FROM scoped s WHERE s.actor_id = a.actor_id ORDER BY s.scope) x), '[]') AS scopes,
  COALESCE((SELECT json_group_array(y.right_kind) FROM (SELECT DISTINCT r.right_kind FROM signed_rights r WHERE r.actor_id = a.actor_id ORDER BY r.right_kind) y), '[]') AS rights
FROM (SELECT DISTINCT actor_id FROM actor_ids WHERE actor_id IS NOT NULL AND actor_id <> '') a
ORDER BY a.actor_id ASC;

-- 视图重建（004 最终版）
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
