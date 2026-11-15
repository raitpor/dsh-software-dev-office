/**
 * 控制台只读 HTTP 服务（M0-5，C1/C3/C4）。
 *
 * - 只绑 `127.0.0.1`（由调用方/`serve.ts` 决定 host），只处理 `GET`；
 * - 页面数据全部经 `src/ui/pages.ts` 的 `query(view,args)`，本文件不 prepare SQL、不写库；
 * - 零依赖：只用 `node:http` 与仓库内相对 import（不 import 宿主包）。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { SdoDatabase } from '../db/driver.js';
import { loadBoardPage, loadOverviewPage, loadPlanPage } from './pages.js';
import type { ConsoleAccess, PageModel } from './pages.js';
import { dbRightsPort } from '../core/pm/access.js';
import type { ActorKind, Session } from '../core/auth/session.js';
import { renderError, renderNotFound, renderPage } from './render.js';

export interface ConsoleServerOptions {
  readonly db: SdoDatabase;
  /** 读取权限；M0 没有登录身份，由启动方固定（默认 decider，见卡「已知边界」）。 */
  readonly right?: unknown;
  /**
   * M3-5/M3-6：控制台身份（`SDO_CONSOLE_ACTOR`，**必填**）。M3-1 起 query 只认 session，
   * 没有身份就没有可展示的读数；控制台拒绝在无身份时启动/装载（Lead m06490 P1，fail-closed）。
   */
  readonly actor: string;
  /** M3-6：控制台会话的 `actor_kind`（`SDO_CONSOLE_ACTOR_KIND`，缺省 human）。 */
  readonly actorKind?: ActorKind;
}

type PageLoader = (db: SdoDatabase, right: unknown, access?: ConsoleAccess) => PageModel;

function consoleSession(actor: string, kind: ActorKind): Session {
  return { actor, actor_kind: kind, session_id: `console:${actor}`, credential: 'SDO_CONSOLE_ACTOR' };
}

function accessOf(db: SdoDatabase, options: ConsoleServerOptions): ConsoleAccess {
  const actor = options.actor.trim();
  const kind = options.actorKind ?? 'human';
  // 收口（Lead m06236 ①）：权限只来自真库 grant；无 grant ⇒ deny-all（绝不回退静态席位表）。
  return { actor, rights: dbRightsPort(db, actor), session: consoleSession(actor, kind) };
}

const ROUTES: ReadonlyMap<string, PageLoader> = new Map<string, PageLoader>([
  ['/', loadOverviewPage],
  ['/board', loadBoardPage],
  ['/plan', loadPlanPage],
]);

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
}

function sendText(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  response.end(body);
}

async function handle(request: IncomingMessage, response: ServerResponse, options: ConsoleServerOptions): Promise<void> {
  const method = request.method ?? 'GET';
  const pathname = (request.url ?? '/').split('?')[0] ?? '/';

  if (method !== 'GET' && method !== 'HEAD') {
    sendText(response, 405, '405 Method Not Allowed：控制台只读，只接受 GET。\n', { allow: 'GET, HEAD' });
    return;
  }

  const loader = ROUTES.get(pathname);
  if (loader === undefined) {
    sendHtml(response, 404, renderNotFound(pathname));
    return;
  }

  try {
    const page = loader(options.db, options.right ?? 'decider', accessOf(options.db, options));
    sendHtml(response, 200, renderPage(page));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendHtml(response, 500, renderError(`读取 ${pathname} 失败：${message}`));
  }
}

/**
 * 创建一个只读控制台服务。调用方负责 `listen`/`close`（测试用随机端口，CLI 用 4173）。
 *
 * 传入的 `db` 生命周期归调用方；server 自己不打开/关闭数据库。
 */
export function createConsoleServer(options: ConsoleServerOptions): Server {
  if (typeof options.actor !== 'string' || options.actor.trim() === '') {
    throw new Error(
      '控制台需要会话身份：请设置 SDO_CONSOLE_ACTOR（及 SDO_CONSOLE_ACTOR_KIND），没有身份时拒绝启动（fail-closed）',
    );
  }
  const server = createServer((request, response) => {
    void handle(request, response, options);
  });
  return server;
}
