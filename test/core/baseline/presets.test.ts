import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { PRESETS, type PresetId } from '../../../src/core/baseline/presets.js';

const CORE = ['spec_set.signed', 'assumption_set.signed', 'provenance.present'];

interface DocGate {
  readonly stage: string;
  readonly policy_mode: string;
  readonly waivable: boolean;
  readonly criteria: readonly string[];
}

const PRESET_IDS = ['waterfall', 'prototype', 'incremental'] as const;
type DocPresetId = (typeof PRESET_IDS)[number];

/**
 * 机器读 `docs/08` §1.1 的三份 preset gate 目录（P2-5）。
 * 目的：`PRESETS` 少绑/换绑任何一条非 core 判据，这里都会红——不再靠人眼对表。
 */
function parsePresetGatesFromDocs(): ReadonlyMap<DocPresetId, ReadonlyMap<string, DocGate>> {
  const doc = readFileSync(resolve(process.cwd(), 'docs/08-方法论与策略.md'), 'utf8');
  const start = doc.indexOf('### 1.1');
  const end = doc.indexOf('\n## 2');
  assert.ok(start >= 0 && end > start, 'docs/08 §1.1 或 §2 边界找不到');
  const section = doc.slice(start, end).replace(/\s+/g, ' ');

  const markers = [...section.matchAll(/# (waterfall|prototype|incremental)：/g)];
  assert.equal(markers.length, 3, '§1.1 应有三段 preset 目录');
  const gateRe = /(G_[A-Za-z0-9_]+): \{ stage: ([A-Za-z0-9_]+), policy_mode: (all_of|any_of), waivable: (true|false), criteria: \[([^\]]*)\] \}/g;

  const result = new Map<DocPresetId, ReadonlyMap<string, DocGate>>();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]!;
    const presetId = marker[1] as DocPresetId;
    const nextStart = markers[index + 1]?.index ?? section.length;
    const body = section.slice(marker.index! + marker[0].length, nextStart);
    const gates = new Map<string, DocGate>();
    for (const match of body.matchAll(gateRe)) {
      gates.set(match[1]!, {
        stage: match[2]!,
        policy_mode: match[3]!,
        waivable: match[4] === 'true',
        criteria: match[5]!.split(',').map((item) => item.trim()).filter((item) => item.length > 0),
      });
    }
    assert.ok(gates.size > 0, `docs/08 §1.1 的 ${presetId} 段没解析出 gate`);
    result.set(presetId, gates);
  }
  return result;
}

const DOC_GATES = parsePresetGatesFromDocs();

test('waterfall mirrors docs/08 §1', () => {
  assert.deepEqual(PRESETS.waterfall.stages.map((s) => [s.id, s.kinds, s.after]), [
    ['req', ['requirement'], []],
    ['design', ['design'], ['req']],
    ['build', ['implement'], ['design']],
    ['verify', ['review'], ['build']],
    ['deliver', ['deliver'], ['verify']],
  ]);
});

test('prototype mirrors docs/08 §1', () => {
  assert.deepEqual(PRESETS.prototype.stages.map((s) => [s.id, s.kinds, s.after]), [
    ['explore', ['implement'], []],
    ['harden', ['requirement', 'design', 'implement', 'review'], ['explore']],
    ['deliver', ['deliver'], ['harden']],
  ]);
});

test('incremental mirrors docs/08 §1', () => {
  assert.deepEqual(PRESETS.incremental.stages.map((s) => [s.id, s.kinds, s.after]), [
    ['req_design', ['requirement', 'design'], []],
    ['build', ['implement'], ['req_design']],
    ['verify', ['review'], ['build']],
    ['integrate', ['deliver'], ['verify']],
  ]);
});

test('P2-5: PRESETS gate catalog equals docs/08 §1.1 (ids, stage, mode, waivable, criteria)', () => {
  const sampled = new Set<string>();
  for (const id of PRESET_IDS) {
    const expected = DOC_GATES.get(id)!;
    const preset = PRESETS[id];
    assert.deepEqual(
      preset.gateDefs.map((gate) => gate.id).sort(),
      [...expected.keys()].sort(),
      `${id}: gate id 集合`,
    );
    for (const gate of preset.gateDefs) {
      const doc = expected.get(gate.id)!;
      assert.equal(gate.stage, doc.stage, `${id}/${gate.id}: stage`);
      assert.equal(gate.policy_mode, doc.policy_mode, `${id}/${gate.id}: policy_mode`);
      assert.equal(gate.waivable, doc.waivable, `${id}/${gate.id}: waivable`);
      assert.deepEqual([...gate.criteria].sort(), [...doc.criteria].sort(), `${id}/${gate.id}: criteria`);
      sampled.add(`${gate.id}:${[...gate.criteria].sort().join(',')}`);
    }
  }
  // 防呆：三份目录确实解析出了不同的 gate 内容，不是同一份被复用。
  assert.ok(sampled.size >= 8, `解析出的 gate 内容太少：${sampled.size}`);
});

test('every preset gate is all_of, non-waivable, and contains core', () => {
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    const preset = PRESETS[id];
    assert.ok(preset.gateDefs.length > 0, id);
    for (const gate of preset.gateDefs) {
      assert.equal(gate.policy_mode, 'all_of', `${id}/${gate.id}`);
      assert.equal(gate.waivable, false, `${id}/${gate.id}`);
      for (const core of CORE) assert.ok(gate.criteria.includes(core), `${id}/${gate.id}/${core}`);
    }
  }
});

test('each stage has at least one gate and lookup matches defs', () => {
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    const preset = PRESETS[id];
    for (const stage of preset.stages) {
      const gateIds = preset.gates[stage.id] ?? [];
      assert.ok(gateIds.length >= 1, `${id}/${stage.id}`);
      for (const gateId of gateIds) {
        assert.ok(preset.gateDefs.some((gate) => gate.id === gateId && gate.stage === stage.id));
      }
    }
  }
});
