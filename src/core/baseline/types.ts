/**
 * P15 静态校验器的输入/输出形状（M1-3）。
 * 真源：`docs/04` §5.1（baseline 冻结什么）、§5.2（规则）、§6（有效绑定）。
 * 输入是 JSON 可序列化对象；本模块不读文件、不读时钟、不写任何东西。
 */

/** `docs/04` §6：有效绑定五条件里的 stage kind。 */
export const STAGE_KINDS = ['requirement', 'design', 'implement', 'review', 'deliver'] as const;

export type KnownStageKind = (typeof STAGE_KINDS)[number];

export interface BaselineStage {
  readonly id: string;
  readonly kinds: readonly KnownStageKind[];
  readonly after: readonly string[];
}

export interface BaselineGate {
  readonly id: string;
  readonly stage: string;
  readonly criteria: readonly string[];
  readonly policy_mode: 'all_of' | 'any_of';
  readonly waivable: boolean;
}

export type Guarantee = 1 | 2 | 3;

export type GuaranteeStatus = 'kept' | 'degraded';

/**
 * 卡面 ①–⑪ 的业务码 + 两个结构短路码。
 * 结构错只出一个码（`stage_bad_kind` / `invalid_baseline`）、delta 三项统一 degraded、
 * 不产业务码/级联码；业务码只在结构合法时出现（口径见 `validate.ts` 与 README）。
 */
export type BaselineReasonCode =
  | 'stage_bad_kind'
  | 'duplicate_gate_id'
  | 'stage_bad_after'
  | 'stage_unknown'
  | 'stage_no_gate'
  | 'gate_empty'
  | 'criterion_unregistered'
  | 'artifact_kinds_incomplete'
  | 'na_stages_mismatch'
  | 'engine_missing'
  | 'review_params_invalid'
  | 'core_not_effective'
  | 'invalid_baseline';

export interface GuaranteeDelta {
  readonly 1: GuaranteeStatus;
  readonly 2: GuaranteeStatus;
  readonly 3: GuaranteeStatus;
}

export interface MissingCriterionGroup {
  readonly guarantee: Guarantee;
  readonly criteria: readonly string[];
}

/** 跨泳道接口（lead m04499）：M1-4 直接消费这个形状。 */
export interface P15Result {
  readonly ok: boolean;
  readonly guarantee_delta: GuaranteeDelta;
  readonly reason_codes: readonly string[];
  /** 仅在有 degraded 时出现；core 条目用 `core:<code>` 前缀。 */
  readonly missing?: readonly MissingCriterionGroup[];
  /** 附加定位信息（M1-4 可忽略）：未注册的判据 id。 */
  readonly unregistered_criteria?: readonly string[];
}

export function isStageKind(value: unknown): value is KnownStageKind {
  return typeof value === 'string' && (STAGE_KINDS as readonly string[]).includes(value);
}

export function isStageKindList(value: unknown): value is readonly KnownStageKind[] {
  return Array.isArray(value) && value.length > 0 && value.every(isStageKind);
}
