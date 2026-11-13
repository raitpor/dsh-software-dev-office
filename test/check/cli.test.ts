import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { PASSPHRASE, countRows, withCheckDbPath } from './helpers.js';

const CLI = 'lib/src/check/cli.js';

interface CliOutput {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], dbPath: string, passphrase = PASSPHRASE): CliOutput {
  const env: NodeJS.ProcessEnv = { ...process.env, SDO_DB_PATH: dbPath };
  if (passphrase.length > 0) env['SDO_DB_PASSPHRASE'] = passphrase;
  else delete env['SDO_DB_PASSPHRASE'];
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('C1：npm run check 同款入口，纯 node 起、输出 JSON（preview/judged/baseline）', () => {
  withCheckDbPath((_db, path) => {
    const output = runCli(['--criterion', 'provenance.present', '--db', path], path);
    assert.equal(output.status, 0, output.stderr);
    const report = JSON.parse(output.stdout) as Record<string, unknown>;
    assert.equal(report['ok'], true);
    assert.equal(report['preview'], true);
    assert.equal(report['judged'], false);
    assert.equal(report['baseline'], null);
    assert.equal(report['mode'], 'criterion');
    const criterion = report['criterion'] as Record<string, unknown>;
    assert.equal(criterion['criterion_id'], 'provenance.present');
    assert.equal(criterion['preview'], true);
    assert.equal(criterion['judged'], false);
  });
});

test('C1：--gate 预览也能跑，退出码 0（判据 fail 不改退出码）', () => {
  withCheckDbPath((_db, path) => {
    const output = runCli(['--gate', 'req', '--preset', 'waterfall', '--db', path], path);
    assert.equal(output.status, 0, output.stderr);
    const report = JSON.parse(output.stdout) as Record<string, unknown>;
    assert.equal(report['mode'], 'gate');
    const gate = report['gate'] as Record<string, unknown>;
    assert.equal(gate['preset'], 'waterfall');
    assert.equal(gate['stage'], 'req');
  });
});

test('C1：未知判据/未知 stage 退出码 2，输出结构化 reason_code', () => {
  withCheckDbPath((_db, path) => {
    const badCriterion = runCli(['--criterion', 'no.such', '--db', path], path);
    assert.equal(badCriterion.status, 2);
    assert.equal((JSON.parse(badCriterion.stdout) as Record<string, unknown>)['reason_code'], 'unknown_criterion');

    const badStage = runCli(['--gate', 'nope', '--db', path], path);
    assert.equal(badStage.status, 2);
    assert.equal((JSON.parse(badStage.stdout) as Record<string, unknown>)['reason_code'], 'unknown_stage');

    const badPreset = runCli(['--gate', 'req', '--preset', 'lite', '--db', path], path);
    assert.equal(badPreset.status, 2);
    assert.equal((JSON.parse(badPreset.stdout) as Record<string, unknown>)['reason_code'], 'unknown_preset');

    // 原型链键不得被 `in` 当成合法 preset（否则会 TypeError ⇒ tool_error 退 1）。
    const protoPreset = runCli(['--gate', 'req', '--preset', 'toString', '--db', path], path);
    assert.equal(protoPreset.status, 2);
    assert.equal((JSON.parse(protoPreset.stdout) as Record<string, unknown>)['reason_code'], 'unknown_preset');
  });
});

test('C4：CLI 只读——跑完后 event/baseline 行数不变', () => {
  withCheckDbPath((db, path) => {
    const before = [countRows(db, 'event'), countRows(db, 'baseline')];
    const output = runCli(['--criterion', 'dead_field', '--db', path], path);
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual([countRows(db, 'event'), countRows(db, 'baseline')], before);
  });
});

test('A3：缺少 SDO_DB_PASSPHRASE 时退出码 1（无明文降级）', () => {
  withCheckDbPath((_db, path) => {
    const output = runCli(['--criterion', 'provenance.present', '--db', path], path, '');
    assert.equal(output.status, 1);
    const payload = JSON.parse(output.stdout) as Record<string, unknown>;
    assert.equal(payload['reason_code'], 'tool_error');
    assert.ok(String(payload['message']).includes('SDO_DB_PASSPHRASE'));
  });
});
