/**
 * P1-1 守卫（M1-1 载体落地后升级，M1-2 C5 摘除 provisional）：
 * C5 的“例子”来自 `criterion.registered` 的 `fixtures[]` 载荷（D-032 裁定 ①），
 * reducer 同事务物化 `criterion_fixture` 行；门的 ok 因此是正式判据，不再带临时说明。
 *
 * 因此本文件守两件事：
 * ①生产代码与 align 测试代码里都不允许直插夹具表（唯一写入口是 `append`）；
 * ②删掉 `fixtures[]` 的注册事件必须被 append 拒绝（新建判据 ≥1 正 ≥1 负是硬门）。
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { appendCriterion, appendIntent, appendRequirement, appendSeeds, ALIGN_AT, draft, ev, intentEdge, SPEC_AT, withAlignDb } from './helpers.js';
import { disposeDiff } from '../../src/align/diff.js';
import { alignmentGate, listRestatements, readAlignmentState } from '../../src/align/gate.js';
import { proposeRestatement } from '../../src/align/restatement.js';

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

const CODE_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs', '.sql'];

function sourceFiles(roots: readonly string[]): string[] {
  return roots
    .map((name) => join(process.cwd(), name))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => walk(dir))
    .filter((file) => CODE_EXTENSIONS.some((extension) => file.endsWith(extension)));
}

/**
 * 直插夹具表的形态（生产代码与测试代码都不允许）。
 * 动态拼 needle：源码里不出现连续的原样字符串，避免守卫自我命中。
 */
const DIRECT_INSERT = new RegExp(['insert', 'into', 'criterion_fixture'].join('\\s+'), 'i');

test('P1-1：生产代码与 align 测试代码零直插夹具表（例子只经 criterion.registered fixtures[]）', () => {
  // 启发式回归守卫（不是源码级证明）：`INSERT OR REPLACE INTO`、`main.criterion_fixture`、
  // 字符串拼接都能绕过；唯一可信的是代码审查 + `append` 契约。
  // 本文件自身是“绕过事件链”的运行时红例容器（见下一条用例），是唯一允许出现直插语句的
  // 测试文件；其余测试代码仍零直插。
  const self = ['fixture', 'carrier'].join('-');
  const offenders = sourceFiles(['src', 'scripts', 'migrations', 'test/align'])
    .filter((file) => !(file.endsWith(`${self}.test.ts`) || file.endsWith(`${self}.test.js`)))
    .filter((file) => DIRECT_INSERT.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('P1-1：删掉 fixtures[] ⇒ criterion.registered 被 append 拒绝（不是门悄悄放行）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    appendRequirement(db);
    assert.throws(
      () =>
        appendSeeds(db, [
          ev(
            'criterion.registered',
            'CRIT-1',
            {
              spec_id: 'SPEC-1',
              kind: 'functional',
              remedy: 'fix it',
              status_enum: 'pass',
            },
            { at: SPEC_AT },
          ),
        ]),
      /fixtures/,
    );
    const registered = db.prepare('SELECT count(*) AS n FROM criterion').get() as { n: number };
    assert.equal(registered.n, 0);
  });
});

test('C5 运行时证据：直插 criterion_fixture 行不能把门翻绿（门读 fold 事件态）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const proposed = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1'), draft('d2'), draft('d3')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: ALIGN_AT,
    });
    assert.equal(proposed.ok, true);
    const restatement = listRestatements(readAlignmentState(db))[0];
    assert.ok(restatement !== undefined);
    for (const targetRef of ['d1', 'd2', 'd3']) {
      const disposed = disposeDiff(db, {
        restatementId: restatement.id,
        targetRef,
        kind: 'agree',
        disposition: 'accept',
        actor: 'alice',
        actorKind: 'human',
        at: ALIGN_AT,
      });
      assert.equal(disposed.ok, true);
    }
    appendRequirement(db);
    // 事件态只有 1 正 1 反（注册硬门允许）⇒ 门要 2 正 ⇒ examples_missing。
    appendCriterion(db, 'CRIT-1', 'SPEC-1', SPEC_AT, [
      { polarity: 'positive', input: 'positive-1' },
      { polarity: 'negative', input: 'negative-1' },
    ]);
    assert.equal(alignmentGate(db).reason_code, 'examples_missing');

    // 绕过事件链直插一条正例：物化表变成 2 正 1 反，但事件态不变 ⇒ 门必须仍红。
    db.prepare(
      `INSERT INTO criterion_fixture (id, criterion_id, polarity, input, expected_status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('fx-direct-positive', 'CRIT-1', 'positive', 'positive-direct', 'pass');

    const after = alignmentGate(db);
    assert.equal(after.reason_code, 'examples_missing');
    assert.deepEqual(after.specIds, ['SPEC-1']);
  });
});
