/**
 * M1-6：v1 → `claim` 重建的共享类型（docs/03 §3）。
 *
 * 两条写路径分开：
 *   · 事件：`src/db/write.ts` 的 `append()`（唯一事件入口）；
 *   · `claim`：本目录的渲染器网关（唯一 claim 入口，`src/claim/gateway.ts`）。
 * `claim` 不是 fold 投影（A2），不进 M1-0 的 SUPPORTED_KINDS/MATERIALIZED_TABLES。
 */
import type { ExportClaim } from '../importer/parse.js';

/** 渲染器未注册。M1 的注册面 = `RENDERERS` 常量 ∩ `view_catalog` 的 view 名（D-034）。 */
export type ClaimReason =
  | 'renderer_unregistered'
  | 'frontier_empty'
  | 'frontier_unknown'
  | 'claim_conflict'
  | 'claim_invalid'
  | 'event_rejected';

export const CLAIM_COLUMNS = [
  'id',
  'subject',
  'predicate',
  'value',
  'as_of_frontier',
  'derived_by',
  'actor',
  'at',
] as const;

export type ClaimColumn = (typeof CLAIM_COLUMNS)[number];

/** 落库前的完整 claim 行；`as_of_frontier` 是 JSON 数组文本（事件 id 列表）。 */
export type ClaimRow = Readonly<Record<ClaimColumn, string>>;

/** 20/20 逐字段比对的一条差异（C1）。 */
export interface ClaimDiff {
  readonly path: string;
  readonly parsed: unknown;
  readonly stored: unknown;
}

export interface ClaimImportResult {
  readonly ok: boolean;
  readonly reason_code?: ClaimReason;
  readonly message?: string;
  /** 新写入的 claim 行数。 */
  readonly written: number;
  /** 已存在且逐字段相同、被跳过的行数（幂等重跑的读数）。 */
  readonly skipped: number;
  /** 经 `append()` 实际写入的新事件数（失败时也照实报，不撒谎）。 */
  readonly events_written: number;
  /** 新写入的 claim 行数（与 `written` 同值；显式命名给 recover 流程读）。 */
  readonly claims_written: number;
  /** 失败后能否用 `renderClaimsFromEvents` 从已落事件补齐 claim。 */
  readonly resumable: boolean;
  /** `resumable` 时的恢复动作。 */
  readonly next_step?: 'render_only';
}

/**
 * 由解析结果推导“期望的 claim 行”。这是 C1 比对的唯一口径：
 * `subject/predicate/value/derived_by/actor/at` 直接取夹具字段（`value` 编码成 code/params），
 * `as_of_frontier` 取该 claim 重建出的真实事件 id（v1 的 `f:...` 只是离线时间标记，不入库）。
 */
export interface ClaimExpectation {
  readonly row: ClaimRow;
  /** 该 claim 重建出的事件 id，按 buildClaimEvents 的顺序。 */
  readonly eventIds: readonly string[];
}

export type ClaimSource = ExportClaim;
