/**
 * **增量 120：语言包的「跳段同名死副本」与「零引用键」守卫**（REV-053 同一病灶的通用形态）。
 *
 * 病灶长什么样（REV-053 原始读数）：同一个键名在两个**不同段**里各写了一份 —— 旧段那份**全仓零引用**
 * （谁也取不到它），新段那份才是活键。两层伤害：
 *   ① 后人按名字搜到两份，改错那一份 ⇒ **白改**（读数看着改了，取值一点没变）；
 *   ② 死键会一直躺着，`en` / `zh-CN` 两侧还得跟着同步翻译，越积越多。
 *
 * 因此本守卫断言的**不是**「跨段同名 = 0」—— 跨段同名在本项目里**多数是正常设计**：
 *   · `k1…k29` 是每个界面面（`uiTools` / `uiRender` / `uiDescribe` / `uiIndex` …）各自的编号键；
 *   · `uiSignValue` / `uiSignField` / `uiSignView` / `gate` / `criterion` / `dimension` 这些段是
 *     **动态取值表**（代码用 `` `段名.${标识}` `` 查），表里的键本来就不该逐条出现在代码里。
 * 真正的病灶是「**同名键里有一份谁也取不到**」（本文件称之为**死副本**）—— 那才是要归零的东西。
 *
 * 五个断言：
 *   · `M120-01` 两包都不得有「跳段同名死副本」；
 *   · `M120-02` 两包的零引用键**基线为 0**（新增死键即红，逐个点名 `段.键 @行`），且**不得留空段壳**；
 *     本轮只留**1 条按身份豁免**的（`DEAD_KEY_WAIVERS`，理由逐条写在那个常量旁边：删了会踩到 `m189`
 *     的 label 普查下界，而"不动判据"是本卡边界）—— 豁免是**名单**，不是数字基线；
 *   · `M120-03` 删完之后 `en` 仍**逐键覆盖** `zh-CN` 且 `en` 里不得残留中文（与 `m7` 同口径；
 *     这一条专门防「删了 `zh-CN` 忘了删 `en`」把半翻译放进来 —— 那种红会由 `m7` 抓到）；
 *   · `M120-04` 扫描器**自证不空转**：合成输入上「能判死也能判活」，并自证**注释不算引用**
 *     （`M120-05` 单列抹注释这条路：行注释 / 块注释 / 行尾注释 / 字符串里的 `//` / 正则里的引号）。
 *
 * **可达性口径**（`reachableOf()`，唯一一处判据）：
 *   ① 静态：代码面出现 `段.键` 字面量（`t('uiPlan.k13')`、`fmt(…)`、以及任何字符串常量表）；
 *   ② 动态段：代码面存在 `` `段.${…}` `` 模板，或 `label('段', …)` —— 整段按键名动态取值；
 *   ③ 动态前缀：代码面存在 `` `段.前缀_${…}` `` 模板（如 `uiSignPayload.col_${coll.}`），
 *      则 `段.前缀_*` 这一族算可达；
 *   ④ 以上都不满足 ⇒ **零引用（死键）**。
 * 代码面 = `src/` + `test/` 的 `.ts`，**且注释与用例标题都已抹成空格**
 * （`.md` / 台账 / 构建产物 / **代码注释** / **用例标题**都不算引用 —— 文档里提到一个键不代表有人取它；
 * 这正是 REV-053 里「以为还在用」的来源）。
 * 这两层抹除都有实测依据（变异自证，见报告）：
 *   · 只抹注释 ⇒ 把 REV-053 那个死键放回语言包，本守卫**仍然绿**（`test/m136.test.ts` 的**用例标题**里
 *     写着它的全名）；把标题也抹掉 ⇒ 同一个变异**立刻红**（M120-01 + M120-02 双双点名）。
 *
 * 已知边界（写下来，免得下一个人以为是漏判）：
 *   · 若将来出现**段名本身是变量**的查表（例如 `t(section + '.' + id)` 且 `section` 来自入参），
 *     本扫描器看不到 ⇒ 会**假红**。补法是把那种形态加进 `dynSections` / `dynPrefixes`，
 *     **不要**把基线抬起来（抬基线等于把守卫关掉）。
 *   · 本文件的**代码**里不写任何 `段.键` 字面量：它自己也在代码面里，写了就等于给那个键伪造一条引用
 *     （注释里写无妨 —— 注释已被抹掉，但那也说明"注释不算引用"这条口径在自我适用）。
 *
 * 背景：REV-053 的原始标本是 `uiIndex` 段的那个 `kScopeReleaseHint`（旧段死副本，活键在 `uiPlan`）；
 * 那一份由先前的批次删除并由 `m136` 的 `M136-02` 钉住，本文件管的是**同类再生**。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PACKS = ['src/data/lang/zh-CN.yml', 'src/data/lang/en.yml'] as const
const CJK = /[\u4e00-\u9fff]/u

interface Entry {
  section: string
  key: string
  /** 1 基行号（报错时点名用）。 */
  line: number
  value: string
}

/** 段头（顶格 `段名:`）与键行（缩进 2 空格 `键: 值`）；键名允许连字符（`no-go`）。 */
const SECTION_HEAD = /^([a-zA-Z][A-Za-z0-9_-]*):\s*$/u
const KEY_LINE = /^ {2}([A-Za-z][A-Za-z0-9_-]*):(.*)$/u

function entriesOf(text: string): Entry[] {
  const out: Entry[] = []
  let section = '?'
  text.split('\n').forEach((line, index) => {
    const head = SECTION_HEAD.exec(line)
    if (head !== null) {
      section = head[1] as string
      return
    }
    const key = KEY_LINE.exec(line)
    if (key === null) return
    out.push({ section, key: key[1] as string, line: index + 1, value: (key[2] ?? '').trim() })
  })
  return out
}

function readPack(pack: string): Entry[] {
  return entriesOf(readFileSync(join(ROOT, pack), 'utf8'))
}

/** 空段壳：段头还在、底下一个键都没有（键删净了却把壳留下 ⇒ 后人以为"这一段还在用"）。 */
function emptySections(text: string): string[] {
  const shells: string[] = []
  let section: string | undefined
  let keys = 0
  const flush = (): void => {
    if (section !== undefined && keys === 0) shells.push(section)
  }
  for (const line of text.split('\n')) {
    const head = SECTION_HEAD.exec(line)
    if (head !== null) {
      flush()
      section = head[1] as string
      keys = 0
      continue
    }
    if (KEY_LINE.test(line)) keys += 1
  }
  flush()
  return shells
}

/** 判 `/` 是不是**正则字面量**起点（而非除号）：看前一个非空白字符是否在"值位置"。口径同 `src/domain/langScan.ts`。 */
function regexStart(source: string, index: number): boolean {
  let k = index - 1
  while (k >= 0 && /\s/u.test(source[k] ?? '')) k -= 1
  if (k < 0) return true
  const prev = source[k] ?? ''
  if ('(,=:[!&|?{};'.includes(prev)) return true
  const word = /([A-Za-z_$][\w$]*)\s*$/u.exec(source.slice(Math.max(0, k - 10), k + 1))
  return word !== null && ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void'].includes(word[1] ?? '')
}

/**
 * **把注释整段抹掉**（保留换行，便于行号仍能对上），字符串/模板/正则字面量原样保留。
 *
 * 为什么必须抹：**注释里提到一个键，不代表有人取它** —— 真机上 REV-053 的标本就栽在这上面：
 * `test/m136.test.ts` 的注释里写着那个死键的全名，于是「零引用」扫描把它当成活的
 * （实测：把死键放回语言包，守卫仍然绿 —— 变异存活）。这与"`.md` 里提过就算引用"是同一个坑。
 */
export function stripComments(source: string): string {
  const out: string[] = []
  const stack: ('code' | 'template')[] = []
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const mode = stack.length === 0 ? 'code' : (stack[stack.length - 1] as 'code' | 'template')
    if (mode === 'template') {
      if (ch === '\\') {
        out.push(source.slice(i, i + 2))
        i += 2
        continue
      }
      if (ch === '`') {
        out.push(ch)
        i += 1
        stack.pop()
        continue
      }
      if (ch === '$' && source[i + 1] === '{') {
        out.push('${')
        i += 2
        stack.push('code')
        continue
      }
      out.push(ch ?? '')
      i += 1
      continue
    }
    // 代码态：行注释 / 块注释 / 字符串 / 模板 / 正则 / `${}` 的收尾
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out.push('\n')
        i += 1
      }
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      out.push(ch)
      i += 1
      while (i < n) {
        const inner = source[i]
        if (inner === '\\') {
          out.push(source.slice(i, i + 2))
          i += 2
          continue
        }
        out.push(inner ?? '')
        i += 1
        if (inner === quote) break
      }
      continue
    }
    if (ch === '`') {
      out.push(ch)
      i += 1
      stack.push('template')
      continue
    }
    if (ch === '/' && regexStart(source, i)) {
      out.push(ch)
      i += 1
      let inClass = false
      while (i < n) {
        const inner = source[i]
        if (inner === '\\') {
          out.push(source.slice(i, i + 2))
          i += 2
          continue
        }
        out.push(inner ?? '')
        i += 1
        if (inner === '[') inClass = true
        else if (inner === ']') inClass = false
        else if (inner === '/' && !inClass) break
        else if (inner === '\n') break
      }
      continue
    }
    if (ch === '}' && stack.length > 0) {
      out.push(ch)
      i += 1
      stack.pop()
      continue
    }
    out.push(ch ?? '')
    i += 1
  }
  return out.join('')
}

/**
 * **把「测试标题」整段抹成空格**（换行保留 ⇒ 偏移与行号都不变）。
 *
 * 与注释同一个道理：`test('… uiIndex 那个 kScopeReleaseHint 已删 …')` 里的**标题是散文**，
 * 它只是"把被测的东西念一遍"，不是取它。实测依据：`test/m136.test.ts` 的用例标题里就写着
 * REV-053 死键的全名 —— 抹注释之后变异**仍然存活**，直到把标题也抹掉才被杀。
 * 只抹 `test` / `it` / `describe`（含 `.only` / `.skip` / `.todo`）的**第一个字符串参数**。
 */
export function maskTestTitles(code: string): string {
  const out: string[] = []
  const CALL = /(?:^|[^\w$.])(?:test|it|describe)(?:\.(?:only|skip|todo))?\(/gu
  let i = 0
  while (i < code.length) {
    CALL.lastIndex = i
    const match = CALL.exec(code)
    if (match === null) {
      out.push(code.slice(i))
      break
    }
    const open = CALL.lastIndex
    let j = open
    while (j < code.length && /\s/u.test(code[j] ?? '')) j += 1
    const quote = code[j]
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      out.push(code.slice(i, open))
      i = open
      continue
    }
    let k = j + 1
    while (k < code.length) {
      const ch = code[k]
      if (ch === '\\') {
        k += 2
        continue
      }
      if (ch === quote) break
      k += 1
    }
    out.push(code.slice(i, j + 1))
    out.push(code.slice(j + 1, k).replace(/[^\n]/gu, ' '))
    i = k
  }
  return out.join('')
}

/**
 * 代码面：`src/` + `test/` 下的全部 `.ts` 源码，**注释与测试标题已抹成空格**（二者都是散文，不是引用），
 * 并**排除本文件自己**。
 *
 * 为什么排除自己：本文件必须**写出**被豁免的死键名（`DEAD_KEY_WAIVERS`）与被杀死的探针名，
 * 它自己也在代码面里 ⇒ 一写就等于给那个键伪造一条"引用"（实测：豁免名单第一版就是这么把自己喂饱的，
 * 死键读数从 1 变 0，守卫立刻空转）。这条口径与 `m191` 的"引用自己那一行不算"同源：
 * **判据不能给自己的举例背书**。排除面**只有本文件**（`M120-04` 断言别的文件里的引用照旧算数）。
 */
function codeFace(): string {
  const SELF = 'test/m120.test.ts'
  const read = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { recursive: true })
      .map((entry) => String(entry).replace(/\\/gu, '/'))
      .filter((entry) => entry.endsWith('.ts') && `${dir}/${entry}` !== SELF)
      .sort()
      .map((entry) => maskTestTitles(stripComments(readFileSync(join(ROOT, dir, entry), 'utf8'))))
  return [...read('src'), ...read('test')].join('\n')
}

/** 动态查表面：模板串 `` `段.${…}` `` 与 `label('段', …)`。 */
function dynamicSections(code: string): Set<string> {
  const found = new Set<string>()
  for (const match of code.matchAll(/` {0,4}([A-Za-z][A-Za-z0-9_]*)\.\$\{/gu)) found.add(match[1] as string)
  for (const match of code.matchAll(/\blabel\(\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/gu)) found.add(match[1] as string)
  return found
}

/** 动态前缀族：模板串 `` `段.前缀_${…}` ``（`uiSignPayload.col_${…}` 这种）。 */
function dynamicPrefixes(code: string): { section: string; prefix: string }[] {
  const found: { section: string; prefix: string }[] = []
  for (const match of code.matchAll(/` {0,4}([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*(?:_))?\$\{/gu)) {
    const prefix = match[2]
    if (prefix !== undefined && prefix !== '') found.push({ section: match[1] as string, prefix })
  }
  return found
}

/**
 * 判一条键**有没有人取**。返回命中的形态名（便于报错时说清凭什么判它活），零引用返回 `undefined`。
 * 三种形态的口径见文件头。
 */
export function reachableOf(
  entry: { section: string; key: string },
  code: string,
  dynSections: Set<string> = dynamicSections(code),
  dynPrefixes: { section: string; prefix: string }[] = dynamicPrefixes(code),
): string | undefined {
  if (code.includes(`${entry.section}.${entry.key}`)) return 'static'
  if (dynSections.has(entry.section)) return 'dynamic-section'
  for (const item of dynPrefixes) {
    if (item.section === entry.section && entry.key.startsWith(item.prefix)) return `dynamic-prefix:${item.prefix}`
  }
  return undefined
}

/** 零引用键（按包内顺序，带行号，便于报错点名）。 */
function deadKeys(pack: string, code = codeFace()): Entry[] {
  const dynSections = dynamicSections(code)
  const dynPrefixes = dynamicPrefixes(code)
  return readPack(pack).filter((entry) => reachableOf(entry, code, dynSections, dynPrefixes) === undefined)
}

/** `段.键 @行` 形态的点名串。 */
function nameOf(entries: readonly Entry[], pack: string): string {
  return entries.map((entry) => `${entry.section}.${entry.key} @${pack}:${entry.line}`).join('；')
}

test('M120-01 两包均无「跳段同名死副本」（同名键里不许有一份谁也取不到）', () => {
  const code = codeFace()
  const dynSections = dynamicSections(code)
  const dynPrefixes = dynamicPrefixes(code)
  for (const pack of PACKS) {
    const entries = readPack(pack)
    const byName = new Map<string, Entry[]>()
    for (const entry of entries) {
      const list = byName.get(entry.key)
      if (list === undefined) byName.set(entry.key, [entry])
      else list.push(entry)
    }
    const offenders: string[] = []
    let crossSectionNames = 0
    for (const [name, copies] of byName) {
      // 只在**同一段内**出现多次不算跳段（那是同段重复键，归 `m136` 的 M136-03 管）。
      if (new Set(copies.map((copy) => copy.section)).size < 2) continue
      crossSectionNames += 1
      const dead = copies.filter((copy) => reachableOf(copy, code, dynSections, dynPrefixes) === undefined)
      if (dead.length === 0) continue
      const live = copies.filter((copy) => !dead.includes(copy)).map((copy) => `${copy.section}@${copy.line}`)
      offenders.push(
        `${name}：死副本 ${dead.map((copy) => `${copy.section}@${copy.line}`).join('/')}` +
          `（活键在 ${live.join('/') === '' ? '**一个都没有**（整名零引用）' : live.join('/')}）`,
      )
    }
    assert.deepEqual(
      offenders,
      [],
      `${pack} 有 ${offenders.length} 组跳段同名死副本（跨段同名共 ${crossSectionNames} 组，其余都是正常设计）：` +
        `${offenders.join(' ｜ ')} —— 删掉死的那一份（两包同步），或把引用改到你要保留的那一份`,
    )
  }
})

/**
 * **按身份豁免的零引用键**（这不是"抬基线"：基线仍是 0 条，这里**逐条点名**）—— 本轮只留下 1 条，
 * 理由在下一段；把它从语言包里删掉（或在别处补上引用）时，本守卫会立刻红并提示把它从名单里划掉。
 */
const DEAD_KEY_WAIVERS: readonly string[] = [
  // 这一条的取值「阶段」是 m189（DEF-093 读散文普查）里 test/m23.test.ts:284 那**一个**站点的
  // **偶然** label 豁免 —— `classifySite` 只判「串是否逐字等于语言包某个取值」，不问语义。
  // 删掉它 ⇒ 站点判 `prose` ⇒ `labelSites` 从 67 掉到 66 ⇒ m189 的 `labelSites >= 67` 这条
  // **别人的判据常量**失守。本卡的边界明写「不动判据与实现」，所以走本卡自己的处置通道
  // 「处置不了的要留名并说明理由」，而不是去改 m189 的普查下界。
  // 收紧办法（建议另开一张卡）：把 m189 的 label 普查下界按现算重新标定，然后删掉这一条。
  'uiDesign.docPhase',
]

test('M120-02 两包零引用键基线 = 0（新增死键即红；本轮只留 1 条按身份豁免的，理由见常量注释）', () => {
  for (const pack of PACKS) {
    const dead = deadKeys(pack)
    // **恰好相等**（两个方向都咬）：新增死键 ⇒ 多出来的名字被点名；豁免项被删/被补引用 ⇒ 也红，提示划掉名单。
    assert.deepEqual(
      dead.map((entry) => `${entry.section}.${entry.key}`),
      [...DEAD_KEY_WAIVERS],
      `${pack} 的零引用键必须**恰好**等于按身份豁免的那 ${DEAD_KEY_WAIVERS.length} 条（现算 ${dead.length} 条）：` +
        `${nameOf(dead, pack)} —— 新增的要么删掉（两包同步，\`en\` 那份也必须删）、要么补引用；` +
        '**不要**把基线抬起来；豁免项若已处置，请把它从 `DEAD_KEY_WAIVERS` 里划掉',
    )

    // 空段壳同样要归零：把一段的键全删了却把段头留着，下一个人会以为"这一段还在用"。
    const shells = emptySections(readFileSync(join(ROOT, pack), 'utf8'))
    assert.deepEqual(shells, [], `${pack} 有 ${shells.length} 个空段壳（段头还在、一条键都没有）：${shells.join(' ')} —— 段头一起删掉`)
  }
})

test('M120-03 en 逐键覆盖 zh-CN，且 en 里不残留中文（删键后不得破配对，否则 m7 会红）', () => {
  const zh = readPack('src/data/lang/zh-CN.yml')
  const en = readPack('src/data/lang/en.yml')
  const enMap = new Map(en.map((entry) => [`${entry.section}.${entry.key}`, entry]))

  const missing = zh.filter((entry) => {
    const hit = enMap.get(`${entry.section}.${entry.key}`)
    return hit === undefined || hit.value === ''
  })
  assert.deepEqual(
    missing.map((entry) => `${entry.section}.${entry.key}`),
    [],
    `en.yml 缺这些键（删 zh 时必须同删/同改 en；否则用户切英文会回落到中文）：` +
      `${nameOf(missing.slice(0, 12), 'src/data/lang/en.yml')}`,
  )

  const dirty = en.filter((entry) => CJK.test(entry.value))
  assert.deepEqual(
    dirty.map((entry) => `${entry.section}.${entry.key}`),
    [],
    `en.yml 里仍有中文（"翻了但没翻干净"）：${nameOf(dirty.slice(0, 12), 'src/data/lang/en.yml')}`,
  )
})

test('M120-04 扫描器自证：能判死 / 判动态段 / 判动态前缀 / 判静态引用（防空转）', () => {
  // 合成代码面：只含三种可达形态，不含任何真实键名。
  const code = [
    "t('alpha.staticKey')",
    't(`beta.${someIdentifier}`)',
    'label(\'gamma\', value)',
    't(`delta.col_${collection}`)',
  ].join('\n')
  const dynSections = dynamicSections(code)
  const dynPrefixes = dynamicPrefixes(code)

  assert.equal(reachableOf({ section: 'alpha', key: 'staticKey' }, code, dynSections, dynPrefixes), 'static', '静态字面量必须判活')
  assert.equal(reachableOf({ section: 'beta', key: 'anything' }, code, dynSections, dynPrefixes), 'dynamic-section', '模板段必须整段判活')
  assert.equal(reachableOf({ section: 'gamma', key: 'anything' }, code, dynSections, dynPrefixes), 'dynamic-section', 'label(段, …) 必须整段判活')
  assert.equal(reachableOf({ section: 'delta', key: 'col_id' }, code, dynSections, dynPrefixes), 'dynamic-prefix:col_', '前缀族必须判活')
  assert.equal(reachableOf({ section: 'delta', key: 'id' }, code, dynSections, dynPrefixes), undefined, '前缀族**之外**的键仍是死键（前缀不得变成整段豁免）')
  assert.equal(reachableOf({ section: 'alpha', key: 'ghostKey' }, code, dynSections, dynPrefixes), undefined, '零引用必须判死')
  assert.equal(reachableOf({ section: 'missingSection', key: 'anything' }, code, dynSections, dynPrefixes), undefined, '整段没人提过也是死键')

  // 扫描器必须真的看到两包（否则「0 条死键」是扫了个空集的假绿）。
  // 用 `assert.equal(条件, true, 消息)` 而不是 `assert.ok(条件, 消息)`：后者的**消息**会被
  // `extractProseSites` 当成"取值"算进读散文站点（它只把第 3 个及以后的实参当消息），
  // 于是本文件会以一条**假的**散文读点进 `m189` 的按身份登记表 —— 那是守卫自己的口径缝隙，不是真读散文。
  for (const pack of PACKS) {
    const count = readPack(pack).length
    assert.equal(count > 2000, true, `${pack} 解析出的键数过少（${count}）：解析器坏了，零引用读数不可信`)
  }

  // **排除面必须很窄**：本文件被排除在代码面之外（理由见 `codeFace`），但别的文件里的引用照旧算数。
  // 这里钉 REV-053 的**活键**：它被 `src/domain/plan.ts` 与 `test/m105.test.ts` 引用 ⇒ 必须判活；
  // 若哪天"排除自己"被写成了"排除整片"，这条立刻红。
  assert.equal(
    reachableOf({ section: 'uiPlan', key: 'kScopeReleaseHint' }, codeFace()),
    'static',
    '别的文件里的引用必须照旧算数（活键判活）—— 否则「排除本文件」被写宽了',
  )
})

test('M120-05 注释与用例标题都不算引用（两层抹除各自要有证据，否则死键会被一句话"救活"）', () => {
  const source = [
    "// t('epsilon.lineComment')",
    "/* t('zeta.blockComment') */",
    "const kept = t('eta.realReference') // 行尾注释：t('theta.trailing')",
    "const url = 'https://example.invalid/a//b'", // 字符串里的 `//` 不是注释起点
    'const quoted = "it\'s fine"',
    "const rx = /['\"]/u", // 正则里的引号不得被当成字符串起点，否则后面的注释会漏抹
    "/* 块注释跨行：t('iota.multiline')",
    "   t('kappa.multiline2') */",
    'const nested = `x ${t(`lambda.inner`)} y`',
    "t('mu.afterNested')",
    "test('用例标题里提到 nu.titleMention 不算引用', () => {})",
    "describe(`用例组标题里提到 xi.titleMention 也不算`, () => {})",
    "test.skip('跳过的用例标题也算散文：omicron.titleMention', () => {})",
  ].join('\n')
  const code = maskTestTitles(stripComments(source))

  for (const ghost of ['epsilon.lineComment', 'zeta.blockComment', 'theta.trailing', 'iota.multiline', 'kappa.multiline2']) {
    assert.equal(code.includes(ghost), false, `注释里的 ${ghost} 必须被抹掉（注释不是引用）`)
    assert.equal(reachableOf({ section: ghost.split('.')[0] as string, key: ghost.split('.')[1] as string }, code), undefined, `${ghost} 只在注释里，必须判死`)
  }
  for (const ghost of ['nu.titleMention', 'xi.titleMention', 'omicron.titleMention']) {
    assert.equal(code.includes(ghost), false, `用例标题里的 ${ghost} 必须被抹掉（标题是散文，不是引用）`)
    assert.equal(reachableOf({ section: ghost.split('.')[0] as string, key: ghost.split('.')[1] as string }, code), undefined, `${ghost} 只在用例标题里，必须判死`)
  }
  for (const alive of ['eta.realReference', 'lambda.inner', 'mu.afterNested']) {
    assert.equal(code.includes(alive), true, `真引用 ${alive} 不得被连带抹掉（抹过头会把活键判成死键 —— 那是假红）`)
  }
  // 抹过头也不行：`test(...)` 的**第二个**参数（函数体）里是真代码，必须原样留着。
  const bodySurvives = maskTestTitles("test('标题', () => { t('pi.bodyReference') })")
  assert.equal(bodySurvives.includes('pi.bodyReference'), true, '抹标题时不得吃掉用例函数体（那是真代码面）')
  // 跨行块注释与标题抹除后**行数不变**（否则报错里的行号会整体偏移，点名就指错地方）。
  assert.equal(stripComments(source).split('\n').length, source.split('\n').length, '抹注释必须保留换行（行号要对得上）')
  assert.equal(maskTestTitles(source).length, source.length, '抹标题必须等长替换（偏移与行号都不许变）')
})
