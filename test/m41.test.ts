/**
 * 评审员 2026-10-05 复审（`.review/2026-10-05-真机缺陷批量修复SDO16-30的评审（评审员）.md` §2）的回归：
 *
 * **新问题（minor）**：`truth/file-written` 把「任何 `.sdo/` 真源写入」都算成「会改 `DESIGN.md` 的真源」，
 * 于是手改一个**构造期**文件（`.sdo/construction/tdd.yml`）也会让 C-25 判 `DESIGN.md` 陈旧 ——
 * 正是 `DESIGN_DOC_SOURCE_EVENTS` 注释里自己警告过的「报警疲劳」（那里特意不列 `phase/*` 就是这个理由）。
 *
 * 修法（采纳评审员的建议①）：**C-25 侧按路径前缀收敛**到设计文档真正渲染的真源；
 * **G3 签字失效那一面保持不变**（任何真源直写都失效 —— 宁可重签，也别静默放过）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { isDesignDocSourceEvent } from '../src/domain/gates.js'
import { isDesignDocTruthPath, isSignatureInvalidatingEvent } from '../src/types.js'
import { TRACE_KINDS, link, renderTraceReport, report as traceReport } from '../src/domain/trace.js'
import { listRequirements } from '../src/domain/requirements.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm41')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('SDO-19 复审：`DESIGN.md` 的真源路径口径 —— 设计类算、构造/测试/成本类不算', () => {
  for (const path of [
    '.sdo/design/component.yml',
    '.sdo/contracts/CT-001.yml',
    '.sdo/decisions/ADR-001.yml',
    '.sdo/quality/q.yml',
    '.sdo/requirements/REQ-001.yml',
    '.sdo/questions/Q-001.yml',
    '.sdo/risks/RISK-001.yml',
    '.sdo/project.json',
  ]) {
    assert.equal(isDesignDocTruthPath(path), true, `${path} 会改 DESIGN.md ⇒ 算文档真源`)
  }
  for (const path of [
    '.sdo/construction/tdd.yml',
    '.sdo/tests/TC-001.yml',
    '.sdo/costs/cost.yml',
    '.sdo/tasks/TASK-001.yml',
    '.sdo/gates/G3.json',
    '.sdo/evidence/child-tools.jsonl',
    '.sdo/changes/CR-001.yml',
  ]) {
    assert.equal(isDesignDocTruthPath(path), false, `${path} 不进 DESIGN.md ⇒ 不算（否则报警疲劳）`)
  }
})

test('SDO-19 复审：C-25 的谓词按路径分流；拿不到 `docSource`/`path` 时仍保守算作会改文档', () => {
  // ① 设计类直写 ⇒ 文档判陈旧
  assert.equal(isDesignDocSourceEvent({ type: 'truth/file-written', data: { path: '.sdo/design/component.yml', docSource: true } }), true)
  // ② 构造期直写 ⇒ **不**判陈旧（本次修的就是这一条）
  assert.equal(isDesignDocSourceEvent({ type: 'truth/file-written', data: { path: '.sdo/construction/tdd.yml', docSource: false } }), false)
  // ③ 旧事件（没有 docSource）：回退到路径判定
  assert.equal(isDesignDocSourceEvent({ type: 'truth/file-written', data: { path: '.sdo/design/x.yml' } }), true, '旧事件按路径回退')
  assert.equal(isDesignDocSourceEvent({ type: 'truth/file-written', data: { path: '.sdo/construction/tdd.yml' } }), false)
  // ④ 路径也读不出 ⇒ 保守算作会改文档（黑名单方向不变）
  assert.equal(isDesignDocSourceEvent({ type: 'truth/file-written', data: {} }), true)
  // ⑤ 既有两条口径不受影响
  assert.equal(isDesignDocSourceEvent({ type: 'trace/linked', data: { kind: 'req-task' } }), false, '施工期覆盖边不进文档（SDO-18）')
  assert.equal(isDesignDocSourceEvent({ type: 'trace/linked', data: { kind: 'req-des' } }), true)
  assert.equal(isDesignDocSourceEvent({ type: 'design/updated' }), true)
  assert.equal(isDesignDocSourceEvent({ type: 'phase/entered', data: { phase: 'construction' } }), false, '阶段流转不判文档陈旧（既有口径）')
  assert.equal(isDesignDocSourceEvent({ type: 'task/claimed', data: { id: 'TASK-001' } }), false)
})

test('SDO-19 复审：写入侧一个事件带两种事实 —— 构造期写入仍**失效 G3 签字**（评审员的取向：宁可重签）', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }
  mkdirSync(join(BASE, '.sdo', 'construction'), { recursive: true })
  mkdirSync(join(BASE, '.sdo', 'design'), { recursive: true })
  store.writeText(['construction', 'tdd.yml'], 'tdd:\n  mutations: 3\n', { mode: 0o600 })
  store.writeText(['design', 'component.yml'], 'view:\n  kind: component\n', { mode: 0o600 })

  const recorded = office.noteTruthFileWrites(call, ['.sdo/construction/tdd.yml', '.sdo/design/component.yml'])
  assert.equal(recorded, 2, '两笔都要入账（构造期写入也要留痕 + 快照）')
  const events = journal.read().events.filter((event) => event.type === 'truth/file-written')
  const byPath = new Map(events.map((event) => [String(event.data.path), event.data]))
  assert.equal(byPath.get('.sdo/construction/tdd.yml')?.docSource, false, '构造期：不算文档真源（C-25 不再误判陈旧）')
  assert.equal(byPath.get('.sdo/design/component.yml')?.docSource, true, '设计期：算文档真源')

  // **两面分开**：文档新鲜度按路径收敛，但"真源被直写"这件事对签字一律作废
  for (const path of ['.sdo/construction/tdd.yml', '.sdo/design/component.yml']) {
    assert.equal(byPath.has(path), true, `${path} 要留痕`)
  }
  assert.equal(isSignatureInvalidatingEvent('G3', 'truth/file-written'), true, '任何真源直写都作废 G3 签字（口径不变）')
})

// —————————————————————— TASK-022：缺陷追溯边（req-defect）与悬空边拒绝 ——————————————————————
//
// DoD 三条：① `TRACE_KINDS` 增 `req-defect`；② 缺陷可挂需求并参与覆盖率与孤儿检测；
// ③ 守卫：指向不存在实体的边**整条被拒绝**（不是跳过那一端）。
//
// 边界：缺陷 id 前缀是 **`DEF-`**（`records.ts:145` 的 `idOf(..., 'defects', 'DEF-')`），
// 台账在 `.sdo/defects/` —— 别按 `DF-` 写（真源里 grep 不到任何 `DF-`）。

const T22 = join(ROOT, 'node_modules', '.sdo-test', 'm41-trace022')

/** 一棵最小可判的树：1 条 must 需求 + 1 个设计元素 + 1 个契约 + 1 张卡 + 1 条用例 + 2 条缺陷。 */
function traceFixture(): { store: SdoStore; journal: Journal } {
  rmSync(T22, { recursive: true, force: true })
  mkdirSync(join(T22, '.sdo', 'tasks'), { recursive: true })
  const fixtureStore = new SdoStore(join(T22, '.sdo'))
  const fixtureJournal = new Journal(fixtureStore)
  fixtureStore.writeYaml(['requirements', 'REQ-001.yml'], {
    requirement: {
      id: 'REQ-001', title: '需求', kind: 'functional', statement: 's', rationale: 'r',
      priority: 'must', status: 'baselined', version: 1,
      acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 'x' }],
    },
  })
  fixtureStore.writeYaml(['defects', 'DEF-001.yml'], {
    defect: { id: 'DEF-001', title: '逃逸缺陷', severity: 'major', status: 'open' },
  })
  // DEF-002 故意**不连**任何需求：它必须是孤儿（否则"孤儿检测"是空转的）
  fixtureStore.writeYaml(['defects', 'DEF-002.yml'], {
    defect: { id: 'DEF-002', title: '没人认领的缺陷', severity: 'minor', status: 'open' },
  })
  return { store: fixtureStore, journal: fixtureJournal }
}

test('TASK-022 ①：TRACE_KINDS 含 req-defect（且原有五类一个不少）', () => {
  assert.ok((TRACE_KINDS as readonly string[]).includes('req-defect'), 'req-defect 必须在允许的边语义里')
  for (const kind of ['req-des', 'req-task', 'req-tc', 'des-task', 'des-ct']) {
    assert.ok((TRACE_KINDS as readonly string[]).includes(kind), `${kind} 不许被挤掉`)
  }
})

test('TASK-022 ②：缺陷挂需求 ⇒ 逐需求可见；未挂需求的缺陷进孤儿点名', () => {
  const { store: fixtureStore, journal: fixtureJournal } = traceFixture()
  const created = link(fixtureStore, fixtureJournal, { from: 'REQ-001', to: 'DEF-001', kind: 'req-defect' })
  assert.equal(created.created, true, '合法边要能建起来')

  const data = traceReport(fixtureStore, listRequirements(fixtureStore))
  const defects = (data.perRequirement[0] as unknown as { defects: string[] }).defects
  assert.deepEqual(defects, ['DEF-001'], '这条需求出过哪些缺陷要能从图里现算')
  const orphans = (data.orphans as unknown as { defects: string[] }).defects
  assert.deepEqual(orphans, ['DEF-002'], '没有任何需求来源的缺陷必须被点名（DEF-001 已挂，不该出现）')

  // 反向：把 DEF-002 也挂上 ⇒ 孤儿清空（证明上面判的不是"永远红"）
  link(fixtureStore, fixtureJournal, { from: 'REQ-001', to: 'DEF-002', kind: 'req-defect' })
  const after = (traceReport(fixtureStore, listRequirements(fixtureStore)).orphans as unknown as { defects: string[] }).defects
  assert.deepEqual(after, [], '都挂上之后不该再有孤儿缺陷')

  // 幂等：同一条边不重复写（否则覆盖率会被重复计数）
  assert.equal(link(fixtureStore, fixtureJournal, { from: 'REQ-001', to: 'DEF-001', kind: 'req-defect' }).created, false)
  assert.equal(traceReport(fixtureStore, listRequirements(fixtureStore)).total, 2, '重复建边不得让边数变 3')
})

test('TASK-022 ③ 守卫：指向不存在实体的边**整条拒绝**，且盘上不留痕', () => {
  const { store: fixtureStore, journal: fixtureJournal } = traceFixture()
  const before = traceReport(fixtureStore, listRequirements(fixtureStore)).total

  const cases: readonly { from: string; to: string; kind: string; why: string }[] = [
    { from: 'REQ-001', to: 'DEF-999', kind: 'req-defect', why: '缺陷侧悬空（本卡新增的边类型）' },
    { from: 'REQ-001', to: 'DES-999', kind: 'req-des', why: '设计元素侧悬空（既有校验，防回归）' },
    { from: 'REQ-001', to: 'CT-999', kind: 'req-des', why: '契约侧悬空（F-5 修过的那一类，防回归）' },
    { from: 'REQ-001', to: 'ZZ-001', kind: 'req-defect', why: 'id 不属于任何已知类别' },
  ]
  for (const item of cases) {
    assert.throws(
      () => link(fixtureStore, fixtureJournal, { from: item.from, to: item.to, kind: item.kind }),
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error)
        // 点名**是哪一个 id**、**哪一类**，并给出可执行修法
        assert.match(text, new RegExp(item.to === 'ZZ-001' ? '不属于任何已知实体类别' : '不存在', 'u'), `${item.why}：报错要说清类型`)
        return true
      },
      `${item.why} 必须整条拒绝`,
    )
  }
  assert.equal(
    traceReport(fixtureStore, listRequirements(fixtureStore)).total,
    before,
    '被拒绝的边**一条都不许落盘**（这正是"整条拒绝"与"跳过坏端"的区别）',
  )

  // 反向：同一批 id 一旦真实存在 ⇒ 立刻能建（证明拒绝的不是"这类边永远建不起来"）
  fixtureStore.writeYaml(['defects', 'DEF-999.yml'], { defect: { id: 'DEF-999', title: '补登记', severity: 'minor', status: 'open' } })
  assert.equal(link(fixtureStore, fixtureJournal, { from: 'REQ-001', to: 'DEF-999', kind: 'req-defect' }).created, true)
})

test('TASK-022 ③b：非法边类型仍然被拒（新增 req-defect 不许放宽词表）', () => {
  const { store: fixtureStore, journal: fixtureJournal } = traceFixture()
  assert.throws(
    () => link(fixtureStore, fixtureJournal, { from: 'REQ-001', to: 'DEF-001', kind: 'req-bug' }),
    /非法追溯边类型/u,
    '词表外的类型要报错并列出可用集合',
  )
})

test('TASK-022 ③c 边界：`REQ-`/`TASK-`/`TC-` 三类**有意不校验**（否则会误伤实体登记早于建边的既有流程）', () => {
  // 为什么要有这条：本仓既有流程会在实体登记**之前**就引用这几类 —— `m73` 的 `decompose` 先建
  // `req-task` 边（`REQ-001` 当时还没进需求台账）、`m2` 的覆盖夹具直接连 `TC-001`（只为一个链接）。
  // 若把校验"顺手补严"，这两条既有用例会当场变红。它们的存在性由各自判据管
  // （`trace.orphans` / `uncoveredMust` / `tests.passed`），不在建边这一层拦。
  const { store: fixtureStore, journal: fixtureJournal } = traceFixture()
  // 空转整改（TASK-051 / REV-004…007 批次）：**只断言"不抛错"是不够的** ——
  // `assert.doesNotThrow` 对"边被静默跳过、一条也不落盘"同样成立，于是守卫可以在
  // "这一组边根本建不起来"的实现上照旧判绿。改成同时断言**边真的建起来了**（`created === true`），
  // 并把"建起来的边数"与盘上读数对上（正例），再补一条反例把"不校验"的边界划清楚。
  const before = traceReport(fixtureStore, listRequirements(fixtureStore)).total
  for (const item of [
    { from: 'REQ-001', to: 'TASK-999', kind: 'req-task' },
    { from: 'REQ-001', to: 'TC-999', kind: 'req-tc' },
  ]) {
    // 正例：合法 id ⇒ **建边成功**（不只是"没报错"）。`created` 是"这条边这次真的落盘了"的唯一回执。
    // 注意**只调一次**：`link` 幂等，第二次同一条边回的是 `created === false`，调两次就把断言测坏了。
    const created = link(fixtureStore, fixtureJournal, item)
    assert.equal(created.created, true, `${item.kind} 是合法 id ⇒ 必须真的建起来（不许"不抛错=通过"的空转）`)
  }
  assert.equal(
    traceReport(fixtureStore, listRequirements(fixtureStore)).total,
    before + 2,
    '两条合法边都要真的落盘（本条同时证明上面的 created 断的不是"永远 true"）',
  )

  // 反例：**"这三类不校验存在性" ≠ "id 不分类也别管"** —— 前缀不属于任何已知类别时，
  // `link` 仍然整条拒绝（`不属于任何已知实体类别`），且盘上一条不留。这一段就是"防空转"的另一半：
  // 守卫对"一次也不建"必须敏感。
  assert.throws(
    () => link(fixtureStore, fixtureJournal, { from: 'REQ-001', to: 'ZZ-001', kind: 'req-defect' }),
    /不属于任何已知实体类别/u,
    '前缀不分类的 id 仍要整条拒绝（`REQ-`/`TASK-`/`TC-` 的不校验只覆盖"存在性"，不覆盖"认不认得出来"）',
  )
  assert.equal(
    traceReport(fixtureStore, listRequirements(fixtureStore)).total,
    before + 2,
    '被拒绝的边一条都不许落盘（落盘数与上一步相同）',
  )
})

test('TASK-022 ②b 渲染：TRACE.md 必须把缺陷行写出来（数据里有、文档不列 = 对读者不存在）', () => {
  const { store: fixtureStore, journal: fixtureJournal } = traceFixture()
  // 夹具里 DEF-002 故意没挂需求 ⇒ 它必须是孤儿缺陷；DEF-001 只挂需求 ⇒ 逐条需求那一段要带它
  link(fixtureStore, fixtureJournal, { from: 'REQ-001', to: 'DEF-001', kind: 'req-defect' })
  const md = renderTraceReport({
    report: traceReport(fixtureStore, listRequirements(fixtureStore)),
    seq: 1,
    header: '<!-- h -->',
  })
  assert.match(md, /无需求来源的缺陷：DEF-002/u, '孤儿缺陷必须在文档里点名')
  assert.match(md, /缺陷 DEF-001/u, '逐条需求那一段要带缺陷列')
  // 反向：挂上 DEF-002 ⇒ 文档里那一行变"无"（证明上面判的不是"永远印 DEF-002"）
  link(fixtureStore, fixtureJournal, { from: 'REQ-001', to: 'DEF-002', kind: 'req-defect' })
  const after = renderTraceReport({
    report: traceReport(fixtureStore, listRequirements(fixtureStore)),
    seq: 1,
    header: '<!-- h -->',
  })
  assert.match(after, /无需求来源的缺陷：无/u, '都挂上之后那一行要为"无"')
  assert.match(after, /缺陷 DEF-001 DEF-002/u)
})
