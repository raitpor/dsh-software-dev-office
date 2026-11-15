-- SDO v2 · 迁移 010：渲染器注册目录（user_version 9 -> 10）
-- 卡：M3-4（渲染器注册目录，收口 D-034）。真源：docs/03 §3 `claim.derived_by`、
-- docs/05 §2「视图驱动：新增页面 = 新增视图 + 一个渲染器」。
--
-- 背景：M1-6 用 `src/claim/renderers.ts` 常量表当注册面（D-034 临时办法）。本表是真源：
-- 一行 = 一个渲染器 id → 实现模块 → 可渲染视图。`claim.derived_by` 只认本表里的 id。
--
-- 行的唯一样子（C1）：由 `renderer.registered` 事件投影（`src/db/renderer.ts` 的
-- `rebuildRendererCatalog` 全量重建）；本表不接受第二套登记入口。
--
-- 事件 kind 必须同时出现在 `src/core/fold/ack.ts` 的 ACK 白名单里，否则写网关按
-- `unknown_event_kind` 拒收（与 007 的同口径；该事件只登记配置，不投影 fold 表）。
-- 重跑安全：建表 IF NOT EXISTS，种子 INSERT OR IGNORE。

CREATE TABLE IF NOT EXISTS renderer_catalog (
  id          TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, '*') = 0),
  module_path TEXT NOT NULL CHECK (length(module_path) > 0),
  -- JSON 数组文本（视图名）；CHECK 只保证形状，名字存在性由登记时的 view_catalog 校验（C1/C3）。
  views       TEXT NOT NULL CHECK (json_valid(views) AND json_type(views) = 'array'),
  at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_renderer_catalog_at ON renderer_catalog (at);

INSERT OR IGNORE INTO event_kind (kind, since, note)
VALUES ('renderer.registered', '2026-11-15', '渲染器注册（M3-4）：目录行由该事件投影；ACK，无 fold 投影');

-- 内置渲染器：v1 结论回执（M1-6 的 `renderer:gate-result`）。
-- 它是引擎自带、不是用户登记，但同样要进目录（C2），否则 M1/M2 读数与 v1 导入
-- 全被 `renderer_unregistered` 拒。`views[]` 取真实读 `task` 表的视图：`board`、`plan`
-- （`src/claim/render.ts` 只把 task.created/task.claimed 折成 claim，来源表是 task）。
-- 若之后有人用 `renderer.registered` 事件登记同 id，事件投影覆盖本行（`rebuildRendererCatalog`
-- 先写事件行、再 `INSERT OR IGNORE` 内置兜底）。
INSERT OR IGNORE INTO renderer_catalog (id, module_path, views, at)
VALUES ('renderer:gate-result', 'src/claim/render.ts', '["board", "plan"]', '2026-11-15');
