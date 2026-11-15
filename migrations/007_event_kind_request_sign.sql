-- SDO v2 · 迁移 007：登记 `request_sign`（user_version 6 -> 7）
-- 卡：M2-5（PM 最小环路）。真源：docs/15 §动作表 `request_sign` 行 + 卡 C7。
-- 该事件是 ACK（不投影任何表）：只记录"PM 发起了一次待签请求"，签名仍由人完成。
-- 事件 kind 必须同时出现在 src/core/fold/ack.ts 的静态白名单里，否则写网关会按
-- `unknown_event_kind` 拒收（这是 M1-0 的 fail-closed 设计，见台账 D-066）。
-- 重跑安全：用 INSERT OR IGNORE（迁移只执行一次，保持可重放）。

INSERT OR IGNORE INTO event_kind (kind, since, note)
VALUES ('request_sign', '2026-11-15', 'docs/15 §动作表：PM 发起待签请求（ACK，无投影；M2-5）');
