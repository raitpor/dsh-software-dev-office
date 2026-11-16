/**
 * M3-G · M2 遗留读数（卡 C6）：M2-G R5 的人类签字样本在 M3 内是否补足。
 * 只读已签 M2 读数，不重测、不造假；样本仍为 0 ⇒ 如实 partial + caveat。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

export function measureLegacyR5() {
  const path = join(ROOT, 'plan', 'milestone', 'M2-读数.json');
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      id: 'R4',
      question: 'M2 遗留 R5（单次签字人工时长）在 M3 是否已有 ≥5 个人类样本',
      command: 'node scripts/m3-readings.mjs --only R4',
      measured: { m2_report: path, read_error: String(error) },
      verdict: 'partial',
      caveat: '读不到已签 M2 读数，无法引用人类样本数；按 A3 不造假。',
    };
  }
  const r5 = report?.readings?.R5?.raw ?? {};
  const samples = Number(r5['human_samples'] ?? 0);
  const sufficient = samples >= 5;
  return {
    id: 'R4',
    question: 'M2 遗留 R5（单次签字人工时长）在 M3 是否已有 ≥5 个人类样本',
    command: 'node scripts/m3-readings.mjs --only R4',
    measured: {
      m2_verdict: report?.readings?.R5?.verdict ?? null,
      human_samples: samples,
      m2_median_ms: r5['median_ms'] ?? null,
      m2_caveat: report?.readings?.R5?.caveat ?? null,
      sufficient,
    },
    verdict: sufficient ? 'pass' : 'partial',
    caveat: sufficient
      ? 'M2 遗留 R5 样本已足，引用 M2 读数。'
      : 'M3 仍无 ≥5 个人类签字样本（M2 样本数见 raw）；按 A3/D-082 不凑数，保持 partial。',
  };
}
