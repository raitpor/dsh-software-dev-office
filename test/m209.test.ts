/**
 * **增量 209：`DEF-151` —— 渲染页眉丢项目信息。**
 *
 * 病根（`DEF-142` 的连带回归）：`docs/TESTPLAN.md` / `docs/TESTREPORT.md` 的正文改由
 * `testingRender` 渲染之后，两个渲染入口 —— `office.renderVerificationDocs`（计划/交付）与
 * `signReview` 里的签字投影 `renderTestReportSignable` —— **都没传** `projectName` / `process` /
 * `phase`。于是 `metaBlock` 落进缺省分支，页眉三格渲染成「（无）」：一份本来有值的交付文档，
 * 被谁后渲染谁生效的规则改坏了（盘上 `docs/TESTPLAN.md` 至今仍带值，那才是验收基准）。
 *
 * 修法口径（任务书 §2）：`SoftwareDevOffice.testingRenderMeta(call)` **一处实现、两处入口共用**
 * （`DEF-142` 的教训就是同一件事两份实现）；台账读不出来 ⇒ 交给渲染层写「（无）」
 * —— fail-open，不抛，也**不许**在这里编一个值顶上（那会把"台账没读出来"藏起来）。
 *
 * 项目格的**口径**（2026-10-21 驾驶舱裁定 ①）：`${id} ${name}`，与 `src/infra/render.ts:94` 的公共页眉
 * 同一条规则（`DESIGN` / `DECISIONS` / `QUALITY` 三份盘上值也都是这一形）。盘上 TESTPLAN/TESTREPORT
 * 那份"有 id、但名字被截断"的值是一次性渲染的异常产物，不作为基准。
 *
 * 本文件钉三件事 + 一条侧面：
 *   ① 页眉三格**逐字**来自项目台账（不是 `includes` 模糊命中；项目格 = 台账 `id` + `name` 两截）；
 *   ② 换项目名**或** id ⇒ 页眉跟着变（防"永远写死一个值"），且渲染文本里不出现「（无）」；
 *   ③ 台账缺失 ⇒ 不抛、页眉写「（无）」、正文照常渲染（fail-open 不是"什么都不写"）；
 *   ④ 第二个入口（签字投影）拿到的是**同一份**元信息（防"只修一处"）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** 夹具根：`writeTestingDoc` 写到 `store.root/../docs/`，所以**必须**在夹具里渲（绝不渲到仓库根）。 */
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm209')
const WORKSPACE = join(BASE, 'proj')
/** 台账缺失的工作区（第 ③ 段）：只有计划真源，没有 `project.json`，journal 为空。 */
const BARE = join(BASE, 'no-ledger')
/** 台账在、但项目名是空白的工作区（第 ③ 段第二面）：三格各自独立降级。 */
const BLANK = join(BASE, 'blank-name')

let office: SoftwareDevOffice

const call: OfficeCall = { sessionId: 's-m209', cwd: WORKSPACE } as unknown as OfficeCall

/** 计划真源**写满**（层级 / 环境 / 数据来源 / 回归范围 / 准出准则 / 计划评审都非空）。 */
const PLAN_YAML = [
  'plan:',
  '  levels:',
  '    - { id: LV-001, level: 单元测试, entry: 实现完成, exit: 单测全绿, traceability: req-tc }',
  '  environment: 本机 node 26',
  '  dataSource: 夹具',
  '  regressionScope: 回归到 REQ-047 与 REQ-151 这两条需求的用例',
  '  exitCriteria:',
  '    - { id: EC-001, criterion: 全量用例通过率, metric: pass/total, threshold: "100%", comparator: gte, scope: 全量套件 }',
  '  review: { status: approved, by: 用户, at: "2026-10-21T00:00:00.000Z" }',
  '',
].join('\n')

/** 写一份计划真源 + 一份**空** journal（让 `loadProject()` 读得到"没有台账"这个事实）。 */
function planSource(workspace: string): void {
  mkdirSync(join(workspace, '.sdo', 'testing'), { recursive: true })
  writeFileSync(join(workspace, '.sdo', 'testing', 'plan.yml'), PLAN_YAML, 'utf8')
  writeFileSync(join(workspace, '.sdo', 'journal.jsonl'), '', 'utf8')
}

/**
 * 写项目台账（`.sdo/project.json`）。
 *
 * 直接写投影而不是走 `office.init`：页眉要看的是**阶段展示名**（`开发`）与**流程 id**（`waterfall`），
 * 而 `init` 只能落到 `intake`；为了三格的值可控，这里给一份 `construction` 的台账。
 * 投影是 `loadProject()` 的**首选**来源（project.json 在就先用它），所以这正是渲染读到的台账。
 */
function projectLedger(workspace: string, name: string, phase = 'construction', id = 'PRJ-001'): void {
  mkdirSync(join(workspace, '.sdo'), { recursive: true })
  writeFileSync(join(workspace, '.sdo', 'project.json'), JSON.stringify({
    id,
    name,
    created: '2026-10-21T00:00:00.000Z',
    process: 'waterfall',
    phase,
    phaseHistory: [{ phase: 'construction', entered: '2026-10-21T00:00:00.000Z' }],
    scope: { in: [], out: [] },
    stakeholders: [],
    glossary: {},
  }, null, 2), 'utf8')
}

/** 在指定工作区渲一次计划文档，返回落盘文本。 */
function renderPlan(workspace: string): string {
  office.noteSession('s-m209', workspace)
  office.renderVerificationDocs({ sessionId: 's-m209', cwd: workspace })
  return readFileSync(join(workspace, 'docs', 'TESTPLAN.md'), 'utf8')
}

/** 页眉三格（`- 项目：…` / `- 流程：…` / `- 阶段：…`），按出现顺序整行取出。 */
function headerCells(text: string): string[] {
  return text.split('\n').filter((line) => /^- (项目|流程|阶段)：/u.test(line))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-m209', WORKSPACE)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M209-01 正例：页眉三格逐字来自项目台账（项目名 / 流程 id / 阶段展示名）', () => {
  projectLedger(WORKSPACE, 'M209 夹具项目')
  planSource(WORKSPACE)
  const text = renderPlan(WORKSPACE)

  // **逐字**核对（不是 `includes` 模糊命中）：三格的值都必须与台账/流程数据一一对上
  assert.deepEqual(
    headerCells(text),
    ['- 项目：PRJ-001 M209 夹具项目', '- 流程：waterfall', '- 阶段：开发'],
    `页眉三格必须逐字来自台账（实际：${JSON.stringify(headerCells(text))}）`,
  )
  // 同一份入参也决定渲染头的 `phase`（此前这里会渲成 `phase ` 空值，与正文三格一起劣化）
  const meta = text.split('\n').find((line) => line.startsWith('<!-- meta:'))
  assert.equal(meta, '<!-- meta: lang zh-CN ; phase 开发 -->', `渲染头的阶段必须与页眉同源（实际：${String(meta)}）`)
  // 正例里绝不该出现缺省文案（写满的真源没有"读不到"的位置）
  assert.equal(/（无）/u.test(text), false, '台账与真源都有值 ⇒ 渲染文本里不该出现「（无）」')

  // **幂等**（`REQ-035`）：同一台账 + 同一真源再渲一次，**除序号外**逐字节相同。
  // 序号不算抖动：渲染本身会登记一条 `doc/rendered`，而 `@ journal seq` / `渲染序号` 记的是
  // "这份稿是按哪个序号渲的" —— 那正是这条不变量要保留的信息（拿掉登记就会失去溯源）。
  // 除这两行外任何差异都说明渲染掺进了时钟/随机性，这里会当场红。
  const again = renderPlan(WORKSPACE)
  assert.deepEqual(headerCells(again), headerCells(text), '再渲一次，页眉三格必须逐字不动')
  const stripSeq = (value: string): string =>
    value.replace(/@ journal seq \d+/u, '@ journal seq N').replace(/- 渲染序号：\d+/u, '- 渲染序号：N')
  assert.equal(stripSeq(again), stripSeq(text), '除序号外必须逐字节相同（渲染是纯函数：同真源同入参 ⇒ 同文本）')
})

test('M209-02 否证：换一个项目名 ⇒ 页眉跟着变（防"永远写死一个值"）', () => {
  projectLedger(WORKSPACE, 'M209 夹具项目')
  planSource(WORKSPACE)
  assert.deepEqual(headerCells(renderPlan(WORKSPACE))[0], '- 项目：PRJ-001 M209 夹具项目')

  // 台账改名 + 换 id 后再渲：页眉第一格必须**两截都**跟着变（写死名字或写死 `PRJ-001` 都会在这里红）
  projectLedger(WORKSPACE, 'M209 改名后', 'construction', 'PRJ-777')
  const text = renderPlan(WORKSPACE)
  assert.deepEqual(
    headerCells(text),
    ['- 项目：PRJ-777 M209 改名后', '- 流程：waterfall', '- 阶段：开发'],
    `改名后台账必须逐字反映到页眉（实际：${JSON.stringify(headerCells(text))}）`,
  )
  assert.equal(/（无）/u.test(text), false, '有值时必须写值，「（无）」只留给真读不到的情形')
})

test('M209-03 fail-open：台账缺失 ⇒ 不抛、页眉写「（无）」、正文照常渲染', () => {
  planSource(BARE)
  office.noteSession('s-m209', BARE)

  // ① 不抛：没有台账时渲染必须照常完成（抛异常会让整份计划文档写不出来）
  assert.doesNotThrow(() => {
    office.renderVerificationDocs({ sessionId: 's-m209', cwd: BARE })
  }, '台账缺失不是渲染的失败条件（fail-open）')

  const text = readFileSync(join(BARE, 'docs', 'TESTPLAN.md'), 'utf8')
  // ② 页眉三格写成缺省文案（「（无）」是"真没读到"的唯一正确表现）
  assert.deepEqual(
    headerCells(text),
    ['- 项目：（无）', '- 流程：（无）', '- 阶段：（无）'],
    `没有台账 ⇒ 三格都写「（无）」（实际：${JSON.stringify(headerCells(text))}）`,
  )
  // ③ 正文照常渲染：fail-open 不等于"什么都不写"
  assert.match(text, /^# 测试计划/mu, '标题必须照常渲染')
  assert.match(text, /EC-001/u, '计划真源里的准出准则必须照常进正文')
  assert.match(text, /source: \.sdo\/testing\/plan\.yml/u, '渲染头仍自报真源路径')

  // ④ 台账在、但那一格是空白 ⇒ 只降级那一格（**不传空串**：`??` 拦不住 `''`，
  //    传空串会渲成"没有任何字的格子"，把"台账缺名字"藏成空白）
  projectLedger(BLANK, '   ')
  planSource(BLANK)
  const blank = renderPlan(BLANK)
  assert.deepEqual(
    headerCells(blank),
    ['- 项目：（无）', '- 流程：waterfall', '- 阶段：开发'],
    `空白的项目名只该让那一格降级，其余两格照旧（实际：${JSON.stringify(headerCells(blank))}）`,
  )
})

test('M209-04 第二入口（签字投影）拿到同一份元信息（防"只修一处"）', () => {
  // 报告投影只在验证/交付阶段追加（`signReview` 的口径），所以这份台账落在 `verification`
  projectLedger(WORKSPACE, 'M209 夹具项目', 'verification')
  planSource(WORKSPACE)
  mkdirSync(join(WORKSPACE, '.sdo', 'testing'), { recursive: true })
  writeFileSync(join(WORKSPACE, '.sdo', 'testing', 'report.yml'), [
    'report:',
    '  criteria:',
    '    - { id: EC-001, criterion: 全量用例通过率, measured: "1483/1483", verdict: pass }',
    '',
  ].join('\n'), 'utf8')

  const review = office.signReview(call, 'G6')
  // 受审载荷里的报告正文就是 `renderTestReportSignable` 的产物：它的页眉必须带上台账三格。
  // 只修 `renderVerificationDocs` 的实现会在这里红（投影仍是「（无）」）
  assert.ok(
    review.full.includes('- 项目：PRJ-001 M209 夹具项目'),
    '签字投影的报告页眉必须带项目名（否则 C-59 签的是一份页眉被削的稿）',
  )
  assert.ok(review.full.includes('- 流程：waterfall'), '签字投影的报告页眉必须带流程 id')
  assert.ok(review.full.includes('- 阶段：验证'), '签字投影的报告页眉必须带阶段展示名')
  assert.equal(review.full.includes('- 项目：（无）'), false, '台账有值 ⇒ 投影里不许再出现缺省文案')
})
