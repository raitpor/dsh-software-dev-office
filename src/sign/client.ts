import { CODE } from '../core/errors/codes.js';
/**
 * 插件侧（非 signerd 进程）的 unix socket 客户端（C1/C4；docs/06 §3.1）。
 *
 * 客户端只拿 capability + socket 路径；私钥与口令只沿 socket 进 signerd，
 * 绝不进插件进程内存。连接失败/超时都给稳定码，不抛裸异常。
 */
import { connect, type Socket } from 'node:net';

import { fail, type SignFailure } from './errors.js';
import { signerdPaths, type SignerdPaths } from './paths.js';
import { overwriteOwnerOnlyFile, readOwnerOnlyFile } from './permissions.js';
import {
  isRecord,
  type ActorKind,
  type LockRequest,
  type SignerdResponse,
  type SignRequest,
  type SignSuccess,
  type StatusRequest,
  type StatusSuccess,
  type UnlockRequest,
  type UnlockSuccess,
} from './protocol.js';
import { parseReceipt, receiptHash, type SignChannel, type SignerdReceipt } from './receipt.js';

type RequestBody =
  | Omit<StatusRequest, 'capability'>
  | Omit<UnlockRequest, 'capability'>
  | Omit<LockRequest, 'capability'>
  | Omit<SignRequest, 'capability'>;

export interface ClientOptions {
  readonly paths?: SignerdPaths;
  readonly timeoutMs?: number;
}

export class SignerdClient {
  readonly paths: SignerdPaths;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.paths = options.paths ?? signerdPaths();
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  capability(): string {
    return readOwnerOnlyFile(this.paths.capabilityFile).trim();
  }

  /**
   * P2-2（第 4/5 轮）：**仅供签发失败路径清理用**（`signDecision` 在签后复核失败时调用）。
   *
   * 语义：`consumed:false` 是客户端失败清理标记，不是可审计的撤销；verify/provenance
   * 视其为不存在（该 decision 会变成 `signature_unverifiable`）。非链尾时重算后缀
   * `prev_receipt_hash` 是**受控的链重写**——回执链只证明剩余回执的 append 顺序，
   * 不证明某条未被 tombstone（并发无锁清理的边界见 README / 台账 D-059）。
   *
   * 按 `receipt_id` 定位：
   * · 在链尾 → 直接删掉这一行（链仍自洽）；
   * · 不在链尾（说明之后又被追加了别人的回执）→ 不能删除，否则破坏后续哈希链；
   *   降级为标记 `consumed:false`，并重算其后缀的 `prev_receipt_hash` 保持链自洽。
   * 任何 IO/权限/解析错误都被吞掉（记 stderr）：清理失败不得改变 `frontier_stale` 返回形状。
   */
  discardReceiptOnFailure(receiptId: string): void {
    try {
      const text = readOwnerOnlyFile(this.paths.receiptsFile);
      const lines = text.split('\n').filter((line) => line.trim().length > 0);
      const parsed: SignerdReceipt[] = [];
      for (const line of lines) {
        const receipt = parseReceipt(line);
        if (receipt === undefined) {
          throw new Error(`receipt_parse_failed: 第 ${String(parsed.length + 1)} 行不是合法回执`);
        }
        parsed.push(receipt);
      }
      const index = parsed.findIndex((receipt) => receipt.receipt_id === receiptId);
      if (index < 0) return;
      if (index === parsed.length - 1) {
        const remaining = lines.slice(0, index);
        overwriteOwnerOnlyFile(
          this.paths.receiptsFile,
          remaining.length === 0 ? '' : `${remaining.join('\n')}\n`,
        );
        return;
      }
      const updated: SignerdReceipt[] = parsed.map((receipt, position) =>
        position === index ? { ...receipt, consumed: false } : { ...receipt },
      );
      for (let position = index + 1; position < updated.length; position += 1) {
        const previous = updated[position - 1];
        if (previous === undefined) break;
        updated[position] = { ...updated[position]!, prev_receipt_hash: receiptHash(previous) };
      }
      overwriteOwnerOnlyFile(
        this.paths.receiptsFile,
        `${updated.map((receipt) => JSON.stringify(receipt)).join('\n')}\n`,
      );
      process.stderr.write(
        `${JSON.stringify({ warning: 'receipt_not_tail', receipt_id: receiptId, action: 'marked_consumed_false' })}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ warning: 'discard_receipt_failed', receipt_id: receiptId, detail: String(error) })}\n`,
      );
    }
  }

  async request(request: RequestBody): Promise<SignerdResponse> {
    const capability = this.capability();
    const line = `${JSON.stringify({ ...request, capability })}\n`;
    return await new Promise<SignerdResponse>((resolvePromise) => {
      const socket: Socket = connect(this.paths.socket);
      let buffer = '';
      let settled = false;
      const finish = (response: SignerdResponse): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolvePromise(response);
      };
      socket.setEncoding('utf8');
      socket.setTimeout(this.timeoutMs);
      socket.once('connect', () => socket.write(line));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const text = buffer.slice(0, index);
        try {
          const parsed = JSON.parse(text) as unknown;
          if (isRecord(parsed) && parsed['ok'] === true) {
            finish(parsed as unknown as SignerdResponse);
          } else if (isRecord(parsed) && parsed['ok'] === false) {
            finish(parsed as unknown as SignerdResponse);
          } else {
            finish(fail(CODE.unknown_request, 'signerd 返回了无法识别的响应'));
          }
        } catch {
          finish(fail(CODE.unknown_request, 'signerd 响应不是合法 JSON'));
        }
      });
      socket.once('timeout', () => finish(fail(CODE.socket_not_ready, `连接 ${this.paths.socket} 超时`)));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        finish(fail(CODE.socket_not_ready, `连接 ${this.paths.socket} 失败：${error.code ?? error.message}`));
      });
    });
  }

  async status(): Promise<StatusSuccess | SignFailure> {
    const response = await this.request({ op: 'status' });
    return response.ok ? (response as StatusSuccess) : (response as SignFailure);
  }

  async unlock(input: {
    actor: string;
    actor_kind: ActorKind;
    passphrase: string;
    frontier: string;
  }): Promise<UnlockSuccess | SignFailure> {
    const response = await this.request({ op: 'unlock', ...input });
    return response.ok ? (response as UnlockSuccess) : (response as SignFailure);
  }

  async lock(actor: string): Promise<SignFailure | { ok: true; op: 'lock' }> {
    const response = await this.request({ op: 'lock', actor });
    return response.ok ? (response as { ok: true; op: 'lock' }) : (response as SignFailure);
  }

  async sign(input: {
    actor: string;
    actor_kind: ActorKind;
    producer: string;
    decision_id: string;
    payload_hash: string;
    proposition_hash: string;
    frontier: string;
    nonce: string;
    channel: SignChannel;
  }): Promise<SignSuccess | SignFailure> {
    const response = await this.request({ op: 'sign', ...input });
    return response.ok ? (response as SignSuccess) : (response as SignFailure);
  }
}
