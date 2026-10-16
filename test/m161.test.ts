/**
 * **增量 161：DEF-034（两份准则词表 + 两套标签 + 过时注释）**。
 *
 * 修前现盘读数（可复算）：
 *   · `src/types.ts` 与 `src/domain/testingStore.ts` **各有一份** `as const` 准则词表，内容**逐字相同**、
 *     来源却是**两处**；`coverage.ts` 的注释写"同一个准则词表（`types.ts` 的 …）"、import 的却是另一份
 *     ⇒ **注释与实现相反**（最容易被后人误信的部分）。
 *   · 同概念两个中文标签（第五批 §3.2 已统一）：读数侧 `decision → 判定`、设计侧当时 `decision → 分支`。
 *   · `coverage.ts` 那段"读数与形状层都还没有 `reportHash`/`artifactHash`"的注释**已过时**（实现早有了）。
 *
 * 修法：词表收敛到**唯一来源**（`types.ts` 的 `TESTING_COVERAGE_CRITERIA`，其余处 import 它，
 * 第二份 `as const` 与第二个类型名一并删除）；过时注释改成与实现相符；两套标签**各自留出处**并
 * 用**机械守卫**钉住关系（设计侧 5 类必须是读数侧的子集 + 那 5 个词就是 DoD 逐字）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { canonicalReadingCriterion, coverageCriterionLabel, legalCoverageCriteriaText } from '../src/domain/coverage.js'
import { WHITEBOX_COVERAGE_CRITERIA, WHITEBOX_CRITERION_LABEL } from '../src/domain/testDesignWhitebox.js'
import { validateTestingSource } from '../src/domain/testingShapes.js'
import * as testingStore from '../src/domain/testingStore.js'
import { TESTING_COVERAGE_CRITERIA } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function readSource(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/**
 * 只扫**代码行**：注释里正当地引用了旧名字（记录缺陷现场）⇒ 扫注释会造出假阳性。
 *
 * **DEF-085（第九批 §3.2）**：除了**整行**注释，还要剥**行尾注释** —— 否则
 * `'statement', 'decision', // 'coverage', '分支'` 这种行会把断言喂饱（收口会话 E3 复现）。
 * 剥法是**字符串感知**的：引号内的 `//`（URL、路径、正则字面量）**不许**被当成注释起点。
 */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
    .map((line) => {
      let quote = ''
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index]
        if (quote !== '') {
          if (char === '\\') index += 1
          else if (char === quote) quote = ''
          continue
        }
        if (char === '"' || char === "'" || char === '`') {
          quote = char
          continue
        }
        if (char === '/' && line[index + 1] === '/') return line.slice(0, index)
      }
      return line
    })
    .join('\n')
}

test('M161-01 结构：准则词表全仓**只有一份定义**，旧名字与旧类型名都已退场', () => {
  const types = readSource('src/types.ts')
  const store = readSource('src/domain/testingStore.ts')
  const coverage = readSource('src/domain/coverage.ts')

  // ① 唯一来源：`TESTING_COVERAGE_CRITERIA = [...] as const` 在 src/ 里恰好一处
  assert.equal(
    (types.match(/TESTING_COVERAGE_CRITERIA = \[/gu) ?? []).length,
    1,
    '唯一来源必须定义在 types.ts（且只有一次）',
  )
  // ② 旧的第二份定义必须绝迹（代码行里不许再出现 `COVERAGE_CRITERIA = [`）
  for (const [name, text] of [['testingStore.ts', store], ['coverage.ts', coverage]] as const) {
    assert.equal(
      /COVERAGE_CRITERIA = \[/u.test(codeOnly(text)),
      false,
      `${name} 里不许再有第二份 as const 词表`,
    )
  }
  // ③ 行为证据（比 grep 强）：旧名字与旧类型**不再导出** ⇒ 消费方无法再拿到"第二份"
  assert.equal('COVERAGE_CRITERIA' in testingStore, false, 'testingStore 不得再导出 COVERAGE_CRITERIA')
  assert.equal('CoverageCriterion' in testingStore, false, 'testingStore 不得再导出 CoverageCriterion（同族的旧类型名）')
  // ④ 消费方直接取唯一来源（注释与实现相符）
  assert.equal(codeOnly(coverage).includes("from '../types.js'"), true, 'coverage.ts 必须直接从唯一来源取词表')
})

test('M161-02 行为：判据仍按**那一份**词表判（合法集合 / 别名 / 非法值三态）', () => {
  // **词表本身逐条钉住**：从唯一来源里删/加一条，必须显式改这条守卫 —— 否则"少了一条"只有
  // 设计侧的子集断言能侧面发现（第一批 MUT-07f 的教训：数出现次数/只测一边，都不是判据）
  assert.deepEqual(
    [...TESTING_COVERAGE_CRITERIA],
    ['statement', 'decision', 'condition', 'decision-condition', 'mc-dc', 'path', 'def-use'],
    '读数侧准则词表逐条钉住（增删都要显式改这条守卫）',
  )
  const text = legalCoverageCriteriaText()
  for (const criterion of TESTING_COVERAGE_CRITERIA) {
    assert.equal(text.includes(criterion), true, `点名合法集合时必须含 ${criterion}`)
    assert.notEqual(coverageCriterionLabel(criterion).trim(), '', `${criterion} 必须有人话标签（不许印空串）`)
  }
  assert.equal(canonicalReadingCriterion('decision'), 'decision', '词表内取值原样收下')
  assert.equal(canonicalReadingCriterion('branch'), 'decision', '别名仍在唯一那处（内容层）被纠正')
  assert.equal(canonicalReadingCriterion('分支'), undefined, '中文标签不是取值（与本仓口径一致，照旧拒）')
  assert.equal(canonicalReadingCriterion('not-a-criterion'), undefined, '词表外的取值必须拒（点名合法集合）')
})

test('M161-03 过时注释已更正：形状层**现在真的**核 `reportHash` / `artifactHash` 的写法', () => {
  const coverage = readSource('src/domain/coverage.ts')
  assert.equal(coverage.includes('都还没有这两个字段'), false, '那句与实现相反的旧注释必须消失')
  // 行为读数（走真实形状校验入口）：非法写法必须在**这两个字段上**被点到名
  const report = validateTestingSource('coverage', {
    readings: [
      {
        id: 'CR-001',
        criterion: 'decision',
        measured: '80',
        threshold: '90',
        command: 'run',
        report: 'r.md',
        reportHash: 'not-a-hash',
        artifact: 'out.bin',
        artifactHash: 'also-not-a-hash',
      },
    ],
    uncovered: [],
  })
  const fields = report.issues.map((issue) => issue.field)
  assert.equal(report.issues.some((issue) => issue.field.endsWith('reportHash')), true, `形状层必须核 reportHash 的写法：${JSON.stringify(fields)}`)
  assert.equal(report.issues.some((issue) => issue.field.endsWith('artifactHash')), true, `形状层必须核 artifactHash 的写法：${JSON.stringify(fields)}`)
})

test('M161-04 两套标签"差异有据"：设计侧 5 类必须是读数侧子集，且那 5 个词就是 DoD 逐字', () => {
  // ① 关系守卫（机械）：只往一边加准则 ⇒ 红。这条挡住的是"两层各改各的"再次漂移。
  const readingSide = new Set<string>(TESTING_COVERAGE_CRITERIA)
  for (const criterion of WHITEBOX_COVERAGE_CRITERIA) {
    assert.equal(readingSide.has(criterion), true, `设计侧口径 ${criterion} 必须在读数侧词表里（子集关系）`)
  }
  // ② 设计侧措辞是 **DoD 逐字**（需求基线口径）⇒ 谁改这 5 个词，必须同时改 DoD 与出处，不能偷偷改
  assert.deepEqual(
    WHITEBOX_COVERAGE_CRITERIA.map((criterion) => WHITEBOX_CRITERION_LABEL[criterion]),
    ['语句', '判定', '路径', '条件', '定义-使用对'],
    '设计侧五个中文词是 DoD 逐字（第五批 §3.2：卡面勘误后统一为「判定」）',
  )
  // ③ 两处都把差异**写在盘上**（各有出处），不是"没人发现"
  assert.equal(readSource('src/domain/coverage.ts').includes('DEF-034'), true, '读数侧必须写明与设计侧措辞的关系')
  assert.equal(readSource('src/domain/testDesignWhitebox.ts').includes('DEF-034'), true, '设计侧必须写明与读数侧措辞的关系')
})

test('M161-05 DEF-034 收口（第五批 §3.2）：词表唯一，**两层中文标签零差异**（变化本身就是机械读数）', () => {
  // **`ADR-014` 裁决"语义应统一"分两步走**：第四批统一**词表/token**并把"差异恰好一处"钉成读数；
  // 第五批（卡面勘误 `TASK-015` 之后）把**设计侧中文标签**也改成「判定」⇒ 差异归零。
  // 这条用例的机械性不依赖某个字面：它比较的是**两张表逐条**（谁再分叉谁红）。
  const readingLabel = new Map(TESTING_COVERAGE_CRITERIA.map((criterion) => [criterion, coverageCriterionLabel(criterion)]))
  const rows = WHITEBOX_COVERAGE_CRITERIA.map((criterion) => ({
    criterion,
    design: WHITEBOX_CRITERION_LABEL[criterion],
    reading: readingLabel.get(criterion),
  }))
  // ① **零差异**（不是"恰好一处"）：两层对同一个 token 必须印同一个词
  assert.deepEqual(
    rows.filter((row) => row.design !== row.reading),
    [],
    `两层中文标签必须逐条同词（谁分叉谁红）：${JSON.stringify(rows.filter((row) => row.design !== row.reading))}`,
  )
  // ② 每个 token 两层都**有**标签（"都空"不许冒充"都同" —— 那会让这条守卫变成永远绿）
  for (const row of rows) {
    assert.equal(typeof row.design === 'string' && row.design !== '', true, `${row.criterion} 在设计侧必须有中文标签`)
    assert.equal(row.reading !== undefined && row.reading !== '', true, `${row.criterion} 在读数侧必须有中文标签`)
    assert.notEqual(row.design, row.criterion, `${row.criterion} 的标签不许回落成裸 token（那等于没标签）`)
  }
  // ③ 取值口径仍是**一份词表**（别名归一只有一处），且设计侧 5 类是读数侧 7 类的子集
  assert.equal(canonicalReadingCriterion('branch'), 'decision', '别名归一只有一处（`branch` ⇒ `decision`）')
  const readingSide = new Set<string>(TESTING_COVERAGE_CRITERIA)
  for (const criterion of WHITEBOX_COVERAGE_CRITERIA) {
    assert.equal(readingSide.has(criterion), true, `设计侧口径 ${criterion} 必须在读数侧词表里（子集关系）`)
  }
  // ⑤ **§3.4（R15）口径收窄**：本判据断言的是**输出标签**（两层对同一 token 印同一个词），
  // **不是**"全仓禁止出现「分支」这个词" —— 把「分支」当**非法输入**喂进去的四处用例必须**留着**
  // （`m34` 两处、`m35` 两处；删了它们反而会让"中文标签不是取值"这条口径失去守卫）。
  // **DEF-085（第七批 §3.3）**：上一版这里是"整文件出现次数 ≥ 2"的**计数下界** —— 而 `m34` 里「分支」
  // 共 8 处、`m35` 共 18 处（其中大半是"控制流分支"这种正常用词）⇒ 把**任务书点名的那四处非法输入**
  // 换成别的 token，这条断言**照样绿**（下界钉不住站点）。现在改成**逐个钉住具体表达式**
  //（不钉整段措辞、更不钉行号）：任一处被换掉/删掉 ⇒ **点名是哪一处**。
  // **DEF-085（第八批 §3.2）**：断言必须只喂**代码行** —— `readSource` 返回整份文件（含注释），
  // 于是"注释里恰好写着同一串"就能把断言喂饱。这里统一过 `codeOnly()`（本文件既有的剥注释 helper）。
  // ⚠️ 如实记：V16 报的"删掉 `m35:1146` 的代码、守卫仍绿"**在现盘不复现**（我实测那条删掉即红并点名；
  // 注释里那行是 `` `coverage` / `分支` `` 的反引号+斜杠形态，本来就匹配不上带引号逗号的代码形态）。
  // 本改动是**加固**（让"注释喂饱"这条路在结构上不可能），不是复现出来的修复。
  const m34 = codeOnly(readSource('test/m34.test.ts'))
  const m35 = codeOnly(readSource('test/m35.test.ts'))
  const sites: { what: string; where: string; source: string; pattern: RegExp }[] = [
    { what: 'm34 单值非法输入（`criterion: \'分支\'`）', where: 'm34:484', source: m34, pattern: /\{ criterion: '分支' \}/u },
    { what: 'm34 多值非法输入清单里的「分支」', where: 'm34:824', source: m34, pattern: /values = \[[^\]]*'分支'/u },
    { what: 'm35 非法取值清单里的「分支」', where: 'm35:1146', source: m35, pattern: /'coverage', '分支'/u },
    { what: 'm35 形状层拒「分支」', where: 'm35:1178', source: m35, pattern: /shapeOf\('分支'\)\.accepted, false/u },
    { what: 'm35 判定层拒「分支」', where: 'm35:1179', source: m35, pattern: /judgedOf\('分支'\)\.accepted, false/u },
  ]
  for (const site of sites) {
    assert.equal(
      site.pattern.test(site.source),
      true,
      `必须留着这处把「分支」当**非法输入**的用例（${site.what}，现盘约在 ${site.where}）—— 它是"中文标签不是取值"这条口径的守卫`,
    )
  }

  // ④ 两处都记录裁决/勘误的出处（读者要能顺着注释查到"为什么统一"）
  const wb = readSource('src/domain/testDesignWhitebox.ts')
  assert.match(wb, /ADR-014/u, '设计侧必须记录裁决出处（ADR-014）')
  assert.match(wb, /TASK-015/u, '设计侧必须记录卡面勘误的出处（TASK-015）')
  const reading = readSource('src/domain/coverage.ts')
  assert.match(reading, /ADR-014/u, '读数侧也必须记录裁决出处（ADR-014）')
  assert.match(reading, /TASK-015/u, '读数侧也必须记录卡面勘误的出处（TASK-015）')
})

test('M161-06 §3.2（DEF-085）：codeOnly 必须剥**行尾注释**，但不许误伤字符串里的 `//`', () => {
  const sample = [
    "const a = 1 // 注释里写着 'coverage', '分支'",
    "const url = 'https://example.com/x' // 尾巴",
    "const b = 'a // b'",
    '// 整行注释：\'coverage\', \'分支\'',
    " * 块注释里的 'coverage', '分支'",
  ].join('\n')
  const code = codeOnly(sample)
  assert.equal(code.includes("'coverage', '分支'"), false, '行尾注释 / 整行注释 / 块注释都必须剥掉')
  assert.equal(code.includes('https://example.com/x'), true, '字符串里的 `//` 不许误剥（URL）')
  assert.equal(code.includes("'a // b'"), true, '字符串里的 `//` 不许误剥（引号内）')
  assert.equal(code.includes('const a = 1'), true, '代码本体必须留下')
  // **豁免面（第九批 §8.1）逐条钉住**：这两条是**有意不抓**的形态（改它 ⇒ 这两格红，见 §8.1 的变异读数）
  // ⚠️ **两条机制分开钉**（`DEF-098` 第十批 §3.3 的改正：此前只有行首那一格，两条机制都能让它 false、
  //    分辨不出是哪条在剥）：行首的 `//` 归**整行注释过滤**，行**内**的 `//` 归**行尾注释剥离**。
  const lineStart = 'const t = `a\n// 多行模板里的这一行\n`\n'
  assert.equal(
    codeOnly(lineStart).includes('// 多行模板里的这一行'),
    false,
    '跨行模板里**行首**的 `//` 被整行注释过滤剥掉（**有意不做任何跨行词法**，见豁免面清单）',
  )
  const inline = 'const t = `a\nx // 多行模板里的行内注释\n`\n'
  assert.equal(
    codeOnly(inline).includes('x // 多行模板里的行内注释'),
    false,
    '跨行模板里**行内**的 `//` 被行尾注释剥离剥掉（同上：有意不做跨行词法）',
  )
  assert.equal(
    codeOnly('const a = 1 # 中文 # 形态').includes('# 中文 # 形态'),
    true,
    '非 JS 注释形态（`#`、`<!-- -->`）**有意不剥**（本仓测试全是 TS，见豁免面清单）',
  )
})
