/**
 * **`DEF-093`（第九批 §3.6）—— R19 清单的"抽取器 + 分类"机制。**
 *
 * 第八批的清单是**作者自报字段**（`readsProse: true/false` + 一句 `why`）⇒ V19 实测三处可骗：
 *   · 塞一条"真读文本却自报 false"的条目 ⇒ 全绿放过；
 *   · 豁免理由只靠 `length >= 12` ⇒ 灌水即豁免；
 *   · 自证格只做"整份文件里有一个汉字 + 一个 ≥4 字母英文词" ⇒ 任意文件（连现造的一行文件）都能冒充。
 *
 * 本模块把清单改成**抽取器列候选、作者只做分类**：
 *   ① `extractProseSites` 按**实际行为**列候选 —— 只要某条断言里出现**内联中文**（字符串或正则字面量），
 *      它就在册（自报字段因此再也躲不掉；作者谎报不产生任何效果）；
 *   ② 豁免**只能由谓词给出**：`classifySite` 判"这个中文串是不是语言包里的**取值**"（**逐字相等**才算），
 *      是 ⇒ 豁免（`label`）且理由必须带**可核 token = 语言包键路径**；不是 ⇒ 判 `prose`（自证或进已知缺口）；
 *   ③ 自证格改成**成对登记**（`PAIRED_PROOFS` 的每一条都要同时给中英两形态 + 一个**必须判不同的坏输入**）
 *      ⇒ "一行文件冒充"不成立：恒真的判据函数会被 `auditPairedProofs` 抓出来。
 *
 * 语言无关：判据只看**字形**（有没有汉字 / 串是否逐字等于语言包取值 / 键是否可取），没有任何词表。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { checkDocs } from './docRefs.js'

const CJK = /[\u4e00-\u9fff]/u
const STRING_CJK = /['"`]([^'"`\n]*[\u4e00-\u9fff][^'"`\n]*)['"`]/u
const REGEX_CJK = /\/((?:[^/\\\n]|\\.)*[\u4e00-\u9fff](?:[^/\\\n]|\\.)*)\/[a-z]*/u

export interface DocSource { path: string; text: string }
export interface ProseSite { path: string; line: number; kind: 'partial' | 'exact'; literal: string }
export interface PackValue { file: string; key: string; value: string }
export interface SiteVerdict { cls: 'label' | 'prose'; token?: string; why: string }

/**
 * 把 `assert.<名>(` 之后的实参按**顶层**逗号切开（只为把"断言消息"排除出去；不做完整语法解析）。
 * **已知代价**：`assert.ok(值, '中文消息')` 只有两个实参 ⇒ 消息会被当成取值（记进缺口，不会误豁免）。
 */
function assertArgs(line: string, open: number): string[] {
  const args: string[] = []
  let depth = 0
  let start = open + 1
  let quote = ''
  for (let i = open + 1; i < line.length; i += 1) {
    const ch = line[i] as string
    if (quote !== '') {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return [...args, line.slice(start, i)]
      depth -= 1
    } else if (ch === ',' && depth === 0) { args.push(line.slice(start, i)); start = i + 1 }
  }
  return [...args, line.slice(start)]
}

/** "部分匹配"口径：读渲染文本（子串/正则）而不是整值比较。 */
const PARTIAL_READ = /\.(?:includes|match|startsWith|endsWith)\(|assert\.(?:match|doesNotMatch)\(/u

/**
 * **文件内的中文绑定**（`const NAME = '中文…'` 这一形态）—— 用于抓"**中文先放变量、再 `includes(NAME)`**"
 * 这条真缝隙（`DEF-093` 第十批 §3.5）：此前只认**内联**中文串 ⇒ `sites = 0` ⇒ 真漏判。
 * 只做**同文件、字面量初值**这一层（跨文件/函数返回值/模板拼接不进：登记在豁免面表里）。
 */
function cjkBindings(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*[\u4e00-\u9fff][^'"`\n]*)\2/gu)) {
    out.set(match[1] as string, (match[3] as string).trim())
  }
  return out
}

/** **候选抽取器**：行里出现**读文本的调用**（`assert.*` / `.includes` / `.match` / …）且带内联中文 ⇒ 在册。 */
export function extractProseSites(docs: readonly DocSource[]): ProseSite[] {
  const out: ProseSite[] = []
  const READING = /\.(?:includes|match|startsWith|endsWith)\(|assert\.\w+\(/u
  for (const doc of docs) {
    const bindings = cjkBindings(doc.text)
    doc.text.split('\n').forEach((line, index) => {
      if (!READING.test(line)) return
      // 断言行：按实参切分（第三个及以后实参是**消息** ⇒ 不算取值）
      const calls = [...line.matchAll(/assert\.\w+\(/gu)]
      const texts: { text: string; partial: boolean }[] = calls.length === 0
        ? [{ text: line, partial: PARTIAL_READ.test(line) }]
        : calls.map((call) => {
          const args = assertArgs(line, (call.index ?? 0) + call[0].length - 1)
          const judged = args.length >= 3 ? args.slice(0, -1) : args
          const text = judged.join(',')
          // `assert.match` / `assert.doesNotMatch` 的"部分匹配"发生在**调用名**上（不在实参文本里）
          return { text, partial: PARTIAL_READ.test(text) || /^assert\.(?:match|doesNotMatch)\(/u.test(call[0]) }
        })
      for (const { text, partial } of texts) {
        const str = STRING_CJK.exec(text)
        const re = REGEX_CJK.exec(text)
        if (str === null && re === null) {
          // **变量再读**那一路：行里没有内联中文，但它读了本文件里绑定了中文的变量 ⇒ 同样是"读散文"
          for (const [name, literal] of bindings) {
            if (!new RegExp(`\\b${name}\\b`, 'u').test(text)) continue
            out.push({ path: doc.path, line: index + 1, kind: 'partial', literal })
          }
          continue
        }
        out.push({
          path: doc.path,
          line: index + 1,
          kind: partial ? 'partial' : 'exact',
          literal: (str !== null ? str[1] as string : re![1] as string).trim(),
        })
      }
    })
  }
  return out
}

/** 读**基准语言包**（`src/data/lang/zh-CN.yml`）里所有中文取值与它们的**键路径**（缩进栈）。 */
export function loadLangPack(root: string): PackValue[] {
  const file = 'src/data/lang/zh-CN.yml'
  const out: PackValue[] = []
  const stack: { indent: number; key: string }[] = []
  for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
    const match = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(line)
    if (match === null) continue
    const indent = (match[1] as string).length
    const key = match[2] as string
    const raw = (match[3] as string).trim()
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop()
    const keyPath = [...stack.map((entry) => entry.key), key].join('.')
    if (raw !== '' && !raw.startsWith('#')) {
      const value = raw.replace(/^["']|["']$/gu, '')
      if (CJK.test(value) && !value.includes('${')) out.push({ file, key: keyPath, value })
    }
    stack.push({ indent, key })
  }
  return out
}

/** **豁免谓词**：串**逐字等于**语言包某个取值 ⇒ `label`（理由 = 那个键路径）；否则 `prose`。 */
export function classifySite(site: ProseSite, pack: readonly PackValue[]): SiteVerdict {
  const hit = pack.find((entry) => entry.value === site.literal)
  if (hit !== undefined && site.literal.length >= 2) {
    return { cls: 'label', token: hit.key, why: `该中文是语言包 \`${hit.file}\` 的取值（键 \`${hit.key}\`）—— 按键可取，不是判据自带散文` }
  }
  return { cls: 'prose', why: '该中文串不在语言包里（逐字相等才算）⇒ 判据自己读散文：必须成对自证，或进已知缺口' }
}

export interface DeclaredExemption { site: string; why: string }
export interface AuditIssue { site: string; detail: string }

/** 站点键（`path:line`）。 */
export const siteKey = (site: ProseSite): string => `${site.path}:${site.line}`

/**
 * **核作者的分类**（作者只许分类，不许改判）：三个机械条件缺一即红 ——
 *   · 站点必须**真的在候选集里**（凭空的条目不算分类）；
 *   · `classifySite` 必须判 `label`（自报"只读结构化键值"对 `prose` 站点**不产生任何豁免效果**）；
 *   · 理由里必须含**可核 token**（语言包键路径），且该键必须真的取得到值（长度不是理由）。
 */
export function auditDeclaredExemptions(
  declared: readonly DeclaredExemption[],
  sites: readonly ProseSite[],
  pack: readonly PackValue[],
): AuditIssue[] {
  const issues: AuditIssue[] = []
  const keys = new Set(pack.map((entry) => entry.key))
  for (const row of declared) {
    const site = sites.find((item) => siteKey(item) === row.site)
    if (site === undefined) { issues.push({ site: row.site, detail: '该站点不在候选集里（凭空的豁免条目）' }); continue }
    const verdict = classifySite(site, pack)
    if (verdict.cls !== 'label') {
      issues.push({ site: row.site, detail: `自报豁免无效：谓词判 ${verdict.cls}（中文串「${site.literal}」不是语言包取值）` })
      continue
    }
    const token = verdict.token as string
    if (!row.why.includes(token) || !keys.has(token)) {
      issues.push({ site: row.site, detail: `豁免理由必须带可核 token（语言包键 \`${token}\`）—— 长度不算理由` })
    }
  }
  return issues
}

export interface PairedProof {
  name: string
  /** **判据本体**（真函数）：输入一段文本，返回判定串。 */
  criterion: (text: string) => string
  zh: string
  en: string
  /** **必须判不同**的坏输入（证明判据不是恒真 —— "一行文件冒充"就死在这一条上）。 */
  bad: string
}

/** **成对自证**：同一格的 zh/en 两形态必须**同判且非空**，且判据对坏输入必须**判不同**（可证伪）。 */
export function auditPairedProofs(proofs: readonly PairedProof[]): AuditIssue[] {
  const issues: AuditIssue[] = []
  for (const proof of proofs) {
    const zh = proof.criterion(proof.zh)
    const en = proof.criterion(proof.en)
    if (zh === '') issues.push({ site: proof.name, detail: '判定为空串 ⇒ 不算自证（判据必须给出可观察结论）' })
    if (zh !== en) issues.push({ site: proof.name, detail: `中英两形态不同判（zh=${zh} / en=${en}）⇒ 判据与语言相关` })
    if (proof.criterion(proof.bad) === zh) issues.push({ site: proof.name, detail: '坏输入与好输入同判 ⇒ 判据恒真、不可证伪（"一行文件"式自证格就长这样）' })
  }
  return issues
}

/**
 * **豁免类的重判**（V19 第 ⑤ 条）。类 1 收窄到 `label` 子集；类 2 **撤销**（反例读自由文本字段）。
 * `evidence` 是**必须被判为 `prose`** 的现盘站点（守卫逐条现算，不许再被豁免）。
 */
export const EXEMPTION_CLASSES: readonly { id: string; name: string; predicate: string; verify: string }[] = [
  {
    id: 'label',
    name: '语言包取值（按键可取）',
    predicate: 'classifySite === label：断言里的中文串**逐字等于** `src/data/lang/zh-CN.yml` 的某个取值',
    verify: 'token = 语言包键路径，守卫用 loadLangPack 现算并核该键存在',
  },
  {
    id: 'structure',
    name: '存在非空 / 结构约束（不读文本内容）',
    predicate: '断言里**没有内联中文串**（因此根本不在候选集里）',
    verify: '候选集由 extractProseSites 按内联中文串产生 ⇒ 这类判据天然不在册（不是"自报豁免"）',
  },
]

export const REJUDGED: readonly { old: string; verdict: string; evidence: readonly string[] }[] = [
  {
    old: '类 1「语言包 `t()`」整类豁免',
    verdict: '**收窄到 label 子集**；回执整段散文不在子集内（m125 形态）⇒ 进缺口；而两形态自证**可达**（m105 的 M105-06 就是现成先例）⇒ 不能整类豁免',
    evidence: ['test/m125.test.ts:189', 'test/m105.test.ts:290'],
  },
  {
    old: '类 2「结构化字段与台账」整类豁免',
    verdict: '**撤销**：反例读的是**自由文本字段/取值**（不是结构化键）⇒ 那些站点必须判 `prose`',
    evidence: ['test/m19.test.ts:906', 'test/m3.test.ts:608'],
  },
]

/** 自证格夹具里的**分隔符**（判据本体吃"载体 ||| 引文"两段）。 */
const PAIR_SEP = '|||'
const carrierDoc = (body: string): DocSource => ({ path: 'c.ts', text: ` * ${'sdo:carrier'} r17\n * ${body}\n * ${'sdo:carrier-end'}\n` })
const referrerDoc = (quote: string): DocSource => ({ path: 'r.ts', text: ` * ${'sdo:ref'} r17\n * ${'sdo:quote:begin'}\n * ${quote}\n * ${'sdo:quote:end'}\n` })

/**
 * **真实判据的成对自证**（守卫会调用这些函数，而不是 grep 文件）：每条都要给中英两形态 + 一个坏输入。
 * 这里登记的是**判据本体**（`checkDocs` 的两条分支）—— 因此"一行文件冒充"没有着力点。
 */
export const PAIRED_PROOFS: readonly PairedProof[] = [
  {
    name: '解析性判据（`docRefs.checkDocs` 的悬空标识符分支）',
    // 判据本体：给出"引用行"，返回 issue 种类（无 issue 记 `ok`）
    criterion: (line) =>
      checkDocs([{ path: 'lib.ts', text: 'export function realWord(): void {}\n' }, { path: 'a.ts', text: ` * ${line}\n` }])
        .map((issue) => issue.kind).join(',') || 'ok',
    zh: '见 `lib.ts` 的 `noSuchSymbol`。',
    en: 'see `lib.ts` the `noSuchSymbol`.',
    bad: '见 `lib.ts` 的 `realWord`。',
  },
  {
    name: '承载性判据（`docRefs.checkDocs` 的引文比对分支）',
    criterion: (text) => {
      const [body, quote] = text.split(PAIR_SEP)
      return checkDocs([carrierDoc(body ?? ''), referrerDoc(quote ?? '')]).map((issue) => issue.kind).join(',') || 'ok'
    },
    zh: `认不出归属时不硬猜${PAIR_SEP}认不出归属时不硬猜`,
    en: `when attribution is unknown apply no mask${PAIR_SEP}when attribution is unknown apply no mask`,
    bad: `认不出归属时不硬猜${PAIR_SEP}TBD`,
  },
]
