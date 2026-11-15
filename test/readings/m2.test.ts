import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const SCRIPT = join(ROOT, 'scripts', 'm2-readings.mjs');
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'artifacts', '__pycache__']);
const VERDICT_RANK: Record<string, number> = { pass: 0, partial: 1, fail: 2 };

function runReadings(outPrefix: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--out', outPrefix], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 180_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface TreeSnapshot {
  readonly exists: boolean;
  readonly entries: readonly string[];
}

/** 树快照：(相对路径, size, mtimeMs)；目录不存在时记录 exists=false，而不是默认空数组。 */
function snapshotTree(root: string): TreeSnapshot {
  if (!existsSync(root)) return { exists: false, entries: [] };
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(current, name);
      const stats = statSync(path);
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile()) {
        entries.push(`${relative(root, path)}|${stats.size}|${Math.trunc(stats.mtimeMs)}`);
      }
    }
  };
  walk(root);
  return { exists: true, entries: entries.sort() };
}

function snapshotState(): TreeSnapshot {
  return snapshotTree(join(homedir(), '.local', 'state', 'sdo'));
}

/** C1 比较键：generatedAt 与 R5 的墙钟派生 4 字段（per_sample/median_total_ms/unlock_wait 正/零样本计数）不可复现（P1-1 裁定）；其余逐键一致。 */
function comparable(reportText: string): unknown {
  const parsed = JSON.parse(reportText) as Record<string, unknown>;
  delete parsed['generatedAt'];
  const readings = parsed['readings'] as Record<string, { raw?: Record<string, unknown> }>;
  const r5 = readings['R5']?.raw;
  if (r5 !== undefined) {
    delete r5['per_sample'];
    delete r5['median_total_ms'];
    delete r5['unlock_wait_positive_samples'];
    delete r5['unlock_wait_zero_samples'];
    r5['median_le_10s'] = 'asserted-separately';
  }
  return parsed;
}

describe('M2-G 读数：可复跑且量真路径', () => {
  it('两遍除 generatedAt/R5 墙钟外逐键一致，生成物结构合法，且不碰生产目录', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sdo-m2g-test-'));
    const repoBefore = snapshotTree(ROOT);
    const stateBefore = snapshotState();
    try {
      const first = runReadings(join(tmp, 'first'));
      assert.equal(first.status, 0, `first run failed: ${first.stderr.slice(0, 800)}`);
      const second = runReadings(join(tmp, 'second'));
      assert.equal(second.status, 0, `second run failed: ${second.stderr.slice(0, 800)}`);

      const json = readFileSync(join(tmp, 'first.json'), 'utf8');
      const md = readFileSync(join(tmp, 'first.md'), 'utf8');
      assert.ok(!json.includes('undefined'), 'JSON 生成物不得含字符串 undefined');
      assert.ok(!md.includes('undefined'), 'Markdown 生成物不得含字符串 undefined');
      assert.ok(!md.includes('signerd 真进程'), 'Markdown 不得声称独立 signerd 进程');

      assert.deepEqual(comparable(json), comparable(readFileSync(join(tmp, 'second.json'), 'utf8')));

      const report = JSON.parse(json) as {
        overall: string;
        readings: Record<string, { id: string; question: string; command: string; raw: unknown; verdict: string; caveat: string }>;
      };
      assert.deepEqual(Object.keys(report.readings).sort(), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
      for (const [id, entry] of Object.entries(report.readings)) {
        assert.equal(entry.id, id);
        const record = entry as unknown as Record<string, unknown>;
        for (const field of ['question', 'command', 'caveat']) {
          assert.equal(typeof record[field], 'string');
          assert.ok(String(record[field]).length > 0, `${id}.${field} 不能为空`);
        }
        // 复跑命令必须指向真实存在的入口（P2-1：不许只验非空串）。
        const commandPath = String(record.command).split(' ')[1] ?? '';
        assert.ok(commandPath.startsWith('scripts/'), `${id}.command 必须以 scripts/ 开头`);
        assert.ok(existsSync(join(ROOT, commandPath)), `${id}.command 指向的 ${commandPath} 不存在`);
        assert.ok(entry.raw !== null && typeof entry.raw === 'object', `${id}.raw 必须是对象`);
        assert.ok(['pass', 'partial', 'fail'].includes(entry.verdict), `${id}.verdict 非法`);
      }

      // P3：overall 必须等于最差 verdict（pass < partial < fail）。
      const entries = Object.values(report.readings) as Array<{ verdict: string }>;
      const worst = entries
        .map((entry) => entry.verdict as keyof typeof VERDICT_RANK)
        .reduce<keyof typeof VERDICT_RANK>(
          (acc, verdict) => (VERDICT_RANK[verdict] ?? 0) > (VERDICT_RANK[acc] ?? 0) ? verdict : acc,
          'pass',
        );
      assert.equal(report.overall, worst, 'overall 必须取最差 verdict');

      // P1-1：R5 现在无人类样本 ⇒ partial；且真实正等待样本存在。
      const r5 = report.readings['R5'];
      assert.equal(r5?.verdict, 'partial', 'R5 必须诚实降级为 partial（无人类样本）');
      const r5raw = r5?.raw as {
        samples: number;
        unlock_wait_positive_samples: number;
        unlock_wait_zero_samples: number;
        sign_ms_positive_samples: number;
        median_le_10s: boolean;
      } | undefined;
      assert.ok(r5raw !== undefined);
      assert.ok(r5raw.samples >= 5);
      assert.ok(r5raw.unlock_wait_positive_samples >= 2);
      assert.ok(r5raw.unlock_wait_zero_samples < 5);
      assert.ok(r5raw.sign_ms_positive_samples >= 5);
      assert.equal(r5raw.median_le_10s, true);

      assert.deepEqual(snapshotState(), stateBefore, '读数不得改 ~/.local/state/sdo');
      assert.deepEqual(snapshotTree(ROOT), repoBefore, '读数不得在仓库树里写文件（含 *.db）');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
