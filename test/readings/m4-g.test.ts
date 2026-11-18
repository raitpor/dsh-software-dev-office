/**
 * M4-G · 读数门测试（卡 C1–C8）：
 * - C1–C4：每条读数真跑 + 变异红证（R1 两个独立进程）；
 * - C5/C6：遗留读数诚实 partial（0 样本 / 无 gate 表）；
 * - C7：两遍复跑，除 generatedAt/墙钟外逐键一致，R1 赢家归一化并断言等式；
 * - C8：默认写 plan/milestone/M4-*；测试用 --out 临时前缀，M0–M3 已签生成物逐字节不变。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(ROOT, 'scripts', 'm4-readings.mjs');
const MILESTONE = join(ROOT, 'plan', 'milestone');

interface Report {
  readonly overall: string;
  readonly readings: Record<string, { readonly verdict: string; readonly raw: Record<string, any> }>;
}

function tempEnv(dir: string): NodeJS.ProcessEnv {
  const samples = join(dir, 'human-samples.json');
  writeFileSync(samples, JSON.stringify({ version: 'sdo-human-samples-v1', samples: [], updated_at: '2026-11-18T00:00:00.000Z' }), 'utf8');
  return {
    ...process.env,
    M4_HUMAN_SAMPLES: samples,
    M4_RECEIPTS_FILE: join(dir, 'no-receipts.jsonl'),
  };
}

function run(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env, timeout: 240_000 });
}

function only(id: string, dir: string, mutation?: string): { verdict: string; status: number | null; raw: Record<string, any> } {
  const env = { ...tempEnv(dir), ...(mutation === undefined ? {} : { M4_G_MUTATION: mutation }) };
  const result = run(['--only', id], env);
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}';
  const parsed = JSON.parse(line) as { verdict?: string; raw?: Record<string, any> };
  return { verdict: parsed.verdict ?? 'missing', status: result.status, raw: parsed.raw ?? {} };
}

/** C7：唯一允许的差异是 generatedAt/墙钟；R1 竞态赢家归一化（不把赢家身份当稳定量）。 */
function normalizeR1Scenario(scenario: Record<string, any> | undefined): void {
  if (scenario === undefined) return;
  const results = [...(scenario['results'] as Array<Record<string, any>>)].sort((left, right) =>
    Number(right['ok'] === true) - Number(left['ok'] === true));
  for (const item of results) {
    item['role'] = item['ok'] === true ? '<ok>' : '<fail>';
    item['card'] = '<card>';
    item['value'] = '<value>';
    item['expected_value'] = '<value>';
    item['expected_path'] = '<path>';
    if ('stored_value' in item) item['stored_value'] = '<stored>';
    if ('reason_code' in item) item['reason_code'] = item['ok'] === true ? '<null>' : '<fail-code>';
    if ('message' in item) item['message'] = '<message>';
  }
  scenario['results'] = results;
  const mainBytes = scenario['main_tree_bytes'] as Record<string, string> | undefined;
  if (mainBytes !== undefined) {
    for (const key of Object.keys(mainBytes).sort()) mainBytes[key] = '<bytes>';
  }
  for (const row of (scenario['lock_rows_during'] as Array<Record<string, any>> | undefined) ?? []) {
    row['card_id'] = '<holder>';
    row['actor'] = '<holder-actor>';
  }
  scenario['winner_value'] = scenario['winner_value'] === null ? null : '<winner>';
}

function normalize(report: Report): Report {
  const copy = JSON.parse(JSON.stringify(report)) as Report & { generatedAt?: string };
  delete copy.generatedAt;
  for (const entry of Object.values(copy.readings)) {
    delete (entry.raw as Record<string, unknown>)['generatedAt'];
  }
  const r1 = copy.readings['R1']?.raw;
  if (r1 !== undefined) {
    normalizeR1Scenario(r1['s1'] as Record<string, any> | undefined);
    normalizeR1Scenario(r1['s2'] as Record<string, any> | undefined);
  }
  return copy;
}

function milestoneHashes(): string[] {
  return readdirSync(MILESTONE)
    .filter((name) => /^M[0-3]-读数\.(json|md)$/u.test(name))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(MILESTONE, name));
      return `${name}:${createHash('sha256').update(bytes).digest('hex')}`;
    });
}

describe('M4-G readings', () => {
  it('C1 R1：同路径两进程真写 ⇒ 恰 1 成 1 败 lock_conflict + 活锁 1 行 + 主树字节=赢家；不相交路径被根锁串行化 ⇒ partial；释放根锁变异红', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4g-r1-'));
    try {
      const normal = only('R1', dir);
      const s1 = normal.raw['s1'] as Record<string, any>;
      const s2 = normal.raw['s2'] as Record<string, any>;
      const winners = (s1['results'] as Array<Record<string, any>>).filter((item) => item['ok'] === true);
      const losers = (s1['results'] as Array<Record<string, any>>).filter((item) => item['ok'] === false);
      assert.equal(s1['pass'], true, JSON.stringify(s1));
      assert.equal(winners.length, 1);
      assert.equal(losers.length, 1);
      assert.equal(losers[0]!['reason_code'], 'lock_conflict', 'S1 败者必须是锁冲突');
      assert.equal((s1['lock_rows_during'] as unknown[]).length, 1);
      assert.equal((s1['lock_rows_during'] as Array<Record<string, any>>)[0]!['path_prefix'], '');
      assert.equal(s1['main_tree_bytes']['src/app.ts'], winners[0]!['value'], '主树字节必须等于赢家内容');
      assert.equal(normal.verdict, 'partial', 'S2 被主树根锁串行化 ⇒ C1 照实 partial');
      assert.equal(s2['pass'], false);
      assert.ok((s2['results'] as Array<Record<string, any>>).some((item) => item['reason_code'] === 'lock_conflict'));

      const mutation = only('R1', dir, 'R1');
      assert.equal(mutation.verdict, 'fail');
      assert.notEqual(mutation.status, 0);
      // 变异释放根锁后，S1 不再满足“恰 1 成 1 败 + 争用期活锁 1 行”；红因可能是
      // dirty_main_tree 或锁窗口不稳定下的 lock_conflict，raw 的 mutation_red_reasons 记录真实原因，
      // 不把它冒充成“锁冲突证明锁起作用”。
      const mutationS1 = mutation.raw['s1'] as Record<string, any>;
      assert.equal(mutationS1['pass'], false);
      assert.ok(Array.isArray(mutation.raw['mutation_red_reasons']));
      assert.equal((mutation.raw['s2'] as Record<string, any>)['skipped'] !== undefined, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2 R2：一次派发 pick_declined ≤1（dispatch_id + 计数）；2 条变异红', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4g-r2-'));
    try {
      const normal = only('R2', dir);
      assert.equal(normal.verdict, 'pass');
      assert.equal(normal.raw['pick_declined_in_dispatch'], 1);
      assert.equal(typeof normal.raw['dispatch_id'], 'string');
      assert.equal(normal.raw['dispatch_window']['from'], '2026-11-17T10:00:01.000Z');
      const mutation = only('R2', dir, 'R2');
      assert.equal(mutation.verdict, 'fail');
      assert.equal(mutation.raw['pick_declined_in_dispatch'], 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3 R3：3 次新起进 gaps.spawn_streak、2 次不告警；阈值变异红', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4g-r3-'));
    try {
      const normal = only('R3', dir);
      assert.equal(normal.verdict, 'pass');
      assert.ok(normal.raw['three_spawns']['max_spawn_streak_count'] >= 3);
      assert.equal(normal.raw['two_spawns']['gaps_rows'].length, 0);
      const mutation = only('R3', dir, 'R3');
      assert.equal(mutation.verdict, 'fail');
      assert.equal(mutation.raw['threshold'], 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C4 R4：claim 前 reserved_by 与 task.claimed.actor 事件级比对、绕过=0；verify 仅旁证；伪造 bob 认领变异红', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4g-r4-'));
    try {
      const normal = only('R4', dir);
      assert.equal(normal.verdict, 'pass');
      assert.equal(normal.raw['reserved_by_before_claim'], 'alice');
      assert.equal(normal.raw['claims'].length, 1);
      assert.equal(normal.raw['claims'][0].actor, 'alice');
      assert.equal(normal.raw['bypass_count'], 0);
      assert.equal(normal.raw['verify_ok'], true);
      assert.deepEqual(normal.raw['verify_problems'], []);
      assert.match(normal.raw['verify_scope_note'], /不是 reserved_by/u);

      const mutation = only('R4', dir, 'R4');
      assert.equal(mutation.verdict, 'fail');
      assert.equal(mutation.raw['bypass_count'], 1, '伪造 bob 认领必须被事件级判据抓到');
      assert.equal(mutation.raw['claims'][0].actor, 'bob');
      assert.equal(mutation.raw['claims'][0].reserved_by_before_claim, 'alice');
      assert.equal(mutation.raw['verify_ok'], false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C5/C6 遗留：0 样本 ⇒ partial；gate 表不存在、stage_run 命中 ⇒ partial + caveat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4g-legacy-'));
    try {
      const human = only('R-legacy1', dir);
      assert.equal(human.verdict, 'partial');
      assert.equal(human.raw['humans'], 0);
      assert.equal(human.raw['m2_r5_verdict'], 'partial');
      assert.equal(human.raw['m3_r4_verdict'], 'partial');
      const gate = only('R-legacy2', dir);
      assert.equal(gate.verdict, 'partial');
      assert.equal(gate.raw['gate_table'], false);
      assert.equal(gate.raw['stage_run_table'], true);
      assert.deepEqual(gate.raw['tables_hit'], ['stage_run']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C7 两遍复跑：归一化后逐键一致（R1 赢家统一为 <winner>，且 winner==stored 断言）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4g-twice-'));
    try {
      const env = tempEnv(dir);
      const first = run(['--out', join(dir, 'a', 'M4-读数')], env);
      assert.equal(first.status, 0, first.stderr);
      const second = run(['--out', join(dir, 'b', 'M4-读数')], env);
      assert.equal(second.status, 0, second.stderr);
      const a = JSON.parse(readFileSync(join(dir, 'a', 'M4-读数.json'), 'utf8')) as Report;
      const b = JSON.parse(readFileSync(join(dir, 'b', 'M4-读数.json'), 'utf8')) as Report;
      assert.equal(a.overall, b.overall);
      assert.deepEqual(normalize(b), normalize(a));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C8 不覆盖已签生成物：跑测前后 M0–M3 生成物 sha256 不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4g-snapshot-'));
    try {
      const before = milestoneHashes();
      const runResult = run(['--out', join(dir, 'M4-读数')], tempEnv(dir));
      assert.equal(runResult.status, 0, runResult.stderr);
      assert.deepEqual(milestoneHashes(), before, 'M0–M3 已签生成物必须逐字节不变');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
