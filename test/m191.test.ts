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
 *   · 台账与证据（`.sdo/`）、编译产物（`lib/`）、**以及 `node_modules/.sdo-test/` 这个夹具暂存根**
 *     **都不在**见证面里：前两者会让"写在报告里的错名字"与"已删掉的名字"自我背书；
 *     而 `.sdo-test/` 是**本仓自己的夹具/变异副本暂存地** —— 它底下常常是这个仓 `lib/` 的整树拷贝
 *     （`<卡>-mut/lib/src/*.d.ts` 这类），按同一条理由必须排除：它是同一份源码的副本，会把已删掉的名字
 *     永远喂饱（`TASK-265` 复核轮实测：`node_modules/.sdo-test/task-245-mut/lib/src/types.d.ts` 这份
 *     遗留副本让 `src/types.ts` 的两条登记当场变 `stale` ⇒ 假红。详见 `DEF-246`）。
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
  ].filter(isWitnessFace).filter((file) => { try { return readFileSync(file).length >= 0 } catch { return false } })
}

/**
 * 见证面的**准入谓词**（一处判定，好给双态）：`node_modules/.sdo-test/` 下的文件一律不进面。
 *
 * 为什么不整棵 `node_modules` 排除：第三方/语言的类型面正是"误报控制"的机制（见上），
 * 只排除**本仓自己的夹具暂存根**这一个子树 —— 它装的是本仓 `lib/` 与夹具项目的副本。
 */
export function isWitnessFace(file: string): boolean {
  return !rel(file).startsWith('node_modules/.sdo-test/')
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
 * **登记键 = `文件` + 标识符 + 注释的逐字原文，不含行号**（`TASK-265` / `DEF-233`）：
 * 行号会随任何无关改动漂移 —— 真机上另一个会话在 `src/types.ts` 上面插了几行，整条棘轮就判红，
 * 而被点名的 11 条 observed 里**没有一条**是被测卡碰过的文件。位置不是身份，内容才是：
 * 同一段注释挪到哪一行都是同一处（绿），文本改一个字或出现两处才红（`M191-06` 双态钉住）。
 *
 * ⚠️ `token` 拆成两段（`head` + `tail`）：**登记表自己不给这些名字背书** —— 若整名写在判据文件里，
 * 它就会从**见证面**里解析到自己（同一份文件里把名字写一遍 = 自解析，正是 `test/docRefs.ts` 的
 * "引用自己那一行不算"要挡的形态）。`M191-06` 把这条不变式做成了断言。
 * 注释原文里**互相引用**的那几个名字（`types.ts` 的两条互指、`m88` 的两条互指）同样拆开写，理由同上；
 * `method.ts` 那条的注释里有一个 `.includes` 调用（点号紧跟括号）也要拆 —— 否则那一行会被算成 §4.3 的读散文站点。
 */
export interface KnownDangling {
  file: string
  /** 注释原文里**标识符之前**的部分（逐字 —— 引号里是注释原文，不是判据措辞）。 */
  before: string
  head: string
  tail: string
  /** 注释原文里**标识符之后**的部分（逐字）。 */
  after: string
  why: string
}

/** 登记条目的**逐字注释原文**（位置无关：它不含行号，所以行号漂移改不动它）。 */
export const noteOf = (entry: KnownDangling): string => `${entry.before}\`${entry.head}${entry.tail}\`${entry.after}`

/** 登记条目的身份键（与现算的悬空键同形；**行号不进键**）。 */
export const knownKeys = (): string[] =>
  KNOWN_DANGLING.map((entry) => `${entry.file} :: \`${entry.head}${entry.tail}\` :: ${noteOf(entry)}`).sort()

/** 现算侧的同一把尺子：文件 + 标识符 + **注释原文**。 */
export const identityOf = (ref: BareRef): string => `${identityFile(ref.path)} :: \`${ref.token}\` :: ${ref.note}`

export const KNOWN_DANGLING: readonly KnownDangling[] = [
  // 举例性函数名（描述别的项目形态），仓内无此定义
  { file: 'src/domain/method.ts', before: '', head: 'check', tail: 'Types', after: ' 的 `type.collaborators' + '.includes' + '(...)` 抛 `includes is not a function`。', why: '举例性函数名：注释在描述"成员类型不支持某个方法"那种形态' },
  // 旧常量名的**残段**（真名带前缀，见同行前半句）
  { file: 'src/domain/signature.ts', before: '`G2_SIGNATURE_INVALIDATING_EVENTS` 与 ', head: 'SIGNATURE_INVALIDATING', tail: '_EVENTS', after: '）。', why: '旧常量名残段（真名带 G2_ 前缀，见同一注释的前半句）' },
  // 历史形态的旧入口名（已移除，仅注释记述）
  { file: 'src/interface/argv.ts', before: '历史形态：裸 `k=v`。键必须非空、值必须非空（与旧 ', head: 'bare', tail: 'Option', after: ' 一致）', why: '旧入口名（已移除；注释只在记述历史形态）' },
  // 举例性函数名（描述"属性节点可以带哪些键"），仓内无此定义
  { file: 'src/interface/tools.ts', before: '且 ', head: 'compile', tail: 'PropertyMap', after: ' 允许属性节点带 `required` + `oneOf`）⇒ 这里**声明联合**：', why: '举例性函数名（注释在描述联合声明口径）' },
  // 被**否决**的候选名（"而不是新造它"）⇒ 按定义不存在（两条互指，名字都拆开写）
  { file: 'src/types.ts', before: '为什么复用**同名口径**而不是新造 ', head: 'introduces', tail: 'Semantics', after: ' / `impact' + 'Surface`：仓库已有影响面词汇', why: '被否决的候选名（原句是"而不是新造它"）⇒ 按定义不存在' },
  { file: 'src/types.ts', before: '为什么复用**同名口径**而不是新造 `introduc' + 'esSemantics` / ', head: 'impact', tail: 'Surface', after: '：仓库已有影响面词汇', why: '同上（被否决的候选名）' },
  // 第三方包（留档副本模块）的导出名，本仓未安装其面
  { file: 'test/m100-hooks.mjs', before: '留档副本的**模块契约**会随新导出漂移（实测：collab.js 新增 ', head: 'declared', tail: 'ItemGaps', after: ' 后，', why: '第三方包（留档副本模块）的导出名；本仓未安装它的类型面' },
  // 旧结构名（改结构后已移除，仅注释记述）
  { file: 'test/m139.test.ts', before: '*DEF-077（第四批 §3.2）改了结构**：联合形态从"注册前统一升级（', head: 'list', tail: 'Schema', after: '）"搬到了**参数声明处**', why: '旧结构名（`DEF-077` 改结构后已移除，注释只在记述旧形态）' },
  // 夹具标识符的**片段**（被引用的整名是它的超串；整名也拆开写，别喂饱见证面）
  { file: 'test/m189.test.ts', before: '③ 子串喂饱（后缀方向）：只有 `realSymbol' + 'EdgeXyz`（含 ', head: 'Ed', tail: 'ge', after: ' 前缀、另加长尾）时同理 —— 两个方向都不许被喂饱', why: '夹具标识符的片段（整名是它的超串，注释在讲"子串喂饱"那一格）。修前这条记着一串行号变迁（398→402→403→404→406→405→406）—— 那串数字正是"登记键钉位置"的病历：`TASK-265` 起锚是注释原文，行号不进登记。' },
  // 第三方包（`@deepseek-ai/dsh-user-questions`）的运行时符号（两条互指，名字都拆开写）
  { file: 'test/m88.test.ts', before: '——`@deepseek-ai/dsh-user-questions` 的 ', head: 'no', tail: 'Answerer', after: ' 抛 `NO_' + 'PROVIDER`，不是 resolve undefined。）', why: '第三方包（`@deepseek-ai/dsh-user-questions`）的运行时符号（其 .d.ts 未收录）' },
  { file: 'test/m88.test.ts', before: '——`@deepseek-ai/dsh-user-questions` 的 `no' + 'Answerer` 抛 ', head: 'NO_', tail: 'PROVIDER', after: '，不是 resolve undefined。）', why: '同上（该包的运行时错误码）' },
  // 设想中的夹具名（该基线文件未实现这两个）
  { file: 'test/task001-red-baseline.test.ts', before: '· ', head: 'handEdited', tail: 'OnUnchangedDoc', after: '：对一份**没人改过**的文档连渲两次，第二次的 `handEdited`。', why: '设想中的夹具名（该基线文件没有实现它）' },
  { file: 'test/task001-red-baseline.test.ts', before: '把当前 `src/` + `test/` 复制成一棵临时树，并按 ', head: 'swap', tail: 'Store', after: ' 决定用哪一版 testingStore.ts 与模块图。', why: '设想中的夹具名（同上）' },
]

/** 某份文件的**注释原文**清单（锚的"出现几次"就数它；与现算悬空同一份切分逻辑）。 */
export function commentNotes(file: NoteFile): string[] {
  return splitCodeAndComments(file.text).comments.map((span) => normalizeNote(span.text))
}

/** 现算的全部悬空（**未**扣掉登记）：用于"登记与身份恰好相等"的双向对账。 */
export function unresolvedRefs(files: readonly NoteFile[], witnesses: readonly NoteFile[]): BareRef[] {
  const out: BareRef[] = []
  for (const file of files) {
    for (const ref of bareRefs(file)) {
      if (externalShaped(ref.token)) continue
      if (resolvesIn(ref.token, ref, witnesses)) continue
      out.push(ref)
    }
  }
  return out
}

/** 现盘版（读 `src/` + `test/` 的注释面）。 */
export function danglingRefs(root: string, witnesses: readonly NoteFile[]): BareRef[] {
  return unresolvedRefs(citationFaces(root).map((path) => ({ path, text: readFileSync(path, 'utf8') })), witnesses)
}

/** 双向对账的读数（三路都点名；位置一律不参与）。 */
export interface DanglingReading {
  /** 现算了但没登记（**新增**悬空 ⇒ 红并点名） */
  fresh: string[]
  /** 登记了但现算不到（**登记失效** ⇒ 红并要求同步收紧） */
  stale: string[]
  /** 该登记的锚文本在它的文件里出现次数 ≠ 1（⇒ 红并点名次数；`M191-06` 双态钉住） */
  ambiguous: string[]
}

/**
 * **登记 ⇄ 现算**的对账（纯函数，双态探针可以直接喂合成文件）。
 *
 * 三路各管一件事，缺一路就有一条静默通道：`fresh` 挡新悬空、`stale` 挡"修好了却不收紧登记"、
 * `ambiguous` 挡"同一段注释在文件里有两处"（那时按文本定位指的不再是**一处**内容）。
 */
export function reconcileDangling(input: {
  files: readonly NoteFile[]
  witnesses: readonly NoteFile[]
  registered?: readonly KnownDangling[]
}): DanglingReading {
  const registered = input.registered ?? KNOWN_DANGLING
  const budget = new Map<string, number>()
  for (const entry of registered) {
    const key = `${entry.file} :: \`${entry.head}${entry.tail}\` :: ${noteOf(entry)}`
    budget.set(key, (budget.get(key) ?? 0) + 1)
  }
  const fresh: string[] = []
  for (const key of [...new Set(unresolvedRefs(input.files, input.witnesses).map(identityOf))].sort()) {
    const left = budget.get(key) ?? 0
    if (left <= 0) fresh.push(key)
    else budget.set(key, left - 1)
  }
  const stale = [...budget].flatMap(([key, left]) => Array.from({ length: left }, () => key)).sort()
  const byFile = new Map(input.files.map((file) => [identityFile(file.path), file] as const))
  const ambiguous = registered.flatMap((entry) => {
    const file = byFile.get(entry.file)
    const hits = file === undefined ? 0 : commentNotes(file).filter((note) => note === noteOf(entry)).length
    return hits === 1 ? [] : [`${entry.file} :: anchor-hits=${String(hits)} :: \`${entry.head}${entry.tail}\``]
  })
  return { fresh, stale, ambiguous }
}

/** 身份的路径形态：绝对路径折成相对（合成探针用的相对路径原样保留）。 */
function identityFile(path: string): string {
  return path.startsWith(ROOT) ? rel(path) : path.split('\\').join('/')
}

test('M191-01 现盘（只读扫描）：`src/`+`test/` 注释里的反引号标识符全部可解析，或按身份登记', () => {
  const witnesses = witnessFaces(ROOT).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  const files = citationFaces(ROOT).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  assert.equal(files.length >= 200, true, `被检查面必须够宽（现算 ${files.length} 个文件）`)
  assert.equal(witnesses.length > files.length, true, '见证面必须比被检查面宽（含依赖类型面）')
  const reading = reconcileDangling({ files, witnesses })
  // ① 每个登记的锚必须在它的文件里**恰好出现一次**（≠1 ⇒ 点名次数：那时它指的已不是一处内容）
  assert.deepEqual(
    reading.ambiguous,
    [],
    `登记的锚文本必须在该文件里恰好出现一次（次数 ≠ 1 的已点名）：${JSON.stringify(reading.ambiguous).slice(0, 900)}`,
  )
  // ② 新增悬空 ⇒ 红并点名（多一条就红）
  assert.deepEqual(
    reading.fresh,
    [],
    `悬空标识符必须与身份登记**恰好相等**（多一条 ⇒ 新悬空，点名）：${JSON.stringify(reading.fresh).slice(0, 900)}`,
  )
  // ③ 登记失效 ⇒ 也红（少一条 ⇒ 有人真去修了，请同步收紧；不许静默通过）
  assert.deepEqual(
    reading.stale,
    [],
    `登记失效：这些锚在该文件里已经找不到（改了措辞或删了注释），请同步收紧登记：${JSON.stringify(reading.stale).slice(0, 900)}`,
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
  // ④ 见证面的**准入谓词**双态（`TASK-265` 复核轮 / `DEF-246`）：夹具暂存根不进面，第三方类型面照进。
  //    病根：`.sdo-test/` 底下是本仓 `lib/` 与夹具项目的整树拷贝，把那里的 `.d.ts` 当见证面
  //    ⇒ 已删掉的名字被副本永远喂饱 ⇒ 登记变 `stale`（今天真机上就是 `task-245-mut` 那份遗留副本干的）。
  assert.equal(
    isWitnessFace(join(ROOT, 'node_modules', '.sdo-test', 'task-245-mut', 'lib', 'src', 'types.d.ts')),
    false,
    '夹具/变异副本（本仓 lib 的拷贝）不许进见证面',
  )
  assert.equal(
    isWitnessFace(join(ROOT, 'node_modules', '@types', 'node', 'index.d.ts')),
    true,
    '反例：已装依赖的类型面必须照进（不许把整棵 node_modules 排除）',
  )
  assert.equal(
    witnessFaces(ROOT).some((path) => rel(path).startsWith('node_modules/.sdo-test/')),
    false,
    '现盘见证面里不许有夹具暂存根（node_modules/.sdo-test/）的文件',
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

test('M191-06 (anchor, TASK-265) 登记钉注释原文不钉行号：漂 5 行同键；改一字 / 出现两次都红并点名', () => {
  const witnesses: NoteFile[] = [{ path: 'src/real.ts', text: 'export const realSymbol = 1\n' }]
  const anchor = '// 这一段把 `ghostSymbolZz` 接上。'
  const atTop: NoteFile[] = [{ path: 'test/anchor.ts', text: `${anchor}\n` }]
  const hole = '// 无关的一行\n'
  const drifted: NoteFile[] = [{ path: 'test/anchor.ts', text: `${hole.repeat(5)}${anchor}\n` }]
  const lineOf = (files: readonly NoteFile[]): number => bareRefs(files[0] as NoteFile)[0]?.line ?? 0
  // 双态一：**位置漂移 ⇒ 同一个身份键**（行号进键正是 `M191-01` 那次真机假红的来源）
  assert.equal(lineOf(atTop), 1, '原地在注释第 1 行')
  assert.equal(lineOf(drifted), 6, '漂移后在注释第 6 行')
  assert.equal(lineOf(drifted) - lineOf(atTop), 5, '两态确实差 5 行（否则这条对照是空转的）')
  const identityAt = (files: readonly NoteFile[]): string =>
    allIdentities(files, [...witnesses, ...files]).join('|')
  assert.notEqual(identityAt(atTop), '', '探针必须真的产出身份（否则下面"同键"是两条空串相等）')
  assert.equal(identityAt(atTop), identityAt(drifted), `位置漂移后身份必须不变：${identityAt(atTop)} ／ ${identityAt(drifted)}`)
  // 双态二：**改一个字 ⇒ 登记失效**（旧文本不再现算得到，新文本又不在登记里 ⇒ 两头都点名）
  const registered: KnownDangling[] = [
    { file: 'test/anchor.ts', before: '这一段把 ', head: 'ghost', tail: 'SymbolZz', after: ' 接上。', why: '合成登记（双态探针用，不是现盘违规）' },
  ]
  const green = reconcileDangling({ files: atTop, witnesses: [...witnesses, ...atTop], registered })
  assert.deepEqual([green.fresh, green.stale, green.ambiguous], [[], [], []], `原地必须全绿：${JSON.stringify(green)}`)
  const changed = anchor.replace('接上', '接上了')
  assert.notEqual(changed, anchor, '探针必须真的改到了字节（否则下面两条是空断言）')
  const changedFiles: NoteFile[] = [{ path: 'test/anchor.ts', text: `${hole.repeat(5)}${changed}\n` }]
  const red = reconcileDangling({ files: changedFiles, witnesses: [...witnesses, ...changedFiles], registered })
  assert.equal(red.stale.length, 1, `文本改了字 ⇒ 登记的锚找不到（登记失效，点名）：${JSON.stringify(red)}`)
  assert.equal(red.fresh.length, 1, `改动后的新文本不在登记里 ⇒ 也要点名：${JSON.stringify(red)}`)
  // 双态三：**同一段注释出现两处 ⇒ 锚不再指"一处内容"**（点名次数，不静默取第一条）
  const twice: NoteFile[] = [{ path: 'test/anchor.ts', text: `${anchor}\n${hole}${anchor}\n` }]
  const doubled = reconcileDangling({ files: twice, witnesses: [...witnesses, ...twice], registered })
  assert.equal(
    doubled.ambiguous.some((row) => row.includes('anchor-hits=2')),
    true,
    `同一段注释两处 ⇒ 必须点名出现 2 次：${JSON.stringify(doubled.ambiguous)}`,
  )
  // 反证：现盘登记每条都必须恰好一处（否则"按文本定位"指的不是一处内容）
  const perEntry = KNOWN_DANGLING.map((entry) => {
    const file = { path: join(ROOT, entry.file), text: readFileSync(join(ROOT, entry.file), 'utf8') }
    return { entry, hits: commentNotes(file).filter((note) => note === noteOf(entry)).length }
  })
  assert.deepEqual(
    perEntry.filter((row) => row.hits !== 1).map((row) => `${row.entry.file} ⇒ anchor-hits=${String(row.hits)}`),
    [],
    '每条登记的锚文本在它的文件里都必须恰好出现一次（≠1 ⇒ 点名次数）',
  )
  // **真实内容漂移**（不碰盘上文件）：拿一条真实登记的注释原文，在它上面插一行 ⇒ 行号 +1、身份键一字不动。
  const first = KNOWN_DANGLING[0] as KnownDangling
  const realText = readFileSync(join(ROOT, first.file), 'utf8')
  const realRows = realText.split('\n')
  const realSpans = splitCodeAndComments(realText).comments.filter((span) => normalizeNote(span.text) === noteOf(first))
  assert.equal(realSpans.length, 1, `${first.file} 里该注释必须恰好一处（现算 ${String(realSpans.length)} 处）`)
  const realAt = (realSpans[0] as CommentSpan).line
  const shifted = [...realRows.slice(0, realAt - 1), '// 另一会话在它上面插的一行', ...realRows.slice(realAt - 1)].join('\n')
  const refOf = (text: string): BareRef =>
    bareRefs({ path: join(ROOT, first.file), text }).find((ref) => noteOf(first) === ref.note) as BareRef
  assert.equal(refOf(realText).line, realAt, '真实内容：定位到登记的注释行')
  assert.equal(refOf(shifted).line, realAt + 1, '插一行后它确实往下挪了一行（否则这条对照是空转的）')
  assert.equal(identityOf(refOf(shifted)), identityOf(refOf(realText)), '真实内容漂移后身份键必须一字不动（键里没有行号）')
  // 不变式（同一件事的另一头）：**登记表自己不许替任何登记名背书** —— 整名写进本文件就会从见证面里自解析。
  // 这一条把"head/tail 拆开写"从口头纪律变成机械读数；注释原文里互指的名字也必须拆。
  const self = readFileSync(join(ROOT, 'test', 'm191.test.ts'), 'utf8')
  const vouched = KNOWN_DANGLING
    .map((entry) => entry.head + entry.tail)
    .filter((token) => new RegExp(`\\b${token}\\b`, 'u').test(self))
  assert.deepEqual(vouched, [], `登记表自己给这些名字背书了（会在见证面里自解析 ⇒ 登记失效）：${vouched.join('、')}`)
})

/** 合成探针用：给定文件面与见证面，现算的**全部**悬空身份（不去重、不扣登记）。 */
function allIdentities(files: readonly NoteFile[], witnesses: readonly NoteFile[]): string[] {
  return unresolvedRefs(files, witnesses).map(identityOf)
}
