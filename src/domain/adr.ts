/**
 * 架构决策记录（ADR，设计 §6.3）。
 *
 * 纪律：ADR 必须含**备选方案与后果**——G3 的 `design.adr` 准则会拒绝"只写结论"的决策。
 * 一条 ADR 被取代时写 `supersededBy`，原记录不改（决策史不可篡改）。
 */
import { nextId } from '../infra/ids.js'
import { pushShapeNote, recordListOf, textOf, typeNameOf } from '../infra/scalar.js'
import type { ContainerRead } from '../infra/scalar.js'
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
  // **D-17**：与 `alternatives` 同口径，但**两种元素形态都合法**：
  //   · 字符串元素（手写 YAML 的常见写法：`- 成本上升`）；
  //   · 映射元素（`{item, mitigation}`，写入端归一后的形状）。
  // 用 `recordListOf` 会把手写字符串列表判成"形状不清 ⇒ 空列表"（它的口径是"只有映射才算数"）
  // ⇒ 那正是本缺陷的另一半：**手写正确的东西被读成 0 条**。所以数组在这里自己逐项归一。
  const rawConsequences = record.consequences
  const consequences: ContainerRead<Adr['consequences'][number]> = Array.isArray(rawConsequences)
    ? {
        value: rawConsequences.map((row) =>
          typeof row === 'string'
            ? { item: row }
            : row !== null && typeof row === 'object' && !Array.isArray(row)
              ? {
                  item: textOf((row as { item?: unknown }).item),
                  ...(textOf((row as { mitigation?: unknown }).mitigation) === ''
                    ? {}
                    : { mitigation: textOf((row as { mitigation?: unknown }).mitigation) }),
                }
              : { item: '' },
        ),
        issue: undefined,
      }
    : recordListOf<Adr['consequences'][number]>(rawConsequences, (text) => ({ item: text }))
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
  /**
   * **D-17**：写入端接受两种形态并**归一**成一种（字符串 ⇒ `{item}`；映射 ⇒ 保留 `mitigation`）。
   * 归一后的结果同时用于落盘、回执与留痕 —— 旧实现把**入参**直接拼进返回对象，回执的
   * 「后果 N 项」量的是调用方给了几项，而**读回来能不能看见**它从不核对。
   */
  consequences: (string | { item: string; mitigation?: string | undefined })[]
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
  // **D-17**：写入端**归一**成落盘形状（字符串 ⇒ `{item}`；映射 ⇒ 保留 `mitigation`）。
  // 归一结果同时用于落盘、返回值与留痕 —— 三处同源，回执里的条数就是"读回来能看见的条数"。
  const consequences: Adr['consequences'] = input.consequences.map((row) =>
    typeof row === 'string'
      ? { item: row }
      : { item: textOf(row.item), ...(textOf(row.mitigation) === '' ? {} : { mitigation: textOf(row.mitigation) }) },
  )
  const adr: Adr = {
    id: input.id ?? nextId('ADR', listAdrIds(store)),
    title: input.title,
    status: input.status ?? 'accepted',
    context: input.context,
    decision: input.decision,
    alternatives: input.alternatives,
    consequences,
    at: new Date().toISOString(),
  }
  writeAdr(store, adr)
  journal.append('adr/recorded', {
    id: adr.id,
    title: adr.title,
    alternatives: adr.alternatives.length,
    // **D-17**：后果条数过去**根本不记** ⇒ 回执的「后果 N 项」无从被证伪；现在与落盘同源
    consequences: adr.consequences.length,
  })
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
export function adrCompleteness(store: SdoStore): {
  ok: boolean
  total: number
  incomplete: string[]
  /** **D-18**：已被取代（`superseded`）的条数 —— 它们**不参与**判据，但要在回执里如实出现 */
  superseded: number
} {
  const adrs = listAdrs(store)
  // **D-18（sdo-test-new 2026-10-09）**：作废（`superseded`）的记录**退出判据**。
  // 旧行为是"保留了历史，却继续拿作废的历史判你红" ⇒ 一条形状写坏的 ADR 在工具面上**无路可走**
  // （同 id 重记被守卫正确拒绝、`supersede` 之后旧记录仍计入判据）⇒ waterfall/prototype 的 G3 永久红。
  const counted = adrs.filter((adr) => adr.status !== 'superseded')
  const incomplete = counted
    .filter((adr) => adr.alternatives.length === 0 || adr.consequences.length === 0)
    .map((adr) => adr.id)
  return {
    ok: counted.length > 0 && incomplete.length === 0,
    total: counted.length,
    incomplete,
    superseded: adrs.length - counted.length,
  }
}
