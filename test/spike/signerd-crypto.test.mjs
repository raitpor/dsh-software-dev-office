// M2-0s spike 测试：私钥落盘加密（KDF + AES-256-GCM，零依赖，node --test）。
//
// scrypt 路线永远可测；两条 Argon2id 原生路线只在 artifacts/spike/deps 已安装时测，
// 未安装则显式 skip（不伪装通过）。
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REPO_ROOT, importRepoModule } from './_root.mjs';

const crypto = await importRepoModule('scripts/spike/signerd-crypto.mjs');
const {
  ENVELOPE_FIELDS,
  PLAINTEXT_KEY,
  TEST_PASSPHRASE,
  SALT,
  ENVELOPE_FORMAT,
  assertEnvelopeShape,
  envelopeFor,
  findWindowLeaks,
  scanTreeForSecrets,
  decryptEnvelope,
  loadCandidates,
  runCandidate,
  searchSecrets,
} = crypto;

const DEPS_ROOT = join(REPO_ROOT, 'artifacts', 'spike', 'deps');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-crypto-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('scrypt 路线端到端：派生→加密→落盘→重开→解密，盘上是密文', async (t) => {
  const keyDir = scratch(t);
  const candidate = loadCandidates({ depsRoot: DEPS_ROOT }).find((c) => c.id === 'scrypt');
  const result = await runCandidate(candidate, { keyDir });
  assert.equal(result.status, 'pass', JSON.stringify(result, null, 2));
  assert.equal(result.roundtrip_ok, true);
  assert.deepEqual(result.on_disk_ciphertext.plaintext_found, []);
  assert.deepEqual(result.on_disk_ciphertext.window_hits_8_16, []);
  assert.equal(result.on_disk_ciphertext.envelope_shape.ok, true);
  assert.equal(result.on_disk_ciphertext.file_mode, '0600');
  assert.equal(result.wrong_passphrase.failed, true);
  assert.equal(result.wrong_passphrase.derived_key_differs, true);
  assert.equal(result.tamper.failed, true);
  assert.deepEqual(result.insecure_file_perms.refused, true);
  assert.deepEqual(result.insecure_dir_perms.refused, true);

  // 独立复核：盘上文件里搜不到 1KB 明文私钥、口令、派生密钥。
  const bytes = readFileSync(join(keyDir, 'scrypt.key'));
  assert.equal(bytes.includes(PLAINTEXT_KEY), false);
  assert.equal(bytes.includes(Buffer.from(TEST_PASSPHRASE, 'utf8')), false);
});

test('searchSecrets 阳性对照：把明文拼进文件必须被抓到', () => {
  const derivedKey = Buffer.alloc(32, 7);
  const hits = searchSecrets(Buffer.concat([Buffer.from('envelope'), PLAINTEXT_KEY]), [
    { label: 'plaintext_key_full_1KB', value: PLAINTEXT_KEY },
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, 'plaintext_key_full_1KB');
});

test('AES-256-GCM：同一明文不同 nonce ⇒ 密文不同；篡改 tag/ct 必须解密失败', () => {
  const derivedKey = Buffer.alloc(32, 9);
  const a = envelopeFor({ kdf: 'scrypt', params: {}, derivedKey, plaintext: PLAINTEXT_KEY });
  const b = envelopeFor({ kdf: 'scrypt', params: {}, derivedKey, plaintext: PLAINTEXT_KEY });
  assert.equal(a.format, ENVELOPE_FORMAT);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.ct, b.ct);
  assert.deepEqual(decryptEnvelope(a, derivedKey), PLAINTEXT_KEY);

  const badTag = { ...a, tag: a.tag === '0'.repeat(32) ? '1'.repeat(32) : '0'.repeat(32) };
  assert.throws(() => decryptEnvelope(badTag, derivedKey));
  const ctBytes = Buffer.from(a.ct, 'hex');
  ctBytes[0] ^= 0xff;
  assert.throws(() => decryptEnvelope({ ...a, ct: ctBytes.toString('hex') }, derivedKey));
  // 错密钥（同口令不同盐）也必须失败
  assert.throws(() => decryptEnvelope(a, Buffer.alloc(32, 10)));
});

test('envelope 信封只放密文与 KDF 参数，不放明文/口令', () => {
  const derivedKey = Buffer.alloc(32, 3);
  const envelope = envelopeFor({ kdf: 'scrypt', params: { N: 2 ** 15 }, derivedKey, plaintext: PLAINTEXT_KEY });
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes(PLAINTEXT_KEY.toString('hex')), false);
  assert.equal(serialized.includes(TEST_PASSPHRASE), false);
  assert.equal(serialized.includes(derivedKey.toString('hex')), false);
  assert.equal(envelope.salt.length, SALT.length * 2);
  assert.equal(envelope.key_id, 'k-spike-scrypt');
});

for (const candidate of loadCandidates({ depsRoot: DEPS_ROOT })) {
  if (candidate.kdf !== 'argon2id') continue;
  test(`Argon2id 路线 ${candidate.id} 端到端`, async (t) => {
    if (!candidate.available) {
      t.skip(`未安装（${candidate.missingReason}）；先跑 node scripts/spike/signerd-crypto.mjs --install`);
      return;
    }
    const result = await runCandidate(candidate, { keyDir: scratch(t) });
    assert.equal(result.status, 'pass', JSON.stringify(result, null, 2));
    assert.equal(result.roundtrip_ok, true);
    assert.deepEqual(result.on_disk_ciphertext.plaintext_found, []);
    assert.equal(result.wrong_passphrase.failed, true);
    assert.equal(result.tamper.failed, true);
    assert.equal(result.on_disk_ciphertext.file_mode, '0600');
  });
}

test('错误口令派生的密钥不同 ⇒ 解密失败（不是“口令比对”而是 GCM 认证失败）', async (t) => {
  const candidate = loadCandidates({ depsRoot: DEPS_ROOT }).find((c) => c.id === 'scrypt');
  const keyDir = scratch(t);
  const derivedKey = await candidate.derive(TEST_PASSPHRASE, SALT);
  const envelope = envelopeFor({ kdf: 'scrypt', params: {}, derivedKey, plaintext: PLAINTEXT_KEY });
  const wrongKey = await candidate.derive(`${TEST_PASSPHRASE}!`, SALT);
  assert.throws(() => decryptEnvelope(envelope, wrongKey), /unable to authenticate|bad decrypt/i);
  const filePath = join(keyDir, 'x.key');
  writeKey(filePath, `${JSON.stringify(envelope)}\n`);
  const reopened = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.throws(() => decryptEnvelope(reopened, wrongKey));
});

function writeKey(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
}

test('信封结构断言：只允许 ENVELOPE_FIELDS，多一个字段即 red', () => {
  const envelope = envelopeFor({ kdf: 'scrypt', params: {}, derivedKey: Buffer.alloc(32, 5), plaintext: PLAINTEXT_KEY });
  assert.deepEqual(assertEnvelopeShape(envelope).fields, [...ENVELOPE_FIELDS].sort());
  assert.throws(
    () => assertEnvelopeShape({ ...envelope, plaintext: 'leak' }),
    /unexpected field\(s\): plaintext/,
  );
  const { tag: _tag, ...missing } = envelope;
  assert.throws(() => assertEnvelopeShape(missing), /missing field\(s\): tag/);
  assert.throws(() => assertEnvelopeShape({ ...envelope, cipher: 'aes-128-cbc' }), /unexpected cipher/);
  assert.throws(() => assertEnvelopeShape({ ...envelope, salt: 'abc' }), /salt must be 16-byte/);
});

test('滑窗 / 前缀搜索：任意 8B、16B 明文窗口出现在盘上都算泄漏', () => {
  const key = Buffer.alloc(32, 1);
  const clean = Buffer.from('{"ct":"deadbeef"}', 'utf8');
  assert.deepEqual(findWindowLeaks(clean), []);

  for (const size of [8, 16]) {
    const leaky = Buffer.concat([Buffer.from('prefix'), PLAINTEXT_KEY.subarray(37, 37 + size), Buffer.from('suffix')]);
    const hits = findWindowLeaks(leaky);
    assert.ok(hits.length > 0, `${size}B 窗口泄漏必须被抓到`);
    assert.ok(hits.some((hit) => hit.label === `plaintext_window_${size}B`));
  }
  // 前缀（整段之外）也必须能被精确串搜到
  const hits = searchSecrets(Buffer.from(PLAINTEXT_KEY.subarray(0, 8)), [
    { label: 'plaintext_prefix_8B', value: PLAINTEXT_KEY.subarray(0, 8) },
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, 'plaintext_prefix_8B');
});

test('目录扫描：key 文件与同级文本里都没有明文；一种植入 8B 明文即 red', (t) => {
  const dir = scratch(t);
  const keyFile = join(dir, 'nested', 'a.key');
  mkdirSync(join(dir, 'nested'));
  const derivedKey = Buffer.alloc(32, 11);
  const envelope = envelopeFor({ kdf: 'scrypt', params: {}, derivedKey, plaintext: PLAINTEXT_KEY });
  writeFileSync(keyFile, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'note.txt'), 'nothing secret here\n');

  const results = [{ id: 'scrypt', derivedKey }];
  const clean = scanTreeForSecrets(dir, { results });
  assert.equal(clean.hits.length, 0, JSON.stringify(clean.hits));
  assert.equal(clean.files_scanned, 2);

  writeFileSync(join(dir, 'leak.bin'), PLAINTEXT_KEY.subarray(100, 108), { mode: 0o600 });
  const leaky = scanTreeForSecrets(dir, { results });
  assert.equal(leaky.hits.length, 1);
  assert.match(leaky.hits[0].path, /leak\.bin$/);
});
