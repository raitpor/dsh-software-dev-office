/**
 * 架构视图与设计元素（设计 §6.1 的五视图）。
 *
 * 存法：**一张视图一个文件**（`.sdo/design/<kind>.yml`），元素带 `DES-*` id。
 * 视图是"人读得懂、机器查得动"的中间形态：G3 的 `design.views` 查五视图齐备，
 * `trace.orphans` 查每个 DES 是否追溯到已基线需求。
 */
import { nextId } from '../infra/ids.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import { VIEW_KINDS } from '../types.js'
import type { DesignElement, DesignView, ViewKind } from '../types.js'

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

export function readView(store: SdoStore, kind: ViewKind): DesignView | undefined {
  return store.readYaml<{ view: DesignView }>('design', `${kind}.yml`)?.view
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
  const element: DesignElement = {
    id,
    name: input.name,
    kind: input.elementKind ?? previous?.kind ?? 'service',
    responsibility: input.responsibility ?? previous?.responsibility ?? '',
    dependsOn: input.dependsOn ?? previous?.dependsOn ?? [],
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
