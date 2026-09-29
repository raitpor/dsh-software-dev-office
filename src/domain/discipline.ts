/**
 * L3 阶段纪律（设计 §8.6 / T-M7-03）。
 *
 * 纯策略：给定（门禁等级、当前阶段、角色、工具、目标路径）→ allow / deny / ask。
 * **fail-open**：钩子自身出任何问题都必须放行——纪律守卫绝不能变成"插件坏了就干不了活"。
 * 只在 L3（`gateLevel: strict`）下才 deny；L1/L2 只观察不拦（建议/强制由门禁承担）。
 */
import { VIEW_KINDS } from '../types.js'

export type DisciplineDecision = { kind: 'allow' | 'deny' | 'ask'; reason: string }

export interface DisciplineInput {
  gateLevel: 'suggest' | 'enforce' | 'strict'
  phase: string
  /** 角色码（`cockpit` 表示驾驶舱主模型，不拦） */
  role: string
  tool: string
  /** 目标路径（写类工具尽量给；给不出就不按路径判） */
  paths?: string[]
  /** 项目是否已初始化 */
  initialized: boolean
}

const WRITE_TOOLS = new Set(['write', 'edit'])
const MUST_NOT_BEFORE_BASELINE = ['sdo_design']
const CODE_PHASES = new Set(['design-plan', 'construction', 'iteration'])

/**
 * 判定一次调用是否违反阶段纪律。
 * 规则（都可解释）：
 *   ① 未初始化就先 `sdo_init`；
 *   ② 基线（G2）之前不许写设计（`sdo_design`）；
 *   ③ 实现阶段之前不许写代码文件（src/ 等）；
 *   ④ 任意阶段都不许改 `.sdo/journal.jsonl`（真源只由 SDO 自己追加）。
 */
export function evaluateDiscipline(input: DisciplineInput): DisciplineDecision {
  const allow: DisciplineDecision = { kind: 'allow', reason: 'ok' }
  if (input.gateLevel !== 'strict') return allow
  if (input.role === 'cockpit' || input.role === '') return allow

  if (!input.initialized) {
    return input.tool === 'sdo_init' ? allow : { kind: 'deny', reason: '项目尚未初始化：先调用 `sdo_init`（L3 阶段纪律）' }
  }
  for (const path of input.paths ?? []) {
    if (path.includes('.sdo/journal.jsonl')) {
      return { kind: 'deny', reason: '`.sdo/journal.jsonl` 是真源，只能由 SDO 追加（L3 阶段纪律）' }
    }
  }
  if (input.phase === 'intake' || input.phase === 'feasibility' || input.phase === 'requirements' || input.phase === 'architecture') {
    if (MUST_NOT_BEFORE_BASELINE.includes(input.tool)) {
      return { kind: 'deny', reason: `阶段 ${input.phase} 不允许写设计：需求基线（G2）通过并完成计划评审后再落笔（L3 阶段纪律）` }
    }
  }
  if (!CODE_PHASES.has(input.phase) && WRITE_TOOLS.has(input.tool)) {
    const codePaths = (input.paths ?? []).filter((path) => path.startsWith('src/') || path.startsWith('test/'))
    if (codePaths.length > 0) {
      return { kind: 'deny', reason: `阶段 ${input.phase} 不允许写实现代码（${codePaths[0]}）：先把流程推进到开发阶段（L3 阶段纪律）` }
    }
  }
  for (const kind of VIEW_KINDS) {
    if (input.tool === 'sdo_design' && (input.paths ?? []).some((path) => path.includes(`design/${kind}`))) {
      return allow
    }
  }
  return allow
}

/** 钩子包装：任何异常都必须放行（fail-open）。 */
export function disciplineOrAllow(input: DisciplineInput, onError?: (error: unknown) => void): DisciplineDecision {
  try {
    return evaluateDiscipline(input)
  } catch (error) {
    onError?.(error)
    return { kind: 'allow', reason: 'discipline hook failed open' }
  }
}
