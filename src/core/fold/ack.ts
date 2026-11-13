/**
 * 已知但不改变 34 张物化表的事件（docs/02 §11 其余域）。
 * 显式列在这里 = “看到了、明确不投影”；未知 kind 仍然 fail-closed（见 registry/index）。
 * 理由统一：物化目标是 docs/03 + 支撑表；这些事件的服务对象表不在 M0-2 的 34 张里，
 * 或它们只驱动 M-10 的 verify/审计，由后续卡接。
 */
export const ACK_KINDS: Readonly<Record<string, string>> = {
  'intent.proposed': '草稿不落 intent 行；intent 行由签字事务写（docs/02 §11），proposed 态由事件流读出',
  'workcopy.created': '工作副本不在 34 张表内，由 M-3/M-10 的工作树逻辑消费',
  'workcopy.removed': '同上',
  'actor.enrolled': '身份表不在 docs/03 的 25 张内，留身份卡',
  'auth.login': '审计事件，不投影',
  'auth.unlock': '审计事件，不投影',
  'auth.failed': '审计事件，不投影',
  'query_miss': 'gap 的输入；gaps/pm_gaps 是视图（M0-3），不是表',
  'schema.migrated': '迁移自述事件；迁移本身由 user_version 记录',
  'backup.taken': '运维审计事件，不投影',
  'restore.done': '运维审计事件，不投影',
  'store.unlocked': '存储保密审计事件，不投影',
  'store.open_suspected': '存储保密审计事件，不投影',
  'lock.acquired': '锁/租约由 M-6 的运行时消费，不在物化表内',
  'lock.released': '同上',
  'lease.issued': '同上',
  'lease.expired': '同上',
  'lease.revoked': '同上',
  'agent.spawned': '代理池视图（M0-3）由运行时数据算，本卡不物化',
  'agent.reused': '同上',
  'agent.pick_declined': '同上',
  'agent.compaction_attempted': '同上',
  'agent.report_compaction': '同上',
  'agent.parked': '同上',
  'agent.retired': '同上',
  'agent.handoff': '同上',
  'change.proposed': '变更链由后续卡消费',
  'change.applied': '同上',
  'node.reset': '图模型节点表的维护事件，M0-2 不建图表',
  'act.cancelled': '取消事件由运行时消费，不投影',
  'boundary.violation': '越界审计事件，不投影',
  'admission.rejected': '准入审计事件，不投影',
  'orphan.expired': '孤儿过期由运行时清理，不投影',
  'redaction.applied': '脱敏审计事件，不投影',
  'i18n.fallback': '本地化回退审计事件，不投影',
  'baseline.rejected': 'baseline 表只存已冻结快照；拒绝不落表（M-10 verify 消费）',
};
