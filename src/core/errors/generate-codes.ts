/**
 * 生成人手读的码表 `src/core/errors/CODES.md`（C3：README 码表由脚本生成，不手写）。
 * 用法：`npm run build && node lib/src/core/errors/generate-codes.js`
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASON_CODES, type ReasonGroup } from './codes.js';

const GROUPS: readonly ReasonGroup[] = ['auth', 'write', 'gate', 'sign', 'release', 'query', 'config', 'internal'];

export function renderCodesMarkdown(): string {
  const lines: string[] = [
    '# Reason codes（自动生成，勿手改）',
    '',
    '由 `src/core/errors/generate-codes.ts` 从 `REASON_CODES` 生成；新增/改名请改码表后重跑。',
    '',
    `共 ${REASON_CODES.length} 个码。`,
    '',
  ];
  for (const group of GROUPS) {
    const entries = REASON_CODES.filter((entry) => entry.group === group);
    lines.push(`## ${group}（${entries.length}）`, '', '| code | summary | HTTP | reserved |', '|---|---|---|---|');
    for (const entry of entries) {
      lines.push(
        `| \`${entry.code}\` | ${entry.summary.replace(/\|/g, '\\|')} | ${entry.http_status ?? ''} | ${entry.reserved ? entry.reserved_for ?? 'yes' : ''} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeCodesMarkdown(path = join(dirname(fileURLToPath(import.meta.url)), '../../../..', 'src/core/errors/CODES.md')): void {
  writeFileSync(path, renderCodesMarkdown(), 'utf8');
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** `--check`：重算 CODES.md / snapshot 与仓库文件一致则 0，否则非零（P2-1）。 */
export function checkGenerated(): readonly string[] {
  const problems: string[] = [];
  const markdownPath = join(ROOT, 'src/core/errors/CODES.md');
  if (!existsSync(markdownPath) || readFileSync(markdownPath, 'utf8') !== renderCodesMarkdown()) {
    problems.push('CODES.md 与 renderCodesMarkdown() 不一致');
  }
  const snapshotPath = join(ROOT, 'test/core/errors/code-snapshot.json');
  try {
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { table?: readonly string[] };
    const frozen = new Set(snapshot.table ?? []);
    const current = new Set(REASON_CODES.map((entry) => entry.code));
    for (const code of current) if (!frozen.has(code)) problems.push(`snapshot 缺码: ${code}`);
    for (const code of frozen) if (!current.has(code)) problems.push(`snapshot 多码: ${code}`);
  } catch (error) {
    problems.push(`snapshot 读取失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const problems = checkGenerated();
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  } else {
    writeCodesMarkdown();
  }
}
