/**
 * 命令行的**分词解析器**（一次扫描，token 化后再统一解析）。
 *
 * 为什么要有这个模块（2026-09-30 的真实缺陷）：
 *   旧实现是"先用正则找 `--key=value`，找不到再回退到**裸 `key=value`** 扫描"。
 *   回退路径按 token 找 `k=v`，于是 `/sdo-budget --decide --note choice=waive` 里
 *   `choice=waive` 会被**同时**认成 `choice` 选项 —— 自由文本值里恰好含同命令别的
 *   `k=v` 时，那条自由文本就被静默篡改成选项 ✗。
 *
 * 现在改成**真正的分词 + 单遍状态机**：
 *   ① {@link tokenize} 一次扫描切 token，尊重 `"…"` / `'…'`（引号内空白不切分、引号剥掉、
 *      记下"这个 token 整体被引号包住"），`--` 之后的一切都是位置参数；
 *   ② {@link parseArgv} 单遍解析：**纯布尔开关**（`flagNames` 里写 `'--name'`）不吞下一个
 *      token，取值开关（写 `'name'`）取一个值（`--k=v` 或 `--k v`），未声明的裸 `k=v`
 *      （**没被引号包住**、不以 `-` 开头）作为历史写法被认领。
 *
 * **向后兼容**（既有 179 个用例是硬门槛）：
 *   `--k=v`、`--k v`、裸 `k=v` 三种形态行为与旧实现一致；`--flag=false` / `--flag false`
 *   仍算"关"，`--flag` 算"开"；`--xchoice=waive`（前缀相似）不是 `choice`；
 *   引号里的 `choice=waive` 是**值/位置参数**，不是选项。
 *
 * **诚实的边界（做不到的就说清楚）**：空格写法下 `--note 见 choice=waive` 里的
 * `choice=waive` 是**独立 token**，只能被当成历史裸 `k=v` 认领 —— 多词自由文本
 * **必须加引号**（`--note "见 choice=waive"`）才是那一个值。这是命令行本身的歧义，
 * 不是可以靠"更聪明的猜测"解决的；本模块不做任何猜测。
 */

/** 解析结果（`option()` / `flag()` 都建立在这份结构上）。 */
export interface ParsedArgv {
  /** 出现过的开关名（`--flag` 与 `--flag=true` 都算出现；`--flag=false` 也会在这里，值见 {@link bools}） */
  flags: Set<string>
  /** 显式布尔值：`--flag=false` → `false`（用于把"出现"与"取值"分开） */
  bools: Map<string, boolean>
  /** 取值选项（`--k=v` / `--k v` / 裸 `k=v`）；显式写法优先于裸写法，同类**先到先得** */
  options: Record<string, string>
  /** `--` 之后的内容（以及没有归属的裸 token） */
  positionals: string[]
}

/** 一个 token 以及它是否"整体被引号包住"。 */
export interface Token {
  text: string
  quoted: boolean
}

// 开关名**不能**以 `-` 开头：`--decide` 的名字是 `decide`（不是 `-decide`），
// `---x=1` 整段非法（与旧实现一致，不把第三个 `-` 当名字的一部分）。
const OPTION_TOKEN = /^--([^-=\s][^=\s]*)(?:=([\s\S]*))?$/u
const BARE_TOKEN = /^([^-=\s][^=\s]*)=([\s\S]*)$/u

/**
 * 把 `raw` 切成 token。
 *
 * 规则：
 *   · `"…"` / `'…'` 内的空白不切分，引号本身剥掉，token 标记为 `quoted`；
 *   · `\` 在引号内转义下一个字符（`\"` 不会提前闭引号）；引号外不特殊处理（Windows 路径不受影响）；
 *   · `--` 单独成 token 时，其后的所有 token 都标记为 `quoted: true`（= 不再是 `k=v` 候选），
 *     交给 {@link parseArgv} 全部当位置参数；
 *   · 空 token（连续空白、空引号）直接丢弃。
 */
export function tokenize(raw: string): Token[] {
  const tokens: Token[] = []
  let text = ''
  let quoted = false
  let has = false
  let quote: string | undefined
  let escape = false
  let afterDashDash = false
  const flush = (): void => {
    // 空 token（连续空白、空引号 `""`）丢弃
    if (has && text !== '') tokens.push({ text, quoted: quoted || afterDashDash })
    text = ''
    quoted = false
    has = false
  }
  for (let at = 0; at < raw.length; at += 1) {
    const ch = raw[at]!
    if (quote !== undefined) {
      if (escape) {
        text += ch
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === quote) {
        quote = undefined
        continue
      }
      text += ch
      has = true
      continue
    }
    if (ch === '"' || ch === "'") {
      // `--name="a b"`：等号后面紧跟引号，引号**属于值**而不是独立 token。
      // 若不在此处吃掉它，`--name="a` 会成为一个 token、`b"` 成为位置参数（值被切碎）。
      if (text.startsWith('--') && text.endsWith('=')) {
        quote = ch
        has = true
        continue
      }
      quote = ch
      has = true
      quoted = true
      continue
    }
    if (/\s/u.test(ch)) {
      flush()
      continue
    }
    if (ch === '-') {
      if (text === '' && !has && !quoted) {
        text = '-'
        has = true
        continue
      }
      if (text === '-' && !has && !quoted) {
        // 恰好 `--`：本 token 结束，之后的一切都是位置参数。
        // **绝不能**把 `--name` 的第 2 个 `-` 当分隔符 —— 那会把 `--decide` 切成
        // `-` + `decide`，整条命令的选项全部失效（实测：M9/M10 全红）。
        flush()
        afterDashDash = true
        has = true
        quoted = true
        text = '--'
        continue
      }
      text += ch
      has = true
      continue
    }
    text += ch
    has = true
  }
  flush()
  return tokens
}

/** 落一个值：`explicit`（`--k=v` / `--k v`）优先于裸 `k=v`，同类则**先到先得**。 */
function assign(options: Record<string, string>, explicit: Set<string>, name: string, value: string, fromFlag: boolean): void {
  if (value === '') return
  const already = options[name]
  if (already !== undefined && (explicit.has(name) || !fromFlag)) return
  options[name] = value
  if (fromFlag) explicit.add(name)
  else explicit.delete(name)
}

/**
 * 单遍解析：先切 token，再按"声明的开关不吞值、其余 `--k` 吞一个值"的规则归类。
 *
 * `flagNames` 是**该命令声明的开关名**，两种写法故意区分开：
 *   · `'decide'`（不带前缀）→ 该开关**可以**取一个值（`--puml custom/x.puml`），
 *     不取值的 `--puml` 仍然算"出现"（真假由调用方决定）；
 *   · `'--decide'`（带 `--` 前缀）→ **纯布尔开关**，`--decide` 后面的 token 一律独立，
 *     不吞也不认领 —— 这正是"自由文本值不被篡改"的关键（`--decide --note choice=waive`
 *     里的 `choice=waive` 只能是 `--note` 的值）。
 * 形如 `--sw=true|false` 的 token 一律算开关（不静默变成字符串选项）。
 */
export function parseArgv(raw: string, flagNames: readonly string[] = []): ParsedArgv {
  const tokens = tokenize(raw)
  const flags = new Set<string>()
  const bools = new Map<string, boolean>()
  const options: Record<string, string> = {}
  // 哪些键的值来自**显式开关**（`--k=v` / `--k v`）—— 它们优先于裸 `k=v`，且与顺序无关
  const explicit = new Set<string>()
  const positionals: string[] = []
  const declared = new Map<string, boolean>()
  for (const name of flagNames) {
    declared.set(name.startsWith('--') ? name.slice(2) : name, !name.startsWith('--'))
  }
  let afterDashDash = false

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at]!
    if (afterDashDash) {
      positionals.push(token.text)
      continue
    }
    if (token.text === '--' && !token.quoted) {
      // `--` 之后的一切都是位置参数（tokenizer 已把后续 token 标为 quoted）
      afterDashDash = true
      continue
    }
    if (token.quoted) {
      // 引号包住的 token：**只有当它确实是某个开关的值时**才被吃成值（`--note "a b c"`），
      // 否则它一律是**位置参数**（`"choice=waive"` 不能被认成选项 —— 那是旧实现的静默篡改点；
      // `"en"` 与 `/sdo-lang en` 也必须等价）。判据只看**紧邻的上一个 token**：
      const owner = at === 0 ? undefined : tokens[at - 1]!
      const ownerForm = owner === undefined || owner.quoted ? null : OPTION_TOKEN.exec(owner.text)
      const ownerName = ownerForm?.[1]
      const ownerIsValueOption = ownerName !== undefined && ownerForm?.[2] === undefined && declared.get(ownerName) !== false
      if (ownerIsValueOption) {
        assign(options, explicit, ownerName, token.text, true)
        continue
      }
      positionals.push(token.text)
      continue
    }
    const asOption = OPTION_TOKEN.exec(token.text)
    if (asOption !== null) {
      const name = asOption[1]!
      const value = asOption[2]
      if (value !== undefined) {
        if (declared.has(name) && (value === 'true' || value === 'false')) {
          bools.set(name, value === 'true')
          if (value === 'true') flags.add(name)
          continue
        }
        assign(options, explicit, name, value, true)
        continue
      }
      const next = tokens[at + 1]
      if (declared.has(name) && next !== undefined && !next.quoted && (next.text === 'true' || next.text === 'false')) {
        bools.set(name, next.text === 'true')
        if (next.text === 'true') flags.add(name)
        at += 1
        continue
      }
      const takesValue = declared.get(name)
      if (takesValue === false) {
        // 纯布尔开关：**不吞下一个 token**（`--decide choice=waive` 的 `choice=waive` 因此保持独立）
        flags.add(name)
        continue
      }
      if (next !== undefined && !next.quoted && !next.text.startsWith('--')) {
        // `--k v`：吃下一个 token 当值（`--k=v` 已在上面的 value 分支处理）。
        // 下一个 token 若是**引号 token**，这里不处理 —— 交给循环体顶部的 quoted 分支
        //（它会用 `tokens[at-1]` 认出本开关），这样空白与 `=` 都能原样保留。
        assign(options, explicit, name, next.text, true)
        at += 1
        continue
      }
      // 开关出现但没给值：记为"出现"（`--puml` = 默认落点），旧实现的 `option()` 仍返回 undefined
      if (takesValue === true) flags.add(name)
      // 未声明的 `--name` 没有取值：旧实现此时 `option()` 返回 undefined，这里保持一致（不记空值）
      continue
    }
    const asBare = BARE_TOKEN.exec(token.text)
    if (asBare !== null && !token.text.startsWith('-')) {
      // 历史形态：裸 `k=v`。键必须非空、值必须非空（与旧 `bareOption` 一致）
      assign(options, explicit, asBare[1]!, asBare[2]!, false)
      continue
    }
    positionals.push(token.text)
  }
  return { flags, bools, options, positionals }
}

/**
 * 在解析结果之上取值的**只读**门面（命令处理函数只依赖它，不直接翻结构）。
 *
 * 取名沿用旧实现的 `option()` / `textOption()` / `flag()`，因此调用点的写法一字未改。
 */
export class ArgvReader {
  private readonly parsed: ParsedArgv

  constructor(parsed: ParsedArgv) {
    this.parsed = parsed
  }

  /** 一键解析：`ArgvReader.of(raw, ['decide','set'])`。 */
  static of(raw: string, flagNames: readonly string[] = []): ArgvReader {
    return new ArgvReader(parseArgv(raw, flagNames))
  }

  /** 取 `--k=v` / `--k v` / 裸 `k=v` 的值；没给（或给了空值）返回 undefined。 */
  option(name: string): string | undefined {
    return this.parsed.options[name]
  }

  /** 自由文本选项（与 {@link option} 同一套解析；保留旧名以免改动既有命令）。 */
  textOption(name: string): string | undefined {
    return this.option(name)
  }

  /** 数值选项（缺省或非数字都视为"未给"，由下游给出可读错误）。 */
  numberOption(name: string): number | undefined {
    const value = this.option(name)
    if (value === undefined) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  /** 布尔开关：`--flag` / `--flag=true` 为真，`--flag=false` / `--flag false` 为假。 */
  flag(name: string): boolean {
    const explicit = this.parsed.bools.get(name)
    if (explicit !== undefined) return explicit
    return this.parsed.flags.has(name)
  }

  /** 位置参数（`--` 之后的全部内容也在这里）。 */
  get positional(): string[] {
    return [...this.parsed.positionals]
  }

  /** 第一个位置参数（`/sdo-lang en` 这类单值命令用）。 */
  get first(): string | undefined {
    return this.parsed.positionals[0]
  }
}
