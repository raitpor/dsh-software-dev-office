/**
 * M3-1 夹具授权（D-057/D-097 方式）：
 * - 测试里的 `append(...)` 统一换成 `appendAs`，默认用一个持有全权的 fixture root 会话；
 * - 需要验证拒绝的用例显式传 `authz`。
 */
import { GENESIS_PREV } from '../../src/core/verify-events.js';
import { append, chainHead, type AppendAuthz } from '../../src/db/write.js';
import { computeEventHash } from '../../src/core/verify-events.js';
import { backfillGrants } from '../../src/db/auth-bootstrap.js';
import { scopeCovers } from '../../src/core/auth/rights.js';
import type { RightsPort } from '../../src/core/pm/access.js';
import type { AppendResult } from '../../src/db/write-types.js';
import type { Event } from '../../src/core/fold/types.js';
import type { SdoDatabase } from '../../src/db/driver.js';

export const FIXTURE_SESSION = { actor: 'fixture-root', actor_kind: 'service' } as const;

export const FIXTURE_AUTHZ: AppendAuthz = { session: FIXTURE_SESSION };

/** 矩阵 scope 列 → 具体 scope 的覆盖集（M4-4/A2：基线授权只按矩阵最小闭集播种）。 */
const SCOPE_EQUIVALENTS: Readonly<Record<string, readonly string[]>> = {
  module: ['module:core', 'module:src'],
  domain: ['domain:core', 'domain:renderers'],
  release: ['release:current'],
  scope: ['module:core', 'module:src', 'domain:core', 'release:current'],
};

/** 测试视图 actor（query/ui 夹具）在 `withViewerDb` 建库时预置的最小权集。 */
export const VIEWER_ACTORS = ['viewer', 'reader-view', 'decider-view'] as const;

interface RequiredEntry { readonly right: string; readonly scope: string }

/** 按矩阵 `required` 的并集算出基线最小闭集（外加 read@domain:core 供查询路径）。 */
export function baselineGrants(db: SdoDatabase): readonly RightGrant[] {
  const rows = db.prepare('SELECT required FROM right').all() as Array<{ required: string }>;
  const keys = new Set<string>();
  const add = (right: string, matrixScope: string): void => {
    for (const scope of SCOPE_EQUIVALENTS[matrixScope] ?? []) keys.add(`${scope}|${right}`);
  };
  for (const row of rows) {
    let entries: unknown;
    try { entries = JSON.parse(row.required); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as RequiredEntry[]) {
      if (typeof entry?.right !== 'string' || typeof entry?.scope !== 'string') continue;
      add(entry.right, entry.scope);
    }
  }
  add('read', 'domain');
  return [...keys].map((key) => {
    const [scope, right] = key.split('|') as [string, string];
    return { actor: '', scope, right };
  });
}

const FIXTURE_AT = '2026-11-13T00:00:00Z';
const VIEWER_GRANTS: readonly RightGrant[] = [
  { actor: 'viewer', scope: 'domain:core', right: 'read' },
  { actor: 'reader-view', scope: 'domain:core', right: 'read' },
  { actor: 'decider-view', scope: 'domain:core', right: 'decide' },
];

function insertGrantRow(db: SdoDatabase, grant: RightGrant): void {
  db.prepare("INSERT OR IGNORE INTO actor (id, kind, display, at) VALUES (?, 'human', NULL, ?)").run(grant.actor, FIXTURE_AT);
  db.prepare(
    "INSERT OR IGNORE INTO scope (actor, scope, right, granted_by, at, revoked_at) VALUES (?, ?, ?, 'fixture', ?, NULL)",
  ).run(grant.actor, grant.scope, grant.right, FIXTURE_AT);
}

function hasAnyGrant(db: SdoDatabase, actor: string): boolean {
  return db.prepare('SELECT 1 AS one FROM scope WHERE actor = ? LIMIT 1').get(actor) !== undefined;
}

/** 只播 `scope` 行（不 append）：读路径夹具库专用（A2 护栏：`withViewerDb` 里禁止 append）。 */
export function seedViewerRights(db: SdoDatabase, grants: readonly RightGrant[] = VIEWER_GRANTS): void {
  for (const grant of grants) insertGrantRow(db, grant);
}

/** 读路径库的基线授权（只插行、不写事件；`withViewerDb` 专用）。 */
export function seedViewerGrants(db: SdoDatabase): void {
  seedViewerRights(db);
}

/**
 * 给夹具 actor 播基线授权（A2：矩阵 `required` 并集的最小闭集，而不是 45 格全灌）。
 *
 * 若该 actor 已有任何 scope 行 ⇒ 直接返回：A2 的建库预置（`withWriteDb`/`grantFixtureRoster`）
 * 已经把行和对应事件都播好，重复 append 只会把链头往前推、打乱调用方预计算的种子链。
 */
export function grantAll(db: SdoDatabase, actor: string): void {
  try {
    const missing = baselineGrants(db).filter((grant) => db.prepare(
      'SELECT 1 AS one FROM scope WHERE actor = ? AND scope = ? AND right = ? LIMIT 1',
    ).get(actor, grant.scope, grant.right) === undefined);
    if (missing.length === 0) return;
    for (const grant of missing) insertGrantRow(db, { ...grant, actor });
    backfillGrants(db);
  } catch (error) {
    // 写锁测试故意先占住库：授权行通常已播好，播种失败不改变被测的 append 行为。
    if ((error as { code?: string }).code !== 'SQLITE_BUSY' && (error as { code?: string }).code !== 'SQLITE_LOCKED') throw error;
  }
}

/** 按库当前链头重排整批：只改 prev/hash，payload、id、actor、at 均不变。 */
function rebaseChain(db: SdoDatabase, events: readonly Event[]): Event[] {
  let prev = chainHead(db);
  return events.map((event) => {
    const unsigned = { ...event, prev, hash: '' };
    const hash = computeEventHash(unsigned);
    prev = hash;
    return { ...unsigned, hash };
  });
}

/**
 * 夹具授权写入口（M3-1 P1-2 后）：会话 actor 必须与事件 actor 一致，
 * 所以按事件 actor 选/拆会话；默认 authz 只提供 actor_kind 模板。
 * 混 actor 批按连续段拆成多个 append——链在同批内已预计算，拆分不改 prev/hash。
 */
export function appendAs(db: SdoDatabase, events: readonly Event[], authz: AppendAuthz = FIXTURE_AUTHZ): AppendResult {
  if (events.length === 0) {
    grantAll(db, authz.session.actor);
    return append(db, events, authz);
  }
  const actors = [...new Set(events.map((event) => event.actor))];
  let headBefore: string | undefined;
  try { headBefore = chainHead(db); } catch { headBefore = undefined; }
  for (const actor of actors) grantAll(db, actor);
  // 补授权会 append `right.granted` 事件、把链头前移；此时调用方预计算的 prev/hash 已过期，
  // 按新链头重排后再入网关（payload/id 不变）。链头没动时保持原样（重复事件才能被幂等跳过）。
  // 两种情况要按新链头重排：①补授权把链头推走；②调用方在未锚定 ACTIVE_DB 的库上
  // 从 genesis 建批次（此时首条 prev 已不是链头）。若批次里的事件已存在（重复 append 测幂等），
  // 保持原样让网关按 id 跳过。
  let headNow: string | undefined;
  try { headNow = chainHead(db); } catch { headNow = undefined; }
  const firstPrev = events[0]?.prev;
  let anyExists = true;
  try {
    anyExists = events.some((event) => db.prepare('SELECT 1 AS one FROM event WHERE id = ? LIMIT 1').get(event.id) !== undefined);
  } catch {
    // event 表被测试故意改名（回滚用例）：交给 append 自己报错，夹具不插手。
    anyExists = true;
  }
  // 只重排两种合法批次：①补授权推走链头；②未锚定 ACTIVE_DB、从 GENESIS 起建的批次。
  // 伪造的 prev（非 GENESIS、非链头）必须原样交给网关拒绝，不能被夹具“修正”。
  const needsRebase = headBefore !== undefined && headNow !== undefined
    && (headNow !== headBefore || (firstPrev === GENESIS_PREV && firstPrev !== headNow && !anyExists));
  const rebased = needsRebase ? rebaseChain(db, events) : events;
  const rebasedActors = [...new Set(rebased.map((event) => event.actor))];
  const single = rebasedActors.length === 1 ? rebasedActors[0] : undefined;
  if (single !== undefined) {
    return append(db, rebased, { session: { actor: single, actor_kind: authz.session.actor_kind } });
  }
  let written = 0;
  let skipped = 0;
  let attempted = 0;
  let last: AppendResult | undefined;
  for (let index = 0; index < events.length;) {
    const actor = events[index]?.actor ?? authz.session.actor;
    let end = index;
    while (end < rebased.length && rebased[end]?.actor === actor) end += 1;
    last = append(db, rebased.slice(index, end), { session: { actor, actor_kind: authz.session.actor_kind } });
    written += last.written;
    skipped += last.skipped;
    attempted += last.attempted;
    if (!last.ok) return { ...last, written, skipped, attempted };
    index = end;
  }
  return { ok: true, written, skipped, attempted, rolled_back: false, eventCount: last?.eventCount ?? 0 };
}

const ROSTER = [
  'fixture-root',
  'alice', 'bob', 'carol', 'dave', 'lead', 'ci', 'bot', 'root', 'impl-core', 'eve',
  'agent-1', 'agent-alpha', 'tester', 'svc', 'reviewer', 'signer-1', 'producer-1',
  'align-fixture-actor', 'a-dev-7f3a', 'actor-1', 'human-1',
] as const;

/**
 * 旧夹具（M0–M2）没有 scope 授权行：给常见 actor 播全权，让工具路径测试继续测业务而不是授权。
 * M3-1 的拒绝用例必须用不在 ROSTER 里的 actor（如 'ghost'）或显式撤销授权。
 */
export function grantFixtureRoster(db: SdoDatabase): void {
  const actors = [...ROSTER, ...VIEWER_ACTORS];
  for (const actor of actors) {
    if (hasAnyGrant(db, actor)) continue;
    for (const grant of baselineGrants(db)) insertGrantRow(db, { ...grant, actor });
  }
  for (const grant of VIEWER_GRANTS) insertGrantRow(db, grant);
  backfillGrants(db);
}

/** 显式给某个会话 actor 播权（endpoint 测试用）。 */
export { grantAll as grantAllForTests };

/** 从测试里删掉 `append(db, ...)` 的默认授权器。 */
export function sessionOf(actor: string, actor_kind = 'human'): { session: { actor: string; actor_kind: string }; action: string; scope: string } {
  return { session: { actor, actor_kind }, action: 'create', scope: 'domain:core' };
}

/**
 * M3-1 测试播种：一条 grant = `scope` 行（`migrations/008_identity.sql` 形状）。
 * 同时可用于真库（`seedRights`）和纯函数测试（`rightsPortFrom`）。
 * 例：`seedRights(db, [{ actor: 'alice', scope: 'domain:core', right: 'read' }])`
 */
export interface RightGrant {
  readonly actor: string;
  readonly scope: string;
  readonly right: string;
}

export function seedRights(db: SdoDatabase, grants: readonly RightGrant[]): void {
  // A2：已存在的行不再 append（append 会 materialize 全表，清掉测试直插的夹具数据）。
  const fresh = grants.filter((grant) => db.prepare(
    'SELECT 1 AS one FROM scope WHERE actor = ? AND scope = ? AND right = ? LIMIT 1',
  ).get(grant.actor, grant.scope, grant.right) === undefined);
  if (fresh.length === 0) return;
  for (const grant of fresh) insertGrantRow(db, grant);
  backfillGrants(db);
}

/**
 * 纯函数版权限端口（给 `test/core/pm/`、`test/ui/` 注入；不做任何 IO）。
 * 语义与 `hasRight` 的 grant 覆盖一致：grant.scope 覆盖目标 scope 即持有该 right。
 */
export function rightsPortFrom(actor: string, grants: readonly RightGrant[]): RightsPort {
  const mine = grants.filter((grant) => grant.actor === actor);
  return {
    actor,
    denied: mine.length === 0,
    has(right, scope): boolean {
      return mine.some((grant) => grant.right === right && scopeCovers(grant.scope, scope));
    },
  };
}

