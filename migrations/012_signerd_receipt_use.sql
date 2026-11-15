-- M3-3（第 2 轮评审 P1-2）：signerd 回执一次性使用。
-- 同一 receipt_id 只能绑定一条 decision.signed 事件；复制事件改 id/hash 重放 ⇒ 唯一冲突被拒。
-- 表在建库迁移里建，写网关在 append 事务内插入（失败整批回滚）。
CREATE TABLE IF NOT EXISTS signerd_receipt_use (
  receipt_id  TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  at          TEXT NOT NULL
);
