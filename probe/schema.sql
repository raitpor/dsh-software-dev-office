-- 可执行性探针用的 DDL 草案（不是最终实现）
-- 目标：验证 docs/ 的设计表能否在 SQLite 上建起来，以及关键约束是否真的拦人（表数以 run.py 输出为准）。
-- 约定：JSON 列用 TEXT；数组用 JSON；跨表一致性尽量用外键，SQLite 表达不了的写进 REPORT.md 的 GAP。

PRAGMA foreign_keys = ON;

-- ---------- 主表（6） ----------
CREATE TABLE intent (
  id            TEXT PRIMARY KEY,
  statement     TEXT NOT NULL,
  owner         TEXT NOT NULL,
  approved_by   TEXT NOT NULL,
  strength      TEXT NOT NULL CHECK (strength IN ('explicit','inferred')),
  baseline_hash TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  at            TEXT NOT NULL
);

CREATE TABLE spec (
  id                    TEXT PRIMARY KEY,
  intent_id             TEXT NOT NULL REFERENCES intent(id),
  clause                TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('requirement','design','contract','impact','assumption')),
  mech_checkable        INTEGER NOT NULL DEFAULT 0 CHECK (mech_checkable IN (0,1)),
  scenario_id           TEXT,
  is_core               INTEGER NOT NULL DEFAULT 0 CHECK (is_core IN (0,1)),
  status                TEXT CHECK (status IS NULL OR status IN ('open','confirmed','rejected','converted')),
  blast_radius          TEXT,
  created_by            TEXT NOT NULL,
  producer              TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  design_artifact_sha256 TEXT,
  code_artifact_sha256   TEXT,
  code_artifact_ref      TEXT,           -- JSON: {snapshot_id, path, design_sha256}
  risk_flags             TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
  at                     TEXT NOT NULL,
  -- 假设条款的完整性：status/blast_radius 与 kind 必须一致（DB 兜底；G1–G5 是缺口编号，G6 是下游 gate id，别混）
  CHECK ((kind = 'assumption') = (status IS NOT NULL)),
  CHECK (kind <> 'assumption' OR (blast_radius IS NOT NULL AND length(blast_radius) > 0))
);

CREATE TABLE goal_node (
  id                     TEXT PRIMARY KEY,
  parent_id              TEXT REFERENCES goal_node(id),
  intent_id              TEXT REFERENCES intent(id),
  goal                   TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('intent','part')),
  acceptance_criterion_id TEXT,
  scope_paths            TEXT NOT NULL DEFAULT '[]',
  at                     TEXT NOT NULL,
  -- 根必须指向 intent；每个 intent 至多一个根（部分唯一索引，见下）
  CHECK (kind <> 'intent' OR intent_id IS NOT NULL)
);

CREATE UNIQUE INDEX ux_goal_root ON goal_node(intent_id) WHERE kind = 'intent';

CREATE TABLE scenario (
  id       TEXT PRIMARY KEY,
  steps    TEXT NOT NULL,
  expected TEXT NOT NULL,
  kind     TEXT NOT NULL
);

CREATE TABLE criterion (
  id           TEXT PRIMARY KEY,
  spec_id      TEXT NOT NULL REFERENCES spec(id),
  kind         TEXT NOT NULL,
  status_enum  TEXT NOT NULL,
  remedy       TEXT NOT NULL CHECK (length(trim(remedy)) > 0),
  UNIQUE (id, spec_id)          -- 供 work_unit 复合外键引用
);

CREATE TABLE evidence (
  id              TEXT PRIMARY KEY,
  criterion_id    TEXT NOT NULL REFERENCES criterion(id),
  artifact_uri    TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  command         TEXT NOT NULL,
  output_digest   TEXT,
  snapshot_id     TEXT REFERENCES snapshot(id),   -- 与 docs/03 同名
  at              TEXT NOT NULL,
  UNIQUE (id, criterion_id)     -- 供 work_unit 复合外键引用
);

CREATE TABLE claim (
  id               TEXT PRIMARY KEY,
  subject          TEXT NOT NULL,
  predicate        TEXT NOT NULL,
  value            TEXT NOT NULL,
  as_of_frontier   TEXT NOT NULL,
  derived_by       TEXT NOT NULL,
  actor            TEXT NOT NULL,
  at               TEXT NOT NULL
);

-- ---------- 辅助表（17） ----------
CREATE TABLE criterion_fixture (
  id              TEXT PRIMARY KEY,
  criterion_id    TEXT NOT NULL REFERENCES criterion(id),
  polarity        TEXT NOT NULL CHECK (polarity IN ('positive','negative')),
  input           TEXT NOT NULL,
  expected_status TEXT NOT NULL CHECK (expected_status IN ('pass','fail','na')),
  -- 同极性可多条；同一输入不许重复
  UNIQUE (criterion_id, polarity, input)
);

CREATE TABLE restatement (
  id                TEXT PRIMARY KEY,
  intent_id         TEXT NOT NULL REFERENCES intent(id),
  draft_specs       TEXT NOT NULL,     -- JSON
  inputs            TEXT NOT NULL,     -- JSON [{kind,id,hash}]
  "by"              TEXT NOT NULL,
  at                TEXT NOT NULL,
  invalid_reason    TEXT,
  accepted_spec_ids TEXT NOT NULL DEFAULT '[]'
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

CREATE TABLE review (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  reviewer          TEXT NOT NULL,
  subject_hash      TEXT NOT NULL,
  subject_producer  TEXT NOT NULL,
  finding           TEXT NOT NULL,
  verified_by       TEXT,
  verdict           TEXT CHECK (verdict IN ('reproduced','refuted')),
  reason            TEXT,
  at                TEXT NOT NULL
);

CREATE TABLE review_round (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  baseline_hash TEXT NOT NULL,
  frontier      TEXT NOT NULL,
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass','changes_requested')),
  signer        TEXT NOT NULL,
  at            TEXT NOT NULL
);

CREATE TABLE receipt (
  id        TEXT PRIMARY KEY,
  claim_ids TEXT NOT NULL,        -- JSON
  renderer  TEXT NOT NULL,
  bytes     INTEGER NOT NULL,
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
  paths      TEXT NOT NULL,       -- JSON
  created_by TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE TABLE design_lock (
  spec_id           TEXT NOT NULL REFERENCES spec(id),
  spec_version_hash TEXT NOT NULL,
  design_sha256     TEXT NOT NULL,
  at                TEXT NOT NULL,
  PRIMARY KEY (spec_id, spec_version_hash)
);

CREATE TABLE redteam (
  id                    TEXT PRIMARY KEY,
  subject_kind          TEXT NOT NULL CHECK (subject_kind IN ('spec','task')),
  subject_id            TEXT NOT NULL,
  criterion_id          TEXT REFERENCES criterion(id),
  criterion_fixture_id  TEXT,
  use_case              TEXT NOT NULL,
  disposition           TEXT NOT NULL CHECK (disposition IN ('accepted','rejected','deferred')),
  at                    TEXT NOT NULL
);

CREATE TABLE work_unit (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  spec_id      TEXT NOT NULL,
  evidence_id  TEXT NOT NULL,
  at           TEXT NOT NULL,
  UNIQUE (task_id),                      -- G4 已定：一卡一行
  -- 两个复合外键：副本不可偏离（docs 的"受约束副本"）
  FOREIGN KEY (criterion_id, spec_id)     REFERENCES criterion (id, spec_id),
  FOREIGN KEY (evidence_id, criterion_id) REFERENCES evidence  (id, criterion_id)
);

CREATE TABLE snapshot (
  id           TEXT PRIMARY KEY,
  git_oid      TEXT NOT NULL UNIQUE,
  external_ref TEXT,
  at           TEXT NOT NULL
);

-- G1 已定：父链用链接表（两个外键都指向 snapshot）
CREATE TABLE snapshot_parent (
  snapshot_id TEXT NOT NULL REFERENCES snapshot(id),
  parent_id   TEXT NOT NULL REFERENCES snapshot(id),
  PRIMARY KEY (snapshot_id, parent_id)
);

CREATE TABLE stage_run (
  id            TEXT PRIMARY KEY,
  stage         TEXT NOT NULL,
  gate_id       TEXT NOT NULL,
  baseline_hash TEXT NOT NULL,
  entered_at    TEXT NOT NULL,
  exited_at     TEXT,
  verdict       TEXT CHECK (verdict IN ('pass','changes_requested','na')),
  criteria      TEXT NOT NULL DEFAULT '[]',  -- JSON 读数
  at            TEXT NOT NULL
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

CREATE TABLE attention (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  question    TEXT NOT NULL,
  options     TEXT NOT NULL DEFAULT '[]',    -- JSON
  answered_by TEXT,
  at          TEXT NOT NULL
);

CREATE TABLE report (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('progress','ready','blocked','failed','dropped')),
  evidence_id TEXT REFERENCES evidence(id),
  note        TEXT,
  at          TEXT NOT NULL
);

-- ---------- 事件（过程真源） ----------
CREATE TABLE event_kind (
  kind  TEXT PRIMARY KEY,
  since TEXT NOT NULL,
  note  TEXT
);

CREATE TABLE event (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL REFERENCES event_kind(kind),
  payload        TEXT NOT NULL,
  frontier       TEXT NOT NULL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL UNIQUE,
  at             TEXT NOT NULL
);
