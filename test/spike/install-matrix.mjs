// M0-0 C4 安装矩阵：可重放脚本（不参与 npm test）。
// 用法（仓库根）：node test/spike/install-matrix.mjs [--out artifacts/install-matrix.log]
// 六格：{npm install, npm ci, npm ci --ignore-scripts} × {13.0.3, 12.11.1}。
// 每格记录：install 退出码/耗时、是否触发 node-gyp、二进制来源、装完能否开加密库。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outIndex = process.argv.indexOf('--out');
const outFile = outIndex >= 0 && process.argv[outIndex + 1] ? resolve(process.argv[outIndex + 1]) : null;

const DRIVER = 'better-sqlite3-multiple-ciphers';
const VERSIONS = ['13.0.3', '12.11.1'];
const MODES = [
  { label: 'npm install', argv: ['install', '--foreground-scripts'], lock: false },
  { label: 'npm ci', argv: ['ci', '--foreground-scripts'], lock: true },
  { label: 'npm ci --ignore-scripts', argv: ['ci', '--ignore-scripts', '--foreground-scripts'], lock: true },
];

// HOME 在只读沙箱里不可写：npm 缓存放系统临时目录，跑完即删，不进工作树。
const cache = mkdtempSync(join(tmpdir(), 'sdo-npm-cache-'));
const env = { ...process.env, npm_config_cache: cache, npm_config_audit: 'false', npm_config_fund: 'false' };

function npm(args, cwd) {
  const t0 = performance.now();
  const r = spawnSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  return {
    status: r.status,
    error: r.error,
    ms: Math.round(performance.now() - t0),
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

function packageJson(version) {
  return JSON.stringify({ name: 'sdo-install-matrix', private: true, dependencies: { [DRIVER]: version } }, null, 2);
}

function makeLock(version) {
  const dir = mkdtempSync(join(tmpdir(), `sdo-lock-${version}-`));
  writeFileSync(join(dir, 'package.json'), packageJson(version));
  const r = npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  if (r.status !== 0) {
    throw new Error(`lock generation failed for ${version}:\n${r.out.slice(-800)}`);
  }
  return { dir, lock: readFileSync(join(dir, 'package-lock.json'), 'utf8') };
}

// 在被测 cell 内的 node_modules 里 require 驱动，做一次加密往返。
const PROBE = `
import Database from 'better-sqlite3-multiple-ciphers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'sdo-probe-'));
try {
  const file = join(dir, 'events.db');
  const open = () => {
    const db = new Database(file);
    db.pragma("cipher='sqlcipher'");
    db.pragma('legacy=4');
    db.key(Buffer.from('correct horse battery staple', 'utf8'));
    return db;
  };
  const db = open();
  db.exec('CREATE TABLE event (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL)');
  db.prepare('INSERT INTO event VALUES (?, ?)').run(1, 'intent.signed');
  db.close();
  const again = open();
  const row = again.prepare('SELECT seq, kind FROM event WHERE seq = 1').get();
  again.close();
  if (!row || row.seq !== 1) throw new Error('reopened row mismatch');
  console.log('OPEN_OK');
} catch (error) {
  console.log('OPEN_FAIL: ' + (error.code ? error.code + ' ' : '') + String(error.message).split('\\n')[0].slice(0, 140));
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
`;

function probeOpen(cell) {
  writeFileSync(join(cell, 'probe.mjs'), PROBE);
  const r = spawnSync(process.execPath, ['probe.mjs'], { cwd: cell, env, encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (/OPEN_OK/.test(out)) return { open: 'OK', detail: '' };
  const failLine = out.split('\n').find((line) => /OPEN_FAIL|Error/.test(line)) ?? out.split('\n')[0] ?? '(no output)';
  return { open: 'FAIL', detail: failLine.trim().slice(0, 180) };
}

function firstGypError(out) {
  const lines = out.split('\n');
  const line =
    lines.find((l) => /gyp ERR! stack Error/.test(l)) ??
    lines.find((l) => /gyp ERR!/.test(l));
  return line ? line.trim().slice(0, 180) : '';
}

const rows = [];
const notes = [];
const locks = new Map();

try {
  for (const version of VERSIONS) locks.set(version, makeLock(version));

  for (const version of VERSIONS) {
    for (const mode of MODES) {
      const cell = mkdtempSync(join(tmpdir(), `sdo-cell-${version}-`));
      writeFileSync(join(cell, 'package.json'), packageJson(version));
      if (mode.lock) writeFileSync(join(cell, 'package-lock.json'), locks.get(version).lock);

      const install = npm(mode.argv, cell);
      const driverDir = join(cell, 'node_modules', DRIVER);
      const hasPrebuilds = existsSync(join(driverDir, 'prebuilds'));
      const hasBuild = existsSync(join(driverDir, 'build', 'Release'));
      const gyp = /(^|\n)>\s*node-gyp|gyp ERR!/.test(install.out);
      const prebuildInstall = /(^|\n)>\s*prebuild-install|prebuild-install (info|http)/.test(install.out);
      const binary = hasPrebuilds
        ? 'tarball-prebuilds'
        : prebuildInstall && hasBuild
          ? 'prebuild-install(net)'
          : gyp && hasBuild ? 'node-gyp(local-build)' : hasBuild ? 'build/Release' : 'none';

      let open = 'not-run';
      let detail = '';
      if (install.status === 0) {
        const probe = probeOpen(cell);
        open = probe.open;
        detail = probe.detail;
      } else {
        detail = firstGypError(install.out);
      }
      const exit = install.error ? 'ERROR' : String(install.status);
      rows.push({ version, mode: mode.label, exit, ms: install.ms, gyp: gyp ? 'yes' : 'no', binary, open });
      if (detail) notes.push(`${version} ${mode.label}: ${detail}`);
      rmSync(cell, { recursive: true, force: true });
    }
  }
} finally {
  for (const { dir } of locks.values()) rmSync(dir, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
}

const lines = [];
lines.push(`install-matrix: node ${process.version} / npm ${(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout ?? '').trim()}`);
lines.push(`driver: ${DRIVER}；cache: 系统临时目录（跑完删除，本沙箱 HOME 只读）`);
lines.push('');
lines.push('version  mode                  install  ms     node-gyp  binary-source          open');
for (const r of rows) {
  lines.push(
    `${r.version}  ${r.mode.padEnd(21)} ${r.exit.padEnd(7)}  ${String(r.ms).padEnd(5)}  ${r.gyp.padEnd(8)}  ${r.binary.padEnd(20)}  ${r.open}`,
  );
}
lines.push('');
lines.push('notes:');
if (notes.length === 0) lines.push('- (none)');
for (const note of notes) lines.push(`- ${note}`);

const text = lines.join('\n');
console.log(text);
if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${text}\n`);
  console.log(`\nwritten: ${outFile}`);
}
