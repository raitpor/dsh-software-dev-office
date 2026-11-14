import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../src/core/fold/canonical.js';
import { fold } from '../../src/core/fold/index.js';
import { CREATE_SEMANTICS } from '../../src/core/fold/reducers/semantics.js';
import { REDUCERS } from '../../src/core/fold/registry.js';
import type { Event, FoldState } from '../../src/core/fold/types.js';
import { chain } from '../db/append-helpers.js';
import { worldSeeds } from '../db/world-seeds.js';

const seeds = worldSeeds();
const events = chain(seeds);
// 从测试文件定位仓库根（`lib/test/core` 编译产物 → 上三级），不依赖 cwd。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const reducersDir = resolve(repoRoot, 'src/core/fold/reducers');
const files = readdirSync(reducersDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, source: readFileSync(resolve(reducersDir, name), 'utf8') }));

/** 每个 create kind 一条“合法但不同值”的载荷改动（必须命中投影列）。 */
const MUTATIONS: Readonly<Record<string, readonly [string, unknown]>> = {
  'assumption.recorded': ['clause', 'mutated'],
  'attention.raised': ['question', 'mutated?'],
  'baseline.amended': ['hash', 'h-mut'],
  'baseline.frozen': ['hash', 'h-mut'],
  'baseline.loosened': ['hash', 'h-mut'],
  'contract.defined': ['clause', 'mutated'],
  'criterion.registered': ['remedy', 'mutated remedy'],
  'decision.valid': ['payload_hash', 'ph-mut'],
  'defect.recorded': ['severity', 'high'],
  'design.locked': ['design_sha256', 'ds-mut'],
  'evidence.attached': ['command', 'echo mutated'],
  'goal.declared': ['scope_paths', ['src/evil']],
  'goal.integrated': ['note', 'mutated'],
  'intent.signed': ['content_hash', 'ch-mut'],
  'report.recorded': ['note', 'mutated'],
  'redteam.recorded': ['use_case', 'mutated'],
  'release.frozen': ['frontier', 'f-mut'],
  'restatement.diff_dispositioned': ['reason', 'mutated'],
  'restatement.recorded': ['draft_specs', ['x']],
  'review.recorded': ['reason', 'mutated'],
  'review.round_closed': ['signer', 'mallory'],
  'scope.declared': ['paths', ['src/evil']],
  'snapshot.taken': ['git_oid', 'mutated'],
  'spec.defined': ['clause', 'mutated'],
  'stage.entered': ['stage', 'MutatedStage'],
  'task.created': ['title', 'mutated'],
  'verify.failed': ['note', 'mutated'],
  'verify.passed': ['note', 'mutated'],
};

function stateFingerprint(state: FoldState): string {
  return canonicalJson({ tables: state.tables, inputs: state.inputs, invalidatedKeys: state.invalidatedKeys });
}

function cloneWithId(event: Event, suffix: string, payload?: Record<string, unknown>): Event {
  return {
    ...event,
    id: `${event.id}-${suffix}`,
    payload: payload === undefined ? event.payload : { ...(event.payload as Record<string, unknown>), ...payload },
    prev: event.hash,
    hash: `${event.hash}-${suffix}`,
  };
}

function functionBody(source: string, name: string): string | undefined {
  const match = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (match === null) return undefined;
  const rest = source.slice(match.index);
  const next = /\nexport\s+function\s+/.exec(rest.slice(1));
  return next === null ? rest : rest.slice(0, next.index + 1);
}

/** 递归看目标函数体（以及同文件里它调用的本地 helper）是否真的走到 `createOnce(`。 */
function bodyCallsCreateOnce(source: string, name: string, seen: ReadonlySet<string> = new Set()): boolean {
  const body = functionBody(source, name);
  if (body === undefined) return false;
  if (body.includes('createOnce(')) return true;
  const localNames = new Set(
    [...source.matchAll(/(?:export\s+)?function\s+(\w+)\s*\(/g)].map((match) => match[1] as string),
  );
  for (const call of body.matchAll(/\b(\w+)\s*\(/g)) {
    const called = call[1] as string;
    if (!localNames.has(called) || seen.has(called)) continue;
    if (bodyCallsCreateOnce(source, called, new Set([...seen, called]))) return true;
  }
  return false;
}

test('P1-1 清单完整性：CREATE_SEMANTICS 全部已注册、且 reducer 函数体调用 createOnce', () => {
  assert.equal(CREATE_SEMANTICS.length, 28, 'create 语义清单数量变化必须显式改测试');
  for (const kind of CREATE_SEMANTICS) {
    const reducer = REDUCERS[kind];
    assert.ok(reducer !== undefined, `${kind} must be a registered reducer`);
    const file = files.find((candidate) => functionBody(candidate.source, reducer.name) !== undefined);
    assert.ok(file !== undefined, `${kind} reducer source found`);
    assert.ok(
      bodyCallsCreateOnce(file.source, reducer.name),
      `${kind} (${file.name}) function body must reach createOnce; flipping it back to upsert makes this red`,
    );
  }
});

for (const kind of CREATE_SEMANTICS) {
  const index = seeds.findIndex((event) => event.kind === kind);
  const before = fold(undefined, events.slice(0, index + 1));
  const base = events[index]!;

  test(`P1-1 ${kind}: identical replay is idempotent`, () => {
    const after = fold(undefined, [...events.slice(0, index + 1), cloneWithId(base, 'replay')]);
    assert.equal(stateFingerprint(after), stateFingerprint(before), `${kind} identical replay must not change the projection`);
  });

  test(`P1-1 ${kind}: same id with different content is rejected`, () => {
    const mutation = MUTATIONS[kind]!;
    const mutated = cloneWithId(base, 'mutated', { [mutation[0]]: mutation[1] });
    assert.throws(
      () => fold(undefined, [...events.slice(0, index + 1), mutated]),
      /already exists with different content; this projection is append-only/u,
      `${kind} must reject a same-id different-content projection`,
    );
  });
}
