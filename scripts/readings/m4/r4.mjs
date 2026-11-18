/**
 * M4-G / C4 · R4 预占：预占期内 `task.claimed.actor` 必须 = `task.assigned.reserved_by`。
 *
 * 事件级判据（本读数的主证据）：claim 前读 task 投影的 reserved_by，claim 后读
 * `task.claimed` 事件的 actor，逐条比对；`bypass = actor !== reserved_by` 的条数要求 0。
 * `verify()` 只作旁证，并注明其 `lease_actor_mismatch` 量的是“claim actor vs 活租约
 * actor”，不是 reserved_by。
 *
 * 变异：`M4_G_MUTATION=R4` 让 bob 在 alice 的预占下认领（走同一产品 claim 路径）；
 * 若网关前置守卫拒绝，则读数照样 fail（没有成功认领），raw 会给出真实失败码。
 */
import { rmSync } from 'node:fs';

import { verify } from '../../../lib/src/core/verify.js';
import { appendSeeds, assignedSeed, openFixtureDb, taskSeed, tmpDbPath } from './helpers.mjs';
import { claimWithLease, currentState } from '../../../lib/test/db/append-helpers.js';

const CARD = 'CARD-M4G-R4';
const mutation = process.env['M4_G_MUTATION'] === 'R4';
const RESERVED_BY = 'alice';
const CLAIM_ACTOR = mutation ? 'bob' : 'alice';
const CLAIM_AT = '2026-11-17T11:00:00.000Z';

/**
 * 变异专用：绕过产品写路径（含 claim guard），直接注入一条 `task.claimed` 事件行，
 * 检验读数的事件级比对能否抓到 `actor != reserved_by`。只允许在变异模式使用。
 */
function injectForgedClaim(db) {
  const head = db.prepare('SELECT hash FROM event ORDER BY rowid DESC LIMIT 1').get();
  const prev = head === undefined ? 'genesis' : head.hash;
  db.prepare(`INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
    VALUES (?, ?, ?, 'task.claimed', ?, ?, '[]', ?, ?, ?)`)
    .run('e-forged-r4-claim', CLAIM_AT, 'bob', CARD, JSON.stringify({ lease_id: 'lease-forged-r4' }), 'req-forged-r4', prev, 'hash-forged-r4');
  return { claim: { ok: true, reason_code: null, message: null } };
}

export async function r4() {
  const { dir, path } = tmpDbPath('r4');
  let db;
  try {
    db = openFixtureDb(path);
    appendSeeds(db, [
      taskSeed(CARD, ['src/agent/']),
      assignedSeed(CARD, RESERVED_BY, '2026-11-17T12:00:00.000Z'),
    ]);
    const reservedByBefore = currentState(db).tables.task?.[CARD]?.reserved_by ?? null;
    const claimed = mutation
      ? injectForgedClaim(db)
      : claimWithLease(db, { card: CARD, actor: CLAIM_ACTOR, at: CLAIM_AT, scope: 'module:core' });

    const claimRows = db
      .prepare("SELECT actor, payload FROM event WHERE kind = 'task.claimed' AND subject = ? ORDER BY rowid")
      .all(CARD);
    const claims = claimRows.map((row) => ({
      actor: row.actor,
      reserved_by_before_claim: reservedByBefore,
      bypass: row.actor !== reservedByBefore,
    }));
    const bypassCount = claims.filter((claim) => claim.bypass).length;

    const verified = verify(db);
    const leaseActorCodes = verified.problems.filter((problem) => problem.code === 'lease_actor_mismatch').length;
    const pass = claimed.claim.ok === true
      && reservedByBefore !== null
      && claims.length >= 1
      && bypassCount === 0;

    return {
      id: 'R4',
      question: '预占期内认领者（task.claimed.actor）是否 = 预占值（task.assigned.reserved_by），绕过条数是否为 0？',
      command: 'node scripts/m4-readings.mjs --only R4',
      measured: {
        reserved_by_before_claim: reservedByBefore,
        claim_actor: CLAIM_ACTOR,
        claim_ok: claimed.claim.ok,
        claim_reason: claimed.claim.ok ? null : claimed.claim.reason_code,
        claims,
        bypass_count: bypassCount,
        verify_ok: verified.ok,
        verify_problems: verified.problems,
        verify_lease_actor_mismatch: leaseActorCodes,
        verify_scope_note: 'verify 的 lease_actor_mismatch 量的是 claim actor vs 活租约 actor，不是 reserved_by；预占判据见 claims[]。',
        mutation: mutation ? 'bob-claims-under-alice-reservation' : null,
        observation: '单次 verify 代替每日报（M4-G A2）',
      },
      verdict: pass ? 'pass' : 'fail',
      caveat: pass
        ? '预占比对取事件级：assign 后投影 reserved_by 与 task.claimed.actor 逐条比；verify 仅旁证（量租约 actor，不是预占值）。'
        : mutation
          ? `变异让 bob 在 alice 预占下认领：claims[] 出现 actor≠reserved_by（或 claim 被真实守卫拒绝，claim_reason=${claimed.claim.ok ? 'null' : claimed.claim.reason_code}），读数 fail。`
          : '不达标：预占值/认领 actor/绕过条数至少一项不符，见 measured.claims。',
    };
  } finally {
    if (db !== undefined) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
