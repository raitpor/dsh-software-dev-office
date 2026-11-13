import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGraph } from '../../../src/core/baseline/graph.js';
import type { BaselineStage } from '../../../src/core/baseline/types.js';

const stage = (id: string, after: readonly string[] = []): BaselineStage =>
  ({ id, kinds: ['requirement'], after });

test('accepts a DAG with multiple roots', () => {
  const result = checkGraph([stage('a'), stage('b'), stage('c', ['a', 'b'])]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cycles, []);
  assert.deepEqual(result.unreachable, []);
});

test('rejects cycles', () => {
  const result = checkGraph([stage('a', ['b']), stage('b', ['a'])]);
  assert.equal(result.ok, false);
  assert.deepEqual([...result.cycles].sort(), ['a', 'b']);
});

test('rejects missing after edges', () => {
  const result = checkGraph([stage('a', ['ghost'])]);
  assert.deepEqual(result.missingEdges, ['a->ghost']);
  assert.equal(result.ok, false);
});

test('rejects duplicate stage ids', () => {
  const result = checkGraph([stage('a'), stage('a')]);
  assert.deepEqual(result.duplicateIds, ['a']);
  assert.equal(result.ok, false);
});

test('rejects an unreachable island', () => {
  const result = checkGraph([stage('a'), stage('x', ['y']), stage('y', ['x'])]);
  assert.deepEqual([...result.unreachable].sort(), ['x', 'y']);
  assert.equal(result.ok, false);
});
