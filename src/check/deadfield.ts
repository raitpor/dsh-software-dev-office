/**
 * `dead_field`：内置硬编码判据（`docs/04` §2 / `docs/09` §16.2 读数③）。
 *
 * 口径（M1-4 卡 C9，Lead m02380 裁 (b)）：
 * - 范围 = 六张主表（`docs/03` §1：intent / spec / scenario / criterion / evidence / claim）。
 * - 对每列判「有写入方 ∧ 有消费者」：
 *   - 有写入方、无消费者 ⇒ `result:'fail'` + `reasons:[{code:'dead_field',detail:'<table>.<column>'}]`；
 *   - 无写入方（引擎还没写过这一列）⇒ 不判 fail，输出 `{level:'info',why:'no_writer'}`——
 *     `scenario` 无写入路径（台账 D-024）、`claim` 属 M1-6，正好落这一类；不造“永远红”的判据。
 * - 消费者三者任一（Lead 指定）：
 *   ① 出现在 `migrations/002_views.sql` 的视图 body；
 *   ② `field_consumer` 目录表有行（`field` 记为 `table.column` 或列名）；
 *   ③ 在 `src/query/`、`src/ui/`、`src/align/` 的 TS 源码里被当字段名读取（静态扫描，启发式）。
 *
 * 写入方清单 = 引擎 fold reducer 实际写的列（见每张表的注释）；**故意不读文档**，
 * 文档说“该有”不算写入方。清单是产品常量，测试不得改它；红例通过 `options.writers`
 * 注入测试专用的一列（只在进程内生效）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { SdoDatabase } from '../db/driver.js';

export const DEAD_FIELD_TABLES = ['intent', 'spec', 'scenario', 'criterion', 'evidence', 'claim'] as const;
export type DeadFieldTable = (typeof DEAD_FIELD_TABLES)[number];

/** 引擎写入方（表 → 列）。列名按 fold reducer 实际 upsert 的键列出；
 *  运行时与 `PRAGMA table_info` 求交，所以 fold-only 列（如 intent.status）自动忽略。 */
export const ENGINE_WRITERS: Readonly<Record<DeadFieldTable, readonly string[]>> = {
  // src/core/fold/reducers/intent.ts · intentSigned
  intent: [
    'id', 'statement', 'source_text', 'owner', 'decision_id', 'strength',
    'baseline_hash', 'content_hash', 'status', 'at',
  ],
  // src/core/fold/reducers/spec.ts · specRow / spec.defined / spec.revised
  spec: [
    'id', 'kind', 'intent_id', 'clause', 'mech_checkable', 'scenario_id', 'is_core',
    'status', 'blast_radius', 'created_by', 'producer', 'content_hash',
    'design_artifact_sha256', 'code_artifact_sha256', 'code_artifact_ref',
    'risk_flags', 'alternatives', 'no_alternative_reason', 'at',
  ],
  // 无写入路径（台账 D-024：scenario 表有 schema、没有事件类型）
  scenario: [],
  // src/core/fold/reducers/verify.ts · criterionRegistered / criterionRevised
  criterion: ['id', 'spec_id', 'kind', 'status_enum', 'remedy', 'at', 'revised_at'],
  // src/core/fold/reducers/verify.ts · evidenceAttached
  evidence: [
    'id', 'criterion_id', 'artifact_uri', 'artifact_sha256', 'command',
    'output_digest', 'snapshot_id', 'at',
  ],
  // 无写入路径（claim 的派生属 M1-6）
  claim: [],
};

export interface DeadFieldReason {
  readonly code: 'dead_field';
  readonly detail: string;
  readonly level?: 'fail' | 'info';
  readonly why?: string;
}

export interface DeadFieldReport {
  readonly result: 'pass' | 'fail';
  readonly reasons: DeadFieldReason[];
  readonly checked: number;
}

export interface DeadFieldOptions {
  /** @internal test-only：向写入方清单注入列（不改 `ENGINE_WRITERS`；红例专用）。 */
  readonly writers?: Readonly<Partial<Record<DeadFieldTable, readonly string[]>>>;
  /** 仓库根（默认 cwd；测试可显式传）。 */
  readonly repoRoot?: string;
}

const IDENT_SCAN_DIRS = ['src/query', 'src/ui', 'src/align'] as const;

function readTextSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readTsCorpus(root: string, dir: string): string {
  let out = '';
  let entries: string[];
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.endsWith('.ts')) {
      out += readTextSafe(join(root, dir, entry));
      out += '\n';
    }
  }
  return out;
}

function escapeIdent(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(text: string, column: string): boolean {
  if (text.length === 0) return false;
  return new RegExp(`(?<![A-Za-z0-9_])${escapeIdent(column)}(?![A-Za-z0-9_])`).test(text);
}

function fieldConsumerFields(db: SdoDatabase): readonly string[] {
  try {
    const rows = db.prepare('SELECT field FROM field_consumer').all() as { field: string }[];
    return rows.map((row) => row.field);
  } catch {
    return [];
  }
}

function tableColumns(db: SdoDatabase, table: DeadFieldTable): readonly string[] {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.map((row) => row.name);
  } catch {
    return [];
  }
}

/** 判据入口：纯读（不写库、不发事件）。 */
export function evaluateDeadField(db: SdoDatabase, options: DeadFieldOptions = {}): DeadFieldReport {
  const root = options.repoRoot ?? process.cwd();
  const viewBodies = readTextSafe(join(root, 'migrations', '002_views.sql'));
  const codeCorpus = IDENT_SCAN_DIRS.map((dir) => readTsCorpus(root, dir)).join('\n');
  const directory = new Set(fieldConsumerFields(db));

  const reasons: DeadFieldReason[] = [];
  let checked = 0;

  for (const table of DEAD_FIELD_TABLES) {
    const injected = options.writers?.[table] ?? [];
    const writers = new Set([...ENGINE_WRITERS[table], ...injected]);
    for (const column of tableColumns(db, table)) {
      checked += 1;
      const detail = `${table}.${column}`;
      if (!writers.has(column)) {
        reasons.push({ code: 'dead_field', detail, level: 'info', why: 'no_writer' });
        continue;
      }
      const consumed =
        directory.has(detail) ||
        directory.has(column) ||
        mentions(viewBodies, column) ||
        mentions(codeCorpus, column);
      if (!consumed) {
        reasons.push({ code: 'dead_field', detail, level: 'fail' });
      }
    }
  }

  const result = reasons.some((reason) => reason.level !== 'info') ? 'fail' : 'pass';
  return { result, reasons, checked };
}
