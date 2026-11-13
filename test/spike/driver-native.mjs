// M0-0 C4 甲：better-sqlite3-multiple-ciphers 真实往返 + 盘上密文证据（可重放）。
// 不参与 npm test；在仓库根目录跑：npm run spike:driver-native
// 样本库保留在仓库根 artifacts/（gitignored，不入库），卡里的 file/xxd 命令可对同一文件复算。
// 注意：SQLCipher 页头含随机 salt，本脚本每次重跑都会覆盖样本，hex 数字只对“当次留样”成立。
import Database from 'better-sqlite3-multiple-ciphers';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const file = join(artifacts, 'enc.db');
const plainFile = join(artifacts, 'plain-control.db');
const passphrase = 'correct horse battery staple';
rmSync(file, { force: true });
rmSync(plainFile, { force: true });

let createMs = 0;
let reopenMs = 0;
let row;
let sqliteVersion = '';
let wrongKeyError = null;

try {
  let t0 = performance.now();
  {
    const db = new Database(file);
    db.pragma("cipher='sqlcipher'");
    db.pragma('legacy=4');
    db.key(Buffer.from(passphrase, 'utf8'));
    db.exec('CREATE TABLE event (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)');
    db.prepare('INSERT INTO event (seq, kind, payload) VALUES (?, ?, ?)').run(
      1,
      'intent.signed',
      '{"intent_id":"i-1"}',
    );
    db.close();
  }
  createMs = +(performance.now() - t0).toFixed(1);

  t0 = performance.now();
  {
    const db = new Database(file);
    db.pragma("cipher='sqlcipher'");
    db.pragma('legacy=4');
    db.key(Buffer.from(passphrase, 'utf8'));
    row = db.prepare('SELECT seq, kind, payload FROM event WHERE seq = 1').get();
    sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;
    db.close();
  }
  reopenMs = +(performance.now() - t0).toFixed(1);

  try {
    const db = new Database(file);
    db.pragma("cipher='sqlcipher'");
    db.pragma('legacy=4');
    db.key(Buffer.from('wrong passphrase', 'utf8'));
    db.prepare('SELECT count(*) FROM event').get();
    db.close();
  } catch (error) {
    wrongKeyError = `${error.code ?? ''} ${error.message}`.trim();
  }

  const plain = new Database(plainFile);
  plain.exec('CREATE TABLE event (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL)');
  plain.prepare('INSERT INTO event VALUES (?, ?)').run(1, 'intent.signed');
  plain.close();
} finally {
  // 不删样本：证据要可复算。
}

const fileKind = execFileSync('file', ['-b', file], { encoding: 'utf8' }).trim();
const plainKind = execFileSync('file', ['-b', plainFile], { encoding: 'utf8' }).trim();
const head = readFileSync(file).subarray(0, 16).toString('hex');

console.log(`driver: better-sqlite3-multiple-ciphers@13.0.3 (sqlite ${sqliteVersion})`);
console.log('artifacts:', artifacts);
console.log('create_close_ms:', createMs, 'reopen_read_ms:', reopenMs, 'bytes:', statSync(file).size);
console.log('row_after_reopen:', JSON.stringify(row));
console.log('wrong_key_error:', wrongKeyError);
console.log('enc.db file:', fileKind);
console.log('enc.db first_16_bytes_hex:', head);
console.log('plain-control.db file:', plainKind);
console.log('plain-control.db first_16_bytes_latin1:', JSON.stringify(readFileSync(plainFile).subarray(0, 16).toString('latin1')));
