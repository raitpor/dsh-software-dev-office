/**
 * L3 阶段纪律（设计 §8.6 / T-M7-03）。
 *
 * 纯策略：给定（门禁等级、当前阶段、角色、工具、目标路径）→ allow / deny / ask。
 * **fail-open**：钩子自身出任何问题都必须放行——纪律守卫绝不能变成"插件坏了就干不了活"。
 * 只在 L3（`gateLevel: strict`）下才 deny；L1/L2 只观察不拦（建议/强制由门禁承担）。
 */
import { VIEW_KINDS } from '../types.js'
import { normalizeWorkspacePath } from './writeScope.js'

export type DisciplineDecision = { kind: 'allow' | 'deny' | 'ask'; reason: string }

export interface DisciplineInput {
  gateLevel: 'suggest' | 'enforce' | 'strict'
  phase: string
  /** 角色码（`cockpit` 表示驾驶舱主模型，不拦） */
  role: string
  tool: string
  /** 目标路径（写类工具尽量给；给不出就不按路径判）。**宿主的 `file_path` 是绝对路径**（真机形态） */
  paths?: string[]
  /** 工作区根：宿主传绝对路径时先按它归一（与写范围纪律同一个 `normalizeWorkspacePath`） */
  root?: string
  /**
   * **项目声明**的实现代码面（`.sdo/config.yml` 的 `discipline.codePaths`）；缺省 = `DEFAULT_CODE_PATHS`。
   * 声明了就用声明的（替换默认值）—— 这就是 `AC-241` 要的"项目声明 + 格式无关的通用比较"。
   */
  codePaths?: readonly string[]
  /** 项目是否已初始化 */
  initialized: boolean
}

/**
 * **默认实现代码面**（只是默认值，**可被项目声明覆盖**；用默认值时回执会**明说**，不许静默 —— `DEF-104`）。
 */
export const DEFAULT_CODE_PATHS: readonly string[] = ['src/', 'test/']

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
  // **`DEF-104`（第十二批 §3.3）**：宿主的 `file_path` 是**绝对路径** ⇒ 先按工作区根归一，再比对。
  const paths = (input.paths ?? []).map((path) => normalizeWorkspacePath(path, input.root))
  for (const path of paths) {
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
    // **项目声明优先**：`discipline.codePaths` 声明了就用它；没声明才用默认面（并在回执里**明说**）
    const declared = (input.codePaths ?? []).filter((prefix) => prefix.trim() !== '')
    const prefixes = declared.length > 0 ? declared : DEFAULT_CODE_PATHS
    const codePaths = paths.filter((path) => prefixes.some((prefix) => {
      const clean = prefix.trim().replace(/^\/+|\/+$/gu, '')
      return clean !== '' && (path === clean || path.startsWith(`${clean}/`))
    }))
    if (codePaths.length > 0) {
      const usingDefaults = declared.length === 0
        ? `（用了**默认**实现代码面 \`${DEFAULT_CODE_PATHS.join('\` + \`')}\`；在 \`.sdo/config.yml\` 的 \`discipline.codePaths\` 里声明项目自己的布局可覆盖）`
        : ''
      return { kind: 'deny', reason: `阶段 ${input.phase} 不允许写实现代码（${codePaths[0]}）：先把流程推进到开发阶段（L3 阶段纪律）${usingDefaults}` }
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
