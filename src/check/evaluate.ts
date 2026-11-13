/**
 * `sdo_check` 的求值层（M1-4 C1–C3、C6、C9、C10）。
 *
 * M1 是**只读预览**：`preview:true` / `judged:false` / 顶层 `baseline:null` 恒在；
 * 不写事件、不写 `gate.judged`、不改表（C4/C5）。M1 只强制 core 三条 + 内置 `dead_field`；
 * 其余目录判据没有数据载体 ⇒ `result:'unknown'` + `reasons:[{code:'insufficient_data'}]`
 * （卡 A2；M2 随签字链补齐，不冒充 pass）。
 */

import type { SdoDatabase } from '../db/driver.js';
import { fold } from '../core/fold/index.js';
import type { FoldState, Row } from '../core/fold/types.js';
import { readEvents } from '../core/verify-events.js';
import type { VerifyProblem } from '../core/verify-types.js';
import { appliesToKinds, catalogCodes, criterionMeta, type StageKind } from '../core/criteria/catalog.js';
import { evaluateBinding, type BindingResult, type Policy } from '../core/criteria/binding.js';
import { evaluateDeadField } from './deadfield.js';

export type CheckVerdict = 'pass' | 'fail' | 'na' | 'unknown';

export interface CheckReason {
  readonly code: string;
  readonly detail?: string;
  readonly level?: 'fail' | 'info';
  readonly why?: string;
}

export interface CheckBasis {
  readonly evidence_ids?: readonly string[];
  readonly spec_ids?: readonly string[];
  readonly task_ids?: readonly string[];
}

export interface CriterionCheck {
  readonly criterion_id: string;
  readonly result: CheckVerdict;
  readonly preview: true;
  readonly judged: false;
  readonly effective: boolean;
  readonly binding_reasons: readonly string[];
  readonly reasons: readonly CheckReason[];
  readonly basis: CheckBasis;
}

export interface CheckState {
  readonly state: FoldState;
  readonly problems: readonly VerifyProblem[];
}

export function readCheckState(db: SdoDatabase): CheckState {
  const problems: VerifyProblem[] = [];
  const events = readEvents(db, problems);
  const state = fold(undefined, events);
  return { state, problems };
}

/** 已注册判据：M1 没有独立注册表（目录即注册面），criterion.registered 的 code 必须来自目录。 */
export function registeredCriteria(): ReadonlySet<string> {
  return new Set<string>(catalogCodes());
}

export function requirementSpecs(state: FoldState): readonly Row[] {
  return rowsOf(state, 'spec').filter(
    (row) => row['kind'] === 'requirement' && row['status'] !== 'rejected',
  );
}

export function assumptionSpecs(state: FoldState): readonly Row[] {
  return rowsOf(state, 'spec').filter((row) => row['kind'] === 'assumption');
}

function rowsOf(state: FoldState, table: string): readonly Row[] {
  const tableRows = state.tables[table as keyof FoldState['tables']];
  return Object.values(tableRows ?? {}) as readonly Row[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function specIdsOf(row: Row): readonly string[] {
  const payload = row['payload'];
  if (payload === null || typeof payload !== 'object') return [];
  const ids = (payload as Record<string, unknown>)['spec_ids'];
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}

function signedDecisions(state: FoldState, kind: string): readonly Row[] {
  return rowsOf(state, 'decision').filter(
    (row) =>
      row['decision_kind'] === kind &&
      row['status'] === 'valid' &&
      text(row['signature']).length > 0,
  );
}

function coveredSpecIds(decisions: readonly Row[]): readonly string[] {
  const ids = new Set<string>();
  for (const decision of decisions) for (const id of specIdsOf(decision)) ids.add(id);
  return [...ids].sort();
}

function boundFrontier(decisions: readonly Row[]): boolean {
  return decisions.some((row) => text(row['frontier']).length > 0);
}

export function evaluateCriterionCode(
  db: SdoDatabase,
  state: FoldState,
  criterionId: string,
  policy: Policy,
  registered: ReadonlySet<string>,
  options: { readonly repoRoot?: string } = {},
): CriterionCheck {
  const binding: BindingResult = evaluateBinding(criterionId, { registered, policy });
  const base = {
    criterion_id: criterionId,
    preview: true as const,
    judged: false as const,
    effective: binding.effective,
    binding_reasons: binding.reasons,
  };

  switch (criterionId) {
    case 'provenance.present':
      return { ...base, ...evaluateProvenance(state) };
    case 'spec_set.signed':
      return { ...base, ...evaluateSpecSetSigned(state) };
    case 'assumption_set.signed':
      return { ...base, ...evaluateAssumptionSetSigned(state) };
    case 'dead_field': {
      const report = evaluateDeadField(db, options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot });
      const reasons: CheckReason[] = report.reasons.map((reason) => ({ ...reason }));
      if (report.result === 'pass') {
        reasons.push({ code: 'dead_field_checked', level: 'info', detail: `${report.checked} columns checked` });
      }
      return {
        ...base,
        result: report.result,
        reasons,
        basis: report.result === 'pass' ? { spec_ids: [] } : {},
      };
    }
    default:
      return {
        ...base,
        result: 'unknown',
        reasons: [
          {
            code: 'insufficient_data',
            detail: `M1 没有求值器：${criterionId}（M2 随签字链补齐）`,
          },
        ],
        basis: {},
      };
  }
}

/** `provenance.present`（保证 3）：每条 task 与 spec 的 created_by 非空。
 *  M1 无 actor 注册表 ⇒ 未校验“是否已注册”，必须在 reasons 里标注 `actor_registry_unavailable`。 */
function evaluateProvenance(state: FoldState): Pick<CriterionCheck, 'result' | 'reasons' | 'basis'> {
  const tasks = rowsOf(state, 'task');
  const specs = rowsOf(state, 'spec');
  const missing: CheckReason[] = [];
  for (const task of tasks) {
    if (text(task['created_by']).length === 0) missing.push({ code: 'missing_created_by', detail: `task:${text(task['id'])}` });
  }
  for (const spec of specs) {
    if (text(spec['created_by']).length === 0) missing.push({ code: 'missing_created_by', detail: `spec:${text(spec['id'])}` });
  }
  const reasons: CheckReason[] = [
    ...missing,
    {
      code: 'actor_registry_unavailable',
      level: 'info',
      detail: 'M1 只校验 created_by 非空；actor 是否已注册要到 M3 才有表可查',
    },
  ];
  return {
    result: missing.length === 0 ? 'pass' : 'fail',
    reasons,
    basis: {
      task_ids: tasks.map((row) => text(row['id'])).filter((id) => id.length > 0).sort(),
      spec_ids: specs.map((row) => text(row['id'])).filter((id) => id.length > 0).sort(),
    },
  };
}

/** `spec_set.signed`（保证 1）：无 requirement ⇒ **fail**（reason `no_requirement_yet`）。
 *  M1-4 第 1 轮评审 P1：core 三条不许产 `na`——`na` 会被 gate 聚合洗成 pass，等于给 core 开后门；
 *  这里固定为 fail，保留 `no_requirement_yet` 作为可读原因（口径写进卡 A2/已知边界）。 */
function evaluateSpecSetSigned(state: FoldState): Pick<CriterionCheck, 'result' | 'reasons' | 'basis'> {
  const requirements = requirementSpecs(state);
  const requirementIds = requirements.map((row) => text(row['id'])).filter((id) => id.length > 0).sort();
  if (requirementIds.length === 0) {
    return { result: 'fail', reasons: [{ code: 'no_requirement_yet' }], basis: { spec_ids: [] } };
  }
  const signed = signedDecisions(state, 'spec_set');
  const covered = coveredSpecIds(signed);
  const missing = requirementIds.filter((id) => !covered.includes(id));
  const reasons: CheckReason[] = [];
  if (signed.length === 0) reasons.push({ code: 'spec_set_not_signed' });
  else if (!boundFrontier(signed)) reasons.push({ code: 'spec_set_not_bound_frontier' });
  for (const id of missing) reasons.push({ code: 'spec_set_missing_requirement', detail: id });
  return {
    result: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    basis: { spec_ids: covered.length > 0 ? covered : requirementIds },
  };
}

/** `assumption_set.signed`（保证 2）：无 open 假设；全部假设被有效 decision(kind='assumption_set') 覆盖。
 *  一条假设都没有时也必须签空集（docs/04 §4）。 */
function evaluateAssumptionSetSigned(state: FoldState): Pick<CriterionCheck, 'result' | 'reasons' | 'basis'> {
  const assumptions = assumptionSpecs(state);
  const assumptionIds = assumptions.map((row) => text(row['id'])).filter((id) => id.length > 0).sort();
  const reasons: CheckReason[] = [];
  for (const row of assumptions) {
    if (row['status'] === 'open') reasons.push({ code: 'open_assumption', detail: text(row['id']) });
  }
  const signed = signedDecisions(state, 'assumption_set');
  const covered = coveredSpecIds(signed);
  if (signed.length === 0) {
    reasons.push({ code: 'assumption_set_not_signed' });
  } else {
    for (const id of assumptionIds) {
      if (!covered.includes(id)) reasons.push({ code: 'assumption_set_missing_spec', detail: id });
    }
    if (!boundFrontier(signed)) reasons.push({ code: 'assumption_set_not_bound_frontier' });
  }
  return {
    result: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    basis: { spec_ids: covered.length > 0 ? covered : assumptionIds },
  };
}

/** C7：stage kinds 与所有已注册判据 applies_to 不相交 ⇒ `stage_gap` 可见。 */
export function stageGap(stageId: string, kinds: readonly StageKind[], registered: ReadonlySet<string>): CheckReason | undefined {
  if (kinds.length === 0) return { code: 'stage_gap', detail: `${stageId}: no kind declared` };
  for (const code of registered) {
    const meta = criterionMeta(code);
    if (meta !== undefined && appliesToKinds(meta, kinds)) return undefined;
  }
  return { code: 'stage_gap', detail: `${stageId} (kinds: ${kinds.join(',')})` };
}
