// M0-0 C4 乙：node:sqlite（Node 内置，零依赖）真实往返复现脚本。
// 不参与 npm test；在仓库根目录跑：npm run spike:node-sqlite
// 结论：能往返，但**不提供加密**——PRAGMA key 被静默忽略，盘上是明文 SQLite。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const file = join(artifacts, 'plain.db');
rmSync(file, { force: true });

let createMs = 0;
let reopenMs = 0;
let row;
let rowWithoutKey;

try {
  let t0 = performance.now();
  let db = new DatabaseSync(file);
  db.exec('CREATE TABLE event (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)');
  db.prepare('INSERT INTO event (seq, kind, payload) VALUES (?, ?, ?)').run(
    1,
    'intent.signed',
    '{"intent_id":"i-1"}',
  );
  db.close();
  createMs = +(performance.now() - t0).toFixed(1);

  t0 = performance.now();
  db = new DatabaseSync(file);
  db.exec("PRAGMA key = 'correct horse battery staple'"); // 被静默忽略
  row = db.prepare('SELECT seq, kind, payload FROM event WHERE seq = 1').get();
  db.close();
  reopenMs = +(performance.now() - t0).toFixed(1);

  const again = new DatabaseSync(file);
  rowWithoutKey = again.prepare('SELECT seq, kind FROM event').get();
  again.close();
} finally {
  // 不删样本：证据要可复算。
}

const fileKind = execFileSync('file', ['-b', file], { encoding: 'utf8' }).trim();
const head = readFileSync(file).subarray(0, 16).toString('latin1');

console.log('driver: node:sqlite', process.versions.sqlite);
console.log('artifacts:', artifacts);
console.log('create_close_ms:', createMs, 'reopen_read_ms:', reopenMs, 'bytes:', statSync(file).size);
console.log('row_after_reopen:', JSON.stringify(row));
console.log('row_without_any_key:', JSON.stringify(rowWithoutKey));
console.log('plain.db file:', fileKind);
console.log('plain.db first_16_bytes_latin1:', JSON.stringify(head));
