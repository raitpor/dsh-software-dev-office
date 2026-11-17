/**
 * M3-1（第 1 轮评审后）：写网关调用点登记表。
 *
 * 授权动作不再由调用方声明（P0：动作由 `event.kind` 经
 * `src/core/auth/kind-actions.ts` 决定），所以这里登记的是**每个文件会写哪些 kind**，
 * 用来在新增/漏登记时才红。守卫测试见 `test/db/permission-write.test.ts`。
 *
 * 局限（卡/README 已写）：静态扫描只能发现字面 `append(`/`appendAsTool(` 调用；
 * 动态拼接、别名变量、包装函数绕不过扫描。它不是授权机制，只是防漂移网。
 */
// 扫描边界（P3-2 说明）：`test/db/permission-write.test.ts` 的 kind ⊆ 登记集合守卫只认
// 源码里的**单行单引号字面量** `kind: 'x.y'`；模板字符串、变量拼接、别名转发扫不到。
// 因此它证明的是“没有显式写出未登记的 kind”，不是全静态覆盖——新增调用点仍须人工登记。

export interface AppendCallSite {
  readonly file: string;
  readonly kinds: readonly string[];
  readonly reason: string;
}

export const APPEND_CALL_SITES: readonly AppendCallSite[] = [
  { file: 'src/align/diff.ts', kinds: ['restatement.diff_dispositioned'], reason: '复述差异处置' },
  { file: 'src/align/restatement.ts', kinds: ['restatement.recorded', 'restatement.invalidated'], reason: '复述落盘/作废' },
  { file: 'src/claim/gateway.ts', kinds: ['task.created', 'task.claimed'], reason: 'v1 回执导入 → task 行' },
  {
    file: 'src/core/pm/act.ts',
    kinds: ['task.claimed', 'task.unblocked', 'request_sign', 'attention.raised', 'attention.withdrawn'],
    reason: 'PM 动作：认领/解阻塞/请求签字/升级/撤回',
  },
  { file: 'src/core/pm/card.ts', kinds: ['task.created'], reason: '建卡' },
  { file: 'src/db/action-objects.ts', kinds: ['defect.closed', 'review.finding_verified'], reason: 'C8 对象条件动作' },
  { file: 'src/db/assumption.ts', kinds: ['assumption.disposed'], reason: '假设处置（复述写路径）' },
  { file: 'src/db/conflict.ts', kinds: ['conflict.detected', 'conflict.resolved'], reason: '冲突检测/裁决（带一次性能力）' },
  { file: 'src/db/freeze-store.ts', kinds: ['baseline.rejected'], reason: '冻结预览被拒的审计事件' },
  {
    file: 'src/db/freeze.ts',
    kinds: ['decision.valid', 'decision.signed', 'security.alert', 'baseline.frozen', 'baseline.amended', 'baseline.loosened'],
    reason: '冻结确认：决策 + baseline 新行 + 安全告警',
  },
  {
    file: 'src/db/gate.ts',
    kinds: ['gate.judged', 'baseline.amended', 'baseline.frozen', 'baseline.loosened'],
    reason: '阶段判定 + 关 defect 时复用的 baseline 守卫路径',
  },
  { file: 'src/db/lock.ts', kinds: ['lock.acquired', 'lock.released', 'lease.revoked'], reason: 'M4-1 锁：获取/释放/撤租约标记（DB 层互斥）' },
  { file: 'src/db/renderer.ts', kinds: ['renderer.registered'], reason: '渲染器登记（一次性能力 + admin@domain）' },
  { file: 'src/db/workcopy.ts', kinds: ['workcopy.created', 'workcopy.removed', 'snapshot.taken', 'task.blocked'], reason: '工作副本生命周期 + 准入 block（工具能力）' },
  { file: 'src/db/workcopy-tool.ts', kinds: ['snapshot.taken'], reason: '基线引导快照（工具能力）' },
  {
    file: 'src/db/lease.ts',
    kinds: ['lease.issued', 'lease.expired', 'lease.revoked', 'task.blocked', 'task.unblocked'],
    reason: 'M4-2 租约：派发/过期/收回 + 收回后 blocked→ready（工具能力/派发权）',
  },
  {
    file: 'src/db/publicface.ts',
    kinds: ['publicface.requested', 'publicface.executed', 'publicface.writer_changed'],
    reason: 'M4-3 公共面申请 / 单写者执行与交棒（能力路径 + reducer 投影）',
  },
  {
    file: 'src/sign/decision.ts',
    kinds: ['decision.valid', 'decision.signed', 'security.alert', 'auth.failed'],
    reason: '签字流程：决策事件 + 两条审计 ACK',
  },
];
