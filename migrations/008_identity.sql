-- SDO v2 · 迁移 008：actor/scope/right 身份层 + 决策权矩阵目录（user_version 7 -> 8）
-- 卡：M3-0（actor/scope/right 身份层与决策权矩阵机器化）；真源：docs/07 §1/§2、docs/02 §4。
--
-- 三张表：
--   actor  谁（kind ∈ human/agent/service；由会话凭据决定，payload 不能自称）
--   scope  membership + grant（某 actor 在某 scope 持某 right；撤销留痕 revoked_at，不物理删行）
--   right  决策权矩阵目录（docs/07 §2 的机器可读版本；动作 → 所需权/可自签/可双人/是否 boot）
--
-- 矩阵目录是**数据不是代码**：本文件的 26 个动作由 docs/07 §2 的 21 行表格解析而来。
-- 重生成流程（docs/07 表格变动时，必须同步 MATRIX_ACTIONS 与本文件并重跑 M3-0 的机器比对测试）：
--   npm run build
--   node -e "…buildMatrixCatalog(docs/07)…"   # 打印 (action, required, self_sign, dual_human, boot_only, doc_row, doc_label)
--   # 把打印结果替换到下面的 VALUES 段；docs 与目录漂移由 test/db/auth.test.ts 的红用例抓住。
-- 括号只当注释：docs/07 的否定句（如 dependencies 的「不是 write@module」）不参与解析（D-087）。
-- 重跑安全：建表用 IF NOT EXISTS，种子用 INSERT OR IGNORE（迁移只执行一次，保持可重放）。

-- ---------- 谁 ----------
CREATE TABLE IF NOT EXISTS actor (
  id      TEXT PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'service')),
  display TEXT,
  at      TEXT NOT NULL
);

-- ---------- 在某 scope 持某权（membership + grant 合一；只增不减，撤销留痕） ----------
CREATE TABLE IF NOT EXISTS scope (
  actor      TEXT NOT NULL REFERENCES actor(id),
  scope      TEXT NOT NULL CHECK (length(scope) > 0 AND instr(scope, '*') = 0),
  right      TEXT NOT NULL CHECK (length(right) > 0 AND instr(right, '*') = 0),
  granted_by TEXT NOT NULL,
  at         TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (actor, scope, right),
  CHECK (
    scope LIKE 'module:%' OR scope LIKE 'domain:%' OR scope LIKE 'release:%'
  )
);

-- ---------- 决策权矩阵目录（docs/07 §2 机器可读；未登记动作一律 no_permission） ----------
CREATE TABLE IF NOT EXISTS right (
  action     TEXT PRIMARY KEY CHECK (length(action) > 0 AND instr(action, '*') = 0),
  required   TEXT NOT NULL CHECK (json_valid(required)) CHECK (instr(required, '*') = 0),
  self_sign  INTEGER CHECK (self_sign IS NULL OR self_sign IN (0, 1)),
  dual_human TEXT NOT NULL CHECK (dual_human IN ('no', 'configurable', 'independence', 'yes')),
  boot_only  INTEGER NOT NULL CHECK (boot_only IN (0, 1)),
  doc_row    INTEGER NOT NULL,
  doc_label  TEXT NOT NULL,
  at         TEXT NOT NULL
);

-- 播种：docs/07 §2 表格（21 行 → 26 个动作；第 0 行「建卡/认领/阻塞」按分工拆成 claim/block，
-- 第 2 行「建卡（create）」登记为 create，其余动作名见 MATRIX_ACTIONS）。
INSERT OR IGNORE INTO right (action, required, self_sign, dual_human, boot_only, doc_row, doc_label, at) VALUES
  ('claim',            '[{"right":"write","scope":"module"}]',                                          NULL, 'no',           0, 0,  '建卡/认领/阻塞',   '2026-11-15'),
  ('block',            '[{"right":"write","scope":"module"}]',                                          NULL, 'no',           0, 0,  '建卡/认领/阻塞',   '2026-11-15'),
  ('propose_plan',     '[{"right":"plan","scope":"domain"}]',                                           NULL, 'no',           0, 1,  '提议目标/拆解',    '2026-11-15'),
  ('create',           '[{"right":"plan","scope":"domain"}]',                                           NULL, 'no',           0, 2,  '建卡',             '2026-11-15'),
  ('dispatch',         '[{"right":"assign","scope":"scope"}]',                                          NULL, 'no',           0, 3,  '派发/预占/再平衡', '2026-11-15'),
  ('assign',           '[{"right":"assign","scope":"scope"}]',                                          NULL, 'no',           0, 3,  '派发/预占/再平衡', '2026-11-15'),
  ('unassign',         '[{"right":"assign","scope":"scope"}]',                                          NULL, 'no',           0, 3,  '派发/预占/再平衡', '2026-11-15'),
  ('unblock',          '[{"right":"assign","scope":"scope"}]',                                          NULL, 'no',           0, 4,  '解阻塞',           '2026-11-15'),
  ('restate',          '[{"right":"plan","scope":"domain"}]',                                           NULL, 'no',           0, 5,  '复述',             '2026-11-15'),
  ('rework',           '[{"right":"plan","scope":"domain"}]',                                           NULL, 'no',           0, 6,  '建返工卡',         '2026-11-15'),
  ('dependencies',     '[{"right":"plan","scope":"domain"}]',                                   NULL, 'no',           0, 7,  '改依赖',           '2026-11-15'),
  ('escalate',         '[{"right":"escalate","scope":"scope"}]',                                        NULL, 'no',           0, 8,  '升级给人',         '2026-11-15'),
  ('withdraw_attention','[{"right":"escalate","scope":"scope"}]',                                       NULL, 'no',           0, 9,  '撤回自己的提问',   '2026-11-15'),
  ('config',           '[{"right":"admin","scope":"domain"}]',                                          NULL, 'no',           0, 10, '改部署配置',       '2026-11-15'),
  ('config.bootstrap', '[]',                                                                            NULL, 'yes',          1, 11, '初始化部署配置',   '2026-11-15'),
  ('defect.record',    '[{"right":"write","scope":"module"}]',                                          NULL, 'no',           0, 12, '记缺陷',           '2026-11-15'),
  ('defect.close',     '[]',                                                                            NULL, 'no',           0, 13, '关缺陷',           '2026-11-15'),
  ('review',           '[{"right":"review","scope":"module"}]',                                         0,    'no',           0, 14, '评审',             '2026-11-15'),
  ('verify_finding',   '[]',                                                                            0,    'no',           0, 15, '核实发现',         '2026-11-15'),
  ('adopt_review',     '[{"right":"review","scope":"module"}]',                                         0,    'no',           0, 16, '采纳评审',         '2026-11-15'),
  ('freeze',           '[{"right":"decide","scope":"release"},{"right":"sign","scope":"release"}]',     0,    'independence', 0, 17, '冻结版本/豁免',    '2026-11-15'),
  ('waive',            '[{"right":"decide","scope":"release"},{"right":"sign","scope":"release"}]',     0,    'independence', 0, 17, '冻结版本/豁免',    '2026-11-15'),
  ('rollback',         '[{"right":"decide","scope":"release"},{"right":"sign","scope":"release"}]',     0,    'independence', 0, 18, '回滚/作废冻结版',  '2026-11-15'),
  ('amend_intent',     '[{"right":"decide","scope":"domain"},{"right":"sign","scope":"domain"}]',       0,    'configurable', 0, 19, '改意图/改条款',    '2026-11-15'),
  ('amend_clause',     '[{"right":"decide","scope":"domain"},{"right":"sign","scope":"domain"}]',       0,    'configurable', 0, 19, '改意图/改条款',    '2026-11-15'),
  ('revoke_decision',  '[{"right":"admin","scope":"domain"},{"right":"sign","scope":"domain"}]',        0,    'independence', 0, 20, '撤签/撤销决策',    '2026-11-15');
