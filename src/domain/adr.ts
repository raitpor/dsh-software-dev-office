/**
 * 架构决策记录（ADR，设计 §6.3）。
 *
 * 纪律：ADR 必须含**备选方案与后果**——G3 的 `design.adr` 准则会拒绝"只写结论"的决策。
 * 一条 ADR 被取代时写 `supersededBy`，原记录不改（决策史不可篡改）。
 */
import { nextId } from '../infra/ids.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { Adr } from '../types.js'

export function listAdrIds(store: SdoStore): string[] {
  return store
    .listNames('decisions')
    .filter((name) => /^ADR-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

export function readAdr(store: SdoStore, id: string): Adr | undefined {
  return store.readYaml<{ adr: Adr }>('decisions', `${id}.yml`)?.adr
}

export function listAdrs(store: SdoStore): Adr[] {
  const out: Adr[] = []
  for (const id of listAdrIds(store)) {
    const adr = readAdr(store, id)
    if (adr !== undefined) out.push(adr)
  }
  return out
}

export function writeAdr(store: SdoStore, adr: Adr): void {
  store.writeYaml(['decisions', `${adr.id}.yml`], { adr })
}

export interface RecordAdrInput {
  title: string
  context: string
  decision: string
  alternatives: { option: string; pros: string; cons: string }[]
  consequences: string[]
  status?: Adr['status'] | undefined
}

/** 记录一条 ADR（`adr/recorded` 留痕）。 */
export function recordAdr(store: SdoStore, journal: Journal, input: RecordAdrInput): Adr {
  const adr: Adr = {
    id: nextId('ADR', listAdrIds(store)),
    title: input.title,
    status: input.status ?? 'accepted',
    context: input.context,
    decision: input.decision,
    alternatives: input.alternatives,
    consequences: input.consequences,
    at: new Date().toISOString(),
  }
  writeAdr(store, adr)
  journal.append('adr/recorded', { id: adr.id, title: adr.title, alternatives: adr.alternatives.length })
  return adr
}

/** 用新 ADR 取代旧 ADR（旧记录只加 `supersededBy`，不改内容）。 */
export function supersedeAdr(
  store: SdoStore,
  journal: Journal,
  input: RecordAdrInput & { supersedes: string },
): Adr {
  const previous = readAdr(store, input.supersedes)
  const adr = recordAdr(store, journal, { ...input, status: input.status ?? 'accepted' })
  if (previous !== undefined) {
    writeAdr(store, { ...previous, status: 'superseded', supersededBy: adr.id })
    journal.append('adr/recorded', { id: previous.id, supersededBy: adr.id })
  }
  return adr
}

/** G3 的 `design.adr` 准则：每条 ADR 必须有 ≥1 条备选与 ≥1 条后果。 */
export function adrCompleteness(store: SdoStore): { ok: boolean; total: number; incomplete: string[] } {
  const adrs = listAdrs(store)
  const incomplete = adrs
    .filter((adr) => adr.alternatives.length === 0 || adr.consequences.length === 0)
    .map((adr) => adr.id)
  return { ok: adrs.length > 0 && incomplete.length === 0, total: adrs.length, incomplete }
}
