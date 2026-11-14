#!/usr/bin/env node
/**
 * M1-G · 七条判死读数（卡 plan/cards/M1-G.md）
 *
 * 用法：
 *   node scripts/m1-readings.mjs                 # 跑全部七条，写 plan/milestone/M1-读数.{json,md}
 *   node scripts/m1-readings.mjs --only R5       # 单跑一条，stdout 输出 {id,raw}
 *   node scripts/m1-readings.mjs --out <prefix>  # 改输出前缀（默认 plan/milestone/M1-读数）
 *
 * 退出码：fail ⇒ 1；partial/pass ⇒ 0（口径同 M0-G：partial 不算“过”，但也不让脚本红）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MEASURES } from './readings/m1/measure.mjs';
import { exitCodeFor, overallFor } from './readings/verdicts.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SCRIPT));

const MODES = Object.keys(MEASURES);

function parseArgs(argv) {
  const options = { only: undefined, out: join(ROOT, 'plan', 'milestone', 'M1-读数') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--only') {
      index += 1;
      options.only = argv[index];
    } else if (arg === '--out') {
      index += 1;
      options.out = resolve(process.cwd(), argv[index] ?? '');
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.only !== undefined && !MODES.includes(options.only)) {
    throw new Error(`--only must be one of ${MODES.join(', ')}`);
  }
  return options;
}

function runOne(id) {
  const measurement = MEASURES[id];
  if (measurement === undefined) throw new Error(`unknown reading: ${id}`);
  return measurement();
}

function toEntry(result) {
  return {
    id: result.id,
    question: result.question,
    command: result.command,
    raw: result.measured,
    verdict: result.verdict,
    caveat: result.caveat,
  };
}

function toMarkdown(report, verdict) {
  const lines = [
    '# M1 判死读数（M1-G）',
    '',
    `- generatedAt: ${report.generatedAt}`,
    `- command: \`${report.command}\``,
    `- node: ${report.node}`,
    `- overall: **${verdict.overall}**`,
    '',
    '> 每条含：问题 / 复跑命令 / 原始输出（raw）/ verdict / caveat。数据集为临时目录新库，不碰生产库（C10）。',
    '',
  ];
  for (const id of MODES) {
    const entry = report.readings[id];
    lines.push(`## ${id} · ${entry.verdict}`);
    lines.push('');
    lines.push(`**问题**：${entry.question}`);
    lines.push('');
    lines.push(`**命令**：\`${entry.command}\``);
    lines.push('');
    lines.push(`**verdict**：\`${entry.verdict}\``);
    lines.push('');
    lines.push('**raw**：');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(entry.raw, null, 2));
    lines.push('```');
    lines.push('');
    lines.push(`**caveat**：${entry.caveat}`);
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write('node scripts/m1-readings.mjs [--only R1..R7] [--out <prefix>]\n');
    return;
  }

  if (options.only !== undefined) {
    const result = runOne(options.only);
    process.stdout.write(`${JSON.stringify({ id: result.id, raw: result.measured })}\n`);
    return;
  }

  const readings = {};
  for (const id of MODES) {
    readings[id] = toEntry(runOne(id));
  }
  const report = {
    card: 'M1-G',
    generatedAt: new Date().toISOString(),
    command: 'npm run readings:m1',
    node: process.version,
    readings,
  };
  const verdict = {
    overall: overallFor(MODES.map((id) => readings[id].verdict)),
    verdicts: Object.fromEntries(MODES.map((id) => [id, readings[id].verdict])),
  };

  const jsonPath = `${options.out}.json`;
  const mdPath = `${options.out}.md`;
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify({ ...report, overall: verdict.overall }, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, toMarkdown(report, verdict), 'utf8');

  process.stdout.write(
    `${JSON.stringify({ overall: verdict.overall, verdicts: verdict.verdicts, out: { json: jsonPath, md: mdPath } }, null, 2)}\n`,
  );
  process.exitCode = exitCodeFor({ overall: verdict.overall });
}

main();
