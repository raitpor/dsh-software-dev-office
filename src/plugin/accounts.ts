/**
 * M5-0 C13：页面账号系统（human 通道）v1。
 *
 * 账号只存在于状态目录的 `accounts.json`（0600、原子写），不建表、不加迁移；
 * 注册两步：页面写挂起申请（含快照哈希）→ agent 调 `sdo_account_confirm`
 * 过宿主审批后才建账号。口令用 Argon2id；会话与 CSRF 在进程内存。
 * 模型可达的文件只会看到哈希；口令明文不落盘、不返回、不进日志。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CODE } from '../core/errors/codes.js';
import { Algorithm, hash, verify } from '@node-rs/argon2';

export const ACCOUNT_FILE_MODE = 0o600;
export const STATE_DIR_MODE = 0o700;
export const SESSION_TTL_MS = 8 * 60 * 60_000;
export const SESSION_IDLE_MS = 30 * 60_000;
export const PENDING_TTL_MS = 15 * 60_000;
export const LOGIN_WINDOW_MS = 5 * 60_000;
export const LOGIN_MAX_FAILURES = 5;
export const MIN_PASSWORD_LENGTH = 12;

export type AccountRole = 'admin' | 'user';

export interface AccountRecord {
  readonly username: string;
  readonly role: AccountRole;
  readonly actor_id: string;
  readonly password_hash: string;
  readonly created_at: string;
  readonly approval_id?: string;
  readonly key_id?: string;
}

export interface PendingRegistration {
  readonly id: string;
  readonly username: string;
  readonly password_hash: string;
  readonly role_suggestion: AccountRole;
  readonly source: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly snapshot_hash: string;
}

interface AccountsFile {
  readonly version: 1;
  readonly accounts: readonly AccountRecord[];
  readonly pending: readonly PendingRegistration[];
}

export interface AccountSession {
  readonly token: string;
  readonly csrf: string;
  readonly account: AccountRecord;
  readonly created_at: number;
  last_seen: number;
}

export interface LoginResult {
  readonly ok: boolean;
  readonly reason_code?: typeof CODE.invalid_field | typeof CODE.rate_limited | typeof CODE.no_permission;
  readonly message?: string;
  readonly account?: AccountRecord;
}

export interface RegisterPendingInput {
  readonly username: string;
  readonly password: string;
  readonly role_suggestion?: AccountRole;
  readonly source: string;
}

export interface ConfirmInput {
  readonly pending_id: string;
  readonly allowed: boolean;
  readonly approval_id: string;
}

export interface ConfirmResult {
  readonly ok: boolean;
  readonly reason_code?: string;
  readonly message?: string;
  readonly account?: AccountRecord;
}

function atomicWrite0600(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: STATE_DIR_MODE });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { encoding: 'utf8', mode: ACCOUNT_FILE_MODE, flag: 'wx' });
  try {
    renameSync(tmp, path);
    const mode = statSync(path).mode & 0o777;
    if (mode !== ACCOUNT_FILE_MODE) throw new Error(`账号文件权限 ${mode.toString(8)} != 600`);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw error;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

export function pendingSnapshotHash(pending: Omit<PendingRegistration, 'snapshot_hash'>): string {
  return `sha256:${createHash('sha256').update(canonical(pending)).digest('hex')}`;
}

function validatePassword(password: string, username: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `口令至少 ${String(MIN_PASSWORD_LENGTH)} 位`;
  if (password.toLowerCase().includes(username.toLowerCase())) return '口令不能包含用户名';
  return undefined;
}

function validUsername(username: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(username);
}

export class AccountStore {
  readonly stateDir: string;
  readonly accountsPath: string;
  private readonly now: () => Date;
  private accounts: AccountRecord[] = [];
  private pending: PendingRegistration[] = [];
  private sessions = new Map<string, AccountSession>();
  private failures = new Map<string, number[]>();

  constructor(stateDir: string, options: { now?: () => Date } = {}) {
    this.stateDir = stateDir;
    this.accountsPath = join(stateDir, 'accounts.json');
    this.now = options.now ?? (() => new Date());
  }

  load(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: STATE_DIR_MODE });
    if (!existsSync(this.accountsPath)) {
      this.accounts = [];
      this.pending = [];
      return;
    }
    const mode = statSync(this.accountsPath).mode & 0o777;
    if (mode !== ACCOUNT_FILE_MODE) throw new Error(`账号文件权限 ${mode.toString(8)} != 600`);
    const parsed = JSON.parse(readFileSync(this.accountsPath, 'utf8')) as AccountsFile;
    this.accounts = [...parsed.accounts];
    this.pending = [...parsed.pending].filter((item) => Date.parse(item.expires_at) > this.now().getTime());
  }

  private save(): void {
    const data: AccountsFile = { version: 1, accounts: this.accounts, pending: this.pending };
    atomicWrite0600(this.accountsPath, `${JSON.stringify(data, null, 2)}\n`);
  }

  get accountCount(): number {
    return this.accounts.length;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  listAccounts(): readonly AccountRecord[] {
    return [...this.accounts];
  }

  findAccount(username: string): AccountRecord | undefined {
    return this.accounts.find((account) => account.username === username);
  }

  findAccountByActor(actorId: string): AccountRecord | undefined {
    return this.accounts.find((account) => account.actor_id === actorId);
  }

  nextRole(): AccountRole {
    return this.accounts.length === 0 ? 'admin' : 'user';
  }

  async registerPending(input: RegisterPendingInput): Promise<{ ok: boolean; id?: string; reason_code?: string; message?: string }> {
    this.load();
    const username = input.username.trim();
    if (!validUsername(username)) return { ok: false, reason_code: CODE.invalid_field, message: '用户名只允许字母数字._-（≤64）' };
    if (this.findAccount(username) !== undefined) {
      return { ok: false, reason_code: CODE.invalid_field, message: '用户名已存在' };
    }
    const passwordProblem = validatePassword(input.password, username);
    if (passwordProblem !== undefined) return { ok: false, reason_code: CODE.invalid_field, message: passwordProblem };
    const created = this.now();
    const unsigned = {
      id: `pending-${randomUUID()}`,
      username,
      password_hash: await hash(input.password, { algorithm: Algorithm.Argon2id }),
      role_suggestion: input.role_suggestion ?? this.nextRole(),
      source: input.source,
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + PENDING_TTL_MS).toISOString(),
    };
    const pending: PendingRegistration = { ...unsigned, snapshot_hash: pendingSnapshotHash(unsigned) };
    this.pending = [...this.pending.filter((item) => item.username !== username), pending];
    this.save();
    return { ok: true, id: pending.id };
  }

  getPending(id: string): PendingRegistration | undefined {
    const pending = this.pending.find((item) => item.id === id);
    if (pending === undefined) return undefined;
    if (Date.parse(pending.expires_at) <= this.now().getTime()) return undefined;
    const { snapshot_hash: stored, ...unsigned } = pending;
    if (pendingSnapshotHash(unsigned) !== stored) {
      throw new Error('pending_registration_tampered');
    }
    return pending;
  }

  listPending(): readonly PendingRegistration[] {
    return this.pending.filter((item) => Date.parse(item.expires_at) > this.now().getTime());
  }

  async confirmPending(input: ConfirmInput): Promise<ConfirmResult> {
    this.load();
    let pending: PendingRegistration;
    try {
      const found = this.getPending(input.pending_id);
      if (found === undefined) return { ok: false, reason_code: CODE.invalid_field, message: '挂起申请不存在或已过期' };
      pending = found;
    } catch (error) {
      return { ok: false, reason_code: CODE.invalid_field, message: String(error) };
    }
    if (!input.allowed) {
      return { ok: false, reason_code: CODE.no_permission, message: '审批未通过，账号未创建' };
    }
    if (this.findAccount(pending.username) !== undefined) {
      return { ok: false, reason_code: CODE.invalid_field, message: '账号已存在' };
    }
    const account: AccountRecord = {
      username: pending.username,
      role: pending.role_suggestion === 'admin' && this.accounts.length === 0 ? 'admin' : 'user',
      actor_id: `user:${randomUUID()}`,
      password_hash: pending.password_hash,
      created_at: this.now().toISOString(),
      approval_id: input.approval_id,
    };
    this.accounts = [...this.accounts, account];
    this.pending = this.pending.filter((item) => item.id !== pending.id);
    this.save();
    return { ok: true, account };
  }

  markKeyId(actorId: string, keyId: string): boolean {
    const index = this.accounts.findIndex((account) => account.actor_id === actorId);
    if (index < 0) return false;
    this.accounts = this.accounts.map((account, at) => (at === index ? { ...account, key_id: keyId } : account));
    this.save();
    return true;
  }

  async login(username: string, password: string, ip: string): Promise<LoginResult> {
    this.load();
    const key = `${ip}|${username.toLowerCase()}`;
    const now = this.now().getTime();
    const recent = (this.failures.get(key) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_FAILURES) {
      this.failures.set(key, recent);
      return { ok: false, reason_code: CODE.rate_limited, message: '登录失败次数过多，请 5 分钟后重试' };
    }
    const account = this.findAccount(username);
    if (account === undefined) {
      this.failures.set(key, [...recent, now]);
      return { ok: false, reason_code: CODE.invalid_field, message: '用户名或口令错误' };
    }
    let valid = false;
    try {
      valid = await verify(account.password_hash, password, { algorithm: Algorithm.Argon2id });
    } catch {
      valid = false;
    }
    if (!valid) {
      this.failures.set(key, [...recent, now]);
      return { ok: false, reason_code: CODE.invalid_field, message: '用户名或口令错误' };
    }
    this.failures.delete(key);
    return { ok: true, account };
  }

  createSession(account: AccountRecord): AccountSession {
    const token = randomBytes(32).toString('hex');
    const session: AccountSession = {
      token,
      csrf: randomBytes(32).toString('hex'),
      account,
      created_at: this.now().getTime(),
      last_seen: this.now().getTime(),
    };
    this.sessions.set(token, session);
    return session;
  }

  resolveSession(token: string | undefined): AccountSession | undefined {
    if (token === undefined) return undefined;
    const session = this.sessions.get(token);
    if (session === undefined) return undefined;
    const now = this.now().getTime();
    if (now - session.created_at >= SESSION_TTL_MS) {
      this.sessions.delete(token);
      return undefined;
    }
    if (now - session.last_seen >= SESSION_IDLE_MS) {
      this.sessions.delete(token);
      return undefined;
    }
    session.last_seen = now;
    return session;
  }

  destroySession(token: string | undefined): void {
    if (token !== undefined) this.sessions.delete(token);
  }

  csrfValid(session: AccountSession, candidate: string | undefined): boolean {
    if (candidate === undefined) return false;
    const expected = Buffer.from(session.csrf, 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** 自检：文件存在时必须 0600；目录 0700。 */
  assertSecure(): void {
    if (!existsSync(this.accountsPath)) return;
    const mode = statSync(this.accountsPath).mode & 0o777;
    if (mode !== ACCOUNT_FILE_MODE) throw new Error(`账号文件权限 ${mode.toString(8)} != 600`);
    const dirMode = statSync(this.stateDir).mode & 0o777;
    if (dirMode !== STATE_DIR_MODE) throw new Error(`状态目录权限 ${dirMode.toString(8)} != 700`);
  }
}
