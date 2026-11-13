import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fold } from '../../src/core/fold/index.js';
import { eventFactory, signedDecision } from './helpers.js';

const SCRIPT = [
  'const { fold } = await import(process.env.FOLD_MODULE_URL);',
  'const events = JSON.parse(process.env.FOLD_EVENTS);',
  'process.stdout.write(JSON.stringify(fold(undefined, events)));',
].join('\n');

function runInChild(events: unknown[]): string {
  const moduleUrl = pathToFileURL(resolve(process.cwd(), 'lib/src/core/fold/index.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, FOLD_MODULE_URL: moduleUrl, FOLD_EVENTS: JSON.stringify(events) },
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

function scenario(): unknown[] {
  const { ev } = eventFactory('proc');
  return [
    ...signedDecision(ev, 'd-1', 'plan'),
    ...signedDecision(ev, 'd-i', 'intent'),
    ev('intent.signed', 'INT-1', {
      decision_id: 'd-i', statement: 's', owner: 'alice', strength: 'explicit', content_hash: 'ch-1',
    }),
    ev('spec.defined', 'SPEC-1', { kind: 'requirement', clause: 'c', intent_id: 'INT-1' }),
    ev('task.created', 'TASK-1', { seq: 1, title: 'card', kind: 'implement' }),
    ev('task.claimed', 'TASK-1', {}),
    ev('task.done', 'TASK-1', {}),
  ];
}

test('P2-3 跨进程确定性：两个子进程 fold 同一串事件，原始 JSON.stringify 逐字节相同', () => {
  const events = scenario();
  const first = runInChild(events);
  const second = runInChild(events);
  assert.equal(first, second);
  const parent = JSON.stringify(fold(undefined, scenario() as never));
  assert.equal(first, parent, '子进程与父进程的原始序列化也必须相同（键序一同比）');
});
