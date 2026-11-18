import { CODE } from '../core/errors/codes.js';
/**
 * signerd 进程本体（C1/C2/C4/C5/C6/C7/C11；docs/06 §3）。
 *
 * 一个 unix socket server，四个 op；私钥只在 unlock 之后以 KeyObject 存在于本进程内存。
 * 签名请求只收摘要：signerd 自己复核 frontier（防签旧版本），拒绝 agent 与“自己批自己”。
 * 窗口（D-060）：TTL=0 时一次解锁授权一次签发、签完即锁；TTL>0 时窗口内可连签（不消费窗口）。
 *
 * 单实例语义与 spike 一致：先抢 `signerd.lock`（0600，含 pid），抢不到活进程 ⇒ 拒绝；
 * 只有持锁后遇到的 socket 才当崩溃遗留清理。
 */
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';

import { SignError, asFailure, errorMessage, fail } from './errors.js';
import { assertOwnerOnlyDir, permissionBits } from './permissions.js';
import { signerdPaths, type SignerdPaths } from './paths.js';
import {
  isRecord,
  parseRequest,
  type SignerdRequest,
  type SignerdResponse,
} from './protocol.js';
import {
  checkWindow,
  parseWindowTtl,
  windowReusable,
  type WindowTtlMinutes,
} from './window.js';
import {
  RECEIPT_VERSION,
  canonicalDecisionMessage,
  computeReceiptId,
  signCanonical,
  type SignerdReceipt,
  DECISION_MESSAGE_VERSION,
} from './receipt.js';
import { SignerdStore } from './store.js';

export interface SignerdOptions {
  readonly paths?: SignerdPaths;
  /** 显式注入信任根（测试/嵌入方；D-054：产品不读 env 覆盖）。 */
  readonly homeDir?: string;
  readonly runtimeDir?: string;
  readonly socketPath?: string;
  readonly store?: SignerdStore;
  readonly now?: () => Date;
  readonly windowTtlMinutes?: WindowTtlMinutes;
  /** C11 用：注入真实延迟，证明 sign_ms 不是常量。 */
  readonly signDelayMs?: number;
}

export interface RunningSignerd {
  readonly socketPath: string;
  readonly store: SignerdStore;
  close(): Promise<void>;
}

const LOCK_ATTEMPTS = 3;

function resolvePaths(options: SignerdOptions): SignerdPaths {
  if (options.paths !== undefined) return options.paths;
  return signerdPaths({
    homeDir: options.homeDir,
    runtimeDir: options.runtimeDir,
    socketPath: options.socketPath,
  });
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockInfo {
  readonly pid: number;
  readonly at: string;
}

export function readLockFile(path: string): LockInfo | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || (permissionBits(stat.mode) !== 0o600)) {
    throw new SignError('signerd_lock_insecure', `${path} 必须是恰 0600 的普通文件`);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed) || typeof parsed['pid'] !== 'number' || typeof parsed['at'] !== 'string') {
      return undefined;
    }
    return { pid: parsed['pid'], at: parsed['at'] };
  } catch {
    return undefined;
  }
}

function acquireLock(path: string): void {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      chmodSync(path, 0o600);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = readLockFile(path);
      if (info !== undefined && processAlive(info.pid)) {
        throw new SignError('signerd_already_running', `已有 signerd 在运行（pid=${String(info.pid)}）`);
      }
      try {
        unlinkSync(path);
      } catch {
        // 竞争下别的进程可能已清理
      }
    }
  }
  throw new SignError('signerd_already_running', '无法获取 signerd.lock');
}

function releaseLock(path: string): void {
  const info = readLockFile(path);
  if (info !== undefined && info.pid === process.pid) {
    try {
      unlinkSync(path);
    } catch {
      // 已删除
    }
  }
}

async function handleRequest(
  store: SignerdStore,
  request: SignerdRequest,
  options: { now: () => Date; signDelayMs: number },
): Promise<SignerdResponse> {
  if (!store.verifyCapability(request.capability)) {
    return fail(CODE.invalid_request, 'capability 不匹配，拒绝请求');
  }
  if (request.op === 'status') {
    const window = store.unlockWindow;
    return {
      ok: true,
      op: 'status',
      locked: !store.unlocked,
      key_id: store.isInitialized() ? store.keyId : null,
      window_until: window?.until ?? null,
      ttl_minutes: window?.ttl_minutes ?? store.defaultTtlMinutes,
    };
  }
  if (request.op === 'lock') {
    store.lock();
    return { ok: true, op: 'lock' };
  }
  if (request.op === 'unlock') {
    if (request.actor_kind === 'agent') {
      return fail(CODE.not_a_signer, 'agent 不能解锁签名密钥（no_proxy_sign）');
    }
    const outcome = await store.unlock(request.actor, request.passphrase, request.frontier);
    return { ok: true, op: 'unlock', ...outcome };
  }
  // sign
  if (request.actor_kind === 'agent') {
    return fail(CODE.not_a_signer, 'agent 不能触发签名（no_proxy_sign）');
  }
  if (request.producer === request.actor) {
    return fail(CODE.not_a_signer, 'producer 不能给自己签发（no_proxy_sign）');
  }
  const window = store.unlockWindow;
  if (window === undefined || !store.unlocked) {
    return fail(CODE.awaiting_unlock, '未解锁，先 unlock 再 sign');
  }
  if (window.actor !== request.actor) {
    return fail(CODE.not_a_signer, `解锁的 actor ${window.actor} 与请求 actor ${request.actor} 不一致`);
  }
  const checked = checkWindow(window, { frontier: request.frontier, now: options.now() });
  if (!checked.ok) {
    store.lock();
    return fail(CODE.frontier_stale, checked.message);
  }
  const timing = store.beginSignTiming();
  const { unlock_wait_ms, since_last_unlock_ms } = timing;
  const signStarted = Date.now();
  try {
    if (options.signDelayMs > 0) {
      // 仅测试用：注入延迟时向 stderr 打一行“已进入签名”，让两进程时序用例可轮询而不是 sleep。
      process.stderr.write(`${JSON.stringify({ phase: 'signing_started', decision_id: request.decision_id })}\n`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, options.signDelayMs));
    }
    const message = canonicalDecisionMessage({
      decision_id: request.decision_id,
      payload_hash: request.payload_hash,
      proposition_hash: request.proposition_hash,
      frontier: request.frontier,
      nonce: request.nonce,
    });
    const signature = signCanonical(store.requirePrivateKey(), message);
    const sign_ms = Math.max(0, Date.now() - signStarted);
    const at = options.now().toISOString();
    const base: Omit<SignerdReceipt, 'prev_receipt_hash'> = {
      version: RECEIPT_VERSION,
      receipt_id: computeReceiptId({
        decision_id: request.decision_id,
        payload_hash: request.payload_hash,
        signature,
        at,
        nonce: request.nonce,
      }),
      decision_id: request.decision_id,
      payload_hash: request.payload_hash,
      proposition_hash: request.proposition_hash,
      frontier: request.frontier,
      nonce: request.nonce,
      signature,
      key_id: store.keyId,
      signer: request.actor,
      channel: request.channel,
      at,
      unlock_wait_ms,
      since_last_unlock_ms,
      sign_ms,
    };
    const receipt = store.appendReceipt(base);
    // D-060：TTL=0 的解锁是一次性授权（签完即锁）；TTL>0 的窗口内可连签，不消费窗口，
    // 直到到期 / frontier 变 / 手动 lock。连签时每条仍经过上面的窗口与 frontier 检查。
    if (!windowReusable(window)) store.consumeWindow();
    return {
      ok: true,
      op: 'sign',
      receipt_id: receipt.receipt_id,
      signature,
      key_id: receipt.key_id,
      signer: receipt.signer,
      channel: receipt.channel,
      at,
      unlock_wait_ms,
      since_last_unlock_ms,
      sign_ms,
    };
  } catch (error) {
    return asFailure(error);
  }
}

function handleConnection(socket: Socket, store: SignerdStore, options: { now: () => Date; signDelayMs: number }): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line.trim().length === 0) continue;
      void (async () => {
        const parsed = parseRequest(line);
        let response: SignerdResponse;
        if (parsed.failure !== undefined) {
          response = parsed.failure;
        } else if (parsed.request !== undefined) {
          try {
            response = await handleRequest(store, parsed.request, options);
          } catch (error) {
            response = asFailure(error);
          }
        } else {
          response = fail(CODE.invalid_request, '请求无法解析');
        }
        if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
      })();
    }
  });
}

/** 启动 signerd；权限/平台不对直接拒绝启动（稳定码）。 */
export async function startSignerd(options: SignerdOptions = {}): Promise<RunningSignerd> {
  const paths = resolvePaths(options);
  const now = options.now ?? (() => new Date());
  const ttlMinutes = options.windowTtlMinutes ?? parseWindowTtl(process.env['SDO_SIGNERD_WINDOW_TTL_MINUTES']);
  const store = options.store ?? new SignerdStore(paths, { windowTtlMinutes: ttlMinutes, now });

  store.ensureHome();
  store.assertStoreSecure();
  if (!store.isInitialized()) {
    throw new SignError('store_not_initialized', `${paths.keyFile} 不存在；先运行 signerd init`);
  }

  // socket 目录：存在则必须 0700；不存在则建 0700。
  if (existsSync(paths.runtimeDir)) {
    assertOwnerOnlyDir(paths.runtimeDir);
  } else {
    const { ensureOwnerOnlyDir } = await import('./permissions.js');
    ensureOwnerOnlyDir(paths.runtimeDir);
  }

  acquireLock(paths.lockFile);
  try {
    // 持锁意味着没有活着的 signerd 持有该目录：此前的 socket 只能是崩溃遗留。
    // DoS 边界（D-054/P3）：能写该 0700 目录的同 uid 攻击者可以预放路径，属 T0 范围。
    if (existsSync(paths.socket)) unlinkSync(paths.socket);
    const server: Server = createServer((socket) => {
      handleConnection(socket, store, { now, signDelayMs: options.signDelayMs ?? 0 });
    });
    // umask 包住 listen：socket 出生即 0600，消除“先默认 0755 再 chmod”的窗口。
    const previousUmask = process.umask(0o077);
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(paths.socket, () => {
          server.removeListener('error', rejectPromise);
          resolvePromise();
        });
      });
    } finally {
      process.umask(previousUmask);
    }
    chmodSync(paths.socket, 0o600);
    const stat = lstatSync(paths.socket);
    if (!stat.isSocket()) {
      throw new SignError('socket_perm_insecure', `${paths.socket} 不是 socket 文件`);
    }
    if (permissionBits(stat.mode) !== 0o600) {
      throw new SignError(
        'socket_perm_insecure',
        `${paths.socket} 权限是 0o${permissionBits(stat.mode).toString(8)}，必须是 0o0600`,
      );
    }
    let closed = false;
    return {
      socketPath: paths.socket,
      store,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
        try {
          unlinkSync(paths.socket);
        } catch {
          // 已不在
        }
        releaseLock(paths.lockFile);
      },
    };
  } catch (error) {
    releaseLock(paths.lockFile);
    throw error;
  }
}

/** 供 CLI 用：初始化 signerd 持久目录（生成并加密私钥）。 */
export async function initializeSignerd(options: {
  passphrase: string;
  paths?: SignerdPaths;
  homeDir?: string;
  now?: () => Date;
}): Promise<{ key_id: string; public_key: string; home: string }> {
  const paths = resolvePaths(options);
  const store = new SignerdStore(paths, { now: options.now });
  const created = await store.initialize(options.passphrase);
  return { ...created, home: paths.home };
}

export const SIGNERD_PROTOCOL_VERSION = DECISION_MESSAGE_VERSION;
export { errorMessage };
