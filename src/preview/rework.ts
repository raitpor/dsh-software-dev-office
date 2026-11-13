/**
 * M1-5 · 一次变更的返工面预览：`rework_units` + `will_change`。
 *
 * 纯函数（C5）：只读事件链（readEvents），只在 `src/core/fold` 的内存态上试算，
 * 不写库、不发事件、不落 preview 行（D-033）。事件语义全部来自 fold，本模块只用
 * 状态差（行集合与行 hash）与 work_unit 的引用关系，不自带任何事件 kind 分支（C3）。
 */
import { canonicalJson, rowHash, sha256Hex } from '../core/fold/canonical.js';
import { fold } from '../core/fold/index.js';
import { TABLE_NAMES } from '../core/fold/types.js';
import type { Event, FoldState, Row, TableName } from '../core/fold/types.js';
import { GENESIS_PREV, computeEventHash, readEvents } from '../core/verify-events.js';
import { checkEnvelope } from '../db/write-envelope.js';
import type { VerifyDatabase, VerifyProblem } from '../core/verify-types.js';
import {
  PreviewError,
  type PreviewChange,
  type PreviewOptions,
  type PreviewResult,
  type ReworkUnitEvidence,
} from './types.js';

/** 调用方手填字段：出现即拒，保证“手填不算”（C4）。 */
const HAND_FILLED_FIELDS = ['rework_units', 'reworkUnits'] as const;

/** work_unit 行里引用其它行的字段 → 被引用的表。 */
const WORK_UNIT_REFS: readonly (readonly [keyof Row, TableName])[] = [
  ['task_id', 'task'],
  ['criterion_id', 'criterion'],
  ['evidence_id', 'evidence'],
  ['spec_id', 'spec'],
];

function stringField(row: Row, field: string): string {
  const value = row[field];
  return typeof value === 'string' ? value : '';
}

function evidenceOf(row: Row, changedRefs: readonly string[]): ReworkUnitEvidence {
  return {
    task_id: stringField(row, 'task_id'),
    criterion_id: stringField(row, 'criterion_id'),
    spec_id: stringField(row, 'spec_id'),
    changed_refs: changedRefs,
  };
}

/**
 * 变更前存在、变更后作废的 work_unit（C2）。
 *
 * “作废”= 单位行消失，或单位行本身 / 其引用的 task、criterion、evidence、spec
 * 任一行的内容 hash 变了。逐行导出 `{task_id, criterion_id, spec_id}` 证据。
 */
export function collectInvalidatedWorkUnits(
  before: FoldState,
  after: FoldState,
): ReworkUnitEvidence[] {
  const beforeUnits = before.tables.work_unit;
  const invalidated: ReworkUnitEvidence[] = [];
  for (const id of Object.keys(beforeUnits).sort()) {
    const row = beforeUnits[id];
    if (row === undefined) {
      continue;
    }
    const changedRefs = invalidationRefs(before, after, id, row);
    if (changedRefs.length > 0) {
      invalidated.push(evidenceOf(row, changedRefs));
    }
  }
  return invalidated;
}

/**
 * 返回触发作废的行引用；空数组 = 没作废。
 * 同一单位只产出一条证据，`changed_refs` 列出所有触发原因（不重复计数）。
 */
function invalidationRefs(before: FoldState, after: FoldState, id: string, beforeRow: Row): string[] {
  const refs: string[] = [];
  const afterRow = after.tables.work_unit[id];
  if (afterRow === undefined) {
    refs.push(`work_unit:${id}`);
    return refs;
  }
  if (rowHash(beforeRow) !== rowHash(afterRow)) {
    refs.push(`work_unit:${id}`);
  }
  for (const [field, table] of WORK_UNIT_REFS) {
    const refId = beforeRow[field];
    if (typeof refId !== 'string') {
      continue;
    }
    const beforeRef = before.tables[table][refId];
    const afterRef = after.tables[table][refId];
    if (beforeRef === undefined) {
      continue;
    }
    if (afterRef === undefined || rowHash(beforeRef) !== rowHash(afterRef)) {
      refs.push(`${table}:${refId}`);
    }
  }
  return refs;
}

/** 前后 fold 态的逐表行差（will_change 的直接来源；不含任何事件语义）。 */
export function diffPreviewStates(
  before: FoldState,
  after: FoldState,
): PreviewChange[] {
  const changes: PreviewChange[] = [];
  for (const table of TABLE_NAMES) {
    const beforeRows = before.tables[table];
    const afterRows = after.tables[table];
    const ids = [...new Set([...Object.keys(beforeRows), ...Object.keys(afterRows)])].sort();
    for (const id of ids) {
      const left = beforeRows[id];
      const right = afterRows[id];
      if (left === undefined && right !== undefined) {
        changes.push({ kind: table, id, change: 'added' });
      } else if (left !== undefined && right === undefined) {
        changes.push({ kind: table, id, change: 'removed' });
      } else if (left !== undefined && right !== undefined && rowHash(left) !== rowHash(right)) {
        changes.push({ kind: table, id, change: 'changed' });
      }
    }
  }
  return changes;
}

function readPreviewState(persisted: readonly Event[]): FoldState {
  try {
    return fold(undefined, persisted);
  } catch (cause) {
    throw new PreviewError(
      'stale_events',
      `preview cannot fold the persisted event chain: ${messageOf(cause)}`,
    );
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 镜像 `append()` 对同一批事件的接受规则（P2，M1-5 第 1 轮评审）：
 * - 已持久化且 hash 相同的事件算“重放”，跳过；重放必须排在新事件之前（与 `src/db/write.ts` 同口径）；
 * - 已持久化但 hash 不同 ⇒ 拒；
 * - 批内重复 id ⇒ 拒（不能落到后续 UNIQUE 冲突）；
 * - 新事件必须接在当前链头，且 `hash` 必须等于 `computeEventHash`。
 * 返回需要“新折叠”的事件（重放事件已包含在 before 状态里）。
 */
function checkBatchSemantics(persisted: readonly Event[], batch: readonly Event[]): Event[] {
  const byId = new Map(persisted.map((event) => [event.id, event.hash] as const));
  let expectedPrev =
    persisted.length === 0 ? GENESIS_PREV : (persisted[persisted.length - 1]?.hash ?? GENESIS_PREV);
  const freshIds = new Set<string>();
  const fresh: Event[] = [];
  let sawNew = false;
  for (const event of batch) {
    // 信封校验对**所有**事件（含重放）都做，与 append 一致；唯一例外是 M1-0 的物化范围收窄
    // （unsupported_scope）：task.* 在 fold 里合法、只是还没物化（D-031/D-038），
    // preview 是 fold 层试算，不在这一步拒。
    const envelope = checkEnvelope(event);
    if (envelope !== undefined && envelope.reason !== 'unsupported_scope') {
      throw new PreviewError(
        'invalid_args',
        `event ${event.id} rejected by the write gateway envelope: ${envelope.message}`,
      );
    }
    const stored = byId.get(event.id);
    if (stored !== undefined) {
      if (sawNew) {
        throw new PreviewError(
          'invalid_args',
          `event ${event.id} of a replay batch must precede new events`,
        );
      }
      if (stored !== event.hash) {
        throw new PreviewError(
          'invalid_args',
          `event ${event.id} already exists with a different hash`,
        );
      }
      // 持久化事件重复出现 = 重放，按幂等跳过（append 同样 skipped）。
      continue;
    }
    if (freshIds.has(event.id)) {
      throw new PreviewError(
        'invalid_args',
        `event ${event.id} appears more than once in the batch (fresh id)`,
      );
    }
    freshIds.add(event.id);
    if (event.prev !== expectedPrev) {
      throw new PreviewError(
        'invalid_args',
        `event ${event.id} does not continue the persisted chain (prev mismatch)`,
      );
    }
    if (computeEventHash(event) !== event.hash) {
      throw new PreviewError('invalid_args', `event ${event.id} hash does not match its content`);
    }
    expectedPrev = event.hash;
    sawNew = true;
    fresh.push(event);
  }
  return fresh;
}

function checkOptions(options: PreviewOptions | undefined): void {
  if (options === undefined) {
    return;
  }
  if (typeof options !== 'object' || options === null) {
    throw new PreviewError('invalid_args', 'preview options must be an object');
  }
  for (const field of HAND_FILLED_FIELDS) {
    // `in` 能覆盖原型链（`Object.create({rework_units: 1})`）；只拒这两个键名，不做白名单。
    if (field in options) {
      throw new PreviewError(
        'invalid_args',
        `preview rejects caller-supplied ${field}: rework_units is computed from fold state, never accepted from the payload`,
      );
    }
  }
}

/**
 * 预览一次变更（C1）：`{willChange, reworkUnits, payloadHash}` 一次调用同时返回。
 *
 * @param db 只读事件链（`readEvents`）。
 * @param events 变更事件批，形状与 `append(events)` 相同（A2）。`payloadHash` 只覆盖事件集合：
 *   空批时只表示“没有变更”，不绑定库状态；非空批靠事件的 `prev`/`hash` 锚链。
 * @param options 接口位；出现 `rework_units`/`reworkUnits` 一律拒（C4）。
 */
export function previewChange(
  db: VerifyDatabase,
  events: readonly Event[],
  options?: PreviewOptions,
): PreviewResult {
  checkOptions(options);
  if (!Array.isArray(events)) {
    throw new PreviewError('invalid_args', 'preview expects an array of events');
  }
  const problems: VerifyProblem[] = [];
  const persisted = readEvents(db, problems);
  if (problems.length > 0) {
    const first = problems[0];
    throw new PreviewError(
      'stale_events',
      `preview cannot trust the persisted event chain: ${first?.code ?? 'unknown'} (${first?.detail ?? 'no detail'})`,
    );
  }
  const before = readPreviewState(persisted);
  const fresh = checkBatchSemantics(persisted, events);
  let after: FoldState;
  try {
    after = fold(before, fresh);
  } catch (cause) {
    throw new PreviewError('invalid_args', `event batch rejected by fold: ${messageOf(cause)}`);
  }

  const invalidatedWorkUnits = collectInvalidatedWorkUnits(before, after);
  const tableChanges = diffPreviewStates(before, after);
  const invalidatedIds = new Set<string>();
  for (const change of tableChanges) {
    if (change.kind === 'work_unit') {
      invalidatedIds.add(change.id);
    }
  }
  // 行本身没变、但引用的上游变了：仍要在 will_change 里露出 3 条 work_unit 路径。
  for (const id of Object.keys(before.tables.work_unit)) {
    if (invalidatedIds.has(id)) {
      continue;
    }
    const row = before.tables.work_unit[id];
    if (row === undefined) {
      continue;
    }
    if (invalidationRefs(before, after, id, row).length > 0) {
      invalidatedIds.add(id);
    }
  }

  const changes = tableChanges.filter(
    (change) => !(change.kind === 'work_unit' && invalidatedIds.has(change.id)),
  );
  for (const id of invalidatedIds) {
    changes.push({ kind: 'work_unit', id, change: 'invalidated' });
  }
  changes.sort((left, right) =>
    left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind.localeCompare(right.kind),
  );

  return {
    willChange: changes,
    reworkUnits: invalidatedWorkUnits.length,
    payloadHash: `sha256:${sha256Hex(canonicalJson(events))}`,
    invalidatedWorkUnits,
  };
}
