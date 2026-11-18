/** M5-0 C13–C17：账号、bootstrap、页面与双人证签字。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AccountStore, SESSION_IDLE_MS } from '../../src/plugin/accounts.js';
import { AGENT_GRANTS, ensureHumanBootstrap, ensurePluginBootstrap, HUMAN_GRANTS, PLUGIN_AGENT_ACTOR } from '../../src/plugin/bootstrap.js';
import { activatePlugin, type PluginContext } from '../../src/plugin/index.js';
import type { ApprovalOutcome } from '../../src/plugin/tools.js';
import { makeDb } from './helpers.js';

function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'sdo-m5-accounts-'));
}

test('C13 accounts: Argon2id、挂起确认、首账号 admin、限速、篡改与 TTL', async () => {
  const dir = tempState();
  let clock = Date.parse('2026-11-18T10:00:00.000Z');
  const store = new AccountStore(dir, { now: () => new Date(clock) });
  store.load();

  assert.equal((await store.registerPending({ username: 'alice', password: 'short', source: 't' })).ok, false);
  assert.equal((await store.registerPending({ username: 'alice', password: 'alice-alice-alice-1', source: 't' })).ok, false);
  const pending = await store.registerPending({ username: 'alice', password: 'correct-horse-battery', source: 'test' });
  assert.equal(pending.ok, true);
  assert.equal(store.pendingCount, 1);
  const denied = await store.confirmPending({ pending_id: pending.id ?? '', allowed: false, approval_id: 'a1' });
  assert.equal(denied.ok, false);
  assert.equal(store.accountCount, 0);

  const allowed = await store.confirmPending({ pending_id: pending.id ?? '', allowed: true, approval_id: 'approval-1' });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.account?.role, 'admin');
  assert.match(String(allowed.account?.actor_id), /^user:/);
  assert.match(String(allowed.account?.password_hash), /^\$argon2id\$/);
  assert.equal(store.accountCount, 1);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await store.login('alice', 'wrong-password-12', '10.0.0.1');
    assert.equal(failed.reason_code, 'invalid_field');
  }
  const limited = await store.login('alice', 'correct-horse-battery', '10.0.0.1');
  assert.equal(limited.reason_code, 'rate_limited');
  const ok = await store.login('alice', 'correct-horse-battery', '10.0.0.2');
  assert.equal(ok.ok, true);
  const session = store.createSession(ok.account!);
  assert.equal(store.resolveSession(session.token)?.account.username, 'alice');
  assert.equal(store.csrfValid(session, session.csrf), true);
  assert.equal(store.csrfValid(session, 'forged'), false);
  clock += SESSION_IDLE_MS + 1;
  assert.equal(store.resolveSession(session.token), undefined);

  const other = new AccountStore(dir, { now: () => new Date(clock) });
  other.load();
  const fresh = await other.registerPending({ username: 'bob', password: 'quiet-otter-cipher-12', source: 't' });
  const raw = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8')) as { pending: Array<Record<string, unknown>> };
  const target = raw.pending.find((item) => item['id'] === fresh.id);
  assert.ok(target);
  target['username'] = 'mallory';
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify(raw), { mode: 0o600 });
  const tampered = new AccountStore(dir, { now: () => new Date(clock) });
  tampered.load();
  assert.throws(() => tampered.getPending(String(fresh.id)), /pending_registration_tampered/);
});

test('C16 bootstrap: agent/human 只补缺失 grant，撤销后不复活', () => {
  const fixture = makeDb();
  try {
    ensurePluginBootstrap(fixture.db);
    ensurePluginBootstrap(fixture.db);
    const agentEvents = fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM event WHERE kind='right.granted' AND subject=?",
    ).get(PLUGIN_AGENT_ACTOR) as { n: number };
    assert.equal(agentEvents.n, AGENT_GRANTS.length);
    ensureHumanBootstrap(fixture.db, 'user:test-human');
    ensureHumanBootstrap(fixture.db, 'user:test-human');
    const humanEvents = fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM event WHERE kind='right.granted' AND subject=?",
    ).get('user:test-human') as { n: number };
    assert.equal(humanEvents.n, HUMAN_GRANTS.length);
    fixture.db.prepare("UPDATE scope SET revoked_at='2026-11-18T00:00:00.000Z' WHERE actor=? AND right='sign' AND scope='domain:core'").run('user:test-human');
    ensureHumanBootstrap(fixture.db, 'user:test-human');
    const after = fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM event WHERE kind='right.granted' AND subject='user:test-human'",
    ).get() as { n: number };
    assert.equal(after.n, HUMAN_GRANTS.length, '撤销行不触发 re-grant');
  } finally {
    fixture.close();
  }
});

function fakeContext(outcome: ApprovalOutcome): {
  ctx: PluginContext;
  tools: ReturnType<typeof activatePlugin> extends Promise<infer T> ? (T extends { tools: infer U } ? U : never) : never;
} {
  const tools: Array<{ name: string; execute: (args: unknown, exec: { callId?: string }) => Promise<unknown> }> = [];
  const ctx: PluginContext = {
    tools: {
      register(definition) {
        tools.push(definition as unknown as (typeof tools)[number]);
        return () => undefined;
      },
    },
    approval: { request: async () => outcome },
    effect: () => () => undefined,
  };
  return { ctx, tools: tools as never };
}

function cookieOf(response: Response): string {
  return (response.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ');
}

function csrfFrom(body: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(body);
  assert.ok(match, '页面必须带 CSRF token');
  return match[1] ?? '';
}

async function postForm(url: string, cookie: string, fields: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie.length === 0 ? {} : { cookie }) },
    body: new URLSearchParams(fields).toString(),
  });
}

test('C13/C15 页面：注册挂起→审批确认→登录→未登录不泄数据→看板含 T-C15', async () => {
  const home = tempState();
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const savedActor = process.env['SDO_PLUGIN_ACTOR'];
  delete process.env['SDO_PLUGIN_ACTOR'];
  try {
    const { ctx, tools } = fakeContext('allowed-once');
    const plugin = await activatePlugin(ctx, { project_dir: tempState(), console: true, console_port: 0 }, {});
    try {
      assert.ok(plugin.consolePort !== undefined);
      const base = `http://127.0.0.1:${String(plugin.consolePort)}`;
      const registerPage = await fetch(`${base}/register`, { redirect: 'manual' });
      const regCookie = cookieOf(registerPage);
      const regHtml = await registerPage.text();
      const csrf = csrfFrom(regHtml);
      const registered = await postForm(`${base}/register`, regCookie, {
        csrf, username: 'alice', password: 'correct-horse-battery',
      });
      assert.equal(registered.status, 202);
      const registeredHtml = await registered.text();
      const pendingId = /申请 id=([^。]+)。/.exec(registeredHtml)?.[1];
      assert.ok(pendingId, '页面必须返回挂起申请 id');
      const confirm = tools.find((tool) => tool.name === 'sdo_account_confirm');
      assert.ok(confirm);
      const confirmed = await confirm.execute({ pending_id: pendingId }, { callId: 'approval-call-1' }) as { ok: boolean };
      assert.equal(confirmed.ok, true);

      const unauthenticated = await fetch(`${base}/board`, { redirect: 'manual' });
      assert.equal(unauthenticated.status, 302);
      assert.equal(unauthenticated.headers.get('location'), '/login');
      assert.doesNotMatch(await unauthenticated.text(), /T-C15/);

      const loginPage = await fetch(`${base}/login`, { redirect: 'manual' });
      const loginCookie = cookieOf(loginPage);
      const loginHtml = await loginPage.text();
      const login = await postForm(`${base}/login`, `${loginCookie}; ${csrf === '' ? '' : ''}`, {
        csrf: csrfFrom(loginHtml), username: 'alice', password: 'correct-horse-battery',
      });
      assert.equal(login.status, 302);
      const sessionCookie = cookieOf(login);
      assert.match(sessionCookie, /sdo_session=/);

      const append = tools.find((tool) => tool.name === 'sdo_append');
      assert.ok(append);
      const appended = await append.execute({
        events: [{
          kind: 'task.created',
          subject: 'T-C15',
          payload: { seq: 1, title: 'T-C15', kind: 'implement', status: 'planned', scope_paths: [] },
        }],
      }, { callId: 'c15-append' }) as { ok: boolean };
      assert.equal(appended.ok, true);
      const board = await fetch(`${base}/board`, { headers: { cookie: sessionCookie }, redirect: 'manual' });
      assert.equal(board.status, 200);
      assert.match(await board.text(), /T-C15/);
    } finally {
      await plugin.dispose();
    }
  } finally {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    if (savedActor === undefined) delete process.env['SDO_PLUGIN_ACTOR'];
    else process.env['SDO_PLUGIN_ACTOR'] = savedActor;
  }
});

test('C14 双人证：页面初始化→提案→确认页重建→unlock→签；signer=账号 actor', async () => {
  const home = tempState();
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const savedActor = process.env['SDO_PLUGIN_ACTOR'];
  delete process.env['SDO_PLUGIN_ACTOR'];
  try {
    const { ctx, tools } = fakeContext('allowed-once');
    const plugin = await activatePlugin(ctx, { project_dir: tempState(), console: true, console_port: 0 }, {});
    try {
      const base = `http://127.0.0.1:${String(plugin.consolePort)}`;
      const registerPage = await fetch(`${base}/register`, { redirect: 'manual' });
      const regCookie = cookieOf(registerPage);
      const csrf = csrfFrom(await registerPage.text());
      const registered = await postForm(`${base}/register`, regCookie, { csrf, username: 'alice', password: 'correct-horse-battery' });
      const pendingId = /申请 id=([^。]+)。/.exec(await registered.text())?.[1] ?? '';
      const confirm = tools.find((tool) => tool.name === 'sdo_account_confirm');
      assert.ok(confirm);
      assert.equal((await confirm.execute({ pending_id: pendingId }, { callId: 'approve-1' }) as { ok: boolean }).ok, true);

      const loginPage = await fetch(`${base}/login`, { redirect: 'manual' });
      const loginCookie = cookieOf(loginPage);
      const login = await postForm(`${base}/login`, loginCookie, {
        csrf: csrfFrom(await loginPage.text()), username: 'alice', password: 'correct-horse-battery',
      });
      const sessionCookie = cookieOf(login);
      assert.match(sessionCookie, /sdo_session=/);

      const setupPage = await fetch(`${base}/setup`, { headers: { cookie: sessionCookie } });
      const setupCookie = [sessionCookie, cookieOf(setupPage)].filter((item) => item.length > 0).join('; ');
      const setupCsrf = csrfFrom(await setupPage.text());
      const setup = await postForm(`${base}/setup`, setupCookie, {
        csrf: setupCsrf, passphrase: 'signing-unlock-passphrase',
      });
      assert.equal(setup.status, 200);

      const append = tools.find((tool) => tool.name === 'sdo_append');
      assert.ok(append);
      const proposed = await append.execute({
        events: [{
          kind: 'request_sign',
          subject: 'T-C15',
          payload: {
            decision_kind: 'sign',
            subject: 'T-C15',
            value: 'accept',
            evidence: ['verify ok'],
            difference: '首次签字',
            consequence: '接受该结果',
            narrative: '提案方叙述：T-C15 定为 accept',
          },
        }],
      }, { callId: 'proposal-1' }) as { ok: boolean; proposal_id?: string };
      assert.equal(proposed.ok, true, JSON.stringify(proposed));
      assert.ok(proposed.proposal_id);

      const confirmPage = await fetch(`${base}/sign/confirm?id=${encodeURIComponent(proposed.proposal_id ?? '')}`, {
        headers: { cookie: sessionCookie },
      });
      assert.equal(confirmPage.status, 200);
      const confirmCookie = [sessionCookie, cookieOf(confirmPage)].filter((item) => item.length > 0).join('; ');
      const confirmHtml = await confirmPage.text();
      assert.match(confirmHtml, /T-C15/);
      assert.match(confirmHtml, /payload_hash 前 8 位/);
      assert.match(confirmHtml, /服务端重建命题/);
      const confirmCsrf = csrfFrom(confirmHtml);

      const signed = await postForm(`${base}/sign`, confirmCookie, {
        csrf: confirmCsrf, id: proposed.proposal_id ?? '', confirmed: 'yes',
        passphrase: 'signing-unlock-passphrase',
      });
      const signedHtml = await signed.text();
      assert.equal(signed.status, 200, signedHtml);
      assert.match(signedHtml, /签字成功/);
      const rawJson = (/<pre>([\s\S]*?)<\/pre>/.exec(signedHtml)?.[1] ?? '{}')
        .replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
      const decision = JSON.parse(rawJson) as {
        outcome?: { signer?: string }; ok?: boolean;
      };
      assert.equal(decision.ok, true);
      assert.match(String(decision.outcome?.signer), /^user:/);
    } finally {
      await plugin.dispose();
    }
  } finally {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    if (savedActor === undefined) delete process.env['SDO_PLUGIN_ACTOR'];
    else process.env['SDO_PLUGIN_ACTOR'] = savedActor;
  }
});
