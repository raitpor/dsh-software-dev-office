-- SDO v2 · 迁移 002：13 个视图 + view_catalog（user_version 1 -> 2）
-- 卡：M0-3（impl-surface）。真源：docs/05 §2/§3/§10.1（13 视图、目录自描述、pm_queue 排序）。
-- 约定：
--   * view_catalog 是视图的目录（数据，不是注释）：name/sql/columns/doc/min_right/row_budget。
--   * 每条视图都是 SQLite 原生 CREATE VIEW，body 与 view_catalog.sql 逐字相同（测试比对 sqlite_master）。
--   * 视图 SQL 只读（SELECT），由 src/views/catalog.ts 的 assertSelectOnly 静态校验。
-- 生成方式：本文件由一次性脚本按同一份视图定义同时生成 CREATE VIEW 与 INSERT，避免两处漂移。
--   * 例外：catalog 名 baseline/evidence 与 001 的同名表冲突（SQLite 同 schema 不允许 table/view 同名），
--     原生视图分别落名 baseline_view/evidence_view（查询入口名仍是 catalog.name，见 src/views/catalog.ts nativeViewName 与台账 D-011）。

CREATE TABLE view_catalog (
  name       TEXT PRIMARY KEY,
  sql        TEXT NOT NULL,
  columns    TEXT NOT NULL,
  doc        TEXT NOT NULL,
  min_right  TEXT NOT NULL CHECK (min_right IN ('reader', 'reviewer', 'decider', 'signer')),
  row_budget INTEGER NOT NULL CHECK (row_budget >= 1)
);

-- ---------- 1/13 overview（min_right=reader, row_budget=1）----------
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

-- ---------- 2/13 review_queue（min_right=decider, row_budget=16）----------
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

-- ---------- 3/13 board（min_right=reader, row_budget=200）----------
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

-- ---------- 4/13 plan（min_right=reader, row_budget=200）----------
CREATE VIEW plan AS
SELECT
  t.id AS task_id,
  t.status AS status,
  t.blocked_by AS blocked_by,
  t.scope_paths AS scope
FROM task t
ORDER BY t.seq ASC;

-- ---------- 5/13 evidence（min_right=reader, row_budget=200）----------
CREATE VIEW evidence_view AS
SELECT
  c.id AS claim_id,
  w.criterion_id AS criterion_id,
  e.artifact_sha256 AS artifact_sha256,
  e.at AS at
FROM claim c
JOIN work_unit w ON w.task_id = c.subject
JOIN evidence e ON e.id = w.evidence_id AND e.criterion_id = w.criterion_id
WHERE c.predicate = 'done'
ORDER BY e.at DESC, c.id ASC;

-- ---------- 6/13 defects（min_right=reader, row_budget=200）----------
CREATE VIEW defects AS
SELECT
  d.id AS defect_id,
  d.family AS family,
  d.status AS status,
  d.severity AS severity,
  d.criterion_id AS criterion_id
FROM defect d
ORDER BY d.at DESC, d.id ASC;

-- ---------- 7/13 team（min_right=reader, row_budget=100）----------
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

-- ---------- 8/13 gaps（min_right=reviewer, row_budget=100）----------
CREATE VIEW gaps AS
WITH gap_items AS (
  SELECT 'query_miss' AS kind, json_extract(e.payload, '$.view') AS subject, e.at AS at
  FROM event e
  WHERE e.kind = 'query_miss'
  UNION ALL
  SELECT 'redteam_deferred' AS kind, r.id AS subject, r.at AS at
  FROM redteam r
  WHERE r.disposition = 'deferred'
  UNION ALL
  SELECT 'waiver' AS kind, COALESCE(json_extract(d.payload, '$.criterion_id'), d.id) AS subject, d.at AS at
  FROM decision d
  WHERE d.decision_kind = 'waiver' AND d.status = 'valid'
)
SELECT
  kind AS kind,
  subject AS subject,
  count(*) AS count,
  MAX(at) AS last_seen
FROM gap_items
WHERE subject IS NOT NULL
GROUP BY kind, subject
ORDER BY count DESC, kind ASC, subject ASC;

-- ---------- 9/13 pm_gaps（min_right=reader, row_budget=20）----------
CREATE VIEW pm_gaps AS
WITH gap_items AS (
  SELECT 'query_miss' AS kind, json_extract(e.payload, '$.view') AS subject, e.at AS at
  FROM event e
  WHERE e.kind = 'query_miss'
  UNION ALL
  SELECT 'redteam_deferred' AS kind, r.id AS subject, r.at AS at
  FROM redteam r
  WHERE r.disposition = 'deferred'
  UNION ALL
  SELECT 'waiver' AS kind, COALESCE(json_extract(d.payload, '$.criterion_id'), d.id) AS subject, d.at AS at
  FROM decision d
  WHERE d.decision_kind = 'waiver' AND d.status = 'valid'
)
SELECT
  kind AS kind,
  count(*) AS count,
  MIN(at) AS new_since,
  MAX(at) AS last_seen
FROM gap_items
WHERE subject IS NOT NULL
GROUP BY kind
ORDER BY kind ASC;

-- ---------- 10/13 agents（min_right=reader, row_budget=20）----------
CREATE VIEW agents AS
WITH agent_events AS (
  SELECT e.actor AS actor_id, e.kind AS kind, e.at AS at, e.id AS id,
         ROW_NUMBER() OVER (PARTITION BY e.actor ORDER BY e.at DESC, e.id DESC) AS rn
  FROM event e
  WHERE e.kind LIKE 'agent.%' AND e.actor IS NOT NULL
)
SELECT
  ae.actor_id AS id,
  CASE
    WHEN (SELECT x.kind FROM agent_events x WHERE x.actor_id = ae.actor_id AND x.rn = 1) = 'agent.parked' THEN 'parked'
    WHEN (SELECT x.kind FROM agent_events x WHERE x.actor_id = ae.actor_id AND x.rn = 1) = 'agent.retired' THEN 'dead'
    ELSE 'idle'
  END AS state,
  NULL AS watermark,
  NULL AS snapshot,
  (SELECT count(*) FROM agent_events x WHERE x.actor_id = ae.actor_id AND x.kind = 'agent.reused') AS reuse_count,
  NULL AS parked_reason
FROM agent_events ae
WHERE ae.rn = 1
ORDER BY ae.actor_id ASC;

-- ---------- 11/13 pm_queue（min_right=reader, row_budget=7）----------
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

-- ---------- 12/13 alignment（min_right=reader, row_budget=200）----------
CREATE VIEW alignment AS
SELECT
  s.id AS spec_id,
  s.clause AS title,
  CASE WHEN EXISTS (
    SELECT 1 FROM restatement r, json_each(r.accepted_spec_ids) j
    WHERE j.value = s.id AND r.invalid_reason IS NULL
  ) THEN 1 ELSE 0 END AS restated,
  (SELECT count(*) FROM criterion_fixture f JOIN criterion c ON c.id = f.criterion_id
   WHERE c.spec_id = s.id AND f.polarity = 'positive') AS examples_pos,
  (SELECT count(*) FROM criterion_fixture f JOIN criterion c ON c.id = f.criterion_id
   WHERE c.spec_id = s.id AND f.polarity = 'negative') AS examples_neg,
  (SELECT count(*) FROM spec a
   WHERE a.kind = 'assumption' AND a.status = 'open'
     AND instr(COALESCE(a.blast_radius, ''), s.id) > 0) AS assumptions_open
FROM spec s
WHERE s.kind = 'requirement'
ORDER BY s.id ASC;

-- ---------- 13/13 baseline（min_right=reader, row_budget=1）----------
CREATE VIEW baseline_view AS
SELECT
  b.id AS policy_id,
  json_extract(b.policy, '$.preset') AS preset,
  json_extract(b.policy, '$.stages') AS stages,
  b.gates AS gates,
  json_extract(b.policy, '$.review') AS review,
  b.thresholds AS thresholds,
  json_extract(b.policy, '$.switches') AS switches,
  b.assurance AS assurance,
  json_object('version', b.engine_version, 'criteria_manifest_hash', b.criteria_manifest_hash) AS engine,
  json_extract(b.policy, '$.artifact_kinds') AS artifact_kinds,
  COALESCE((
    SELECT json_group_array(json_object('criterion_id', json_extract(c.value, '$.id'), 'reason', 'applies_to 与 stages.kinds 无交集'))
    FROM json_each(b.criteria) c
    WHERE json_type(c.value, '$.applies_to') = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(c.value, '$.applies_to') ap,
             json_each(b.policy, '$.stages') st,
             json_each(st.value, '$.kinds') sk
        WHERE sk.value = ap.value
      )
  ), '[]') AS na_criteria,
  b.frozen_by AS frozen_by,
  b.at AS frozen_at,
  b.hash AS hash
FROM (
  SELECT id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria,
         gates, thresholds, assurance, at, hash
  FROM baseline
  ORDER BY at DESC, id DESC
  LIMIT 1
) b;

-- ---------- 目录：13 行（sql 列=上面每条 CREATE VIEW 的 body）----------
INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'overview',
  'SELECT
  COALESCE((SELECT stage FROM stage_run ORDER BY entered_at DESC, id DESC LIMIT 1), ''unset'') AS stage,
  (SELECT count(*) FROM task WHERE status = ''in_progress'') AS in_flight,
  (SELECT count(*) FROM task WHERE status = ''blocked'') AS blocked,
  (SELECT count(*) FROM defect WHERE status = ''open'') AS open_defects,
  CASE
    WHEN (SELECT count(*) FROM defect WHERE status = ''open'' AND severity = ''high'') > 0 THEN ''red''
    WHEN (SELECT verdict FROM stage_run ORDER BY entered_at DESC, id DESC LIMIT 1) = ''changes_requested'' THEN ''red''
    WHEN (SELECT count(*) FROM task WHERE status = ''blocked'') > 0 THEN ''yellow''
    ELSE ''green''
  END AS health',
  '[{"name":"stage","label":"当前阶段","type":"text"},{"name":"in_flight","label":"在飞卡数","unit":"张","type":"integer"},{"name":"blocked","label":"阻塞卡数","unit":"张","type":"integer"},{"name":"open_defects","label":"未修缺陷数","unit":"条","type":"integer"},{"name":"health","label":"健康度","type":"text"}]',
  '现在在哪个阶段：最新 stage_run 的阶段、在飞/阻塞卡数、未修缺陷数、健康度（有 open high 缺陷或最新阶段判红=red，有阻塞=yellow，否则 green）。空库时 stage=unset。',
  'reader',
  1
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'review_queue',
  'SELECT
  a.id AS item_id,
  a.question AS proposition,
  COALESCE((
    SELECT json_group_array(eid) FROM (
      SELECT DISTINCT r.evidence_id AS eid
      FROM report r
      WHERE r.task_id = a.task_id AND r.evidence_id IS NOT NULL
      ORDER BY r.evidence_id
    )
  ), ''[]'') AS evidence_refs,
  CASE
    WHEN t.status = ''blocked''
      THEN ''阻塞「'' || t.title || ''」（'' || COALESCE(t.block_code, ''unknown'') || ''）''
    ELSE ''待答「'' || t.title || ''」''
  END AS impact,
  a.options AS options
FROM attention a
JOIN task t ON t.id = a.task_id
WHERE a.state = ''open''
ORDER BY a.expires_at ASC, a.id ASC',
  '[{"name":"item_id","label":"待审项","type":"text"},{"name":"proposition","label":"命题（可反驳的一句话）","type":"text"},{"name":"evidence_refs","label":"证据 id 列表","type":"array"},{"name":"impact","label":"不签的后果","type":"text"},{"name":"options","label":"备选处置","type":"array"}]',
  '待 decider 决策的项：每条未回答 attention 一行，含可反驳命题、可点开的证据 id（该卡 report 里带 evidence 的产物）、不签的后果、备选处置。expires_at 到期由查询层按 as_of 派生 expired 并移出，本视图不取当前时间。',
  'decider',
  16
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'board',
  'WITH task_events AS (
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
  COALESCE(ev.kind, '''') AS last_action,
  COALESCE(rep.state, '''') AS last_report,
  t.block_code AS block_code
FROM task t
LEFT JOIN task_events ev ON ev.task_id = t.id AND ev.rn = 1
LEFT JOIN task_reports rep ON rep.task_id = t.id AND rep.rn = 1
ORDER BY t.seq ASC',
  '[{"name":"task_id","label":"卡号","type":"text"},{"name":"title","label":"标题","type":"text"},{"name":"status","label":"状态","type":"text"},{"name":"owner","label":"负责人","type":"text"},{"name":"last_action","label":"上一步动作","type":"text"},{"name":"last_report","label":"最新报告状态","type":"text"},{"name":"block_code","label":"阻塞原因码","type":"text"}]',
  '每张卡一行：状态、负责人、上一步（该卡最新事件 kind）、最新报告状态、阻塞原因码；最近事件/报告按 at DESC,id DESC 兜底。',
  'reader',
  200
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'plan',
  'SELECT
  t.id AS task_id,
  t.status AS status,
  t.blocked_by AS blocked_by,
  t.scope_paths AS scope
FROM task t
ORDER BY t.seq ASC',
  '[{"name":"task_id","label":"卡号","type":"text"},{"name":"status","label":"状态","type":"text"},{"name":"blocked_by","label":"依赖（task/spec/goal_node id）","type":"array"},{"name":"scope","label":"写域路径","type":"array"}]',
  '待办与依赖：每张卡的 status、blocked_by[]（可指 task/spec/goal_node）、scope_paths[]；行序按 task.seq。',
  'reader',
  200
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'evidence',
  'SELECT
  c.id AS claim_id,
  w.criterion_id AS criterion_id,
  e.artifact_sha256 AS artifact_sha256,
  e.at AS at
FROM claim c
JOIN work_unit w ON w.task_id = c.subject
JOIN evidence e ON e.id = w.evidence_id AND e.criterion_id = w.criterion_id
WHERE c.predicate = ''done''
ORDER BY e.at DESC, c.id ASC',
  '[{"name":"claim_id","label":"声明 id","type":"text"},{"name":"criterion_id","label":"判据 id","type":"text"},{"name":"artifact_sha256","label":"产物指纹","type":"text"},{"name":"at","label":"取证时刻","type":"timestamp"}]',
  '每条 done 声明 → 证据 → 产物指纹：claim(subject=task_id, predicate=done) 经 work_unit 关联 evidence；schema 无 claim→evidence 外键，联结约定见台账 D-008。',
  'reader',
  200
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'defects',
  'SELECT
  d.id AS defect_id,
  d.family AS family,
  d.status AS status,
  d.severity AS severity,
  d.criterion_id AS criterion_id
FROM defect d
ORDER BY d.at DESC, d.id ASC',
  '[{"name":"defect_id","label":"缺陷 id","type":"text"},{"name":"family","label":"复发族","type":"text"},{"name":"status","label":"状态","type":"text"},{"name":"severity","label":"严重度","type":"text"},{"name":"criterion_id","label":"关联判据","type":"text"}]',
  '缺陷分布：family 复发族、open/closed、severity、关联判据；按发现时间倒序。',
  'reader',
  200
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'team',
  'WITH actor_ids AS (
  SELECT signer AS actor_id FROM decision WHERE status = ''valid''
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
  FROM decision WHERE status = ''valid''
)
SELECT
  a.actor_id AS actor_id,
  CASE WHEN EXISTS (SELECT 1 FROM signed_rights r WHERE r.actor_id = a.actor_id) THEN ''human'' ELSE ''agent'' END AS kind,
  COALESCE((SELECT json_group_array(x.scope) FROM (SELECT DISTINCT s.scope FROM scoped s WHERE s.actor_id = a.actor_id ORDER BY s.scope) x), ''[]'') AS scopes,
  COALESCE((SELECT json_group_array(y.right_kind) FROM (SELECT DISTINCT r.right_kind FROM signed_rights r WHERE r.actor_id = a.actor_id ORDER BY r.right_kind) y), ''[]'') AS rights
FROM (SELECT DISTINCT actor_id FROM actor_ids WHERE actor_id IS NOT NULL AND actor_id <> '''') a
ORDER BY a.actor_id ASC',
  '[{"name":"actor_id","label":"参与者","type":"text"},{"name":"kind","label":"类型（human/agent）","type":"text"},{"name":"scopes","label":"可见/可写范围","type":"array"},{"name":"rights","label":"已签决策类型","type":"array"}]',
  '谁在做什么、谁能决策哪个域：actor 来自 decision.signer/task/spec/attention；kind=human 表示有有效签字 decision；scopes=其任务/声明覆盖的路径，rights=其签署过的 decision_kind。actor/right 表（M3/M4）落地前为派生形状，见台账 D-006。',
  'reader',
  100
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'gaps',
  'WITH gap_items AS (
  SELECT ''query_miss'' AS kind, json_extract(e.payload, ''$.view'') AS subject, e.at AS at
  FROM event e
  WHERE e.kind = ''query_miss''
  UNION ALL
  SELECT ''redteam_deferred'' AS kind, r.id AS subject, r.at AS at
  FROM redteam r
  WHERE r.disposition = ''deferred''
  UNION ALL
  SELECT ''waiver'' AS kind, COALESCE(json_extract(d.payload, ''$.criterion_id''), d.id) AS subject, d.at AS at
  FROM decision d
  WHERE d.decision_kind = ''waiver'' AND d.status = ''valid''
)
SELECT
  kind AS kind,
  subject AS subject,
  count(*) AS count,
  MAX(at) AS last_seen
FROM gap_items
WHERE subject IS NOT NULL
GROUP BY kind, subject
ORDER BY count DESC, kind ASC, subject ASC',
  '[{"name":"kind","label":"缺口类型","type":"text"},{"name":"subject","label":"聚合主体","type":"text"},{"name":"count","label":"出现次数","unit":"条","type":"integer"},{"name":"last_seen","label":"最近出现时刻","type":"timestamp"}]',
  'reviewer 的缺口明细：query_miss 聚合、红队 deferred、生效豁免（waiver）按 (kind,subject) 聚合。退休候选判据需 caught=0 连续 3 迭代，001 无迭代实体，暂不覆盖（台账 D-007）。',
  'reviewer',
  100
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'pm_gaps',
  'WITH gap_items AS (
  SELECT ''query_miss'' AS kind, json_extract(e.payload, ''$.view'') AS subject, e.at AS at
  FROM event e
  WHERE e.kind = ''query_miss''
  UNION ALL
  SELECT ''redteam_deferred'' AS kind, r.id AS subject, r.at AS at
  FROM redteam r
  WHERE r.disposition = ''deferred''
  UNION ALL
  SELECT ''waiver'' AS kind, COALESCE(json_extract(d.payload, ''$.criterion_id''), d.id) AS subject, d.at AS at
  FROM decision d
  WHERE d.decision_kind = ''waiver'' AND d.status = ''valid''
)
SELECT
  kind AS kind,
  count(*) AS count,
  MIN(at) AS new_since,
  MAX(at) AS last_seen
FROM gap_items
WHERE subject IS NOT NULL
GROUP BY kind
ORDER BY kind ASC',
  '[{"name":"kind","label":"缺口类型","type":"text"},{"name":"count","label":"未决计数","unit":"条","type":"integer"},{"name":"new_since","label":"最早未决时刻","type":"timestamp"},{"name":"last_seen","label":"最近出现时刻","type":"timestamp"}]',
  'PM 的完成读数：按 kind 汇总未决项计数、最早未决时刻（new_since）、最近出现时刻；明细见 gaps（reviewer）。',
  'reader',
  20
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'agents',
  'WITH agent_events AS (
  SELECT e.actor AS actor_id, e.kind AS kind, e.at AS at, e.id AS id,
         ROW_NUMBER() OVER (PARTITION BY e.actor ORDER BY e.at DESC, e.id DESC) AS rn
  FROM event e
  WHERE e.kind LIKE ''agent.%'' AND e.actor IS NOT NULL
)
SELECT
  ae.actor_id AS id,
  CASE
    WHEN (SELECT x.kind FROM agent_events x WHERE x.actor_id = ae.actor_id AND x.rn = 1) = ''agent.parked'' THEN ''parked''
    WHEN (SELECT x.kind FROM agent_events x WHERE x.actor_id = ae.actor_id AND x.rn = 1) = ''agent.retired'' THEN ''dead''
    ELSE ''idle''
  END AS state,
  NULL AS watermark,
  NULL AS snapshot,
  (SELECT count(*) FROM agent_events x WHERE x.actor_id = ae.actor_id AND x.kind = ''agent.reused'') AS reuse_count,
  NULL AS parked_reason
FROM agent_events ae
WHERE ae.rn = 1
ORDER BY ae.actor_id ASC',
  '[{"name":"id","label":"代理 id","type":"text"},{"name":"state","label":"状态","type":"text"},{"name":"watermark","label":"上下文水位","type":"number"},{"name":"snapshot","label":"绑定快照","type":"text"},{"name":"reuse_count","label":"复用次数","unit":"次","type":"integer"},{"name":"parked_reason","label":"停泊原因","type":"text"}]',
  '代理池：从 agent.* 事件流派生的每 actor 一行（state 取最新事件：parked→parked、retired→dead，其余 idle；reuse_count=agent.reused 次数）。agent 表与事件 payload 字段 M4 才有，watermark/snapshot/parked_reason 暂为 NULL（台账 D-006）。',
  'reader',
  20
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'pm_queue',
  'WITH dep_blocked AS (
  SELECT t.id AS id
  FROM task t
  WHERE EXISTS (
    SELECT 1
    FROM json_each(t.blocked_by) dep
    WHERE CASE
      WHEN EXISTS (SELECT 1 FROM task d WHERE d.id = dep.value) THEN
        (SELECT d.status FROM task d WHERE d.id = dep.value) <> ''done''
      WHEN EXISTS (SELECT 1 FROM spec s WHERE s.id = dep.value) THEN
        NOT EXISTS (
          SELECT 1 FROM decision sd, json_each(sd.payload, ''$.spec_ids'') j
          WHERE sd.decision_kind = ''spec_set'' AND sd.status = ''valid'' AND j.value = dep.value
        )
      WHEN EXISTS (SELECT 1 FROM goal_node g WHERE g.id = dep.value) THEN
        NOT EXISTS (SELECT 1 FROM claim gc WHERE gc.subject = dep.value AND gc.predicate = ''done'' AND gc.value = ''true'')
      ELSE 1
    END
  )
)
SELECT 1 AS rank, ''attention'' AS kind, a.id AS subject_id,
  COALESCE(t.title, a.question) AS title, ''wait'' AS action, ''waiting_human'' AS reason_code,
  a.at AS since, t.owner AS owner, t.block_code AS block_code, t.blocked_by AS blocked_by
FROM attention a
JOIN task t ON t.id = a.task_id
WHERE a.state = ''open''
UNION ALL
SELECT 1, ''baseline'', e.id,
  ''冻结被拒：'' || COALESCE(json_extract(e.payload, ''$.reason_code''), ''unknown''),
  ''escalate'', ''waiting_human'', e.at, NULL, NULL, ''[]''
FROM event e
WHERE e.kind = ''baseline.rejected''
  AND e.at = (SELECT MAX(x.at) FROM event x WHERE x.kind = ''baseline.rejected'')
UNION ALL
SELECT 2, ''task'', t.id, t.title,
  CASE
    WHEN t.block_code IN (''lease_expired'', ''lease_revoked'') THEN ''unblock''
    WHEN t.block_code IN (''upstream_changed'', ''clause_unjudged'') THEN ''rework''
    ELSE ''attention''
  END,
  ''blocked'',
  COALESCE((SELECT MAX(r.at) FROM report r WHERE r.task_id = t.id), t.at),
  t.owner, t.block_code, t.blocked_by
FROM task t
WHERE t.status = ''blocked''
  AND NOT EXISTS (SELECT 1 FROM attention a2 WHERE a2.task_id = t.id AND a2.state = ''open'')
UNION ALL
SELECT 2, ''task'', t.id, t.title, ''wait'', ''blocked'',
  COALESCE((SELECT MAX(r.at) FROM report r WHERE r.task_id = t.id), t.at),
  t.owner, t.block_code, t.blocked_by
FROM task t
WHERE t.status <> ''blocked'' AND t.id IN (SELECT id FROM dep_blocked)
UNION ALL
SELECT 3, ''stage_run'', sr.id, ''阶段判红：'' || sr.stage, ''rework'', ''gate_red'',
  COALESCE(sr.exited_at, sr.entered_at), NULL, NULL, ''[]''
FROM stage_run sr
WHERE sr.verdict = ''changes_requested''
UNION ALL
SELECT 4, ''assumption'', s.id, s.clause, ''escalate'', ''assumption_open'',
  s.at, NULL, NULL, ''[]''
FROM spec s
WHERE s.kind = ''assumption'' AND s.status = ''open''
UNION ALL
SELECT 5, ''task'', t.id, t.title, ''dispatch'', ''sampled_review'',
  t.at, t.owner, t.block_code, t.blocked_by
FROM task t
JOIN (
  SELECT json_extract(policy, ''$.review.sample_every'') AS sample_every,
         json_extract(policy, ''$.review.sample_seed'') AS sample_seed
  FROM baseline
  ORDER BY at DESC, id DESC
  LIMIT 1
) p
WHERE t.kind <> ''review''
  AND t.status = ''done''
  AND p.sample_every IS NOT NULL
  AND CAST(p.sample_every AS INTEGER) > 0
  AND ((t.seq - CAST(COALESCE(p.sample_seed, 0) AS INTEGER)) % CAST(p.sample_every AS INTEGER)) = 0
  AND NOT EXISTS (SELECT 1 FROM review_round rr WHERE rr.task_id = t.id)
UNION ALL
SELECT 6, ''task'', COALESCE(json_extract(e.payload, ''$.change_id''), e.subject),
  ''返工未建卡：变更 '' || COALESCE(json_extract(e.payload, ''$.change_id''), e.subject),
  ''rework'', ''rework_pending'', e.at, NULL, NULL, ''[]''
FROM event e
WHERE e.kind = ''change.applied''
  AND CAST(COALESCE(json_extract(e.payload, ''$.rework_units''), 0) AS INTEGER) > 0
  AND NOT EXISTS (
    SELECT 1 FROM task t2, json_each(t2.inputs) j
    WHERE j.value = COALESCE(json_extract(e.payload, ''$.change_id''), e.subject)
      AND t2.kind = ''implement''
      AND t2.status IN (''planned'', ''ready'', ''in_progress'', ''blocked'')
  )
UNION ALL
SELECT 7, ''task'', t.id, t.title, ''dispatch'', ''unclaimed'',
  t.at, t.owner, t.block_code, t.blocked_by
FROM task t
WHERE t.status = ''ready''
  AND t.id NOT IN (SELECT id FROM dep_blocked)
  AND COALESCE((
    SELECT le.kind FROM event le
    WHERE le.subject = t.id AND le.kind IN (''lease.issued'', ''lease.expired'', ''lease.revoked'')
    ORDER BY le.at DESC, le.id DESC
    LIMIT 1
  ), '''') <> ''lease.issued''
ORDER BY 1 ASC, 2 ASC, 3 ASC',
  '[{"name":"rank","label":"优先级","type":"integer"},{"name":"kind","label":"对象类型","type":"text"},{"name":"subject_id","label":"对象 id","type":"text"},{"name":"title","label":"标题","type":"text"},{"name":"action","label":"建议动作","type":"text"},{"name":"reason_code","label":"原因码","type":"text"},{"name":"since","label":"自何时起","type":"timestamp"},{"name":"owner","label":"负责人","type":"text"},{"name":"block_code","label":"阻塞原因码","type":"text"},{"name":"blocked_by","label":"依赖","type":"array"}]',
  '作为 PM 现在最该做的 ≤7 件事：排序写死 waiting_human(1) > blocked(2) > gate_red(3) > assumption_open(4) > sampled_review(5) > rework_pending(6) > unclaimed(7)，同 rank 内按 kind、subject_id 兜底（不用 since；ORDER BY 1,2,3 = rank,kind,subject_id）。blocked 的 action 按 block_code 现算（lease_expired/lease_revoked→unblock，upstream_changed/clause_unjudged→rework，其余→attention）；依赖等待 action=wait；lease 与 change 表 M4/M1 前分别由 lease.*/change.applied 事件流派生（台账 D-009）。截断/游标在 M0-4，本视图不带 LIMIT。',
  'reader',
  7
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'alignment',
  'SELECT
  s.id AS spec_id,
  s.clause AS title,
  CASE WHEN EXISTS (
    SELECT 1 FROM restatement r, json_each(r.accepted_spec_ids) j
    WHERE j.value = s.id AND r.invalid_reason IS NULL
  ) THEN 1 ELSE 0 END AS restated,
  (SELECT count(*) FROM criterion_fixture f JOIN criterion c ON c.id = f.criterion_id
   WHERE c.spec_id = s.id AND f.polarity = ''positive'') AS examples_pos,
  (SELECT count(*) FROM criterion_fixture f JOIN criterion c ON c.id = f.criterion_id
   WHERE c.spec_id = s.id AND f.polarity = ''negative'') AS examples_neg,
  (SELECT count(*) FROM spec a
   WHERE a.kind = ''assumption'' AND a.status = ''open''
     AND instr(COALESCE(a.blast_radius, ''''), s.id) > 0) AS assumptions_open
FROM spec s
WHERE s.kind = ''requirement''
ORDER BY s.id ASC',
  '[{"name":"spec_id","label":"需求 id","type":"text"},{"name":"title","label":"需求条文","type":"text"},{"name":"restated","label":"已复述","type":"boolean"},{"name":"examples_pos","label":"正例数","unit":"条","type":"integer"},{"name":"examples_neg","label":"反例数","unit":"条","type":"integer"},{"name":"assumptions_open","label":"挡路的 open 假设数","unit":"条","type":"integer"}]',
  '对齐进度：每条 requirement 一行；restated=是否被复述接受（restatement.accepted_spec_ids 且未作废）；examples_pos/neg=判据夹具正/负例数；assumptions_open=blast_radius 文本指向该 spec 的 open 假设数（无结构化外键，见台账 D-010）。',
  'reader',
  200
);

INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget) VALUES (
  'baseline',
  'SELECT
  b.id AS policy_id,
  json_extract(b.policy, ''$.preset'') AS preset,
  json_extract(b.policy, ''$.stages'') AS stages,
  b.gates AS gates,
  json_extract(b.policy, ''$.review'') AS review,
  b.thresholds AS thresholds,
  json_extract(b.policy, ''$.switches'') AS switches,
  b.assurance AS assurance,
  json_object(''version'', b.engine_version, ''criteria_manifest_hash'', b.criteria_manifest_hash) AS engine,
  json_extract(b.policy, ''$.artifact_kinds'') AS artifact_kinds,
  COALESCE((
    SELECT json_group_array(json_object(''criterion_id'', json_extract(c.value, ''$.id''), ''reason'', ''applies_to 与 stages.kinds 无交集''))
    FROM json_each(b.criteria) c
    WHERE json_type(c.value, ''$.applies_to'') = ''array''
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(c.value, ''$.applies_to'') ap,
             json_each(b.policy, ''$.stages'') st,
             json_each(st.value, ''$.kinds'') sk
        WHERE sk.value = ap.value
      )
  ), ''[]'') AS na_criteria,
  b.frozen_by AS frozen_by,
  b.at AS frozen_at,
  b.hash AS hash
FROM (
  SELECT id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria,
         gates, thresholds, assurance, at, hash
  FROM baseline
  ORDER BY at DESC, id DESC
  LIMIT 1
) b',
  '[{"name":"policy_id","label":"基线 id","type":"text"},{"name":"preset","label":"preset","type":"text"},{"name":"stages","label":"阶段与承担 kind","type":"array"},{"name":"gates","label":"gate 绑定","type":"array"},{"name":"review","label":"评审抽样参数","type":"object"},{"name":"thresholds","label":"阈值","type":"object"},{"name":"switches","label":"开关","type":"object"},{"name":"assurance","label":"assurance 档位","type":"object"},{"name":"engine","label":"引擎版本与判据清单 hash","type":"object"},{"name":"artifact_kinds","label":"产物种类","type":"object"},{"name":"na_criteria","label":"本次不适用的判据","type":"array"},{"name":"frozen_by","label":"签署人","type":"text"},{"name":"frozen_at","label":"签署时刻","type":"timestamp"},{"name":"hash","label":"基线 hash","type":"text"}]',
  '现在按哪把尺子判：最新 baseline 的 policy/preset、stages、gates、review 抽样参数、thresholds、switches、assurance、engine 版本、artifact_kinds、na_criteria 及签署人与 hash。na_criteria 由 criteria[].applies_to 与 stages[].kinds 的差集派生（manifest 缺 applies_to 时为空数组，台账 D-011）。',
  'reader',
  1
);

