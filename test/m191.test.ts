/**
 * **增量 191：`P-A`（第十一批 §3.5）—— 交付注释里的每个标识符必须可解析。**
 *
 * `DEF-095` 的修法已在 `test/docRefs.ts` 证明"注释里的标识符必须可解析"**可做且语言中立**
 * （`M189-10`）。本条把它**从"路径 + 符号"那一形态推广到全部交付注释**：扫描 `src/` 与 `test/` 的
 * **注释文本**里的**反引号标识符**，断言每个标识符能在**该文件或仓内**解析到；本季已复发的
 * "注释引用不存在的函数名/字段名"（`DEF-077` / `DEF-086` / `DEF-090` / `DEF-095` 一族）因此在**源头**被挡住。
 *
 * **判据只认字形与结构，不读任何措辞**（因此中英写入同判、也不需要任何词表）：
 *   · **形态**：反引号跨度必须**整个**是一个标识符（`/^[A-Za-z_$][\w$]*$/`）—— 于是 `` `JSON.stringify` ``、
 *     `` `node --test` ``、`` `scripts/run-tests.mjs` ``、`` `wc -l` `` 这类**根本不是标识符引用**的写法不进面
 *     （它们是代码片段/命令，不是实体名）；
 *   · **解析**：该标识符必须在**见证面**（该文件"引用那一行以外"的文本 + 仓的交付面文本 + 已装依赖的类型面）
 *     里以**整词**出现 —— 与 `test/docRefs.ts` 的机制同口径（**引用自己那一行不算**、整词匹配 `\b名\b`）；
 *   · **结构性豁免**（两条，都是**字形**类，不是词表）：`$` 起首（环境/外壳变量约定，如 `` `$HOME` ``）；
 *     `tq_` + 十六进制（知识库记录号形态，不是仓内实体）。
 *
 * **现盘的历史违规**（判据不会为它们放宽）**按身份登记**在 `KNOWN_DANGLING`：数量与身份**恰好相等**
 * （新增一条 ⇒ 红并点名；声明里的某条不再出现 ⇒ 也红并要求同步收紧），登记理由逐条写在下面。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { checkDocs, normalizeNote } from './docRefs.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

export interface NoteFile { path: string; text: string }
export interface CommentSpan { line: number; text: string }
export interface BareRef { path: string; line: number; token: string; note: string }
export interface BareIssue { path: string; line: number; token: string; note: string; kind: 'dangling' | 'unregistered' }

/** 标识符形态（**整个**反引号跨度必须是它；带点/带空格/带斜杠的一律不是标识符引用）。 */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u

/** 结构性豁免（**字形**类，不含任何措辞）：环境/外壳变量、知识库记录号。 */
const externalShaped = (token: string): boolean =>
  token.startsWith('$') || /^tq_[0-9a-f]{6,}$/u.test(token)

/**
 * **字符串感知**地把一份源码切成"代码行"与"注释段"。
 * 为什么要自己切：注释里的 `//`（如 `https://`）与字符串里的注释符会让"朴素按行切"两头出错；
 * 这里只做**词法级**的引号/注释识别（不解析语法），并把字符串与模板内容**保留在代码面**里
 * —— 因为"仓内用法"包括写在字符串里的名字（如 `assert.equal(x, 'sdo_test')`）。
 */
export function splitCodeAndComments(text: string): { code: string; comments: CommentSpan[] } {
  const codeLines: string[] = []
  const comments: CommentSpan[] = []
  let blockComment = false
  for (const [index, raw] of text.split('\n').entries()) {
    let code = ''
    let comment = ''
    let at = 0
    while (at < raw.length) {
      if (blockComment) {
        const end = raw.indexOf('*/', at)
        if (end < 0) { comment += raw.slice(at); at = raw.length; break }
        comment += raw.slice(at, end)
        blockComment = false
        at = end + 2
        continue
      }
      const char = raw[at] as string
      if (char === '"' || char === "'" || char === '`') {
        code += char
        at += 1
        while (at < raw.length) {
          if (raw[at] === '\\') { code += raw.slice(at, at + 2); at += 2; continue }
          code += raw[at] as string
          if (raw[at] === char) { at += 1; break }
          at += 1
        }
        continue
      }
      if (char === '/' && raw[at + 1] === '/') { comment += raw.slice(at + 2); break }
      if (char === '/' && raw[at + 1] === '*') { blockComment = true; at += 2; continue }
      code += char
      at += 1
    }
    codeLines.push(code)
    if (comment.trim() !== '') comments.push({ line: index + 1, text: comment })
  }
  return { code: codeLines.join('\n'), comments }
}

const walkInto = (dir: string, accept: (name: string) => boolean, out: string[] = []): string[] => {
  let entries: Dirent[] = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkInto(full, accept, out)
    else if (accept(entry.name)) out.push(full)
  }
  return out
}

const rel = (path: string): string => relative(ROOT, path).split('\\').join('/')

/** **被检查面**：`src/` 与 `test/` 的代码文件（注释文本取自它们）。 */
export function citationFaces(root: string): string[] {
  return [
    ...walkInto(join(root, 'src'), (name) => name.endsWith('.ts')),
    ...walkInto(join(root, 'test'), (name) => name.endsWith('.ts') || name.endsWith('.mjs')),
  ].sort()
}

/**
 * **见证面**：判"这个标识符在这份文件或仓内解析得到吗"的语料。
 *   · 仓的**交付面文本**：`src/`、`test/`、`scripts/`、`presets/`、`skills/`、`docs/`（**除 `docs/plan/`**：
 *     那是冻结的历史任务书，里面记着**旧名字** ⇒ 把它当见证面等于让旧名字给新悬空背书）、根配置文件；
 *   · **已装依赖的类型面**：`node_modules/**\/*.d.ts`（第三方/语言的标识符在这里解析 —— 这是"误报控制"
 *     的**机制**，不是一张名字白名单）；
 *   · 台账与证据（`.sdo/`）与编译产物（`lib/`）**都不在**见证面里：前者会让"写在报告里的错名字"自我背书，
 *     后者是同一份源码的副本（会把"已删掉的名字"永远喂饱）。
 */
export function witnessFaces(root: string): string[] {
  const rootFiles = ['README.md', 'CHANGELOG.md', 'package.json', 'tsconfig.json', 'client.js', 'client.d.ts']
  return [
    ...walkInto(join(root, 'src'), (name) => name.endsWith('.ts')),
    ...walkInto(join(root, 'test'), (name) => name.endsWith('.ts') || name.endsWith('.mjs')),
    ...walkInto(join(root, 'scripts'), () => true),
    ...walkInto(join(root, 'presets'), () => true),
    ...walkInto(join(root, 'skills'), () => true),
    ...walkInto(join(root, 'docs'), (name) => name.endsWith('.md')).filter((file) => !rel(file).startsWith('docs/plan/')),
    ...walkInto(join(root, 'node_modules'), (name) => /\.d\.(?:ts|mts|cts)$/u.test(name)),
    ...rootFiles.map((name) => join(root, name)),
  ].filter((file) => { try { return readFileSync(file).length >= 0 } catch { return false } })
}

/** 注释文本里的**反引号标识符**（只取整个跨度都是标识符的那些）。 */
export function bareRefs(file: NoteFile): BareRef[] {
  const out: BareRef[] = []
  for (const span of splitCodeAndComments(file.text).comments) {
    for (const match of span.text.matchAll(/`([^`\n]+)`/gu)) {
      const token = match[1] as string
      if (!IDENTIFIER.test(token)) continue
      out.push({ path: file.path, line: span.line, token, note: normalizeNote(span.text) })
    }
  }
  return out
}

/**
 * **整词 + "引用那一行不算"** —— 与 `test/docRefs.ts` 的解析口径同源（它也是这么判"别处可解析"的）。
 * 该文件自己那一行被剔掉（否则"写在注释里的名字"会被同一行里的另一处提及喂饱）。
 */
export function resolvesIn(token: string, ref: BareRef, witnesses: readonly NoteFile[]): boolean {
  const pattern = new RegExp(`\\b${token}\\b`, 'u')
  for (const witness of witnesses) {
    const text = witness.path === ref.path
      ? witness.text.split('\n').filter((_line, index) => index + 1 !== ref.line).join('\n')
      : witness.text
    if (pattern.test(text)) return true
  }
  return false
}

/**
 * **现盘的历史违规（身份登记）** —— 判据**不为它们放宽**：登记与现算必须**恰好相等**（`M191-01`），
 * 任何**新增**悬空当场红并点名；某条登记不再现算得到（有人真去修了）也红，要求**同步收紧**这份登记。
 *
 * ⚠️ `token` 拆成两段：**登记表自己不给这些名字背书** —— 若整名写在判据文件里，它就会从**见证面**里
 * 解析到自己（同一份文件里把名字写一遍 = 自解析，正是 `test/docRefs.ts` 的"引用自己那一行不算"要挡的形态）。
 * 逐条身份 = `相对路径:行号 \`标识符\``（`M191-01` 的比对键）。
 */
interface KnownDangling { file: string; line: number; head: string; tail: string; why: string }

export const KNOWN_DANGLING: readonly KnownDangling[] = [
  // 举例性函数名（描述别的项目形态），仓内无此定义
  { file: 'src/domain/method.ts', line: 267, head: 'check', tail: 'Types', why: '举例性函数名：注释在描述"成员类型不支持某个方法"那种形态' },
  // 旧常量名的**残段**（真名带前缀，见同行前半句）
  { file: 'src/domain/signature.ts', line: 13, head: 'SIGNATURE_INVALIDATING', tail: '_EVENTS', why: '旧常量名残段（真名带 G2_ 前缀，见同一注释的前半句）' },
  // 历史形态的旧入口名（已移除，仅注释记述）
  { file: 'src/interface/argv.ts', line: 243, head: 'bare', tail: 'Option', why: '旧入口名（已移除；注释只在记述历史形态）' },
  // 举例性函数名（描述"属性节点可以带哪些键"），仓内无此定义
  { file: 'src/interface/tools.ts', line: 1015, head: 'compile', tail: 'PropertyMap', why: '举例性函数名（注释在描述联合声明口径）' },
  // 被**否决**的候选名（"而不是新造它"）⇒ 按定义不存在
  // 行号随 `TASK-171`（判据激活条件 `when` 进 `GateCriterionDef`）之后 +13：**只有行号变，身份一字未动**
  { file: 'src/types.ts', line: 885, head: 'introduces', tail: 'Semantics', why: '被否决的候选名（原句是"而不是新造它"）⇒ 按定义不存在' },
  { file: 'src/types.ts', line: 885, head: 'impact', tail: 'Surface', why: '同上（被否决的候选名）' },
  // 第三方包（留档副本模块）的导出名，本仓未安装其面
  { file: 'test/m100-hooks.mjs', line: 21, head: 'declared', tail: 'ItemGaps', why: '第三方包（留档副本模块）的导出名；本仓未安装它的类型面' },
  // 旧结构名（改结构后已移除，仅注释记述）
  { file: 'test/m139.test.ts', line: 108, head: 'list', tail: 'Schema', why: '旧结构名（`DEF-077` 改结构后已移除，注释只在记述旧形态）' },
  // 夹具标识符的**片段**（被引用的整名是它的超串）
  { file: 'test/m189.test.ts', line: 404, head: 'Ed', tail: 'ge', why: '夹具标识符的片段（整名是它的超串，注释在讲"子串喂饱"那一格；DEF-155 补 4 行注释后 398 → 402；TASK-172 给 m218 补一行登记后 403 → 404）' },
  // 第三方包（`@deepseek-ai/dsh-user-questions`）的运行时符号
  { file: 'test/m88.test.ts', line: 544, head: 'no', tail: 'Answerer', why: '第三方包（`@deepseek-ai/dsh-user-questions`）的运行时符号（其 .d.ts 未收录）' },
  { file: 'test/m88.test.ts', line: 544, head: 'NO_', tail: 'PROVIDER', why: '同上（该包的运行时错误码）' },
  // 设想中的夹具名（该基线文件未实现这两个）
  { file: 'test/task001-red-baseline.test.ts', line: 33, head: 'handEdited', tail: 'OnUnchangedDoc', why: '设想中的夹具名（该基线文件没有实现它）' },
  { file: 'test/task001-red-baseline.test.ts', line: 67, head: 'swap', tail: 'Store', why: '设想中的夹具名（同上）' },
]

/** 登记条目的比对键（与现算的悬空键同形）。 */
export const knownKeys = (): string[] =>
  KNOWN_DANGLING.map((entry) => `${entry.file}:${entry.line} \`${entry.head}${entry.tail}\``).sort()

/** 现算的全部悬空（**未**扣掉登记）：用于"登记与身份恰好相等"的双向对账。 */
export function danglingRefs(root: string, witnesses: readonly NoteFile[]): BareRef[] {
  const out: BareRef[] = []
  for (const path of citationFaces(root)) {
    const file: NoteFile = { path, text: readFileSync(path, 'utf8') }
    for (const ref of bareRefs(file)) {
      if (externalShaped(ref.token)) continue
      if (resolvesIn(ref.token, ref, witnesses)) continue
      out.push(ref)
    }
  }
  return out
}

const keyOf = (ref: BareRef): string => `${rel(ref.path)}:${ref.line} \`${ref.token}\``

test('M191-01 现盘（只读扫描）：`src/`+`test/` 注释里的反引号标识符全部可解析，或按身份登记', () => {
  const witnesses = witnessFaces(ROOT).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  assert.equal(citationFaces(ROOT).length >= 200, true, `被检查面必须够宽（现算 ${citationFaces(ROOT).length} 个文件）`)
  assert.equal(witnesses.length > citationFaces(ROOT).length, true, '见证面必须比被检查面宽（含依赖类型面）')
  const observed = [...new Set(danglingRefs(ROOT, witnesses).map(keyOf))].sort()
  assert.deepEqual(
    observed,
    knownKeys(),
    `悬空标识符必须与身份登记**恰好相等**（多一条 ⇒ 新悬空，点名；少一条 ⇒ 登记失效，请同步收紧）：${JSON.stringify(observed).slice(0, 900)}`,
  )
})

test('M191-02 §3.5 DoD②（误报控制）：外部约定/第三方/语言的标识符**不许**报红 + 同格反例', () => {
  const witnesses = witnessFaces(ROOT).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  // ① 形态关：这些跨度**整个不是标识符** ⇒ 根本不构成"标识符引用"（`JSON.stringify` / `node --test` /
  //    `scripts/run-tests.mjs` / `wc -l` / `--test-reporter=tap` / `src/**` / `HEAD~1`）
  const shapes = '`JSON.stringify`、`node --test`、`scripts/run-tests.mjs`、`wc -l`、`--test-reporter=tap`、`src/**`、`HEAD~1`'
  assert.deepEqual(bareRefs({ path: 'x.ts', text: `// ${shapes}\n` }), [], '非标识符形态不许进面（它们不是实体引用）')
  // ② 解析关：工具名 / 语言内建 / 第三方符号都在见证面里解析得到（**机制**，不是名字白名单）
  const externals = ['tsc', 'node', 'git', 'cp', 'sha256sum', 'cmp', 'find', 'grep', 'awk', 'diff', 'wc', 'readdir', 'SyntaxError', 'additionalProperties', 'JSON']
  const missing = externals.filter((token) => !resolvesIn(token, { path: join(ROOT, 'test', 'm191.test.ts'), line: 0, token, note: '' }, witnesses))
  assert.deepEqual(missing, [], `外部/第三方/语言的标识符不许报红（解析不到的：${missing.join(', ')}）`)
  // ③ 同格反例：**同一个探针**喂一个真的不存在的标识符 ⇒ 必须红（证明②不是恒真）
  // 运行期拼出来的名字：本文件自己的文本（见证面里就有它）不许给它背书
  const ghost = ['gho', 'stSym', 'bolZq7'].join('')
  assert.equal(
    resolvesIn(ghost, { path: join(ROOT, 'test', 'm191.test.ts'), line: 0, token: ghost, note: '' }, witnesses),
    false,
    '不存在的标识符必须判"解析不到"（否则这一格恒真）',
  )
})

test('M191-03 §3.5 DoD①：注释里写一个**不存在**的标识符 ⇒ 红并点名到「文件 + 注释」', () => {
  const witnesses: NoteFile[] = [
    { path: 'src/real.ts', text: 'export function realSymbol(): void {}\n' },
    { path: 'test/a.ts', text: '// 这一段把 `ghostSymbolZz` 接上（不存在的函数名）。\n' },
  ]
  const dangling = witnesses
    .filter((file) => file.path.startsWith('test/'))
    .flatMap((file) => bareRefs(file).filter((ref) => !resolvesIn(ref.token, ref, witnesses)))
  assert.deepEqual(dangling.map((ref) => ref.token), ['ghostSymbolZz'], '必须红，且点名到那个标识符')
  assert.equal(dangling[0]?.path, 'test/a.ts', '必须点名到**文件**')
  assert.equal(dangling[0]?.line, 1, '必须点名到**注释所在的行**')
  assert.match(dangling[0]?.note ?? '', /ghostSymbolZz/u, '必须带上注释原文（复验者据此一眼看到那一句）')
  // 反例：同一形态喂一个**真**标识符 ⇒ 不许红
  const real: NoteFile[] = [{ path: 'src/real.ts', text: 'export function realSymbol(): void {}\n' }, { path: 'test/b.ts', text: '// 这里用 `realSymbol`。\n' }]
  assert.deepEqual(bareRefs(real[1] as NoteFile).filter((ref) => !resolvesIn(ref.token, ref, real)), [], '存在的标识符不许红')
  // 与 `test/docRefs.ts` 同一条口径（**引用自己那一行不算**）：符号只写在被引文件自己那一行 ⇒ 判悬空
  const selfOnly: NoteFile[] = [{ path: 'src/self.ts', text: '// 见 `selfOnlySymbolZz`。\n' }]
  assert.equal(resolvesIn('selfOnlySymbolZz', bareRefs(selfOnly[0] as NoteFile)[0] as BareRef, selfOnly), false, '引用自己那一行不算（与 docRefs 同口径）')
  assert.deepEqual(
    checkDocs([{ path: 'src/self.ts', text: `// 见 \`src/self.ts\` 的 \`selfOnlySymbolZz\`。\n` }]).map((issue) => issue.kind),
    ['dangling-id'],
    '同一个"自引用不算"口径在 docRefs 的符号支路上也是红的（两处机制同源，不是第二份匹配）',
  )
})

test('M191-04 §3.5 DoD③（语言无关）：中英两形态**同判**，判据里没有任何措辞词表', () => {
  const witnesses: NoteFile[] = [{ path: 'src/real.ts', text: 'export function realSymbol(): void {}\n' }]
  const zh: NoteFile = { path: 'test/zh.ts', text: '// 这一段把 `ghostSymbolZz` 接上。\n' }
  const en: NoteFile = { path: 'test/en.ts', text: '// this line wires up `ghostSymbolZz`.\n' }
  const verdict = (file: NoteFile): string[] =>
    bareRefs(file).filter((ref) => !resolvesIn(ref.token, ref, [...witnesses, file])).map((ref) => ref.token)
  assert.deepEqual(verdict(zh), verdict(en), '中英写入必须**同判**（同一份判据，不看语言）')
  assert.deepEqual(verdict(zh), ['ghostSymbolZz'], '两形态都必须红（不是"英文漏判"）')
  // 反例：中英两形态各喂一个**真**标识符 ⇒ 都不红
  const okZh: NoteFile = { path: 'test/zh2.ts', text: '// 这是 `realSymbol`。\n' }
  const okEn: NoteFile = { path: 'test/en2.ts', text: '// this is `realSymbol`.\n' }
  for (const file of [okZh, okEn]) {
    assert.deepEqual(bareRefs(file).filter((ref) => !resolvesIn(ref.token, ref, [...witnesses, file])), [], '真标识符在中英两形态下都不许红')
  }
})

test('M191-05 §3.5 DoD②（形态口径）：`--`/路径/点号形态**不进**标识符面，整词匹配不许被"子串喂饱"', () => {
  const witnesses: NoteFile[] = [{ path: 'src/real.ts', text: 'export function realSymbol(): void {}\n' }]
  // `realSymbolEdgeXyz` 存在 ⇒ 引它绿；但 `realSymbol` 也必须**另有出处**才绿（不许被子串喂饱）
  const superset: NoteFile[] = [{ path: 'src/x.ts', text: 'export const realSymbolEdgeXyz = 1\n' }, { path: 'test/c.ts', text: '// 引 `realSymbol`。\n' }]
  assert.equal(
    resolvesIn('realSymbol', bareRefs(superset[1] as NoteFile)[0] as BareRef, superset),
    false,
    '被指文件里只有**超串**时，整词匹配仍必须判"解析不到"（子串喂饱是 `DEF-096` 那一族）',
  )
  assert.equal(
    resolvesIn('realSymbolEdgeXyz', bareRefs({ path: 'test/d.ts', text: '// 引 `realSymbolEdgeXyz`。\n' })[0] as BareRef, [...witnesses, ...superset]),
    true,
    '反例：整名存在时必须判"解析到"（否则这一格恒红）',
  )
})
