/**
 * 风险登记（`.sdo/risks/RISK-*.yml`，设计 §9.1 的 `sdo_risk` / §6 的风险登记）。
 *
 * 用途：
 *   · 可行性评估（G1）要"风险已登记"；
 *   · 红队议题要求"回到需求或转为风险"（§5.4）——转风险就是写在这里；
 *   · 螺旋流程的每圈风险评审门（GR）读这里。
 */
import { nextId } from '../infra/ids.js'
import { textOf } from '../infra/scalar.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { RiskItem } from '../types.js'

/** 风险结论（螺旋流程每圈一条；`continue` 继续 / `adjust` 调整 / `stop` 终止）。 */
export interface RiskConclusion {
  at: string
  conclusion: 'continue' | 'adjust' | 'stop'
  rationale: string
  by: string
}

export const CONCLUSION_FILE = 'conclusion.yml'

export function listRiskIds(store: SdoStore): string[] {
  return store
    .listNames('risks')
    .filter((name) => /^RISK-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

export function readRisk(store: SdoStore, id: string): RiskItem | undefined {
  return store.readYaml<{ risk: RiskItem }>('risks', `${id}.yml`)?.risk
}

export function listRisks(store: SdoStore): RiskItem[] {
  const out: RiskItem[] = []
  for (const id of listRiskIds(store)) {
    const risk = readRisk(store, id)
    if (risk !== undefined) out.push(risk)
  }
  return out
}

export function writeRisk(store: SdoStore, risk: RiskItem): void {
  store.writeYaml(['risks', `${risk.id}.yml`], { risk })
}

export interface LogRiskInput {
  title: string
  level: RiskItem['level']
  probability: RiskItem['probability']
  impact: string
  mitigation: string
  owner: string
  origin?: string | undefined
}

/** 登记一条风险（`risk/logged` 留痕）。 */
export function logRisk(store: SdoStore, journal: Journal, input: LogRiskInput): RiskItem {
  const risk: RiskItem = {
    id: nextId('RISK', listRiskIds(store)),
    title: input.title,
    level: input.level,
    probability: input.probability,
    impact: input.impact,
    mitigation: input.mitigation,
    owner: input.owner,
    status: 'open',
    at: new Date().toISOString(),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  }
  writeRisk(store, risk)
  journal.append('risk/logged', { id: risk.id, level: risk.level, title: risk.title })
  return risk
}

/** 更新风险（状态/应对/责任人），`risk/updated` 留痕。 */
export function updateRisk(
  store: SdoStore,
  journal: Journal,
  id: string,
  patch: Partial<Pick<RiskItem, 'status' | 'mitigation' | 'owner' | 'level' | 'impact'>>,
): RiskItem | undefined {
  const current = readRisk(store, id)
  if (current === undefined) return undefined
  const next: RiskItem = { ...current, ...patch }
  writeRisk(store, next)
  journal.append('risk/updated', { id, status: next.status })
  return next
}

export function readConclusion(store: SdoStore): RiskConclusion | undefined {
  return store.readYaml<{ conclusion: RiskConclusion }>('risks', CONCLUSION_FILE)?.conclusion
}

/** 写本圈风险结论（螺旋流程 GR 门禁的输入）。 */
export function writeConclusion(store: SdoStore, journal: Journal, conclusion: RiskConclusion): void {
  store.writeYaml(['risks', CONCLUSION_FILE], { conclusion })
  journal.append('risk/updated', { conclusion: conclusion.conclusion, rationale: conclusion.rationale })
}

/** 统计（供状态块/看板与门禁使用）。 */
export function riskStats(risks: RiskItem[]): {
  total: number
  open: number
  blockers: number
  high: number
  unmitigated: RiskItem[]
} {
  const unmitigated = risks.filter(
    (risk) =>
      (risk.level === 'high' || risk.level === 'blocker') &&
      risk.status === 'open' &&
      (textOf(risk.mitigation).trim() === '' || textOf(risk.owner).trim() === ''),
  )
  return {
    total: risks.length,
    open: risks.filter((risk) => risk.status === 'open').length,
    // **G-05**：与同一行的「未关闭」口径对齐 —— 旧实现按**等级**统计（含已关闭），
    // 同一行混两种口径，读者会把「阻塞 1」理解成"有 1 条阻塞未解决"（实测已致误报）。
    blockers: risks.filter((risk) => risk.level === 'blocker' && risk.status === 'open').length,
    high: risks.filter((risk) => risk.level === 'high' && risk.status === 'open').length,
    unmitigated,
  }
}
