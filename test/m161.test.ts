/**
 * **增量 161：DEF-034（两份准则词表 + 两套标签 + 过时注释）**。
 *
 * 修前现盘读数（可复算）：
 *   · `src/types.ts` 与 `src/domain/testingStore.ts` **各有一份** `as const` 准则词表，内容**逐字相同**、
 *     来源却是**两处**；`coverage.ts` 的注释写"同一个准则词表（`types.ts` 的 …）"、import 的却是另一份
 *     ⇒ **注释与实现相反**（最容易被后人误信的部分）。
 *   · 同概念两个中文标签：读数侧 `decision → 判定`、设计侧 `decision → 分支`。
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

/** 只扫**代码行**：注释里正当地引用了旧名字（记录缺陷现场）⇒ 扫注释会造出假阳性。 */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
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
    ['语句', '分支', '路径', '条件', '定义-使用对'],
    '设计侧五个中文词是 DoD 逐字（本批不动需求基线；要统一措辞请驾驶舱裁决）',
  )
  // ③ 两处都把差异**写在盘上**（各有出处），不是"没人发现"
  assert.equal(readSource('src/domain/coverage.ts').includes('DEF-034'), true, '读数侧必须写明与设计侧措辞的关系')
  assert.equal(readSource('src/domain/testDesignWhitebox.ts').includes('DEF-034'), true, '设计侧必须写明与读数侧措辞的关系')
})
