/**
 * M0-7 只读导入器 CLI。
 *
 * 用法：
 *   node lib/src/importer/index.js --input <v1-export.json> [--sample N]
 *                                  [--backfill-seq] [--out <report.json>]
 *
 * 只读纪律（C1）：
 *   · 输入导出文件只读；
 *   · 不打开、不创建 SQLite 库（M0 只做「能不能重建」的推演，不落库）；
 *   · 报告默认写 stdout；**只有显式 `--out` 才写文件**——这是本目录唯一的写路径。
 *
 * 退出码：0 = 重建/回填通过且无差异；1 = 导入错误或差异清单非空；2 预留给进程级失败。
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ImportError,
  readExportFile,
  recordPath,
  type ExportClaim,
  type ParsedExport,
} from './parse.js';
import {
  PARSER_ASSERTED_CLAIM_FIELDS,
  sampleRebuild,
  type DiffEntry,
  type RebuiltClaim,
  type SampleRebuildResult,
} from './rebuild.js';
import { backfillSeq, type SeqBackfill } from './seq.js';

export const REPORT_FORMAT = 'sdo-v2-importer-report';
export const REPORT_FORMAT_VERSION = 1;

/**
 * 判据 C2 的抽样下限：不带 `--sample` 时导出至少要有 20 条结论型 claim，
 * 否则 fail-closed（`sample_too_small`）。显式 `--sample N` 视为抽样者已知情，
 * 报告里记 `sample.declared=true`。
 */
export const C2_MIN_SAMPLE = 20;

export interface CliOptions {
  readonly input: string;
  readonly out?: string;
  /** 未给定时默认取导出里的全部 claim（M0-7 正例是 20 条）。 */
  readonly sample?: number;
  readonly backfillSeq: boolean;
}

export interface ReportSample {
  readonly requested: number;
  readonly available: number;
  readonly rebuilt: number;
  /** true = CLI 显式给了 `--sample N`；false = 缺省取全部（受 C2_MIN_SAMPLE 下限约束）。 */
  readonly declared: boolean;
}

export interface ReportParserAssertions {
  /** 由解析层强制、因而不计入 `fields_compared` 的 claim 投影列。 */
  readonly fields: readonly string[];
  /** 断言覆盖的 claim 条数。 */
  readonly claims: number;
}

export interface ReportSummary {
  readonly claims: number;
  readonly work_units: number;
  readonly fields_compared: number;
  readonly diffs: number;
}

export interface Report {
  readonly format: string;
  readonly format_version: number;
  readonly mode: 'rebuild' | 'backfill-seq' | 'rebuild+backfill-seq';
  readonly input: string;
  readonly sample: ReportSample;
  readonly summary: ReportSummary;
  readonly claims: readonly RebuiltClaim[];
  readonly diffs: readonly DiffEntry[];
  /** predicate/value 是解析层强制的自证项，单列，不混进独立比较计数。 */
  readonly asserted_by_parser: ReportParserAssertions;
  readonly seq?: SeqBackfill;
}

function splitFlag(arg: string): readonly [string, string | undefined] {
  if (!arg.startsWith('--')) {
    return [arg, undefined];
  }
  const equals = arg.indexOf('=');
  if (equals < 0) {
    return [arg, undefined];
  }
  return [arg.slice(0, equals), arg.slice(equals + 1)];
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new ImportError('usage', `${flag} requires a value`);
  }
  return value;
}

function requireNonEmpty(value: string, flag: string): string {
  if (value.length === 0) {
    throw new ImportError('usage', `${flag} requires a non-empty value`);
  }
  return value;
}

/** 解析 CLI 参数；任何未知参数 / 非法值都 fail-closed（usage 错误）。 */
export function parseArgs(argv: readonly string[]): CliOptions {
  let input: string | undefined;
  let out: string | undefined;
  let sample: number | undefined;
  let backfillSeqFlag = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    const [name, inline] = splitFlag(arg);
    if (name === '--input') {
      const value = inline ?? takeValue(argv, index + 1, '--input');
      if (inline === undefined) {
        index += 1;
      }
      input = requireNonEmpty(value, '--input');
    } else if (name === '--out') {
      const value = inline ?? takeValue(argv, index + 1, '--out');
      if (inline === undefined) {
        index += 1;
      }
      out = requireNonEmpty(value, '--out');
    } else if (name === '--sample') {
      const value = inline ?? takeValue(argv, index + 1, '--sample');
      if (inline === undefined) {
        index += 1;
      }
      if (!/^[1-9]\d*$/.test(value)) {
        throw new ImportError('usage', `--sample must be a positive integer, got ${JSON.stringify(value)}`);
      }
      sample = Number(value);
    } else if (name === '--backfill-seq') {
      if (inline !== undefined) {
        throw new ImportError('usage', '--backfill-seq is a flag and takes no value');
      }
      backfillSeqFlag = true;
    } else {
      throw new ImportError('usage', `unknown argument ${JSON.stringify(arg)}; see --help`);
    }
  }
  if (input === undefined) {
    throw new ImportError('usage', 'missing required --input <export.json>; see --help');
  }
  return { input, ...(out === undefined ? {} : { out }), ...(sample === undefined ? {} : { sample }), backfillSeq: backfillSeqFlag };
}

/**
 * 抽样前的**整份导出**结构校验（P2-3）：重复 claim_no 已由 parse 层全量拒绝；
 * 这里补上「同一 task_id 多回执」和「seq 冲突/跳号」——否则 `--sample 20` 会把
 * 抽样之外的坏记录悄悄藏起来。
 */
export function validateExportStructure(parsed: ParsedExport): void {
  const owners = new Map<string, ExportClaim>();
  for (const claim of parsed.claims) {
    const previous = owners.get(claim.task_id);
    if (previous !== undefined) {
      throw new ImportError(
        'structure',
        `claims ${previous.claim_no} and ${claim.claim_no} both reference task ${claim.task_id}; M0 rebuild requires one conclusion receipt per task (work_unit is UNIQUE(task_id))`,
        { path: recordPath(claim.offset, 'task_id'), offset: claim.offset },
      );
    }
    owners.set(claim.task_id, claim);
  }
  if (parsed.cards.length > 0) {
    // 回填算法同时校验：card_id/seq 唯一、seq 在 1..N、回填后整列严格递增。
    backfillSeq(parsed.cards);
  }
}

/** 组装报告（纯函数：给定解析结果与选项，输出报告 JSON 结构）。 */
export function buildReport(parsed: ParsedExport, options: CliOptions): Report {
  const available = parsed.claims.length;
  const declared = options.sample !== undefined;
  if (!declared && available < C2_MIN_SAMPLE) {
    throw new ImportError(
      'sample_too_small',
      `export has ${available} claim record(s); C2 requires at least ${C2_MIN_SAMPLE} conclusion receipts without an explicit --sample N (fail-closed: refusing to silently pass a thin sample)`,
      { available, required: C2_MIN_SAMPLE, path: 'records' },
    );
  }
  const requested = options.sample ?? available;
  validateExportStructure(parsed);
  const rebuild: SampleRebuildResult = sampleRebuild(parsed.claims, requested);
  const seq = options.backfillSeq ? backfillSeq(parsed.cards) : undefined;
  const hasRebuild = requested > 0;
  const mode: Report['mode'] = options.backfillSeq
    ? hasRebuild
      ? 'rebuild+backfill-seq'
      : 'backfill-seq'
    : 'rebuild';
  const summary: ReportSummary = {
    claims: rebuild.claims.length,
    work_units: rebuild.claims.filter((claim) => claim.work_unit !== null).length,
    fields_compared: rebuild.fields_compared,
    diffs: rebuild.diffs.length,
  };
  return {
    format: REPORT_FORMAT,
    format_version: REPORT_FORMAT_VERSION,
    mode,
    input: options.input,
    sample: { requested, available, rebuilt: rebuild.claims.length, declared },
    summary,
    claims: rebuild.claims,
    diffs: rebuild.diffs,
    asserted_by_parser: {
      fields: PARSER_ASSERTED_CLAIM_FIELDS.map((field) => `claim.${field}`),
      claims: rebuild.claims.length,
    },
    ...(seq === undefined ? {} : { seq }),
  };
}

export function usageText(): string {
  return [
    'M0-7 只读导入器：读 v1 导出（sdo1-export 夹具），抽样重建 claim/work_unit，',
    '产差异清单；可选回填存量卡 seq 映射表。不写库（--out 除外）。',
    '',
    '用法:',
    '  node lib/src/importer/index.js --input <export.json> [--sample N] [--backfill-seq] [--out <report.json>]',
    '',
    '参数:',
    '  --input <file>    必填；v1 只读导出文件（当前仅认 format=sdo1-export, format_version=1）',
    '  --sample <N>      重建前 N 条 claim；缺省=全部（且导出须 >= 20 条，否则 fail-closed）',
    '  --backfill-seq    产出 card_id → seq 映射表（1..N 唯一单调），不写库',
    '  --out <file>      把报告 JSON 同时写到文件；缺省只写 stdout',
    '  --help            打印本帮助',
  ].join('\n');
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * CLI 主流程。可注入 io 便于测试；返回进程退出码。
 * 错误一律序列化成 stderr JSON `{error:{code,message,offset?,cardIds?,path?}}`。
 */
export function runCli(argv: readonly string[], io: CliIo = defaultIo): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(`${usageText()}\n`);
    return 0;
  }
  try {
    const options = parseArgs(argv);
    if (options.out !== undefined && resolve(options.out) === resolve(options.input)) {
      throw new ImportError(
        'invalid_field',
        `--out must not point at the read-only --input (${options.input}); choose a different report path`,
        { path: options.out },
      );
    }
    const parsed = readExportFile(options.input);
    const report = buildReport(parsed, options);
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out !== undefined) {
      try {
        writeFileSync(options.out, text, 'utf8');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ImportError('io', `cannot write --out report ${options.out}: ${detail}`, {
          path: options.out,
        });
      }
    }
    io.stdout(text);
    return report.diffs.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof ImportError) {
      io.stderr(`${JSON.stringify({ error: error.toJSON() }, null, 2)}\n`);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
