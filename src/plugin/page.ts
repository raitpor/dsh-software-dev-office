/**
 * M5-0 C3/C13/C15：插件独立页面（127.0.0.1）。
 *
 * 不是宿主 Web UI 的一部分；在插槽可验证前先提供最小可用页面：
 * 登录/注册申请/看板/plan/签字确认。未登录一律 302 到 /login 且不发业务数据。
 * 账号与签字都在服务端完成；页面不接触 signerd socket / 状态目录。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

import type { SdoDatabase } from '../db/driver.js';
import { query } from '../query/index.js';
import type { AccountRecord, AccountSession, AccountStore } from './accounts.js';
import type { SigningService } from './signing.js';
import type { PluginRuntime } from './state.js';

export interface PageServerOptions {
  readonly runtime: PluginRuntime;
  readonly db: SdoDatabase;
  readonly accounts: AccountStore;
  readonly signing: SigningService;
  readonly port: number;
}

export interface PageServerHandle {
  readonly port: number;
  readonly host: '127.0.0.1';
  close(): Promise<void>;
}

const COOKIE_SESSION = 'sdo_session';
const COOKIE_CSRF = 'sdo_csrf';
const MAX_BODY = 16 * 1024;

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== undefined && key.length > 0) result[key] = decodeURIComponent(rest.join('='));
  }
  return result;
}

function setCookie(response: ServerResponse, name: string, value: string, httpOnly: boolean): void {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) attrs.push('HttpOnly');
  response.appendHeader('Set-Cookie', attrs.join('; '));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_BODY) throw new Error('body_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseForm(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of body.split('&')) {
    if (pair.length === 0) continue;
    const [key, ...rest] = pair.split('=');
    if (key !== undefined) result[decodeURIComponent(key.replaceAll('+', ' '))] = decodeURIComponent(rest.join('=').replaceAll('+', ' '));
  }
  return result;
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · SDO</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:920px;margin:2rem auto;padding:0 1rem;color:#1b1b1b}label{display:block;margin:.6rem 0}input,textarea{width:100%;padding:.45rem;box-sizing:border-box}button{margin-top:.8rem;padding:.45rem 1rem}pre{background:#f4f4f4;padding:1rem;overflow:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.35rem;text-align:left}.warn{color:#a00}</style></head><body>${body}</body></html>`;
}

function csrfFor(request: IncomingMessage, response: ServerResponse): string {
  const cookies = parseCookies(request.headers['cookie']);
  const existing = cookies[COOKIE_CSRF];
  if (existing !== undefined && existing.length > 0) return existing;
  const token = randomBytes(24).toString('hex');
  setCookie(response, COOKIE_CSRF, token, false);
  return token;
}

function pageLogin(csrf: string, error?: string): string {
  return layout('登录', `<h1>登录</h1>${error === undefined ? '' : `<p class="warn">${escapeHtml(error)}</p>`}
<form method="post" action="/login"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label>用户名<input name="username" autocomplete="username" required></label>
<label>口令<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">登录</button></form>
<p><a href="/register">申请注册</a></p>`);
}

function pageRegister(csrf: string, message?: string): string {
  return layout('申请注册', `<h1>申请注册</h1><p>注册是两步：先提交申请，再到对话里让 SDO 确认（人工审批）后账号才会创建。</p>
${message === undefined ? '' : `<p class="warn">${escapeHtml(message)}</p>`}
<form method="post" action="/register"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label>用户名<input name="username" required></label>
<label>口令（至少 12 位，且不含用户名）<input name="password" type="password" required></label>
<button type="submit">提交申请</button></form>
<p><a href="/login">返回登录</a></p>`);
}

function pageHome(session: AccountSession, csrf: string, rows: readonly unknown[]): string {
  return layout('看板', `<h1>看板</h1><p>已登录：<strong>${escapeHtml(session.account.username)}</strong>（${escapeHtml(session.account.role)}，${escapeHtml(session.account.actor_id)}）</p>
<nav><a href="/">看板</a> · <a href="/plan">计划</a> · <a href="/sign">签字</a></nav>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">登出</button></form>
<pre>${escapeHtml(JSON.stringify(rows, null, 2))}</pre>`);
}

function renderRows(db: SdoDatabase, view: string, account: AccountRecord): readonly unknown[] {
  try {
    const result = query(db, { view, limit: 100 }, {
      session: { actor: account.actor_id, actor_kind: 'human', session_id: 'plugin-page', credential: 'account-session' },
    });
    return result.rows;
  } catch {
    return [];
  }
}

function pageConfirm(session: AccountSession, csrf: string, summary: NonNullable<ReturnType<SigningService['summarize']>>): string {
  const claims = summary.claims.length === 0
    ? '<p>无 claim 列表</p>'
    : `<table><tr><th>claim id</th><th>标题</th><th>状态</th></tr>${summary.claims.map((claim) => `<tr><td>${escapeHtml(claim.id)}</td><td>${escapeHtml(claim.title)}</td><td>${escapeHtml(claim.status)}</td></tr>`).join('')}</table>`;
  return layout('确认签字', `<h1>确认签字</h1>
<p>当前账号：<strong>${escapeHtml(session.account.actor_id)}</strong></p>
<p>提案种类：<strong>${escapeHtml(summary.decision_kind)}</strong>；对象：<strong>${escapeHtml(summary.subject)}</strong>；取值：<strong>${escapeHtml(summary.value)}</strong></p>
<p>服务端重建命题：<strong>${escapeHtml(summary.proposition)}</strong></p>
<p>payload_hash 前 8 位：<code>${escapeHtml(summary.payload_hash_prefix)}</code></p>
${claims}
<h2>提案方叙述</h2><p>${escapeHtml(summary.narrative)}</p>
${summary.narrative_mismatch ? '<p class="warn">提案方叙述与结构化载荷不一致：默认拒绝签字。</p>' : '<p>（提案方叙述仅供参考，不是权威内容。）</p>'}
<form method="post" action="/sign"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="id" value="${escapeHtml(summary.id)}">
<label><input type="checkbox" name="confirmed" value="yes" required> 我已按上述服务端内容确认</label>
<label>签字解锁串（不会保存/回显）<input name="passphrase" type="password" required></label>
<button type="submit">解锁并签字</button></form>
<p><a href="/sign">返回待签列表</a></p>`);
}

function pageSignList(session: AccountSession, csrf: string, proposals: readonly unknown[]): string {
  return layout('签字', `<h1>待签提案</h1><p>当前账号：${escapeHtml(session.account.actor_id)}</p>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">登出</button></form>
<pre>${escapeHtml(JSON.stringify(proposals, null, 2))}</pre>
<p><a href="/">返回看板</a></p>`);
}

function requireSession(store: AccountStore, request: IncomingMessage, response: ServerResponse): AccountSession | undefined {
  const cookies = parseCookies(request.headers['cookie']);
  const session = store.resolveSession(cookies[COOKIE_SESSION]);
  if (session === undefined) {
    response.writeHead(302, { Location: '/login' });
    response.end();
    return undefined;
  }
  return session;
}

export async function startPageServer(options: PageServerOptions): Promise<PageServerHandle> {
  const { runtime, db, accounts, signing } = options;
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      runtime.log({ event: 'page_error', request_id: 'page', elapsed_ms: 0, reason: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('页面处理失败');
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (method === 'GET' && path === '/login') {
      const csrf = csrfFor(request, response);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pageLogin(csrf, url.searchParams.get('error') ?? undefined));
      return;
    }
    if (method === 'GET' && path === '/register') {
      const csrf = csrfFor(request, response);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pageRegister(csrf, url.searchParams.get('error') ?? undefined));
      return;
    }
    if (method === 'POST' && path === '/register') {
      const csrf = csrfFor(request, response);
      const form = parseForm(await readBody(request));
      if (form['csrf'] !== csrf) {
        response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(pageRegister(csrf, 'CSRF 校验失败'));
        return;
      }
      const pending = await accounts.registerPending({
        username: form['username'] ?? '',
        password: form['password'] ?? '',
        source: `plugin-page:${request.socket.remoteAddress ?? 'unknown'}`,
      });
      response.writeHead(pending.ok ? 202 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pageRegister(csrf, pending.ok
        ? `申请已提交，申请 id=${pending.id}。请到对话里让 SDO 确认（人工审批）后，再用刚设的口令登录。`
        : pending.message));
      return;
    }
    if (method === 'POST' && path === '/login') {
      const csrf = csrfFor(request, response);
      const form = parseForm(await readBody(request));
      if (form['csrf'] !== csrf) {
        response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(pageLogin(csrf, 'CSRF 校验失败'));
        return;
      }
      const ip = request.socket.remoteAddress ?? 'unknown';
      const result = await accounts.login(form['username'] ?? '', form['password'] ?? '', ip);
      if (!result.ok) {
        response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(pageLogin(csrf, result.reason_code === 'rate_limited' ? '失败次数过多，请稍后再试' : '用户名或口令错误'));
        return;
      }
      if (result.account === undefined) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('账号状态异常');
        return;
      }
      const session = accounts.createSession(result.account);
      setCookie(response, COOKIE_SESSION, session.token, true);
      response.writeHead(302, { Location: '/' });
      response.end();
      return;
    }
    if (method === 'POST' && path === '/logout') {
      const cookies = parseCookies(request.headers['cookie']);
      accounts.destroySession(cookies[COOKIE_SESSION]);
      setCookie(response, COOKIE_SESSION, '', true);
      response.writeHead(302, { Location: '/login' });
      response.end();
      return;
    }

    const session = requireSession(accounts, request, response);
    if (session === undefined) return;
    const csrf = csrfFor(request, response);

    if (method === 'GET' && path === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pageHome(session, csrf, renderRows(db, 'overview', session.account)));
      return;
    }
    if (method === 'GET' && path === '/board') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pageHome(session, csrf, renderRows(db, 'board', session.account)));
      return;
    }
    if (method === 'GET' && path === '/plan') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pageHome(session, csrf, renderRows(db, 'plan', session.account)));
      return;
    }
    if (method === 'GET' && path === '/setup') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(layout('初始化签名密钥', `<h1>初始化签名密钥</h1><p>首次使用需要设置签字解锁串；它只用于加密本机签名密钥，不保存、不回显、不落日志。</p>
<form method="post" action="/setup"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label>签字解锁串（至少 12 位）<input name="passphrase" type="password" required></label>
<button type="submit">初始化</button></form>`));
      return;
    }
    if (method === 'POST' && path === '/setup') {
      const form = parseForm(await readBody(request));
      if (form['csrf'] !== csrf) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('CSRF 校验失败');
        return;
      }
      const initialized = await signing.initialize(form['passphrase'] ?? '');
      if (initialized.ok && initialized.key_id !== undefined) {
        accounts.markKeyId(session.account.actor_id, initialized.key_id);
      }
      response.writeHead(initialized.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(layout('初始化结果', `<h1>${initialized.ok ? '已初始化' : '初始化失败'}</h1><pre>${escapeHtml(JSON.stringify(initialized, null, 2))}</pre><p><a href="/">返回</a></p>`));
      return;
    }
    if (method === 'GET' && path === '/sign') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pageSignList(session, csrf, signing.listProposals(db)));
      return;
    }
    if (method === 'GET' && path === '/sign/confirm') {
      const summary = signing.summarize(db, url.searchParams.get('id') ?? '');
      if (summary === undefined) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('提案不存在');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pageConfirm(session, csrf, summary));
      return;
    }
    if (method === 'POST' && path === '/sign') {
      const form = parseForm(await readBody(request));
      if (form['csrf'] !== csrf) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('CSRF 校验失败');
        return;
      }
      if (form['confirmed'] !== 'yes') {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('未确认');
        return;
      }
      const fresh = accounts.findAccountByActor(session.account.actor_id) ?? session.account;
      const signed = await signing.sign(
        db,
        form['id'] ?? '',
        fresh,
        form['passphrase'] ?? '',
      );
      response.writeHead(signed.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(layout('签字结果', `<h1>签字${signed.ok ? '成功' : '失败'}</h1><pre>${escapeHtml(JSON.stringify(signed, null, 2))}</pre><p><a href="/sign">返回</a></p>`));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  runtime.log({ event: 'page_listening', request_id: 'page', elapsed_ms: 0, port });
  return { port, host: '127.0.0.1', close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
