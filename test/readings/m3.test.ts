import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const SCRIPT = join(ROOT, 'scripts', 'm3-readings.mjs');
// 跳过 `lib`/`dist` 的理由：它们是 `npm run build` 的产物（脚本入口前本来就跑 build），
// 不属于“读数是否写仓库”的证据面；跳过不是漏网——源码/生成物目录仍在快照内。
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'artifacts', '__pycache__']);
const VERDICT_RANK: Record<string, number> = { pass: 0, partial: 1, fail: 2 };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** 产品随机生成、两遍必然不同的 id 字段（不是时钟，也不能从报告里删——C2 要求写数据来源）。 */
const VOLATILE_KEYS = new Set([
  'conflict_detected_event_id',
  'conflict_row_id',
  'single_gate_judged_event_id',
  'double_gate_judged_event_id',
  'attention_id',
  'freeze_decision_id',
  'started_at', // R1 墙钟屏障后的进程启动时刻：时钟字段，两遍必然不同
]);

function runReadings(outPrefix: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--out', outPrefix], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 240_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface TreeSnapshot {
  readonly exists: boolean;
  readonly entries: readonly string[];
}

function snapshotTree(root: string): TreeSnapshot {
  if (!existsSync(root)) return { exists: false, entries: [] };
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(current, name);
      const stats = statSync(path);
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile()) entries.push(`${relative(root, path)}|${stats.size}|${Math.trunc(stats.mtimeMs)}`);
    }
  };
  walk(root);
  return { exists: true, entries: entries.sort() };
}

function snapshotState(): TreeSnapshot {
  return snapshotTree(join(homedir(), '.local', 'state', 'sdo'));
}

/**
 * C4 比较键：generatedAt 与 UUID 规范化。
 * 另：R1 的墙钟屏障（startAt = Date.now()+1200）不是冻结时钟，两进程是否真重叠依赖机器速度；
 * 两遍比较只保证“同样的事实形状一致”，不保证竞态角色不变。
 * 冲突/判定事件 id 由产品用 randomUUID 生成（数据来源要求写它们，不能删字段），
 * 不是时钟；两遍比较时把 UUID 归一为 `<uuid>`，其余逐键一致。
 */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = stripVolatile(item);
    }
    return out;
  }
  return value;
}

/**
 * R1 的赢家本来就是竞态结果（两遍不同但两遍都满足 ok:1/conflict:1）。
 * C4 比较前把“谁赢”规范化为 ok/conflict 角色，逐键比其余事实；单遍断言仍看真实 actor。
 */
function canonicalizeRace(parsed: Record<string, unknown>): void {
  const readings = parsed['readings'] as Record<string, { raw?: Record<string, unknown> }> | undefined;
  const r1 = readings?.['R1']?.raw;
  if (r1 === undefined) return;
  const workers = (r1['worker_results'] as Array<Record<string, unknown>> | undefined) ?? [];
  r1['worker_results'] = workers
    .map((worker) => ({
      ...worker,
      actor: worker['outcome'] === 'ok' ? '<winner>' : '<loser>',
      event_id: '<event>',
    }))
    .sort((a, b) => String(a['actor']).localeCompare(String(b['actor'])));
  // F1：先验证“落库值 == 赢家值”的等式，再一起归一。若粗暴覆盖，会让 stored_clause 漂移在 C4 里不可见。
  const winnerValue = r1['winner_value'];
  const storedClause = r1['stored_clause'];
  let storedMatchesWinner = false;
  try {
    storedMatchesWinner = JSON.parse(String(winnerValue)) === storedClause;
  } catch {
    storedMatchesWinner = false;
  }
  r1['stored_clause'] = storedMatchesWinner ? '<winner-value>' : `<MISMATCH:${String(storedClause)}>`;
  r1['winner_actor'] = '<winner>';
  r1['loser_actor'] = '<loser>';
  r1['winner_value'] = '<winner-value>';
  r1['loser_value'] = '<loser-value>';
  // winner_event_id 必须就是 spec.revised 事件表里那条；脱节时归一成 MISMATCH，避免两遍比较看不出。
  const winnerEventId = r1['winner_event_id'];
  const revisedEvents = (r1['spec_revised_events'] as string[] | undefined) ?? [];
  const winnerEventLinked = revisedEvents.length === 1 && revisedEvents[0] === winnerEventId;
  r1['winner_event_id'] = winnerEventLinked ? '<winner-event>' : `<MISMATCH:${String(winnerEventId)}>`;
  r1['spec_revised_events'] = [winnerEventLinked ? '<winner-event>' : '<MISMATCH>'];
}

function comparable(reportText: string): unknown {
  const parsed = JSON.parse(reportText.replace(UUID, '<uuid>')) as Record<string, unknown>;
  delete parsed['generatedAt'];
  canonicalizeRace(parsed);
  return stripVolatile(parsed);
}

describe('M3-G 读数：可复跑且量真路径', () => {
  it('两遍除 generatedAt/UUID 外逐键一致，结构合法，且不碰生产目录', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sdo-m3g-test-'));
    const repoBefore = snapshotTree(ROOT);
    const stateBefore = snapshotState();
    try {
      const first = runReadings(join(tmp, 'first'));
      assert.equal(first.status, 0, `first run failed: ${first.stderr.slice(0, 1200)}`);
      const second = runReadings(join(tmp, 'second'));
      assert.equal(second.status, 0, `second run failed: ${second.stderr.slice(0, 1200)}`);

      const json = readFileSync(join(tmp, 'first.json'), 'utf8');
      const md = readFileSync(join(tmp, 'first.md'), 'utf8');
      assert.ok(!json.includes('undefined'), 'JSON 生成物不得含字符串 undefined');
      assert.ok(!md.includes('undefined'), 'Markdown 生成物不得含字符串 undefined');
      assert.deepEqual(comparable(json), comparable(readFileSync(join(tmp, 'second.json'), 'utf8')));

      // P2-1 区分力：若归一化无条件覆盖 stored_clause，篡改后两遍仍相等（假绿）；正确实现必须不等。
      const tampered = JSON.parse(json) as { readings: { R1: { raw: Record<string, unknown> } } };
      tampered.readings.R1.raw['stored_clause'] = 'tampered-by-test';
      assert.notDeepEqual(comparable(JSON.stringify(tampered)), comparable(json), '归一化必须保留 stored_clause 等式：篡改后两遍不得相等');

      const report = JSON.parse(json) as {
        overall: string;
        readings: Record<
          string,
          { id: string; question: string; command: string; raw: Record<string, unknown>; verdict: string; caveat: string }
        >;
      };
      assert.deepEqual(Object.keys(report.readings).sort(), ['R1', 'R2', 'R3', 'R4']);
      for (const [id, entry] of Object.entries(report.readings)) {
        assert.equal(entry.id, id);
        const record = entry as unknown as Record<string, unknown>;
        for (const field of ['question', 'command', 'caveat']) {
          assert.equal(typeof record[field], 'string');
          assert.ok(String(record[field]).length > 0, `${id}.${field} 不能为空`);
        }
        const commandPath = String(record['command']).split(' ')[1] ?? '';
        assert.ok(existsSync(join(ROOT, commandPath)), `${id}.command 指向的 ${commandPath} 不存在`);
        assert.ok(entry.raw !== null && typeof entry.raw === 'object', `${id}.raw 必须是对象`);
        assert.ok(['pass', 'partial', 'fail'].includes(entry.verdict), `${id}.verdict 非法`);
      }

      // 三条判死读数必须 pass；M2 遗留 R5 无人类样本 ⇒ R4 partial、overall partial。
      assert.equal(report.readings['R1']?.verdict, 'pass');
      assert.equal(report.readings['R2']?.verdict, 'pass');
      assert.equal(report.readings['R3']?.verdict, 'pass');
      assert.equal(report.readings['R4']?.verdict, 'partial');
      const worst = Object.values(report.readings)
        .map((entry) => entry.verdict as keyof typeof VERDICT_RANK)
        .reduce<keyof typeof VERDICT_RANK>(
          (acc, verdict) => (VERDICT_RANK[verdict] ?? 0) > (VERDICT_RANK[acc] ?? 0) ? verdict : acc,
          'pass',
        );
      assert.equal(report.overall, worst, 'overall 必须取最差 verdict');
      assert.equal(report.overall, 'partial');

      // C2 数据来源：R1 必须写出赢家事件/冲突事件/冲突行 id；R2 必须写 baseline hash。
      const r1 = report.readings['R1']?.raw as Record<string, unknown>;
      for (const key of ['winner_event_id', 'conflict_detected_event_id', 'conflict_row_id', 'winner_actor', 'loser_actor']) {
        assert.equal(typeof r1[key], 'string', `R1.raw.${key} 必须是数据来源`);
        assert.ok(String(r1[key]).length > 0, `R1.raw.${key} 不能为空`);
      }
      assert.equal(r1['conflicts_view_rows'], 1);
      assert.equal(typeof r1['stored_clause'], 'string');
      assert.notEqual(String(r1['stored_clause']).length, 0, 'R1 必须读到最终落库值');
      // P3：单遍直接断言“落库值 == 赢家值”与“winner_event_id 就是 spec.revised 那条”，不只依赖 verdict。
      assert.equal(r1['stored_clause'], JSON.parse(String(r1['winner_value'])), 'R1 最终落库值必须等于赢家值');
      const revisedIds = r1['spec_revised_events'] as string[] | undefined;
      assert.equal(revisedIds?.length, 1, 'R1 只能有一条 spec.revised 事件');
      assert.equal(revisedIds?.[0], r1['winner_event_id'], 'R1 winner_event_id 必须对应 spec.revised 事件行');
      const r2 = report.readings['R2']?.raw as Record<string, unknown>;
      assert.match(String(r2['baseline_hash']), /^sha256:[0-9a-f]{64}$/);
      assert.equal(r2['baseline_row_hash'], r2['baseline_hash'], 'R2 必须回查 baseline 行 hash 与 preview hash 一致');
      assert.match(String(r2['second_baseline_hash']), /^sha256:[0-9a-f]{64}$/);
      assert.equal(r2['chain_head_equals_b2'], true, 'R2 负例要求链头已是第二版 baseline');
      assert.notEqual(r2['second_baseline_hash'], r2['baseline_hash']);
      for (const key of ['freeze_decision_id', 'single_gate_judged_event_id', 'double_gate_judged_event_id']) {
        assert.equal(typeof r2[key], 'string', `R2.raw.${key} 必须是数据来源`);
        assert.ok(String(r2[key]).length > 0, `R2.raw.${key} 不能为空`);
      }
      assert.equal(r2['single_signer_verdict'], 'changes_requested');
      assert.ok((r2['single_signer_reasons'] as string[]).includes('independence_unsatisfied'));
      assert.equal(r2['dual_signer_verdict'], 'pass');
      assert.equal(r2['single_gate_judged_event_checked'], true, 'R2 单签判定事件必须真存在于事件表且 kind=gate.judged');
      assert.equal(r2['double_gate_judged_event_checked'], true, 'R2 双签判定事件必须真存在于事件表且 kind=gate.judged');
      assert.equal(r2['freeze_decision_row_checked'], true, 'R2 freeze 决策行必须真存在于 decision 表');

      // F2：R3 必须证明“迁移”——撤权前无申请入口/页面无申请，撤权后出现且 scope 是 release:R-3。
      const r3 = report.readings['R3']?.raw as Record<string, unknown>;
      assert.equal(typeof r3['attention_id'], 'string');
      assert.ok(String(r3['attention_id']).length > 0, 'R3.raw.attention_id 不能为空');
      const before = r3['before'] as Record<string, unknown>;
      const after = r3['after'] as Record<string, unknown>;
      assert.equal(before['apply_entries'], 0, 'R3 撤权前不应有申请入口（需要 read@domain:pm 夹具）');
      assert.equal(before['page_has_apply'], false, 'R3 撤权前页面不应出现申请入口');
      assert.equal(before['page_has_to_decide'], true);
      assert.equal(after['rows'], 0);
      assert.equal(after['page_has_to_decide'], false);
      assert.equal(after['page_has_apply'], true);
      assert.ok((after['apply_scopes'] as string[]).includes('release:R-3'), 'R3 撤权后申请入口必须是 release:R-3');

      assert.deepEqual(snapshotState(), stateBefore, '读数不得改 ~/.local/state/sdo');
      assert.deepEqual(snapshotTree(ROOT), repoBefore, '读数不得在仓库树里写文件（含 *.db）');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
