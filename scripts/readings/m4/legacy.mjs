/**
 * M4-G / C5+C6 · 两条 M3 遗留读数。
 *
 * - R-legacy1：人类签字样本（`plan/milestone/M4-人类样本.json`）≥5 条且 5 个不同决策
 *   才把 M2 R5 / M3 R4 改判 pass；不足照实 partial（不造样本）。
 * - R-legacy2：`gate` 与 `stage_run` 两种表名都探测；本仓库实际只有 `stage_run`，
 *   没有 `gate` 表 ⇒ partial + caveat（与 M3-G 同口径）。
 */
import { rmSync } from 'node:fs';

import { measureHumanSamples, DEFAULT_RECEIPTS_FILE } from './r-human.mjs';
import { openFixtureDb, tmpDbPath } from './helpers.mjs';

export function measureLegacyHuman() {
  const reading = measureHumanSamples();
  const raw = reading.measured;
  const samples = Number(raw.humans ?? 0);
  const distinct = Number(raw.distinct_decisions ?? 0);
  const median = raw.median_total_ms === undefined ? null : raw.median_total_ms;
  const pass = samples >= 5 && distinct >= 5;
  return {
    id: 'R-legacy1',
    question: '人类签字样本 ≥5 条且 5 个不同决策时，把 M2 R5 / M3 R4 改判 pass？',
    command: 'node scripts/m4-readings.mjs --only R-legacy1',
    measured: {
      samples_file: 'plan/milestone/M4-人类样本.json',
      receipts_file: DEFAULT_RECEIPTS_FILE,
      humans: samples,
      distinct_decisions: distinct,
      median_total_ms: median,
      threshold: { humans: 5, distinct_decisions: 5 },
      m2_r5_verdict: pass ? 'pass' : 'partial',
      m3_r4_verdict: pass ? 'pass' : 'partial',
      source_verdict: reading.verdict,
    },
    verdict: pass ? 'pass' : 'partial',
    caveat: pass
      ? '样本来自真 signerd 回执 + 真 decision；给出样本数、不同决策数、中位；不把 M2/M3 的旧写死值当证据。'
      : '人类样本不足（当前 0 条）：按 A3 诚实 partial，不为过门造样本；M2 R5 / M3 R4 维持 partial。',
  };
}

export async function measureLegacyGateName() {
  const { dir, path } = tmpDbPath('legacy2');
  let db;
  try {
    db = openFixtureDb(path);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('gate','stage_run') ORDER BY name")
      .all()
      .map((row) => row.name);
    const hasGate = names.includes('gate');
    const hasStageRun = names.includes('stage_run');
    return {
      id: 'R-legacy2',
      question: 'M2-2 的门禁判定实际落在 gate 还是 stage_run？两种名都探测后给结论。',
      command: 'node scripts/m4-readings.mjs --only R-legacy2',
      measured: {
        tables_hit: names,
        gate_table: hasGate,
        stage_run_table: hasStageRun,
        canonical_name: hasGate ? 'gate' : hasStageRun ? 'stage_run' : null,
      },
      verdict: hasGate ? 'pass' : 'partial',
      caveat: hasGate
        ? '发现 gate 表：需按 C6 重跑 M2 R7 类检查后单独出结论（初版先记命中）。'
        : '本仓库没有 gate 表，M2-2 的判定落在 stage_run（M3-G 同口径）：按 C6 记 partial + 此处 caveat，不伪造 gate。',
    };
  } finally {
    if (db !== undefined) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
