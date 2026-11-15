/**
 * M2-G · 读数公共装配：真 signerd + 已迁移临时库 + 签字页服务。
 *
 * 纪律：不碰 ~/.local/state/sdo/（bootSignerd 把 HOME 指到临时目录），
 * 所有库都在 mkdtemp 出的临时目录；读数只取产品路径返回的码/计数/回执，不硬编码。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootSignerd, TEST_ACTOR, TEST_PASSPHRASE, TEST_PRODUCER } from '../../../lib/test/sign/helpers.js';
import { SigningPageService } from '../../../lib/src/sign/page.js';
import { openSdoDatabase } from '../../../lib/src/db/open.js';
import { runMigrations } from '../../../lib/src/db/migrate.js';
import { append, chainHead } from '../../../lib/src/db/write.js';
import { computeEventHash } from '../../../lib/src/core/verify-events.js';
import { expectedClaimRow, writeClaimRows } from '../../../lib/src/claim/gateway.js';

export const AT = '2026-11-15T09:00:00.000Z';
export { TEST_ACTOR, TEST_PASSPHRASE, TEST_PRODUCER };

export function seedClaim(db, taskId, claimNo) {
  // claim 只能经写网关；event 由写网关落库（非空库的来源之一）。
  const prev = chainHead(db);
  const unsigned = {
    id: `ev-m2g-task-${taskId}`,
    at: AT,
    actor: 'm2g-fixture',
    kind: 'task.created',
    subject: taskId,
    payload: { seq: Number(taskId.split('-')[1] ?? 1), title: 't', kind: 'implement' },
    caused_by: [],
    request_id: `rq-${taskId}`,
    prev,
    hash: '',
  };
  const event = { ...unsigned, hash: computeEventHash(unsigned) };
  const result = append(db, [event]);
  if (!result.ok) throw new Error(`m2g append failed: ${result.message ?? result.reason_code}`);
  // claim 行也走 claim 网关（C2：读数脚本不许测试直插）。
  const row = expectedClaimRow(
    {
      claim_no: claimNo,
      task_id: taskId,
      predicate: 'done',
      value: true,
      renderer: 'renderer:gate-result',
      actor: 'alice',
      at: AT,
    },
    [event.id],
  );
  const written = writeClaimRows(db, [row]);
  if (!written.ok) throw new Error(`m2g claim failed: ${written.message ?? written.reason_code}`);
  return row.id;
}

export function draft(claimIds, actorKind) {
  return {
    decision_kind: 'sign',
    claim_ids: claimIds,
    difference: 'v1 写 3 秒，v2 写 2 秒',
    consequence: '将以 v2 为准',
    actor: TEST_ACTOR,
    producer: TEST_PRODUCER,
    channel: 'ui',
    ...(actorKind === undefined ? {} : { actor_kind: actorKind }),
  };
}

/** 一次读数运行：真 signerd（可注入 TTL/时钟）+ 已迁移临时库 + 签字页服务。 */
export async function withSignPage(options, run) {
  const rig = await bootSignerd({
    ttl: options.ttl ?? '0',
    ...(options.signDelayMs === undefined ? {} : { signDelayMs: options.signDelayMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m2g-'));
  const db = openSdoDatabase(join(dir, 'sdo.db'), 'm2-g-readings-passphrase');
  try {
    runMigrations(db);
    let tick = Date.parse(AT);
    const service = new SigningPageService({
      db,
      client: rig.client,
      ...(options.realClock === true
        ? {}
        : { now: options.pageNow ?? (() => new Date((tick += 1000))) }),
      channel: 'ui',
    });
    return await run({ db, rig, service, dir });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    await rig.close();
  }
}

export function count(db, sql, ...params) {
  return Number(db.prepare(sql).get(...params)['n']);
}

export function decisionCount(db) {
  return count(db, 'SELECT count(*) AS n FROM decision');
}

export function eventCount(db) {
  return count(db, 'SELECT count(*) AS n FROM event');
}

export async function createAndConfirm(service, claimIds, overrides = {}) {
  const created = await service.createRequest({ ...draft(claimIds), ...overrides });
  if (!created.ok) return { ok: false, reason_code: created.reason_code, stage: 'create' };
  const confirmed = await service.confirm({
    requestId: created.item.id,
    actor: TEST_ACTOR,
    proposition: overrides.forgedProposition ?? created.item.proposition,
    payloadHash: created.item.payload_hash,
    ...(overrides.actorKind === undefined ? {} : { actorKind: overrides.actorKind }),
  });
  return { ...confirmed, item: created.item };
}

export function reason(outcome) {
  return outcome.ok ? 'ok' : String(outcome.reason_code);
}
