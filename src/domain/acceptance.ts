/**
 * **验收大纲**（`.sdo/testing/acceptance.yml`）：把验收准备**左移到需求基线**（REQ-046 / DES-031）。
 *
 * ## 要解决的问题
 *
 * V 模型的核心是"左边写下什么，右边就验什么"。如果验收依据等到交付期才倒推，那么**左边冻结时
 * 根本没写清该怎么验** —— 交付期只能凭印象列验收项，也就无法反过来说"这条 AC 没验"。
 * 因此：需求基线冻结（G2）时，**每条 must 需求的每条验收标准**都要对应一个
 * 「验收项 + 判定基准」，落 `.sdo/testing/acceptance.yml`；需求一变，整份大纲失效。
 *
 * ## 形状（与 `testingShapes.ts` 的校验口径**同源**，不另造一套）
 *
 * ```yaml
 * acceptance:
 *   baselineAt: 2026-10-13T…Z          # 生成时刻
 *   baselineBy: human                   # 谁冻的
 *   requirementFingerprint: sha256:…    # 生成时**需求真源**的内容指纹（过期判定的比较键）
 *   outline:
 *     - id: TA-001                      # 大纲条目编号（TA-）
 *       requirement: REQ-046            # 需求 id
 *       ac: AC-188                      # 验收标准 id（交付期验收矩阵的追溯键）
 *       item: 每条 must 需求的每条 AC 都有对应验收项与判定基准
 *       baseline: 读 acceptance.yml 逐条比对 AC 编号，缺任一即点名
 * ```
 *
 * ⚠️ **字段名与 `testingShapes.ts` 的 `TestingAcceptanceItem` 一一对应**（`item` = 验收项、
 * `baseline` = 判定基准）：跨模块改名字段名会让 G2 生成的产物**通不过测试域自己的形状校验**。
 *
 * ## 三条纪律
 *
 * ① **大纲只由需求真源生成**：`generateOutline` 是纯函数（同需求 ⇒ 同大纲 ⇒ 同指纹），
 *    因此"重新生成"是幂等的，不会每次冻结都产生一份新内容。
 * ② **过期判定的比较键是需求指纹**，不是时间、不是 journal 序号（与 `renderStale` 同一条口径：
 *    指纹绑内容，不绑历史）。
 * ③ **fail-closed 的分类结果**：`assessOutline` 返回**机器可判**的结论（`missing` / `stale` /
 *    `incomplete` / `ok`）与**逐条点名**（哪条 AC 缺、哪条需求变了），文案由调用方给。
 */
import { contentHash } from './hash.js'
import { SdoStore } from '../infra/store.js'
import { textOf } from '../infra/scalar.js'
import { formatId } from '../infra/ids.js'
import type { Requirement } from '../types.js'

/** 大纲真源在 `.sdo/` 根下的路径（与 `testingStore.TESTING_SOURCE_FILES.acceptance` 必须一致）。 */
export const ACCEPTANCE_PATH = ['testing', 'acceptance.yml'] as const
/** YAML 根键（`testingStore.rootKeyOf('acceptance')` 同值）。 */
export const ACCEPTANCE_ROOT_KEY = 'acceptance'
/** 大纲条目编号前缀。 */
export const ACCEPTANCE_ID_PREFIX = 'TA'

/** 大纲里的**一条**（= 一条 AC 一行）。 */
export interface AcceptanceOutlineEntry {
  id: string
  requirement: string
  ac: string
  /** 验收项：对这条 AC 要验什么。 */
  item: string
  /** 判定基准：写清用什么判定它对不对。 */
  baseline: string
}

/** 大纲真源。 */
export interface AcceptanceOutline {
  /** 生成时刻（ISO）。 */
  baselineAt: string
  /** 谁冻结的（签字人 / 驾驶舱 / human）。 */
  baselineBy: string
  /** 生成时**需求真源**的内容指纹：过期判定的唯一比较键。 */
  requirementFingerprint: string
  outline: AcceptanceOutlineEntry[]
}

/** 一条**应当**进大纲的 AC（从需求真源现算）。 */
export interface ExpectedOutlineEntry {
  requirement: string
  ac: string
  item: string
  baseline: string
}

/**
 * **需求真源的内容指纹**（过期判定的比较键）。
 *
 * 只取"大纲所依赖的那部分"：must 需求的 id + 版本 + 状态 + 每条 AC 的 (id, given, when, then)。
 * 故意**不含** `updatedAt` / `rationale` 这类与验收无关的字段 —— 把无关字段算进指纹，
 * 会让"改了一句理由"也把整份大纲判过期（假红，与 `hash.ts` 的"指纹绑内容"口径冲突）。
 */
export function requirementFingerprint(requirements: readonly Requirement[]): string {
  const musts = requirements
    .filter((requirement) => (requirement.priority ?? 'must') === 'must')
    // 排序：指纹必须与需求在盘上的顺序无关（`.sdo/requirements/*.yml` 按文件名列，顺序稳定但不要依赖它）
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((requirement) => ({
      id: requirement.id,
      version: requirement.version ?? '',
      status: requirement.status,
      acceptance: [...requirement.acceptance]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((ac) => ({ id: ac.id, given: ac.given, when: ac.when, then: ac.then })),
    }))
  return contentHash(musts)
}

/** 判定基准的兜底文案：AC 只写了 Given/When/Then 时，用它拼出"怎么判定"。 */
function defaultBaseline(requirementId: string, acId: string, then: string): string {
  const expected = then.trim() === '' ? '（该 AC 未写 Then）' : then.trim()
  return `按 ${requirementId}:${acId} 的 Then 判定：${expected}`
}

/**
 * 从需求真源**现算应当进大纲的全部条目**（每条 must 需求的每条 AC 一行）。
 *
 * 顺序稳定（需求按 id、AC 按 id）⇒ 同一真源永远产出同一份大纲（幂等）。
 */
export function expectedOutline(requirements: readonly Requirement[]): ExpectedOutlineEntry[] {
  const musts = requirements
    .filter((requirement) => (requirement.priority ?? 'must') === 'must')
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
  const entries: ExpectedOutlineEntry[] = []
  for (const requirement of musts) {
    for (const ac of [...requirement.acceptance].sort((a, b) => a.id.localeCompare(b.id))) {
      entries.push({
        requirement: requirement.id,
        ac: ac.id,
        // 验收项：这条 AC 要验什么（缺 Then 时如实说明，而不是留空 —— 空项会被形状校验点名）
        item: ac.then.trim() === '' ? `${requirement.title || requirement.id}：${ac.given || ac.when || ac.id}` : ac.then,
        baseline: defaultBaseline(requirement.id, ac.id, ac.then),
      })
    }
  }
  return entries
}

/**
 * 生成大纲（**纯函数**：不读盘、不写盘、不含时钟 —— 时间由调用方给，便于幂等与单测）。
 *
 * `generatedAt` / `generatedBy` 由调用方传入：把时间塞进函数内部会让"同真源两次生成"
 * 因毫秒差异而字节不同，破坏"重新生成是幂等的"这条性质。
 */
export function generateOutline(input: {
  requirements: readonly Requirement[]
  generatedAt: string
  generatedBy: string
}): AcceptanceOutline {
  const expected = expectedOutline(input.requirements)
  return {
    baselineAt: input.generatedAt,
    baselineBy: input.generatedBy,
    requirementFingerprint: requirementFingerprint(input.requirements),
    outline: expected.map((entry, index) => ({
      // 编号按"本次生成的顺序"分配：需求与 AC 都已排序 ⇒ 编号稳定
      id: formatId(ACCEPTANCE_ID_PREFIX, index + 1),
      requirement: entry.requirement,
      ac: entry.ac,
      item: entry.item,
      baseline: entry.baseline,
    })),
  }
}

// —————————————————————— 读 / 写 ——————————————————————

/** 读大纲：不存在返回 `undefined`；读不动（YAML 坏）**抛错**由调用方兜（与 `store.readYaml` 同口径）。 */
export function readOutline(store: SdoStore): AcceptanceOutline | undefined {
  if (!store.exists(...ACCEPTANCE_PATH)) return undefined
  const raw = store.readYaml<Record<string, unknown>>(...ACCEPTANCE_PATH)
  const body = raw?.[ACCEPTANCE_ROOT_KEY]
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const outline = Array.isArray(record.outline) ? record.outline : []
  return {
    baselineAt: textOf(record.baselineAt),
    baselineBy: textOf(record.baselineBy),
    requirementFingerprint: textOf(record.requirementFingerprint),
    outline: outline
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        id: textOf(item.id),
        requirement: textOf(item.requirement),
        ac: textOf(item.ac),
        item: textOf(item.item),
        baseline: textOf(item.baseline),
      })),
  }
}

/** 写大纲（覆盖式；`store` 是 `.sdo/` 根的沙箱，路径天然落在台账内）。 */
export function writeOutline(store: SdoStore, outline: AcceptanceOutline): string {
  return store.writeYaml([...ACCEPTANCE_PATH], { [ACCEPTANCE_ROOT_KEY]: outline })
}

// —————————————————————— 过期判定 ——————————————————————

export type OutlineVerdict = 'ok' | 'missing' | 'stale' | 'incomplete'

/** `assessOutline` 的结论：机器可判的 `verdict` + **逐条点名**。 */
export interface OutlineAssessment {
  verdict: OutlineVerdict
  /** 应当进大纲的条目总数（现算）。 */
  expectedCount: number
  /** 大纲里实际有的条目数。 */
  actualCount: number
  /** 缺的条目（`REQ:AC` 形态，逐条点名）。 */
  missing: string[]
  /** 多的条目（大纲里有、现算没有 —— 需求删了 AC 之后残留）。 */
  extra: string[]
  /** 判定基准为空的条目（有行但没写"怎么判定"，等于没写）。 */
  withoutBaseline: string[]
  /** 算过期时的比较值。 */
  recordedFingerprint: string
  currentFingerprint: string
  /** 人读的一句话结论（回执直接用；**不含** C-xx 编号）。 */
  detail: string
}

/**
 * 评估大纲与当前需求真源是否一致（**只读**：不写盘、不改台账）。
 *
 * 四种结论（都点名到具体 AC，便于回执直接引用）：
 *   · `missing`    —— 盘上没有 `.sdo/testing/acceptance.yml`；
 *   · `stale`      —— 需求真源指纹与生成时不一致（**需求变更 ⇒ 整份大纲失效**）；
 *   · `incomplete` —— 指纹一致但有缺项/空判定基准（手改删行、或 AC 的 Then 是空的）；
 *   · `ok`         —— 指纹一致且逐条齐备。
 */
export function assessOutline(store: SdoStore, requirements: readonly Requirement[]): OutlineAssessment {
  const current = requirementFingerprint(requirements)
  const expected = expectedOutline(requirements)
  const expectedKeys = expected.map((entry) => `${entry.requirement}:${entry.ac}`)
  const outline = readOutline(store)
  if (outline === undefined) {
    return {
      verdict: 'missing',
      expectedCount: expectedKeys.length,
      actualCount: 0,
      missing: expectedKeys,
      extra: [],
      withoutBaseline: [],
      recordedFingerprint: '',
      currentFingerprint: current,
      detail: `验收大纲不存在：需求基线冻结时须按 ${expectedKeys.length} 条 AC 生成 .sdo/testing/acceptance.yml`,
    }
  }
  const actualKeys = outline.outline.map((entry) => `${entry.requirement}:${entry.ac}`)
  const actualSet = new Set(actualKeys)
  const expectedSet = new Set(expectedKeys)
  const missing = expectedKeys.filter((key) => !actualSet.has(key))
  const extra = actualKeys.filter((key) => !expectedSet.has(key))
  const withoutBaseline = outline.outline
    .filter((entry) => textOf(entry.baseline).trim() === '')
    .map((entry) => `${entry.requirement}:${entry.ac}`)

  if (outline.requirementFingerprint !== current) {
    return {
      verdict: 'stale',
      expectedCount: expectedKeys.length,
      actualCount: actualKeys.length,
      missing,
      extra,
      withoutBaseline,
      recordedFingerprint: outline.requirementFingerprint,
      currentFingerprint: current,
      detail:
        `验收大纲与当前需求基线不一致（生成时 ${short(outline.requirementFingerprint)}，现在 ${short(current)}）：`
        + '需求基线一变，整份大纲即失效，须重新生成并随 G2 一并重签'
        + (missing.length === 0 ? '' : `；新缺 ${missing.length} 条：${missing.slice(0, 8).join(' ')}`),
    }
  }
  if (missing.length > 0 || withoutBaseline.length > 0) {
    return {
      verdict: 'incomplete',
      expectedCount: expectedKeys.length,
      actualCount: actualKeys.length,
      missing,
      extra,
      withoutBaseline,
      recordedFingerprint: outline.requirementFingerprint,
      currentFingerprint: current,
      detail:
        '验收大纲不齐备：'
        + [
          missing.length === 0 ? '' : `缺 ${missing.length} 条（${missing.slice(0, 8).join(' ')}）`,
          withoutBaseline.length === 0 ? '' : `${withoutBaseline.length} 条没写判定基准（${withoutBaseline.slice(0, 8).join(' ')}）`,
        ]
          .filter((item) => item !== '')
          .join('；'),
    }
  }
  return {
    verdict: 'ok',
    expectedCount: expectedKeys.length,
    actualCount: actualKeys.length,
    missing: [],
    extra,
    withoutBaseline: [],
    recordedFingerprint: outline.requirementFingerprint,
    currentFingerprint: current,
    detail: `验收大纲齐备：${actualKeys.length} 条（每条 must 需求的每条 AC 一行），与当前需求基线一致`,
  }
}

/**
 * **已存在才刷新**（需求真源变更后调用）：大纲已经生成过 ⇒ 让它跟上当前真源；没生成过 ⇒ 什么都不做。
 *
 * 为什么需要它（TASK-013 实测逼出来的）：大纲是**派生**产物 —— 它必须跟着需求真源走。
 * 只在"判定 G2"时刷新会漏掉一类真实路径：用户改了需求（`capture`/`update`/`change`）之后，
 * 看板/注入块走的是 `status().pendingGate`、阶段出口走的是 `advance()` —— 这两条都**不经过**
 * `baseline()`/`checkGate()`，于是大纲停在旧指纹上，C10 一直红**而且没有修复路径**
 * （用户改了需求、也补了 AC，却还是被拦）。实测两条既有用例正是这样红的。
 *
 * 而"没生成过就不生成"这条边界同样重要：**基线没冻结时不该凭空产生验收大纲**
 * （它是"冻结那一刻"的约定），否则每个还没走到 G2 的项目都会多出一份 `acceptance.yml`。
 *
 * 幂等：已是当前真源的产物 ⇒ 不写盘。
 */
export function refreshOutlineIfPresent(input: {
  store: SdoStore
  requirements: readonly Requirement[]
  generatedAt: string
  generatedBy: string
}): { refreshed: boolean } {
  if (!input.store.exists(...ACCEPTANCE_PATH)) return { refreshed: false }
  const before = assessOutline(input.store, input.requirements)
  if (before.verdict === 'ok') return { refreshed: false }
  writeOutline(input.store, generateOutline(input))
  return { refreshed: true }
}

/** 指纹的短显示（回执里人眼比对用；去掉算法前缀取前 8 位）。 */
function short(fingerprint: string): string {
  const hex = fingerprint.startsWith('sha256:') ? fingerprint.slice('sha256:'.length) : fingerprint
  return hex.slice(0, 8)
}

/**
 * 把判定结论翻成**用户可见的一句话**（门禁判据的 `detail`）。
 *
 * 为什么放在本模块而不是 `gates.ts`：那个文件被 i18n 棘轮钉在「零硬编码中文」
 * （`test/m7.test.ts` 基线 `src/domain/gates.ts: 0`），而语言包不在本卡写范围 ——
 * 让"用户可见的中文"集中在本模块产出，既不打破棘轮，也不在判据里塞英文占位。
 * 迁到 `uiGates.*` 语言键属后续卡（那时本函数退化成一次 `fmt` 调用）。
 */
export function describeOutlineVerdict(assessment: OutlineAssessment): string {
  switch (assessment.verdict) {
    case 'ok':
      return assessment.detail
    case 'missing':
      return `${assessment.detail}（当前 must 需求共 ${assessment.expectedCount} 条 AC）`
    case 'stale':
      return assessment.detail
    case 'incomplete':
      return assessment.detail
    default:
      // 穷尽性守卫：新增 verdict 却忘了给文案时，回执不能说"没问题"
      return `验收大纲判定为未覆盖的状态（${String(assessment.verdict)}）：${assessment.detail}`
  }
}

/** 判红的**补救办法**（门禁回执的 `remedy`；可执行、点名入口）。 */
export function outlineRemedy(): string {
  return (
    '在需求基线冻结（G2）时按当前需求真源重新生成验收大纲：'
    + '`sdo_requirement` 复核 must 需求与其 AC → 重新生成 `.sdo/testing/acceptance.yml`（每条 must 需求的每条 AC 一行，'
    + '含验收项与判定基准）→ 重跑 `sdo_gate action=check gate=G2`；'
    + '需求变更（`sdo_requirement action=change`）之后整份大纲失效，必须重新生成并随 G2 一并重签'
  )
}

/**
 * **便捷入口**：需要时生成、需要时重生成；已是最新就**不写盘**（幂等）。
 *
 * 返回 `{ generated }` 表示这次到底写没写 —— 幂等是"重新生成"能被反复调用的前提：
 * 每次冻结都重写一遍会让"大纲有没有被人手改过"无从判断，也会产生无意义的事件噪声。
 */
export function ensureOutline(input: {
  store: SdoStore
  requirements: readonly Requirement[]
  generatedAt: string
  generatedBy: string
}): { generated: boolean; outline: AcceptanceOutline; assessment: OutlineAssessment } {
  const before = assessOutline(input.store, input.requirements)
  if (before.verdict === 'ok') {
    // 已经是当前真源的产物：不写盘（幂等），把现盘那份读出来返回
    const existing = readOutline(input.store)
    return {
      generated: false,
      outline: existing ?? generateOutline(input),
      assessment: before,
    }
  }
  const outline = generateOutline(input)
  writeOutline(input.store, outline)
  return { generated: true, outline, assessment: assessOutline(input.store, input.requirements) }
}
