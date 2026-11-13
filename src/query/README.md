# src/query/ · sdo_query

职责：`sdo_query` 的预算、游标、`query_miss` 聚合；列表查询必须带 `LIMIT`。

- 写域：`surface` 泳道（impl-surface）。
- 第一张填充卡：M0-4。
- 纪律：成本是契约（docs/02 §7）——超预算要告警，不许静默扫全表。
