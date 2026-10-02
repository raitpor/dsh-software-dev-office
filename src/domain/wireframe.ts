/**
 * 界面线框图（ASCII）与 PlantUML 骨架 —— 从 `ui` 视图**机械推导**，不含任何"脑补"内容。
 *
 * 纪律（这是本模块存在的唯一理由）：
 *   ① **只画台账里有的东西**：栏目来自 `screens[].columns`（顺序原样），区域来自
 *      `screens[].layout.regions`（顺序原样）；台账里没有的栏目**一个都不许出现**。
 *   ② **逐项对应**：栏目分配到哪个区域由 `regionBuckets()` 机械算出，区域名一定取自
 *      `layout.regions`（为空时用调用方给的占位符），不是这里编出来的。
 *   ③ **空就是空**：没有栏目 → 线框里不画栏目，由调用方给出可读提示；没有页面 →
 *      返回空数组（不造"示例页面"）。
 *   ④ 本模块**不写盘**、不读盘、不碰台账 —— 它只是排版函数（渲染 `docs/DESIGN.md` 与
 *      写 `.puml` 文件都是调用方的事）。
 *
 * 视觉宽度：中日韩字符在等宽终端里占 **2** 列，按 `.length` 算会让方框歪掉，
 * 因此这里统一用 {@link visualWidth} / {@link padVisual} 排版。
 *
 * 用户可见文案一律由调用方（语言包）传入 —— 本模块里没有中文/英文字面量。
 */
import type { UiScreen, UiStackDirection, UiView } from '../types.js'

/** 调用方（语言包）提供的、本模块排版时需要的文案。 */
/** 区域归属的来源：`declared`（栏目显式声明）/ `exact`（唯一解）/ `guessed`（按数量均分，可能错位）。 */
export type WireframeAssignment = 'declared' | 'exact' | 'guessed'

export interface WireframeStrings {
  /** 页面没有任何栏目时的可读提示（必须存在于线框里，不能留白让人猜） */
  emptyColumns: string
  /** 页面没有声明任何布局区域时的区域占位符 */
  noRegions: string
  /** `.puml` 里的"本页栏目"注记前缀 */
  screenNote: string
  /** `.puml` 里的"响应式断点"注记前缀 */
  breakpoints: string
  /** `.puml` 里的"尚无界面视图"提示 */
  noScreens: string
  /** **F-2**：区域归属是"按数量均分"的猜测时的图旁注记（必须说明这是猜测与如何消除） */
  assignmentGuessed: string
  /** **F-2**：栏目声明了本屏不存在的区域名时的图旁注记（点名栏目 / 声明值 / 本屏可用区域） */
  regionUnknown: (column: string, declared: string, regions: string) => string
  /**
   * 区域堆叠方向的**来源注记**（F-15）：传 `undefined` 表示台账没声明（按缺省纵向渲染）。
   * 文案由调用方从语言包取（本模块不含任何中英文字面量）。
   */
  stackNote: (stack: UiStackDirection | undefined) => string
}

/** 页面名字里出现这些字符时不能直接当 PlantUML 标识符（对 CJK 同样安全）。 */
const IDENT_UNSAFE = /[^0-9A-Za-z_]/gu

/** 中日韩/全角字符占两列的宽度（等宽终端口径）。 */
export function visualWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // 覆盖 CJK 统一表意文字及扩展 A、CJK 标点、全角形式、谚文 —— 这些在等宽字体里都是双宽
    const wide =
      (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x20000 && code <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

/** 按**视觉宽度**截断（超出后以省略号收尾，保证方框不歪）。 */
export function clipVisual(text: string, limit: number): string {
  if (visualWidth(text) <= limit) return text
  let width = 0
  let out = ''
  for (const ch of text) {
    const next = width + visualWidth(ch)
    if (next > limit - 1) break
    out += ch
    width = next
  }
  return `${out}…`
}

/** 右侧补空格到给定视觉宽度（不会截断）。 */
export function padVisual(text: string, width: number): string {
  const pad = width - visualWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

/** 居中（按视觉宽度）。 */
function centerVisual(text: string, width: number): string {
  const pad = Math.max(0, width - visualWidth(text))
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + text + ' '.repeat(pad - left)
}

/**
 * 把栏目按**顺序**分配到布局区域（`layout.regions` 的顺序即区域顺序）。
 *
 * 规则是纯机械的、可复现的：
 *   · 没有区域 → 所有栏目落在占位区域 {@link WireframeStrings.noRegions} 上；
 *   · 栏目数 ≤ 区域数 → 逐区域各放一个，多余的区域留空（**空区域也要画出来**，
 *     否则"声明了却没排"这件事就被悄悄吞掉了）；
 *   · 栏目数 > 区域数 → 按区域数整除后余数从第一个区域开始各多放一个。
 * 返回值里的区域名**一定**来自 `layout.regions`（或占位符），本模块不发明区域。
 */
export function regionBuckets(
  screen: UiScreen,
  noRegions: string,
): { region: string; columns: string[]; assignment: WireframeAssignment }[] {
  const names = screen.columns.map((column) => column.name)
  const regions = screen.layout.regions.length === 0 ? [noRegions] : [...screen.layout.regions]
  const buckets = regions.map((region) => ({ region, columns: [] as string[], assignment: 'exact' as WireframeAssignment }))

  /**
   * **F-2（sdo-test 回归报告，major）**：栏目落在哪个区域由 `ui` 视图**显式声明**（`columns[].region`）
   * 决定；只有**全部**栏目都没声明时才退回"按数量均分"，并且**必须**把这次归属标记为
   * `guessed`（线框图与 `.puml` 会在图旁注明"区域归属是猜测"，并给出消除办法）。
   *
   * 旧实现只有均分 —— 在「区域数 ≠ 栏目数」的屏上必然错位（实测 5 栏 3 区把表单字段排进页头），
   * 而 SVG/线框是给人审的交付物，错位会直接误导审阅者。
   */
  const declared = screen.columns.filter((column) => (column.region ?? '').trim() !== '')
  if (declared.length === screen.columns.length && screen.columns.length > 0) {
    // 整屏都是显式声明 → **所有**区域（含空区域）的归属来源都记 `declared`：
    // 空区域不是"猜出来的空"，而是"声明里没有栏目落在这里"。
    for (const bucket of buckets) bucket.assignment = 'declared'
    for (const column of screen.columns) {
      const want = (column.region ?? '').trim()
      const hit = buckets.find((bucket) => bucket.region === want)
      // 声明了但不在 `layout.regions` 里：**不静默**丢弃，单开一个同名区域并把归属标成 declared
      // （`ui` 视图形状校验另有判据报"区域名不存在"，两者互补：一个拦、一个显示）
      if (hit === undefined) {
        buckets.push({ region: want, columns: [column.name], assignment: 'declared' })
        continue
      }
      hit.columns.push(column.name)
      hit.assignment = 'declared'
    }
    return buckets
  }

  const base = Math.floor(names.length / regions.length)
  const extra = names.length % regions.length
  let at = 0
  for (let index = 0; index < regions.length; index += 1) {
    const take = base + (index < extra ? 1 : 0)
    buckets[index]!.columns = names.slice(at, at + take)
    at += take
  }
  // 只有一个区域、或每区至多一栏时，均分结果唯一 → 不算"猜测"
  const trivial = regions.length <= 1 || names.length <= regions.length
  for (const bucket of buckets) bucket.assignment = trivial ? 'exact' : 'guessed'
  return buckets
}

/** 一屏的线框排版结果：`width` 是所有行统一的显示宽度（调用方拼接时可直接对齐）。 */
export interface WireframeBlock {
  id: string
  name: string
  lines: string[]
  /** **F-2**：本屏区域归属的来源（`guessed` 时图里会注明"这是猜测"）。 */
  assignment: WireframeAssignment
  /** 本屏是否**没有任何栏目**（调用方据此给可读提示 / 判 N/A） */
  empty: boolean
}

const MIN_BOX = 24
const MAX_BOX = 64

/**
 * 画一屏的线框图（方框内是栏目名，顺序与 `columns` 一致；区域名来自 `layout.regions`）。
 *
 * F-15：区域按 `layout.stack` 的**显式声明**堆叠 —— `horizontal` 并排、`vertical` 纵向；
 * **未声明时按 `vertical` 渲染**（报告实测的 `grid` 文本正是"单列纵向堆叠"）。
 * 本模块**不猜 `grid` 的自由文本**；方向来源由 {@link WireframeStrings.stackNote}
 * 在图旁注明（声明 / 缺省），避免"图与声明相反"再次误导审阅者。
 */
export function screenWireframe(screen: UiScreen, strings: WireframeStrings): WireframeBlock {
  const buckets = regionBuckets(screen, strings.noRegions)
  const empty = screen.columns.length === 0
  // `undefined`（未声明）= 缺省纵向；只有显式 `horizontal` 才并排。
  const stack: UiStackDirection = screen.layout.stack === 'horizontal' ? 'horizontal' : 'vertical'

  // 先量宽度：每个区域框的宽度由"区域名"与"该区域的栏目名+缩进"共同决定
  const natural = buckets.map((bucket) => {
    const inner = Math.max(
      visualWidth(bucket.region) + 2,
      ...bucket.columns.map((column) => visualWidth(column) + 4),
      0,
    )
    return Math.min(MAX_BOX, Math.max(MIN_BOX, inner + 2))
  })
  const head = `▌${screen.id} ${screen.name}`
  const grid = screen.layout.grid === '' ? '' : ` (${screen.layout.grid})`
  const lines: string[] = [clipVisual(`${head}${grid}`, MAX_BOX * Math.max(1, natural.length) + natural.length - 1)]
  // 图旁注明方向来源：声明了 `layout.stack` 就写值，没声明就写"缺省（纵向）"
  lines.push(strings.stackNote(screen.layout.stack))

  if (stack === 'horizontal') {
    // 区域框**并排**画（与 `layout.regions` 的顺序一致）
    lines.push(buckets.map((_, index) => `┌${'─'.repeat(natural[index]!)}┐`).join(''))
    lines.push(buckets.map((bucket, index) => `│${padVisual(centerVisual(bucket.region, natural[index]!), natural[index]!)}│`).join(''))
    lines.push(buckets.map((_, index) => `├${'─'.repeat(natural[index]!)}┤`).join(''))
    const rows = Math.max(1, ...buckets.map((bucket) => bucket.columns.length))
    for (let row = 0; row < rows; row += 1) {
      const cells = buckets.map((bucket, index) => {
        const name = bucket.columns[row]
        const width = natural[index]!
        return `│${padVisual(name === undefined ? '' : `  ${clipVisual(name, width - 3)}`, width)}│`
      })
      lines.push(cells.join(''))
    }
    lines.push(buckets.map((_, index) => `└${'─'.repeat(natural[index]!)}┘`).join(''))
  } else {
    // **纵向**：每个区域一个方框，自上而下按 `layout.regions` 顺序堆叠。
    // 所有区域共用同一宽度（取最大）：同一屏的方框各行等宽，方框不会歪。
    const width = Math.max(MIN_BOX, ...natural)
    for (const bucket of buckets) {
      lines.push(`┌${'─'.repeat(width)}┐`)
      lines.push(`│${padVisual(centerVisual(bucket.region, width), width)}│`)
      lines.push(`├${'─'.repeat(width)}┤`)
      for (const column of bucket.columns) lines.push(`│${padVisual(`  ${clipVisual(column, width - 3)}`, width)}│`)
      lines.push(`└${'─'.repeat(width)}┘`)
    }
  }
  // **F-2**：声明了本屏不存在的区域名 → 在图里点名（否则那个栏目会被排进凭空出现的区域框）
  for (const bucket of buckets) {
    if (screen.layout.regions.length > 0 && !screen.layout.regions.includes(bucket.region) && bucket.columns.length > 0) {
      lines.push(strings.regionUnknown(bucket.columns.join('、'), bucket.region, screen.layout.regions.join(' / ')))
    }
  }
  const assignment: WireframeAssignment = buckets.some((bucket) => bucket.assignment === 'guessed')
    ? 'guessed'
    : buckets.some((bucket) => bucket.assignment === 'declared')
      ? 'declared'
      : 'exact'
  // **F-2**：归属是猜的就必须写在图里（不写等于让审阅者以为这就是声明的布局）
  if (assignment === 'guessed') lines.push(strings.assignmentGuessed)
  if (empty) lines.push(strings.emptyColumns)
  return { id: screen.id, name: screen.name, lines, empty, assignment }
}

/**
 * 整个 `ui` 视图的线框图（每屏一段）。
 *
 * **没有页面 → 返回空数组**（不造示例页面）；调用方据此决定是给"还没有页面"的提示
 * 还是 N/A 说明。
 */
export function renderWireframes(view: UiView, strings: WireframeStrings): WireframeBlock[] {
  return view.screens.map((screen) => screenWireframe(screen, strings))
}

/** PlantUML 标识符里不能有空格/中文标点，机械替换（展示名仍用原文，不丢信息）。 */
function ident(raw: string, fallback: string): string {
  const cleaned = raw.replace(IDENT_UNSAFE, '_').replace(/_+/gu, '_').replace(/^_|_$/gu, '')
  return cleaned === '' ? fallback : cleaned
}

/**
 * 生成 **PlantUML 骨架**（`.puml` 源码）。
 *
 * ⚠️ 本仓库**没有 PlantUML 渲染器**，因此这里只产出源码文件：
 * 不解析、不渲染、不调用外部工具 —— 使用者自己拿 PlantUML 去出图。
 * 图里的区域与栏目同样**逐项来自台账**（与线框图同一份 {@link regionBuckets}）。
 */
export function plantUmlSkeleton(
  view: UiView | undefined,
  strings: WireframeStrings,
  title: string,
  /** 无障碍注记的整行文本（由调用方用语言包拼好，本模块不做文案） */
  a11yText: string,
): string {
  const lines: string[] = ['@startuml', `title ${title}`]
  if (view === undefined || view.screens.length === 0) {
    lines.push(`note "${strings.noScreens}" as N0`)
    lines.push('@enduml', '')
    return lines.join('\n')
  }
  lines.push(`' ${strings.screenNote}: ${view.id} / ${view.style.source}`)
  let index = 0
  for (const screen of view.screens) {
    const group = `${ident(screen.id, `SCR_${index + 1}`)}_${ident(screen.name, `screen_${index + 1}`)}`
    index += 1
    lines.push(`package "${screen.id} ${screen.name}" as ${group} {`)
    // F-15：方向来源同样写进骨架源码的注释里（声明 / 缺省），与 ASCII 线框图口径一致
    lines.push(`  ' ${strings.stackNote(screen.layout.stack)}`)
    const buckets = regionBuckets(screen, strings.noRegions)
    for (const [at, bucket] of buckets.entries()) {
      const box = `${group}_r${at + 1}`
      lines.push(`  rectangle "${bucket.region}" as ${box} {`)
      for (const column of bucket.columns) lines.push(`    card "${column}" as ${box}_c${bucket.columns.indexOf(column) + 1}`)
      lines.push('  }')
    }
    lines.push('}')
    if (screen.columns.length === 0) lines.push(`note "${strings.emptyColumns}" as ${group}_empty`)
    // **F-2**：骨架里也要说清"区域归属是猜测"（与 ASCII 线框图同口径）
    if (buckets.some((bucket) => bucket.assignment === 'guessed')) {
      lines.push(`note "${strings.assignmentGuessed}" as ${group}_guess`)
    }
  }
  if (view.breakpoints.length > 0) {
    const text = view.breakpoints.map((item) => `${item.name} ${item.width}`).join(' / ')
    lines.push(`note "${strings.breakpoints}: ${text}" as NB`)
  }
  lines.push(`note "${a11yText}" as NA`)
  lines.push('@enduml', '')
  return lines.join('\n')
}
