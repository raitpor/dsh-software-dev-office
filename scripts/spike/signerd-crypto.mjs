#!/usr/bin/env node
// M2-0s spike：signerd 私钥落盘加密的三条路线实测（零产品依赖；带 --install 复跑安装行为）。
//
// 三条路线：
//   (a) argon2@0.45.2        原生 node-gyp-build + 包内 prebuilds（无需编译）
//   (b) @node-rs/argon2@2.2.2 napi-rs，平台二进制走 optionalDependencies（无 install 脚本）
//   (c) node:crypto scrypt    零依赖兜底（N=2^15, r=8, p=1, maxmem 64MiB）
//
// 每个路线跑：
//   1. KDF 派生 32B 密钥（Argon2id：m=19456KiB, t=2, p=1；scrypt：N=32768, r=8, p=1）
//   2. AES-256-GCM 加密 1KB 固定测试私钥 → 写盘（0600）
//   3. 重开文件（先验权限，O_NOFOLLOW + fstat）→ 用口令解密 → 与明文逐字节比对
//   4. 结构断言：key 文件顶层**恰好**是信封字段（多/少字段即 red）
//   5. 盘上是密文的证据：整段明文、7 种前缀、任意 8/16B 滑动窗口、hex/base64、口令、派生密钥
//   6. 整个 artifacts/spike 目录（不只 key 文件）都扫一遍，任何文件命中都算 red
//   7. 错口令必须解密失败（GCM 认证失败），篡改一字节也必须失败
//   8. 0600 被改成 0644 ⇒ 读取前就拒绝（稳定码 file_perm_insecure）
//
// 用法（仓库根）：
//   node scripts/spike/signerd-crypto.mjs                 # 只用已装好的依赖跑三条路线
//   node scripts/spike/signerd-crypto.mjs --install       # 先复跑两条原生路线的安装（联网）
//   node scripts/spike/signerd-crypto.mjs --json artifacts/spike/signerd-crypto.json
//
// 依赖装在 artifacts/spike/deps/（gitignored），**不进产品 package.json**。
import { spawnSync } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PermissionError,
  assertOwnerOnlyDir,
  chmodSyncSafe,
  createOwnerOnlyDir,
  readOwnerOnlyFile,
  writeOwnerOnlyFile,
} from './fs-perms.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = join(root, 'artifacts', 'spike');
const DEPS_ROOT = join(ARTIFACTS, 'deps');
const KEY_DIR = join(ARTIFACTS, 'keys');
const NPM_CACHE = join(root, 'artifacts', '.npmcache');

export const ENVELOPE_FORMAT = 'sdo-signerd-key-v1';
export const TEST_PASSPHRASE = 'correct horse battery staple';
/** 固定测试私钥：1KB 确定性字节（i*7+13 mod 256，周期 256 ⇒ 重复 4 次），便于全字节序列搜索。 */
export const PLAINTEXT_KEY = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 7 + 13) & 0xff));
/** 固定盐：仅为了可复算；正式实现必须每把钥匙随机 16B 盐。 */
export const SALT = Buffer.from('sdo-m2-0s-spike!', 'utf8');
if (SALT.length !== 16) throw new Error('SALT must be 16 bytes');
export const KDF_PARAMS = Object.freeze({
  argon2id: { memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32 },
  scrypt: { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024, hashLength: 32 },
});
/** key 文件顶层只允许这些字段（顺序无关）；多一个字段即 red —— 防止把明文/口令顺手写进信封。 */
export const ENVELOPE_FIELDS = Object.freeze(['cipher', 'ct', 'format', 'kdf', 'kdf_params', 'key_id', 'nonce', 'salt', 'tag']);

const ARGON2_SPEC = 'argon2@0.45.2';
const NODE_RS_SPEC = '@node-rs/argon2@2.2.2';

const INSTALL_TARGETS = [
  { id: 'argon2-native', dir: 'argon2-native', spec: ARGON2_SPEC, module: 'argon2' },
  { id: 'argon2-node-rs', dir: 'argon2rs', spec: NODE_RS_SPEC, module: '@node-rs/argon2' },
];

function nowMs() {
  return performance.now();
}

function requireFrom(dir, moduleName) {
  const req = createRequire(join(dir, 'package.json'));
  return req(moduleName);
}

export function loadCandidates({ depsRoot = DEPS_ROOT, log = () => {} } = {}) {
  const candidates = [
    {
      id: 'scrypt',
      kdf: 'scrypt',
      available: true,
      params: KDF_PARAMS.scrypt,
      derive: (passphrase, salt) =>
        scryptSync(passphrase, salt, KDF_PARAMS.scrypt.hashLength, {
          N: KDF_PARAMS.scrypt.N,
          r: KDF_PARAMS.scrypt.r,
          p: KDF_PARAMS.scrypt.p,
          maxmem: KDF_PARAMS.scrypt.maxmem,
        }),
    },
  ];

  for (const target of INSTALL_TARGETS) {
    const dir = join(depsRoot, target.dir);
    let mod = null;
    let error = null;
    try {
      mod = requireFrom(dir, target.module);
    } catch (cause) {
      error = `${cause.code ?? ''} ${cause.message ?? cause}`.trim();
    }
    if (!mod) {
      candidates.push({
        id: target.id,
        kdf: 'argon2id',
        available: false,
        params: KDF_PARAMS.argon2id,
        missingReason: error,
        installHint: `node scripts/spike/signerd-crypto.mjs --install  # 或 npm install --prefix ${dir} ${target.spec}`,
        derive: null,
      });
      log(`[skip] ${target.id}: ${error}`);
      continue;
    }
    if (target.id === 'argon2-native') {
      candidates.push({
        id: target.id,
        kdf: 'argon2id',
        available: true,
        params: KDF_PARAMS.argon2id,
        module: { name: target.module, version: modVersion(dir, target.module) },
        derive: (passphrase, salt) =>
          mod.hash(passphrase, {
            type: mod.argon2id,
            raw: true,
            salt,
            hashLength: KDF_PARAMS.argon2id.hashLength,
            memoryCost: KDF_PARAMS.argon2id.memoryCost,
            timeCost: KDF_PARAMS.argon2id.timeCost,
            parallelism: KDF_PARAMS.argon2id.parallelism,
          }),
      });
    } else {
      candidates.push({
        id: target.id,
        kdf: 'argon2id',
        available: true,
        params: KDF_PARAMS.argon2id,
        module: { name: target.module, version: modVersion(dir, target.module) },
        derive: (passphrase, salt) =>
          mod.hashRaw(passphrase, {
            algorithm: mod.Algorithm?.Argon2id ?? 2,
            salt,
            outputLen: KDF_PARAMS.argon2id.hashLength,
            memoryCost: KDF_PARAMS.argon2id.memoryCost,
            timeCost: KDF_PARAMS.argon2id.timeCost,
            parallelism: KDF_PARAMS.argon2id.parallelism,
          }),
      });
    }
  }
  return candidates;
}

function modVersion(dir, moduleName) {
  try {
    return requireFrom(dir, `${moduleName}/package.json`).version;
  } catch {
    return null;
  }
}

export function envelopeFor({ kdf, params, derivedKey, plaintext }) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: ENVELOPE_FORMAT,
    kdf,
    kdf_params: params,
    salt: SALT.toString('hex'),
    cipher: 'aes-256-gcm',
    nonce: nonce.toString('hex'),
    tag: tag.toString('hex'),
    ct: ciphertext.toString('hex'),
    key_id: `k-spike-${kdf}`,
  };
}

export function decryptEnvelope(envelope, derivedKey) {
  if (envelope.format !== ENVELOPE_FORMAT) throw new Error(`unknown envelope format ${envelope.format}`);
  const decipher = createDecipheriv('aes-256-gcm', derivedKey, Buffer.from(envelope.nonce, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'hex')), decipher.final()]);
}

function serializeEnvelope(envelope) {
  return `${JSON.stringify(envelope)}\n`;
}

/** 盘上是否出现任何应当保密的字节序列；返回命中列表（空 = 密文证据成立）。 */
export function searchSecrets(fileBytes, secrets) {
  const hits = [];
  for (const { label, value } of secrets) {
    const offset = fileBytes.indexOf(value);
    if (offset !== -1) hits.push({ label, offset });
  }
  return hits;
}

/**
 * 结构断言：key 文件顶层必须**恰好**是 ENVELOPE_FIELDS，字段类型/十六进制长度也要对。
 * 多字段、少字段、明文混入都会抛错（调用方捕获后记为 red）。
 */
export function assertEnvelopeShape(envelope) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('envelope is not a JSON object');
  }
  const keys = Object.keys(envelope).sort();
  const expected = [...ENVELOPE_FIELDS].sort();
  const extra = keys.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !keys.includes(key));
  if (extra.length > 0) throw new Error(`envelope has unexpected field(s): ${extra.join(',')}`);
  if (missing.length > 0) throw new Error(`envelope missing field(s): ${missing.join(',')}`);
  if (envelope.format !== ENVELOPE_FORMAT) throw new Error(`unexpected envelope format: ${envelope.format}`);
  if (envelope.cipher !== 'aes-256-gcm') throw new Error(`unexpected cipher: ${envelope.cipher}`);
  if (typeof envelope.kdf !== 'string' || envelope.kdf.length === 0) throw new Error('envelope.kdf missing');
  if (envelope.kdf_params === null || typeof envelope.kdf_params !== 'object' || Array.isArray(envelope.kdf_params)) {
    throw new Error('envelope.kdf_params is not an object');
  }
  const expectHex = (field, bytes) => {
    const value = envelope[field];
    if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) {
      throw new Error(`envelope.${field} must be ${bytes}-byte lowercase hex`);
    }
  };
  expectHex('salt', 16);
  expectHex('nonce', 12);
  expectHex('tag', 16);
  if (typeof envelope.ct !== 'string' || envelope.ct.length === 0 || envelope.ct.length % 2 !== 0 || !/^[0-9a-f]+$/.test(envelope.ct)) {
    throw new Error('envelope.ct must be non-empty even-length lowercase hex');
  }
  if (typeof envelope.key_id !== 'string' || envelope.key_id.length === 0) throw new Error('envelope.key_id missing');
  return { ok: true, fields: keys };
}

/**
 * 前缀 + 滑动窗口搜索：任意 8/16 字节的明文窗口都不许出现在盘上。
 * 窗口去重后逐个 indexOf（1KB 周期明文只有 256 个唯一窗口），成本可控。
 */
export function findWindowLeaks(fileBytes, plaintext = PLAINTEXT_KEY, { sizes = [8, 16] } = {}) {
  const hits = [];
  for (const size of sizes) {
    if (plaintext.length < size) continue;
    const seen = new Set();
    for (let offset = 0; offset + size <= plaintext.length; offset += 1) {
      const window = plaintext.subarray(offset, offset + size);
      const key = window.toString('hex');
      if (seen.has(key)) continue;
      seen.add(key);
      const at = fileBytes.indexOf(window);
      if (at !== -1) {
        hits.push({ label: `plaintext_window_${size}B`, offset: at, window_offset: offset, window_hex: key.slice(0, 32) });
        if (hits.length >= 20) return hits;
      }
    }
  }
  return hits;
}

function secretsFor(derivedKey) {
  return [
    { label: 'plaintext_key_full_1KB', value: PLAINTEXT_KEY },
    { label: 'plaintext_key_hex', value: Buffer.from(PLAINTEXT_KEY.toString('hex'), 'utf8') },
    { label: 'plaintext_key_base64', value: Buffer.from(PLAINTEXT_KEY.toString('base64'), 'utf8') },
    { label: 'passphrase_utf8', value: Buffer.from(TEST_PASSPHRASE, 'utf8') },
    { label: 'derived_key_bytes', value: derivedKey },
    { label: 'derived_key_hex', value: Buffer.from(derivedKey.toString('hex'), 'utf8') },
    // 前缀：整段之外，文件里也不许出现明文的任意前缀。
    ...[8, 16, 32, 64, 128, 256, 512]
      .filter((length) => length <= PLAINTEXT_KEY.length)
      .map((length) => ({ label: `plaintext_prefix_${length}B`, value: PLAINTEXT_KEY.subarray(0, length) })),
  ];
}

export async function runCandidate(candidate, { keyDir = KEY_DIR } = {}) {
  if (!candidate.available) {
    return {
      id: candidate.id,
      kdf: candidate.kdf,
      status: 'skipped',
      available: false,
      missing_reason: candidate.missingReason,
      install_hint: candidate.installHint,
    };
  }

  createOwnerOnlyDir(keyDir);
  const file = join(keyDir, `${candidate.id}.key`);
  rmSync(file, { force: true });

  const deriveMs = [];
  let derivedKey = null;
  for (let i = 0; i < 3; i += 1) {
    const t0 = nowMs();
    derivedKey = await candidate.derive(TEST_PASSPHRASE, SALT);
    deriveMs.push(Number((nowMs() - t0).toFixed(3)));
  }
  if (!Buffer.isBuffer(derivedKey) || derivedKey.length !== 32) {
    return {
      id: candidate.id,
      status: 'fail',
      failure: `derived key is not 32 bytes (got ${derivedKey?.length ?? typeof derivedKey})`,
    };
  }

  const wrongKey = await candidate.derive(`${TEST_PASSPHRASE}!`, SALT);
  const envelope = envelopeFor({
    kdf: candidate.kdf,
    params: candidate.params,
    derivedKey,
    plaintext: PLAINTEXT_KEY,
  });
  const serialized = serializeEnvelope(envelope);

  const tEnc0 = nowMs();
  const written = writeOwnerOnlyFile(file, Buffer.from(serialized, 'utf8'));
  const encryptMs = Number((nowMs() - tEnc0).toFixed(3));

  const tDec0 = nowMs();
  const fileBytes = readOwnerOnlyFile(file);
  const reopened = JSON.parse(fileBytes.toString('utf8'));
  const decrypted = decryptEnvelope(reopened, derivedKey);
  const decryptMs = Number((nowMs() - tDec0).toFixed(3));

  const roundtripOk = decrypted.equals(PLAINTEXT_KEY);
  const exactHits = searchSecrets(fileBytes, secretsFor(derivedKey));
  const windowHits = findWindowLeaks(fileBytes, PLAINTEXT_KEY, { sizes: [8, 16] });
  const secretsHits = [...exactHits, ...windowHits];
  const ciphertextDiffers = reopened.ct !== PLAINTEXT_KEY.toString('hex');

  let envelopeShape;
  try {
    envelopeShape = { ...assertEnvelopeShape(reopened), file: file };
  } catch (error) {
    envelopeShape = { ok: false, error: error.message, file };
  }

  let wrongPassphrase = null;
  try {
    const badKey = Buffer.from(wrongKey);
    decryptEnvelope(reopened, badKey);
    wrongPassphrase = { failed: false, error: null };
  } catch (error) {
    wrongPassphrase = { failed: true, error: { name: error.name, code: error.code ?? null, message: error.message } };
  }
  const wrongKeyDiffers = !Buffer.from(wrongKey).equals(derivedKey);

  const tampered = { ...reopened };
  const ctBytes = Buffer.from(tampered.ct, 'hex');
  ctBytes[ctBytes.length - 1] ^= 0xff;
  tampered.ct = ctBytes.toString('hex');
  let tamper = null;
  try {
    decryptEnvelope(tampered, derivedKey);
    tamper = { failed: false };
  } catch (error) {
    tamper = { failed: true, error: { name: error.name, message: error.message } };
  }

  // 权限负例：0600 改成 0644 必须在读取内容之前拒绝。
  chmodSyncSafe(file, 0o644);
  let insecureRead = null;
  try {
    readOwnerOnlyFile(file);
    insecureRead = { refused: false };
  } catch (error) {
    insecureRead = {
      refused: error instanceof PermissionError,
      code: error.code ?? null,
      message: error.message,
    };
  }
  chmodSyncSafe(file, 0o600);

  // 目录负例：0700 改成 0755 必须拒绝。
  chmodSyncSafe(keyDir, 0o755);
  let insecureDir = null;
  try {
    assertOwnerOnlyDir(keyDir);
    insecureDir = { refused: false };
  } catch (error) {
    insecureDir = { refused: error instanceof PermissionError, code: error.code ?? null };
  }
  chmodSyncSafe(keyDir, 0o700);

  const ok =
    roundtripOk &&
    envelopeShape.ok === true &&
    secretsHits.length === 0 &&
    ciphertextDiffers &&
    wrongKeyDiffers &&
    wrongPassphrase.failed &&
    tamper.failed &&
    written.mode === '0600' &&
    insecureRead.refused &&
    insecureDir.refused;

  const result = {
    id: candidate.id,
    kdf: candidate.kdf,
    status: ok ? 'pass' : 'fail',
    module: candidate.module ?? 'node:crypto',
    params: candidate.params,
    file: { path: file, bytes: fileBytes.length, mode: written.mode },
    timings_ms: {
      derive_samples: deriveMs,
      derive_median: median(deriveMs),
      encrypt: encryptMs,
      decrypt: decryptMs,
    },
    roundtrip_ok: roundtripOk,
    on_disk_ciphertext: {
      plaintext_found: secretsHits,
      exact_secret_hits: exactHits,
      window_hits_8_16: windowHits,
      envelope_shape: envelopeShape,
      ciphertext_equals_plaintext: !ciphertextDiffers,
      file_mode: written.mode,
    },
    wrong_passphrase: { ...wrongPassphrase, derived_key_differs: wrongKeyDiffers },
    tamper,
    insecure_file_perms: insecureRead,
    insecure_dir_perms: insecureDir,
    failure: ok ? null : 'one or more checks failed',
  };
  // 派生密钥只用于同进程内存里的目录扫描，绝不进 JSON 报告。
  Object.defineProperty(result, 'derivedKey', { value: Buffer.from(derivedKey), enumerable: false });
  return result;
}

/**
 * 对整个 artifacts/spike 目录做保密扫描：不只 key 文件，任何文件里出现
 * 明文/口令/派生密钥（精确串）或明文任意 8/16B 窗口都算 red。
 * 单文件 > maxBytes 记 skipped（当前最大 728KB），避免 spike 被超大二进制拖慢。
 */
export function scanTreeForSecrets(rootDir, { results = [], maxBytes = 2 * 1024 * 1024, plaintext = PLAINTEXT_KEY } = {}) {
  const secrets = [];
  const seenKeys = new Set();
  for (const result of results) {
    if (!result?.derivedKey) continue;
    const hex = result.derivedKey.toString('hex');
    if (seenKeys.has(hex)) continue;
    seenKeys.add(hex);
    secrets.push(...secretsFor(result.derivedKey));
  }
  if (secrets.length === 0) secrets.push(...secretsFor(Buffer.alloc(32)));
  const hits = [];
  const skipped = [];
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const size = statSync(full).size;
        if (size > maxBytes) {
          skipped.push({ path: relative(rootDir, full), bytes: size });
          continue;
        }
        const buf = readFileSync(full);
        files += 1;
        bytes += buf.length;
        const exact = searchSecrets(buf, secrets);
        const windows = findWindowLeaks(buf, plaintext, { sizes: [8, 16] });
        if (exact.length > 0 || windows.length > 0) {
          hits.push({ path: relative(rootDir, full), exact, windows });
        }
      }
    }
  };
  walk(rootDir);
  return { root: rootDir, files_scanned: files, bytes_scanned: bytes, skipped_large_files: skipped, hits };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(3));
}

export function runAll({ candidates, keyDir = KEY_DIR } = {}) {
  const results = [];
  return (async () => {
    for (const candidate of candidates) {
      results.push(await runCandidate(candidate, { keyDir }));
    }
    return results;
  })();
}

// ---------------------------------------------------------------------------
// 安装行为实测：两个原生候选 × {--ignore-scripts, 默认脚本}。记录退出码/耗时/
// 构建脚本是否真的跑了/装完能否 require。
// ---------------------------------------------------------------------------

function writeMinimalPackageJson(dir, name) {
  mkdirSync(dir, { recursive: true });
  const pkg = { name, private: true, version: '0.0.0' };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

export function probeInstall({ depsRoot = DEPS_ROOT, log = () => {} } = {}) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const report = [];
  for (const target of INSTALL_TARGETS) {
    const dir = join(depsRoot, target.dir);
    for (const mode of ['ignore-scripts', 'scripts-enabled']) {
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
      rmSync(join(dir, 'package-lock.json'), { force: true });
      writeMinimalPackageJson(dir, `sdo-spike-${target.id.replace(/[^a-z0-9-]/g, '-')}`);
      const args = [
        'install',
        '--prefix',
        dir,
        '--no-audit',
        '--no-fund',
        '--foreground-scripts',
        ...(mode === 'ignore-scripts' ? ['--ignore-scripts'] : []),
        target.spec,
      ];
      const t0 = nowMs();
      const result = spawnSync('npm', args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 300_000,
        env: { ...process.env, npm_config_cache: NPM_CACHE, npm_config_audit: 'false', npm_config_fund: 'false' },
      });
      const wallMs = Number((nowMs() - t0).toFixed(0));
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const logFile = join(ARTIFACTS, `install-${target.id}-${mode}.log`);
      writeFileSync(logFile, output);
      let load = null;
      try {
        const mod = requireFrom(dir, target.module);
        load = { ok: true, version: modVersion(dir, target.module) };
      } catch (error) {
        load = { ok: false, error: `${error.code ?? ''} ${error.message}`.trim() };
      }
      const record = {
        candidate: target.id,
        spec: target.spec,
        mode,
        exit_code: result.status,
        wall_ms: wallMs,
        npm_summary: firstMatch(output, /added \d+ packages?[^\n]*/g),
        build_script_ran: /node-gyp|gyp info|prebuildify/i.test(output),
        install_script_invoked: /install-scripts|install: /i.test(output),
        compiled_from_source: /gyp info using|gyp ERR!/i.test(output),
        load,
        log: logFile,
      };
      report.push(record);
      log(
        `[install] ${target.id} ${mode}: exit=${record.exit_code} ${wallMs}ms build_script=${record.build_script_ran} load=${load.ok}`,
      );
    }
  }
  return report;
}

function firstMatch(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches[0].trim() : null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { install: false, json: join(ARTIFACTS, 'signerd-crypto.json') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--install') options.install = true;
    else if (argv[i] === '--json') options.json = resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
  }
  return options;
}

function printResult(result) {
  if (result.status === 'skipped') {
    console.log(`[skip] ${result.id} (kdf=${result.kdf}): ${result.missing_reason}`);
    console.log(`       -> ${result.install_hint}`);
    return;
  }
  const t = result.timings_ms ?? {};
  const onDisk = result.on_disk_ciphertext ?? {};
  console.log(
    `[${result.status}] ${result.id.padEnd(15)} kdf=${String(result.kdf).padEnd(8)} ` +
      `derive=${String(t.derive_median).padStart(7)}ms encrypt=${String(t.encrypt).padStart(6)}ms ` +
      `decrypt=${String(t.decrypt).padStart(6)}ms file=${onDisk.file_mode} ${result.file?.bytes ?? '?'}B`,
  );
  console.log(
    `        roundtrip=${result.roundtrip_ok} plaintext_in_file=${JSON.stringify(onDisk.plaintext_found)} ` +
      `wrong_passphrase_rejected=${result.wrong_passphrase?.failed} tamper_rejected=${result.tamper?.failed} ` +
      `insecure_file_refused=${result.insecure_file_perms?.refused}(${result.insecure_file_perms?.code}) ` +
      `insecure_dir_refused=${result.insecure_dir_perms?.refused}(${result.insecure_dir_perms?.code})`,
  );
  if (result.failure) console.log(`        FAILURE: ${result.failure}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node scripts/spike/signerd-crypto.mjs [--install] [--json <path>]');
    return 0;
  }
  mkdirSync(ARTIFACTS, { recursive: true });
  const installed = options.install ? probeInstall({ log: console.log }) : null;
  const candidates = loadCandidates({ log: console.log });
  const results = await runAll({ candidates });
  console.log('---');
  for (const result of results) printResult(result);
  const treeScan = scanTreeForSecrets(ARTIFACTS, { results });
  console.log(
    `--- tree scan ${treeScan.root}: files=${treeScan.files_scanned} bytes=${treeScan.bytes_scanned} ` +
      `skipped=${treeScan.skipped_large_files.length} hits=${treeScan.hits.length}`,
  );
  for (const hit of treeScan.hits) console.log(`        LEAK ${JSON.stringify(hit)}`);
  const summary = {
    spike: 'M2-0s/signerd-crypto',
    at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    plaintext_key_sha256: createHash('sha256').update(PLAINTEXT_KEY).digest('hex'),
    install: installed,
    results,
    tree_scan: treeScan,
  };
  writeFileSync(options.json, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`--- json: ${options.json}`);
  const failed = results.filter((r) => r.status === 'fail');
  const leaked = treeScan.hits.length > 0;
  return failed.length === 0 && !leaked ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
