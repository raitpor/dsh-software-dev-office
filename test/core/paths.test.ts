import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SdoPathError, ensureDbDirectory, resolveDbPath, warnIfInsideWorkspace } from '../../src/core/paths.js';

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0-6-paths-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('C1: 未设 SDO_DB 时默认路径在工作区外的 state 目录', () => {
  const result = resolveDbPath({ env: {}, cwd: '/repo/sdo-pkg', home: '/home/alice' });

  assert.equal(result.path, '/home/alice/.local/state/sdo/sdo-pkg.db');
  assert.equal(result.source, 'default');
  assert.equal(result.inWorkspace, false);
  assert.equal(result.warning, null);
});

test('C1: 项目名由 cwd 末段 slug 化（空格/大写不进路径）', () => {
  const result = resolveDbPath({ env: {}, cwd: '/repo/My Project!', home: '/home/alice' });

  assert.equal(result.path, '/home/alice/.local/state/sdo/my-project.db');
});

test('C2: SDO_DB 相对路径落进工作区 ⇒ 照常解析但 warning', () => {
  const result = resolveDbPath({ env: { SDO_DB: './tmp.db' }, cwd: '/repo/sdo-pkg', home: '/home/alice' });

  assert.equal(result.path, '/repo/sdo-pkg/tmp.db');
  assert.equal(result.source, 'env');
  assert.equal(result.inWorkspace, true);
  assert.match(result.warning ?? '', /sandbox protection is disabled by explicit override/u);
});

test('C2: SDO_DB 指向工作区外 ⇒ 无 warning', () => {
  const result = resolveDbPath({
    env: { SDO_DB: '/var/tmp/sdo.db' },
    cwd: '/repo/sdo-pkg',
    home: '/home/alice',
  });

  assert.equal(result.path, '/var/tmp/sdo.db');
  assert.equal(result.inWorkspace, false);
  assert.equal(result.warning, null);
});

test('C2: 空 SDO_DB 视为未设置', () => {
  const result = resolveDbPath({ env: { SDO_DB: '' }, cwd: '/repo/sdo-pkg', home: '/home/alice' });

  assert.equal(result.source, 'default');
  assert.equal(result.path, '/home/alice/.local/state/sdo/sdo-pkg.db');
});

test('C1/C5: ensureDbDirectory 递归建目录且权限 0700', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'nested', 'state', 'sdo.db');
    const created = ensureDbDirectory(dbPath);

    assert.equal(created, join(dir, 'nested', 'state'));
    assert.equal(statSync(created).mode & 0o777, 0o700);
  });
});

test('C5: 父路径被普通文件占用 ⇒ SdoPathError + fail-closed 文案', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'not-a-dir'), 'x');

    assert.throws(
      () => ensureDbDirectory(join(dir, 'not-a-dir', 'sdo.db')),
      (error: unknown) =>
        error instanceof SdoPathError && /fail-closed: no workspace fallback/u.test(error.message),
    );
  });
});

test('C5: 目录不可写 ⇒ SdoPathError（不回退工作区）', () => {
  withTempDir((dir) => {
    const locked = join(dir, 'locked');
    mkdirSync(locked, { mode: 0o500 });
    try {
      assert.throws(
        () => ensureDbDirectory(join(locked, 'sdo.db')),
        (error: unknown) =>
          error instanceof SdoPathError && /fail-closed: no workspace fallback/u.test(error.message),
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

test('C2: 工作区内覆盖会真的打印一条 warning；默认路径不打印', () => {
  const inside = resolveDbPath({ env: { SDO_DB: './tmp.db' }, cwd: '/repo/sdo-pkg', home: '/home/alice' });
  const lines: string[] = [];
  const printed = warnIfInsideWorkspace(inside, (line) => lines.push(line));

  assert.equal(printed, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /sandbox protection is disabled by explicit override/u);

  const outside = resolveDbPath({ env: {}, cwd: '/repo/sdo-pkg', home: '/home/alice' });
  const quiet: string[] = [];
  assert.equal(warnIfInsideWorkspace(outside, (line) => quiet.push(line)), false);
  assert.deepEqual(quiet, []);
});

test('P2-1: 工作区按仓库根判定（.git 标记）：子目录启动 + HOME 在仓库根内 ⇒ 告警', () => {
  withTempDir((root) => {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'home'));
    mkdirSync(join(root, 'sub'));
    const result = resolveDbPath({ env: {}, cwd: join(root, 'sub'), home: join(root, 'home') });

    assert.equal(result.inWorkspace, true);
    assert.match(result.warning ?? '', /sandbox protection is disabled/u);
  });
});

test('P2-1: 工作区按仓库根判定（package.json 标记）：HOME 是仓库根 ⇒ 告警', () => {
  withTempDir((root) => {
    writeFileSync(join(root, 'package.json'), '{}\n');
    mkdirSync(join(root, 'sub'));
    const result = resolveDbPath({ env: {}, cwd: join(root, 'sub'), home: root });

    assert.equal(result.inWorkspace, true);
    assert.match(result.warning ?? '', /sandbox protection is disabled/u);
  });
});

test('P3: monorepo 子包自带 package.json 时，工作区仍按仓库根的 .git 判定', () => {
  withTempDir((root) => {
    const repo = join(root, 'repo');
    const pkg = join(repo, 'pkg');
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(pkg, 'package.json'), '{}\n');
    mkdirSync(join(repo, 'home'));

    const result = resolveDbPath({ env: {}, cwd: pkg, home: join(repo, 'home') });

    assert.equal(result.inWorkspace, true);
    assert.match(result.warning ?? '', /sandbox protection is disabled/u);
  });
});
