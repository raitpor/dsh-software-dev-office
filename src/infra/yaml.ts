/**
 * 极小的 YAML **子集**编解码器。
 *
 * 为什么自己写：设计（§4.4 / §11.1）要求 `.sdo/` 实体与随包数据是 `.yml`，
 * 而约束 C-03 禁止引入第三方运行时依赖，Node 又没有内置 YAML 解析器，
 * 宿主（`@deepseek-ai/cordis` / `dsh-config-editor`）也没有暴露可复用的解析 API。
 * 因此这里实现一个**严格受限**的子集：越界一律报错，绝不猜测。
 *
 * 支持：
 *   · 注释：**整行** `#`，或**值后**的 ` # 注释`（井号前后都是空白/行尾才算注释；
 *     `真机 #1132` 这种"井号后紧跟非空白"的写法是**正文**，见 `isCommentHash`）；单文档
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

/**
 * **键的引号解包**（DEF-003 修法，读端一侧）。
 *
 * 为什么必须有：写端 `quoteIfNeeded` 对**必须加引号**的键（`NEEDS_QUOTE` 首项就是减号，
 * 如 CSS 令牌 `--sdo-accent`）会加单引号；而读端过去见引号即放弃、把整行当标量读走
 * ⇒ 带引号键的真源**整份读不回**（DEF-003）。修法只补读端对引号键的识别，
 * 让两端成为同一口径的两端 —— **不改写端**（把减号开头的键写成不带引号会让 YAML 本身歧义，
 * 那是掩盖不是修复）。
 *
 * 引号与转义规则**复用 `parsePlainOrQuoted`**（单引号 `''` ⇒ `'`；双引号走 JSON 转义），
 * 不在这里另写第二套 —— 两处口径必须同源。
 *
 * 返回 `undefined` = 不是「引号包裹的键」（含未闭合、闭引号后既非引号也非「冒号+空格/行尾」）。
 */
function unwrapQuotedKey(text: string): string | undefined {
  const first = text[0]
  if (first !== "'" && first !== '"') {
    // **plain 键**：原口径逐字保留（方括号/引号/注释符等仍视为值）
    return /[[\]{}'",#&*!|>%@`]/.test(text) ? undefined : text
  }
  // 单引号自转义（`''`），双引号用 `\` ⇒ 找闭引号时都要跳过转义位
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]
    if (first === "'" && ch === "'" && text[i + 1] === "'") {
      i++
      continue
    }
    if (first === '"' && ch === '\\') {
      i++
      continue
    }
    if (ch !== first) continue
    const after = text.slice(i + 1)
    if (after !== '' && !after.startsWith(': ')) return undefined
    return parsePlainOrQuoted(text.slice(0, i + 1), 0) as string
  }
  return undefined
}

/**
 * **起始引号在 `start` 处时，对应闭引号的下标**（找不到 ⇒ `undefined`）。
 *
 * 转义口径与 `unwrapQuotedKey` **同源**（这是它存在的唯一理由）：
 *   · 单引号：`''` 是转义的自转义，要整对跳过；
 *   · 双引号：`\` 转义下一个字符（`\"` 不是闭引号、`\\` 也不是）。
 * 抽成一处是为了让"哪里是闭引号"只有一个答案 —— `splitKey`（找键的边界）与
 * `unwrapQuotedKey`（解键的值）若各写一份，DEF-003/DEF-061 这类"两端不同口径"的病会再犯一次。
 */
function closingQuoteIndex(text: string, start: number): number | undefined {
  const quote = text[start]
  if (quote !== "'" && quote !== '"') return undefined
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (quote === "'" && ch === "'" && text[i + 1] === "'") {
      i++
      continue
    }
    if (quote === '"' && ch === '\\') {
      i++
      continue
    }
    if (ch === quote) return i
  }
  return undefined
}

/**
 * 判断一段文本是否像一个键值对的开头（键为 plain 标量或**引号包裹的键**，冒号后跟空格或行尾）。
 *
 * **DEF-003 → REV-041 / DEF-061 的因果**（为什么必须加"跳过引号段"这一个扫描态）：
 *   · DEF-003 只堵住了**一个触发字符** —— 键以减号开头（CSS 令牌 `--sdo-accent`）：写端
 *     `quoteIfNeeded` 会给它加单引号后，读端在 `unwrapQuotedKey` 里认了引号键，于是那一类通了；
 *   · 但**本函数**（`splitKey`）的扫描循环仍不知道"引号段"这回事：它在**引号内**照样把
 *     `:` / `#` 当分隔与注释判定，并且**不加区分**地把任何含 `\` 的行判成"不是键值对"。
 *     于是写端会加引号的其它触发支（键内含「冒号+空格」/「空格+井号」/ 含反斜杠或转义引号）
 *     就**没有逐支对齐**：`'a\b': 1`、`"a\"b": 1` 这类**合法 YAML** 会被判成"不是键值对"⇒ 整行当标量，
 *     再往下就报「引号字符串没有闭合」（真源读不回）。
 *   · 教训（`tq_097f952f`/`tq_097f952d`）：**只堵报告里那一个复现手法不算修** —— 两端必须逐支对齐。
 *
 * 修法只加**一个扫描态**：读到起始引号即跳到对应闭引号（单引号按 `''` 自转义、双引号按 `\` 转义），
 * 引号段内的 `:` / `#` / `\` **不参与**分隔与注释判定。**不动**值解析、缩进、列表、流式集合 ——
 * 那几处各有自己的引号处理（`parsePlainOrQuoted` / `stripInlineComment`），本函数只管"键在哪里结束"。
 */
function splitKey(text: string, lineNo?: number): { key: string; rest: string | undefined } | undefined {
  // **流式集合/序列**（`{...}` / `[...]`）由 `parseValueToken` 处理，本函数只负责"块映射的键在哪里结束"
  // ⇒ 这些形态里的 `:` 不是块映射的分隔符，DEF-061 的可读拒绝**不适用于它们**（否则 `- { id: X }`
  // 这种既有写法会被误杀）。这是本轮实测出来的边界。
  const flowish = /^[{[]/u.test(text)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    // **引号段跳过**（本卡新增的唯一扫描态）：起始引号 ⇒ 一路跳到它的闭引号。
    // 不闭合、或找不到闭引号 ⇒ 交给 `unwrapQuotedKey` 的既有口径去判（这里只跳过，不越权下结论）。
    if (ch === "'" || ch === '"') {
      const closing = closingQuoteIndex(text, i)
      if (closing === undefined) {
        // **DEF-061 残余面**：引号没闭合。若这一行**长得就是键值对**（后面还有 `: `），
        // 那它就是"键里含引号却被裸写"⇒ 可读拒绝；否则（如标量 `don't stop`）照旧当标量。
        if (!flowish && lineNo !== undefined && /:\s|:$/u.test(text.slice(i + 1))) {
          throw new YamlSubsetError(
            lineNo,
            `键「${text.slice(0, Math.max(i, text.search(/:\s|:$/u))).trim()}」里含 ${ch} 却没有按引号键写 ——`
            + '裸键里的引号读端不认，整行会被静默当成字符串；请写成 `\'键\': 值`（键里的单引号用两个单引号自转义）',
          )
        }
        return undefined
      }
      i = closing
      continue
    }
    // **行内注释**（` # 注释`）只可能出现在引号之外 —— 引号段已经整段跳过了。
    if (ch === '#' && isCommentHash(text, i)) return undefined
    if (ch === ':' && (i + 1 === text.length || text[i + 1] === ' ')) {
      const rawKey = text.slice(0, i).trim()
      const key = unwrapQuotedKey(rawKey)
      // **DEF-061 残余面（第三批 §3.18）**：这一行**长得就是键值对**（有 `: ` 分隔），却因为裸键里夹着
      // 读端不认的字符而对不上 —— 旧口径在这里 `return undefined`，上层于是把**整行当标量**读走：
      // 写得出、读不回，而且**一声不响**（本项目最忌讳的形态）。既然写读两端的合法面已经对齐
      //（写端 `quoteKeyIfNeeded` 对这些键一定加引号），手写成裸形态就是**真错** ⇒ 可读拒绝并给修法。
      // 只在调用方给了行号时抛（`splitKey` 也被内联集合的扫描复用过，那里没有行号语义）。
      if ((key === undefined || key === '') && !flowish && lineNo !== undefined && rawKey !== '' && NEEDS_QUOTE_KEY.test(rawKey)) {
        throw new YamlSubsetError(
          lineNo,
          `键「${rawKey}」里含必须加引号的字符（${rawKey.match(new RegExp(NEEDS_QUOTE_KEY.source, 'gu'))?.join(' ') ?? ''}）——`
          + '裸键里的这些字符读端不认，整行会被静默当成字符串；请写成 `\'键\': 值`（写端对这类键一律加引号）',
        )
      }
      if (key === undefined || key === '') return undefined
      const rest = i + 1 === text.length ? '' : text.slice(i + 2).trim()
      return { key, rest }
    }
    // **plain 键里出现 `\` ⇒ 不是键值对**（原口径保留）：裸键不允许反斜杠。
    // 引号段已经在上面 `continue` 掉了，所以"引号内的反斜杠"不会再被这一条误杀 ——
    // 这正是 REV-041 主发现（`'a\b': 1` 被拒）与发现 7（`"a\"b": 1` 被拒）的共同根因。
    if (ch === '\\') {
      // `\` 在裸键里同样不被认（既有口径）：若这一行确实是「键: 值」形态 ⇒ 可读拒绝而不是静默降级
      if (!flowish && lineNo !== undefined && /:\s|:$/u.test(text.slice(i))) {
        throw new YamlSubsetError(
          lineNo,
          `键「${text.slice(0, text.indexOf(':')).trim()}」里含反斜杠 —— 裸键不允许反斜杠（读端会拒认，整行被静默当成字符串）；`
          + '请写成 `\'键\': 值`',
        )
      }
      return undefined
    }
  }
  return undefined
}

/**
 * **`#` 在什么位置才算行内注释**（D-23 的真根因，写读两端必须同一口径）。
 *
 * 病根（真机）：写端 `NEEDS_QUOTE` 只在"`#` 后面还有空白"时给值加引号，所以
 * `真机 #1132 复现` 这种（井号后紧接非空白）被当作**安全裸值**写出；而读端旧口径
 * **只要井号前面是空格就当注释** ⇒ 读回时被**静默截断**成 `真机`。
 * 后果：① 评审 `reviewContentHash` 写读不等 ⇒ 每条含该写法的评审被判"被改过"（D-23 报的就是这条，
 * 只是把根因记成了"两套哈希口径"）；② 任何台账文本（需求陈述、验收标准、证据）在**下一次写回**时
 * 会把截断后的内容**固化**失（本项目最忌讳的"静默丢内容"）。
 *
 * 现在的口径（两端一致）：
 *   · 整行注释：行首（可含缩进）的 `#`；
 *   · 值后注释：`#` 前是空白**且** `#` 后是空白或行尾（即 ` # 注释` 这种约定写法）；
 *   · 其余（` #1132`、`\t#TODO`、结尾的 ` #`）**是正文**，一律保留 —— 写端会给它们加引号，
 *     手写的这类值也不会再被吃掉。
 */
function isCommentHash(text: string, i: number): boolean {
  if (i === 0) return true
  const before = text[i - 1]
  if (before !== ' ' && before !== '\t') return false
  const after = text[i + 1]
  return after === undefined || after === ' ' || after === '\t'
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
    if (ch === '#' && isCommentHash(text, i)) {
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
    if (splitKey(line.content, line.lineNo) !== undefined) return this.parseMap(indent)
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
      const split = splitKey(line.content, line.lineNo)
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
      const split = splitKey(rest, line.lineNo)
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
        const contSplit = splitKey(cont.content, cont.lineNo)
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

/**
 * 裸值什么时候**必须**加引号（写端唯一的判定，读端 `parsePlainOrQuoted` 是它的逆）。
 *
 * **D-23**：原式只覆盖"`#` **后面**还有空白"（`.*[:#]\s`），漏掉"**前面**是空白的井号"
 * （`.*\s#`）—— 于是 `真机 #1132 复现`、结尾的 ` #` 这类值被裸写出去，
 * 而读端旧口径把 ` #` 一律当注释剥掉 ⇒ **读回被截断**。两端同源是这条常量的全部意义：
 * 加一个分支就要能说清"读端为什么不会误解它"。
 */
const NEEDS_QUOTE = /^(?:[-?:,[\]{}#&*!|>%@`'"]|.*[:#]\s|.*\s#|.*\s$)/s
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
 * **键**的合法面（DEF-061 残余面 / 第三批 §3.18）—— 与 `NEEDS_QUOTE` 分开是**故意的**。
 *
 * 病根（现盘实测）：读端 `unwrapQuotedKey` 对**裸键**的合法面是"不含
 * `[ ] { } ' " , # & * ! | > % @ \`` 中任一字符"，而写端 `quoteIfNeeded` 只在**起始位置**命中
 * 这类字符时才加引号、`\` 更是**完全不查**（`NEEDS_ESCAPE_QUOTE` 只作用于**值**）
 * ⇒ 键里**夹着**这些字符时（`a#b` / `a,b` / `a\b` / `a"b` / `a'b`）**写得出、读不回**：
 * 读端 `splitKey` 返回 undefined ⇒ 整行被**静默读成字符串**（既不报错也不还原）。
 *
 * 口径 = **写读对称**：读端不认的裸形态，写端就必须加引号。所以键的判定要比值**严**：
 * 只要**任意位置**出现上面那组字符就加引号（值不受影响 —— 值里的 `,`/`#`（非注释位）本身是合法的，
 * 动它会把大批既有往返形态一起改掉，那是另一件事）。
 */
const NEEDS_QUOTE_KEY = /[\[\]{}'",#&*!|>%@`\\]/u

function quoteKeyIfNeeded(key: string): string {
  if (key !== '' && !NEEDS_QUOTE_KEY.test(key)) return quoteIfNeeded(key)
  return `'${key.replace(/'/g, "''")}'`
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
    const keyText = quoteKeyIfNeeded(key) + ':'
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
