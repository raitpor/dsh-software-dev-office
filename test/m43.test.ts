/**
 * 真机报告 2026-10-06 追加的**插件侧**三条（SDO-41 / SDO-50 / SDO-37）。
 *
 *   · **SDO-41（报告评为「最严重」）**：`sdo_deliver action=package` 把**非法/缺失**的 `verdict`
 *     一律落成 `pass` —— 流程官提交 13 行 `unverified`，得到 15/15 全 pass 且零提示
 *     （「框架主动生产假绿记录」）；且验收矩阵的行内容**不进真源**（journal 只存 `acceptance: 15` 计数），
 *     正文只存在于自述"派生视图、请勿手改"的渲染产物里。
 *   · **SDO-50（判据层自锁）**：`verificationStats` 把**所有历史结果平铺**统计 ⇒ 一条用例出现过一次 fail
 *     就永远红，而门禁给的补救是「修好并重跑」——机制上不可能奏效。
 *   · **SDO-37**：`hashArtifact` 对**目录**返回 `missing`，回执于是说「这些产物在盘上找不到」——
 *     把"目录不参与文件哈希"误读成"产物缺失"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import {
  deliveryCompleteness,
  recordRun,
  hashArtifact,
  packageDelivery,
  renderDelivery,
  verificationStats,
} from '../src/domain/records.js'
import type { AcceptanceRow } from '../src/domain/records.js'
import {
  TESTING_CLASSES,
  TESTING_DOC_META,
  TESTING_SOURCE_FILES,
  currentJournalSeq,
  docSourceFingerprint,
  docSourceLocation,
  lastDocRecord,
  readTestingClass,
  readTestingSource,
  renderStale,
  sourceFingerprintOf,
  writeTestingSource,
} from '../src/domain/testingStore.js'
import type { TestingDocKind } from '../src/domain/testingStore.js'
import { parseRenderSeq } from '../src/domain/design.js'
import {
  docSha256,
  renderTestDesign,
  renderTestPlan,
  renderTestReport,
  writeTestingDoc,
} from '../src/domain/testingRender.js'
import type { Requirement } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm43')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function acceptance(verdict: AcceptanceRow['verdict'], requirement = 'REQ-001'): AcceptanceRow {
  return { requirement, criterion: 'AC-001', evidence: 'e', verdict }
}

function requirement(): Requirement {
  return {
    id: 'REQ-001', title: 'R', kind: 'functional', statement: 's', rationale: 'r', status: 'approved',
    priority: 'must', source: 'user', acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
    revision: 1, createdAt: '', updatedAt: '',
  } as unknown as Requirement
}

test('SDO-41：`unverified` 是一等公民 —— 落账原样、门禁拦下、事件带行内容、渲染打 ⚠️', () => {
  // 交付现在**还要求真机运行证据**（用户要求 2026-10-06）：先记一条绑定产物的通过运行，
  // 好让"pass 行不被降级、也不打 ⚠️"这件事能被单独观察到。
  writeFileSync(join(BASE, 'art.txt'), 'bytes', 'utf8')
  const ran = recordRun(store, journal, {
    workspace: BASE, target: 'desktop', command: './run', outcome: 'pass', evidence: 'log', artifact: 'art.txt', by: 'h',
  })
  assert.equal(ran.ok, true)
  // **SDO-40 缺口三**：`pass` 行必须能追到「用例 → 通过结果」，否则降级为 unverified
  store.writeYaml(['tests', 'TC-002.yml'], { testCase: { id: 'TC-002', title: 't', kind: 'unit', requirement: 'REQ-002', steps: [], expected: 'e', at: '' } })
  store.writeYaml(['tests', 'results', 'TR-002.yml'], { result: { id: 'TR-002', caseId: 'TC-002', status: 'pass', evidence: 'e', at: '2026-10-06T00:00:00Z' } })
  const { manifest } = packageDelivery(store, journal, {
    workspace: BASE,
    by: 'cockpit',
    artifacts: [{ path: 'art.txt', kind: 'source' }],
    acceptance: [acceptance('unverified'), acceptance('pass', 'REQ-002')],
    rollbackPoint: 'git:abc',
    prototypeDir: 'prototype',
  })
  assert.equal(manifest.acceptance[0]?.verdict, 'unverified', '未验证不许被改写成 pass')

  // ① 交付门禁把「未通过或未验证」当成问题（不能让"未验证"混过去）
  const completeness = deliveryCompleteness(store, [requirement()], 'prototype')
  assert.equal(completeness.ok, false)
  assert.match(completeness.problems.join(' '), /未通过或未验证：REQ-001:unverified/u)

  // ② 行内容进真源（可从 journal 重建矩阵，而不是只存在于渲染产物里）
  const event = journal.read().events.filter((item) => item.type === 'delivery/packaged').pop()
  const rows = event?.data.acceptanceRows
  assert.ok(Array.isArray(rows) && rows.length === 2, `验收行要整体入账：${JSON.stringify(event?.data)}`)
  assert.equal((rows as { verdict: string }[])[0]?.verdict, 'unverified')
  assert.equal((rows as { criterion: string }[])[0]?.criterion, 'AC-001', 'criterion 也要入账（追溯键）')

  // ③ 渲染时非 pass 行显著标注
  const doc = renderDelivery(manifest, '# h')
  assert.match(doc, /\| REQ-001 \| AC-001 \| e \| unverified ⚠️ \|/u)
  assert.match(doc, /\| REQ-002 \| AC-001 \| e \| pass \|/u, 'pass 行不加标记')

  // ④ 工具层：非法取值**绝不默认 pass**（源码级守卫 + 回执点名字段）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /verdict: verdictOf\(row\.verdict\)/u, '入参必须过 verdictOf')
  assert.doesNotMatch(index, /row\.verdict === 'fail' \|\| row\.verdict === 'waived' \? row\.verdict : 'pass'/u, '旧的"非法即 pass"必须消失')
  assert.match(index, /kAcceptanceVerdictRewritten/u, '被改写的行要逐行点名')
})

test('SDO-50：C-50 按用例取**最新一条**结果（latest-wins）—— 「修好并重跑」必须能变绿', () => {
  const write = (id: string, caseId: string, status: 'pass' | 'fail', at: string): void => {
    store.writeYaml(['tests', 'results', `${id}.yml`], { result: { id, caseId, status, evidence: 'e', at } })
  }
  // 真机形状：TC-053 先 fail（01:04）后 pass（08:01）⇒ 门禁判定在 08:12，不该再红
  write('TR-061', 'TC-053', 'fail', '2026-10-06T01:04:41Z')
  write('TR-066', 'TC-053', 'pass', '2026-10-06T08:01:31Z')
  const fixed = verificationStats(store)
  assert.equal(fixed.failed, 0, '最新一条是 pass ⇒ 不再算失败')
  assert.deepEqual(fixed.failedCaseIds, [])
  assert.equal(fixed.failed, 0)
  assert.equal(fixed.results, 1, '按用例去重后只算最新那一条')

  // 反向：最新一条是 fail ⇒ 仍要红（不许放宽成"有任一 pass 即通过"）
  write('TR-067', 'TC-053', 'fail', '2026-10-06T09:00:00Z')
  const regressed = verificationStats(store)
  assert.equal(regressed.failed, 1)
  assert.deepEqual(regressed.failedCaseIds, ['TC-053'])

  // 两个用例各取自己最新的一条（互不干扰）
  write('TR-070', 'TC-025', 'pass', '2026-10-06T02:00:00Z')
  write('TR-071', 'TC-025', 'fail', '2026-10-06T03:00:00Z')
  const two = verificationStats(store)
  assert.deepEqual(two.failedCaseIds.sort(), ['TC-025', 'TC-053'], '每个用例各取最新一条')
  assert.equal(two.results, 2)
})

test('SDO-37：目录型产物不再被说成「盘上找不到」—— 递归摘要 + 条目数，且不算缺失', () => {
  mkdirSync(join(BASE, 'src', 'deep'), { recursive: true })
  writeFileSync(join(BASE, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  writeFileSync(join(BASE, 'src', 'deep', 'b.ts'), 'export const b = 2\n', 'utf8')

  const dirHash = hashArtifact(BASE, 'src')
  assert.match(dirHash, /^dir:2:[0-9a-f]{12}$/u, `目录要给「条目数:摘要」而不是 missing：${dirHash}`)
  assert.equal(hashArtifact(BASE, 'src/a.ts').length, 64, '文件照旧给 sha256')
  assert.equal(hashArtifact(BASE, 'nope'), 'missing', '真不存在才是 missing')

  // 门禁与事件：目录条目不算「缺失」，并在事件里单独列出来
  const { missingArtifacts } = packageDelivery(store, journal, {
    workspace: BASE, by: 'cockpit', artifacts: [{ path: 'src', kind: 'source' }],
    acceptance: [], rollbackPoint: 'git:abc', prototypeDir: 'prototype',
  })
  assert.deepEqual(missingArtifacts, [], '目录不是缺失')
  const event = journal.read().events.filter((item) => item.type === 'delivery/packaged').pop()
  assert.deepEqual(event?.data.directoryArtifacts, ['src'], '目录条目要在事件里单独说明')
  const completeness = deliveryCompleteness(store, [], 'prototype')
  assert.doesNotMatch(completeness.problems.join(' '), /src/u, '不许把目录说成产物缺失')
})

// ════════════════════════════════════════════════════════════════════════════════════════
// 测试域七类真源（0.1.6 / DES-031）：读写幂等 + 渲染头 + 过期判定
//
// 卡 TASK-001 的 DoD 原文：
//   ① 七类真源的读写幂等（同一真源两次渲染逐字节一致）；
//   ② 渲染头带真源位置与 journal 序号；
//   ③ 改真源后序号前进；
//   ④ 守卫用例：改真源 ⇒ 旧渲染判过期。
//
// 这一组用例只碰 `.sdo/testing/**` 与 `docs/TEST*`：**不接工具面**（工具面的接线与门禁判据
// 是后续卡的事），于是"读写 / 渲染 / 过期"这三层口径可以单独被观察到。
// ════════════════════════════════════════════════════════════════════════════════════════

/** 测试域专用沙箱（与上面 SDO-41/50/37 三条的 `m43` 分开，避免互相清目录）。 */
const TESTING_BASE = join(ROOT, 'node_modules', '.sdo-test', 'm43-testing')

let tStore: SdoStore
let tJournal: Journal

function freshTesting(): void {
  rmSync(TESTING_BASE, { recursive: true, force: true })
  mkdirSync(join(TESTING_BASE, '.sdo'), { recursive: true })
  tStore = new SdoStore(join(TESTING_BASE, '.sdo'))
  tJournal = new Journal(tStore)
}

function testingInput(): {
  store: SdoStore
  seq: number
  projectName: string
  process: string
  phase: string
} {
  return {
    store: tStore,
    seq: currentJournalSeq(tStore),
    projectName: 'PRJ-001 测试域',
    process: 'waterfall',
    phase: 'verification',
  }
}

/** 七类真源各来一份**有内容**的（不是空壳：渲染出来的文档必须能指回这些内容）。 */
function writeTestingFixtures(): void {
  writeTestingSource(
    tStore,
    'profile',
    'profile',
    {
      packages: [
        { id: 'v-model', selected: true, reason: '顺序流程：层级与多级追溯是主线', basis: 'process=waterfall' },
        { id: 'risk-based', selected: true, reason: '风险 8 条，按风险定深度', basis: 'risks=8' },
        { id: 'mutation-driven', selected: true, reason: 'critical 档位要求变异自证', basis: 'scale=critical' },
        { id: 'static-analysis', selected: true, reason: '契约 23 条，失败面可冻结', basis: 'contracts=23' },
        { id: 'exploratory', selected: false, reason: '本会话未选：只登记、不作通过证据' },
      ],
      scope: 'all',
    },
    tJournal,
  )
  writeTestingSource(
    tStore,
    'plan',
    'plan',
    {
      levels: [
        {
          id: 'TL-001',
          level: '单元',
          entry: '被测源码构建通过',
          exit: '单元用例全绿且独立评审采纳',
          traceability: 'req-tc',
        },
        { id: 'TL-002', level: '集成', entry: '单元出口达成', exit: '契约测试覆盖 23 条', traceability: 'des-ct' },
      ],
      environment: 'node 20 / 无网络',
      data: '真实台账副本 + 手工夹具',
      regressionScope: ['REQ-045', 'REQ-051'],
      exitCriteria: [
        { id: 'XC-001', criterion: '语句覆盖', metric: 'statement', threshold: '80%', scope: 'src/domain/testing*' },
        { id: 'XC-002', criterion: '变异 kill 率', metric: 'mutation-kill', threshold: '100%', scope: 'critical 卡' },
      ],
      review: { status: 'approved', by: 'user', at: '2026-10-13T00:00:00.000Z' },
    },
    tJournal,
  )
  writeTestingSource(
    tStore,
    'design',
    'design',
    {
      artifacts: [
        {
          id: 'BB-001',
          technique: 'equivalence',
          artifact: '有效类/无效类各一',
          requirementRef: 'REQ-045',
          domainSource: 'src/domain/testingStore.ts:TESTING_PACKAGES',
          useCases: ['TC-101', 'TC-102'],
        },
        {
          id: 'BB-002',
          technique: 'decision-table',
          artifact: '条件桩/动作桩/规则表（不可能规则逐条标注）',
          requirementRef: 'REQ-050',
          domainSource: 'src/domain/gates.ts',
          useCases: ['TC-110'],
        },
      ],
    },
    tJournal,
  )
  writeTestingSource(
    tStore,
    'design',
    'design-whitebox',
    {
      artifacts: [
        {
          id: 'WB-001',
          technique: 'basis-paths',
          artifact: '独立路径集',
          function: 'renderTestingDoc',
          branch: 'kind===plan/design/report',
          useCases: ['TC-201', 'TC-202', 'TC-203'],
        },
        {
          id: 'WB-002',
          technique: 'def-use',
          artifact: '定义-使用对清单',
          function: 'sourceFingerprintOf',
          variable: 'entries',
          useCases: ['TC-210'],
        },
      ],
    },
    tJournal,
  )
  writeTestingSource(
    tStore,
    'acceptance',
    'acceptance',
    {
      outline: [
        { id: 'TA-001', requirement: 'REQ-045', ac: 'AC-185', item: '方法包选择落盘且依据可核对', baseline: 'profile.yml 逐包可核' },
        { id: 'TA-002', requirement: 'REQ-051', ac: 'AC-204', item: '真源变化后拒绝签字', baseline: '报告指纹与真源比对' },
      ],
    },
    tJournal,
  )
  writeTestingSource(
    tStore,
    'coverage',
    'coverage',
    {
      readings: [
        {
          id: 'COV-001',
          criterion: 'statement',
          threshold: '80%',
          measured: '91%',
          command: 'node --test',
          report: 'node_modules/.sdo-test/cov.json',
          artifact: 'sha256:aaaa',
        },
      ],
      uncovered: [
        { id: 'UN-001', item: 'renderStale:missing 分支', disposition: '补用例', useCase: 'TC-301', reason: '' },
      ],
    },
    tJournal,
  )
  writeTestingSource(
    tStore,
    'regression',
    'regression',
    {
      impact: ['DES-031', 'TC-101', 'TC-201'],
      cases: [
        { case: 'TC-101', result: 'pass', artifact: 'sha256:bbbb', command: 'node --test test/m43.test.js' },
        { case: 'TC-201', result: 'fail', artifact: 'sha256:bbbb', command: 'node --test test/m43.test.js' },
      ],
    },
    tJournal,
  )
  writeTestingSource(
    tStore,
    'report',
    'report',
    {
      exitCriteria: [
        { id: 'XC-001', criterion: '语句覆盖', threshold: '80%', measured: '91%', verdict: 'pass' },
        { id: 'XC-002', criterion: '变异 kill 率', threshold: '100%', measured: '80%', verdict: 'fail' },
      ],
      coverage: [
        { id: 'COV-001', criterion: 'statement', threshold: '80%', measured: '91%', command: 'node --test', report: 'cov.json', artifact: 'sha256:aaaa' },
      ],
      uncovered: [
        { id: 'UN-001', item: 'renderStale:missing 分支', disposition: '补用例', useCase: 'TC-301', reason: '' },
      ],
      mutation: { killRate: '80%', threshold: '100%', record: '.sdo/construction/tdd.yml', survived: [{ id: 'MU-003', disposition: '补用例', useCase: 'TC-310', reason: '' }] },
      residualRisks: ['未覆盖分支 UN-001 尚未重算'],
      escapes: [{ id: 'DEF-007', title: '逃逸：真源改了但旧渲染仍被当证据' }],
      signature: { status: 'pending', by: '', at: '', waiver: '' },
    },
    tJournal,
  )
}

/**
 * 建好七类真源 + 三份渲染好、登记好的承重文档。
 *
 * 三份**用同一个 `seq`** 渲染 —— 这正是"同一次渲染动作"的真实形态（否则后写的两行会让先写的
 * 那份的登记序号小于当前序号；那种差异只该进回执的说明，不该让前两份被判过期）。
 */
function renderAllDocs(): Record<TestingDocKind, string> {
  writeTestingFixtures()
  const seq = currentJournalSeq(tStore)
  const strs: TestingDocKind[] = ['plan', 'design', 'report']
  for (const kind of strs) writeTestingDoc(tStore, kind, { ...testingInput(), seq }, tJournal)
  return {
    plan: readFileSync(join(TESTING_BASE, 'docs', 'TESTPLAN.md'), 'utf8'),
    design: readFileSync(join(TESTING_BASE, 'docs', 'TESTDESIGN.md'), 'utf8'),
    report: readFileSync(join(TESTING_BASE, 'docs', 'TESTREPORT.md'), 'utf8'),
  }
}

test('测试域七类：一类一函数、design 一类两文件，且每条真源路径都落在 .sdo/testing/ 下', () => {
  assert.equal(TESTING_CLASSES.length, 7, '测试域是**七类**真源（REQ-017 的 0.1.6 扩项）')
  assert.deepEqual([...TESTING_CLASSES], ['profile', 'plan', 'design', 'acceptance', 'coverage', 'regression', 'report'])

  const files = TESTING_CLASSES.flatMap((cls) => TESTING_SOURCE_FILES[cls])
  assert.equal(files.length, 8, 'design 一类含黑盒 + 白盒两个文件，其余各一个')
  for (const ref of files) {
    assert.match(ref.path, /^testing\/[a-z-]+\.yml$/u, `真源必须落在 .sdo/testing/：${ref.path}`)
    assert.equal(ref.class, ref.path.slice('testing/'.length, -'.yml'.length).replace('design-whitebox', 'design'))
  }

  // 承重三份文档：**规范名唯一**，且每份都能指到它自己的真源位置
  assert.equal(TESTING_DOC_META.plan.relativePath, 'docs/TESTPLAN.md')
  assert.equal(TESTING_DOC_META.design.relativePath, 'docs/TESTDESIGN.md')
  assert.equal(TESTING_DOC_META.report.relativePath, 'docs/TESTREPORT.md')
  assert.equal(docSourceLocation('plan'), '.sdo/testing/plan.yml')
  assert.match(docSourceLocation('design'), /design\.yml \+ design-whitebox\.yml/u, '白盒并入同一份设计规格，不另造第二份')
  assert.equal(docSourceLocation('report'), '.sdo/testing/report.yml')
})

test('读写幂等：同一真源写两次逐字节一致、**不留第二条事件**、指纹不变（REQ-045 落盘的幂等）', () => {
  freshTesting()
  const plan = { levels: [{ id: 'TL-001', level: '单元', entry: 'e', exit: 'x' }], exitCriteria: [] }
  const first = writeTestingSource(tStore, 'plan', 'plan', plan, tJournal)
  assert.equal(first.changed, true, '首次写：盘上内容确实变了')
  const bytes1 = readFileSync(join(TESTING_BASE, '.sdo', 'testing', 'plan.yml'), 'utf8')
  const fp1 = sourceFingerprintOf(tStore, 'plan')

  const eventsAfterFirst = tJournal.read().events.length
  const mtime1 = statSync(join(TESTING_BASE, '.sdo', 'testing', 'plan.yml')).mtimeMs

  const second = writeTestingSource(tStore, 'plan', 'plan', plan, tJournal)
  assert.equal(second.changed, false, '同样的内容再写一次 ⇒ 不动盘（changed:false）')
  const bytes2 = readFileSync(join(TESTING_BASE, '.sdo', 'testing', 'plan.yml'), 'utf8')
  assert.equal(bytes2, bytes1, '同一真源两次写入逐字节一致')
  assert.equal(second.fingerprint, fp1, '指纹由内容决定：同内容 ⇒ 同指纹')
  assert.equal(
    tJournal.read().events.length,
    eventsAfterFirst,
    '重复写**不留第二条** truth/file-written：否则任何一次重放都会推进序号',
  )
  assert.equal(statSync(join(TESTING_BASE, '.sdo', 'testing', 'plan.yml')).mtimeMs, mtime1, '没变就不该动 mtime')

  // 反向：内容真变了 ⇒ 指纹变（否则"改真源判过期"整条链失效）
  writeTestingSource(tStore, 'plan', 'plan', { ...plan, environment: 'node 20' }, tJournal)
  assert.notEqual(sourceFingerprintOf(tStore, 'plan'), fp1, '内容变了指纹必须变')
})

test('渲染幂等：同一真源同一 seq 两次渲染逐字节一致，且带真源位置与 journal 序号', () => {
  freshTesting()
  writeTestingFixtures()
  const input = testingInput()

  for (const kind of ['plan', 'design', 'report'] as const) {
    const one = kind === 'plan' ? renderTestPlan(input) : kind === 'design' ? renderTestDesign(input) : renderTestReport(input)
    // 先给 journal 追加一条事件，证明"渲染是纯函数"：真源与 seq 没变，序号前进也不该影响同一 seq 的渲染
    tJournal.append('evidence/recorded', { note: '无关事件' }, 'sdo')
    const two = kind === 'plan' ? renderTestPlan(input) : kind === 'design' ? renderTestDesign(input) : renderTestReport(input)
    assert.equal(two, one, `${kind}：同一真源 + 同一 seq ⇒ 逐字节一致`)
    assert.match(one, /<!-- generated by dsh-software-dev-office v[^ ]+ from \.sdo\/ ; DO NOT EDIT -->/u)
    assert.match(
      one,
      new RegExp(`<!-- source: ${docSourceLocation(kind).replace(/[.+]/gu, '\\$&')} @ journal seq ${input.seq} -->`, 'u'),
      `${kind}：渲染头必须带**真源位置**与 **journal 序号**`,
    )
    assert.equal(parseRenderSeq(one), input.seq, '序号要能被既有解析器读出来（判据按它重渲染）')
    assert.match(one, /\| [^|]+ \| -+ \|/u, `${kind}：正文有表格（人读）`)
  }

  // 落盘之后的字节同样幂等（**同一 seq** 写两遍 ⇒ sha256 相同；
  // ⚠️ 每次写都会登记一条事件、序号因此前进 —— 所以"同一真源"必须连同"同一 seq"一起说）
  const fixedSeq = currentJournalSeq(tStore)
  const write1 = writeTestingDoc(tStore, 'plan', { ...input, seq: fixedSeq }, tJournal)
  const write2 = writeTestingDoc(tStore, 'plan', { ...input, seq: fixedSeq }, tJournal)
  assert.equal(write2.sha256, write1.sha256, '落盘渲染也幂等：同一真源 + 同一 seq ⇒ 同一 sha256')
  assert.equal(docSha256(readFileSync(join(TESTING_BASE, ...write1.path.split('/')), 'utf8')), write1.sha256)
})

test('真源内容真的流进文档：AC 编号、准出准则、黑盒/白盒必产项都能在文档里点名', () => {
  freshTesting()
  const docs = renderAllDocs()
  assert.match(docs.plan, /TL-001/u, '层级表')
  assert.match(docs.plan, /node 20 \/ 无网络/u, '测试环境与数据来源')
  assert.match(docs.plan, /XC-002/u, '准出准则')
  assert.match(docs.plan, /已批准/u, '计划评审状态')
  assert.match(docs.design, /BB-001/u, '黑盒必产项')
  assert.match(docs.design, /src\/domain\/testingStore\.ts:TESTING_PACKAGES/u, '域的出处要写出来（防凑数）')
  assert.match(docs.design, /TC-101/u, '必产项被用例反向引用')
  assert.match(docs.design, /WB-002/u, '白盒必产项（并入同一份设计规格）')
  assert.match(docs.report, /UN-001/u, '未覆盖项逐条处置（含指向补的那条用例 TC-301）')
  assert.match(docs.report, /TC-301/u, '未覆盖项的处置要指向用例')
  assert.match(docs.report, /MU-003/u, '存活变异体逐条处置')
  assert.match(docs.report, /DEF-007/u, '逃逸缺陷')
  assert.match(docs.report, /未覆盖分支 UN-001 尚未重算/u, '残余风险')
  assert.equal(docs.report.includes('pass') && docs.report.includes('fail'), true, '准出准则逐条结论（一 pass 一 fail 都在）')
})

test('改真源 ⇒ 旧渲染判过期；重新渲染后**序号前进**（卡 DoD 的守卫 ③④）', () => {
  freshTesting()
  renderAllDocs()

  const before = renderStale(tStore, 'plan', tJournal)
  assert.equal(before.stale, false, `刚渲染且登记过的文档不该判过期：${JSON.stringify(before)}`)
  assert.equal(before.missing, false)

  const metaBefore = lastDocRecord(tStore, 'plan')
  assert.ok(metaBefore !== undefined, '渲染要留登记（journal doc/rendered），否则无从判过期')
  assert.equal(metaBefore.fingerprint, docSourceFingerprint(tStore, 'plan'))
  const seqBefore = metaBefore.seq

  // ① 改真源（多加一条准出准则）
  const planPath = join(TESTING_BASE, '.sdo', 'testing', 'plan.yml')
  writeFileSync(planPath, `${readFileSync(planPath, 'utf8')}  # 改了真源\n`, 'utf8')

  const after = renderStale(tStore, 'plan', tJournal)
  assert.equal(after.stale, true, '改真源 ⇒ 旧渲染**判过期**')
  assert.equal(after.sourceChanged, true, '过期的理由是"真源内容指纹不符"')
  assert.equal(after.missing, false, '文档还在盘上，过期不是因为缺文件')
  assert.notEqual(after.currentFingerprint, after.recordedFingerprint)

  // ② 重新渲染：序号**前进**，且新头里的序号就是新的登记
  const fresh = writeTestingDoc(tStore, 'plan', testingInput(), tJournal)
  assert.ok(fresh.seq > seqBefore, `改真源后重新渲染，序号必须前进：${seqBefore} → ${fresh.seq}`)
  assert.equal(parseRenderSeq(readFileSync(join(TESTING_BASE, 'docs', 'TESTPLAN.md'), 'utf8')), fresh.seq)
  assert.equal(lastDocRecord(tStore, 'plan')?.fingerprint, fresh.fingerprint, '登记跟着新真源走')

  const settled = renderStale(tStore, 'plan', tJournal)
  assert.equal(settled.stale, false, `重新渲染并登记后不再过期：${JSON.stringify(settled)}`)

  // ③ 只追加无关事件（真源没变）⇒ **不判过期**（这一点必须是设计取舍，不是碰巧）：
  //    序号是整个 journal 的游标（记一条用例结果、判一次门禁都会动它），拿它定红绿必然假红；
  //    红绿由**内容指纹**说了算，序号只作回执里的说明。
  const seqAtSettle = lastDocRecord(tStore, 'plan')?.seq ?? 0
  tJournal.append('evidence/recorded', { note: '与测试真源无关' }, 'sdo')
  const drifted = renderStale(tStore, 'plan', tJournal)
  assert.equal(drifted.sourceChanged, false, '真源内容没变')
  assert.equal(drifted.seqAdvanced, true, '序号确实前进了（说明性字段）')
  assert.equal(drifted.stale, false, '无关事件不该让渲染过期（否则渲染完三份文档，前两份立刻假红）')

  // ④ 真源再动一次 ⇒ 又过期，且重新渲染后序号继续**单调前进**（卡 DoD 的③）
  const planPathAgain = join(TESTING_BASE, '.sdo', 'testing', 'plan.yml')
  writeFileSync(planPathAgain, `${readFileSync(planPathAgain, 'utf8')}  # 再改一次\n`, 'utf8')
  assert.equal(renderStale(tStore, 'plan', tJournal).stale, true)
  const rerendered = writeTestingDoc(tStore, 'plan', testingInput(), tJournal)
  assert.ok(rerendered.seq > seqAtSettle, `序号只许前进：${seqAtSettle} → ${rerendered.seq}`)
  assert.equal(renderStale(tStore, 'plan', tJournal).stale, false)
})

test('过期判定的粒度：改 design-whitebox（白盒真源）只让设计规格过期，不动计划与报告', () => {
  freshTesting()
  renderAllDocs()
  for (const kind of ['plan', 'design', 'report'] as const) {
    assert.equal(renderStale(tStore, kind, tJournal).stale, false, `${kind} 起始不该过期`)
  }
  const white = join(TESTING_BASE, '.sdo', 'testing', 'design-whitebox.yml')
  writeFileSync(white, `${readFileSync(white, 'utf8')}  # 白盒真源改了\n`, 'utf8')

  assert.equal(renderStale(tStore, 'design', tJournal).stale, true, '白盒真源改了 ⇒ 设计规格过期')
  assert.equal(renderStale(tStore, 'design', tJournal).sourceChanged, true)
  assert.equal(renderStale(tStore, 'plan', tJournal).stale, false, '计划不受影响')
  assert.equal(renderStale(tStore, 'report', tJournal).stale, false, '报告不受影响（报告只由 report.yml 定）')
})

test('指纹口径：换行归一（CRLF 不改指纹）、mtime 不改指纹、**没登记过的文档也判过期**（不许假绿）', () => {
  freshTesting()
  writeTestingFixtures()
  const fp = sourceFingerprintOf(tStore, 'plan')
  const planPath = join(TESTING_BASE, '.sdo', 'testing', 'plan.yml')
  const text = readFileSync(planPath, 'utf8')

  // ① 只改 mtime：指纹不动
  const future = new Date(Date.now() + 60_000)
  utimesSync(planPath, future, future)
  assert.equal(sourceFingerprintOf(tStore, 'plan'), fp, '指纹绑内容，不绑 mtime')

  // ② CRLF 归一：指纹不动（Windows 检出不该造成假过期）
  writeFileSync(planPath, text.replace(/\n/gu, '\r\n'), 'utf8')
  assert.equal(sourceFingerprintOf(tStore, 'plan'), fp, 'CRLF/LF 同一内容 ⇒ 同一指纹')
  writeFileSync(planPath, text, 'utf8')

  // ③ 盘上有文档但**没有登记** ⇒ 过期（来路不明的文档不算"当前真源的渲染"）
  const docsDir = join(TESTING_BASE, 'docs')
  mkdirSync(docsDir, { recursive: true })
  writeFileSync(join(docsDir, 'TESTPLAN.md'), '# 手写的一份计划\n', 'utf8')
  const unknown = renderStale(tStore, 'plan', tJournal)
  assert.equal(unknown.stale, true, '没有登记的文档必须判过期（否则外部文档能冒充证据）')
  assert.equal(unknown.recordedFingerprint, '')
  assert.equal(unknown.missing, false, '它不是"缺失"，是"来路不明"')

  // ④ 同一真源的两次渲染（不同 seq）只差头里的序号 —— 指纹与正文不受影响
  const one = renderTestPlan({ ...testingInput(), seq: 7 })
  const two = renderTestPlan({ ...testingInput(), seq: 9 })
  assert.equal(one.replaceAll('seq 7', 'seq 9').replace('渲染序号：7', '渲染序号：9'), two, '两次渲染的差异**只在**渲染头与元信息里的序号')
})

test('手改守卫：改过盘上的文档 ⇒ 渲染前先留副本再覆盖，并如实回报（与 derivedDocs 同款）', () => {
  freshTesting()
  renderAllDocs()
  const docPath = join(TESTING_BASE, 'docs', 'TESTREPORT.md')
  writeFileSync(docPath, '# 我手改过的报告\n', 'utf8')

  const write = writeTestingDoc(tStore, 'report', testingInput(), tJournal)
  assert.equal(write.handEdited, true, '盘上那份不是我们写的 ⇒ 必须报出来')
  assert.ok(write.snapshot !== undefined && write.snapshot.startsWith('evidence/hand-edits/'), `副本路径：${write.snapshot}`)
  const backup = readFileSync(join(TESTING_BASE, '.sdo', ...(write.snapshot as string).split('/')), 'utf8')
  assert.equal(backup, '# 我手改过的报告\n', '副本里是**手改的那一份**原文')
  assert.match(readFileSync(docPath, 'utf8'), /测试总结报告/u, '盘上被真源渲染覆盖')

  // 反向：没人手改时不许假报手改（否则每次渲染都留副本，噪声会盖掉真问题）
  const again = writeTestingDoc(tStore, 'report', testingInput(), tJournal)
  assert.equal(again.handEdited, false)
})

test('坏真源不崩也不静默：YAML 坏 ⇒ unreadable；`levels: 单元` 少写一对 [] ⇒ 形状提示点名', () => {
  freshTesting()
  tStore.writeText(['testing', 'plan.yml'], 'plan: [\n')
  const broken = readTestingSource(tStore, TESTING_SOURCE_FILES.plan[0] as never)
  assert.equal(broken.present, true)
  assert.equal(broken.unreadable, true, '解析不了就如实报 unreadable，绝不静默当成"没写"')
  assert.deepEqual(broken.value, {})
  const doc = renderTestPlan(testingInput())
  assert.match(doc, /测试计划/u, '坏真源也要渲染出文档（人得看得见）')

  // 形状：`levels: 单元`（少写一对 `[]`）⇒ 按"整条只有名字"读回，并给一条点名到字段的提示
  tStore.writeYaml(['testing', 'plan.yml'], { plan: { levels: '单元', exitCriteria: [] } })
  const read = readTestingClass(tStore, 'plan')[0]
  assert.equal(read?.notes.length, 1, `少写一对 [] 要有形状提示：${JSON.stringify(read?.notes)}`)
  assert.equal(read?.notes[0]?.key, 'levels')
  assert.equal(read?.notes[0]?.handling, 'single')
})

test('渲染头可复算：`seq` 与真源指纹都进登记，且 writeTestingDoc 的登记能被 lastDocRecord 读回', () => {
  freshTesting()
  writeTestingFixtures()
  const seq = currentJournalSeq(tStore)
  const write = writeTestingDoc(tStore, 'design', { ...testingInput(), seq }, tJournal)
  const record = lastDocRecord(tStore, 'design')
  assert.ok(record !== undefined)
  assert.equal(record.path, write.path)
  assert.equal(record.seq, seq)
  assert.equal(record.sha256, write.sha256)
  assert.equal(record.fingerprint, sourceFingerprintOf(tStore, 'design'), 'design 的指纹是黑盒 + 白盒两个文件的合并指纹')
  assert.notEqual(record.fingerprint, sourceFingerprintOf(tStore, 'profile'), '合并指纹不是任意别的类的指纹')
  assert.equal(currentJournalSeq(tStore, tJournal), tJournal.read().events.length, '当前序号 = 盘上最大 seq')
})

// ════════════════════════════════════════════════════════════════════════════════════════
// REV-001 整改（TASK-029）：散文切分与 stale 语义
//
// 两条发现都来自评审 TASK-001 的 REV-001：
//   · **F3**（可修）：`renderTestPlan` 的「回归范围」曾走 `tokens()`（按空白切分）⇒ 手写整句被切碎。
//     它之所以漏抓，是因为**当时的夹具只喂 ID 型取值**（`['REQ-045','REQ-051']`）——
//     按空白切分对 ID 型取值与按整行读取**结果相同**。所以本条的夹具必须是**散文**，否则等于没测。
//   · **F4**（非阻塞）：`renderStale` 在「盘上有文档但没有渲染登记」时曾返回 `sourceChanged: true`，
//     与字段注释（"真源内容指纹与登记不一致"）矛盾 —— 无登记根本不存在可比对的指纹。
//     现在改由 `unregistered` 表达，`sourceChanged` 恒为 false。
// ════════════════════════════════════════════════════════════════════════════════════════

test('REV-001 F3 守卫：回归范围按**整行**读 —— 手写整句不许被空白切碎（夹具必须是散文）', () => {
  freshTesting()
  const PROSE = '回归到 REQ-045 与 REQ-051 这两条需求的用例'
  // 把**散文**写进真源（这正是 `.sdo/testing/plan.yml` 给人手写时的典型形态）
  writeTestingSource(
    tStore,
    'plan',
    'plan',
    {
      levels: [{ id: 'TL-001', level: '单元', entry: 'e', exit: 'x' }],
      exitCriteria: [{ id: 'XC-001', criterion: 'c', threshold: '80%' }],
      regressionScope: [PROSE],
    },
    tJournal,
  )
  const doc = renderTestPlan({ store: tStore, seq: currentJournalSeq(tStore) })
  const section = doc.split('## 3.')[1]?.split('## 4.')[0] ?? ''
  const bullets = section.split('\n').filter((line) => line.startsWith('- ') && !line.includes('（无）'))

  // ① 整句逐字出现
  assert.ok(section.includes(`- ${PROSE}`), `整句必须逐字保留；实际渲染：\n${section.trim()}`)
  // ② 只许一条 —— 按空白切分会得到 5 条（实测：- 回归到 / - REQ-045 / - 与 / - REQ-051 / - 这两条需求的用例）
  assert.equal(bullets.length, 1, `散文位置只许一条；实际 ${bullets.length} 条：${bullets.join(' | ')}`)
  // ③ 反向：ID 列表形态仍然照旧（一条一个）
  writeTestingSource(
    tStore,
    'plan',
    'plan',
    {
      levels: [{ id: 'TL-001', level: '单元', entry: 'e', exit: 'x' }],
      exitCriteria: [{ id: 'XC-001', criterion: 'c', threshold: '80%' }],
      regressionScope: ['REQ-045', 'REQ-051'],
    },
    tJournal,
  )
  const listDoc = renderTestPlan({ store: tStore, seq: currentJournalSeq(tStore) })
  const listSection = listDoc.split('## 3.')[1]?.split('## 4.')[0] ?? ''
  const listBullets = listSection.split('\n').filter((line) => line.startsWith('- ') && !line.includes('（无）'))
  assert.deepEqual(listBullets, ['- REQ-045', '- REQ-051'], 'ID 列表形态不受影响（修 F3 不该把列表也并成一条）')
})

test('REV-001 F4 守卫：无登记 ⇒ unregistered=true 且 sourceChanged=false（来路不明 ≠ 真源改了）', () => {
  freshTesting()
  writeTestingFixtures()
  // 盘上放一份**没有登记**的文档（模拟外部/手写产物）
  mkdirSync(join(TESTING_BASE, 'docs'), { recursive: true })
  writeFileSync(join(TESTING_BASE, 'docs', 'TESTPLAN.md'), '# 来路不明的一份计划\n', 'utf8')

  const unknown = renderStale(tStore, 'plan', tJournal)
  assert.equal(lastDocRecord(tStore, 'plan'), undefined, '前提：确实没有登记')
  assert.equal(unknown.stale, true, '来路不明的文档不算"当前真源的渲染" ⇒ 过期')
  // `unregistered` 是本轮（REV-001 F4）新加的字段。这里按**宽松取值**读它而不是 `unknown.unregistered`：
  // 红灯基线用例会把「修正前的 testingStore.ts」物化成一棵树再编译，而当前 `test/` 会被一起拷进去 ——
  // 直接写 `unknown.unregistered` 会让那棵树**编译不过**（修正前的类型里没有这个字段），
  // 于是红灯基线从"行为对比"退化成"类型报错"。宽松取值让这套断言在**两版 API** 下都能编译，
  // 而行为差异照旧由断言体现（修正前该字段为 undefined ⇒ 下面两条必红）。
  const f4 = unknown as unknown as { unregistered?: boolean; sourceChanged: boolean }
  assert.equal(f4.unregistered, true, '要显式表达"没有登记"')
  assert.equal(unknown.sourceChanged, false, '没有可比对的登记指纹 ⇒ 不能说"真源改了"（F4 的核心）')
  assert.equal(unknown.recordedFingerprint, '', '没有登记就没有登记指纹')
  assert.equal(unknown.missing, false, '它不是"缺失"，是"来路不明"')

  // 反向：真源真的改了 ⇒ 是 sourceChanged 而**不是** unregistered（两个字段正交）
  renderAllDocs()
  const planPath = join(TESTING_BASE, '.sdo', 'testing', 'plan.yml')
  writeFileSync(planPath, `${readFileSync(planPath, 'utf8')}  # 改真源\n`, 'utf8')
  const changed = renderStale(tStore, 'plan', tJournal)
  assert.equal(changed.sourceChanged, true, '有登记且指纹对不上 ⇒ 真源改了')
  assert.equal((changed as unknown as { unregistered?: boolean }).unregistered, false, '有登记就不是"来路不明"')
  assert.equal(changed.stale, true)
})

test('REV-001 补漏：渲染产物被删掉 ⇒ stale=true 且 missing=true（变异 M3 存活暴露的缺口）', () => {
  freshTesting()
  renderAllDocs()
  const ok = renderStale(tStore, 'plan', tJournal)
  assert.equal(ok.stale, false, '前提：刚渲染且登记过')
  assert.equal(ok.missing, false, '前提：文档在盘上')

  // 删掉渲染产物：真源没变、登记还在，但文档没了 ⇒ 必须判过期（否则"报告被删"会被当成"无需重渲染"）
  rmSync(join(TESTING_BASE, 'docs', 'TESTPLAN.md'))
  const gone = renderStale(tStore, 'plan', tJournal)
  assert.equal(gone.missing, true, '要如实报"盘上没有这份文档"')
  assert.equal(gone.sourceChanged, false, '真源没改，过期理由不是"真源改了"')
  assert.equal(gone.stale, true, '缺文档 ⇒ 必须判过期（这条是变异 M3 存活暴露出来的漏抓）')
})
