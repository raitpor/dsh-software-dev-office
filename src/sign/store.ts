/**
 * signerd 的持久存储（C2/C9）：私钥信封、受信公钥 keyring、签名回执、capability。
 *
 * 目录 0700、文件 0600，全部用 `permissions.ts` 的显式校验（spike E5 手法）；
 * receipts 只追加不修改；keyring 重写走 0600 临时文件 + rename。
 * 进程内存里只活在 unlock 之后的 Ed25519 KeyObject——私钥不落明文、不出进程。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';
import { join } from 'node:path';

import { SignError, errorMessage } from './errors.js';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  generateSigningKey,
  type KeyEnvelope,
} from './keys.js';
import {
  assertOwnerOnlyDir,
  assertOwnerOnlyFile,
  ensureOwnerOnlyDir,
  readOwnerOnlyFile,
  writeOwnerOnlyFile,
} from './permissions.js';
import type { SignerdPaths } from './paths.js';
import { parseReceipt, receiptHash, type SignerdReceipt } from './receipt.js';
import { openWindow, parseWindowTtl, type UnlockWindow, type WindowTtlMinutes } from './window.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const RATE_LIMIT_MS = 5 * 60_000;

export interface KeyringFile {
  readonly version: 1;
  readonly keys: Readonly<Record<string, string>>;
}

export interface UnlockOutcome {
  readonly key_id: string;
  readonly window_until: string | null;
  readonly ttl_minutes: WindowTtlMinutes;
  readonly unlock_ms: number;
}

export interface SignerdStoreOptions {
  readonly windowTtlMinutes?: WindowTtlMinutes;
  readonly now?: () => Date;
}

function atomicWrite0600(path: string, data: string): void {
  const tmp = join(
    path,
    '..',
    `.${process.pid.toString(36)}.${randomBytes(4).toString('hex')}.tmp`,
  );
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    assertOwnerOnlyFile(tmp);
    renameSync(tmp, path);
    assertOwnerOnlyFile(path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw error;
  }
}

export class SignerdStore {
  readonly paths: SignerdPaths;
  private readonly now: () => Date;
  private readonly ttlMinutes: WindowTtlMinutes;
  private privateKey: KeyObject | undefined;
  private keyIdValue: string | undefined;
  private window: UnlockWindow | undefined;
  private failedAttempts = 0;
  private rateLimitedUntil = 0;
  private lastUnlockAt = 0;

  constructor(paths: SignerdPaths, options: SignerdStoreOptions = {}) {
    this.paths = paths;
    this.now = options.now ?? (() => new Date());
    this.ttlMinutes = options.windowTtlMinutes ?? parseWindowTtl(process.env['SDO_SIGNERD_WINDOW_TTL_MINUTES']);
  }

  /** 0700 目录 + capability；已存在则只校验（坏权限直接拒，不静默 chmod）。 */
  ensureHome(): void {
    ensureOwnerOnlyDir(this.paths.home);
    if (!existsSync(this.paths.capabilityFile)) {
      writeOwnerOnlyFile(this.paths.capabilityFile, `${randomBytes(32).toString('hex')}\n`);
    } else {
      assertOwnerOnlyFile(this.paths.capabilityFile);
    }
  }

  get defaultTtlMinutes(): WindowTtlMinutes {
    return this.ttlMinutes;
  }

  isInitialized(): boolean {
    return existsSync(this.paths.keyFile);
  }

  /** 首次生成签名密钥（口令加密后才落盘）；已初始化则抛 `store_not_initialized` 以外不覆盖。 */
  async initialize(passphrase: string): Promise<{ key_id: string; public_key: string }> {
    this.ensureHome();
    if (this.isInitialized()) {
      throw new SignError('signerd_already_running', 'signerd 已初始化，拒绝覆盖已有私钥');
    }
    if (passphrase.length === 0) throw new SignError('invalid_request', '口令不能为空');
    const material = generateSigningKey();
    const envelope = await encryptPrivateKey(material, passphrase, this.now());
    atomicWrite0600(this.paths.keyFile, `${JSON.stringify(envelope)}\n`);
    this.keyIdValue = material.key_id;
    this.privateKey = material.private_key;
    this.registerPublicKey(material.key_id, material.public_key);
    if (!existsSync(this.paths.receiptsFile)) {
      writeOwnerOnlyFile(this.paths.receiptsFile, '');
    }
    return { key_id: material.key_id, public_key: material.public_key };
  }

  /** 读盘上的信封（不派生）；用于 status/自检。 */
  loadEnvelope(): KeyEnvelope {
    assertOwnerOnlyFile(this.paths.keyFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readOwnerOnlyFile(this.paths.keyFile)) as unknown;
    } catch (error) {
      throw new SignError('key_envelope_invalid', `key 信封不是合法 JSON：${errorMessage(error)}`);
    }
    return parsed as KeyEnvelope;
  }

  get unlocked(): boolean {
    return this.privateKey !== undefined;
  }

  get keyId(): string {
    if (this.keyIdValue === undefined) {
      this.keyIdValue = this.loadEnvelope().key_id;
    }
    return this.keyIdValue;
  }

  /** 解锁：Argon2id 派生 + GCM 解密；连续 5 次失败锁 5 分钟。 */
  async unlock(actor: string, passphrase: string, frontier: string): Promise<UnlockOutcome> {
    const now = this.now();
    if (now.getTime() < this.rateLimitedUntil) {
      throw new SignError('rate_limited', `连续失败过多，${new Date(this.rateLimitedUntil).toISOString()} 前拒绝解锁`);
    }
    if (this.privateKey !== undefined) this.lock();
    const started = Date.now();
    try {
      const envelope = this.loadEnvelope();
      const material = await decryptPrivateKey(envelope, passphrase);
      this.privateKey = material.private_key;
      this.keyIdValue = material.key_id;
        this.failedAttempts = 0;
      this.lastUnlockAt = this.now().getTime();
      this.window = openWindow({
        actor,
        frontier,
        ttl_minutes: this.ttlMinutes,
        now: this.now(),
      });
      this.registerPublicKey(material.key_id, material.public_key);
      return {
        key_id: material.key_id,
        window_until: this.window.until,
        ttl_minutes: this.ttlMinutes,
        unlock_ms: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof SignError && error.reason_code === 'bad_passphrase') {
        this.failedAttempts += 1;
        if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
          this.rateLimitedUntil = now.getTime() + RATE_LIMIT_MS;
          throw new SignError('rate_limited', '连续 5 次口令错误，锁 5 分钟');
        }
      }
      throw error;
    }
  }

  lock(): void {
    this.privateKey = undefined;
    this.window = undefined;
    this.lastUnlockAt = 0;
  }

  get unlockWindow(): UnlockWindow | undefined {
    return this.window;
  }

  /** 消费本次授权（单次签发）：成功签发后立即回 locked。 */
  consumeWindow(): void {
    this.window = undefined;
    this.privateKey = undefined;
  }

  requirePrivateKey(): KeyObject {
    if (this.privateKey === undefined) throw new SignError('locked', 'signerd 未解锁');
    return this.privateKey;
  }

  /** C11：unlock→sign 之间的真实等待（毫秒），由调用方测量后传入。 */
  markUnlockedAt(): void {
    this.lastUnlockAt = this.now().getTime();
  }

  unlockWaitMs(): number {
    if (this.lastUnlockAt === 0) return 0;
    return Math.max(0, this.now().getTime() - this.lastUnlockAt);
  }

  readCapability(): string {
    assertOwnerOnlyFile(this.paths.capabilityFile);
    return readFileSync(this.paths.capabilityFile, 'utf8').trim();
  }

  verifyCapability(candidate: unknown): boolean {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    const expected = Buffer.from(this.readCapability(), 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  readKeyring(): KeyringFile {
    if (!existsSync(this.paths.keyringFile)) return { version: 1, keys: {} };
    assertOwnerOnlyFile(this.paths.keyringFile);
    const parsed = JSON.parse(readOwnerOnlyFile(this.paths.keyringFile)) as KeyringFile;
    return { version: 1, keys: { ...parsed.keys } };
  }

  registerPublicKey(keyId: string, publicKeyB64: string): void {
    const keyring = this.readKeyring();
    if (keyring.keys[keyId] === publicKeyB64) return;
    const next: KeyringFile = { version: 1, keys: { ...keyring.keys, [keyId]: publicKeyB64 } };
    atomicWrite0600(this.paths.keyringFile, `${JSON.stringify(next)}\n`);
  }

  /** 追加一条回执并补上哈希链前驱（D-054）；返回落盘后的完整回执。 */
  appendReceipt(receipt: Omit<SignerdReceipt, 'prev_receipt_hash'>): SignerdReceipt {
    if (!existsSync(this.paths.receiptsFile)) {
      writeOwnerOnlyFile(this.paths.receiptsFile, '');
    }
    assertOwnerOnlyFile(this.paths.receiptsFile);
    const existing = readFileSync(this.paths.receiptsFile, 'utf8');
    const lines = existing.split('\n').filter((line) => line.trim().length > 0);
    const lastLine = lines[lines.length - 1];
    let prev: string | null = null;
    if (lastLine !== undefined) {
      const last = parseReceipt(lastLine);
      if (last === undefined) {
        throw new SignError('receipt_chain_broken', '已有回执文件无法解析，拒绝追加（先人工核查）');
      }
      prev = receiptHash(last);
    }
    const full: SignerdReceipt = { ...receipt, prev_receipt_hash: prev, consumed: true };
    atomicWrite0600(this.paths.receiptsFile, `${existing}${JSON.stringify(full)}\n`);
    return full;
  }

  readReceipts(): SignerdReceipt[] {
    if (!existsSync(this.paths.receiptsFile)) return [];
    assertOwnerOnlyFile(this.paths.receiptsFile);
    return readOwnerOnlyFile(this.paths.receiptsFile)
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => parseReceipt(line))
      .filter((receipt): receipt is SignerdReceipt => receipt !== undefined);
  }

  /** 目录与全部关键文件的权限自检（启动时跑一次；坏权限 = 拒绝启动）。 */
  assertStoreSecure(): void {
    assertOwnerOnlyDir(this.paths.home);
    if (this.isInitialized()) assertOwnerOnlyFile(this.paths.keyFile);
    if (existsSync(this.paths.keyringFile)) assertOwnerOnlyFile(this.paths.keyringFile);
    if (existsSync(this.paths.receiptsFile)) assertOwnerOnlyFile(this.paths.receiptsFile);
  }
}
