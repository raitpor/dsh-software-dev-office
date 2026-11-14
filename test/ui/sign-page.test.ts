import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { SigningPageService } from '../../src/sign/page.js';
import { createSigningServer } from '../../src/ui/sign-server.js';
import { seedClaim, withMigratedDbAsync, withSignRig } from '../sign/page-helpers.js';
import { TEST_ACTOR, TEST_PASSPHRASE, TEST_PRODUCER, type SignerdRig } from '../sign/helpers.js';

interface RunningPage {
  readonly base: string;
  readonly close: () => Promise<void>;
}

function startPage(service: SigningPageService): Promise<RunningPage> {
  const server: Server = createSigningServer({ service });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done, reject) => {
            server.close((error) => (error === undefined ? done() : reject(error)));
          }),
      });
    });
  });
}

test('签字页 HTTP：GET /sign 渲染四元组表单、无“全部同意”、只绑 127.0.0.1', async () => {
  await withSignRig({}, async (rig: SignerdRig) => {
    await withMigratedDbAsync(async (db) => {
      seedClaim(db);
      const service = new SigningPageService({ db, client: rig.client });
      const page = await startPage(service);
      try {
        const response = await fetch(`${page.base}/sign`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /text\/html/);
        const html = await response.text();
        assert.match(html, /data-page="sign"/);
        assert.match(html, /data-frontier/);
        assert.doesNotMatch(html, /全部同意|approve_all/);
        const address = new URL(page.base);
        assert.equal(address.hostname, '127.0.0.1');
      } finally {
        await page.close();
      }
    });
  });
});

test('签字页 HTTP：preview → unlock → confirm 得到 decision，成本表可见', async () => {
  await withSignRig({}, async (rig: SignerdRig) => {
    await withMigratedDbAsync(async (db) => {
      const claimId = seedClaim(db).claimId;
      const service = new SigningPageService({ db, client: rig.client });
      const page = await startPage(service);
      try {
        const created = await fetch(`${page.base}/sign/requests`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision_kind: 'sign',
            claim_ids: [claimId],
            difference: 'v1 写 3 秒，v2 写 2 秒',
            consequence: '以 v2 为准',
            actor: TEST_ACTOR,
            producer: TEST_PRODUCER,
          }),
        });
        const createdBody = (await created.json()) as { ok: boolean; item: { id: string; proposition: string; payload_hash: string } };
        assert.equal(createdBody.ok, true);

        const unlocked = await fetch(`${page.base}/sign/unlock`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor: TEST_ACTOR, passphrase: TEST_PASSPHRASE }),
        });
        assert.equal(((await unlocked.json()) as { ok: boolean }).ok, true);

        const confirmed = await fetch(`${page.base}/sign/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            request_id: createdBody.item.id,
            actor: TEST_ACTOR,
            proposition: createdBody.item.proposition,
            payload_hash: createdBody.item.payload_hash,
          }),
        });
        const confirmedBody = (await confirmed.json()) as { ok: boolean; decision_id: string | null };
        assert.equal(confirmedBody.ok, true);
        assert.match(confirmedBody.decision_id ?? '', /^dec-/);

        const costs = await fetch(`${page.base}/sign/costs`);
        const costsBody = (await costs.json()) as { ok: boolean; costs: unknown[] };
        assert.equal(costsBody.ok, true);
        assert.equal(costsBody.costs.length, 1);

        const html = await (await fetch(`${page.base}/sign`)).text();
        assert.match(html, /data-page="sign"/);
      } finally {
        await page.close();
      }
    });
  });
});

test('签字页 HTTP：未知路径 404、非 GET/POST 405、批量字段被拒', async () => {
  await withSignRig({}, async (rig: SignerdRig) => {
    await withMigratedDbAsync(async (db) => {
      seedClaim(db);
      const service = new SigningPageService({ db, client: rig.client });
      const page = await startPage(service);
      try {
        const missing = await fetch(`${page.base}/nope`);
        assert.equal(missing.status, 404);
        const method = await fetch(`${page.base}/sign`, { method: 'DELETE' });
        assert.equal(method.status, 405);
        const batch = await fetch(`${page.base}/sign/requests`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ request_ids: ['a', 'b'], actor: TEST_ACTOR }),
        });
        const batchBody = (await batch.json()) as { ok: boolean; reason_code: string };
        assert.equal(batchBody.ok, false);
        assert.equal(batchBody.reason_code, 'invalid_request');
      } finally {
        await page.close();
      }
    });
  });
});
