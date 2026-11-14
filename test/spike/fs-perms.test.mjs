// M2-0s spike 测试：文件/目录权限校验（零依赖，node --test）。
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importRepoModule } from './_root.mjs';

const perms = await importRepoModule('scripts/spike/fs-perms.mjs');
const {
  PermissionError,
  PERM_ERROR,
  assertOwnerOnlyDir,
  assertOwnerOnlyFile,
  chmodSyncSafe,
  createOwnerOnlyDir,
  formatMode,
  isOwnerOnlyMode,
  permissionBits,
  readOwnerOnlyFile,
  writeOwnerOnlyFile,
} = perms;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-perms-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('permissionBits 只取低 9 位：st.mode 含文件类型位，直接比较必错', (t) => {
  const dir = scratch(t);
  const file = join(dir, 'plain.txt');
  writeFileSync(file, 'x', { mode: 0o600 });
  chmodSync(file, 0o600);
  const stat = statSync(file);
  assert.equal(permissionBits(stat), 0o600);
  assert.notEqual(stat.mode, 0o600, 'st.mode 含 S_IFREG(0o100000)，与 0o600 直接比较永远不等');
  assert.equal(formatMode(stat), '0600');
});

test('createOwnerOnlyDir 建出并校验 0700', (t) => {
  const dir = scratch(t);
  const target = join(dir, 'state');
  const info = createOwnerOnlyDir(target);
  assert.equal(formatMode(statSync(target)), '0700');
  assert.equal(info.mode, '0700');
});

test('assertOwnerOnlyDir 拒绝 0755（稳定码 dir_perm_insecure）', (t) => {
  const dir = scratch(t);
  const target = join(dir, 'wide');
  createOwnerOnlyDir(target);
  chmodSync(target, 0o755);
  assert.throws(
    () => assertOwnerOnlyDir(target),
    (error) => error instanceof PermissionError && error.code === PERM_ERROR.dir_insecure,
  );
});

test('assertOwnerOnlyDir 拒绝缺失与符号链接', (t) => {
  const dir = scratch(t);
  assert.throws(
    () => assertOwnerOnlyDir(join(dir, 'nope')),
    (error) => error.code === PERM_ERROR.missing,
  );
  const real = join(dir, 'real');
  createOwnerOnlyDir(real);
  const link = join(dir, 'link');
  symlinkSync(real, link, 'dir');
  assert.throws(
    () => assertOwnerOnlyDir(link),
    (error) => error.code === PERM_ERROR.symlink,
  );
});

test('writeOwnerOnlyFile 落盘 0600 且可读回；不覆盖已有文件', (t) => {
  const dir = scratch(t);
  const target = join(dir, 'key.bin');
  const payload = Buffer.from('secret-material', 'utf8');
  const info = writeOwnerOnlyFile(target, payload);
  assert.equal(info.mode, '0600');
  assert.equal(info.size, payload.length);
  assert.deepEqual(readOwnerOnlyFile(target), payload);
  assert.throws(() => writeOwnerOnlyFile(target, Buffer.from('other')), /EEXIST/);
});

test('readOwnerOnlyFile 在 0644 时先拒绝（fail-closed），错误码 file_perm_insecure', (t) => {
  const dir = scratch(t);
  const target = join(dir, 'key.bin');
  writeOwnerOnlyFile(target, Buffer.from('secret'));
  chmodSync(target, 0o644);
  assert.throws(
    () => readOwnerOnlyFile(target),
    (error) => error instanceof PermissionError && error.code === PERM_ERROR.file_insecure,
  );
});

test('readOwnerOnlyFile 拒绝符号链接、缺失、目录', (t) => {
  const dir = scratch(t);
  const real = join(dir, 'key.bin');
  writeOwnerOnlyFile(real, Buffer.from('secret'));
  const link = join(dir, 'key.link');
  symlinkSync(real, link);
  assert.throws(
    () => readOwnerOnlyFile(link),
    (error) => error.code === PERM_ERROR.symlink,
  );
  assert.throws(
    () => readOwnerOnlyFile(join(dir, 'absent.bin')),
    (error) => error.code === PERM_ERROR.missing,
  );
  assert.throws(
    () => assertOwnerOnlyFile(dir),
    (error) => error.code === PERM_ERROR.not_regular_file,
  );
});

test('chmodSyncSafe 显式改权限位并可再次校验', (t) => {
  const dir = scratch(t);
  const target = join(dir, 'key.bin');
  writeOwnerOnlyFile(target, Buffer.from('secret'));
  chmodSyncSafe(target, 0o600);
  assert.equal(assertOwnerOnlyFile(target).mode, '0600');
});

test('isOwnerOnlyMode 严格恰 0600/0700：0400、0700 文件与 0750、1700 目录都拒', () => {
  assert.equal(isOwnerOnlyMode(0o600), true);
  assert.equal(isOwnerOnlyMode(0o400), false, '只读 0400 不够，key 必须恰 0600');
  assert.equal(isOwnerOnlyMode(0o700), false, '文件带执行位 0700 不算 owner-only key');
  assert.equal(isOwnerOnlyMode(0o640), false);
  assert.equal(isOwnerOnlyMode(0o600, { dir: true }), false, '目录 0600 不能读写进入');
  assert.equal(isOwnerOnlyMode(0o700, { dir: true }), true);
  assert.equal(isOwnerOnlyMode(0o750, { dir: true }), false);
  assert.equal(isOwnerOnlyMode(0o1700, { dir: true }), false, 'sticky 位也算不合格');
});

test('0400/0700 的 key 文件在读取前被拒（file_perm_insecure）', (t) => {
  const dir = scratch(t);
  for (const mode of [0o400, 0o700]) {
    const target = join(dir, `key-${mode.toString(8)}.bin`);
    writeOwnerOnlyFile(target, Buffer.from('secret'));
    chmodSync(target, mode);
    assert.throws(
      () => readOwnerOnlyFile(target),
      (error) => error instanceof PermissionError && error.code === PERM_ERROR.file_insecure,
      `mode ${mode.toString(8)} 必须被拒`,
    );
  }
});

test('0750 目录在读取前被拒（dir_perm_insecure）', (t) => {
  const dir = scratch(t);
  const target = join(dir, 'state');
  createOwnerOnlyDir(target);
  chmodSync(target, 0o750);
  assert.throws(
    () => assertOwnerOnlyDir(target),
    (error) => error instanceof PermissionError && error.code === PERM_ERROR.dir_insecure,
  );
});
