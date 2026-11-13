# src/views/ · 视图

职责：13 个视图 + `view_catalog`，`min_right` 生效；视图只读，不写事件。

- 写域：`surface` 泳道（impl-surface）。不碰 fold 与 DDL。
- 第一张填充卡：M0-3。
- 纪律：页面上的每个数字都必须能被 query 复算（M0-5 判据），视图不做第二套真相。
