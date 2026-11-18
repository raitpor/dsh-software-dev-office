import { CODE } from '../core/errors/codes.js';
/**
 * M2-4 C4/C6 · 晚到条款链（准入拦截）。
 *
 * `docs/03` §4 / `docs/07` §19.2：准入那一刻按条款**当前版本**查——
 * “你引用的条款，改过之后有没有人重新判过？”没有 ⇒ `clause_unjudged`
 * （不是 `upstream_changed`：那是卡开工/在飞时的上游变化；这里是**准入**时点发现条款晚到）。
 *
 * 只查 pre-work 类判据（`docs/04` §4 `spec_set.signed` 行）：不需要产物就能判的
 * `alignment.examples_present` / `redteam.disposed` / `stage.requirement_complete` /
 * `design.covers_spec`；`task.complete` / `design.code_matches` 属 post-work，**不**在准入查
 * （否则“要准入先有产物、要产物先准入”死锁）。
 *
 * 读数来源：`gate.judged` 折叠进 `stage_run.criteria` 的判据三态读数组（M2-2），
 * 读数时刻 = `stage_run.judged_at`。不读物化表、不自己造第二套读数字段。
 */
import type { FoldState, Row } from '../core/fold/types.js';
import { canonicalJson, rowHash, sha256Hex } from '../core/fold/canonical.js';
import { referencedSpecIds } from '../core/review/refs.js';

/** `docs/04` §4 的 pre-work 适用判据（准入只认这四个；不包含集合签字自身）。 */
export const PRE_WORK_CRITERIA = [
  'alignment.examples_present',
  'redteam.disposed',
  'stage.requirement_complete',
  'design.covers_spec',
] as const;

export type PreWorkCriterion = (typeof PRE_WORK_CRITERIA)[number];

const PRE_WORK_SET: ReadonlySet<string> = new Set(PRE_WORK_CRITERIA);

export interface PreWorkReading {
  readonly spec_id: string;
  readonly criterion: string;
  readonly verdict: string;
  readonly stage_run_id: string;
  /** 读数时刻（`stage_run.judged_at`）。 */
  readonly at: string;
  /** 读数内容的规范化哈希（工具算；`docs/06` §5 的 `data_hash`）。 */
  readonly data_hash: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** ISO 字符串按真实时刻比较；不可解析排最前（与 M1-2 `compareByAtThenId` 同口径）。 */
function timeMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** 某条款的 pre-work 判据（criterion 行 id 命中固定集合）。 */
function preWorkCriteriaOf(state: FoldState, specId: string): Row[] {
  return Object.values(state.tables.criterion).filter(
    (row) => row['spec_id'] === specId && PRE_WORK_SET.has(text(row['id'])),
  );
}

function readingHash(reader: {
  readonly criterion: string;
  readonly verdict: string;
  readonly stage_run_id: string;
  readonly at: string;
}): string {
  return `sha256:${sha256Hex(canonicalJson(reader))}`;
}

/**
 * 某条款在**历次 gate.judged** 里的 pre-work 读数（时间升序）。
 *
 * 读数 = 门禁真正判过的条目（`pass` / `fail` / `na` 都算）：`na` 也是“判过、结论不适用”，
 * 带 reason 与判定时刻；真正“没读数”指 `stage_run` 里没有该条款的 pre-work 条目。
 * M2 的 non-core 判据统一由门禁判 `na`（`not_enforced_in_m2`），因此 M2 的读数以 `na` 为主，
 * 这是“引擎在这一版能给出的读数”，不改口径。
 */
export function preWorkReadingsForSpec(state: FoldState, specId: string): PreWorkReading[] {
  const criteria = new Set(preWorkCriteriaOf(state, specId).map((row) => text(row['id'])));
  if (criteria.size === 0) return [];
  const readings: PreWorkReading[] = [];
  for (const stage of Object.values(state.tables.stage_run)) {
    const judgedAt = text(stage['judged_at']) || text(stage['at']);
    if (judgedAt.length === 0) continue;
    const entries = stage['criteria'];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const reading = entry as Record<string, unknown>;
      const criterion = text(reading['criterion_id']);
      const verdict = text(reading['verdict']);
      if (!criteria.has(criterion)) continue;
      const VERDICTS = new Set(['pass', 'fail', 'na']);
      if (!VERDICTS.has(verdict)) continue;
      const stageRunId = text(stage['id']);
      readings.push({
        spec_id: specId,
        criterion,
        verdict,
        stage_run_id: stageRunId,
        at: judgedAt,
        data_hash: readingHash({ criterion, verdict, stage_run_id: stageRunId, at: judgedAt }),
      });
    }
  }
  return readings.sort((left, right) => timeMs(left.at) - timeMs(right.at) || left.criterion.localeCompare(right.criterion));
}

/** 条款最近一次修订时刻（`spec.revised` 落 `revised_at`；没改过就是定义时刻）。 */
export function latestRevisionAt(state: FoldState, specId: string): string | undefined {
  const spec = state.tables.spec[specId];
  if (spec === undefined) return undefined;
  const revisedAt = text(spec['revised_at']);
  return revisedAt.length > 0 ? revisedAt : text(spec['at']) || undefined;
}

/** 条款的版本哈希（`docs/06` §5 `clause_readings[].spec_version_hash`）。 */
export function specVersionHash(state: FoldState, specId: string): string | undefined {
  const spec = state.tables.spec[specId];
  return spec === undefined ? undefined : `sha256:${rowHash(spec)}`;
}

/** 某条款最近一次 pre-work 读数（按 `at`）。 */
export function latestPreWorkReading(state: FoldState, specId: string): PreWorkReading | undefined {
  const readings = preWorkReadingsForSpec(state, specId);
  return readings[readings.length - 1];
}

export interface ClauseUnjudgedDetail {
  readonly spec_id: string;
  readonly cause: 'no_reading' | 'reading_before_revision';
  readonly revised_at: string;
  readonly reading_at?: string;
}

export type AdmissionResult =
  | { readonly ok: true; readonly checked: readonly string[] }
  | { readonly ok: false; readonly reason_code: typeof CODE.clause_unjudged; readonly details: readonly ClauseUnjudgedDetail[] }
  | { readonly ok: false; readonly reason_code: typeof CODE.task_not_found; readonly details: readonly [] };

const ADMISSION_SPEC_KINDS: ReadonlySet<string> = new Set(['requirement', 'design']);

/**
 * C4：准入时点的条款读数检查。
 *
 * 只查 requirement/design 条款；不查“条款是否已在有效 spec_set 里”（避免自指：
 * 集合签字自身要等读数）。空引用 ⇒ 直接通过。
 */
export function checkAdmission(state: FoldState, taskId: string): AdmissionResult {
  if (state.tables.task[taskId] === undefined) {
    return { ok: false, reason_code: CODE.task_not_found, details: [] };
  }
  const specs = referencedSpecIds(state, taskId).filter((id) => {
    const row = state.tables.spec[id];
    return row !== undefined && ADMISSION_SPEC_KINDS.has(text(row['kind']));
  });
  const details: ClauseUnjudgedDetail[] = [];
  for (const specId of specs) {
    const revisedAt = latestRevisionAt(state, specId);
    if (revisedAt === undefined) continue;
    const reading = latestPreWorkReading(state, specId);
    if (reading === undefined) {
      details.push({ spec_id: specId, cause: 'no_reading', revised_at: revisedAt });
      continue;
    }
    if (timeMs(revisedAt) > timeMs(reading.at)) {
      details.push({ spec_id: specId, cause: 'reading_before_revision', revised_at: revisedAt, reading_at: reading.at });
    }
  }
  if (details.length > 0) return { ok: false, reason_code: CODE.clause_unjudged, details };
  return { ok: true, checked: specs };
}

/**
 * C6：某条款变更后，依赖它且读数已陈旧的卡（P13 依赖闭包）。
 *
 * 复用 C4 的同一判定（不新造第二套 stale 规则）：一个任务“要重判”当且仅当它引用了该条款、
 * 且该条款最近修订晚于它最近一次 pre-work 读数（或根本没有读数）。
 * 未引用该条款的卡不出现。
 */
export function clauseUnjudgedTasks(state: FoldState, specId: string): string[] {
  const revisedAt = latestRevisionAt(state, specId);
  if (revisedAt === undefined) return [];
  const reading = latestPreWorkReading(state, specId);
  if (reading !== undefined && timeMs(revisedAt) <= timeMs(reading.at)) return [];
  const tasks = Object.values(state.tables.task)
    .filter((task) => text(task['kind']) !== 'review') // 评审卡不计入 P13 重判点名（卡面“恰好 3 张”口径）
    .filter((task) => referencedSpecIds(state, text(task['id'])).includes(specId))
    .map((task) => text(task['id']));
  return tasks.sort();
}
