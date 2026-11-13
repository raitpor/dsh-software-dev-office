/**
 * `sdo_check` 公开入口（M1-4 C1–C3）。
 *
 * 只读预览：不写事件、不写 `gate.judged`、不改表（C4/C5）；输出必带
 * `preview:true` / `judged:false` / `baseline:null`，文案不冒充“判定/门禁”（C3）。
 * 参数错（未知判据/未知 stage/参数形状）返回结构化失败，由 CLI 映射退出码 2；
 * 工具自身错抛异常，由 CLI 映射退出码 1（判据 fail 仍退 0，C7/卡假设 A3）。
 */

import type { SdoDatabase } from '../db/driver.js';
import { PRESETS } from '../core/baseline/presets.js';
import { catalogCodes } from '../core/criteria/catalog.js';
import {
  evaluateCriterionCode,
  readCheckState,
  registeredCriteria,
  type CriterionCheck,
} from './evaluate.js';
import { evaluateGate, isPresetId, presetPolicy, type GateCheck } from './gate.js';

export type CheckFailureCode = 'unknown_criterion' | 'unknown_stage' | 'unknown_preset' | 'invalid_args';

export interface CheckFailure {
  readonly ok: false;
  readonly reason_code: CheckFailureCode;
  readonly message: string;
}

export interface CheckReport {
  readonly ok: true;
  readonly preview: true;
  readonly judged: false;
  readonly baseline: null;
  readonly at: string;
  readonly mode: 'criterion' | 'gate';
  readonly criterion?: CriterionCheck;
  readonly gate?: GateCheck;
}

export interface RunCheckOptions {
  readonly criterion?: string;
  readonly gate?: string;
  readonly preset?: string;
  readonly repoRoot?: string;
  /** 测试用确定性时间（C8：同输入两次除 at 外逐字节相同）。 */
  readonly at?: string;
}

const BUILTIN_CRITERIA = ['dead_field'] as const;

export function runCheck(db: SdoDatabase, options: RunCheckOptions): CheckReport | CheckFailure {
  const hasCriterion = options.criterion !== undefined;
  const hasGate = options.gate !== undefined;
  if (hasCriterion === hasGate) {
    return { ok: false, reason_code: 'invalid_args', message: '需要且只需要 --criterion <id> 或 --gate <stage> 之一' };
  }

  const presetId = options.preset ?? 'waterfall';
  if (!isPresetId(presetId)) {
    return {
      ok: false,
      reason_code: 'unknown_preset',
      message: `未知 preset：${presetId}（可用：${Object.keys(PRESETS).join(', ')}）`,
    };
  }
  const preset = PRESETS[presetId];
  const at = options.at ?? new Date().toISOString();

  const { state, problems } = readCheckState(db);
  if (problems.length > 0) {
    throw new Error(`event chain is not readable: ${problems[0]?.code ?? 'unknown'}`);
  }

  const policy = presetPolicy(preset);
  const registered = registeredCriteria();
  const base = { ok: true as const, preview: true as const, judged: false as const, baseline: null, at };

  if (hasCriterion) {
    const criterionId = options.criterion as string;
    const known = BUILTIN_CRITERIA_SET.has(criterionId) || catalogCodes().includes(criterionId);
    if (!known) {
      return {
        ok: false,
        reason_code: 'unknown_criterion',
        message: `未知判据：${criterionId}`,
      };
    }
    const criterion = evaluateCriterionCode(db, state, criterionId, policy, registered, options);
    return { ...base, mode: 'criterion', criterion };
  }

  const gate = evaluateGate(db, state, preset, options.gate as string, options);
  if (gate === undefined) {
    return {
      ok: false,
      reason_code: 'unknown_stage',
      message: `preset ${presetId} 没有 stage：${String(options.gate)}`,
    };
  }
  return { ...base, mode: 'gate', gate };
}

const BUILTIN_CRITERIA_SET: ReadonlySet<string> = new Set(BUILTIN_CRITERIA);

export { evaluateGate, presetPolicy, type GateCheck } from './gate.js';
export {
  evaluateCriterionCode,
  readCheckState,
  registeredCriteria,
  type CheckBasis,
  type CheckReason,
  type CheckVerdict,
  type CriterionCheck,
} from './evaluate.js';
export { DEAD_FIELD_TABLES, ENGINE_WRITERS, evaluateDeadField, type DeadFieldReport } from './deadfield.js';
