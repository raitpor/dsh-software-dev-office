/**
 * 工具面（M5-0 C2/C9）：只读工具不写库；写工具只经 `append(db, events, {session})`。
 *
 * 身份只来自插件配置/宿主进程环境，工具参数里没有 actor/session 入口；缺身份时
 * 所有工具 fail-closed 返回结构化拒绝，不做匿名放行。
 */

import type { Session } from '../core/auth/session.js';
import type { Event } from '../core/fold/types.js';
import { CODE } from '../core/errors/codes.js';
import { verify } from '../core/verify.js';
import { buildEvent } from '../db/freeze-store.js';
import type { SdoDatabase } from '../db/driver.js';
import { append, chainHead } from '../db/write.js';
import { query, type QueryArgs } from '../query/index.js';
import type { PluginRuntime } from './state.js';
import type { AccountStore } from './accounts.js';
import type { SigningService } from './signing.js';
import { ensureHumanBootstrap } from './bootstrap.js';

export interface ToolRun {
  readonly callId?: string;
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface PluginApprovalService {
  request(input: {
    readonly toolName: string;
    readonly callId?: string;
    readonly displayReason?: Readonly<Record<string, string>>;
    readonly agent?: unknown;
  }): Promise<ApprovalOutcome>;
}

export interface PluginToolServices {
  readonly accounts?: AccountStore;
  readonly signing?: SigningService;
  readonly approval?: PluginApprovalService;
}

interface ToolOutput {
  readonly schema: Record<string, unknown>;
  render(args: unknown, value: unknown): unknown[];
}

export interface PluginTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: ToolOutput;
  execute(args: unknown, exec: ToolRun): Promise<unknown>;
}

function textBlock(value: unknown): unknown[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failure(reason_code: string, message: string): Record<string, unknown> {
  return { ok: false, reason_code, message };
}

interface SessionFailure {
  readonly error: Record<string, unknown>;
}

export function sessionFor(runtime: PluginRuntime, callId: string): Session | undefined {
  const actor = runtime.settings.actor;
  if (actor === undefined || actor.length === 0) return undefined;
  return { actor, actor_kind: runtime.settings.actorKind, session_id: `plugin:${callId}`, credential: 'plugin-config' };
}

function requireSession(runtime: PluginRuntime, exec: ToolRun): Session | SessionFailure {
  const callId = exec.callId ?? 'tool-call';
  const session = sessionFor(runtime, callId);
  if (session === undefined) {
    runtime.log({ event: 'tool_no_session', request_id: callId, elapsed_ms: 0, tool: 'sdo' });
    return { error: failure('no_permission', '插件未配置 actor：工具面需要身份（SDO_PLUGIN_ACTOR / config.actor）') };
  }
  return session;
}

function openDb(
  runtime: PluginRuntime,
  exec: ToolRun,
  tool: string,
): { readonly db: SdoDatabase } | { readonly error: Record<string, unknown> } {
  try {
    return { db: runtime.open() };
  } catch {
    runtime.log({
      event: 'tool_db_unavailable',
      request_id: exec.callId ?? 'tool-call',
      elapsed_ms: 0,
      tool,
    });
    return { error: failure('no_permission', '数据库不可用：检查 SDO_DB_PASSPHRASE 与库路径') };
  }
}

export function buildTools(runtime: PluginRuntime, services: PluginToolServices = {}): readonly PluginTool[] {
  const tools: PluginTool[] = [
    {
      name: 'sdo_query',
      description: 'Query an SDO view through the catalog (read-only; never raw SQL).',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', description: 'catalog view name' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          cursor: { type: 'string' },
          select: { type: 'array', items: { type: 'string' } },
        },
        required: ['view'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textBlock(value) },
      async execute(args, exec) {
        const input = record(args) ?? {};
        const session = requireSession(runtime, exec);
        if ('error' in session) return session.error;
        if (typeof input['view'] !== 'string' || input['view'].length === 0) {
          return failure('invalid_field', 'view is required');
        }
        const opened = openDb(runtime, exec, 'sdo_query');
        if ('error' in opened) return opened.error;
        const started = Date.now();
        const queryArgs: QueryArgs = {
          view: input['view'],
          ...(typeof input['limit'] === 'number' ? { limit: input['limit'] } : {}),
          ...(typeof input['cursor'] === 'string' ? { cursor: input['cursor'] } : {}),
          ...(Array.isArray(input['select'])
            ? { select: input['select'].filter((item): item is string => typeof item === 'string') }
            : {}),
        };
        const parsed = query(opened.db, queryArgs, { session });
        runtime.log({
          event: 'tool_call',
          request_id: exec.callId ?? 'tool-call',
          elapsed_ms: Date.now() - started,
          tool: 'sdo_query',
          view: input['view'],
        });
        return { ok: true, result: parsed };
      },
    },
    {
      name: 'sdo_verify',
      description: 'Run the SDO event-chain/projection verify and return structured problems.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => textBlock(value) },
      async execute(_args, exec) {
        const session = requireSession(runtime, exec);
        if ('error' in session) return session.error;
        const opened = openDb(runtime, exec, 'sdo_verify');
        if ('error' in opened) return opened.error;
        const started = Date.now();
        const report = verify(opened.db);
        runtime.log({
          event: 'tool_call',
          request_id: exec.callId ?? 'tool-call',
          elapsed_ms: Date.now() - started,
          tool: 'sdo_verify',
        });
        return {
          ok: true,
          verify: {
            ok: report.ok,
            eventCount: report.eventCount,
            problems: report.problems.slice(0, 20),
            problemCount: report.problems.length,
          },
        };
      },
    },
    {
      name: 'sdo_status',
      description: 'Read plugin/database status (path, schema version, verify summary).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => textBlock(value) },
      async execute(_args, exec) {
        const session = requireSession(runtime, exec);
        if ('error' in session) return session.error;
        const opened = openDb(runtime, exec, 'sdo_status');
        if ('error' in opened) return opened.error;
        const started = Date.now();
        const eventCount = verify(opened.db).eventCount;
        runtime.log({
          event: 'tool_call',
          request_id: exec.callId ?? 'tool-call',
          elapsed_ms: Date.now() - started,
          tool: 'sdo_status',
        });
        return {
          ok: true,
          db_path: runtime.getDbPath(),
          user_version: runtime.userVersion(),
          version: runtime.getVersion(),
          actor: runtime.settings.actor ?? null,
          event_count: eventCount,
        };
      },
    },
    {
      name: 'sdo_append',
      description: 'Append SDO events through the write gateway; actor comes from the plugin session, never from arguments.',
      parameters: {
        type: 'object',
        properties: {
          events: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                subject: { type: 'string' },
                payload: { type: 'object' },
                caused_by: { type: 'array', items: { type: 'string' } },
              },
              required: ['kind', 'subject', 'payload'],
              additionalProperties: false,
            },
          },
        },
        required: ['events'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textBlock(value) },
      async execute(args, exec) {
        const input = record(args) ?? {};
        const session = requireSession(runtime, exec);
        if ('error' in session) return session.error;
        const rawEvents = input['events'];
        if (!Array.isArray(rawEvents) || rawEvents.length === 0 || rawEvents.length > 20) {
          return failure('invalid_field', 'events must be a non-empty array (max 20)');
        }
        const opened = openDb(runtime, exec, 'sdo_append');
        if ('error' in opened) return opened.error;
        const db = opened.db;
        const requestId = exec.callId ?? 'tool-call';
        const proposalRaw = rawEvents.find((raw) => record(raw)?.['kind'] === 'request_sign');
        if (proposalRaw !== undefined) {
          if (services.signing === undefined) return failure('approval_unavailable', '签字服务不可用');
          if (session.actor_kind !== 'agent') return failure('not_a_signer', '提案只能由 agent 通道发起');
          const item = record(proposalRaw) ?? {};
          const payload = record(item['payload']) ?? {};
          const result = services.signing.propose(db, { actor: session.actor, actor_kind: 'agent' }, {
            decision_kind: String(payload['decision_kind'] ?? 'sign') as never,
            subject: String(payload['subject'] ?? item['subject'] ?? ''),
            value: String(payload['value'] ?? ''),
            evidence: Array.isArray(payload['evidence']) ? payload['evidence'].map(String) : [],
            difference: String(payload['difference'] ?? ''),
            consequence: String(payload['consequence'] ?? ''),
            ...(record(payload['extra']) === undefined ? {} : { extra: record(payload['extra']) }),
            ...(Array.isArray(payload['claim_ids']) ? { claim_ids: payload['claim_ids'].map(String) } : {}),
            ...(typeof payload['narrative'] === 'string' ? { narrative: payload['narrative'] } : {}),
            ...(typeof payload['task_id'] === 'string' ? { task_id: payload['task_id'] } : {}),
          });
          runtime.log({ event: 'tool_call', request_id: requestId, elapsed_ms: 0, tool: 'sdo_append', ok: result.ok });
          return result;
        }
        const at = new Date().toISOString();
        let prev = chainHead(db);
        const events: Event[] = [];
        for (const [index, raw] of rawEvents.entries()) {
          const item = record(raw);
          if (item === undefined || typeof item['kind'] !== 'string' || typeof item['subject'] !== 'string') {
            return failure('invalid_field', `events[${String(index)}] needs kind/subject/payload`);
          }
          const partial = {
            id: `${requestId}#${String(index)}`,
            at,
            actor: session.actor,
            kind: item['kind'],
            subject: item['subject'],
            payload: item['payload'],
            caused_by: Array.isArray(item['caused_by'])
              ? item['caused_by'].filter((id): id is string => typeof id === 'string')
              : [],
            request_id: requestId,
          };
          const event = buildEvent(partial, prev);
          events.push(event);
          prev = event.hash;
        }
        const result = append(db, events, { session });
        runtime.log({
          event: 'tool_call',
          request_id: requestId,
          elapsed_ms: 0,
          tool: 'sdo_append',
          ok: result.ok,
        });
        return result;
      },
    },
  ];
  if (services.accounts !== undefined && services.approval !== undefined) {
    tools.push({
      name: 'sdo_account_confirm',
      description: 'Confirm a pending human account registration via host approval; never creates an account without allowed-once.',
      parameters: {
        type: 'object',
        properties: { pending_id: { type: 'string' } },
        required: ['pending_id'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textBlock(value) },
      async execute(args, exec) {
        const session = requireSession(runtime, exec);
        if ('error' in session) return session.error;
        if (session.actor_kind !== 'agent') return failure('not_a_signer', '账号确认只能由 agent 通道发起');
        const input = record(args) ?? {};
        const pendingId = input['pending_id'];
        if (typeof pendingId !== 'string' || pendingId.length === 0) return failure('invalid_field', 'pending_id is required');
        const accounts = services.accounts;
        const approval = services.approval;
        if (accounts === undefined || approval === undefined) return failure('approval_unavailable', '账号服务不可用');
        accounts.load();
        let pending;
        try {
          pending = accounts.getPending(pendingId);
        } catch {
          return failure('pending_registration_tampered', '挂起申请被篡改');
        }
        if (pending === undefined) return failure('approval_required', '挂起申请不存在或已过期');
        const opened = openDb(runtime, exec, 'sdo_account_confirm');
        if ('error' in opened) return opened.error;
        const snapshot = `用户名=${pending.username}；角色建议=${pending.role_suggestion}；来源=${pending.source}；申请 id=${pending.id}；提交方无法验证`;
        let outcome: ApprovalOutcome;
        try {
          outcome = await approval.request({
            toolName: 'sdo_account_confirm',
            ...(exec.callId === undefined ? {} : { callId: exec.callId }),
            displayReason: { en: snapshot, zh: snapshot },
          });
        } catch {
          outcome = 'unavailable';
        }
        if (outcome === 'unavailable') {
          return { ok: false, reason_code: CODE.no_permission, message: '宿主审批不可用；挂起申请保留至 TTL' };
        }
        if (outcome === 'rejected') {
          return { ok: false, reason_code: CODE.no_permission, message: '人工审批拒绝；挂起申请保留至 TTL' };
        }
        if (outcome === 'cancelled') {
          return { ok: false, reason_code: CODE.no_permission, message: '人工审批取消；挂起申请保留至 TTL' };
        }
        const created = await accounts.confirmPending({
          pending_id: pendingId,
          allowed: true,
          approval_id: exec.callId ?? 'approval-unknown',
        });
        if (!created.ok || created.account === undefined) {
          return { ok: false, reason_code: created.reason_code ?? CODE.invalid_field, message: created.message };
        }
        try {
          ensureHumanBootstrap(opened.db, created.account.actor_id);
        } catch (error) {
          return { ok: false, reason_code: CODE.runtime_inconsistent, message: `账号已创建但 bootstrap 授权失败：${String(error)}` };
        }
        runtime.log({ event: 'account_confirmed', request_id: exec.callId ?? 'tool-call', elapsed_ms: 0, actor: created.account.actor_id });
        return {
          ok: true,
          account: {
            username: created.account.username,
            role: created.account.role,
            actor_id: created.account.actor_id,
            approval_id: created.account.approval_id,
          },
        };
      },
    });
  }
  return tools;
}

export function toolNames(tools: readonly PluginTool[]): readonly string[] {
  return tools.map((tool) => tool.name);
}
