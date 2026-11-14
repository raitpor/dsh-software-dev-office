import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { verify } from '../../src/core/verify.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { failureGuidance, SigningPageService, type SigningDraft } from '../../src/sign/page.js';
import { TEST_ACTOR, TEST_PASSPHRASE, TEST_PRODUCER, type SignerdRig } from './helpers.js';
import { bumpFrontier, seedClaim, withMigratedDbAsync, withSignRig } from './page-helpers.js';

function draft(claimId: string, overrides: Partial<SigningDraft> = {}): SigningDraft {
  return {
    decision_kind: 'sign',
    claim_ids: [claimId],
    difference: 'v1 写的是 3 秒，v2 写的是 2 秒',
    consequence: '将以 v2 为准，`sdo_check` 按 2 秒判',
    actor: TEST_ACTOR,
    producer: TEST_PRODUCER,
    ...overrides,
  };
}

/** 每个用例：真 signerd + 已迁移库 + 一条 claim；回调拿 (db, service, claimId)。 */
async function withPage(
  rigOptions: Parameters<typeof withSignRig>[0],
  run: (
    db: SdoDatabase,
    service: SigningPageService,
    claimId: string,
    rig: SignerdRig,
  ) => Promise<void>,
  pageOptions: { readonly now?: () => Date } = {},
): Promise<void> {
  await withSignRig(rigOptions, async (rig: SignerdRig) => {
    await withMigratedDbAsync(async (db) => {
      const claimId = seedClaim(db).claimId;
      // 确定性时钟：默认让 created_at 严格递增；需要“同毫秒创建”的用例可覆盖。
      let tick = Date.parse('2026-11-14T00:00:00.000Z');
      const service = new SigningPageService({
        db,
        client: rig.client,
        now: pageOptions.now ?? (() => new Date((tick += 1000))),
      });
      await run(db, service, claimId, rig);
    });
  });
}

async function unlock(service: SigningPageService): Promise<void> {
  const outcome = await service.unlock({ actor: TEST_ACTOR, passphrase: TEST_PASSPHRASE });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
}

function countDecision(db: SdoDatabase, kind: string): number {
  return (db.prepare('SELECT count(*) AS n FROM decision WHERE decision_kind = ?').get(kind) as { n: number }).n;
}

function confirmItem(
  service: SigningPageService,
  item: { id: string; proposition: string; payload_hash: string },
  actor = TEST_ACTOR,
) {
  return service.confirm({
    requestId: item.id,
    actor,
    proposition: item.proposition,
    payloadHash: item.payload_hash,
  });
}

test('C1 篡改命题 ⇒ no_blind_sign，且 0 个 decision 行', async () => {
  await withPage({}, async (db, service, claimId) => {
    await unlock(service);
    const created = await service.createRequest(draft(claimId));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const bad = await service.confirm({
      requestId: created.item.id,
      actor: TEST_ACTOR,
      proposition: '模型自己写的摘要：一切正常',
      payloadHash: created.item.payload_hash,
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.reason_code, 'no_blind_sign');
      assert.match(bad.message, /claim 渲染器/);
    }
    assert.equal(countDecision(db, 'sign'), 0);
  });
});

test('C1 正常路径：服务端按 claim 渲染，落 decision.valid+signed 且 verify 绿', async () => {
  await withPage({}, async (db, service, claimId) => {
    await unlock(service);
    const created = await service.createRequest(draft(claimId));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.match(created.item.proposition, /done=true/);
    const confirmed = await confirmItem(service, created.item);
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    if (!confirmed.ok || confirmed.staged) return;
    assert.ok(confirmed.decision);
    assert.equal(confirmed.decision.frontier, created.item.frontier);
    const kinds = db
      .prepare("SELECT kind FROM event WHERE kind IN ('decision.valid','decision.signed') ORDER BY rowid")
      .all()
      .map((row) => String((row as Record<string, unknown>)['kind']));
    assert.deepEqual(kinds, ['decision.valid', 'decision.signed']);
    assert.equal(service.publicPending().length, 0);
    assert.equal(service.costs().length, 1);
    assert.equal(verify(db).ok, true);
  });
});

test('C2 两段式不可绕：payload_hash 与预览不一致 ⇒ payload_changed', async () => {
  await withPage({ ttl: '5' }, async (db, service, claimId) => {
    await unlock(service);
    const first = await service.createRequest(draft(claimId));
    const second = await service.createRequest(draft(claimId, { difference: '换一个差异，hash 应该变' }));
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.notEqual(first.item.payload_hash, second.item.payload_hash);
    const confirm = await service.confirm({
      requestId: first.item.id,
      actor: TEST_ACTOR,
      proposition: first.item.proposition,
      payloadHash: second.item.payload_hash,
    });
    assert.equal(confirm.ok, false);
    if (!confirm.ok) assert.equal(confirm.reason_code, 'payload_changed');
    assert.equal(countDecision(db, 'sign'), 0);
  });
});

test('C3 单条（TTL=0）：解锁 + 确认共 2 次人工交互', async () => {
  await withPage({}, async (_db, service, claimId) => {
    const created = await service.createRequest(draft(claimId));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await unlock(service);
    const confirmed = await confirmItem(service, created.item);
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    if (!confirmed.ok || confirmed.staged) return;
    assert.equal(confirmed.interactions, 2);
    const cost = service.costs()[0]!;
    assert.equal(cost.interactions, 2);
    assert.equal(cost.window_reused, false);
    assert.ok(cost.signerd_unlock_wait_ms >= 0);
    assert.ok(cost.sign_ms >= 0);
  });
});

test('C3 会话式批量（TTL>0）：preview 3 → 1 解锁 → 3 逐条确认 → 一次提交', async () => {
  await withPage({ ttl: '5' }, async (db, service, claimId) => {
    const items = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await service.createRequest(draft(claimId));
      assert.equal(created.ok, true);
      if (!created.ok) return;
      items.push(created.item);
    }
    const frontier = items[0]!.frontier;
    assert.equal(new Set(items.map((item) => item.frontier)).size, 1);
    await unlock(service);
    const first = await confirmItem(service, items[0]!);
    const second = await confirmItem(service, items[1]!);
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.staged, true);
    assert.equal(second.staged, true);
    assert.equal(second.pending_count, 1);
    assert.equal(countDecision(db, 'sign'), 0, '提交前不允许任何 decision 行');
    const third = await confirmItem(service, items[2]!);
    assert.equal(third.ok, true, JSON.stringify(third));
    if (!third.ok) return;
    assert.equal(third.staged, true, '批量最后一条确认完也要等人点“提交这批”');
    assert.equal(countDecision(db, 'sign'), 0, '提交之前不落库');
    const submitted = await service.submit();
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    if (!submitted.ok) return;
    assert.equal(submitted.staged, false);
    assert.equal(countDecision(db, 'sign'), 3);
    const rows = db.prepare('SELECT frontier FROM decision WHERE decision_kind = ?').all('sign') as {
      frontier: string;
    }[];
    assert.deepEqual(
      rows.map((row) => row.frontier),
      [frontier, frontier, frontier],
    );
    const costs = service.costs();
    assert.deepEqual(
      costs.map((cost) => cost.interactions),
      [2, 1, 1],
    );
    assert.deepEqual(
      costs.map((cost) => cost.window_reused),
      [false, true, true],
    );
    assert.equal(costs[1]!.page_unlock_wait_ms, 0);
    assert.equal(costs[2]!.page_unlock_wait_ms, 0);
    assert.equal(costs[1]!.signerd_unlock_wait_ms, 0);
    assert.equal(costs[2]!.signerd_unlock_wait_ms, 0);
    const since = costs.map((cost) => cost.signerd_since_last_unlock_ms);
    assert.ok(since[0]! >= 0);
    for (let index = 1; index < since.length; index += 1) {
      assert.ok(since[index]! >= since[index - 1]!, `since_last_unlock_ms 必须单调不减：${String(since)}`);
    }
    assert.equal(verify(db).ok, true);
  });
});

test('P2-1 TTL=0 多条目：confirm 拒 ttl_requires_window，0 个 decision，会话进 needs_window', async () => {
  await withPage({}, async (db, service, claimId) => {
    const items = [];
    for (let index = 0; index < 2; index += 1) {
      const created = await service.createRequest(draft(claimId));
      assert.equal(created.ok, true);
      if (!created.ok) return;
      items.push(created.item);
    }
    await unlock(service); // ttl=0
    const rejected = await confirmItem(service, items[0]!);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.reason_code, 'ttl_requires_window');
      assert.equal(rejected.staged, 0);
      assert.equal(rejected.requested, 2);
      assert.match(rejected.message, /TTL=0/);
    }
    assert.equal(countDecision(db, 'sign'), 0);
    const failed = await confirmItem(service, items[1]!);
    assert.equal(failed.ok, false);
    const status = await service.status();
    assert.equal(status.needs_window, true);
  });
});

test('P2-1 TTL=0 解锁后再 createRequest 加第二条 ⇒ 拒', async () => {
  await withPage({}, async (db, service, claimId) => {
    const first = await service.createRequest(draft(claimId));
    assert.equal(first.ok, true);
    await unlock(service); // ttl=0
    const second = await service.createRequest(draft(claimId, { difference: '第二条' }));
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason_code, 'ttl_requires_window');
      assert.equal(second.requested, 2);
    }
    assert.equal(countDecision(db, 'sign'), 0);
    const status = await service.status();
    assert.equal(status.needs_window, true);
  });
});

test('P2-2 两个时长字段：第 2 条起 unlock_wait_ms=0，since_last_unlock_ms 单调不减', async () => {
  await withPage({ ttl: '5' }, async (_db, service, claimId) => {
    const items = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await service.createRequest(draft(claimId));
      assert.equal(created.ok, true);
      if (!created.ok) return;
      items.push(created.item);
    }
    await unlock(service);
    for (const item of items) {
      const confirmed = await confirmItem(service, item);
      assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    }
    const submitted = await service.submit();
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const costs = service.costs();
    assert.equal(costs.length, 3);
    assert.equal(costs[0]!.signerd_unlock_wait_ms >= 0, true);
    assert.equal(costs[1]!.signerd_unlock_wait_ms, 0);
    assert.equal(costs[2]!.signerd_unlock_wait_ms, 0);
    const since = costs.map((cost) => cost.signerd_since_last_unlock_ms);
    assert.ok(since[0]! >= 0);
    for (let index = 1; index < since.length; index += 1) {
      assert.ok(since[index]! >= since[index - 1]!, `since_last_unlock_ms 必须单调不减：${String(since)}`);
    }
  });
});

test('P2-1 成本三字段逐条等于 signerd 回执真值（变异 C/G 必红）', async () => {
  await withPage({ ttl: '5' }, async (_db, service, claimId, rig) => {
    const items = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await service.createRequest(draft(claimId));
      assert.equal(created.ok, true);
      if (!created.ok) return;
      items.push(created.item);
    }
    await unlock(service);
    // 让首条 unlock_wait_ms 明确大于 0，避免同毫秒实现下 >=0 恒真。
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const item of items) {
      const confirmed = await confirmItem(service, item);
      assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    }
    const submitted = await service.submit();
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const receipts = readFileSync(rig.paths.receiptsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        decision_id: string;
        unlock_wait_ms: number;
        since_last_unlock_ms?: number;
        sign_ms: number;
      });
    const costs = service.costs();
    assert.equal(costs.length, 3);
    for (const cost of costs) {
      const receipt = receipts.find((entry) => entry.decision_id === cost.decision_id);
      assert.ok(receipt !== undefined, `receipt missing for ${cost.decision_id}`);
      // 三字段必须逐条等于回执真值：恒 12345（变异 C）或恒 0（变异 G）都会红。
      assert.equal(cost.signerd_unlock_wait_ms, receipt.unlock_wait_ms);
      assert.equal(cost.signerd_since_last_unlock_ms, receipt.since_last_unlock_ms ?? 0);
      assert.equal(cost.sign_ms, receipt.sign_ms);
    }
    assert.ok(costs[0]!.signerd_unlock_wait_ms > 0, '首条必须真的等过解锁');
    assert.deepEqual(
      costs.map((cost) => cost.signerd_unlock_wait_ms),
      [costs[0]!.signerd_unlock_wait_ms, 0, 0],
    );
  });
});

test('P2-2 同窗口重复 unlock：interactions = 解锁 POST 数 + 本次确认 = 3', async () => {
  await withPage({ ttl: '5' }, async (db, service, claimId) => {
    const items = [];
    for (let index = 0; index < 2; index += 1) {
      const created = await service.createRequest(draft(claimId));
      assert.equal(created.ok, true);
      if (!created.ok) return;
      items.push(created.item);
    }
    await unlock(service);
    await unlock(service); // 人重复点了一次解锁（多一次 POST）
    const first = await confirmItem(service, items[0]!);
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;
    assert.equal(first.interactions, 3, '首条确认返回也必须是 解锁2次 + 确认1次');
    const second = await confirmItem(service, items[1]!);
    assert.equal(second.ok, true, JSON.stringify(second));
    if (!second.ok) return;
    assert.equal(second.interactions, 1);
    const submitted = await service.submit();
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const costs = service.costs();
    assert.deepEqual(
      costs.map((cost) => cost.interactions),
      [3, 1],
    );
    assert.equal(countDecision(db, 'sign'), 2);
  });
});

test('P2 乱序确认：成本归因按实际签名顺序（sign_seq），不按创建顺序', async () => {
  await withPage({ ttl: '5' }, async (db, service, claimId) => {
    const items = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await service.createRequest(draft(claimId));
      assert.equal(created.ok, true);
      if (!created.ok) return;
      items.push(created.item);
    }
    await unlock(service);
    // 确认顺序 2 → 1 → 3（创建顺序 1 → 2 → 3）
    for (const item of [items[1]!, items[0]!, items[2]!]) {
      const confirmed = await confirmItem(service, item);
      assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    }
    assert.equal(countDecision(db, 'sign'), 0, '提交前不落库');
    const submitted = await service.submit();
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(countDecision(db, 'sign'), 3);
    const costs = service.costs();
    assert.deepEqual(
      costs.map((cost) => cost.sign_seq),
      [0, 1, 2],
    );
    // 真等了解锁的是“第一个真正签的”（items[1]），不是创建最早的 items[0]。
    assert.equal(costs[0]!.request_id, items[1]!.id);
    assert.equal(costs[0]!.interactions, 2);
    for (const cost of costs.slice(1)) {
      assert.equal(cost.interactions, 1);
      assert.equal(cost.page_unlock_wait_ms, 0);
    }
    assert.equal(costs[0]!.page_unlock_wait_ms, costs[0]!.signerd_unlock_wait_ms);
    assert.equal(verify(db).ok, true);
  });
});

test('P2 同毫秒创建：created_at 相同也不影响按 sign_seq 归因', async () => {
  const frozen = () => new Date('2026-11-14T00:00:00.000Z');
  await withPage(
    { ttl: '5' },
    async (db, service, claimId) => {
      const items = [];
      for (let index = 0; index < 3; index += 1) {
        const created = await service.createRequest(draft(claimId));
        assert.equal(created.ok, true);
        if (!created.ok) return;
        items.push(created.item);
      }
      assert.equal(new Set(items.map((item) => item.created_at)).size, 1, '三条必须同 created_at');
      await unlock(service);
      for (const item of items) {
        const confirmed = await confirmItem(service, item);
        assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
      }
      const submitted = await service.submit();
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      const costs = service.costs();
      assert.deepEqual(
        costs.map((cost) => cost.sign_seq),
        [0, 1, 2],
      );
      assert.deepEqual(
        costs.map((cost) => cost.request_id),
        items.map((item) => item.id),
      );
      assert.equal(costs[0]!.interactions, 2);
      assert.equal(costs[1]!.interactions, 1);
      assert.equal(costs[2]!.interactions, 1);
      assert.equal(countDecision(db, 'sign'), 3);
    },
    { now: frozen },
  );
});

test('P3 全部确认后、submit 前注入事件 ⇒ frontier_stale、整批 0 条', async () => {
  await withPage({ ttl: '5' }, async (db, service, claimId) => {
    const items = [];
    for (let index = 0; index < 2; index += 1) {
      const created = await service.createRequest(draft(claimId));
      assert.equal(created.ok, true);
      if (!created.ok) return;
      items.push(created.item);
    }
    await unlock(service);
    for (const item of items) {
      const confirmed = await confirmItem(service, item);
      assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    }
    assert.equal(countDecision(db, 'sign'), 0);
    bumpFrontier(db);
    const submitted = await service.submit();
    assert.equal(submitted.ok, false);
    if (!submitted.ok) assert.equal(submitted.reason_code, 'frontier_stale');
    assert.equal(countDecision(db, 'sign'), 0);
  });
});

test('C1 同一 subject 的 claim 取值变化 ⇒ 重新预览的命题随之变化', async () => {
  await withPage({}, async (db, service, claimId) => {
    const first = await service.createRequest(draft(claimId));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    // claim 行是 append-only（005 触发器）：用同 subject、不同取值的新 claim 行模拟“claim 变了”。
    const row = db.prepare('SELECT subject, as_of_frontier, derived_by, actor, at FROM claim WHERE id = ?').get(claimId) as {
      subject: string;
      as_of_frontier: string;
      derived_by: string;
      actor: string;
      at: string;
    };
    const { canonicalJson } = await import('../../src/core/fold/canonical.js');
    const { writeClaimRows } = await import('../../src/claim/gateway.js');
    const altId = 'claim:TEST-CHANGED';
    const written = writeClaimRows(db, [
      {
        id: altId,
        subject: row.subject,
        predicate: 'done',
        value: canonicalJson({ code: 'done', value: false }),
        as_of_frontier: row.as_of_frontier,
        derived_by: row.derived_by,
        actor: row.actor,
        at: row.at,
      },
    ]);
    assert.equal(written.ok, true, JSON.stringify(written));
    const changed = await service.createRequest(draft(altId));
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.notEqual(changed.item.proposition, first.item.proposition, 'claim 取值变化必须进入命题');
    assert.match(changed.item.proposition, /done=false/, '命题必须来自 claim 渲染器，而不是被复用');
  });
});

test('P3 stageDecision 直接调用也强制 baseline 的 will_change/guarantee_delta', async () => {
  const { stageDecision } = await import('../../src/sign/decision.js');
  const { chainHead } = await import('../../src/db/write.js');
  await withSignRig({}, async (rig) => {
    await withMigratedDbAsync(async (db) => {
      const claimId = seedClaim(db).claimId;
      const result = await stageDecision(db, rig.client, {
        decision_kind: 'baseline',
        subject: 'baseline B1',
        value: '冻结',
        evidence: [claimId],
        difference: '旧尺子 → 新尺子',
        consequence: '冻结后按新尺子判',
        actor: TEST_ACTOR,
        actor_kind: 'human',
        producer: TEST_PRODUCER,
        channel: 'ui',
        frontier: chainHead(db),
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason_code, 'no_blind_sign');
    });
  });
});

test('C3 显式提交：两条逐条确认后 submit() 一次落库', async () => {
  await withPage({ ttl: '5' }, async (db, service, claimId) => {
    const items = [];
    for (let index = 0; index < 2; index += 1) {
      const created = await service.createRequest(draft(claimId));
      assert.equal(created.ok, true);
      if (!created.ok) return;
      items.push(created.item);
    }
    await unlock(service);
    const first = await confirmItem(service, items[0]!);
    const second = await confirmItem(service, items[1]!);
    assert.equal(first.ok && second.ok, true);
    assert.equal(service.publicPending().length, 2, '确认完但未提交时，待签项仍在会话里');
    assert.equal(countDecision(db, 'sign'), 0, 'submit 之前不落库');
    const submitted = await service.submit();
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    if (!submitted.ok) return;
    assert.equal(submitted.staged, false);
    assert.equal(countDecision(db, 'sign'), 2);
    assert.equal(service.publicPending().length, 0);
    assert.equal(verify(db).ok, true);
  });
});

test('C5 TTL>0 窗口内 frontier 变 ⇒ frontier_stale 且要求重新解锁', async () => {
  await withPage({ ttl: '5' }, async (db, service, claimId) => {
    await unlock(service);
    const created = await service.createRequest(draft(claimId));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    bumpFrontier(db);
    const statusAfterBump = await service.status();
    assert.ok(statusAfterBump.stale_count >= 1);
    assert.equal(statusAfterBump.awaiting_unlock, true);
    const confirmed = await confirmItem(service, created.item);
    assert.equal(confirmed.ok, false);
    if (!confirmed.ok) assert.equal(confirmed.reason_code, 'frontier_stale');
    const status = await service.status();
    assert.equal(status.locked, true);
    assert.ok(status.stale_count >= 1);
    assert.equal(status.awaiting_unlock, true);
    await service.abandon();
    assert.equal(service.publicPending().length, 0);
  });
});

test('C5 会话式批量负例：确认期间外部注入事件 ⇒ 提交时整批拒、0 decision、回执 consumed', async () => {
  await withPage({ ttl: '5' }, async (db, service, claimId) => {
    const items = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await service.createRequest(draft(claimId));
      assert.equal(created.ok, true);
      if (!created.ok) return;
      items.push(created.item);
    }
    await unlock(service);
    const first = await confirmItem(service, items[0]!);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.staged, true);
    bumpFrontier(db);
    const second = await confirmItem(service, items[1]!);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason_code, 'frontier_stale');
    assert.equal(countDecision(db, 'sign'), 0, '整批拒：一条 decision 都不能落库');
    const pending = service.publicPending();
    assert.equal(pending.length, 3, '会话保留但全部标记 stale，需重新预览');
    assert.ok(pending.every((item) => item.stale));
    const third = await confirmItem(service, items[2]!);
    assert.equal(third.ok, false);
    await service.abandon();
    assert.equal(service.publicPending().length, 0);
  });
});

test('C6 四种失败都有可读文案与下一步，且不泄露密钥材料', async () => {
  await withPage({}, async (db, service, claimId) => {
    const beforeUnlock = await service.createRequest(draft(claimId));
    assert.equal(beforeUnlock.ok, true);
    if (!beforeUnlock.ok) return;
    const notUnlocked = await confirmItem(service, beforeUnlock.item);
    assert.equal(notUnlocked.ok, false);
    if (!notUnlocked.ok) assert.equal(notUnlocked.reason_code, 'awaiting_unlock');

    const blind = await service.confirm({
      requestId: beforeUnlock.item.id,
      actor: TEST_ACTOR,
      proposition: '摘要',
      payloadHash: beforeUnlock.item.payload_hash,
    });
    assert.equal(blind.ok, false);
    if (!blind.ok) assert.equal(blind.reason_code, 'no_blind_sign');

    const changed = await service.confirm({
      requestId: beforeUnlock.item.id,
      actor: TEST_ACTOR,
      proposition: beforeUnlock.item.proposition,
      payloadHash: 'sha256:deadbeef',
    });
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.reason_code, 'payload_changed');

    await unlock(service);
    const agentAttempt = await service.confirm({
      requestId: beforeUnlock.item.id,
      actor: 'a-dev-7f3a',
      actorKind: 'agent',
      proposition: beforeUnlock.item.proposition,
      payloadHash: beforeUnlock.item.payload_hash,
    });
    assert.equal(agentAttempt.ok, false);
    if (!agentAttempt.ok) assert.equal(agentAttempt.reason_code, 'not_a_signer');
    assert.ok(
      (db.prepare("SELECT count(*) AS n FROM event WHERE kind = 'security.alert'").get() as { n: number }).n >= 1,
    );

    for (const code of ['awaiting_unlock', 'not_a_signer', 'no_blind_sign', 'payload_changed']) {
      const guidance = failureGuidance(code);
      assert.ok(guidance.title.length > 0, `${code} 缺 title`);
      assert.ok(guidance.next.length > 0, `${code} 缺 next`);
    }
    const serialized = JSON.stringify([notUnlocked, agentAttempt, blind, changed]);
    assert.doesNotMatch(serialized, /BEGIN|PRIVATE KEY/i);
    assert.equal(countDecision(db, 'sign'), 0);
  });
});

test('C4 签字成本是真实测量：注入 signerd 延迟会反映在 sign_ms', async () => {
  let fastSignMs = -1;
  let slowSignMs = -1;
  await withPage({}, async (_db, service, claimId) => {
    await unlock(service);
    const created = await service.createRequest(draft(claimId));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const confirmed = await confirmItem(service, created.item);
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    if (confirmed.ok && !confirmed.staged) fastSignMs = confirmed.cost!.sign_ms;
  });
  await withPage({ signDelayMs: 120 }, async (_db, service, claimId) => {
    await unlock(service);
    const created = await service.createRequest(draft(claimId));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const confirmed = await confirmItem(service, created.item);
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    if (confirmed.ok && !confirmed.staged) {
      const cost = confirmed.cost!;
      slowSignMs = cost.sign_ms;
      assert.ok(slowSignMs >= 100, `sign_ms=${String(slowSignMs)} 应包含注入的 120ms`);
      assert.ok(cost.page_total_ms >= 0);
    }
  });
  assert.ok(fastSignMs >= 0);
  assert.ok(slowSignMs > fastSignMs, `慢=${String(slowSignMs)} 应大于 快=${String(fastSignMs)}`);
});

test('C8 签字页没有批量入口：confirm 只接受一个 request_id', async () => {
  await withPage({}, async (_db, service, claimId) => {
    await unlock(service);
    const created = await service.createRequest(draft(claimId));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const bogus = await service.confirm({
      requestId: `${created.item.id},another`,
      actor: TEST_ACTOR,
      proposition: created.item.proposition,
      payloadHash: created.item.payload_hash,
    });
    assert.equal(bogus.ok, false);
    if (!bogus.ok) assert.equal(bogus.reason_code, 'invalid_request');
    assert.equal(service.publicPending().length, 1);
  });
});
