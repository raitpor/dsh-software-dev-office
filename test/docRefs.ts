/**
 * **`DEF-088`（第八批 §3.3）—— "引用"的机械判据。**
 *
 * 旧判据只有一句"行里同时出现 `理由记在|结论记在|详见` 与 `DEF-\d+`" ⇒ V16 实测它**既不充分也不必要**：
 *   · **假阳性**：一条**完全合法**的引用（实体确实存在）也会红；
 *   · **语言相关**：英文悬空引用**漏判**（与"语言无关"长期约束相抵）；
 *   · **只认证词**：保留措辞、抽掉真正的结论 ⇒ 仍绿。
 *
 * 新判据**只认标识符与结构标记，不认自然语言措辞**（因此中英文行为一致）：
 *   ① **解析性**（`dangling-id`）：凡是**标识符引用**（`DEF-123`，或 `` `test/docRefs.ts` `` 的 `` `checkDocs` ``）都必须
 *      **在扫描面里别处可解析** —— **引用自己那一行不算**（两条支路同口径：`DEF-` 号支路与符号支路）。
 *      ⇒ 引一个不存在的实体必红，引一个真存在的实体不红。
 *      符号引用的"被指符号"取**结构上最近的那一个**（路径 token **之后**最近的标识符 token，见 `symbolAfter`，
 *      **只向右、至多 1 个**），**不再是**"引用行里所有反引号词"（`DEF-091`：那种口径下，行里多写一个真词就能喂饱真悬空）。
 *   ② **承载性**（`missing-carrier` / `empty-quote` / `quote-mismatch`）：凡把**结论委托给别处**的写法，
 *      必须用**结构标记**登记，且**逐字携带**载体的结论：
 *        · 引用方：`sdo:ref <id>` + `sdo:quote:begin` … `sdo:quote:end`
 *        · 载体方：`sdo:carrier <id>` … `sdo:carrier-end`
 *      ⇒ 载体不存在、引文为空、引文与载体**不逐字相等**（= 保留措辞但掏空语义）三种都红。
 *
 * **为什么这不是"关键词匹配"**：判据里**没有任何自然语言词表** —— 它比的是①标识符的**可解析性**、
 * ②被结构标记括起来的**两段文本是否逐字相等**（先做语言中立的归一：去注释符、折叠空白）。
 * 同一条判据对中文与英文写入**给出同一个判定**（`test/m189` 的两格夹具实测）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface DocText { path: string; text: string }
export interface DocRefIssue { kind: 'dangling-id' | 'missing-carrier' | 'empty-quote' | 'quote-mismatch'; path: string; detail: string }

const QUOTE_BEGIN = 'sdo:quote:begin'
const QUOTE_END = 'sdo:quote:end'
const CARRIER_BEGIN = 'sdo:carrier'
const CARRIER_END = 'sdo:carrier-end'
const REF = 'sdo:ref'

/** 语言中立的归一：去掉行首注释符、折叠空白。**只看字形，不看语言。** */
export function normalizeNote(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*(\*|\/\/|\/\*)\s?/u, '').trim())
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

interface Block { id: string; body: string; at: number }

function blocksOf(text: string, begin: string, end: string): Block[] {
  const out: Block[] = []
  const lines = text.split('\n')
  let start = -1
  let id = ''
  for (const [index, line] of lines.entries()) {
    if (start < 0 && line.includes(begin)) {
      start = index
      const tail = line.slice(line.indexOf(begin) + begin.length).trim()
      const sameLine = tail.endsWith(end) ? tail.slice(0, tail.length - end.length).trim() : ''
      id = sameLine !== '' ? sameLine : tail
      if (sameLine !== '') {
        out.push({ id, body: '', at: index })
        start = -1
      }
      continue
    }
    if (start >= 0 && line.includes(end)) {
      out.push({ id, body: normalizeNote(lines.slice(start + 1, index).join('\n')), at: start })
      start = -1
    }
  }
  return out
}

export interface Citation {
  id: string
  kind: 'defect' | 'symbol'
  line: number
  path?: string
  symbol?: string
  /** **结构候选**：路径 token **之后**最近的那一个标识符（**只向右、至多 1 个**）。解析只需它命中。 */
  candidates?: string[]
  raw?: string
}

/** 引用两侧的**结构间隔**上限（去空白与反引号后的字符数）：更远的标识符不算"结构上被指为符号"。 */
export const CITATION_GAP_MAX = 6

const PATH_TOKEN = /^[\w./-]+\.ts$/u
const ID_TOKEN = /^[A-Za-z_$][\w$]*$/u

interface Token { text: string; start: number; end: number }

/** 一行里的所有反引号 token（记内容与**内容**在行内的起止位置）。 */
function tokensIn(line: string): Token[] {
  const out: Token[] = []
  for (const match of line.matchAll(/`([^`]*)`/gu)) {
    const text = match[1] as string
    const start = (match.index ?? 0) + 1
    out.push({ text, start, end: start + text.length })
  }
  return out
}

/** 两个 token 之间的间隔文本（去空白与反引号）—— 判"结构上是否绑在一起"只看它，不看任何词。 */
function gapText(line: string, a: Token, b: Token): string {
  const [left, right] = a.start <= b.start ? [a, b] : [b, a]
  return line.slice(left.end, right.start).replace(/[\s`]/gu, '')
}

/**
 * **结构上被指为符号的那一个**：路径 token **之后**最近的标识符 token，且
 *   · 两侧之间**不许夹第二个路径 token**（`records.ts:199` 那种"并列文件清单 + 后面另起一句"不是引用；
 *     `collab.ts` 里 `` `src/a.ts` `` × `` `src/a.tsx` `` 这种"举例"也不是）；
 *   · 间隔不许超过 `CITATION_GAP_MAX`（`reviewDoc.ts:469` 里那句散文里的命令名 `tsc` 就是被这条挡掉的）。
 * 于是"行里别处多写一个真词"**再也喂不饱**真悬空（`DEF-091` 的 S2/S3 同判）。
 *
 * **故意不认证的形态**（豁免面，见第九批 §8）：符号写在路径**之前**的写法（`sym` 从 `file.ts` 取）
 * 一律不认证 —— 中文与英文都常把主语放在前面（"`environment` 在 `design.ts`"），
 * 认它会把 5 条**举例性**路径当成引用（第九批判据实测）；代价是这类写法里的真悬空漏判。
 */
function symbolAfter(line: string, tokens: readonly Token[], index: number): string[] {
  const anchor = tokens[index] as Token
  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i] as Token
    if (PATH_TOKEN.test(token.text)) return []
    if (!ID_TOKEN.test(token.text)) continue
    return gapText(line, anchor, token).length <= CITATION_GAP_MAX ? [token.text] : []
  }
  return []
}

/** **标识符引用**（只认结构：`DEF-数字` 与 `` `路径` `` 的 `` `符号` `` 两种形态；不认任何措辞）。 */
export function citationsIn(text: string): Citation[] {
  const out: Citation[] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    // ⚠️ 只认**本仓缺陷号的形态**（三位起：台账是 `DEF-001`…）：`DEF-1`/`DEF-2` 这种是散文里的
    // **示例/占位符**（真机现场：`// 逐卡列出声明：\`TASK-xxx → DEF-1, DEF-2\``）—— 形态判定，与语言无关。
    for (const match of line.matchAll(/\bDEF-\d{3,}/gu)) out.push({ id: match[0], kind: 'defect', line: index + 1 })
    // `test/docRefs.ts` 的 `checkDocs` 这种写法（被指符号 = 路径 token **之后**最近的标识符 token，见 `symbolAfter`）
    const tokens = tokensIn(line)
    for (const match of line.matchAll(/`([\w./-]+\.ts)`/gu)) {
      const file = match[1] as string
      const at = (match.index ?? 0) + 1
      const tokenIndex = tokens.findIndex((token) => token.start === at && token.text === file)
      if (tokenIndex < 0) continue
      const candidates = symbolAfter(line, tokens, tokenIndex)
      if (candidates.length === 0) continue
      const symbol = candidates[0] as string
      out.push({ id: `${file}#${symbol}`, kind: 'symbol', line: index + 1, path: file, symbol, candidates, raw: line })
    }
  }
  return out
}

/**
 * 判定的两个面**必须分开**（第一版混在一起 ⇒ 把任务书里的示例号 `DEF-999` 也当成悬空引用误报）：
 *   · **引用面**（`docs`）：**要policed 的引用**在这里 —— 我们只patrol `src/**\/*.ts` 的注释；
 *   · **见证面**（`witnesses`）：判"这个号还能在哪被读到"的语料 —— `src/` + `docs/` 全文（含历史任务书）。
 * 两面都是**结构**判定（标识符是否出现），不读任何措辞 ⇒ 与语言无关。
 */
export function checkDocs(docs: readonly DocText[], witnesses: readonly DocText[] = docs): DocRefIssue[] {
  const issues: DocRefIssue[] = []
  const carriers = new Map<string, Block>()
  for (const doc of witnesses) {
    for (const block of blocksOf(doc.text, CARRIER_BEGIN, CARRIER_END)) carriers.set(block.id, block)
  }
  // ① 解析性：标识符引用必须**别处**可解析
  //
  // 两种形态的解析口径不同（都是**结构**判定，不看措辞）：
  //   · `DEF-123`：要求扫描面里**别处**再出现一次（引用自己那一行不算）—— 只在唯一一行里出现的号 = 悬空；
  //   · `` `path` 的 `symbol` ``：要求**被指的那个文件真的含这个符号名**（不是"这个拼接串出现过两次"）。
  for (const doc of docs) {
    for (const citation of citationsIn(doc.text)) {
      if (citation.kind === 'symbol') {
        // **候选口径（`DEF-091` 起）**：只认**结构上最近的那一个**标识符 token（`citation.candidates`
        // 由 `symbolAfter` 按"无第二个路径 token + 间隔 ≤ `CITATION_GAP_MAX`"选出，**只向右、至多 1 个**），
        // 不再是"引用行里所有反引号词" —— 后者会让行里别处一个真词把真悬空喂饱（S2 绿 / S3 红，同形不同判）。
        const target = witnesses.find((other) => other.path.endsWith(citation.path as string))
        const candidates = citation.candidates ?? [citation.symbol as string]
        // **`DEF-096`（第十批 §3.1）**：`DEF-` 号支路早有"引用自己那一行不算"，符号支路此前没有 ⇒
        // 把引用写在**被指文件自己**里时**恒可解析**（自解析）。现在同口径：引用那一行**不算数**，
        // 必须在**别的行**上还能找到这个符号（真存在的符号写在文件自己里照样绿，见 `test/m189`）。
        const haystack = target === undefined
          ? ''
          : doc.path === target.path
            ? target.text.split('\n').filter((_line, at) => at + 1 !== citation.line).join('\n')
            : target.text
        const found = target !== undefined
          && candidates.some((name) => new RegExp(`\\b${name}\\b`, 'u').test(haystack))
        if (!found) issues.push({ kind: 'dangling-id', path: doc.path, detail: `${citation.id}（第 ${citation.line} 行）指向的定义查无实体` })
        continue
      }
      const elsewhere = witnesses.some((other) => {
        const hits = citationsIn(other.text).filter((item) => item.id === citation.id)
        if (other.path !== doc.path) return hits.length > 0
        return hits.length > 1   // 同一文件：引用自己那一行不算
      })
      if (!elsewhere) issues.push({ kind: 'dangling-id', path: doc.path, detail: `${citation.id}（第 ${citation.line} 行）在扫描面里别处查无此号` })
    }
  }
  // ② 承载性：结构化委托必须带逐字引文，且载体真的在
  for (const doc of docs) {
    const refIds = [...doc.text.matchAll(new RegExp(`${REF}\\s+([^\\s*]+)`, 'gu'))].map((match) => match[1] ?? '')
    const quotes = blocksOf(doc.text, QUOTE_BEGIN, QUOTE_END)
    for (const [index, id] of refIds.entries()) {
      const carrier = carriers.get(id)
      if (carrier === undefined) {
        issues.push({ kind: 'missing-carrier', path: doc.path, detail: `${REF} ${id} 在扫描面里找不到 ${CARRIER_BEGIN} ${id} 载体` })
        continue
      }
      const quote = quotes[index]
      if (quote === undefined || quote.body === '') {
        issues.push({ kind: 'empty-quote', path: doc.path, detail: `${REF} ${id} 没有逐字引文（${QUOTE_BEGIN}…${QUOTE_END} 为空或缺失）` })
        continue
      }
      if (quote.body !== carrier.body) {
        issues.push({ kind: 'quote-mismatch', path: doc.path, detail: `${REF} ${id} 的引文与载体结论不逐字相等（保留措辞但掏空语义就会落在这里）` })
      }
    }
  }
  return issues
}

/** 便捷入口：按路径读文件后判定（只读）。 */
export function checkDocFiles(files: readonly string[], witnessFiles: readonly string[] = files): DocRefIssue[] {
  const load = (paths: readonly string[]): DocText[] => paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  return checkDocs(load(files), load(witnessFiles))
}

/** 现盘的两个面：**引用面** = `src/**\/*.ts`；**见证面** = 它 + `docs/**\/*.md`（两处调用点共用，避免各写一份 walk）。 */
export function repoDocFaces(root: string): { citations: string[]; witnesses: string[] } {
  const walk = (dir: string, ext: string, out: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, ext, out)
      else if (entry.name.endsWith(ext)) out.push(full)
    }
  }
  const citations: string[] = []
  const witnesses: string[] = []
  walk(join(root, 'src'), '.ts', citations)
  witnesses.push(...citations)
  walk(join(root, 'docs'), '.md', witnesses)
  return { citations, witnesses }
}
