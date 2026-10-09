/**
 * **增量 82：D 轮（细脊线会话）实测的四条 + 一条系统性守卫**
 *
 *   · **D-16（minor）**：`uiIndex.planReviewed` 的语料占位符是 `{x}`，而调用点传的是 `p1`
 *     ⇒ 回执里**漏出字面量 `{x}`**（注释还自称已修 —— 比没修更坏：读码的人会以为这里没问题）。
 *   · **D-17（major）**：ADR `consequences` **写读形状不对称** —— 写入端原样收 `{item,mitigation}` 映射，
 *     读取端却用 `textListOf`（只认字符串列表）⇒ 磁盘上 3 条、读回来**恒为 0 条**，
 *     而 `adrCompleteness`（waterfall/prototype 的 G3 判据 `design.adr`）读的正是读路径。
 *   · **D-18（minor）**：`supersede` 之后旧记录仍计入 `adrCompleteness` ⇒ **写坏的 ADR 无路可走**
 *     （同 id 重记被守卫正确拒绝）⇒ 那类项目的 G3 永久判红。
 *   · **D-20（major）**：C-80 把 `dropped` 卡算成"迭代内未完成" ⇒ 迭代内**做过任何作废**就永久卡死 GI，
 *     而卡带死 `iteration` 号、`drop` 不清除、也没有"移出迭代"的动作 ⇒ 工具面无出路。
 *   · **D-19（minor）**：`grill` 的兜底建议无免责（会与项目约束相反），且没告诉用户"可以答不适用+理由"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { adrCompleteness, readAdr, recordAdr, supersedeAdr } from '../src/domain/adr.js'
import { loadPackagedYaml } from '../src/infra/data.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm82')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

const store = (): SdoStore => new SdoStore(join(BASE, '.sdo'))
const journal = (): Journal => new Journal(new SdoStore(join(BASE, '.sdo')))

test('M82-01 D-16：语料占位符必须与调用点的参数键同源（否则回执漏出字面量 {x}）', () => {
  const zh = loadPackagedYaml('src/data/lang/zh-CN.yml') as Record<string, Record<string, string>>
  assert.match(String(zh['uiIndex']?.['planReviewed']), /\{p1\}/u, '语料要用 {p1}（全仓主流写法）')
  assert.doesNotMatch(String(zh['uiIndex']?.['planReviewed']), /\{x\}/u, '不许留 {x}')
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /fmt\('uiIndex\.planReviewed', \{ p1: args\.approvedBy \?\? 'human' \}\)/u)
})

test('M82-02 系统性守卫：**每一个** fmt(key,{…}) 的参数键都要覆盖语料里的占位符（D-16 的整类病）', () => {
  // 报告只核了 `{x}` 这一个方向，并明说"反方向未系统扫描" ⇒ 这里把它机械化：
  // 扫 src/**.ts 里的 `fmt('<key>', { … })`，与语言包里该键的 `{…}` 占位符比对。
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) files.push(full)
    }
  }
  walk(join(ROOT, 'src'))
  const packs = ['zh-CN.yml', 'en.yml'].map((file) => loadPackagedYaml(`src/data/lang/${file}`) as Record<string, Record<string, string>>)
  const lookup = (key: string): string | undefined => {
    const [section, name] = key.split('.')
    if (section === undefined || name === undefined) return undefined
    for (const pack of packs) {
      const value = pack[section]?.[name]
      if (typeof value === 'string') return value
    }
    return undefined
  }
  const problems: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // `fmt('key', { ... })` / `fmt('key', { … } as …)`：只认字面量键，动态键（含 ${}）跳过
    const pattern = /fmt\(\s*'([A-Za-z][\w.]*)'\s*,\s*(\{[^)]*?\})\s*[),]/gu
    for (const match of source.matchAll(pattern)) {
      const key = match[1] ?? ''
      const objectText = match[2] ?? ''
      const text = lookup(key)
      if (text === undefined) continue
      const placeholders = [...text.matchAll(/\{(\w+)\}/gu)].map((item) => item[1] ?? '')
      const provided = new Set([...objectText.matchAll(/(?:^|[,{\s])(\w+)\s*:/gu)].map((item) => item[1] ?? ''))
      if (provided.has('...')) continue
      const missing = placeholders.filter((name) => !provided.has(name))
      if (missing.length > 0) problems.push(`${key}：模板要 ${missing.join(' ')}，调用点只给 ${[...provided].join(' ')}`)
    }
  }
  assert.deepEqual(problems, [], `语料与调用点的占位符不同源：\n${problems.join('\n')}`)
})

test('M82-03 D-17：ADR 后果用映射写进去，必须读得出来（写读同形状）且判据跟着对', () => {
  const consequences = [
    { item: '成本上升', mitigation: '先用最小实现验证' },
    { item: '学习曲线', mitigation: '写一页速查' },
    { item: '依赖风险' },
  ]
  const adr = recordAdr(store(), journal(), {
    title: '选型', context: '背景', decision: '用 A',
    alternatives: [{ option: '用 B', pros: '快', cons: '贵' }],
    consequences,
  })
  // ① 回执/返回值量的是**落盘后**的条数（旧实现量的是入参）
  assert.equal(adr.consequences.length, 3)
  // ② 读回来必须还是 3 条（旧实现：textListOf 遇映射项 ⇒ 0 条）
  const read = readAdr(store(), adr.id)
  assert.equal(read?.consequences.length, 3, '写进去就要读得出来')
  assert.equal(read?.consequences[0]?.mitigation, '先用最小实现验证', '可选字段 mitigation 不许丢（丢了域层守卫不可达）')
  // ③ 判据（waterfall/prototype 的 G3 → C-22 design.adr）不许再因此判红
  const completeness = adrCompleteness(store())
  assert.equal(completeness.ok, true, `不得因形状判红：${JSON.stringify(completeness)}`)
  assert.deepEqual(completeness.incomplete, [])
  // ④ 留痕里两个条数都要有（旧实现只记 alternatives ⇒ "后果几条"无处核对）
  const recorded = journal().read().events.filter((event) => event.type === 'adr/recorded').at(-1)
  assert.equal(recorded?.data['consequences'], 3)
  // ⑤ **落盘形状只有一种**（写端归一的真正价值）：调用方给字符串，磁盘上也是映射项
  recordAdr(store(), journal(), {
    title: '字符串写法', context: 'c', decision: 'd',
    alternatives: [{ option: 'x', pros: '', cons: '' }],
    consequences: ['纯字符串的一条'],
  })
  const raw = store().readYaml<{ adr: { consequences: unknown[] } }>('decisions', 'ADR-002.yml')?.adr
  const first = raw?.consequences?.[0]
  assert.equal(typeof first, 'object', `落盘必须是映射项（写读同形状）：${JSON.stringify(first)}`)
  assert.deepEqual(first, { item: '纯字符串的一条' })

  // ⑥ 手写的**字符串列表**同样不许报形状提示（F-21 的既有口径）
  store().writeYaml(['decisions', 'ADR-009.yml'], {
    adr: {
      id: 'ADR-009', title: '手写', status: 'accepted', context: 'c', decision: 'd',
      alternatives: [{ option: 'x', pros: '', cons: '' }], consequences: ['手写的一条'], at: 'x',
    },
  })
  assert.equal(readAdr(store(), 'ADR-009')?.consequences.length, 1, '手写字符串列表也要读得出来')
})

test('M82-04 D-18：`supersede` 之后旧记录退出判据（写坏的 ADR 才有自救路）', () => {
  const broken = recordAdr(store(), journal(), {
    title: '写坏了', context: 'c', decision: 'd',
    alternatives: [{ option: 'x', pros: '', cons: '' }],
    // 旧实现的坑：形状写坏 ⇒ 读回 0 条 ⇒ 判红且无路可走
    consequences: [],
  })
  assert.equal(adrCompleteness(store()).ok, false, '前置：它确实是坏的')
  supersedeAdr(store(), journal(), {
    title: '改正后', context: 'c', decision: 'd2',
    alternatives: [{ option: 'y', pros: '', cons: '' }],
    consequences: ['修正后的后果'],
    supersedes: broken.id,
  })
  const after = adrCompleteness(store())
  assert.equal(after.ok, true, `取代之后必须能过：${JSON.stringify(after)}`)
  assert.equal(after.superseded, 1, '作废条数要如实报出来')
  assert.deepEqual(after.incomplete, [], '作废的旧记录不许再计入 incomplete')
  // 拒绝同 id 时给出的出路必须真的有效（回执文案里点名 supersede）
  const zh = loadPackagedYaml('src/data/lang/zh-CN.yml') as Record<string, Record<string, string>>
  assert.match(String(zh['uiIndex']?.['kAdrIdTaken']), /supersede/u, '同 id 拒绝要指路 supersede')
})

test('M82-05 D-20：C-80 不许把 `dropped` 卡算成"迭代内未完成"（与 readyTasks / C-40 同口径）', () => {
  const gates = readFileSync(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8')
  const block = gates.slice(gates.indexOf("'iteration.increment'"), gates.indexOf("'iteration.dod'"))
  assert.match(block, /task\.status !== 'dropped'/u, 'C-80 必须排除 dropped（旧实现漏了它）')
  // 与 readyTasks 的同口径对照（同一类语义不许两处不同）
  const plan = readFileSync(join(ROOT, 'src', 'domain', 'plan.ts'), 'utf8')
  assert.match(plan, /task\.status !== 'done' && task\.status !== 'verified' && task\.status !== 'dropped'/u)
  // 作废多少张要看得见（C-40 的写法）
  assert.match(block, /k124b/u)
  const zh = loadPackagedYaml('src/data/lang/zh-CN.yml') as Record<string, Record<string, string>>
  assert.match(String(zh['uiGates']?.['k124b']), /已显式放弃/u)
})

test('M82-06 D-19：`grill` 的兜底建议必须带免责，且告诉用户"可以答不适用+理由"', () => {
  const receipt = readFileSync(join(ROOT, 'src', 'interface', 'designReceipt.ts'), 'utf8')
  assert.match(receipt, /uiDesign\.docQuestionSuggestDisclaimer/u, '建议后面要跟免责（与 design-questions 同口径）')
  assert.match(receipt, /uiDesign\.docQuestionNotApplicable/u, '"不适用+理由"要是显式的合法答法')
  const zh = loadPackagedYaml('src/data/lang/zh-CN.yml') as Record<string, Record<string, string>>
  assert.match(String(zh['uiDesign']?.['docQuestionSuggestDisclaimer']), /请勿据此决策/u)
  assert.match(String(zh['uiDesign']?.['docQuestionSuggestDisclaimer']), /零外部依赖/u, '要点名真机里那个与本项目约束相反的例子')
  assert.match(String(zh['uiDesign']?.['docQuestionNotApplicable']), /不适用/u)
})
