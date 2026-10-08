/**
 * 架构决策记录（ADR，设计 §6.3）。
 *
 * 纪律：ADR 必须含**备选方案与后果**——G3 的 `design.adr` 准则会拒绝"只写结论"的决策。
 * 一条 ADR 被取代时写 `supersededBy`，原记录不改（决策史不可篡改）。
 */
import { nextId } from '../infra/ids.js'
import { pushShapeNote, recordListOf, textListOf, textOf, typeNameOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { Adr } from '../types.js'

export function listAdrIds(store: SdoStore): string[] {
  return store
    .listNames('decisions')
    .filter((name) => /^ADR-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

/**
 * 读一条 ADR 并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/decisions/ADR-*.yml` 是手可编辑真源，`alternatives`（记录列表）与 `consequences`
 * （列表）是 G3 的 `design.adr` 判据直接读的字段。旧实现 `adr.alternatives.length` 在标量写法下
 * 把字符串长度当条目数 —— **不崩但静默判错**；标量按单元素保留 + 提示，映射按空 + 提示。
 */
export function readAdrChecked(store: SdoStore, id: string): { adr: Adr | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ adr: unknown }>('decisions', `${id}.yml`)?.adr
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'adr', id, 'adr', { position: 'map', actualType: typeNameOf(raw), handling: 'empty', text: textOf(raw) })
    }
    return { adr: undefined, notes }
  }
  const record = raw as Record<string, unknown>
  const alternatives = recordListOf<Adr['alternatives'][number]>(record.alternatives, (text) => ({ option: text, pros: '', cons: '' }))
  pushShapeNote(notes, 'adr', id, 'alternatives', alternatives.issue)
  const consequences = textListOf(record.consequences)
  pushShapeNote(notes, 'adr', id, 'consequences', consequences.issue)
  const declaredId = textOf(record.id)
  const adr: Adr = {
    ...(record as unknown as Adr),
    id: declaredId.trim() === '' ? id : declaredId,
    title: textOf(record.title),
    status: textOf(record.status) as Adr['status'],
    context: textOf(record.context),
    decision: textOf(record.decision),
    alternatives: alternatives.value.map((item) => ({ option: textOf(item.option), pros: textOf(item.pros), cons: textOf(item.cons) })),
    consequences: consequences.value,
    at: textOf(record.at),
  }
  return { adr, notes }
}

export function readAdr(store: SdoStore, id: string): Adr | undefined {
  return readAdrChecked(store, id).adr
}

/** 全部 ADR 上的形状提示（回执 / 门禁详情共用）。 */
export function adrShapeNotes(store: SdoStore): FieldShapeNote[] {
  const notes: FieldShapeNote[] = []
  for (const id of listAdrIds(store)) notes.push(...readAdrChecked(store, id).notes)
  return notes
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
  /**
   * **调用方指定的编号**（可选）。
   *
   * **D-8（sdo-test-new 2026-10-08，major）**：`sdo_adr` 的 schema 一直声明着 `id`（`param.id`：
   * 「标识（如 REQ-001 / TASK-001 / Q-0001）」），但 `record` 分支**从不读它** ⇒ 传 `ADR-999`
   * 落库变成 `ADR-006`，调用方无法钉住编号，文档里按自己编号写的引用与台账**静默漂移**。
   * 现在：给了就用（存在性/格式/冲突由调用方先校验），没给才自动编号。
   */
  id?: string | undefined
}

/** 显式编号的合法形状（与自动编号同形；真源文件名直接用它，所以必须白名单化）。 */
export function isAdrId(value: string): boolean {
  return /^ADR-\d{3,}$/u.test(value)
}

/** 记录一条 ADR（`adr/recorded` 留痕）。 */
export function recordAdr(store: SdoStore, journal: Journal, input: RecordAdrInput): Adr {
  const adr: Adr = {
    id: input.id ?? nextId('ADR', listAdrIds(store)),
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
