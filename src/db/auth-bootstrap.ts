import { CODE } from '../core/errors/codes.js';
/**
 * 身份层 **迁移/CLI 初始化专用** 入口（M3-0 第 2 轮评审 P2-1）。
 *
 * 为什么单独一个文件：`enrollActor`/`grantRight` 是工具层 API，调用者必须持 `admin@domain`；
 * “第一个 admin 从哪来”不能靠调用方可传的 `bootstrap:true` 开关（那等于自证）。
 * 这里两个函数只能由迁移/CLI 初始化代码 import，**不导进工具层**；
 * 迁移 008 自身用 SQL 播种矩阵、不依赖本文件。
 *
 * 纪律：不得从 `src/query`、`src/core/pm`、`src/sign` 或任何事件写路径 import 本文件。
 */

import type { SdoDatabase } from './driver.js';
import { RIGHT_NAMES } from '../core/auth/matrix.js';
import { parseScope } from '../core/auth/rights.js';
import { isActorKind } from '../core/auth/session.js';
import { mintRightChangeAuthority, RIGHT_GRANTED, RIGHT_REVOKED, rightChangePayloadHash } from '../core/auth/rights-events.js';
import type { Event } from '../core/fold/types.js';
import type { VerifyProblem } from '../core/verify-types.js';
import { readEvents } from '../core/verify-events.js';
import { randomUUID } from 'node:crypto';
import { projectedRightRows } from './auth.js';
import { buildEvent } from './freeze-store.js';
import { append, chainHead } from './write.js';
import type { AuthFailureResult, AuthResult, EnrollActorInput, GrantRightInput } from './auth.js';

function fail(reason_code: typeof CODE.invalid_field | typeof CODE.no_permission, message: string): AuthFailureResult {
  return { ok: false, reason_code, message };
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 仅迁移/CLI 初始化：登记第一个 actor（不检查调用者 admin）。 */
export function bootstrapEnrollActor(db: SdoDatabase, input: EnrollActorInput): AuthResult {
  if (!isNonEmptyText(input.actor) || input.actor.includes('*')) {
    return fail(CODE.invalid_field, 'actor 不能为空且不接受通配');
  }
  if (!isActorKind(input.kind)) return fail(CODE.invalid_field, `actor_kind 非法：${String(input.kind)}`);
  const existing = db.prepare('SELECT kind FROM actor WHERE id = ?').get(input.actor) as { kind?: string } | undefined;
  if (existing !== undefined) {
    if (existing.kind !== input.kind) return fail(CODE.invalid_field, `actor 已登记且 kind 不同：${input.actor}`);
    return { ok: true };
  }
  db.prepare('INSERT INTO actor (id, kind, display, at) VALUES (?, ?, ?, ?)').run(
    input.actor,
    input.kind,
    input.display ?? null,
    input.at ?? new Date().toISOString(),
  );
  return { ok: true };
}

/** 仅迁移/CLI 初始化：授予第一个 `admin@domain`（不检查调用者 admin）。 */
export function bootstrapGrantRight(db: SdoDatabase, input: GrantRightInput): AuthResult {
  if (!isNonEmptyText(input.actor) || !isNonEmptyText(input.granted_by)) {
    return fail(CODE.invalid_field, 'actor/granted_by 不能为空');
  }
  if (!isNonEmptyText(input.right) || !(RIGHT_NAMES as readonly string[]).includes(input.right)) {
    return fail(CODE.invalid_field, `未知/非法 right：${String(input.right)}`);
  }
  const scope = parseScope(input.scope);
  if (!scope.ok) return fail(CODE.invalid_field, scope.message);
  const actor = db.prepare('SELECT 1 AS one FROM actor WHERE id = ?').get(input.actor);
  if (actor === undefined) return fail(CODE.invalid_field, `actor 未登记：${input.actor}`);
  // M4-4/A3：bootstrap 也只经唯一写入口落 `right.granted`（不再直插 scope 行）；
  // 一次性能力绑 event id + payload hash，网关对裸 append 仍拒 unauthorized_right_change。
  const at = input.at ?? new Date().toISOString();
  const payload = { grantee: input.actor, right: input.right, scope: input.scope, granted_by: input.granted_by };
  const event: Event = buildEvent(
    {
      id: randomUUID(),
      at,
      actor: input.granted_by,
      kind: RIGHT_GRANTED,
      subject: input.actor,
      payload,
      caused_by: [],
      request_id: `right:${input.actor}:${input.scope}:${input.right}`,
    },
    chainHead(db),
  );
  mintRightChangeAuthority(event.id, rightChangePayloadHash(payload));
  const result = append(db, [event], { session: { actor: input.granted_by, actor_kind: 'service' } });
  if (!result.ok) return fail(result.reason_code === CODE.invalid_field || result.reason_code === CODE.no_permission ? result.reason_code : CODE.invalid_field, result.message ?? 'append rejected');
  return { ok: true };
}

// ── M4-4/A3：存量 `scope` 行的一次性背填（唯一允许的存量迁移路径） ──────────────

export interface BackfillGrantsResult {
  readonly ok: boolean;
  readonly appended: number;
  readonly skipped: number;
  readonly reason_code?: string;
  readonly message?: string;
}

interface LegacyScopeRow {
  actor: string;
  scope: string;
  right: string;
  granted_by: string;
  at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

interface PlannedRightEvent {
  readonly actor: string;
  readonly at: string;
  readonly kind: typeof RIGHT_GRANTED | typeof RIGHT_REVOKED;
  readonly subject: string;
  readonly payload: Record<string, unknown>;
  readonly request_id: string;
}

/**
 * 把旧库 `scope` 表里已有的授权行对齐成 `right.granted`/`right.revoked` 事件。
 * - 只读 `scope` 行、经唯一写入口 `append()` 落事件，**不伪造 SQL 事件**；
 * - 幂等：已有事件覆盖的 (actor,scope,right) 跳过；
 * - 已撤销行补一条 `right.revoked`，让事件流能复算出同样的 `revoked_at/revoked_by`；
 * - 按“连续同 actor”分段 append（网关要求 event.actor === session.actor）。
 */
export function backfillGrants(db: SdoDatabase, options: { at?: string } = {}): BackfillGrantsResult {
  const problems: VerifyProblem[] = [];
  let events: Event[];
  try {
    events = readEvents(db, problems);
  } catch (error) {
    return { ok: false, appended: 0, skipped: 0, reason_code: CODE.write_failed, message: String(error) };
  }
  if (problems.length > 0) {
    return {
      ok: false,
      appended: 0,
      skipped: 0,
      reason_code: CODE.event_chain_broken,
      message: problems.map((problem) => problem.code).join(','),
    };
  }
  const tracked = projectedRightRows(events).rows;
  const rows = db
    .prepare(
      'SELECT actor, scope, right, granted_by, at, revoked_at, revoked_by FROM scope ORDER BY actor, scope, right',
    )
    .all() as unknown as LegacyScopeRow[];
  const planned: PlannedRightEvent[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (tracked.has(`${row.actor}|${row.scope}|${row.right}`)) {
      skipped += 1;
      continue;
    }
    const grantAt = typeof row.at === 'string' && row.at.length > 0 ? row.at : (options.at ?? new Date().toISOString());
    planned.push({
      actor: row.granted_by,
      at: grantAt,
      kind: RIGHT_GRANTED,
      subject: row.actor,
      payload: {
        grantee: row.actor,
        right: row.right,
        scope: row.scope,
        granted_by: row.granted_by,
        legacy: true,
      },
      request_id: `right:${row.actor}:${row.scope}:${row.right}`,
    });
    if (row.revoked_at === null) continue;
    const revokedBy = typeof row.revoked_by === 'string' && row.revoked_by.length > 0 ? row.revoked_by : row.granted_by;
    planned.push({
      actor: revokedBy,
      at: row.revoked_at,
      kind: RIGHT_REVOKED,
      subject: row.actor,
      payload: {
        grantee: row.actor,
        right: row.right,
        scope: row.scope,
        revoked_by: revokedBy,
        legacy: true,
      },
      request_id: `right-revoke:${row.actor}:${row.scope}:${row.right}`,
    });
  }

  let prev = chainHead(db);
  let appended = 0;
  let index = 0;
  while (index < planned.length) {
    let end = index + 1;
    while (end < planned.length && planned[end]!.actor === planned[index]!.actor) end += 1;
    const segment: Event[] = [];
    const hashes: string[] = [];
    for (let cursor = index; cursor < end; cursor += 1) {
      const item = planned[cursor]!;
      const event = buildEvent(
        {
          id: randomUUID(),
          at: item.at,
          actor: item.actor,
          kind: item.kind,
          subject: item.subject,
          payload: item.payload,
          caused_by: [],
          request_id: item.request_id,
        },
        prev,
      );
      segment.push(event);
      hashes.push(rightChangePayloadHash(item.payload));
      prev = event.hash;
    }
    const actor = planned[index]!.actor;
    for (let cursor = 0; cursor < segment.length; cursor += 1) {
      mintRightChangeAuthority(segment[cursor]!.id, hashes[cursor]!);
    }
    const result = append(db, segment, { session: { actor, actor_kind: 'service' } });
    if (!result.ok) {
      return { ok: false, appended, skipped, reason_code: String(result.reason_code), message: result.message };
    }
    appended += segment.length;
    index = end;
  }
  return { ok: true, appended, skipped };
}
