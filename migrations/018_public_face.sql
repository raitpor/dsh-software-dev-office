-- M4-3 公共面单写者（docs/07 §12；S30 第 4 条；D-177 授权）
-- public_face 是**数据登记**，内容只由迁移写入；刻意不加入 TABLE_NAMES，
-- 因此 append/fold 永远不能物化本表（没有第二条写路）。见卡 M4-3 C1/①。
CREATE TABLE public_face (
  prefix TEXT PRIMARY KEY,
  note   TEXT NOT NULL,
  since  TEXT NOT NULL
);

-- 初始范围按 S30 ④：判据注册面 + 视图目录种子。只登记“公共注册面”，
-- 不把 src/views/** 整体划入（那会把普通视图逻辑也变成公共面）。
-- 迁移播种窗口：打开 projection_guard，播完立即关闭；窗口外任何 SQL 写都被触发器 ABORT。
INSERT OR IGNORE INTO projection_guard (name, active) VALUES ('public_face', 0);
UPDATE projection_guard SET active = 1 WHERE name = 'public_face';
INSERT OR IGNORE INTO public_face (prefix, note, since) VALUES
  ('migrations/002_views.sql', '视图目录 view_catalog 的初始种子（13 视图）', '2026-11-13'),
  ('migrations/003_event_kinds.sql', 'event_kind 登记面（事件类型表的唯一登记入口）', '2026-11-13'),
  ('migrations/004_stage_run_nullable_gate.sql', 'stage_run 重建连带重装 view_catalog 视图 SQL', '2026-11-14'),
  ('migrations/011_view_catalog_conflicts.sql', 'conflicts 视图的 view_catalog 种子', '2026-11-15'),
  ('src/core/criteria/', 'criterion/criterion_fixture 的注册入口（判据目录与注册逻辑）', '2026-11-14'),
  ('src/core/fold/reducers/verify.ts', 'criterion.registered 的投影入口（公共表 criterion 的唯一产出路径）', '2026-11-14');
UPDATE projection_guard SET active = 0 WHERE name = 'public_face';

-- 登记表只读守卫（照 renderer_catalog 的 projection_guard 模式，P3-7）：
-- 窗口外 INSERT/UPDATE/DELETE 一律 ABORT。守卫本身可被同库写者打开（已知边界）。
CREATE TRIGGER public_face_readonly_insert
BEFORE INSERT ON public_face
WHEN (SELECT active FROM projection_guard WHERE name = 'public_face') IS NOT 1
BEGIN SELECT RAISE(ABORT, 'public_face is read-only outside migration'); END;
CREATE TRIGGER public_face_readonly_update
BEFORE UPDATE ON public_face
WHEN (SELECT active FROM projection_guard WHERE name = 'public_face') IS NOT 1
BEGIN SELECT RAISE(ABORT, 'public_face is read-only outside migration'); END;
CREATE TRIGGER public_face_readonly_delete
BEFORE DELETE ON public_face
WHEN (SELECT active FROM projection_guard WHERE name = 'public_face') IS NOT 1
BEGIN SELECT RAISE(ABORT, 'public_face is read-only outside migration'); END;

-- 单写者：当前持有者只有一行；初始持有者由一次性 bootstrap 事件
-- publicface.writer_changed{from:null} 建立（不迁移硬插，避免绕过事件链）。
-- 单行物理约束（P2-3）：固定 id=1，交棒在 fold 里是同一 PK 的 UPDATE（不是删旧插新），
-- 因此不会撞下面的 INSERT 触发器；直插第二行同时被 CHECK(id=1) 与触发器拒绝。
CREATE TABLE public_face_writer (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  actor      TEXT NOT NULL,
  held_since TEXT NOT NULL,
  note       TEXT
);

CREATE TRIGGER public_face_writer_single
BEFORE INSERT ON public_face_writer
WHEN EXISTS (SELECT 1 FROM public_face_writer)
BEGIN SELECT RAISE(ABORT, 'public_face_writer is single-row'); END;

-- docs/02 §11 总表没有 publicface.*：迁移内登记 kind（C1 的“事件登记面”同源）。
INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES
  ('publicface.requested', '2026-11-17', 'M4-3 公共面申请（卡 → 单写者）'),
  ('publicface.executed',  '2026-11-17', 'M4-3 公共面执行（单写者能力路径）'),
  ('publicface.writer_changed', '2026-11-17', 'M4-3 单写者切换（真 reducer，投影 public_face_writer）');
