/**
 * P1-1 守卫：C5“例子”目前只有 `criterion_fixture` 表承载，而该表没有事件 kind（台账 D-032）。
 * 因此：①生产代码里不允许出现直插夹具的旁路；②夹具缺失时门必须红；
 * ③门即使绿也带 `provisional_reasons:['fixture_no_event_carrier']`。
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { disposeDiff } from '../../src/align/diff.js';
import { alignmentGate, listRestatements, readAlignmentState } from '../../src/align/gate.js';
import { proposeRestatement } from '../../src/align/restatement.js';
import {
  ALIGN_AT,
  appendCriterion,
  appendIntent,
  appendRequirement,
  draft,
  intentEdge,
  withAlignDb,
} from './helpers.js';

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

function sourceFiles(): string[] {
  const roots = ['src', 'scripts', 'migrations'].map((name) => join(process.cwd(), name));
  return roots
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => walk(dir))
    .filter((file) => CODE_EXTENSIONS.some((extension) => file.endsWith(extension)));
}

test('P1-1：生产代码零 `INSERT INTO criterion_fixture`（夹具只能由测试直插）', () => {
  // 启发式回归守卫（不是源码级证明）：`INSERT OR REPLACE INTO`、`main.criterion_fixture`、
  // 字符串拼接都能绕过；唯一可信的是代码审查 + `append` 契约（M1-2 第 2 轮 P2-3）。
  const offenders = sourceFiles().filter((file) =>
    /\binsert\b[\s\S]{0,40}criterion_fixture/i.test(readFileSync(file, 'utf8')),
  );
  assert.deepEqual(offenders, []);
});

test('P1-1：夹具缺失时门必须红（examples_missing），不许靠测试直插造绿', () => {
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
    appendCriterion(db, 'CRIT-1', 'SPEC-1');

    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'examples_missing');
    assert.deepEqual(gate.specIds, ['SPEC-1']);
    assert.deepEqual(gate.provisional_reasons, ['fixture_no_event_carrier']);
  });
});
