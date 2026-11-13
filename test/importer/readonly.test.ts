/**
 * 只读判据 C1 的证据：
 *   · 静态：`src/importer/` 下只有 index.ts 的显式 `--out` 一处写文件调用，且没有 DB 打开/写 SQL；
 *   · 运行时：跑一次导入后，导出文件与「库文件」的 mtime/内容都不变，目录里不新增文件。
 * M0-7 不打开 SQLite 库；这里放一个假库文件证明 CLI 不会碰它。
 */

import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { FIXTURE_PATH, runImportCli } from './helpers.js';

const IMPORTER_DIR = resolve(process.cwd(), 'src/importer');
const WRITE_CALL =
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|renameSync|rmSync|unlinkSync|copyFileSync|mkdirSync)\s*\(/;
const DB_ACCESS = /better-sqlite3|node:sqlite|openEncryptedDatabase|new\s+Database\s*\(/;

describe('importer/readonly: 静态扫描（C1）', () => {
  it('src/importer 只有 index.ts 允许一处显式写文件（--out）', () => {
    const files = readdirSync(IMPORTER_DIR)
      .filter((name) => name.endsWith('.ts'))
      .sort();
    assert.deepEqual(files, ['index.ts', 'parse.ts', 'rebuild.ts', 'seq.ts']);
    for (const file of files) {
      const source = readFileSync(join(IMPORTER_DIR, file), 'utf8');
      assert.doesNotMatch(source, DB_ACCESS, `${file} 不得打开数据库`);
      const writes = source.match(WRITE_CALL) ?? [];
      if (file === 'index.ts') {
        assert.equal(writes.length, 1, 'index.ts 只允许 --out 这一处写文件');
        assert.match(source, /options\.out !== undefined/);
      } else {
        assert.equal(writes.length, 0, `${file} 不得写文件`);
      }
    }
  });

  it('src/importer 没有写 SQL（INSERT/UPDATE/DELETE/DDL）', () => {
    for (const file of readdirSync(IMPORTER_DIR).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(IMPORTER_DIR, file), 'utf8');
      assert.doesNotMatch(source, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/i);
    }
  });
});

describe('importer/readonly: 运行时 mtime（C1）', () => {
  it('跑完导入后导出文件与库文件 mtime/内容不变、不新增文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m07-ro-'));
    try {
      const exported = join(dir, 'export.json');
      copyFileSync(FIXTURE_PATH, exported);
      const fakeDb = join(dir, 'sdo.db');
      writeFileSync(fakeDb, 'fake db bytes: M0-7 不打开 SQLite 库\n');

      const fixtureBefore = statSync(exported);
      const dbBefore = statSync(fakeDb);
      const repoFixtureBefore = statSync(FIXTURE_PATH);
      const listingBefore = readdirSync(dir).sort();

      const run = runImportCli(['--input', exported, '--sample', '20'], dir);
      assert.equal(run.status, 0, run.stderr);

      assert.equal(statSync(exported).mtimeMs, fixtureBefore.mtimeMs, '导出文件 mtime 变了');
      assert.equal(statSync(fakeDb).mtimeMs, dbBefore.mtimeMs, '库文件 mtime 变了');
      assert.equal(statSync(FIXTURE_PATH).mtimeMs, repoFixtureBefore.mtimeMs, '仓库夹具 mtime 变了');
      assert.equal(readFileSync(exported, 'utf8'), readFileSync(FIXTURE_PATH, 'utf8'));
      assert.equal(readFileSync(fakeDb, 'utf8'), 'fake db bytes: M0-7 不打开 SQLite 库\n');
      assert.deepEqual(readdirSync(dir).sort(), listingBefore, '目录里多了文件（没 --out 不应写文件）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--out 才写文件：不跑 --out 时临时目录只有输入文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m07-ro2-'));
    try {
      const exported = join(dir, 'export.json');
      copyFileSync(FIXTURE_PATH, exported);
      const run = runImportCli(['--input', exported, '--sample', '20'], dir);
      assert.equal(run.status, 0);
      assert.deepEqual(readdirSync(dir).sort(), ['export.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
