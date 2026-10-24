/**
 * **声明形状的写入时校验**（`TASK-187`：可观测性③ / `DEF-163` / `DEF-168`）。
 *
 * ## 这个模块解决的是什么
 *
 * `impact` / `landing` / `writeScopes` 这三条声明是**机器读的**：判据拿它们与写范围、落点、
 * 在飞卡做集合运算。但修前它们**在写入那一刻没有任何校验** —— 于是把
 * `impact: ["src/office.ts（登记同步）"]` 这种**带中文括注**的值写进卡面时，没有任何人反对；
 * 错误要到 `done` 的判据面才炸（`landing-outside-scope` / `impact-undeclared`），而那时卡已经
 * 不可改（`DEF-163` / `DEF-168`）—— 作者只能看着一条永远对不上的声明烂在台账里。
 *
 * 本模块把校验搬到**接受声明的那一刻**（`sdo_task action=update` / `decompose` 建卡 /
 * `createTask` 兜底），三条当场判、不当场放行：
 *
 *   ① **纯路径**：不许中文说明、不许括注、不许空格、不许空串、不许重复
 *      （{@link PURE_PATH} 是唯一的字形判据，**不按扩展名/文件格式猜**：`REQ-060`）；
 *   ② **顶层目录必须真的存在**：`no-such-dir/x.ts` 这种"仓库里根本没有的顶层目录"当场拒绝；
 *   ③ **与在飞卡写范围相交**：相交**不是错**（同一处代码先后被两张卡改是常态），所以**接受**，
 *      但必须**点名**（{@link declarationOverlaps} 的读数由调用方印进回执/提示通道）。
 *
 * ## 为什么②只核**第一段**（写下来的取舍，别当漏项）
 *
 * 严格到"每一级都必须存在"会**误杀本卡的正常工作**：本仓的卡普遍声明**自己将要新建**的目录
 * （`test/m230/a/`、`src/ct-001/` 一类），那些目录在写入那一刻当然还不存在 —— 硬核会让
 * "新建目录的卡"一律建不出来。真正会咬人的是**顶层写错**（`tools/checks/` 之于没有 `tools/` 的
 * 仓库、`build/` 之于没有 `build/` 的仓库）：那说明作者把仓库布局记错了，不是"将要新建"。
 * 所以判据取**第一段**：顶层存在 ⇒ 放行（更深的路径可能由本卡自己创建）；不存在 ⇒ 拒绝，
 * 并在 remedy 里给"显式新建"的机械形态 —— **把新目录放在一个真实存在的顶层目录之下**。
 * 无 `/` 的路径（`README.md`、`pom.xml`）与 glob 打头的路径（首段含 `*` 的，如星号 + `/x`）不参与②。
 *
 * ## ③a ②的第二个边界：**裸工作区里判不了就不判**
 *
 * ② 需要一份"可对照的顶层布局"。工作区里除了台账目录（`.sdo/`）**什么都没有**时（刚初始化的项目、
 * 只放了台账的夹具目录），每一层都还没建 —— 那时"顶层目录不存在"**零信息量**：任何声明都是"将要新建"。
 * 所以在**对照集为空**时②整条跳过（与 `findProjectRoot` 不向上猜、`inject` 空文本不贡献内容同一方向：
 * 判不出来的事不许硬判）。真机上（仓库里有 `src/`、`test/`、`docs/` 一堆顶层）②照常生效。
 *
 * ## 为什么拒绝必须给示例
 *
 * 卡上的要求逐字是「拒绝要**可修**：报错必须给出『改成什么形状』的示例（纯路径数组），不许只说
 * 『形状不合法』」。所以每条回执都带 `example`，且**优先取该字段自己那条合法项**
 * （作者照着改一个字就行），该字段一条合法项都没有时才用该字段的规范样例。
 *
 * ## 不回溯历史
 *
 * 只对**新写入**生效：本模块**没有**任何"扫全库找旧违规"的入口。已 `done`/`dropped` 的老卡
 * （含历史上那批中文括注的 `impact`）不会被它碰 —— `DEF-163` 的误报由这条口径自然消失，
 * 不需要改判据、也不需要清洗历史（`updateTask` 只对活卡生效，`createTask`/`decompose` 只对新卡生效）。
 *
 * ## 文案
 *
 * 与 `domain/snapshot.ts` / `domain/changeFeed.ts` 同一处置：本模块**不在** m7 的硬编码中文棘轮基线里，
 * 而 `src/domain/plan.ts` **在**基线里（允许新增中文 0）—— 所以**所有面向人的句子都留在这里**
 * （{@link ZH} / {@link EN} 两份本地表，按 `locale()` 取），`plan.ts` / `office.ts` 只传结构与代码。
 * 语言包（`src/data/lang/*.yml`）不在本卡写范围，迁移面见交付说明的跟卡建议。
 */
import { readdirSync } from 'node:fs'

import { locale } from './i18n.js'
import { scopePathsIntersect } from './scopePaths.js'

/** 受校验的三条声明字段（**只有**这三个：其余字段是自由文本，不该被路径文法约束）。 */
export type DeclarationField = 'impact' | 'landing' | 'writeScopes'

/** **拒绝**码（结构面：回执按码印行，文案另给）。 */
export type DeclarationCode = 'not-a-path' | 'blank' | 'duplicate' | 'file-as-directory'

/**
 * **告警**码：不拦写入，但必须看得见。
 *
 * `unknown-top-dir` 曾经是**拒绝**，实测被退回：本仓的卡普遍声明**将来要新建**的目录
 * （`test/m230/a/`、`src/ct-001/`），而夹具/新项目的工作区里那些顶层目录当然还不存在 ——
 * 一拒绝就是"新建目录的卡一律建不出来"（真机反例：`test/m162.test.ts` 的夹具工作区只有 `build/`，
 * 声明 `src/x.ts` 被拒）。这是**判不了**，不是**判错了**：一个还不存在的顶层目录既可能是笔误，
 * 也可能就是本卡要创建的。所以它降级成告警（口径②的"**要求显式新建标记**"分支：
 * 工具把这个事实变成**必须看见**的一行，并给出"先建目录 / 或确认由本卡新建"两条出路），
 * 而**真正的错**——把一个**已存在的文件**当目录用（`README.md/x.ts`）——仍然当场拒绝。
 */
export type DeclarationWarningCode = 'unknown-top-dir'

/** 一条告警（结构：字段 / 位置 / 原文；**不拦写入**）。 */
export interface DeclarationWarning {
  field: DeclarationField
  index: number
  code: DeclarationWarningCode
  raw: string
  /** 缺失的顶层目录名 */
  missing: string
}

/**
 * **纯路径的字形判据**（唯一实现）。
 *
 * 允许：字母数字、`.`、`_`、`-`、`@`、`+`、`~`、`*`（glob）、`/`（目录）。
 * 因此**逐步排除**了：中文说明与全角标点、`（）` / `()` 括注、空格、`:`、`;`、`,`、`|`、引号 ——
 * 这些正是"带括注"的实际形态。不按扩展名/文件格式判（`REQ-060`：不引入文件格式知识）。
 */
const PURE_PATH = /^[A-Za-z0-9._@+~][A-Za-z0-9._@+~/*-]*$/u

/** 一条问题（结构化：字段 / 位置 / 码 / 原文 / 重复项首见位置）。 */
export interface DeclarationProblem {
  field: DeclarationField
  /** 该字段里的第几项（0 起） */
  index: number
  code: DeclarationCode
  /** 被拒的原文（**原样回声**，作者才认得出自己写的那一条） */
  raw: string
  /** 只有 `duplicate` 有：同一项**第一次**出现的位置（0 起） */
  firstIndex?: number | undefined
}

export interface DeclarationCheckResult {
  ok: boolean
  /** **拒绝**清单（`ok` 时为空数组） */
  problems: DeclarationProblem[]
  /** **告警**清单（不拦写入；`ok` 时也可能非空 —— 那是"必须看见但不该拒"的读数） */
  warnings: DeclarationWarning[]
  /** 首条问题的码（回执的 `[code]` 位；`ok` 时为空串） */
  code: DeclarationCode | ''
  /** 整份可读解释（含**修法示例**；`ok` 时为空串） */
  detail: string
  /** 修法示例（**纯路径数组**；`ok` 时为空数组） */
  example: string[]
  /** 归一后的声明（`ok` 时才有：已去两端空白、已去 `./` 前缀、已去重） */
  normalized: { impact?: string[] | undefined; landing?: string[] | undefined; writeScopes?: string[] | undefined }
}

/** 一条"与在飞卡相交"的读数（**相交不是错**，只要求可见）。 */
export interface DeclarationOverlap {
  field: DeclarationField
  /** 声明的那条路径 */
  path: string
  /** 与哪张**在飞卡**相交 */
  taskId: string
  /** 那张卡的哪条写范围被撞上 */
  otherScope: string
  /**
   * **声明方是谁**（舰队级读数用）。
   *
   * 为什么需要它：改卡回执里的读数天然知道"是谁在声明"（就是刚改的那张卡），可一旦读数被存下来
   * 给**别的读者**（`office.declarationOverlaps` 的舰队视图），"谁的声明 × 谁的写范围"就必须两个都写清 ——
   * 否则两个 id 挤进一个字段（早先写成 `A×B` 那种拼串），读者只能猜哪边是声明方。
   */
  declaredBy?: string | undefined
}

interface Labels {
  notPath: (field: string, index: number, raw: string) => string
  blank: (field: string, index: number) => string
  duplicate: (field: string, raw: string, first: number) => string
  fixShape: (example: string) => string
  overlapNote: (taskId: string, field: string, path: string, other: string) => string
  overlapNoteOwned: (declaredBy: string, taskId: string, field: string, path: string, other: string) => string
  /** 把一个**文件**当目录用（真错，当场拒） */
  fileAsDirectory: (field: string, index: number, raw: string, file: string) => string
  /** 顶层目录还不存在（告警：可能是笔误，也可能是本卡要新建） */
  topMissing: (field: string, index: number, raw: string, missing: string) => string
}

const ZH: Labels = {
  notPath: (field, index, raw) => `${field} 的第 ${String(index + 1)} 项 \`${raw}\` 不是纯路径：声明是给判据做集合运算的，`
    + '不能带中文说明、括注、空格或标点。',
  blank: (field, index) => `${field} 的第 ${String(index + 1)} 项是空串：空串会被判据当成"有一条声明"，`
    + '但它什么都不指 —— 要撤回声明就给空数组 `[]`，不要留空串。',
  duplicate: (field, raw, first) => `${field} 里 \`${raw}\` 重复出现（第一次在第 ${String(first + 1)} 项）：`
    + '重复项会让"声明了几条"这类读数虚高。',
  fileAsDirectory: (field, index, raw, file) => `${field} 的第 ${String(index + 1)} 项 \`${raw}\` 把一个**文件**当目录用：`
    + `\`${file}\` 是文件，不可能是它下面的目录 —— 这是笔误（把目标文件与它的父目录写反了）。`,
  topMissing: (field, index, raw, missing) => `⚠ ${field} 的第 ${String(index + 1)} 项 \`${raw}\` 的顶层目录 \`${missing}\` 在仓库里还不存在：`
    + '若这是笔误，改到已存在的顶层目录之下；若这个目录由本卡**新建**，请确认后照写（工具不替你判"要新建"与"写错了"）。',
  fixShape: (example) => `  → 改成纯路径数组：${example}`,
  overlapNote: (taskId, field, path, other) => `${field} 的 \`${path}\` 与在飞卡 ${taskId} 的写范围 \`${other}\` 相交`
    + '（相交不是错：同一处代码先后被两张卡改是常态；列出来是为了**可见**）。',
  overlapNoteOwned: (declaredBy, taskId, field, path, other) => `${declaredBy} 的 ${field} 声明 \`${path}\` `
    + `与在飞卡 ${taskId} 的写范围 \`${other}\` 相交（相交不是错：同一处代码先后被两张卡改是常态；列出来是为了**可见**）。`,
}

const EN: Labels = {
  notPath: (field, index, raw) => `${field} entry #${String(index + 1)} \`${raw}\` is not a pure path: declarations are `
    + 'set-operands for the criteria, so they cannot carry annotations, parentheses, spaces or punctuation.',
  blank: (field, index) => `${field} entry #${String(index + 1)} is blank: a blank entry still counts as a declaration `
    + 'while pointing at nothing. Use `[]` to withdraw the declaration instead of leaving a blank string.',
  duplicate: (field, raw, first) => `${field} repeats \`${raw}\` (first seen at entry #${String(first + 1)}): `
    + 'duplicates inflate "how many declarations" readings.',
  fileAsDirectory: (field, index, raw, file) => `${field} entry #${String(index + 1)} \`${raw}\` uses a **file** as a directory: `
    + `\`${file}\` is a file and cannot contain that path -- the file and its parent directory were swapped.`,
  topMissing: (field, index, raw, missing) => `WARNING: ${field} entry #${String(index + 1)} \`${raw}\` has top-level directory \`${missing}\`, `
    + 'which does not exist yet: fix it to sit under an existing top-level directory, or keep it if this card creates that directory '
    + '(the tool does not guess between "typo" and "new directory").',
  fixShape: (example) => `  -> use a pure path array instead: ${example}`,
  overlapNote: (taskId, field, path, other) => `${field} entry \`${path}\` overlaps in-flight card ${taskId}'s write scope `
    + `\`${other}\` (overlap is not an error -- two cards touching the same code in sequence is normal; this is listed so it stays visible).`,
  overlapNoteOwned: (declaredBy, taskId, field, path, other) => `${declaredBy}'s ${field} entry \`${path}\` overlaps in-flight card `
    + `${taskId}'s write scope \`${other}\` (overlap is not an error -- two cards touching the same code in sequence is normal; `
    + 'this is listed so it stays visible).',
}

/** 取当前语言的标签表（`en` 之外一律按基准语言渲染 —— 与 `locale()` 的回落口径一致）。 */
function labels(): Labels {
  return locale() === 'en' ? EN : ZH
}

/** 该字段的规范样例（作者手里一条合法项都没有时的兜底示例）。 */
const SAMPLE: Record<DeclarationField, string> = {
  impact: 'src/office.ts',
  landing: 'src/office.ts',
  writeScopes: 'src/domain/',
}

/** 去 `./` 前缀与两端空白（**不做** `..` 折叠：那是判定层的事）。 */
function shapeOf(raw: string): string {
  return raw.trim().replace(/^\.\//u, '')
}

/** 该路径的**第一段**（决定"顶层目录是否存在"）；glob 元字符去掉。 */
function topSegmentOf(path: string): string {
  const first = shapeOf(path).split('/')[0] ?? ''
  return first.replace(/[*?[\]]/gu, '')
}

/**
 * 仓库里真实存在的顶层条目（按字母序，**不截断**）。
 *
 * ⚠️ 成员判定必须用**全表**：早先这里在返回前 `slice(0, 12)`，于是 `src` / `test` 这类排在字母表
 * 中段的目录**不在前 12 个里** ⇒ 合法的 `src/x.ts` 被判成"顶层目录不存在"。截断只能发生在
 * **显示**那一步（`topMissing` 的告警文本），不能发生在**判定**这一步。
 */
function topLevelEntries(root: string, kind: 'dir' | 'file'): string[] {
  if (root === '') return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => (kind === 'dir' ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 工作区顶层的**目录**（判"目录存在"用）。 */
function topLevelDirs(root: string): string[] {
  return topLevelEntries(root, 'dir')
}

/** 工作区顶层的**文件**（判"把文件当目录用"用）。 */
function topLevelFiles(root: string): string[] {
  return topLevelEntries(root, 'file')
}

/** 一个字段的校验结果（内部用：保留原文位置，供②与示例引用）。 */
interface FieldCheck {
  /** 通过①的条目（去重后），带原文位置 */
  kept: { path: string; index: number }[]
  /** 该字段是否被这次调用声明过（`undefined` = 没声明） */
  declared: boolean
}

/**
 * **校验一份声明**（`impact` / `landing` / `writeScopes` / `addWriteScopes`）。
 *
 * 三条口径见模块注释。`root` 是**工作区根**：只用于②（顶层目录是否真的存在）——
 * 传 `undefined` 时②**整条跳过**（判不了就不判，绝不因为拿不到工作区就把合法声明拒掉）。
 *
 * 返回的结构化部分（`problems` / `code` / `example`）给判据与守卫读，`detail` 给人读。
 */
export function checkDeclaration(
  input: {
    impact?: readonly string[] | undefined
    landing?: readonly string[] | undefined
    writeScopes?: readonly string[] | undefined
    addWriteScopes?: readonly string[] | undefined
  },
  options: {
    root?: string | undefined
    ledgerDir?: string | undefined
    /**
     * **②（顶层目录存在性）是否生效**（缺省 `true`）。
     *
     * `decompose` 的 draft 里有一半是**结构通道按项目模板推导**出来的写范围（`test/des-001/` 一类），
     * 它们不是"某个作者的声明"，新建目录正是模板的本职 —— 对它们核存在性只会把结构通道整条打死
     * （真机形态：夹具工作区里只有 `src/`，模板却给了 `test/des-001/` ⇒ 一张卡都建不出来）。
     * 所以**建卡路径**（`decompose` / `createTask` 由它调用）只判**形状**（①③），
     * 存在性只挂在**声明的写入面**（`sdo_task action=update`，即本卡要治的那个场景）。
     */
    existence?: boolean | undefined
  } = {},
): DeclarationCheckResult {
  const label = labels()
  const problems: DeclarationProblem[] = []
  // **对照集**：工作区顶层减去台账目录（`.sdo/`）。空 ⇒ 裸工作区 ⇒ ② 整条跳过（见模块注释 ③a）
  const layoutDirs = topLevelDirs(options.root ?? '').filter((name) => name !== (options.ledgerDir ?? '.sdo'))
  const layoutFiles = topLevelFiles(options.root ?? '').filter((name) => name !== (options.ledgerDir ?? '.sdo'))
  const tops = new Set(layoutDirs)
  const files = new Set(layoutFiles)
  const comparable = options.existence !== false && layoutDirs.length + layoutFiles.length > 0

  const warnings: DeclarationWarning[] = []
  const checkField = (field: DeclarationField, raw: readonly string[] | undefined, mode: { append?: boolean } = {}): FieldCheck => {
    if (raw === undefined) return { kept: [], declared: false }
    const seen = new Map<string, number>()
    const kept: { path: string; index: number }[] = []
    raw.forEach((item, index) => {
      const text = String(item ?? '')
      const path = shapeOf(text)
      if (path === '') {
        // 追加通道的空串是"没写"，既有实现直接跳过 ⇒ 这里同样不判红
        if (mode.append !== true) problems.push({ field, index, code: 'blank', raw: text })
        return
      }
      if (!PURE_PATH.test(path)) {
        problems.push({ field, index, code: 'not-a-path', raw: text })
        return
      }
      const first = seen.get(path)
      if (first !== undefined) {
        // 追加通道的重复项由既有实现归一去重（见上面的注释）⇒ 不判红
        if (mode.append !== true) problems.push({ field, index, code: 'duplicate', raw: path, firstIndex: first })
        return
      }
      seen.set(path, index)
      /**
       * ② 顶层目录（无 `/` 的顶层条目与 glob 打头的一律不判 —— 见模块注释）：
       *   · 顶层是**已存在的文件** ⇒ **拒绝**（`file-as-directory`：这是笔误，永远错）；
       *   · 顶层**还不存在** ⇒ 只**告警**（可能是笔误，也可能由本卡新建 ⇒ 判不了就不拦）。
       */
      if (comparable && path.includes('/') && !/[*?[\]]/u.test(path.split('/')[0] ?? '')) {
        const top = topSegmentOf(path)
        if (top !== '' && !tops.has(top)) {
          if (files.has(top)) {
            problems.push({ field, index, code: 'file-as-directory', raw: path })
            return
          }
          warnings.push({ field, index, code: 'unknown-top-dir', raw: path, missing: top })
        }
      }
      kept.push({ path, index })
    })
    return { kept, declared: true }
  }

  const impact = checkField('impact', input.impact)
  const landing = checkField('landing', input.landing)
  const writeScopes = checkField('writeScopes', input.writeScopes)
  /**
   * 追加写范围（`addWriteScopes`）：**只判字形与存在性，不判重复/空串**。
   *
   * 为什么不一样：追加通道的既有语义就是"归一去重"（`collab.ts` 的 `addWriteScopes` 会跳过
   * 空串与已存在的范围，`test/m126.test.ts` 把它钉成契约：`['src/b.ts', './src/b.ts', 'src/b.ts/']`
   * 必须被**收下**并去重）。在这里把重复判成错，等于把"无害的冗余写法"升级成拒绝 ——
   * 那是行为回退，不是校验。所以这一路只拦住"不是路径"与"顶层写错"。
   */
  const addScopes = checkField('writeScopes', input.addWriteScopes, { append: true })

  const normalized: DeclarationCheckResult['normalized'] = {}
  if (impact.declared) normalized.impact = impact.kept.map((item) => item.path)
  if (landing.declared) normalized.landing = landing.kept.map((item) => item.path)
  if (writeScopes.declared) normalized.writeScopes = writeScopes.kept.map((item) => item.path)
  if (addScopes.declared) normalized.writeScopes = [...(normalized.writeScopes ?? []), ...addScopes.kept.map((item) => item.path)]

  if (problems.length === 0) {
    return { ok: true, problems: [], warnings, code: '', detail: '', example: [], normalized }
  }

  // 示例：**优先取该字段自己那条合法项**（作者照着改一个字就行）
  const firstField = problems[0]?.field ?? 'impact'
  const validOf = firstField === 'impact' ? impact : firstField === 'landing' ? landing : writeScopes
  const example = validOf.kept.length > 0
    ? validOf.kept.slice(0, 3).map((item) => item.path)
    /**
     * `file-as-directory` 的示例要**直指那句话**：作者把"目标文件"与"它的父目录"写反了，
     * 所以最省事的改法就是**只写那个文件**（`README.md/x.ts` ⇒ `README.md`），而不是换个无关目录。
     */
    : problems[0]?.code === 'file-as-directory'
      ? [topSegmentOf(problems[0].raw)]
      : [SAMPLE[firstField]]

  const lines = problems.map((problem) => {
    switch (problem.code) {
      case 'not-a-path':
        return label.notPath(problem.field, problem.index, problem.raw)
      case 'blank':
        return label.blank(problem.field, problem.index)
      case 'duplicate':
        return label.duplicate(problem.field, problem.raw, problem.firstIndex ?? 0)
      case 'file-as-directory':
        // 点名那个**文件**（笔误的另一半：把目标文件与它的父目录写反了）
        return label.fileAsDirectory(problem.field, problem.index, problem.raw, topSegmentOf(problem.raw))
    }
  })
  return {
    ok: false,
    problems,
    warnings,
    code: problems[0]?.code ?? 'not-a-path',
    detail: lines.join('\n') + '\n' + label.fixShape(JSON.stringify(example)),
    example,
    normalized,
  }
}

/**
 * **与在飞卡的写范围相交**（口径③）：相交**不是错**，只要求可见。
 *
 * 判据走**唯一的相交出口** `scopePathsIntersect`（ADR-009：四处各写一份正是 `DEF-057` 的成因）——
 * 本模块不另造前缀匹配。`inFlight` 由调用方给（`office.updateTask` 传"除本卡外的 in-progress 卡"），
 * 于是"哪些卡算在飞"这条口径仍然只有一处定义。
 */
export function declarationOverlaps(
  declarations: { impact?: readonly string[] | undefined; landing?: readonly string[] | undefined; writeScopes?: readonly string[] | undefined },
  inFlight: readonly { id: string; writeScopes: readonly string[] }[],
): DeclarationOverlap[] {
  const out: DeclarationOverlap[] = []
  const fields: DeclarationField[] = ['writeScopes', 'impact', 'landing']
  for (const field of fields) {
    for (const raw of declarations[field] ?? []) {
      const path = shapeOf(String(raw ?? ''))
      if (path === '') continue
      for (const other of inFlight) {
        for (const scope of other.writeScopes) {
          const otherScope = shapeOf(String(scope ?? ''))
          if (otherScope === '' || !scopePathsIntersect(path, otherScope)) continue
          out.push({ field, path, taskId: other.id, otherScope })
        }
      }
    }
  }
  return out
}

/** 把一条**告警**渲染成一句人话（不拦写入；给回执的尾注用；语言随 `locale()`）。 */
export function describeWarning(warning: DeclarationWarning): string {
  return labels().topMissing(warning.field, warning.index, warning.raw, warning.missing)
}

/** 把一条相交读数渲染成**一句人话**（给回执/提示通道用；语言随 `locale()`）。 */
export function describeOverlap(overlap: DeclarationOverlap): string {
  const label = labels()
  return overlap.declaredBy === undefined || overlap.declaredBy === ''
    ? label.overlapNote(overlap.taskId, overlap.field, overlap.path, overlap.otherScope)
    : label.overlapNoteOwned(overlap.declaredBy, overlap.taskId, overlap.field, overlap.path, overlap.otherScope)
}
