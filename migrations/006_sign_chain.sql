-- SDO v2 · 迁移 006：M2-0 认证与签字链地基（user_version 5 -> 6）
-- 卡：M2-0（C2/C8/C12）。真源：docs/06 §5（decision 表）、§13；台账 D-046/D-047。
--
-- 1) `security.alert` 进 event_kind：kind 是登记数据（G5），新增 = 插一行。
--    代码侧同步进 ACK_KINDS（看到但不投影），漂移由 test/db/event-kinds.test.ts 守住。
-- 2) `decision.channel`：签发渠道 ui|cli，来自 signerd 回执，由 decision.signed 投影。
--    key_id 001 已有；channel 新增，允许 NULL（旧行/直接 fold 的测试夹具）但 CHECK 只认 ui/cli。
--
-- 幂等：迁移只在 user_version 前进时执行一次；种子用 INSERT OR IGNORE 保持可重放。
-- 重跑本文件本身（ADD COLUMN 会报 duplicate column）不被支持；幂等由 runMigrations 的
-- user_version 保证，二次运行 no-op 有测试覆盖（test/db/event-kinds.test.ts）。

INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES (
  'security.alert',
  '2026-11-14',
  'M2-0 C12/D-046：安全告警审计事件（代签尝试等），append 成功即落 event，不投影业务表'
);

ALTER TABLE decision ADD COLUMN channel TEXT CHECK (channel IS NULL OR channel IN ('ui', 'cli'));
