import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyState, fold } from '../../src/core/fold/index.js';
import { eventFactory, signedDecision, stableStringify } from './helpers.js';

const FOLD_DIR = join(process.cwd(), 'src/core/fold');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('C1 fold 源码不读时钟/环境/随机/文件系统', () => {
  const forbidden = [
    'Date.now(',
    'new Date(',
    'process.env',
    'Math.random(',
    "from 'node:fs'",
    "from 'node:path'",
    "from 'node:os'",
    'readFileSync',
    'writeFileSync',
  ];
  for (const file of sourceFiles(FOLD_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} must not use ${token}`);
    }
  }
});

test('C1 fold 不修改传入的 prev 状态', () => {
  const { ev } = eventFactory('purity');
  const decisionEvents = signedDecision(ev, 'd-1', 'intent');
  const signed = ev('intent.signed', 'INT-1', {
    decision_id: 'd-1', statement: 's', owner: 'o', strength: 'explicit', content_hash: 'ch-1',
  });
  const first = fold(undefined, [...decisionEvents, signed]);
  const before = stableStringify(first);
  const next = fold(first, [ev('spec.defined', 'SPEC-1', { intent_id: 'INT-1', clause: 'c', kind: 'requirement' })]);
  assert.equal(stableStringify(first), before);
  assert.equal(next.tables.intent['INT-1']?.['status'], 'signed');
});

test('C1 输入只有 events 与起始状态：空输入返回空状态', () => {
  const state = fold(undefined, []);
  assert.deepEqual(state.tables.intent, {});
  assert.equal(state.eventIds.length, 0);
  assert.equal(stableStringify(state), stableStringify(emptyState()));
});
