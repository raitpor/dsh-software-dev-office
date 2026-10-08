/**
 * 极小的 YAML **子集**编解码器。
 *
 * 为什么自己写：设计（§4.4 / §11.1）要求 `.sdo/` 实体与随包数据是 `.yml`，
 * 而约束 C-03 禁止引入第三方运行时依赖，Node 又没有内置 YAML 解析器，
 * 宿主（`@deepseek-ai/cordis` / `dsh-config-editor`）也没有暴露可复用的解析 API。
 * 因此这里实现一个**严格受限**的子集：越界一律报错，绝不猜测。
 *
 * 支持：
 *   · 注释（整行 / 值后）；单文档
 *   · 缩进嵌套的映射与序列（只用空格，Tab 报错）
 *   · 序列项内联映射（`- id: X` 后跟同列键）
 *   · 标量：plain / 单引号 / 双引号；null / true / false / 整数 / 浮点
 *   · 流式集合 `[a, b]` 与 `{a: 1, b: 2}`（可嵌套）
 *   · 块标量 `|` `>` 及 `-` / `+` chomping
 *
 * 不支持（遇到就报错，不做兼容猜测）：多文档（`---`/`...`）、锚点与别名（`&`/`*`）、
 * 标签（`!`）、复杂键、制表符缩进、显式键（`?`）。
 */

/** YAML 子集解析错误：带行号与原因，便于直接给用户看。 */
export class YamlSubsetError extends Error {
  readonly line: number

  constructor(line: number, reason: string) {
    super(`YAML 第 ${line} 行：${reason}`)
    this.name = 'YamlSubsetError'
    this.line = line
  }
}

interface LineInfo {
  readonly lineNo: number
  readonly indent: number
  /** 去掉缩进与行尾空白后的内容；整行注释与空行会被丢弃，不进入此数组 */
  readonly content: string
}

const PLAIN_INT = /^-?(?:0|[1-9]\d*)$/
const PLAIN_FLOAT = /^-?(?:0|[1-9]\d*)\.\d+(?:[eE][-+]?\d+)?$/

/** 判断一段文本是否像一个键值对的开头（键为 plain 标量，冒号后跟空格或行尾）。 */
function splitKey(text: string): { key: string; rest: string | undefined } | undefined {
  // 键里不允许出现引号/方括号等；遇到引号直接放弃（视为标量）
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') return undefined
    if (ch === ':' && (i + 1 === text.length || text[i + 1] === ' ')) {
      const key = text.slice(0, i).trim()
      if (key === '' || /[[\]{}'",#&*!|>%@`]/.test(key)) return undefined
      const rest = i + 1 === text.length ? '' : text.slice(i + 2).trim()
      return { key, rest }
    }
    if (ch === '#' && i > 0 && text[i - 1] === ' ') return undefined
  }
  return undefined
}

/** 去掉值后的行内注释（引号内不算）。 */
function stripInlineComment(text: string): string {
  let quote: '"' | "'" | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i++
          continue
        }
        quote = undefined
      } else if (quote === '"' && ch === '\\') {
        i++
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i).trimEnd()
    }
  }
  return text.trimEnd()
}

/** 预处理：切行 → 去注释 → 丢弃空行/整行注释 → 计算缩进。 */
function preprocess(text: string): LineInfo[] {
  const out: LineInfo[] = []
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx] ?? ''
    if (raw.includes('\t')) {
      throw new YamlSubsetError(idx + 1, '不允许用 Tab 缩进，请改用空格')
    }
    const withoutComment = stripInlineComment(raw)
    if (withoutComment.trim() === '') continue
    const indent = withoutComment.length - withoutComment.trimStart().length
    out.push({ lineNo: idx + 1, indent, content: withoutComment.trimStart() })
  }
  return out
}

class Parser {
  private i = 0

  constructor(private readonly lines: LineInfo[]) {}

  private peek(): LineInfo | undefined {
    return this.lines[this.i]
  }

  parseDocument(): unknown {
    if (this.lines.length === 0) return null
    const first = this.lines[0]
    if (first === undefined) return null
    if (first.content === '---' || first.content === '...') {
      throw new YamlSubsetError(first.lineNo, '不支持多文档（`---` / `...`）')
    }
    const value = this.parseNode(first.indent)
    if (this.i < this.lines.length) {
      const extra = this.lines[this.i]
      throw new YamlSubsetError(extra?.lineNo ?? 0, '这里的内容无法归属到任何结构（缩进不对？）')
    }
    return value
  }

  private parseNode(indent: number): unknown {
    const line = this.peek()
    if (line === undefined) return null
    if (line.content.startsWith('- ') || line.content === '-') return this.parseList(indent)
    if (splitKey(line.content) !== undefined) return this.parseMap(indent)
    this.i++
    return parseValueToken(line.content, line.lineNo)
  }

  private parseMap(indent: number): Record<string, unknown> {
    const map: Record<string, unknown> = {}
    while (true) {
      const line = this.peek()
      if (line === undefined || line.indent < indent) break
      if (line.indent > indent) {
        throw new YamlSubsetError(line.lineNo, `缩进比同级深 ${line.indent - indent} 个空格，无法归属`)
      }
      const split = splitKey(line.content)
      if (split === undefined) {
        if (line.content.startsWith('- ')) break
        throw new YamlSubsetError(line.lineNo, '期望 `键: 值`，但看到的是标量')
      }
      this.i++
      map[split.key] = this.parseValueAfterKey(split.rest ?? '', indent, line.lineNo)
    }
    return map
  }

  private parseList(indent: number): unknown[] {
    const list: unknown[] = []
    while (true) {
      const line = this.peek()
      if (line === undefined || line.indent < indent) break
      if (line.indent > indent) {
        throw new YamlSubsetError(line.lineNo, `缩进比同级深 ${line.indent - indent} 个空格，无法归属`)
      }
      if (!(line.content.startsWith('- ') || line.content === '-')) break
      this.i++
      const afterDash = line.content === '-' ? '' : line.content.slice(2)
      const itemIndent = line.indent + (line.content.length - afterDash.trimStart().length)
      const rest = afterDash.trim()
      if (rest === '') {
        const next = this.peek()
        list.push(next !== undefined && next.indent > line.indent ? this.parseNode(next.indent) : null)
        continue
      }
      // **§4.1**：列表项的块标量（`- |-` / `- |` / `- >`）也要能读 —— 存量文件与手写真源都是这个形状
      if (rest.startsWith('|') || rest.startsWith('>')) {
        list.push(this.parseBlockScalar(rest, itemIndent, line.lineNo))
        continue
      }
      const split = splitKey(rest)
      if (split === undefined) {
        list.push(parseValueToken(rest, line.lineNo))
        continue
      }
      // 序列项内联映射：本行是这个映射的第一个键，后续键与它同列
      const map: Record<string, unknown> = {}
      map[split.key] = this.parseValueAfterKey(split.rest ?? '', itemIndent, line.lineNo)
      while (true) {
        const cont = this.peek()
        if (cont === undefined || cont.indent < itemIndent) break
        if (cont.indent > itemIndent) {
          throw new YamlSubsetError(cont.lineNo, '序列项内的映射缩进不一致')
        }
        if (cont.content.startsWith('- ') || cont.content === '-') break
        const contSplit = splitKey(cont.content)
        if (contSplit === undefined) throw new YamlSubsetError(cont.lineNo, '期望 `键: 值`')
        this.i++
        map[contSplit.key] = this.parseValueAfterKey(contSplit.rest ?? '', itemIndent, cont.lineNo)
      }
      list.push(map)
    }
    return list
  }

  /** 解析 `键:` 之后的部分：空则取嵌套块；`|`/`>` 取块标量；否则取标量或流式集合。 */
  private parseValueAfterKey(rest: string, indent: number, lineNo: number): unknown {
    if (rest === '') {
      const next = this.peek()
      if (next === undefined || next.indent <= indent) return null
      return this.parseNode(next.indent)
    }
    if (rest.startsWith('|') || rest.startsWith('>')) return this.parseBlockScalar(rest, indent, lineNo)
    return parseValueToken(rest, lineNo)
  }

  private parseBlockScalar(header: string, indent: number, lineNo: number): string {
    const style = header[0] === '>' ? 'folded' : 'literal'
    const chompRaw = header.slice(1).replace(/\d/g, '')
    if (chompRaw !== '' && chompRaw !== '-' && chompRaw !== '+') {
      throw new YamlSubsetError(lineNo, `不支持的块标量指示符 \`${header}\``)
    }
    const chomp = chompRaw === '' ? 'clip' : chompRaw === '-' ? 'strip' : 'keep'
    const collected: { indent: number; text: string }[] = []
    while (true) {
      const line = this.peek()
      if (line === undefined || line.indent <= indent) break
      collected.push({ indent: line.indent, text: line.content })
      this.i++
    }
    if (collected.length === 0) return ''
    let base = Number.POSITIVE_INFINITY
    for (const c of collected) base = Math.min(base, c.indent)
    const rawText = collected.map((c) => ' '.repeat(c.indent - base) + c.text).join('\n')
    let body = style === 'literal' ? rawText : rawText.replace(/(?<!\n)\n(?!\n)/g, ' ').replace(/\n\n/g, '\n')
    if (chomp === 'strip') body = body.replace(/\n+$/, '')
    else if (chomp === 'clip') body = body.replace(/\n+$/, '') + '\n'
    else body = body + '\n'
    return body
  }
}

/** 解析值 token：流式集合、引号字符串、plain 标量。 */
function parseValueToken(text: string, lineNo: number): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const flow = new FlowParser(trimmed, lineNo)
    const value = flow.parseValue()
    flow.expectEnd()
    return value
  }
  return parsePlainOrQuoted(trimmed, lineNo)
}

function parsePlainOrQuoted(text: string, lineNo: number): unknown {
  const first = text[0]
  if (first === '&' || first === '*') throw new YamlSubsetError(lineNo, '不支持锚点/别名（`&` / `*`）')
  if (first === '!') throw new YamlSubsetError(lineNo, '不支持标签（`!`）')
  if (first === "'") {
    if (!text.endsWith("'") || text.length < 2) throw new YamlSubsetError(lineNo, '单引号字符串没有闭合')
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (first === '"') {
    if (!text.endsWith('"') || text.length < 2) throw new YamlSubsetError(lineNo, '双引号字符串没有闭合')
    try {
      return JSON.parse(text)
    } catch {
      throw new YamlSubsetError(lineNo, '双引号字符串里的转义不合法')
    }
  }
  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null
  if (text === 'true' || text === 'True' || text === 'TRUE') return true
  if (text === 'false' || text === 'False' || text === 'FALSE') return false
  if (PLAIN_INT.test(text)) return Number(text)
  if (PLAIN_FLOAT.test(text)) return Number(text)
  return text
}

/** 流式集合（`[...]` / `{...}`）的极小解析器，支持嵌套。 */
class FlowParser {
  private pos = 0

  constructor(private readonly text: string, private readonly lineNo: number) {}

  private error(reason: string): never {
    throw new YamlSubsetError(this.lineNo, `流式集合：${reason}`)
  }

  private skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos] ?? '')) this.pos++
  }

  parseValue(): unknown {
    this.skipSpace()
    const ch = this.text[this.pos]
    if (ch === '[') return this.parseArray()
    if (ch === '{') return this.parseObject()
    if (ch === "'" || ch === '"') return this.parseQuoted()
    return this.parsePlain()
  }

  private parseArray(): unknown[] {
    this.pos++ // [
    const out: unknown[] = []
    this.skipSpace()
    if (this.text[this.pos] === ']') {
      this.pos++
      return out
    }
    while (true) {
      out.push(this.parseValue())
      this.skipSpace()
      const ch = this.text[this.pos]
      if (ch === ',') {
        this.pos++
        continue
      }
      if (ch === ']') {
        this.pos++
        return out
      }
      this.error('数组缺少 `,` 或 `]`')
    }
  }

  private parseObject(): Record<string, unknown> {
    this.pos++ // {
    const out: Record<string, unknown> = {}
    this.skipSpace()
    if (this.text[this.pos] === '}') {
      this.pos++
      return out
    }
    while (true) {
      this.skipSpace()
      const key = this.parseScalarKey()
      this.skipSpace()
      if (this.text[this.pos] !== ':') this.error('对象缺少 `:`')
      this.pos++
      out[key] = this.parseValue()
      this.skipSpace()
      const ch = this.text[this.pos]
      if (ch === ',') {
        this.pos++
        continue
      }
      if (ch === '}') {
        this.pos++
        return out
      }
      this.error('对象缺少 `,` 或 `}`')
    }
  }

  private parseScalarKey(): string {
    const ch = this.text[this.pos]
    if (ch === "'" || ch === '"') {
      const value = this.parseQuoted()
      if (typeof value !== 'string') this.error('键必须是字符串')
      return value
    }
    const start = this.pos
    while (this.pos < this.text.length && !':,}'.includes(this.text[this.pos] ?? '')) this.pos++
    const key = this.text.slice(start, this.pos).trim()
    if (key === '') this.error('键不能为空')
    return key
  }

  private parseQuoted(): string {
    const quote = this.text[this.pos]
    const start = this.pos
    this.pos++
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]
      if (quote === '"' && ch === '\\') {
        this.pos += 2
        continue
      }
      if (ch === quote) {
        if (quote === "'" && this.text[this.pos + 1] === "'") {
          this.pos += 2
          continue
        }
        this.pos++
        const raw = this.text.slice(start, this.pos)
        const parsed = parsePlainOrQuoted(raw, this.lineNo)
        if (typeof parsed !== 'string') this.error('引号内容解析失败')
        return parsed
      }
      this.pos++
    }
    this.error('引号没有闭合')
  }

  private parsePlain(): unknown {
    const start = this.pos
    while (this.pos < this.text.length && !',]}'.includes(this.text[this.pos] ?? '')) this.pos++
    return parsePlainOrQuoted(this.text.slice(start, this.pos).trim(), this.lineNo)
  }

  expectEnd(): void {
    this.skipSpace()
    if (this.pos < this.text.length) this.error('集合后面还有多余字符')
  }
}

/** 解析一段 YAML 子集文本；失败抛 {@link YamlSubsetError}。 */
export function parseYaml(text: string): unknown {
  return new Parser(preprocess(text)).parseDocument()
}

const NEEDS_QUOTE = /^(?:[-?:,[\]{}#&*!|>%@`'"]|.*[:#]\s|.*\s$)/s
/** 必须用转义双引号（而不是单引号/裸值）的字符：tab / CR / 双引号 / 反斜杠 / 控制字符。 */
const NEEDS_ESCAPE_QUOTE = /[\t\r"\\]|[\u0000-\u001f]/u
const LOOKS_LIKE_SCALAR = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|-?(?:0|[1-9]\d*)(?:\.\d+)?)$/

function quoteIfNeeded(value: string): string {
  if (value === '' || NEEDS_QUOTE.test(value) || LOOKS_LIKE_SCALAR.test(value)) {
    return `'${value.replace(/'/g, "''")}'`
  }
  return value
}

/**
 * **多行字符串的转义双引号形式**（第二轮评审 §4.1/§4.2 的修法）。
 *
 * 病根：写出侧把多行串写成块标量（`key: |-` 或列表项 `- |-`），而**列表项**那种形式解析侧
 * （`parseList`）根本不认 ⇒ 写成功、台账记"已记录"，文件却**永久不可读**（真机路径：`sdo_quality`
 * 的 risks/sensitivities 元素含换行）。另外块标量里的**空行**在读取时被 `preprocess` 丢掉 ⇒ 多段正文掉空行。
 * 解析侧本来就支持转义双引号（`"p\n\nq"` 读回 `p\n\nq`），所以从**写出侧**收口：多行串一律用转义引号，
 * 写读往返天然成立，也不必再教解析器认列表块标量（那条仍补上，用于读**存量/手写**文件）。
 */
function quoteMultiline(value: string): string {
  const escaped = value
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\r/gu, '\\r')
    .replace(/\t/gu, '\\t')
    .replace(/\n/gu, '\\n')
  return `"${escaped}"`
}

function emitScalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('YAML 子集不支持 NaN / Infinity')
    return String(value)
  }
  if (typeof value === 'string') {
    // **§4.1/§4.2**：换行、制表符、双引号、反斜杠、控制字符一律走**转义双引号** ——
    // 单引号形式写不出 tab（读侧直接判"不允许用 Tab 缩进"），原样输出又可能破坏引号语义。
    return value.includes('\n') || NEEDS_ESCAPE_QUOTE.test(value) ? quoteMultiline(value) : quoteIfNeeded(value)
  }
  throw new Error(`YAML 子集不支持的类型：${typeof value}`)
}

function isCollection(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

function emitValue(value: unknown, indent: number, lines: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isCollection(item)) {
        const nested: string[] = []
        emitCollectionInline(item, indent + 2, nested)
        const first = nested.shift() ?? ''
        lines.push(' '.repeat(indent) + '- ' + first.trimStart())
        for (const l of nested) lines.push(l)
      } else {
        lines.push(' '.repeat(indent) + '- ' + emitScalar(item))
      }
    }
    return
  }
  if (isCollection(value)) {
    emitCollectionInline(value, indent, lines)
    return
  }

  lines.push(' '.repeat(indent) + emitScalar(value))
}

/** 把映射/序列写成"可内联在 `- ` 之后"的形式，第一行不带缩进。 */
function emitCollectionInline(value: unknown, indent: number, lines: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(' '.repeat(indent) + '[]')
      return
    }
    const nested: string[] = []
    emitValue(value, indent, nested)
    lines.push(...nested)
    return
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    lines.push(' '.repeat(indent) + '{}')
    return
  }
  for (const [key, item] of entries) {
    const keyText = quoteIfNeeded(key) + ':'
    if (item === null || !isCollection(item)) {
      lines.push(' '.repeat(indent) + keyText + ' ' + emitScalar(item))
      continue
    }
    if (Array.isArray(item) && item.length === 0) {
      lines.push(' '.repeat(indent) + keyText + ' []')
      continue
    }
    if (!Array.isArray(item) && Object.keys(item as object).length === 0) {
      lines.push(' '.repeat(indent) + keyText + ' {}')
      continue
    }
    lines.push(' '.repeat(indent) + keyText)
    emitValue(item, indent + 2, lines)
  }
}

/** 把值序列化为 YAML 子集文本（确定性输出：键序即插入序）。 */
export function stringifyYaml(value: unknown): string {
  const lines: string[] = []
  if (value === null || !isCollection(value)) {
    lines.push(emitScalar(value))
  } else if (Array.isArray(value) && value.length === 0) {
    lines.push('[]')
  } else if (!Array.isArray(value) && Object.keys(value as object).length === 0) {
    lines.push('{}')
  } else if (Array.isArray(value)) {
    emitValue(value, 0, lines)
  } else {
    emitCollectionInline(value, 0, lines)
  }
  return lines.join('\n') + '\n'
}
