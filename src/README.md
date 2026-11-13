# src/ 目录约定（SDO v2）

> 写域是硬边界（[plan/01 §2](../../plan/01-团队与分工.md)）：一个目录只由一个泳道写；跨域改动由 PM 开双泳道卡，不靠默契。

| 目录 | 职责 | 写域泳道 | 第一张填充卡 |
|---|---|---|---|
| `core/` | 事件模型、fold 投影、verify、P15、门禁判定 | `core`（impl-core） | M0-2 |
| `db/` | SQLite schema、迁移、驱动适配 | `core`（impl-core） | M0-1 |
| `views/` | 13 个视图 + `view_catalog` + `min_right` | `surface`（impl-surface） | M0-3 |
| `query/` | `sdo_query`：预算、游标、`query_miss` 聚合 | `surface` | M0-4 |
| `ui/` | 控制台三页（总览 / board / plan） | `surface` | M0-5 |
| `sign/` | 登录、签章口令、`signerd`、免密窗口、签名字段 | `security`（M2 起进场） | M2 |

构建：`npm run build`（tsc → `lib/`）；测试：`npm test`（零依赖 `node --test`）。
数据库驱动选型结论见 [../plan/cards/M0-0.md](../plan/cards/M0-0.md) 的 C4。
