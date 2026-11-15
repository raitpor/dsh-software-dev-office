import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  MATRIX_ACTIONS,
  RIGHT_NAMES,
  SCOPE_PREFIXES,
  buildMatrixCatalog,
  normalizeLabel,
  parseMatrixTable,
} from '../../../src/core/auth/matrix.js';

const REPO_ROOT = process.cwd(); // npm test 从仓库根运行（与 test/db/baseline-freeze.test.ts 同约定）
const DOCS_07 = resolve(REPO_ROOT, 'docs/07-协作-权限-并行与子代理.md');

function docsMarkdown(): string {
  return readFileSync(DOCS_07, 'utf8');
}

test('C2：docs/07 §2 的 21 行表格可机器解析成目录（动作/所需权/可自签/可双人）', () => {
  const markdown = docsMarkdown();
  const rows = parseMatrixTable(markdown);
  assert.equal(rows.length, 21, 'docs/07 §2 必须恰好 21 个数据行');
  assert.equal(rows[0]?.label, '建卡/认领/阻塞');

  const catalog = buildMatrixCatalog(markdown);
  assert.equal(catalog.length, 26, '21 行 → 26 个动作 id（claim/block、dispatch/assign/unassign、freeze/waive、amend_intent/amend_clause 拆分）');
  const actions = catalog.map((entry) => entry.action);
  for (const expected of MATRIX_ACTIONS.flatMap((spec) => spec.actions)) {
    assert.ok(actions.includes(expected), `目录必须包含动作 ${expected}`);
  }
  const config = catalog.find((entry) => entry.action === 'config');
  assert.deepEqual(config?.required, [{ right: 'admin', scope: 'domain' }]);
  const freeze = catalog.find((entry) => entry.action === 'freeze');
  assert.deepEqual(freeze?.required, [
    { right: 'decide', scope: 'release' },
    { right: 'sign', scope: 'release' },
  ]);
  assert.equal(freeze?.dual_human, 'independence');
  assert.equal(freeze?.self_sign, false);
  const bootstrap = catalog.find((entry) => entry.action === 'config.bootstrap');
  assert.equal(bootstrap?.boot_only, true, '初始化部署配置必须登记为 boot 动作');
  const close = catalog.find((entry) => entry.action === 'defect.close');
  assert.deepEqual(close?.required, [], '关缺陷不需要额外权');
});

test('C2：文档新增一行而未登记 MATRIX_ACTIONS ⇒ 解析器直接失败（矩阵是数据）', () => {
  const markdown = docsMarkdown();
  const mutated = markdown.replace(
    '| 撤签 / 撤销决策 |',
    '| 新增动作 | `admin@domain` | 不能 | 否 |\n| 撤签 / 撤销决策 |',
  );
  assert.notEqual(mutated, markdown, '测试必须真的插入了一行');
  assert.throws(() => buildMatrixCatalog(mutated), /行数|尚未登记|未登记/, 'docs/07 多一行必须红');
});

test('C2：文档删除一行而未同步 MATRIX_ACTIONS ⇒ 解析器失败', () => {
  const markdown = docsMarkdown();
  const rows = markdown.split('\n');
  const index = rows.findIndex((line) => line.includes('| 撤签 / 撤销决策 |'));
  assert.ok(index > 0);
  rows.splice(index, 1);
  assert.throws(() => buildMatrixCatalog(rows.join('\n')), /行数|未登记/);
});

test('C2：动作名/标签漂移会被发现（文档改字必须同步目录）', () => {
  const markdown = docsMarkdown().replace('撤签 / 撤销决策', '撤签决策');
  assert.throws(() => buildMatrixCatalog(markdown), /标签变化/);
});

test('P1-2：括号内否定句不参与授权解析（dependencies 只有 plan@domain）', () => {
  const catalog = buildMatrixCatalog(docsMarkdown());
  const dependencies = catalog.find((entry) => entry.action === 'dependencies');
  assert.deepEqual(dependencies?.required, [{ right: 'plan', scope: 'domain' }]);
  // 文档里确实写着否定句，确保上面的断言不是“文档里没有 write@module”的巧合
  const markdown = docsMarkdown();
  assert.ok(markdown.includes('不是 `write@module`'), 'docs/07 的否定句仍在（否则该用例需换夹具）');
});

test('P2-1：未知权名/裸权名漏 @scope ⇒ 解析失败（不许 continue 静默丢权）', () => {
  assert.throws(
    () => parseMatrixTable('## 2. 决策权矩阵\n\n| 动作 | 需要什么权 | 是否可自签 | 是否可双人 |\n|---|---|---|---|\n| X | `writee@module` | — | 否 |\n'),
    /unknown_right_in_matrix/,
  );
  assert.throws(
    () => parseMatrixTable('## 2. 决策权矩阵\n\n| 动作 | 需要什么权 | 是否可自签 | 是否可双人 |\n|---|---|---|---|\n| X | `write` | — | 否 |\n'),
    /缺少 @scope/,
  );
});

test('P1（第 2 轮）：空授权格不在白名单 ⇒ 解析失败（不许变成谁都能做）', () => {
  const base = docsMarkdown();
  const withCell = (cell: string): string =>
    base
      .split('\n')
      .map((line) => (line.includes('| 冻结版本 / 豁免 |') ? `| 冻结版本 / 豁免 | ${cell} | — | 否 |` : line))
      .join('\n');
  // ① “不是 x@y 而是 z@w”：括号外仍被否定词截断 ⇒ required 为空 ⇒ 非白名单动作必须抛
  assert.throws(() => buildMatrixCatalog(withCell('不是 `write@module` 而是 `plan@domain`')), /unknown_right_in_matrix/);
  // ② 整格 `—`：非白名单动作也必须抛
  assert.throws(() => buildMatrixCatalog(withCell('—')), /unknown_right_in_matrix/);
  // 白名单动作的空格仍然合法（docs/07:48/50/52 的“不需要额外权”）
  const catalog = buildMatrixCatalog(docsMarkdown());
  for (const action of ['defect.close', 'verify_finding', 'config.bootstrap']) {
    const entry = catalog.find((item) => item.action === action);
    assert.ok(entry !== undefined, `${action} 应在目录里`);
    assert.deepEqual(entry?.required, [], `${action} 允许空授权（白名单）`);
  }
});

test('matrix: 权名/前缀/双人模式闭集，标签归一化稳定', () => {
  assert.deepEqual([...SCOPE_PREFIXES], ['module', 'domain', 'release']);
  assert.ok(RIGHT_NAMES.includes('sign'));
  assert.ok(RIGHT_NAMES.includes('escalate'));
  assert.equal(normalizeLabel('  建卡/认领/阻塞 '), '建卡/认领/阻塞');
  const catalog = buildMatrixCatalog(docsMarkdown());
  for (const entry of catalog) {
    assert.ok(!entry.action.includes('*'), '目录动作不得含通配');
    for (const required of entry.required) {
      assert.ok(RIGHT_NAMES.includes(required.right));
      assert.ok(['module', 'domain', 'release', 'scope'].includes(required.scope));
    }
  }
});
