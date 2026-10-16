/**
 * **`DEF-088`（第八批 §3.3）—— "引用"的机械判据。**
 *
 * 旧判据只有一句"行里同时出现 `理由记在|结论记在|详见` 与 `DEF-\d+`" ⇒ V16 实测它**既不充分也不必要**：
 *   · **假阳性**：一条**完全合法**的引用（实体确实存在）也会红；
 *   · **语言相关**：英文悬空引用**漏判**（与"语言无关"长期约束相抵）；
 *   · **只认证词**：保留措辞、抽掉真正的结论 ⇒ 仍绿。
 *
 * 新判据**只认标识符与结构标记，不认自然语言措辞**（因此中英文行为一致）：
 *   ① **解析性**（`dangling-id`）：凡是**标识符引用**（`DEF-123`，或 `` `file.ts` `` 的 `` `symbol` ``）都必须
 *      **在扫描面里别处可解析** —— 引用自己那一行不算。⇒ 引一个不存在的实体必红，引一个真存在的实体不红。
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

export interface Citation { id: string; kind: 'defect' | 'symbol'; line: number; path?: string; symbol?: string; raw?: string }

/** **标识符引用**（只认结构：`DEF-数字` 与 `` `路径` `` 的 `` `符号` `` 两种形态；不认任何措辞）。 */
export function citationsIn(text: string): Citation[] {
  const out: Citation[] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    // ⚠️ 只认**本仓缺陷号的形态**（三位起：台账是 `DEF-001`…）：`DEF-1`/`DEF-2` 这种是散文里的
    // **示例/占位符**（真机现场：`// 逐卡列出声明：\`TASK-xxx → DEF-1, DEF-2\``）—— 形态判定，与语言无关。
    for (const match of line.matchAll(/\bDEF-\d{3,}/gu)) out.push({ id: match[0], kind: 'defect', line: index + 1 })
    // `path/to/file.ts` 的 `symbol`（两侧都是反引号包裹的标识符）
    for (const match of line.matchAll(/`([\w./-]+\.ts)`[^\n]*?`([A-Za-z_$][\w$]*)`/gu)) {
      const file = match[1] as string
      const symbol = match[2] as string
      out.push({ id: `${file}#${symbol}`, kind: 'symbol', line: index + 1, path: file, symbol, raw: line })
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
        // **候选口径**：一行里 `` `file.ts` `` 之后可能有**多个**反引号标识符（真机现场：注释里连着举好几个），
        // 抽取器不猜"哪个才是符号"⇒ 只要**任一候选**能在被指的文件里找到定义就不算悬空（仍然是结构判定）。
        const target = witnesses.find((other) => other.path.endsWith(citation.path as string))
        const candidates = [citation.symbol as string]
        if (target !== undefined) {
          for (const match of (citation.raw ?? '').matchAll(/`([A-Za-z_$][\w$]*)`/gu)) candidates.push(match[1] as string)
        }
        const found = target !== undefined
          && candidates.some((name) => new RegExp(`\\b${name}\\b`, 'u').test(target.text))
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
