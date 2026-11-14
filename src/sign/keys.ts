/**
 * 私钥落盘加密（C2，docs/06 §13；M2-0s 证据 E2/E3/E4）。
 *
 * 信封：单行 JSON，Argon2id（m=19456 KiB, t=2, p=1，16B 盐）派生 32B KEK，
 * AES-256-GCM（12B nonce）加密 PKCS#8 DER。盘上只有密文 + 公开参数；
 * key_id = `ed25519:` + SPKI DER 的 sha256 前 32 hex 位。
 *
 * 为什么不用 scrypt 兜底：spike 已实测 `@node-rs/argon2` 可安装可复现（D-049），
 * Argon2id 是设计条款，不降级。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

import { Algorithm, hashRaw } from '@node-rs/argon2';

import { SignError, errorMessage } from './errors.js';

export const KEY_ENVELOPE_FORMAT = 'sdo-signerd-key-v1';
export const KEY_ID_PREFIX = 'ed25519:';
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const DERIVED_KEY_BYTES = 32;

/** 与 spike 一致；只认这一组，参数存在信封里以便未来轮换。 */
export const KDF_PARAMS = { m: 19456, t: 2, p: 1 } as const;

export interface KeyEnvelope {
  readonly format: typeof KEY_ENVELOPE_FORMAT;
  readonly kdf: 'argon2id';
  readonly kdf_params: { readonly m: number; readonly t: number; readonly p: number };
  /** base64(16B) */
  readonly salt: string;
  /** base64(12B) */
  readonly nonce: string;
  /** base64(16B) GCM tag */
  readonly tag: string;
  readonly cipher: 'aes-256-gcm';
  /** base64(PKCS#8 DER 密文) */
  readonly ct: string;
  readonly key_id: string;
  /** base64(SPKI DER)，公开，用于 keyring 与验签 */
  readonly public_key: string;
  readonly created_at: string;
}

interface KeyMaterial {
  readonly key_id: string;
  readonly public_key: string;
  readonly private_key: KeyObject;
}

export function keyIdForPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `${KEY_ID_PREFIX}${createHash('sha256').update(der).digest('hex').slice(0, 32)}`;
}

export function publicKeyBase64(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function publicKeyFromBase64(encoded: string): KeyObject {
  return createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
}

/** 生成 Ed25519 签名密钥对（私钥只在 signerd 进程内以 KeyObject 存在）。 */
export function generateSigningKey(): KeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { key_id: keyIdForPublicKey(publicKey), public_key: publicKeyBase64(publicKey), private_key: privateKey };
}

export function requireEnvelopeShape(value: unknown): KeyEnvelope {
  if (typeof value !== 'object' || value === null) {
    throw new SignError('key_envelope_invalid', 'key 信封不是对象');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'cipher',
    'created_at',
    'ct',
    'format',
    'kdf',
    'kdf_params',
    'key_id',
    'nonce',
    'public_key',
    'salt',
    'tag',
  ];
  const actual = Object.keys(record).sort();
  if (actual.join(',') !== expected.join(',')) {
    throw new SignError('key_envelope_invalid', `key 信封字段必须恰为 ${expected.join(',')}`);
  }
  if (record['format'] !== KEY_ENVELOPE_FORMAT) {
    throw new SignError('key_envelope_invalid', `不认识的 key 信封格式 ${String(record['format'])}`);
  }
  if (record['kdf'] !== 'argon2id' || record['cipher'] !== 'aes-256-gcm') {
    throw new SignError('key_envelope_invalid', 'key 信封只支持 argon2id + aes-256-gcm');
  }
  const params = record['kdf_params'];
  if (typeof params !== 'object' || params === null) {
    throw new SignError('key_envelope_invalid', 'kdf_params 缺失');
  }
  const p = params as Record<string, unknown>;
  if (p['m'] !== KDF_PARAMS.m || p['t'] !== KDF_PARAMS.t || p['p'] !== KDF_PARAMS.p) {
    throw new SignError('key_envelope_invalid', 'kdf_params 与实现的参数不一致');
  }
  for (const field of ['salt', 'nonce', 'tag', 'ct', 'key_id', 'public_key', 'created_at']) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
      throw new SignError('key_envelope_invalid', `key 信封字段 ${field} 必须是非空字符串`);
    }
  }
  return record as unknown as KeyEnvelope;
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  try {
    return await hashRaw(passphrase, {
      memoryCost: KDF_PARAMS.m,
      timeCost: KDF_PARAMS.t,
      parallelism: KDF_PARAMS.p,
      outputLen: DERIVED_KEY_BYTES,
      algorithm: Algorithm.Argon2id,
      salt,
    });
  } catch (error) {
    throw new SignError('unknown_request', `Argon2id 派生失败：${errorMessage(error)}`);
  }
}

export async function encryptPrivateKey(
  material: KeyMaterial,
  passphrase: string,
  now: Date = new Date(),
): Promise<KeyEnvelope> {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(passphrase, salt);
  const plaintext = material.private_key.export({ type: 'pkcs8', format: 'der' });
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  return {
    format: KEY_ENVELOPE_FORMAT,
    kdf: 'argon2id',
    kdf_params: { ...KDF_PARAMS },
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
    cipher: 'aes-256-gcm',
    ct: ct.toString('base64'),
    key_id: material.key_id,
    public_key: material.public_key,
    created_at: now.toISOString(),
  };
}

/** 错口令 / 篡改信封都会在 GCM 认证处失败，统一 `bad_passphrase`（不泄漏哪一步失败）。 */
export async function decryptPrivateKey(envelope: KeyEnvelope, passphrase: string): Promise<KeyMaterial> {
  const parsed = requireEnvelopeShape(envelope);
  const salt = Buffer.from(parsed.salt, 'base64');
  const nonce = Buffer.from(parsed.nonce, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  const ct = Buffer.from(parsed.ct, 'base64');
  const key = await deriveKey(passphrase, salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    const private_key = createPrivateKey({ key: plaintext, format: 'der', type: 'pkcs8' });
    return { key_id: parsed.key_id, public_key: parsed.public_key, private_key };
  } catch {
    throw new SignError('bad_passphrase', '口令错误或密钥文件被篡改');
  } finally {
    key.fill(0);
  }
}
