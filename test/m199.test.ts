/**
 * **增量 199：第十三批 §2.3 / §3.1（`DEF-113` / `DEF-111`）。**
 *
 * `DEF-113`：`tester` 面里有 `sdo_deliver` ⇒ 只读补核卡（`TASK-150`）误调 `action=package`，生成了本项目
 * **第一个**交付包 `DLV-001`（台账 `delivery/packaged` seq 3497 抹不掉）。修：把 `sdo_deliver` 从 tester 面移出
 * （它属 `delivery` 角色），`sdo_test` 仍在。
 * `DEF-111`：工具描述/卡面模板写评审落点 `.md`、实际 `.yml` ⇒ 子会话按卡面找证据、`done` 被拒两次。
 * 修：源树里已无 `REV-*.md` 字面（现算），并让 `sdo_review record` 回执**印出真实落点**。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { maskAllows, toolAllowList } from '../src/domain/roles.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

test('M199-01 §2.3（`DEF-113`）`tester` 面**不含** `sdo_deliver`（只读补核卡不许写交付真源）；`delivery` 面仍含', () => {
  // ① tester 面：没有 sdo_deliver（旧形态会让只读卡造出交付包 DLV-001）
  assert.equal(toolAllowList('tester').includes('sdo_deliver'), false, 'tester 面不许有 sdo_deliver（它属 delivery 角色）')
  assert.equal(maskAllows('tester', 'sdo_deliver'), false, '`maskAllows` 必须同判（掩码唯一出口）')
  // ② tester 该有的还在（`sdo_test` / 写类 —— 改测试脚本是它的正当工作）
  for (const tool of ['sdo_test', 'sdo_task', 'sdo_trace', 'write', 'edit', 'bash']) {
    assert.equal(toolAllowList('tester').includes(tool), true, `tester 面不许误删 ${tool}`)
  }
  // ③ delivery 面仍含（移出不是删掉能力）
  assert.equal(toolAllowList('delivery').includes('sdo_deliver'), true, '交付官必须还能 package')
})

test('M199-02 §3.1（`DEF-111`）评审落点就是 `.yml`：源树零 `REV-*.md` 字面，回执模板印 `.yml` 落点', () => {
  // ① 源树（src / skills / README）里不许再有 `REV-*.md` 的描述（文档与实现同一落点）
  for (const file of ['src/interface/tools.ts', 'src/data/lang/zh-CN.yml', 'src/data/lang/en.yml', 'skills/role-reviewer.md', 'README.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    assert.equal(new RegExp('REV-\\*\\.md', 'u').test(text), false, `${file} 里还写着 REV-*.md（实际落点是 .yml）`)
  }
  // ② 回执模板必须印真实落点（`.yml`），否则子会话仍要猜文件名
  const zh = readFileSync(join(ROOT, 'src', 'data', 'lang', 'zh-CN.yml'), 'utf8')
  const line = zh.split('\n').find((item) => item.includes('kReviewLandedAt:')) ?? ''
  assert.match(line, /\.yml/u, '回执模板必须印 `.yml` 落点')
  // ③ 接线：回执真的用了它，且落在 `reviews/<REV id>.yml`
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.ok(index.includes("fmt('uiIndex.kReviewLandedAt', { p1: landedAt })"), '`sdo_review record` 回执必须把**现算的落点**传给模板（不是空串）')
  assert.ok(index.includes('/reviews/${review.id}.yml'), '落点必须由 `reviews/<REV id>.yml` 现算（不写死）')
})

test("M199-03 §2.2（`DEF-110`）通道不可用 ≠ 拒签：两条事件分开记，回执给出路", () => {
  // ① 事件词表里有独立事件（旧实现只有 `gate/sign-rejected`，事后读账分不出"没弹"与"拒签"）
  const types = readFileSync(join(ROOT, 'src', 'types.ts'), 'utf8')
  assert.ok(types.includes("'gate/sign-unavailable'"), '事件词表必须有 `gate/sign-unavailable`')
  // ② 接线：拿不到 answer 时**落独立事件**，而不是走 `noteSignRejected`
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.ok(index.includes('office.noteSignUnavailable(call, args.gate'), '通道不可用必须落 `gate/sign-unavailable`')
  // ③ 回执文案必须**给出路**（不许只报"没弹出"）
  const zh = readFileSync(join(ROOT, 'src', 'data', 'lang', 'zh-CN.yml'), 'utf8')
  const line = zh.split('\n').find((item) => item.includes('kSignNoChannel:')) ?? ''
  assert.match(line, /不是「你拒签」|不是.*拒签/u, '必须明确"这不是你拒签"（区分没弹/拒签）')
  assert.match(line, /出路/u, '必须给可执行出路')
  assert.match(line, /重试/u, '出路里要点名"在 GUI 里重试"')
  // ④ 两条事件的载荷可区分：unavailable 带 reason，rejected 带 basis
  const office = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  // 载荷**在 200 字符内**检查（跨函数的 `[\s\S]*?` 会串到下一个 append，等于没判）
  assert.match(office, /journal\.append\('gate\/sign-unavailable', \{[\s\S]{0,200}?reason:/u, '`sign-unavailable` 要带 reason')
  assert.match(office, /journal\.append\('gate\/sign-rejected', \{[\s\S]{0,200}?basis:/u, '`sign-rejected` 要带 basis')
})

test("M199-04 §2.1（`DEF-112`）陈述面签字 = **弱签字**：只入账、**不冻结门禁**；问答通道才是有效签字", async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const os = await import('node:os')
  const { SdoStore } = await import('../src/infra/store.js')
  const { Journal } = await import('../src/infra/journal.js')
  const { recordSignature, signatureState, signoffInput } = await import('../src/domain/signature.js')
  const dir = mkdtempSync(join(os.tmpdir(), 'sdo-m199-'))
  try {
    const store = new SdoStore(join(dir, '.sdo'))
    const journal = new Journal(store)
    // ① 陈述面（`command` + weak）⇒ 入账但状态是 `weak`（C7 只认 `valid`）
    const weak = recordSignature(store, journal, { gate: 'G2', by: 'user', basis: '把 REQ-060 补进基线', channel: 'command', weak: true })
    assert.equal(weak.weak, true, '陈述面必须落 `weak: true`（否则读面又把工作指令当有效签字）')
    const weakState = signatureState(store, journal, 'G2')
    assert.equal(weakState.status, 'weak', '弱签字的状态必须是 `weak`（不是 valid）')
    assert.equal(signoffInput(store, journal, 'G2').status, 'weak', '`signoffInput` 必须同判（C7/DoR 都读它）')
    // ② 问题②：问答通道（宿主回传原话）⇒ 有效签字
    const second = mkdtempSync(join(os.tmpdir(), 'sdo-m199b-'))
    try {
      const store2 = new SdoStore(join(second, '.sdo'))
      const journal2 = new Journal(store2)
      recordSignature(store2, journal2, { gate: 'G2', by: 'user', basis: '签字确认，批准通过', channel: 'question', basisFresh: true })
      assert.equal(signatureState(store2, journal2, 'G2').status, 'valid', '问答通道的签字必须 valid（唯一被门禁承认的通道）')
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
    // ③ 接线：工具面**对陈述面传 `weak: true`**（否则上面的行为在真机上不会发生）
    const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
    assert.match(index, /channel: 'command',\s*\n\s*weak: true,/u, '陈述面必须显式传 `weak: true`')
    // ④ 回执必须给可执行出路（走问答通道）
    const zh = readFileSync(join(ROOT, 'src', 'data', 'lang', 'zh-CN.yml'), 'utf8')
    const line = zh.split('\n').find((item) => item.includes('kSignWeak:')) ?? ''
    assert.match(line, /channel=question/u, '回执要给"改走问答通道"的出路')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M199-05 §3.3（`DEF-115`）幽灵用例：指向不存在用例的结果必须被**点名**，不静默算进覆盖", async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const os = await import('node:os')
  const { SdoStore } = await import('../src/infra/store.js')
  const { listTestCases, orphanTestResults } = await import('../src/domain/records.js')
  const dir = mkdtempSync(join(os.tmpdir(), 'sdo-m199-orphan-'))
  try {
    const store = new SdoStore(join(dir, '.sdo'))
    // 一条**真实**用例 + 两条结果：一条挂它、一条挂**未登记**的用例（模拟历史 TR-211 那种形态）
    store.writeYaml(['tests', 'TC-901.yml'], { testCase: { id: 'TC-901', title: 't', steps: [], expected: 'e', requirement: 'REQ-001', kind: 'unit' } })
    assert.equal(listTestCases(store).some((item) => item.id === 'TC-901'), true, '前置：真用例在册')
    store.writeYaml(['tests', 'results', 'TR-901.yml'], { result: { id: 'TR-901', caseId: 'TC-901', status: 'pass', at: '' } })
    // 历史遗留：直接写盘（写入面自 DEF-037 起会拒，这里模拟"已经存在的历史记录"）
    store.writeYaml(['tests', 'results', 'TR-902.yml'], { result: { id: 'TR-902', caseId: 'TC-999-GHOST', status: 'pass', at: '' } })
    const orphans = orphanTestResults(store)
    assert.deepEqual(orphans, [{ id: 'TR-902', caseId: 'TC-999-GHOST' }], '只点名指向不存在用例的那条（真用例的那条不许误报）')
    // 回执层：`sdo_test action=list` 必须印出来（接线检查）
    const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
    assert.ok(index.includes('office.orphanTestResults(call)'), '回执必须调用幽灵用例读数')
    assert.ok(index.includes("fmt('uiIndex.kTestOrphanResults'"), '回执必须用语言键点名（数量 + 明细）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M199-06 §2.4（`DEF-107`）没有交付包必须给**可读读数**：`delivery.manifest` 的判定层要点名\"还没有交付清单\"", async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const os = await import('node:os')
  const { SdoStore } = await import('../src/infra/store.js')
  const { deliveryCompleteness } = await import('../src/domain/records.js')
  const dir = mkdtempSync(join(os.tmpdir(), 'sdo-m199-deliv-'))
  try {
    const store = new SdoStore(join(dir, '.sdo'))
    const assessment = deliveryCompleteness(store, [], 'prototype')
    assert.equal(assessment.ok, false, '没有交付清单时不许判绿')
    assert.ok(
      assessment.problems.some((item) => item.includes('还没有交付清单')),
      `必须给"没有交付包"的可读读数：${assessment.problems.join(' | ')}`,
    )
    // 触发点写进了项目侧文档（不是只活在代码注释里）
    const doc = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8')
    assert.match(doc, /交付包什么时候必须存在/u, '项目侧文档必须有"交付包何时必须存在"一节')
    assert.match(doc, /delivery.*done|done.*delivery/u, '触发点一：交付卡 done 前必须 package')
    assert.match(doc, /G7/u, '触发点二：G7 签字前必须 package')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M199-07 §4.3 读散文棘轮零摩擦：`scripts/refresh-prose-gap.mjs --check` 必须与现算**恰好相等**，且差异明细可见", async () => {
  const { spawnSync } = await import('node:child_process')
  // ① 检查模式：登记与现算恰好相等 ⇒ exit 0（不同步则 exit 1 并打印 +/~/- 明细）
  const check = spawnSync(process.execPath, ['scripts/refresh-prose-gap.mjs'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(check.status, 0, `棘轮登记与现算必须同步（跑 --write 重生成）：\n${check.stdout}${check.stderr}`)
  assert.match(check.stdout, /登记与现算恰好相等/u, '检查模式必须明说"已同步"')
  // ② 明细能力：脚本源码里必须有 +/~/- 三类差集打印（否则"零摩擦"会变成"静默漂移"）
  const script = readFileSync(join(ROOT, 'scripts', 'refresh-prose-gap.mjs'), 'utf8')
  for (const marker of ['+ 新增', '~ 变化', '- 删除', '--write']) {
    assert.ok(script.includes(marker), `脚本必须能打印「${marker}」并支持 --write`)
  }
  // ③ 口径不变：它只是重生成登记表，判定仍是 `deepEqual`（脚本不许改 m189 的断言语义）
  const m189 = readFileSync(join(ROOT, 'test', 'm189.test.ts'), 'utf8')
  assert.match(m189, /actualGap/u, 'M189-13 的现算表仍在（脚本不替代判定）')
})
