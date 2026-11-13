-- SDO v2 · 迁移 001：初始 schema（user_version 0 -> 1）
-- 真源：docs/03（25 张表）+ docs/02/04/06/07/09/12 定义的支撑表。
-- 外键开关由连接层负责（src/db/driver.ts 的 openEncryptedDatabase 每连接开 foreign_keys=ON）。
-- 本迁移只建形状与约束，不写业务数据（config 的四个缺省值是 M0-7 的事）。

-- ---------- 身份与授权 ----------
CREATE TABLE decision (
  id            TEXT PRIMARY KEY,
  decision_kind TEXT NOT NULL CHECK (decision_kind IN ('sign','intent','plan','spec_set','assumption_set','freeze','baseline','waiver','rollback')),
  status        TEXT NOT NULL CHECK (status IN ('valid','invalid','revoked')),
  payload       TEXT NOT NULL CHECK (json_valid(payload)),
  payload_hash  TEXT NOT NULL,
  signature     TEXT NOT NULL,
  key_id        TEXT NOT NULL,
  signer        TEXT NOT NULL,
  frontier      TEXT NOT NULL,
  at            TEXT NOT NULL,
  revoked_at    TEXT,
  revoke_reason TEXT
);

-- ---------- 尺子（docs/04 §5.1；append-only，见文末触发器） ----------
CREATE TABLE baseline (
  id                       TEXT PRIMARY KEY,
  frozen_by                TEXT NOT NULL,
  engine_version           TEXT NOT NULL,
  criteria_manifest_hash   TEXT NOT NULL,
  policy                   TEXT NOT NULL CHECK (json_valid(policy)),
  criteria                 TEXT NOT NULL CHECK (json_valid(criteria)),
  gates                    TEXT NOT NULL CHECK (json_valid(gates)),
  thresholds               TEXT NOT NULL CHECK (json_valid(thresholds)),
  assurance                TEXT NOT NULL CHECK (json_valid(assurance)),
  prev                     TEXT REFERENCES baseline(id),
  direction                TEXT CHECK (direction IS NULL OR direction IN ('tighten','loosen')),
  hash                     TEXT NOT NULL UNIQUE,
  at                       TEXT NOT NULL
);

-- ---------- 卡（docs/07 task 行） ----------
CREATE TABLE task (
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
                  'awaiting_signature','verify_failed','dirty_main_tree','redteam_deferred')),
  at           TEXT NOT NULL
);

-- ---------- 主表（docs/03） ----------
CREATE TABLE intent (
  id            TEXT PRIMARY KEY,
  statement     TEXT NOT NULL,      -- 模型摘要
  source_text   TEXT NOT NULL,      -- 用户原话（可脱敏）；approved_by 是 decision.signer 的投影，不存第二份
  owner         TEXT NOT NULL,
  decision_id   TEXT NOT NULL REFERENCES decision(id),
  strength      TEXT NOT NULL CHECK (strength IN ('explicit','inferred')),
  baseline_hash TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  at            TEXT NOT NULL
);

CREATE TABLE snapshot (
  id           TEXT PRIMARY KEY,
  git_oid      TEXT NOT NULL UNIQUE,
  external_ref TEXT,
  at           TEXT NOT NULL
);

CREATE TABLE snapshot_parent (
  snapshot_id TEXT NOT NULL REFERENCES snapshot(id),
  parent_id   TEXT NOT NULL REFERENCES snapshot(id),
  PRIMARY KEY (snapshot_id, parent_id)
);

CREATE TABLE scenario (
  id       TEXT PRIMARY KEY,
  steps    TEXT NOT NULL CHECK (json_valid(steps)),
  expected TEXT NOT NULL CHECK (json_valid(expected)),
  kind     TEXT NOT NULL
);

CREATE TABLE spec (
  id                     TEXT PRIMARY KEY,
  intent_id              TEXT NOT NULL REFERENCES intent(id),
  clause                 TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('requirement','design','contract','impact','assumption')),
  mech_checkable         INTEGER NOT NULL DEFAULT 0 CHECK (mech_checkable IN (0,1)),
  scenario_id            TEXT,
  is_core                INTEGER NOT NULL DEFAULT 0 CHECK (is_core IN (0,1)),
  status                 TEXT CHECK (status IS NULL OR status IN ('open','confirmed','rejected','converted')),
  blast_radius           TEXT,
  created_by             TEXT NOT NULL,
  producer               TEXT NOT NULL,
  content_hash           TEXT NOT NULL,
  design_artifact_sha256 TEXT,
  code_artifact_sha256   TEXT,   -- 派生列：G2 应用层重算，不开放写
  code_artifact_ref      TEXT CHECK (code_artifact_ref IS NULL OR json_valid(code_artifact_ref)),
  risk_flags             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(risk_flags)),
  alternatives           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternatives)),
  no_alternative_reason  TEXT,
  at                     TEXT NOT NULL,
  CHECK ((kind = 'assumption') = (status IS NOT NULL)),
  CHECK (kind <> 'assumption' OR (blast_radius IS NOT NULL AND length(trim(blast_radius)) > 0)),
  CHECK (mech_checkable = 0 OR scenario_id IS NOT NULL)
);

CREATE TABLE criterion (
  id          TEXT PRIMARY KEY,
  spec_id     TEXT NOT NULL REFERENCES spec(id),
  kind        TEXT NOT NULL,
  status_enum TEXT NOT NULL,
  remedy      TEXT NOT NULL CHECK (length(trim(remedy)) > 0),
  UNIQUE (id, spec_id)          -- 供 work_unit 复合外键引用
);

CREATE TABLE criterion_fixture (
  id              TEXT PRIMARY KEY,
  criterion_id    TEXT NOT NULL REFERENCES criterion(id),
  polarity        TEXT NOT NULL CHECK (polarity IN ('positive','negative')),
  input           TEXT NOT NULL,
  expected_status TEXT NOT NULL CHECK (expected_status IN ('pass','fail','na')),
  UNIQUE (criterion_id, polarity, input)
);

CREATE TABLE evidence (
  id              TEXT PRIMARY KEY,
  criterion_id    TEXT NOT NULL REFERENCES criterion(id),
  artifact_uri    TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  command         TEXT NOT NULL,
  output_digest   TEXT,
  snapshot_id     TEXT REFERENCES snapshot(id),
  at              TEXT NOT NULL,
  UNIQUE (id, criterion_id)     -- 供 work_unit 复合外键引用
);

CREATE TABLE design_lock (
  spec_id           TEXT NOT NULL REFERENCES spec(id),
  spec_version_hash TEXT NOT NULL,
  design_sha256     TEXT NOT NULL,
  at                TEXT NOT NULL,
  PRIMARY KEY (spec_id, spec_version_hash)
);

CREATE TABLE redteam (
  id                   TEXT PRIMARY KEY,
  subject_kind         TEXT NOT NULL CHECK (subject_kind IN ('spec','task')),
  subject_id           TEXT NOT NULL,
  criterion_id         TEXT REFERENCES criterion(id),
  criterion_fixture_id TEXT REFERENCES criterion_fixture(id),
  use_case             TEXT NOT NULL,
  disposition          TEXT NOT NULL CHECK (disposition IN ('accepted','rejected','deferred')),
  at                   TEXT NOT NULL
);

CREATE TABLE restatement (
  id                TEXT PRIMARY KEY,
  intent_id         TEXT NOT NULL REFERENCES intent(id),
  draft_specs       TEXT NOT NULL CHECK (json_valid(draft_specs)),
  inputs            TEXT NOT NULL CHECK (json_valid(inputs)),
  "by"              TEXT NOT NULL,
  at                TEXT NOT NULL,
  invalid_reason    TEXT,
  accepted_spec_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(accepted_spec_ids))
);

CREATE TABLE restatement_diff (
  id             TEXT PRIMARY KEY,
  restatement_id TEXT NOT NULL REFERENCES restatement(id),
  kind           TEXT NOT NULL CHECK (kind IN ('agree','missing','extra','conflict')),
  target_ref     TEXT NOT NULL,
  disposition    TEXT NOT NULL CHECK (disposition IN ('accept','reject','defer')),
  reason         TEXT,
  at             TEXT NOT NULL
);

CREATE TABLE claim (
  id             TEXT PRIMARY KEY,
  subject        TEXT NOT NULL,
  predicate      TEXT NOT NULL,
  value          TEXT NOT NULL,
  as_of_frontier TEXT NOT NULL,
  derived_by     TEXT NOT NULL,
  actor          TEXT NOT NULL,
  at             TEXT NOT NULL
);

CREATE TABLE receipt (
  id        TEXT PRIMARY KEY,
  claim_ids TEXT NOT NULL CHECK (json_valid(claim_ids)),
  renderer  TEXT NOT NULL,
  bytes     INTEGER NOT NULL CHECK (bytes >= 0),
  at        TEXT NOT NULL
);

CREATE TABLE field_consumer (
  field         TEXT NOT NULL,
  consumer_kind TEXT NOT NULL CHECK (consumer_kind IN ('view','renderer','criterion')),
  consumer_id   TEXT NOT NULL,
  PRIMARY KEY (field, consumer_kind, consumer_id)
);

CREATE TABLE scope_decl (
  id         TEXT PRIMARY KEY,
  stage      TEXT NOT NULL,
  paths      TEXT NOT NULL CHECK (json_valid(paths)),
  created_by TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE TABLE goal_node (
  id                      TEXT PRIMARY KEY,
  parent_id               TEXT REFERENCES goal_node(id),
  intent_id               TEXT REFERENCES intent(id),
  decision_id             TEXT NOT NULL REFERENCES decision(id),
  goal                    TEXT NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('intent','part')),
  acceptance_criterion_id TEXT REFERENCES criterion(id),
  scope_paths             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scope_paths)),
  at                      TEXT NOT NULL,
  CHECK (kind <> 'intent' OR intent_id IS NOT NULL)
);

CREATE TABLE integration (
  id             TEXT PRIMARY KEY,
  parent_goal_id TEXT NOT NULL REFERENCES goal_node(id),
  child_goal_id  TEXT NOT NULL REFERENCES goal_node(id),
  state          TEXT NOT NULL CHECK (state IN ('connected','pending','dropped')),
  evidence_id    TEXT REFERENCES evidence(id),
  note           TEXT,
  at             TEXT NOT NULL
);

CREATE TABLE work_unit (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id),
  criterion_id TEXT NOT NULL,
  spec_id      TEXT NOT NULL,
  evidence_id  TEXT NOT NULL,
  at           TEXT NOT NULL,
  UNIQUE (task_id),              -- G4：一卡一行
  FOREIGN KEY (criterion_id, spec_id)     REFERENCES criterion (id, spec_id),
  FOREIGN KEY (evidence_id, criterion_id) REFERENCES evidence  (id, criterion_id)
);

CREATE TABLE stage_run (
  id            TEXT PRIMARY KEY,
  stage         TEXT NOT NULL,
  gate_id       TEXT NOT NULL,
  baseline_hash TEXT NOT NULL,
  entered_at    TEXT NOT NULL,
  exited_at     TEXT,
  verdict       TEXT CHECK (verdict IS NULL OR verdict IN ('pass','changes_requested','na')),
  criteria      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criteria)),
  at            TEXT NOT NULL
);

CREATE TABLE attention (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id),
  raised_by    TEXT NOT NULL,
  asked_of     TEXT,
  question     TEXT NOT NULL,
  options      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options)),
  state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','withdrawn')),
  expires_at   TEXT NOT NULL,
  answered_by  TEXT,
  withdrawn_by TEXT CHECK (withdrawn_by IS NULL OR withdrawn_by = raised_by),
  supersedes   TEXT REFERENCES attention(id),
  at           TEXT NOT NULL
);

CREATE TABLE report (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id),
  state       TEXT NOT NULL CHECK (state IN ('progress','ready','blocked','failed','dropped')),
  evidence_id TEXT REFERENCES evidence(id),
  note        TEXT,
  at          TEXT NOT NULL
);

CREATE TABLE review_round (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id),
  baseline_hash TEXT NOT NULL,
  frontier      TEXT NOT NULL,
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass','changes_requested')),
  signer        TEXT NOT NULL,
  at            TEXT NOT NULL
);

CREATE TABLE review (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES task(id),   -- 评审卡 id
  reviewer         TEXT NOT NULL,
  subject_hash     TEXT NOT NULL,
  subject_producer TEXT NOT NULL,
  finding          TEXT NOT NULL,
  verified_by      TEXT,
  verdict          TEXT CHECK (verdict IS NULL OR verdict IN ('reproduced','refuted')),
  reason           TEXT,
  at               TEXT NOT NULL
);

CREATE TABLE verify_run (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','service','agent')),
  actor      TEXT NOT NULL,
  groups     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(groups)),
  result     TEXT NOT NULL CHECK (result IN ('pass','fail')),
  signed_by  TEXT REFERENCES decision(id),
  note       TEXT
);

CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL CHECK (value >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE event_kind (
  kind  TEXT PRIMARY KEY,
  since TEXT NOT NULL,
  note  TEXT
);

-- docs/02 §10 的逻辑信封；probe 的 event 是简化草图（无 actor/subject/caused_by/request_id），以本文档为准
CREATE TABLE event (
  id         TEXT PRIMARY KEY,                 -- e-<actor短id>-<该 actor 内递增>
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  kind       TEXT NOT NULL REFERENCES event_kind(kind),
  subject    TEXT,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  caused_by  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(caused_by)),
  request_id TEXT,
  prev       TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE
);

CREATE TABLE defect (
  id            TEXT PRIMARY KEY,
  criterion_id  TEXT,                         -- 可指向内置判据 code，故不做外键
  spec_id       TEXT REFERENCES spec(id),
  task_id       TEXT REFERENCES task(id),
  kind          TEXT NOT NULL CHECK (kind IN ('criterion','integration','consistency')),
  severity      TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  family        TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  evidence      TEXT,
  verify_run_id TEXT REFERENCES verify_run(id),
  closed_by     TEXT,
  at            TEXT NOT NULL,
  CHECK (status = 'open' OR (verify_run_id IS NOT NULL AND closed_by IS NOT NULL))
);

CREATE TABLE release (
  id             TEXT PRIMARY KEY,
  package_version TEXT,
  status         TEXT NOT NULL CHECK (status IN ('draft','frozen','delivered','rolled_back')),
  frozen_at      TEXT,
  frozen_by      TEXT CHECK (frozen_by IS NULL OR json_valid(frozen_by)),
  frontier       TEXT NOT NULL,
  baseline_hash  TEXT NOT NULL,
  scope_spec_set TEXT NOT NULL,
  note           TEXT,
  CHECK (status = 'draft' OR (frozen_at IS NOT NULL AND frozen_by IS NOT NULL))
);

CREATE TABLE release_item (
  release_id     TEXT NOT NULL REFERENCES release(id),
  kind           TEXT NOT NULL,
  target         TEXT NOT NULL,
  requirement_id TEXT REFERENCES spec(id),
  disposition    TEXT NOT NULL,
  reason         TEXT,
  defer_count    INTEGER NOT NULL DEFAULT 0,
  approved_by    TEXT,
  CHECK (kind IN ('requirement','spec','defect','risk','deprecation')),
  CHECK (disposition IN ('in','out')),
  CHECK (kind = 'requirement' OR requirement_id IS NOT NULL),
  CHECK (disposition <> 'out' OR reason IS NOT NULL),  -- docs/09：out 的 reason 必填是约束，不是注释
  PRIMARY KEY (release_id, kind, target)
);

-- ---------- 索引 ----------
CREATE UNIQUE INDEX ux_goal_root ON goal_node(intent_id) WHERE kind = 'intent';
CREATE INDEX ix_spec_intent ON spec(intent_id);
CREATE INDEX ix_criterion_spec ON criterion(spec_id);
CREATE INDEX ix_evidence_criterion ON evidence(criterion_id);
CREATE INDEX ix_defect_criterion ON defect(criterion_id);
CREATE INDEX ix_defect_status ON defect(status);
CREATE INDEX ix_decision_kind_status ON decision(decision_kind, status);
CREATE INDEX ix_event_kind_at ON event(kind, at);
CREATE INDEX ix_event_subject_at ON event(subject, at);
CREATE INDEX ix_task_status ON task(status);
CREATE INDEX ix_goal_node_parent ON goal_node(parent_id);

-- ---------- 只追加/不可变约束（库层，不靠 TS if） ----------
CREATE TRIGGER trg_event_append_only_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only: UPDATE rejected'); END;

CREATE TRIGGER trg_event_append_only_delete BEFORE DELETE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only: DELETE rejected'); END;

CREATE TRIGGER trg_baseline_append_only_update BEFORE UPDATE ON baseline
BEGIN SELECT RAISE(ABORT, 'baseline is append-only: UPDATE rejected'); END;

CREATE TRIGGER trg_baseline_append_only_delete BEFORE DELETE ON baseline
BEGIN SELECT RAISE(ABORT, 'baseline is append-only: DELETE rejected'); END;

-- 冻结后只允许状态/交付号前进；范围字段（id/尺子/frontier/集合/签字）一律不可改
CREATE TRIGGER trg_release_frozen_immutable BEFORE UPDATE ON release
WHEN OLD.status <> 'draft' AND (
  NEW.id IS NOT OLD.id OR
  NEW.frozen_at IS NOT OLD.frozen_at OR
  NEW.frozen_by IS NOT OLD.frozen_by OR
  NEW.frontier IS NOT OLD.frontier OR
  NEW.baseline_hash IS NOT OLD.baseline_hash OR
  NEW.scope_spec_set IS NOT OLD.scope_spec_set OR
  NEW.note IS NOT OLD.note OR
  (NEW.package_version IS NOT OLD.package_version AND NEW.status IS OLD.status)
)
BEGIN SELECT RAISE(ABORT, 'release is frozen: only status transitions (package_version at delivery)'); END;

CREATE TRIGGER trg_release_no_delete BEFORE DELETE ON release
BEGIN SELECT RAISE(ABORT, 'release rows are never deleted: supersede with a new release'); END;

-- ---------- 评审补强（P1-2 / P2） ----------
-- P1-2 状态迁移：new release 只能从 draft/frozen 起；冻结后不许退回 draft。
CREATE TRIGGER trg_release_insert_status BEFORE INSERT ON release
WHEN NEW.status NOT IN ('draft','frozen')
BEGIN SELECT RAISE(ABORT, 'a release must start as draft or frozen'); END;

CREATE TRIGGER trg_release_status_transition BEFORE UPDATE OF status ON release
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'draft'    AND NEW.status = 'frozen') OR
  (OLD.status = 'frozen'   AND NEW.status IN ('delivered','rolled_back')) OR
  (OLD.status = 'delivered' AND NEW.status = 'rolled_back')
)
BEGIN SELECT RAISE(ABORT, 'invalid release status transition (frozen rows never go back to draft)'); END;

-- P2-1 关闭 defect 只认 result='pass' 的 verify_run（没有 verify 的情形仍由表 CHECK 拦）。
CREATE TRIGGER trg_defect_close_requires_passing_verify_insert BEFORE INSERT ON defect
WHEN NEW.status = 'closed' AND NEW.verify_run_id IS NOT NULL AND NEW.closed_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM verify_run WHERE id = NEW.verify_run_id AND result = 'pass')
BEGIN SELECT RAISE(ABORT, 'defect close requires verify_run.result = pass'); END;

CREATE TRIGGER trg_defect_close_requires_passing_verify_update BEFORE UPDATE ON defect
WHEN NEW.status = 'closed' AND NEW.verify_run_id IS NOT NULL AND NEW.closed_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM verify_run WHERE id = NEW.verify_run_id AND result = 'pass')
BEGIN SELECT RAISE(ABORT, 'defect close requires verify_run.result = pass'); END;

-- P2-2 关闭人必须就是该次复验的 actor（verify_run 存在且 result='pass' 由上面的触发器保证）。
CREATE TRIGGER trg_defect_close_actor_insert BEFORE INSERT ON defect
WHEN NEW.status = 'closed' AND NEW.verify_run_id IS NOT NULL AND NEW.closed_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM verify_run WHERE id = NEW.verify_run_id AND actor = NEW.closed_by)
BEGIN SELECT RAISE(ABORT, 'defect close: closed_by must equal verify_run.actor'); END;

CREATE TRIGGER trg_defect_close_actor_update BEFORE UPDATE ON defect
WHEN NEW.status = 'closed' AND NEW.verify_run_id IS NOT NULL AND NEW.closed_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM verify_run WHERE id = NEW.verify_run_id AND actor = NEW.closed_by)
BEGIN SELECT RAISE(ABORT, 'defect close: closed_by must equal verify_run.actor'); END;

-- P2-3 closed 是终态：重开在设计里没有定义（docs/03 只有 open/closed），库层直接拒。
-- 若要重开，先改设计（新增事件与状态迁移），不是库层放宽。
CREATE TRIGGER trg_defect_closed_terminal BEFORE UPDATE ON defect
WHEN OLD.status = 'closed'
BEGIN SELECT RAISE(ABORT, 'closed defect is terminal: reopening is not defined in the design'); END;
