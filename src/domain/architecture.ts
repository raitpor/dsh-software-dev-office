/**
 * 架构视图与设计元素（设计 §6.1 的五视图）。
 *
 * 存法：**一张视图一个文件**（`.sdo/design/<kind>.yml`），元素带 `DES-*` id。
 * 视图是"人读得懂、机器查得动"的中间形态：G3 的 `design.views` 查五视图齐备，
 * `trace.orphans` 查每个 DES 是否追溯到已基线需求。
 */
import { nextId } from '../infra/ids.js'
import { pushShapeNote, textListOf, textOf } from '../infra/scalar.js'
import type { FieldShapeNote, ShapeIssue } from '../infra/scalar.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import { VIEW_KINDS } from '../types.js'
import type { DesignElement, DesignView, ViewKind } from '../types.js'

/** 视图种类（从 types 再导出，方便本模块的使用者只 import 一处）。 */
export { VIEW_KINDS }

/** 五视图的中文名（展示与报告用）。 */
export const VIEW_LABEL: Record<ViewKind, string> = {
  context: '上下文视图',
  component: '组件视图',
  runtime: '运行时视图',
  data: '数据视图',
  deployment: '部署视图',
}

/** 角色的结构化取值（与 domain/plan.ts 的 `ROLES` 同集合；这里独立声明避免循环依赖）。 */
export type ElementRole = 'analyst' | 'red-team' | 'architect' | 'office' | 'developer' | 'tester' | 'reviewer' | 'delivery'

/** 元素类型 → 负责角色（拆分器的结构通道用；未知类型按 developer 处理）。 */
export const VIEW_KIND_OF_ELEMENT: Record<string, ElementRole> = {
  system: 'architect',
  service: 'developer',
  ui: 'developer',
  store: 'developer',
  queue: 'developer',
  job: 'developer',
  external: 'analyst',
  actor: 'analyst',
  document: 'analyst',
}

/** 设计元素 id 前缀（`DES-001`）。 */
export const ELEMENT_PREFIX = 'DES'

/**
 * 可选字符串列表：`undefined` 原样保留（确认戳指纹按 `?? []` 取值，不能凭空改成 `[]`）。
 *
 * 形状问题（标量 / 映射）由 F-21 的 `textListOf()` 产出 `ShapeIssue`，调用方收成提示。
 */
function optionalTextList(value: unknown): { value: string[] | undefined; issue: ShapeIssue | undefined } {
  if (value === undefined || value === null) return { value: undefined, issue: undefined }
  const read = textListOf(value)
  return { value: read.value, issue: read.issue }
}

/**
 * **视图的边界归一化**（F-20 同类；F-21 补齐提示）。
 *
 * 为什么：`.sdo/design/*.yml` 是给人手改的真源。`dependsOn: api`（少写一对 `[]`）会让
 * `describeDesign` 抛 `element.dependsOn.join is not a function`（实测，见
 * `.verify/probe-f20-containers.mjs`）——同一个"类型假设"家族，只是假设的对象从标量换成了列表。
 * 这里把「结构」收敛在读入处：列表字段一定是数组、标量字段一定是字符串；
 * 每个形状问题同时产出一条**面向用户**的提示（回执 / 只读视图 / 门禁详情三处可见）。
 */
function normalizeElement(
  raw: unknown,
  index: number,
  viewKind: ViewKind,
  notes: FieldShapeNote[],
): DesignElement {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    // 连元素都不是映射：保留成一条空元素（**不静默丢弃**，计数与门禁仍能看到它）
    pushShapeNote(notes, 'view', viewKind, `elements[${index}]`, {
      position: 'map',
      actualType: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
      handling: 'empty',
      text: textOf(raw),
    })
    return { id: '', name: textOf(raw), kind: '', responsibility: '', dependsOn: [] }
  }
  const record = raw as Record<string, unknown>
  const confidence = record.confidence
  const requires = optionalTextList(record.requires)
  pushShapeNote(notes, 'view', viewKind, `elements[${index}].requires`, requires.issue)
  const dependsOn = textListOf(record.dependsOn)
  pushShapeNote(notes, 'view', viewKind, `elements[${index}].dependsOn`, dependsOn.issue)
  return {
    id: textOf(record.id),
    name: textOf(record.name),
    kind: textOf(record.kind),
    responsibility: textOf(record.responsibility),
    dependsOn: dependsOn.value,
    ...(requires.value === undefined ? {} : { requires: requires.value }),
    ...(typeof confidence === 'string' ? { confidence: confidence as DesignElement['confidence'] } : {}),
  }
}

function normalizeView(raw: unknown, kind: ViewKind, notes: FieldShapeNote[]): DesignView | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    // 文件在、但主体不是映射：可读的失败（视图因此缺席，门禁会判红）—— 但要报出，不静默
    if (raw !== undefined) {
      pushShapeNote(notes, 'view', kind, 'view', {
        position: 'map',
        actualType: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
        handling: 'empty',
        text: textOf(raw),
      })
    }
    return undefined
  }
  const record = raw as unknown as Record<string, unknown>
  const declared = record.kind
  const rawElements = record.elements
  let elements: DesignElement[] = []
  if (Array.isArray(rawElements)) {
    elements = rawElements.map((item, index) => normalizeElement(item, index, kind, notes))
  } else {
    // 列表位置被写成标量 / 映射：口径见 `textListOf`（标量→单元素，映射→空）
    const read = textListOf(rawElements)
    pushShapeNote(notes, 'view', kind, 'elements', read.issue)
    if (read.issue?.handling === 'single') elements = [normalizeElement(rawElements, 0, kind, notes)]
  }
  return {
    // 文件名才是真源键：正文里的 kind 缺失/写坏时按文件名落地，不让它静默错位
    kind: typeof declared === 'string' && (VIEW_KINDS as readonly string[]).includes(declared) ? (declared as ViewKind) : kind,
    summary: textOf(record.summary),
    elements,
    updatedAt: textOf(record.updatedAt),
  }
}

/** 读一个视图 + 它的形状提示（F-21）。 */
export function readViewChecked(store: SdoStore, kind: ViewKind): { view: DesignView | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const view = normalizeView(store.readYaml<{ view: DesignView }>('design', `${kind}.yml`)?.view, kind, notes)
  return { view, notes }
}

export function readView(store: SdoStore, kind: ViewKind): DesignView | undefined {
  return readViewChecked(store, kind).view
}

/** 全部视图上的形状提示（回执 / 只读视图 / 门禁详情共用）。 */
export function viewShapeNotes(store: SdoStore): FieldShapeNote[] {
  const notes: FieldShapeNote[] = []
  for (const kind of VIEW_KINDS) notes.push(...readViewChecked(store, kind).notes)
  return notes
}

export function writeView(store: SdoStore, view: DesignView): void {
  store.writeYaml(['design', `${view.kind}.yml`], { view })
}

/** 已存在的视图（只返回真正有文件的）。 */
export function listViews(store: SdoStore): DesignView[] {
  const out: DesignView[] = []
  for (const kind of VIEW_KINDS) {
    const view = readView(store, kind)
    if (view !== undefined) out.push(view)
  }
  return out
}

/** 全部设计元素（跨视图，按 id 排序）。 */
export function listElements(store: SdoStore): DesignElement[] {
  const elements: DesignElement[] = []
  for (const view of listViews(store)) elements.push(...view.elements)
  return elements.sort((a, b) => a.id.localeCompare(b.id))
}

/** 全部已用元素 id（保证编号全局唯一）。 */
export function usedElementIds(store: SdoStore): string[] {
  return listElements(store).map((element) => element.id)
}

export interface UpsertElementInput {
  /** 视图；不传表示"在所有视图里找同名元素更新" */
  kind: ViewKind
  /** 元素 id；不传则新建 */
  id?: string | undefined
  name: string
  elementKind?: string | undefined
  responsibility?: string | undefined
  dependsOn?: string[] | undefined
  summary?: string | undefined
  /** 追溯到的需求 id（设计草稿按它标"来源需求"） */
  requires?: string[] | undefined
  /** 设计置信度（不填则由 requires 推导：有来源=high，无来源=low） */
  confidence?: 'high' | 'medium' | 'low' | undefined
}

/** 由"有没有需求来源"推导置信度：没来源的条目就是 agent 在推测，必须重看。 */
export function derivedConfidence(element: Pick<DesignElement, 'requires'>): 'high' | 'low' {
  return (element.requires ?? []).length > 0 ? 'high' : 'low'
}

/** 新增或更新一个设计元素（返回写入后的元素与视图）。 */
export function upsertElement(
  store: SdoStore,
  journal: Journal,
  input: UpsertElementInput,
): { element: DesignElement; view: DesignView; created: boolean } {
  const view: DesignView =
    readView(store, input.kind) ?? { kind: input.kind, summary: input.summary ?? '', elements: [], updatedAt: '' }

  const id = input.id ?? nextId(ELEMENT_PREFIX, usedElementIds(store))
  const index = view.elements.findIndex((element) => element.id === id)
  const previous = index >= 0 ? view.elements[index] : undefined
  const requires = input.requires ?? previous?.requires ?? []
  const element: DesignElement = {
    id,
    name: input.name,
    kind: input.elementKind ?? previous?.kind ?? 'service',
    responsibility: input.responsibility ?? previous?.responsibility ?? '',
    dependsOn: input.dependsOn ?? previous?.dependsOn ?? [],
    requires,
    confidence: input.confidence ?? derivedConfidence({ requires }),
  }
  const elements = index >= 0 ? view.elements.map((item) => (item.id === id ? element : item)) : [...view.elements, element]
  const next: DesignView = {
    ...view,
    summary: input.summary ?? view.summary,
    elements,
    updatedAt: new Date().toISOString(),
  }
  writeView(store, next)
  journal.append('design/updated', {
    view: input.kind,
    element: element.id,
    created: index < 0,
  })
  return { element, view: next, created: index < 0 }
}

/** 视图齐备性检查（G3 的 `design.views` 准则）。 */
export function viewsCompleteness(store: SdoStore): {
  ok: boolean
  present: ViewKind[]
  missing: ViewKind[]
  empty: ViewKind[]
} {
  const present: ViewKind[] = []
  const empty: ViewKind[] = []
  for (const kind of VIEW_KINDS) {
    const view = readView(store, kind)
    if (view === undefined) continue
    present.push(kind)
    if (view.elements.length === 0) empty.push(kind)
  }
  const missing = VIEW_KINDS.filter((kind) => !present.includes(kind))
  return { ok: missing.length === 0 && empty.length === 0, present, missing, empty }
}

/** 组件视图里的跨组件依赖边（用于契约完整性检查）。 */
export function componentEdges(store: SdoStore): { consumer: string; producer: string }[] {
  const component = readView(store, 'component')
  if (component === undefined) return []
  const edges: { consumer: string; producer: string }[] = []
  for (const element of component.elements) {
    for (const target of element.dependsOn) edges.push({ consumer: element.name, producer: target })
  }
  return edges
}

/** 按名字找元素（契约用名字而非 id 描述上下游时更易读）。 */
export function findElementByName(store: SdoStore, name: string): DesignElement | undefined {
  return listElements(store).find((element) => element.name === name || element.id === name)
}
