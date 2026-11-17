/**
 * M3-1 P0：事件 kind → 授权动作的唯一映射表。
 *
 * 写网关**不再接受调用方声明的 action/scope**：授权动作由 `event.kind` 查本表决定，
 * 漏映射的 kind 一律 fail-closed（`unmapped_event_kind`），防止“空 required 动作
 * （defect.close/verify_finding）被拿来写任意 kind”。
 *
 * 动作名来自 docs/07 §2 的矩阵行（`MATRIX_ACTIONS`），`sign` 例外：决策事件没有
 * 单独矩阵行，由 `hasRight(actor,'sign',decisionScope)` 判定（见 D-108）。
 *
 * scope 解析优先级：payload 显式 `scope` → kind 专属推导（task 的 scope_paths、
 * decision 的决策作用域）→ 动作权前缀的 office 单域常量（D-101 单域假设，
 * M4 多域时要求调用点把 scope 带进 payload）。不在这里“猜” module→domain 归属，
 * 归属只走 `scope_owns` 链（C9）。
 */

import type { FoldState } from '../fold/types.js';

export type Payload = Readonly<Record<string, unknown>>;

export interface KindContext {
  /** 事件前的折叠态：仅 decision.* 需要（scope 从决策对象所属域取）。 */
  readonly state?: FoldState | undefined;
  /** 事件 subject（决策 id）。 */
  readonly subject: string;
}

export interface KindAction {
  readonly action: string;
  readonly scopeOf: (payload: Payload, ctx: KindContext) => string;
}

type ScopeKind = 'domain' | 'module' | 'release' | 'config' | 'task' | 'decision' | 'lock' | 'lease' | 'unit';

interface Spec {
  readonly action: string;
  readonly scope: ScopeKind;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

/** 显式 payload.scope 优先；否则按 scope 类别回退（单域单位常量，D-101）。 */
function prefixOf(kind: ScopeKind): string {
  if (kind === 'domain' || kind === 'config') return 'domain:';
  if (kind === 'release') return 'release:';
  if (kind === 'unit') return '';
  return 'module:';
}

function basicScope(payload: Payload, kind: ScopeKind): string | undefined {
  const explicit = text(payload['scope']);
  // 显式 scope 与动作所需前缀不符时忽略（否则 cross-prefix 会被误判成 no_ownership）。
  if (explicit !== undefined && (kind === 'unit' ? /^(domain|module|release):/.test(explicit) : explicit.startsWith(prefixOf(kind)))) return explicit;
  if (kind === 'task') {
    const paths = payload['scope_paths'];
    if (Array.isArray(paths)) {
      const module = paths.find((path) => typeof path === 'string' && path.startsWith('module:'));
      if (typeof module === 'string') return module;
    }
  }
  return undefined;
}

/** 决策事件的作用域：decision 行在 fold 里；未落地时按决策类别推（载荷 decision_kind）。 */
/** 撤租约的 scope 唯一来源是租约行（M4-2 第 2 轮 P1）；取不到时由 write.ts 拒。 */
function leaseScope(payload: Payload, ctx: KindContext): string {
  const leaseId = text(payload['lease_id']);
  const row = leaseId === undefined ? undefined : ctx.state?.tables.lease[leaseId];
  return row === undefined ? '' : String(row['scope'] ?? '');
}

function decisionScope(payload: Payload, ctx: KindContext): string {
  const explicit = text(payload['scope']);
  if (explicit !== undefined) return explicit;
  const row = ctx.state?.tables.decision[ctx.subject];
  const kind =
    (row === undefined ? undefined : text(row['decision_kind'])) ??
    text(payload['decision_kind']) ??
    '';
  return ['freeze', 'baseline', 'waiver', 'rollback'].includes(kind) ? 'release:current' : 'domain:core';
}

/**
 * M4-1/P2-5：锁的 scope 按前缀首段推导，不再写死 module:core：
 * 根前缀（`.`/空）⇒ `domain:core`（只允许工作副本工具路径申请，见 db/lock.ts）；
 * 其余 ⇒ `module:<首段>`（首段做白名单清洗，坏字符回退 module:core 并交由 C2 拒绝）。
 */
function lockScope(payload: Payload, ctx: KindContext): string {
  const explicit = text(payload['scope']);
  if (explicit !== undefined && /^(domain|module|release):/.test(explicit)) return explicit;
  const subject = typeof ctx.subject === 'string' ? ctx.subject.replace(/\\/g, '/').toLowerCase() : '';
  const trimmed = subject.replace(/^\.?\/+|\/+$/g, '');
  if (trimmed === '' || trimmed === '.') return 'domain:core';
  const first = trimmed.split('/')[0] ?? '';
  return /^[a-z0-9][a-z0-9._-]*$/.test(first) ? `module:${first}` : 'module:core';
}

const SCOPE_FALLBACK: Readonly<Record<Exclude<ScopeKind, 'task' | 'decision' | 'lock' | 'lease' | 'unit'>, string>> = {
  domain: 'domain:core',
  module: 'module:core',
  release: 'release:current',
  config: 'domain:renderers',
};

function scopeFor(payload: Payload, kind: ScopeKind, ctx: KindContext): string {
  const explicit = basicScope(payload, kind);
  if (explicit !== undefined) return explicit;
  if (kind === 'lock') return lockScope(payload, ctx);
  if (kind === 'decision') return decisionScope(payload, ctx);
  if (kind === 'lease') return leaseScope(payload, ctx);
  if (kind === 'task') return SCOPE_FALLBACK.module;
  if (kind === 'unit') return 'domain:core';
  return SCOPE_FALLBACK[kind];
}

/**
 * 每个 supported kind 的动作与作用域类别。逐条给理由太占行，按组说明：
 * - 计划/声明/条款类 → 建卡与复述（`create`/`restate`/`propose_plan`，plan@domain）；
 * - 任务生命周期 → 认领/派发/解阻塞（write@module / assign@scope）；
 * - 评审与门禁 → `review`/`verify_finding`/`adopt_review`（review@module）；
 * - 冻结与回滚 → `freeze`/`rollback`（decide@release + sign）；
 * - 决策事件 → `sign`（作用域由决策对象定，见 decisionScope）；
 * - defect.close / verify_finding 的 required 为空：权限放行后仍必须过
 *   `ACTION_OBJECT_CONDITIONS`（P1-1），所以这里映射的是动作而非“谁都能写”。
 */
const SPECS: Readonly<Record<string, Spec>> = {
  'assumption.disposed': { action: 'restate', scope: 'domain' },
  'assumption.invalidated': { action: 'restate', scope: 'domain' },
  'assumption.recorded': { action: 'create', scope: 'domain' },
  'attention.answered': { action: 'escalate', scope: 'module' },
  'attention.raised': { action: 'escalate', scope: 'module' },
  'attention.withdrawn': { action: 'withdraw_attention', scope: 'module' },
  'baseline.amended': { action: 'freeze', scope: 'release' },
  'baseline.frozen': { action: 'freeze', scope: 'release' },
  'baseline.loosened': { action: 'freeze', scope: 'release' },
  'config.changed': { action: 'config', scope: 'domain' },
  // M4-3/C4：writer_changed 由单写者能力路径短路（网关先消费能力，再跳过矩阵）；
  // 这里保留一个已存在的管理动作名作为“设计矩阵里有这一行”的记录，不新增矩阵行。
  'publicface.writer_changed': { action: 'config', scope: 'unit' },
  'conflict.detected': { action: 'adopt_review', scope: 'module' },
  'conflict.resolved': { action: 'adopt_review', scope: 'module' },
  'contract.defined': { action: 'create', scope: 'domain' },
  'criterion.registered': { action: 'create', scope: 'domain' },
  'criterion.revised': { action: 'restate', scope: 'domain' },
  'decision.rejected': { action: 'sign', scope: 'decision' },
  'decision.revoked': { action: 'revoke_decision', scope: 'decision' },
  'decision.signed': { action: 'sign', scope: 'decision' },
  'decision.valid': { action: 'sign', scope: 'decision' },
  'defect.closed': { action: 'defect.close', scope: 'module' },
  'defect.recorded': { action: 'defect.record', scope: 'module' },
  'design.locked': { action: 'create', scope: 'domain' },
  'evidence.attached': { action: 'create', scope: 'domain' },
  'gate.judged': { action: 'review', scope: 'module' },
  'goal.declared': { action: 'propose_plan', scope: 'domain' },
  'goal.integrated': { action: 'propose_plan', scope: 'domain' },
  'goal.reparented': { action: 'propose_plan', scope: 'domain' },
  'intent.signed': { action: 'amend_intent', scope: 'domain' },
  'lock.acquired': { action: 'claim', scope: 'lock' },
  'lock.released': { action: 'claim', scope: 'lock' },
  'lease.revoked': { action: 'assign', scope: 'lease' },
  'lease.issued': { action: 'dispatch', scope: 'unit' },
  'lease.expired': { action: 'dispatch', scope: 'unit' },
  'redteam.disposed': { action: 'review', scope: 'module' },
  'redteam.recorded': { action: 'review', scope: 'module' },
  'release.delivered': { action: 'freeze', scope: 'release' },
  'release.frozen': { action: 'freeze', scope: 'release' },
  'release.superseded': { action: 'rollback', scope: 'release' },
  'report.recorded': { action: 'create', scope: 'domain' },
  'restatement.diff_dispositioned': { action: 'restate', scope: 'domain' },
  'restatement.invalidated': { action: 'restate', scope: 'domain' },
  'restatement.recorded': { action: 'restate', scope: 'domain' },
  'review.finding_verified': { action: 'verify_finding', scope: 'module' },
  'review.recorded': { action: 'review', scope: 'module' },
  'review.round_closed': { action: 'review', scope: 'module' },
  'scope.declared': { action: 'create', scope: 'domain' },
  'snapshot.taken': { action: 'create', scope: 'domain' },
  'spec.defined': { action: 'create', scope: 'domain' },
  'spec.revised': { action: 'restate', scope: 'domain' },
  'stage.entered': { action: 'review', scope: 'module' },
  'stage.exited': { action: 'review', scope: 'module' },
  'task.assigned': { action: 'dispatch', scope: 'module' },
  'task.blocked': { action: 'claim', scope: 'task' },
  'task.claimed': { action: 'claim', scope: 'task' },
  'task.created': { action: 'create', scope: 'domain' },
  'task.dependencies_changed': { action: 'dependencies', scope: 'domain' },
  'task.done': { action: 'claim', scope: 'task' },
  'task.dropped': { action: 'claim', scope: 'task' },
  'task.reopened': { action: 'claim', scope: 'task' },
  'task.unassigned': { action: 'dispatch', scope: 'task' },
  'task.unblocked': { action: 'unblock', scope: 'task' },
  'verify.failed': { action: 'review', scope: 'module' },
  'verify.passed': { action: 'review', scope: 'module' },
};

/**
 * ACK kind 里**有业务含义**的少数派：走正常动作判定；其余 ACK 由网关按“会话绑定 +
 * 审计事件不投影业务行”放行（附录：卡 M3-1 A5 / D-108 边界）。
 */
const ACK_SPECS: Readonly<Record<string, Spec>> = {
  // M4-3/C3：申请是常规写，复用矩阵的 write@module 动作行 `claim`（不新增矩阵行；scope 由 payload.scope 给出）。
  'publicface.requested': { action: 'claim', scope: 'module' },
  // M4-3/C4：执行只认单写者能力；映射存在是为了“已登记动作”的可审计记录。
  'publicface.executed': { action: 'claim', scope: 'module' },
  'request_sign': { action: 'propose_plan', scope: 'domain' },
  'renderer.registered': { action: 'config', scope: 'config' },
};

function toAction(spec: Spec): KindAction {
  return { action: spec.action, scopeOf: (payload, ctx) => scopeFor(payload, spec.scope, ctx) };
}

export const KIND_ACTIONS: Readonly<Record<string, KindAction>> = Object.freeze(
  Object.fromEntries(
    Object.entries({ ...SPECS, ...ACK_SPECS }).map(([kind, spec]) => [kind, toAction(spec)]),
  ),
);

/** 网关判定入口：未映射 ⇒ undefined（调用方必须 fail-closed）。 */
export function kindActionFor(kind: string): KindAction | undefined {
  return KIND_ACTIONS[kind];
}

/** 有业务含义的 ACK kind（guard 测试用：其余 ACK 只做会话绑定）。 */
export const ACK_ACTION_KINDS: readonly string[] = Object.freeze(Object.keys(ACK_SPECS));
