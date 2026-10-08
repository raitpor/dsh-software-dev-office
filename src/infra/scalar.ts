/**
 * **用户可编辑 YAML 的字符串口径**（F-20）。
 *
 * 为什么需要它：`.sdo/**\/*.yml` 是给人手改的真源，而 YAML 的类型由**写法**决定 ——
 * `retry: 2` 是 number、`flag: true` 是 boolean、`x:` 是 null、`x: {a: 1}` 是对象。
 * 代码对读出来的字段直接调用 `String.prototype` 方法（`.trim()` / `.includes()` …）时，
 * 一个人手写漏掉的一对引号就会让整条判定链**抛异常**，而不是给出可读结论。
 * 实测（原始栈）：`TypeError: contract.failureSemantics.retry.trim is not a function`
 * （`.verify/probe-f20.mjs`，一行 `retry: 2` 即复现）。
 *
 * 口径（F-20 的修复约定，"不崩 / 不静默 / 不假红"）：
 *   · `string`         → 原样；
 *   · `number`/`boolean` → **字符串化**后使用（值本身语义正确，只是 YAML 类型不同）——
 *     调用方**不应**因此判红，但必须给出类型提示；
 *   · `null`/`undefined` → 空串（等价于"没写"，与 `retry: ''` 同口径）；
 *   · `object`/`array`/其他 → 空串 + `usable: false`：**不能静默**，调用方必须给出
 *     可读的失败与修正办法（把该字段按空缺处理，让既有判据去判红并说明怎么改）。
 *
 * 本模块只做口径转换：不抛异常、不猜语义、不写日志。
 */

/** 一个 YAML 值的字符串口径。 */
export interface ScalarText {
  /** 字符串化结果；**无法字符串化时是空串** */
  text: string
  /** YAML 里的实际类型名：`string` / `number` / `boolean` / `null` / `undefined` / `object` / `array` / … */
  actualType: string
  /** 能否按 `text` 使用 */
  usable: boolean
  /** 类型不是 `string`（调用方据此给出**可执行的类型提示**） */
  typed: boolean
}

/** YAML 值的类型名（`null` / `array` 单独识别，其余用 `typeof`）。 */
export function typeNameOf(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 把 YAML 值转成字符串口径（**绝不抛异常**）。 */
export function scalarText(value: unknown): ScalarText {
  const actualType = typeNameOf(value)
  if (actualType === 'string') return { text: value as string, actualType, usable: true, typed: false }
  if (actualType === 'number') {
    // 非有限数（NaN / Infinity）字符串化后不是可用的值 → 按空缺处理（usable: false）
    const finite = Number.isFinite(value)
    return { text: finite ? String(value) : '', actualType, usable: finite, typed: true }
  }
  if (actualType === 'boolean') return { text: String(value), actualType, usable: true, typed: true }
  if (actualType === 'null' || actualType === 'undefined') {
    return { text: '', actualType, usable: true, typed: false }
  }
  return { text: '', actualType, usable: false, typed: true }
}

/**
 * 只要字符串口径时的简写：`textOf(x).trim()` 替代 `x.trim()`。
 *
 * 无法字符串化（对象/数组）时返回空串 —— 于是"字段没写"的既有判据会自然判红，
 * 用户看到的是可读的失败而不是崩溃。需要**点名类型与修正办法**的场合请用 `scalarText()`。
 */
export function textOf(value: unknown): string {
  return scalarText(value).text
}

// —————————————————————— F-21 ①：容器族（列表 / 映射位置的形状假设） ——————————————————————

/**
 * 一个**容器位置**被手写成别的形状时的说明（F-21 ①）。
 *
 * 为什么需要它：F-20 修的是"标量位置的类型假设"，同一家族还有**容器位置的形状假设** ——
 * `.sdo/**\/*.yml` 里 `dependsOn: api`（少写一对 `[]`）会让 `dependsOn.join` 抛异常、
 * `targets: Q-1` 会让 `targets.includes` 抛异常。口径与 F-20 一致：
 *   · **列表位置**：标量 → 单元素列表（作者的意图明确，丢掉它就是静默改数据）；
 *     映射/对象 → **不猜**，按空处理，但必须报出（`handling: 'empty'`）；
 *   · **映射位置**：标量 / 列表 → **不猜**，按空映射处理，同样必须报出。
 *
 * 本结构是**纯数据、无文案**；"哪个实体、哪个字段"由调用方补上（见 `FieldShapeNote`）。
 */
export interface ShapeIssue {
  /** 位置种类 */
  position: 'list' | 'map' | 'bool'
  /** YAML 里的实际类型名 */
  actualType: string
  /** 处置方式：`single` = 按单元素列表读取；`empty` = 按空处理 */
  handling: 'single' | 'empty'
  /** 可字符串化时的值文本（用于给出建议写法）；否则空串 */
  text: string
}

/**
 * 一条**面向用户**的形状提示：哪个实体、哪个字段、实际形状、怎么处置。
 *
 * 与 F-20 的 `ContractFieldNote` 同口径：`entity` 是实体种类（文案键 `shapeEntity.<entity>`），
 * `id` 是哪个实体，`field` 是点号分层的字段路径，`key` 是最后一段（可直接写进 YAML 的键名）。
 */
export interface FieldShapeNote {
  entity: string
  id: string
  field: string
  key: string
  position: ShapeIssue['position']
  actualType: string
  handling: ShapeIssue['handling']
  text: string
}

/** 把字段级的 `ShapeIssue` 补上实体上下文（没有问题时返回 `undefined`）。 */
export function shapeNoteOf(
  entity: string,
  id: string,
  field: string,
  issue: ShapeIssue | undefined,
): FieldShapeNote | undefined {
  if (issue === undefined) return undefined
  return {
    entity,
    id,
    field,
    key: field.split('.').pop() ?? field,
    position: issue.position,
    actualType: issue.actualType,
    handling: issue.handling,
    text: issue.text,
  }
}

/** 便利：把一条 `ShapeIssue` 收进提示数组（没有问题时什么都不做）。 */
export function pushShapeNote(
  notes: FieldShapeNote[],
  entity: string,
  id: string,
  field: string,
  issue: ShapeIssue | undefined,
): void {
  const note = shapeNoteOf(entity, id, field, issue)
  if (note !== undefined) notes.push(note)
}

/** 一次容器读取：归一化后的值 + 形状说明（`issue === undefined` 表示写法正确）。 */
export interface ContainerRead<T> {
  value: T[]
  issue: ShapeIssue | undefined
}

function listIssue(actualType: string, handling: ShapeIssue['handling'], text: string): ShapeIssue {
  return { position: 'list', actualType, handling, text }
}

/**
 * **字符串列表位置**的口径。
 *
 *   · 数组 → 逐项字符串化（`null`/空串/对象项被跳过，跳过即报出）；
 *   · 标量 → **单元素列表** + 提示（作者的意图明确：写成 `[值]` 即可）；
 *   · 映射 → 空列表 + 提示（**不猜**）。
 */
export function textListOf(value: unknown): ContainerRead<string> {
  if (value === null || value === undefined) return { value: [], issue: undefined }
  if (Array.isArray(value)) {
    const out: string[] = []
    let bad: string | undefined
    for (const item of value) {
      const scalar = scalarText(item)
      if (scalar.text !== '') {
        out.push(scalar.text)
        continue
      }
      // 空串 / 空项是"这一项没写"，不算形状问题；对象/数组/NaN 这类"读不成字符串"的项要报出
      if (scalar.actualType === 'string' || scalar.actualType === 'null' || scalar.actualType === 'undefined') continue
      bad ??= scalar.actualType
    }
    return { value: out, issue: bad === undefined ? undefined : listIssue(bad, 'empty', '') }
  }
  if (typeof value === 'object') return { value: [], issue: listIssue('object', 'empty', '') }
  const scalar = scalarText(value)
  if (scalar.actualType === 'string' && scalar.text === '') return { value: [], issue: undefined }
  if (scalar.usable && scalar.text !== '') {
    return { value: [scalar.text], issue: listIssue(scalar.actualType, 'single', scalar.text) }
  }
  return { value: [], issue: listIssue(scalar.actualType, 'empty', '') }
}

/**
 * **记录列表 + 标量项**的宽容读法（**D-9**，sdo-test-new 2026-10-08，minor）。
 *
 * `recordListOf` 只收映射项：一串**字符串**会被判成"形状不对"，值被读成空列表 + 一条
 * 「是 string 类型：无法判断列表内容，已按**空列表**处理」的提示 —— 而盘上那份 YAML 明明是
 * 一个合法列表，提示给出的补救（"写成 `- 值` 列表"）也正是作者已经写的样子。真机症状：
 * `design/method-dfd.yml` 的 `levels[].flows`（一串流名）被静默读空，**父/子层流量平衡校验因此空洞通过**。
 *
 * 这里把"标量项"按调用方给的 `fromScalar` 收回（这正是 `recordListOf` 的 `fromScalar` 参数本来的用意），
 * 只对**既不是标量也不是映射**的项报形状问题。用法限定在"对象里只有名字是本质、其余字段可缺省"的列表。
 */
export function looseRecordListOf<T>(value: unknown, fromScalar: (text: string) => T): ContainerRead<T> {
  if (!Array.isArray(value)) return recordListOf<T>(value, fromScalar)
  const out: T[] = []
  let bad: string | undefined
  for (const item of value) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out.push(item as T)
      continue
    }
    const scalar = scalarText(item)
    if (scalar.usable && scalar.text !== '') {
      out.push(fromScalar(scalar.text))
      continue
    }
    // 空串 / null 是"这一项没写"，不算形状问题
    if (scalar.actualType === 'string' || scalar.actualType === 'null' || scalar.actualType === 'undefined') continue
    bad ??= scalar.actualType
  }
  return { value: out, issue: bad === undefined ? undefined : listIssue(bad, 'empty', '') }
}

/**
 * **记录列表位置**（形如 `- id: …`）的口径。
 *
 * 与字符串列表同一口径：标量 → 单元素列表（由调用方给出的 `fromScalar` 决定把它放进哪个字段），
 * 数组 → 只保留映射项；**单个映射**（少写了 `-`）→ **不猜**，按空处理 + 提示。
 */
export function recordListOf<T>(value: unknown, fromScalar: (text: string) => T): ContainerRead<T> {
  if (value === null || value === undefined) return { value: [], issue: undefined }
  if (Array.isArray(value)) {
    const out: T[] = []
    let bad: string | undefined
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) out.push(item as T)
      else bad ??= typeNameOf(item)
    }
    return { value: out, issue: bad === undefined ? undefined : listIssue(bad, 'empty', '') }
  }
  if (typeof value === 'object') return { value: [], issue: listIssue('object', 'empty', '') }
  const scalar = scalarText(value)
  if (scalar.actualType === 'string' && scalar.text === '') return { value: [], issue: undefined }
  if (scalar.usable && scalar.text !== '') {
    return { value: [fromScalar(scalar.text)], issue: listIssue(scalar.actualType, 'single', scalar.text) }
  }
  return { value: [], issue: listIssue(scalar.actualType, 'empty', '') }
}

/**
 * **映射位置**的口径：只有映射才算数；标量 / 列表 → 空映射 + 提示（**不猜**）。
 *
 * 返回原映射本身（字段级归一化由调用方逐字段做）。
 */
export function recordOf(value: unknown): { value: Record<string, unknown>; issue: ShapeIssue | undefined } {
  if (value === null || value === undefined) return { value: {}, issue: undefined }
  if (typeof value === 'object' && !Array.isArray(value)) return { value: value as Record<string, unknown>, issue: undefined }
  return { value: {}, issue: { position: 'map', actualType: typeNameOf(value), handling: 'empty', text: scalarText(value).text } }
}

/** **字符串映射位置**的口径：键保留、值逐项字符串化；整个位置形状不对时按空映射 + 提示。 */
export function textMapOf(value: unknown): { value: Record<string, string>; issue: ShapeIssue | undefined } {
  const read = recordOf(value)
  if (read.issue !== undefined) return { value: {}, issue: read.issue }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(read.value)) out[key] = scalarText(item).text
  return { value: out, issue: undefined }
}

/**
 * **布尔位置**（`dropped` 这类开关）的口径：只有 `true` / `false` 算数；
 * 非布尔存在时按"没写"处理并给出提示（**绝不猜** `yes` 是不是 true）。
 */
export function boolField(value: unknown): { value: boolean | undefined; issue: ShapeIssue | undefined } {
  if (value === null || value === undefined) return { value: undefined, issue: undefined }
  if (typeof value === 'boolean') return { value, issue: undefined }
  return {
    value: undefined,
    issue: { position: 'bool', actualType: typeNameOf(value), handling: 'empty', text: scalarText(value).text },
  }
}

/**
 * **显式放弃**（`dropped`）的唯一判定口径（F-21 ②）。
 *
 *   · `true` → 放弃；
 *   · `false` / 缺失 / `null` → 不放弃，**不产生提示**；
 *   · 其余（`dropped: yes` / `'true'` / `1`）→ **不放弃**（插件不替用户猜），
 *     但**必须报出**并在提示里点名建议写法 `dropped: true`（或 `false`）。
 *
 * 全仓库对 `dropped` 的判定都走这一个助手，避免"一处一种写法"。
 */
export function droppedFlag(value: unknown): { dropped: boolean; issue: ShapeIssue | undefined } {
  const read = boolField(value)
  return { dropped: read.value === true, issue: read.issue }
}
