/**
 * M1-5 preview · `rework_units` 的公开类型。
 *
 * 口径（docs/11 §7.5）：返工面与影响面必须同源同算、一起返回一个整数。
 * `work_unit` 在 fold 里只增不删，因此“作废”的判定不是在集合里找删除，
 * 而是：变更前存在的单位，在变更后其行本身或其引用的 task/criterion/evidence/spec
 * 行发生了变化（docs/11 §2“内容变（hash 变）⇒ 失效但不删除”）。
 */

/** 一条被本次变更作废的已完成 work_unit 的证据（不落库，只回给调用方）。 */
export interface ReworkUnitEvidence {
  readonly task_id: string;
  readonly criterion_id: string;
  readonly spec_id: string;
  /** 触发这次作废的行（`work_unit:<id>` / `task:<id>` / …），用于回答“为什么算作废”。 */
  readonly changed_refs: readonly string[];
}

export type PreviewChangeKind = 'added' | 'removed' | 'changed' | 'invalidated';

/** will_change 的一行：哪张表、哪个对象、怎么变。 */
export interface PreviewChange {
  readonly kind: string;
  readonly id: string;
  readonly change: PreviewChangeKind;
}

export interface PreviewResult {
  readonly willChange: readonly PreviewChange[];
  readonly reworkUnits: number;
  readonly payloadHash: string;
  readonly invalidatedWorkUnits: readonly ReworkUnitEvidence[];
}

export type PreviewReason = 'invalid_args' | 'stale_events';

export class PreviewError extends Error {
  readonly code: PreviewReason;

  constructor(code: PreviewReason, message: string) {
    super(message);
    this.name = 'PreviewError';
    this.code = code;
  }
}

/** 第三参只用于接口对齐；任何 rework 数字都在运行时拒绝（C4）。 */
export type PreviewOptions = Readonly<Record<string, unknown>>;
