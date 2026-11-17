/**
 * M3-1 夹具授权（D-057/D-097 方式）：
 * - 测试里的 `append(...)` 统一换成 `appendAs`，默认用一个持有全权的 fixture root 会话；
 * - 需要验证拒绝的用例显式传 `authz`。
 */
import { append, type AppendAuthz } from '../../src/db/write.js';
import { scopeCovers } from '../../src/core/auth/rights.js';
import type { RightsPort } from '../../src/core/pm/access.js';
import type { AppendResult } from '../../src/db/write-types.js';
import type { Event } from '../../src/core/fold/types.js';
import type { SdoDatabase } from '../../src/db/driver.js';

const RIGHT_NAMES = ['read', 'write', 'review', 'decide', 'sign', 'admin', 'plan', 'assign', 'escalate'] as const;
const SCOPES = ['domain:core', 'domain:renderers', 'module:core', 'module:src', 'release:current'] as const;

export const FIXTURE_SESSION = { actor: 'fixture-root', actor_kind: 'service' } as const;

export const FIXTURE_AUTHZ: AppendAuthz = { session: FIXTURE_SESSION };

/** 给夹具 actor 播全权（幂等；测试库已迁移后才调用）。 */
export function grantAll(db: SdoDatabase, actor: string): void {
  try {
    db.prepare("INSERT OR IGNORE INTO actor (id, kind, display, at) VALUES (?, 'human', NULL, '2026-11-13T00:00:00Z')").run(actor);
    for (const scope of SCOPES) {
      for (const right of RIGHT_NAMES) {
        db.prepare(
          "INSERT OR IGNORE INTO scope (actor, scope, right, granted_by, at, revoked_at) VALUES (?, ?, ?, 'fixture', '2026-11-13T00:00:00Z', NULL)",
        ).run(actor, scope, right);
      }
    }
  } catch (error) {
    // 写锁测试故意先占住库：授权行通常已播好，播种失败不改变被测的 append 行为。
    if ((error as { code?: string }).code !== 'SQLITE_BUSY' && (error as { code?: string }).code !== 'SQLITE_LOCKED') throw error;
  }
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
  const single = actors.length === 1 ? actors[0] : undefined;
  if (single !== undefined) {
    grantAll(db, single);
    return append(db, events, { session: { actor: single, actor_kind: authz.session.actor_kind } });
  }
  let written = 0;
  let skipped = 0;
  let attempted = 0;
  let last: AppendResult | undefined;
  for (let index = 0; index < events.length;) {
    const actor = events[index]?.actor ?? authz.session.actor;
    let end = index;
    while (end < events.length && events[end]?.actor === actor) end += 1;
    grantAll(db, actor);
    last = append(db, events.slice(index, end), { session: { actor, actor_kind: authz.session.actor_kind } });
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
  for (const actor of ROSTER) grantAll(db, actor);
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
  const actorInsert = db.prepare("INSERT OR IGNORE INTO actor (id, kind, display, at) VALUES (?, 'human', NULL, '2026-11-13T00:00:00Z')");
  const grantInsert = db.prepare(
    "INSERT OR IGNORE INTO scope (actor, scope, right, granted_by, at, revoked_at) VALUES (?, ?, ?, 'fixture', '2026-11-13T00:00:00Z', NULL)",
  );
  for (const grant of grants) {
    actorInsert.run(grant.actor);
    grantInsert.run(grant.actor, grant.scope, grant.right);
  }
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

