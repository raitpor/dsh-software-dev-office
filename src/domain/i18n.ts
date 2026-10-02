/**
 * i18n：把**内部标识**翻成**中文呈现**（设计需求：对外一律中文，不暴露 `G0` 这类不清晰表述）。
 *
 * 分工：
 *   · 标识（`G0` / `intake` / `in-progress` / `developer`）**保持不变**——它们进出 journal、
 *     命令参数与追溯图，改名会破坏真源与既有数据；
 *   · 显示一律经 `t()` 走 `src/data/lang/zh-CN.yml`；
 *   · 命令参数**同时接受中文**（`gateIdOf('立项门禁')` → `G0`），降低记忆负担。
 */
import { loadPackagedYaml } from '../infra/data.js'

interface LangFile {
  locale: string
  [section: string]: unknown
}

/** **基准语言**：回退链的末端，必须永远完整（当前语言缺键时回落到它）。 */
export const BASE_LOCALE = 'zh-CN'
/** 随包语言清单（新增语言 = 放一个 `src/data/lang/<locale>.yml` + 在这里登记）。 */
export const LANGUAGES: readonly string[] = [BASE_LOCALE, 'en']

let activeLocale = BASE_LOCALE
let cache: { locale: string; tables: Record<string, Record<string, string>> } | undefined

/**
 * 设定当前语言（由**插件行配置** `lang` 驱动；`apply()` 早期调用一次）。
 * 未知/空语言一律回落到基准语言 —— 显示语言配错不该让会话不可用。
 */
export function setLocale(locale: string): void {
  const next = LANGUAGES.includes(locale.trim()) ? locale.trim() : BASE_LOCALE
  if (next === activeLocale && cache !== undefined) return
  activeLocale = next
  cache = undefined
}

/** 读一个语言包；**缺失不抛错**（显示层退回标识/基准语言，绝不把"翻译缺了"升级成"会话用不了"）。 */
function readPack(locale: string): LangFile | undefined {
  try {
    return loadPackagedYaml<LangFile>(`src/data/lang/${locale}.yml`)
  } catch {
    return undefined
  }
}

function tablesOf(file: LangFile | undefined): Record<string, Record<string, string>> {
  const tables: Record<string, Record<string, string>> = {}
  if (file === undefined) return tables
  for (const [key, value] of Object.entries(file)) {
    if (key === 'locale' || typeof value !== 'object' || value === null) continue
    tables[key] = value as Record<string, string>
  }
  return tables
}

function load(): { locale: string; tables: Record<string, Record<string, string>> } {
  if (cache !== undefined) return cache
  const base = tablesOf(readPack(BASE_LOCALE))
  if (activeLocale === BASE_LOCALE) {
    cache = { locale: BASE_LOCALE, tables: base }
    return cache
  }
  const pack = readPack(activeLocale)
  if (pack === undefined) {
    // 语言包不存在（或还没打包进来）→ 整体回落基准语言
    cache = { locale: BASE_LOCALE, tables: base }
    return cache
  }
  // **逐键合并**：目标语言覆盖基准语言，缺的键回落基准 —— 支持渐进补译
  const merged: Record<string, Record<string, string>> = {}
  for (const [section, table] of Object.entries(base)) merged[section] = { ...table }
  for (const [section, table] of Object.entries(tablesOf(pack))) {
    merged[section] = { ...(merged[section] ?? {}), ...table }
  }
  cache = { locale: activeLocale, tables: merged }
  return cache
}

/**
 * 目标语言**覆盖了多少个基准键**（≤ 基准键总数）。
 *
 * 回执必须用它当分子：直接数"目标语言包有多少键"会得到 `980 of 951` 这种不可能的读数
 * （非基准语言包可以带**专属键**，例如 `criterion.C-xx`：基准语言下判据描述取自流程数据，
 * 而流程数据是中文，所以英文包必须自带这些键）。分子分母口径不一致就是展示 bug（真机实测 G-08）。
 */
export function coveredBaseKeys(): number {
  const base = tablesOf(readPack(BASE_LOCALE))
  const activeLocaleNow = activeLocale
  if (activeLocaleNow === BASE_LOCALE) return Object.values(base).reduce((sum, table) => sum + Object.keys(table).length, 0)
  const pack = tablesOf(readPack(activeLocaleNow))
  let covered = 0
  for (const [section, table] of Object.entries(base)) {
    for (const key of Object.keys(table)) if (pack[section]?.[key] !== undefined) covered += 1
  }
  return covered
}

/** 目标语言包中**基准语言没有的专属键**数（同一份回执里如实说明）。 */
export function extraKeys(): number {
  if (activeLocale === BASE_LOCALE) return 0
  const base = tablesOf(readPack(BASE_LOCALE))
  const pack = tablesOf(readPack(activeLocale))
  let extra = 0
  for (const [section, table] of Object.entries(pack)) {
    for (const key of Object.keys(table)) if (base[section]?.[key] === undefined) extra += 1
  }
  return extra
}

/** 基准语言的全部键数（回执里用它算"目标语言覆盖了多少"）。 */
export function baseKeyCount(): number {
  return Object.values(tablesOf(readPack(BASE_LOCALE))).reduce((sum, table) => sum + Object.keys(table).length, 0)
}

/** 目标语言包**实际覆盖**的键数（用于诊断"英语包补译到哪了"）。 */
export function translatedKeys(): number {
  const pack = activeLocale === BASE_LOCALE ? undefined : readPack(activeLocale)
  return Object.values(tablesOf(pack)).reduce((sum, table) => sum + Object.keys(table).length, 0)
}

/** 取文案：`t('gate.G0')`；查不到就原样返回 key 的最后一段（绝不显示空白）。 */
export function t(key: string, fallback?: string): string {
  const [section, ...rest] = key.split('.')
  const id = rest.join('.')
  const value = section === undefined ? undefined : load().tables[section]?.[id]
  if (value !== undefined) return value
  return fallback ?? id ?? key
}

/** 当前**生效**语言（语言包缺失时回落为基准语言）。 */
export function locale(): string {
  return load().locale
}

/**
 * 在**指定语言**下执行一段渲染（N-11）。
 *
 * 用途：`docs/DESIGN.md` 的渲染头记录了渲染时的语言，判据要按**那个**语言重渲染才能逐字节比对
 * 正文 —— 否则"中文渲染 → 切到 en → 章节标题找不到"会变成假红，照着 remedy 重渲染后又反向假红。
 * 只影响这段同步执行的取文，结束后恢复原语言（渲染是纯函数，不落盘、不产生异步）。
 */
export function withLocale<T>(target: string, render: () => T): T {
  const previous = activeLocale
  setLocale(target)
  try {
    return render()
  } finally {
    setLocale(previous)
  }
}

/** 反查：中文（或标识本身）→ 标识。命令参数用它，使用户可以写"立项门禁"。 */
export function idOf(section: string, input: string): string | undefined {
  const table = load().tables[section]
  if (table === undefined) return undefined
  if (table[input] !== undefined) return input
  const hit = Object.entries(table).find(([, label]) => label === input)
  return hit?.[0]
}

/** 门禁：标识或中文 → 门禁 id。 */
export function gateIdOf(input: string): string | undefined {
  return idOf('gate', input.trim())
}

/** 门禁的显示名（找不到时退回标识，便于诊断）。 */
/**
 * 门禁的**用户可见写法**：中文名在前、内部编号在后（括号里）。
 * 实测反馈：只说 `G1` 一般用户看不懂是什么门禁，所以一律带中文名；编号保留以便追溯。
 */
/**
 * 带占位符的取文：`fmt('statusProject', { id: 'PRJ-001' })`。
 * 约定：`t()` 只支持**两层键**（`section.key`），因此键一律扁平（如 `status.projectLine` 不用）。
 */
export function fmt(key: string, params: Record<string, string | number | undefined | null> = {}): string {
  let text = t(key)
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, value === undefined || value === null ? '' : String(value))
  }
  return text
}

export function gateWithId(id: string): string {
  const name = gateLabel(id)
  return name === id ? id : `${name}（${id}）`
}

export function gateLabel(id: string): string {
  return t(`gate.${id}`, id)
}

/**
 * 显示层选择器：**非基准语言时优先语言包**，基准语言时优先流程数据。
 *
 * 为什么需要它：阶段名与判据描述也在**流程数据**（`src/data/processes/*.yml`）里，
 * 而那份数据是中文的。基准语言下优先数据（允许项目自定义措辞）；
 * 切到 `en` 时若还优先数据，界面就会"半中半英"——英文的判据编号配中文的判据描述。
 */
export function textOrProcess(key: string, fromProcess?: string | undefined): string {
  const packed = t(key)
  const resolved = packed !== key.split('.').pop()
  const fromData = fromProcess !== undefined && fromProcess.trim() !== '' ? fromProcess : undefined
  if (locale() === BASE_LOCALE) return fromData ?? packed
  return resolved ? packed : (fromData ?? packed)
}

/** 阶段显示名：基准语言优先流程数据，非基准语言优先语言包，最后退回标识。 */
export function phaseText(id: string, fromProcess?: string | undefined): string {
  return textOrProcess(`phase.${id}`, fromProcess)
}

/** 通用：把某节的标识翻成中文（例如 taskStatus / riskLevel / reviewVerdict）。 */
export function label(section: string, id: string): string {
  return t(`${section}.${id}`, id)
}
