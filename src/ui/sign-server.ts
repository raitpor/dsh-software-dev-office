import { CODE } from '../core/errors/codes.js';
/**
 * M2-6 签字页 HTTP 壳（node:http，零第三方依赖；C7/C8）。
 *
 * 路由：GET /sign（页面）、GET /sign/status、GET /sign/costs、
 * POST /sign/requests（生成待签 preview）、POST /sign/unlock、POST /sign/confirm。
 * 只绑 127.0.0.1（由 sign-serve.ts 决定）；一次 confirm 只接受一个 request_id，
 * 出现 all / request_ids / batch 等批量字段直接拒（docs/06 禁“全部同意”式盲签）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { SigningDraft, SigningPageService } from '../sign/page.js';
import { failureGuidance } from '../sign/page.js';
import { renderSigningFailurePage, renderSigningPage } from './sign-render.js';

export interface SigningServerOptions {
  readonly service: SigningPageService;
}

const MAX_BODY_BYTES = 256 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(text);
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(html);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBatchShape(body: Record<string, unknown>): boolean {
  return (
    body['all'] !== undefined ||
    body['request_ids'] !== undefined ||
    body['batch'] !== undefined ||
    body['approve_all'] !== undefined ||
    body['selection'] !== undefined
  );
}

export function createSigningServer(options: SigningServerOptions): Server {
  const { service } = options;

  async function renderPage(response: ServerResponse, failure?: string, message?: string): Promise<void> {
    const status = await service.status();
    const view = service.sessionView();
    const guidance =
      failure === undefined
        ? view.guidance
        : { ...view.guidance, [failure]: failureGuidance(failure) };
    sendHtml(
      response,
      200,
      renderSigningPage({
        status,
        pending: view.pending,
        guidance,
        costs: service.costs(),
        ...(failure === undefined ? {} : { failure, failureMessage: message ?? '' }),
      }),
    );
  }

  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      if (method === 'GET' || method === 'HEAD') {
        if (path === '/sign') {
          await renderPage(response);
          return;
        }
        if (path === '/sign/status') {
          sendJson(response, 200, { ok: true, ...(await service.status()) });
          return;
        }
        if (path === '/sign/costs') {
          sendJson(response, 200, { ok: true, costs: service.costs() });
          return;
        }
        if (path === '/') {
          response.statusCode = 302;
          response.setHeader('location', '/sign');
          response.end();
          return;
        }
        sendHtml(response, 404, renderSigningFailurePage('页面不存在', '签字页在 /sign。'));
        return;
      }
      if (method !== 'POST') {
        response.statusCode = 405;
        response.setHeader('allow', 'GET, HEAD, POST');
        sendJson(response, 405, { ok: false, reason_code: CODE.invalid_request, message: '只接受 GET/HEAD/POST' });
        return;
      }
      const raw = await readBody(request);
      let body: Record<string, unknown>;
      if ((request.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(raw));
      } else {
        let parsed: unknown;
        try {
          parsed = raw.length === 0 ? {} : JSON.parse(raw);
        } catch {
          sendJson(response, 400, { ok: false, reason_code: CODE.invalid_request, message: '请求不是合法 JSON' });
          return;
        }
        if (!isRecord(parsed)) {
          sendJson(response, 400, { ok: false, reason_code: CODE.invalid_request, message: '请求体必须是 JSON 对象' });
          return;
        }
        body = parsed;
      }
      if (hasBatchShape(body)) {
        sendJson(response, 200, {
          ok: false,
          reason_code: CODE.invalid_request,
          message: '签字页不支持批量/“全部同意”提交；一次只签一条',
        });
        return;
      }
      if (path === '/sign/requests') {
        const claimIds = body['claim_ids'];
        if (typeof body['decision_kind'] !== 'string' || typeof body['actor'] !== 'string' || typeof body['producer'] !== 'string') {
          sendJson(response, 200, { ok: false, reason_code: CODE.invalid_request, message: '缺少 decision_kind/actor/producer' });
          return;
        }
        if (!Array.isArray(claimIds) || claimIds.some((id) => typeof id !== 'string')) {
          sendJson(response, 200, { ok: false, reason_code: CODE.invalid_request, message: 'claim_ids 必须是字符串数组' });
          return;
        }
        const draft: SigningDraft = {
          decision_kind: body['decision_kind'] as SigningDraft['decision_kind'],
          claim_ids: claimIds as string[],
          difference: String(body['difference'] ?? ''),
          consequence: String(body['consequence'] ?? ''),
          actor: body['actor'],
          producer: body['producer'],
          ...(Array.isArray(body['will_change'])
            ? { will_change: (body['will_change'] as unknown[]).filter((line): line is string => typeof line === 'string') }
            : {}),
          ...(isRecord(body['guarantee_delta'])
            ? { guarantee_delta: body['guarantee_delta'] as Record<string, string> }
            : {}),
        };
        const created = await service.createRequest(draft);
        if (!created.ok) {
          const guidance = failureGuidance(created.reason_code);
          sendJson(response, 200, { ...created, guidance });
          return;
        }
        sendJson(response, 200, { ok: true, item: created.item });
        return;
      }
      if (path === '/sign/unlock') {
        const actor = body['actor'];
        const passphrase = body['passphrase'];
        if (typeof actor !== 'string' || typeof passphrase !== 'string') {
          sendJson(response, 200, { ok: false, reason_code: CODE.invalid_request, message: '缺少 actor/passphrase' });
          return;
        }
        const outcome = await service.unlock({ actor, passphrase });
        if (!outcome.ok) {
          sendJson(response, 200, { ...outcome, guidance: failureGuidance(outcome.reason_code) });
          return;
        }
        sendJson(response, 200, { ...outcome, interactions: 1 });
        return;
      }
      if (path === '/sign/submit') {
        const submitted = await service.submit();
        if (!submitted.ok) {
          sendJson(response, 200, { ...submitted, guidance: failureGuidance(submitted.reason_code) });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          staged: false,
          decision_id: submitted.decision?.decision_id ?? null,
          receipt_id: submitted.decision?.receipt_id ?? null,
          signer: submitted.decision?.signer ?? null,
          interactions: submitted.interactions,
          cost: submitted.cost ?? null,
        });
        return;
      }
      if (path === '/sign/abandon') {
        await service.abandon();
        sendJson(response, 200, { ok: true, pending_count: 0 });
        return;
      }
      if (path === '/sign/confirm') {
        const requestId = body['request_id'];
        const proposition = body['proposition'];
        const payloadHash = body['payload_hash'];
        const actor = body['actor'];
        if (typeof requestId !== 'string' || typeof proposition !== 'string' || typeof payloadHash !== 'string') {
          sendJson(response, 200, {
            ok: false,
            reason_code: CODE.invalid_request,
            message: '确认必须带 request_id/proposition/payload_hash',
          });
          return;
        }
        const confirmed = await service.confirm({
          requestId,
          actor: typeof actor === 'string' ? actor : '',
          proposition,
          payloadHash,
        });
        if (!confirmed.ok) {
          sendJson(response, 200, { ...confirmed, guidance: failureGuidance(confirmed.reason_code) });
          return;
        }
        if (confirmed.staged || confirmed.decision === undefined) {
          sendJson(response, 200, {
            ok: true,
            staged: true,
            interactions: confirmed.interactions,
            pending_count: confirmed.pending_count,
          });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          staged: false,
          decision_id: confirmed.decision.decision_id,
          receipt_id: confirmed.decision.receipt_id,
          signer: confirmed.decision.signer,
          interactions: confirmed.interactions,
          cost: confirmed.cost ?? null,
        });
        return;
      }
      sendHtml(response, 404, renderSigningFailurePage('页面不存在', '签字页在 /sign。'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      sendHtml(response, 500, renderSigningFailurePage('签字页内部错误', message));
    }
  });
  return server;
}
