# src/views/ · 视图与目录

职责：把「视图是数据」落成可查的东西——13 个视图由 `migrations/002_views.sql` 用 SQLite 原生
`CREATE VIEW` 建在库里，目录表 `view_catalog` 自描述（`name/sql/columns/doc/min_right/row_budget`）。
视图只读，不写事件；第一张填充卡 M0-3。

- 写域：`surface` 泳道（impl-surface）。不碰 fold、DDL 与查询工具。
- 纪律：页面上的每个数字都必须能被 query 复算（M0-5 判据），视图不做第二套真相。
- 本卡不做：列级裁剪、预算/游标/`query_miss` 留痕——属于 M0-4 的查询层。

## 文件

| 文件 | 内容 |
|---|---|
| `migrations/002_views.sql` | `CREATE TABLE view_catalog` + 13 个 `CREATE VIEW` + 13 条目录 `INSERT`（同一份定义生成，body 与 `view_catalog.sql` 逐字一致） |
| `src/views/catalog.ts` | 目录读取与校验：`listViewCatalog` / `viewsForRight` / `assertSelectOnly` / `nativeViewName` |
| `test/views/*.test.ts` | C1–C6 的读数（目录、空库可查、列一致、只读、pm_queue 排序、权限集合） |

## 目录是唯一真源

- `sdo_query({view:'list'})` 返回的就是 `view_catalog`（`listViewCatalog` 按 `name` 排序返回）。
- 新增视图 = 在迁移里 `CREATE VIEW` + 一条 `INSERT INTO view_catalog`，**不改代码**；
  `viewsForRight` 读库计算可见集合，新行立即出现（正例见 `test/views/catalog.test.ts` 的「C1 正例」）。
- 每行 `columns` 是 `[{name,label,unit?,type}]` 的 JSON，`label` 是人话、`type` 属于
  `text|integer|number|timestamp|array|object|boolean`；`listViewCatalog` 对坏 JSON、重复列名、
  非法 `min_right`/`row_budget`、写入型 SQL 一律抛错（fail-closed）。

## 权限（min_right）

层级 `reader < reviewer < decider < signer`，由 `RIGHT_LEVELS` 给出：

- `reader` 见 11 个（除 `review_queue`、`gaps`）；
- `reviewer` 见 12 个（+`gaps`）；
- `decider`/`signer` 见全部 13 个（含 `review_queue`）。

这里只做「可见性声明」；列级裁剪与 `query_miss(reason='filtered_by_permission')` 属 M0-4。

## 只读校验

`assertSelectOnly(sql)` 是手写词法扫描（不是正则）：跳过 `--` 行注释、块注释、字符串
（`''` 转义）与引号标识符，再拒绝 `INSERT/UPDATE/DELETE/REPLACE/ATTACH/DETACH/PRAGMA/
CREATE/DROP/ALTER/VACUUM/REINDEX/ANALYZE/TRIGGER`，并拒绝多语句（`;`）与非 `SELECT/WITH`
开头。`listViewCatalog` 读取时对每行执行一次。

## 命名映射（偏差 D-011）

catalog 名 `baseline`/`evidence` 与 001 的同名投影表冲突（SQLite 同一 schema 不允许
table 与 view 同名），原生视图分别落名 `baseline_view`/`evidence_view`；对外查询入口名仍是
`view_catalog.name`，`nativeViewName()` 是唯一的映射点。详见 `plan/03-偏差台账.md` D-011。

## 测试

`npm test`（先 `tsc` 到 `lib/` 再 `node --test lib/test/`）。视图读数集中在
`test/views/catalog.test.ts`、`test/views/views-query.test.ts`、`test/views/pm-queue.test.ts`。
