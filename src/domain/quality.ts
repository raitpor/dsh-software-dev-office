/**
 * 质量属性场景与 ATAM-lite（设计 §6.2）。
 *
 * 纪律：
 *   · 每条场景必须**可测**（度量写清"指标 + 条件 + 阈值"），否则它只是一句愿望；
 *   · ATAM-lite 的产出是**风险点 / 敏感点 / 权衡点**三张清单——它们会挂到 ADR 与风险登记上，
 *     而不是写一段"评估通过"的空话。
 */
import { nextId } from '../infra/ids.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { QualityAssessment, QualityScenario } from '../types.js'

export const ASSESSMENT_FILE = 'atam.yml'

export function listScenarioIds(store: SdoStore): string[] {
  return store
    .listNames('quality')
    .filter((name) => /^QS-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

export function readScenario(store: SdoStore, id: string): QualityScenario | undefined {
  return store.readYaml<{ scenario: QualityScenario }>('quality', `${id}.yml`)?.scenario
}

export function listScenarios(store: SdoStore): QualityScenario[] {
  const out: QualityScenario[] = []
  for (const id of listScenarioIds(store)) {
    const scenario = readScenario(store, id)
    if (scenario !== undefined) out.push(scenario)
  }
  return out
}

export function writeScenario(store: SdoStore, scenario: QualityScenario): void {
  store.writeYaml(['quality', `${scenario.id}.yml`], { scenario })
}

export interface RecordScenarioInput {
  attribute: string
  stimulus: string
  response: string
  measure: string
  priority?: QualityScenario['priority'] | undefined
  targets?: string[] | undefined
}

/** 记录一条质量场景。 */
export function recordScenario(store: SdoStore, journal: Journal, input: RecordScenarioInput): QualityScenario {
  const scenario: QualityScenario = {
    id: nextId('QS', listScenarioIds(store)),
    attribute: input.attribute,
    stimulus: input.stimulus,
    response: input.response,
    measure: input.measure,
    priority: input.priority ?? 'medium',
    targets: input.targets ?? [],
    at: new Date().toISOString(),
  }
  writeScenario(store, scenario)
  journal.append('quality/recorded', { id: scenario.id, attribute: scenario.attribute })
  return scenario
}

export function readAssessment(store: SdoStore): QualityAssessment | undefined {
  return store.readYaml<{ assessment: QualityAssessment }>('quality', ASSESSMENT_FILE)?.assessment
}

/** 写 ATAM-lite 评估（风险/敏感/权衡三张清单）。 */
export function writeAssessment(
  store: SdoStore,
  journal: Journal,
  input: { risks: string[]; sensitivities: string[]; tradeoffs: string[]; by: string },
): QualityAssessment {
  const assessment: QualityAssessment = {
    at: new Date().toISOString(),
    by: input.by,
    risks: input.risks,
    sensitivities: input.sensitivities,
    tradeoffs: input.tradeoffs,
  }
  store.writeYaml(['quality', ASSESSMENT_FILE], { assessment })
  journal.append('quality/recorded', { atam: true, risks: input.risks.length })
  return assessment
}

/** 场景是否可测：度量里必须出现数值或明确的阈值符号。 */
export function isMeasurable(scenario: QualityScenario): boolean {
  return /\d/u.test(scenario.measure) || /[≥≤<>]=?/u.test(scenario.measure)
}

/** 不可测的场景 id（用于提示与门禁）。 */
export function unmeasurableScenarios(store: SdoStore): string[] {
  return listScenarios(store)
    .filter((scenario) => !isMeasurable(scenario))
    .map((scenario) => scenario.id)
}
