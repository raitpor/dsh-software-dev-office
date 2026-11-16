/**
 * M4-1/C5：锁 TTL 常量。
 *
 * docs/07 §13 的 lock DDL 给 `expires_at` 的默认值是 2 小时（“到期需续”）。
 * 仓库目前没有 `lease` 表（M4-2 才建），所以 A3「复用 lease TTL」没有对象可复用；
 * M4-1 先用这个常量，等 M4-2 落地后由 lease 的 TTL 覆盖（D-136）。
 */
export const LOCK_TTL_MS = 2 * 60 * 60 * 1000;
/** verify 的泄漏宽限：超过 TTL + 宽限仍无卡关联的活锁才报 `lock_leaked`。 */
export const LOCK_GRACE_MS = 10 * 60 * 1000;

/** 根锁工具路径的自证标记（事件流侧第二道闸，见 M4-1 第 2 轮 P1）。 */
export const LOCK_TOOL_INITIATOR = 'sdo-workcopy';
