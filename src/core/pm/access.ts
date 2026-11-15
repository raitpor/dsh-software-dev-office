/**
 * M3-5 · 撤权后的队列可见性（纯数据层，权限通过端口注入）。
 *
 * 硬口径（卡 M3-5 / Lead m05648）：
 * - 撤权**不是删行**：事件/历史不动，只是“你能看到的待审行”按当前权限过滤；
 *   同一批行在别人眼里仍在。
 * - 权限来源可注入（`RightsPort`）：M3-1 交付前用假 rights 驱动测试；交付后由
 *   `src/core/auth` 适配成同一个端口，本模块不硬编码身份表。
 * - 队列排序仍属视图（M0-4 D-011）：本模块只做**行级可见性判定**，不改 `view_catalog.sql`。
 * - `escalate` 只能升到自己有 `read` 的域：判定函数在这里，写动作在 `act.ts`。
 */

import type { SdoDatabase } from '../../db/driver.js';
import { query } from '../../query/index.js';
import { scopeCovers } from '../auth/rights.js';
import type { Session } from '../auth/session.js';
import { readGrants } from '../../db/auth.js';
import type { PmQueueRow } from './queue.js';
import { readPmState, rowOf, rowsOf, stringArrayField, stringField } from './state.js';
import { canonicalJson } from '../fold/canonical.js';

/** M3-0 矩阵的动作名（`docs/07` §2）；本卡只消费，不新增动作。 */
export type AccessRight =
  | 'read'
  | 'review'
  | 'decide'
  | 'sign'
  | 'plan'
  | 'assign'
  | 'escalate'
  | 'write'
  | 'admin';

/**
 * 权限端口：`has(right, scope)` 是**唯一**判权入口。
 * 测试传假实现；M3-1 落地后由 `src/core/auth` 的 `hasRight` 适配（不在这里硬编码）。
 */
export interface RightsPort {
  readonly actor: string;
  has(right: AccessRight, scope: string): boolean;
  /**
   * 显式 deny-all 标记（M3-5 P2-1）：控制台的未知身份不靠“能力表恰好为空”推断，
   * 而是显式声明；否则空 `review_queue` + deny-all 会静默输出 `to_decide=0`。
   */
  readonly denied?: boolean;
}

/** 未知身份的权限端口：显式 deny-all（M3-1 接线后由 `src/core/auth` 适配替换）。 */
export function denyAllRightsPort(actor: string): RightsPort {
  return { actor, denied: true, has: () => false };
}

/** `pm_queue` 中缺少具体域信息的行（全局行）归属的兜底 scope。 */
export const PM_QUEUE_SCOPE = 'domain:pm';

/**
 * 生产路径的权限端口（M3-5 收口）：从真库 `scope` 表读该 actor 未撤销的 grant，
 * 语义与 M3-1 `hasRight` 的 grant 覆盖一致（同前缀、按 `/` 边界）。
 *
 * 默认 **deny-all**：actor 不存在或没有任何有效 grant ⇒ 显式 `denied`。
 * 不允许调用方在缺权限时“回退到静态席位表”放行（Lead m06236 ①）。
 */
export function dbRightsPort(db: SdoDatabase, actor: string): RightsPort {
  const grants = readGrants(db, actor).filter((grant) => grant.revoked_at === null);
  if (grants.length === 0) return denyAllRightsPort(actor);
  return {
    actor,
    has(right: AccessRight, scope: string): boolean {
      return grants.some((grant) => grant.right === right && scopeCovers(grant.scope, scope));
    },
  };
}

export interface TaskScopeSet {
  readonly task_id: string;
  /** 该卡关联的域 scope（release 卡来自 `inputs` 的 `release:` 前缀）。 */
  readonly scopes: readonly string[];
}

/** 从 fold 状态取 task 的域 scope；无显式域时返回 `[domain:pm]`（不猜）。 */
export function taskScopes(
  db: SdoDatabase,
  taskId: string,
  state: import('../fold/types.js').FoldState | undefined = undefined,
): TaskScopeSet {
  const foldState = state ?? readPmState(db).state;
  const task = rowOf(foldState, 'task', taskId);
  if (task === undefined) return { task_id: taskId, scopes: [PM_QUEUE_SCOPE] };
  const inputs = stringArrayField(task, 'inputs');
  const scopes: string[] = [];
  for (const input of inputs) {
    if (input.startsWith('release:')) scopes.push(input);
    else if (input.startsWith('domain:')) scopes.push(input);
  }
  return { task_id: taskId, scopes: scopes.length === 0 ? [PM_QUEUE_SCOPE] : [...new Set(scopes)].sort() };
}

export interface ApplyEntry {
  /** 需要申请的 scope（`release:<id>` / `domain:<name>`）。 */
  readonly scope: string;
  /** M4 换真 `grant` 前的入口动作：`escalate`（A2）。 */
  readonly action: 'escalate';
  readonly reason_code: 'no_permission';
  readonly hint: string;
}

function applyEntry(scope: string): ApplyEntry {
  return {
    scope,
    action: 'escalate',
    reason_code: 'no_permission',
    hint: `你对 ${scope} 没有权限：向有该域权限的人申请（M4 前先走 escalate）`,
  };
}

export interface HiddenReviewRow {
  readonly item_id: string;
  readonly scopes: readonly string[];
  readonly reason_code: 'no_permission';
}

export interface ReviewQueueAccess {
  readonly rows: readonly ReviewQueueRow[];
  readonly hidden: readonly HiddenReviewRow[];
  readonly apply_entries: readonly ApplyEntry[];
  /** 视图层就 miss 时（权限不足整个视图），行集为空并带 miss。 */
  readonly miss: 'filtered_by_permission' | undefined;
  /**
   * 本次读取是否发生“按权限过滤”（P2-1）：hidden 非空、视图本身 miss、或端口显式 deny-all。
   * UI 用它决定是否抑制 `to_decide` 数字——不能用 `hidden.length>0`，否则空队列 + deny-all 会出假 0。
   */
  readonly filtered: boolean;
}

export interface ReviewQueueRow {
  readonly item_id: string;
  readonly proposition: string;
  readonly scopes: readonly string[];
}

function toReviewRow(raw: Readonly<Record<string, unknown>>, scopes: readonly string[]): ReviewQueueRow {
  return {
    item_id: String(raw['item_id']),
    proposition: String(raw['proposition']),
    scopes,
  };
}

/** 当前权限下可见的 `review_queue` 行 + 被隐藏行的申请入口（C1/C2/C5）。 */
export function readReviewQueueAccess(
  db: SdoDatabase,
  rights: RightsPort,
  session: Session,
): ReviewQueueAccess {
  const denied = rights.denied === true;
  const { state } = readPmState(db);
  // 判权分工（M3-5 收口，Lead m06236 ③）：
  // - query 侧（有 session 时）只判**视图级** min_right（`review_queue` 需要 decider 层级），
  //   防止未授权调用方把整表读出来；它判不了“这一行属于哪个域”。
  // - 行级域判定**唯一**在下面 `rights.has('read') && rights.has('decide')`。
  // 两者维度不同，不是重复判权；无 session 的纯数据层测试才用兼容参数 `right`。
  const result = query(db, { view: 'review_queue' }, { session });
  if (result.miss !== undefined) {
    const filtered = result.miss.reason === 'filtered_by_permission';
    return {
      rows: [],
      hidden: [],
      apply_entries: filtered || denied ? [applyEntry(PM_QUEUE_SCOPE)] : [],
      miss: filtered ? 'filtered_by_permission' : undefined,
      filtered: filtered || denied,
    };
  }
  const rows: ReviewQueueRow[] = [];
  const hidden: HiddenReviewRow[] = [];
  const entries = new Map<string, ApplyEntry>();
  for (const raw of result.rows) {
    // review_queue 的 `item_id` 是 attention.id；经 attention.task_id 取域。
    const attention = rowOf(state, 'attention', String(raw['item_id']));
    const taskId = stringField(attention, 'task_id') ?? '';
    const scopes = taskId.length === 0 ? [PM_QUEUE_SCOPE] : taskScopes(db, taskId, state).scopes;
    // P2-2：显式双查（read + decide）。M3-1 的 hasRight('decide') 未声明隐含 read，
    // 因此“只看 decide”的端口也不该看到 proposition。
    const visible = !denied && scopes.some((scope) => rights.has('read', scope) && rights.has('decide', scope));
    if (visible) {
      rows.push(toReviewRow(raw, scopes));
      continue;
    }
    hidden.push({ item_id: String(raw['item_id']), scopes, reason_code: 'no_permission' });
    for (const scope of scopes) entries.set(scope, applyEntry(scope));
  }
  if (denied && entries.size === 0) entries.set(PM_QUEUE_SCOPE, applyEntry(PM_QUEUE_SCOPE));
  return {
    rows,
    hidden,
    apply_entries: [...entries.values()].sort((a, b) => a.scope.localeCompare(b.scope)),
    miss: undefined,
    filtered: denied || hidden.length > 0,
  };
}

export interface PmQueueAccess {
  readonly rows: readonly PmQueueRow[];
  readonly hidden: readonly PmQueueRow[];
  readonly apply_entries: readonly ApplyEntry[];
}

/**
 * `pm_queue` 的行级过滤：**owner 是该 actor 的行**，在其失去 `read@domain:pm` 后不再出现；
 * 全局行（owner 为 null）不归个人，仍按视图权限可见（C5：不残留“已无权”的本人行）。
 */
export function filterPmQueueRows(rows: readonly PmQueueRow[], rights: RightsPort): PmQueueAccess {
  if (rights.denied === true) {
    // 显式 deny-all：全局行也不可见（P2-1/P3，与“撤权只藏自己的行”区分开）。
    return { rows: [], hidden: rows, apply_entries: [applyEntry(PM_QUEUE_SCOPE)] };
  }
  const verifiable = rights.has('read', PM_QUEUE_SCOPE);
  const visible: PmQueueRow[] = [];
  const hidden: PmQueueRow[] = [];
  for (const row of rows) {
    if (row.owner === rights.actor && !verifiable) hidden.push(row);
    else visible.push(row);
  }
  const apply_entries = verifiable ? [] : [applyEntry(PM_QUEUE_SCOPE)];
  return { rows: visible, hidden, apply_entries };
}

export interface HistorySnapshot {
  readonly decision_ids: readonly string[];
  readonly decision_hashes: readonly string[];
  readonly attention_ids: readonly string[];
  /** P3：attention 也快照内容，而不只是 id。 */
  readonly attention_hashes: readonly string[];
}

/** 撤销权限不动历史（C3）：同一库同一函数在撤权前后必须逐字段相等。 */
export function historySnapshot(db: SdoDatabase): HistorySnapshot {
  const { state } = readPmState(db);
  const ids = (table: string): readonly string[] => Object.keys(rowsOf(state, table)).sort();
  const decisionIds = ids('decision');
  const hashes = decisionIds.map((id) => {
    const row = rowOf(state, 'decision', id);
    return `${id}:${stringField(row, 'status') ?? ''}:${canonicalJson(row ?? {})}`;
  });
  const attentionIds = ids('attention');
  const attentionHashes = attentionIds.map((id) => {
    const row = rowOf(state, 'attention', id);
    return `${id}:${stringField(row, 'status') ?? ''}:${canonicalJson(row ?? {})}`;
  });
  return {
    decision_ids: decisionIds,
    decision_hashes: hashes,
    attention_ids: attentionIds,
    attention_hashes: attentionHashes,
  };
}

/** 该 actor 是否可以在 scope 上升级（必须先有 `read`，再有 `escalate`）。 */
export function canEscalateTo(rights: RightsPort, scope: string): boolean {
  return rights.has('read', scope) && rights.has('escalate', scope);
}
