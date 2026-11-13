/**
 * test/importer 共用工具：读夹具、跑 CLI、构造 seq 输入。
 * 只读夹具；需要改写时由测试自己拷到临时目录。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseExportText, type ExportCard, type ParsedExport } from '../../src/importer/parse.js';

export const REPO_ROOT = process.cwd();
export const FIXTURE_PATH = resolve(REPO_ROOT, 'test/fixtures/v1-export.json');
export const CLI_PATH = resolve(REPO_ROOT, 'lib/src/importer/index.js');

/** 读夹具并解析（走与 CLI 相同的 parse 层，保证测试与生产解析一致）。 */
export function loadFixture(): ParsedExport {
  const text = readFileSync(FIXTURE_PATH, 'utf8');
  return parseExportText(text, FIXTURE_PATH);
}

/** 读夹具原始 JSON，供测试改字段后再 parse（C4 之类）。 */
export function fixtureDocument(): { records: Record<string, unknown>[] } {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('fixture is not an object');
  }
  return raw as { records: Record<string, unknown>[] };
}

export interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 以子进程跑 `node lib/src/importer/index.js`（after `npm run build`）。 */
export function runImportCli(args: readonly string[], cwd: string = REPO_ROOT): CliRun {
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** 解析 stdout 报告 JSON。 */
export function parseReport(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('report is not an object');
  }
  return parsed as Record<string, unknown>;
}

/** 解析 stderr 错误 JSON。 */
export function parseCliError(stderr: string): Record<string, unknown> {
  const parsed = JSON.parse(stderr) as unknown;
  if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) {
    throw new Error(`stderr is not an importer error JSON: ${stderr}`);
  }
  return (parsed as { error: Record<string, unknown> }).error;
}

/** 构造 card 记录（导出流里的 card record）。 */
export function cardRecord(card_id: string, seq: number | null): ExportCard {
  return { kind: 'card', offset: 0, card_id, title: null, seq };
}
