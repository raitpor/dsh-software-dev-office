import { CODE } from '../errors/codes.js';
/** M4-0：工作副本 API 的纯类型（db/workcopy 与测试共用）。 */
import type { TreeChange } from './tree.js';

export interface WorkcopySession {
  readonly actor: string;
  readonly actor_kind: 'human' | 'agent' | 'service';
}
export interface WorkcopyAuthor {
  readonly name: string;
  readonly email: string;
}
export interface CreateLinkOptions {
  /** @internal test-only：默认当前平台。产品路径不得传。 */
  readonly platform?: NodeJS.Platform;
  /** @internal test-only：默认 fs.symlinkSync。产品路径不得传。 */
  readonly symlinkFn?: (target: string, path: string, type: 'dir' | 'junction') => void;
}
export interface CreateRequest {
  readonly root: string;
  /** @internal test-only：覆盖 symlink 平台/实现（跑 win32/linux 两条分支）。产品路径不得传。 */
  readonly link?: CreateLinkOptions;
  readonly card: string;
  readonly base_snapshot_id: string;
  readonly session: WorkcopySession;
  readonly at: string;
}
export interface CreateResult {
  readonly ok: true;
  readonly gitdir: string;
  readonly workdir: string;
  readonly base_oid: string;
  readonly file_count: number;
  readonly timings: Record<string, number>;
}

/**
 * 工作副本 API 的结构化失败码闭集（M4-0/M4-1；D-156/D-157）。
 * 判定：`admitWorkcopy`/`commitWorkcopy`/`removeWorkcopy` 的 `ok:false` 只返回这些码；
 * append 网关的细码不透传，一律归一为 `append_failed`（message 保留原文）。
 */
export const WORKCOPY_FAILURE_REASONS = [
  CODE.admission_ambiguous, CODE.append_failed, CODE.dirty_main_tree, CODE.dirty_workcopy, CODE.invalid_field, CODE.lock_conflict, CODE.lock_missing, CODE.lock_release_failed, CODE.merge_conflict, CODE.no_permission, CODE.public_face_readonly, CODE.scope_undeclared, CODE.scope_violation, CODE.snapshot_missing, CODE.task_not_found, CODE.vcs_link_unsupported, CODE.vcs_object_missing, CODE.workcopy_busy,
] as const;

export type WorkcopyFailureReason = (typeof WORKCOPY_FAILURE_REASONS)[number];

/** 卡锁逐前缀释放的结构化失败项（M4-1 第 5 轮复审 P2，D-158）。 */
export interface LockReleaseFailure {
  readonly prefix: string;
  readonly reason_code: string;
  readonly message: string;
}

export interface FailureResult {
  readonly ok: false;
  readonly reason_code: WorkcopyFailureReason;
  readonly message?: string;
  /** 卡锁释放失败时逐前缀原因（reason_code 可为 no_permission/materialize_failed/...）。 */
  readonly details?: readonly LockReleaseFailure[];
  readonly [key: string]: unknown;
}
export interface CommitRequest {
  readonly root: string;
  readonly card: string;
  readonly base_snapshot_id: string;
  readonly message: string;
  readonly author?: WorkcopyAuthor;
}
export interface CommitResult {
  readonly ok: true;
  readonly card_oid: string;
  readonly base_oid: string;
  readonly changes: readonly TreeChange[];
  readonly timings: Record<string, number>;
}
export interface AdmitRequest extends CommitRequest {
  readonly session: WorkcopySession;
  readonly at: string;
  readonly snapshot_id?: string;
  readonly task_id?: string;
  /** @internal test-only：merge 后、重判前执行（TOCTOU 用例）。产品路径不得传（M4-1 接线时由调用方保证）。 */
  readonly beforeRewrite?: () => void;
  /** @internal test-only：在 rewrite 自己的扫描前执行（P2-1 窗口用例）。产品路径不得传。 */
  readonly rewriteScanHook?: () => void;
}
export interface AdmitResult {
  readonly ok: true;
  readonly snapshot_id: string;
  readonly git_oid: string;
  readonly changes: readonly TreeChange[];
  readonly written: number;
  readonly deleted: number;
  readonly timings: Record<string, number>;
  /** merge 后首次重判脏的时点（P1-2）。 */
  readonly dirty_checked_at: string;
  /** 重写主树的时点（P1-2）。 */
  readonly rewritten_at: string;
}
