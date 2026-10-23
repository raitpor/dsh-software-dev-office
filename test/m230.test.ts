/**
 * **增量 230：评审强制机制 —— 完成点硬拦截 + 状态块可见 + 拆卡注入 DoD（`TASK-195`）。**
 *
 * 病根（本卡要防的那件事）：**「忘评审」**。修前形态是 ——
 *   · `C-42`（`review.required`）只在**门禁 G5** 判，而门禁是**事后**的：一批中大卡全 done 完
 *     才一次性变红，评审要求于是永远晚一步；
 *   · 状态块里**没有**"还有哪些中大卡欠评审"这一行 ⇒ 每轮的提示面里它不可见；
 *   · 拆卡时 DoD 由模板/建议给，**不含**"已通过独立评审" ⇒ 执行者照着 DoD 干完就 done。
 *
 * 三个落点各自的守卫（编号与任务卡 DoD 一一对应）：
 *   ① `M230-01` 无评审的 medium 卡 `done` ⇒ **拒绝**且点名卡 id + 可执行修法；
 *   ② `M230-02` 有 `pass` 但**未采纳** ⇒ 拒绝且文案说「待核实采纳」；
 *   ③ `M230-03` `pass` 且**已采纳** ⇒ 放行（不误伤）；
 *   ④ `M230-04` 开关 `review.requireOnDone: false` ⇒ 放行**且回执明说已关闭**（不许静默放行）；
 *   ⑤ `M230-05` 状态块那一行与 `C-42` 的**点名集逐字一致**（同一个现算函数，不许两套口径）；
 *   ⑥ `M230-06` 拆卡时往 DoD 注入「已通过独立评审（评审者≠作者）」，**已有同义条目则不重复注入**。
 *
 * 夹具口径：真写卡 → 真认领 → 真 `reportTask`（`done` 是执行者唯一必经的关口，测内部函数没有意义）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice, INDEPENDENT_REVIEW_DOD } from '../src/office.js'
import { renderStatusBlock } from '../src/interface/inject.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { Review } from '../src/domain/records.js'
import type { EvidenceItem, TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m230/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
/** 实现方会话（认领 + 交产物）与评审方会话（记独立评审）。 */
const impl = (): OfficeCall => ({ sessionId: 's-impl', cwd: WORKSPACE }) as unknown as OfficeCall
const reviewer = (): OfficeCall => ({ sessionId: 's-rev', cwd: WORKSPACE }) as unknown as OfficeCall

/** 一条能过 A1 证据对账的 `command` 证据（`exitCode: 0` 是硬要求）。 */
function evidence(): EvidenceItem[] {
  return [{ kind: 'command', detail: 'node --test lib/test/m230.test.js（1656 passed）', at: '2026-10-23T00:00:00.000Z', exitCode: 0 }]
}

/** 写一张卡（字段平铺在 `task:` 之下，与 `readTaskChecked` 的读法一致）。 */
function writeCard(overrides: Partial<TaskCard> & { id: string }): TaskCard {
  const card: TaskCard = {
    title: overrides.id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    // 产品写范围 ⇒ `producesProductArtifacts` 为真（这条判据的前提之一）
    writeScopes: ['src/m230/'],
    role: 'developer',
    size: 'medium',
    revision: 1,
    status: 'ready',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as TaskCard
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${card.id}.yml`], { task: card })
  return card
}

/** 认领（`done` 只有 owner 能做）。 */
function claimIt(id: string, owner = 'dev-a'): void {
  const claimed = office.claimTask(impl(), { taskId: id, owner, expectedRevision: 1 })
  assert.equal(claimed.ok, true, `夹具前提：认领必须成功：${JSON.stringify(claimed)}`)
}

/** 同一条 `done` 调用（六个守卫都走它 —— 差异只在夹具，不在调用形状）。 */
function done(id: string, owner = 'dev-a'): ReturnType<SoftwareDevOffice['reportTask']> {
  return office.reportTask(impl(), { taskId: id, owner, status: 'done', evidence: evidence() })
}

/** 记一条**独立**的 `pass` 评审（评审人 ≠ 卡 owner）。 */
function addPassReview(id: string, findings: string[] = ['已逐条核对，无阻塞问题']): Review {
  return office.addReview(reviewer(), {
    taskId: id,
    reviewer: 'reviewer-9',
    verdict: 'pass',
    findings,
    sessionId: 's-rev',
  } as never)
}

/** 把一条评审的每条发现都核实成"成立" ⇒ 采纳态（核实人不是记录人）。 */
function adopt(review: Review): void {
  for (let index = 0; index < review.findings.length; index += 1) {
    const outcome = office.verifyReviewFinding(impl(), {
      reviewId: review.id,
      index,
      outcome: 'reproduced',
      evidence: '照着发现能复现 ⇒ exitCode=0（M230 夹具）',
      by: 'dev-a',
    })
    assert.equal(outcome.ok, true, `夹具前提：第 ${index + 1} 条发现必须能核实：${JSON.stringify(outcome)}`)
  }
}

/** `C-42` 的现算读数（走真门禁，不另判一遍）。 */
function c42(): { ok: boolean; detail: string } {
  const criterion = office.evaluate(impl(), 'G5').criteria.find((item) => item.id === 'C-42')
  assert.ok(criterion !== undefined, '前置：G5 必须声明 C-42（review.required）')
  return criterion as { ok: boolean; detail: string }
}

/** 状态块里「待评审中大卡」那一行（没有该行时返回 `''`）。 */
function statusLine(): string {
  const block = renderStatusBlock(office.status(impl()), '.sdo', 4000)
  return block.split('\n').find((line) => line.includes('待评审中大卡')) ?? ''
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-impl', WORKSPACE)
  office.noteSession('s-rev', WORKSPACE)
  office.init(impl(), { name: 'M230 评审强制', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 把项目开关写成需要的那一侧（`.sdo/config.yml` 是**项目**声明，不是插件行配置）。 */
function setSwitch(requireOnDone: boolean): void {
  office.storeFor(WORKSPACE).writeYaml(['config.yml'], {
    process: 'waterfall',
    scale: 'normal',
    review: { requireOnDone },
  })
}

test('M230-01 落点一：无评审的 medium 卡 done ⇒ 拒绝完成，且点名卡 id 与「先派 reviewer 卡评审」的修法', () => {
  writeCard({ id: 'TASK-001' })
  claimIt('TASK-001')
  const result = done('TASK-001')
  assert.equal(result.ok, false, `中大卡没有已采纳的通过评审 ⇒ 必须拒绝完成：${JSON.stringify(result).slice(0, 200)}`)
  if (result.ok) assert.fail('应拒绝')
  assert.equal(result.code, 'review-required', '拒绝码要单列（与"评审要求改动未核实"是两种修法）')
  assert.match(result.detail, /TASK-001/u, '要点名是哪张卡被拦')
  assert.match(result.detail, /reviewer\s*卡/u, '要给出可执行修法：先派一张 reviewer 卡评审')
  assert.match(result.detail, /requireOnDone/u, '要把开关的位置说出来（否则没人找得到出路）')
  // 零写盘：卡仍是 in-progress，且**没有** task/done 事件（不许留下半个 done）
  const card = office.tasks(impl()).find((item) => item.id === 'TASK-001')
  assert.equal(card?.status, 'in-progress', '被拒的 done 不得改卡状态')
  const doneEvents = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'task/done')
  assert.equal(doneEvents.length, 0, '被拒的 done 不得落 task/done 事件（零写盘）')
})

test('M230-02 落点一：有 pass 但**未采纳** ⇒ 拒绝完成，且文案说清「待核实采纳」', () => {
  writeCard({ id: 'TASK-001' })
  claimIt('TASK-001')
  const review = addPassReview('TASK-001')
  const result = done('TASK-001')
  assert.equal(result.ok, false, '有 pass 评审但没被核实采纳 ⇒ 不算数（与 C-42 同一采纳口径）')
  if (result.ok) assert.fail('应拒绝')
  assert.equal(result.code, 'review-required')
  assert.match(result.detail, /待核实采纳/u, `文案要说清"有 pass ≠ 算数"：${result.detail}`)
  assert.match(result.detail, new RegExp(review.id, 'u'), '要点名是哪条评审待核实')
  assert.match(result.detail, /verify-review/u, '要给出可执行修法（逐条核实）')
})

test('M230-03 落点一：pass 且**已采纳** ⇒ 放行（不误伤）', () => {
  writeCard({ id: 'TASK-001' })
  claimIt('TASK-001')
  adopt(addPassReview('TASK-001'))
  const result = done('TASK-001')
  assert.equal(result.ok, true, `已采纳的通过评审 ⇒ 必须放行：${JSON.stringify(result).slice(0, 300)}`)
  assert.equal(c42().ok, true, '放行的卡在 C-42 上也必须是绿的（同一口径）')
})

test('M230-04 落点一：开关 review.requireOnDone=false ⇒ 放行，且回执**明说已关闭**（不许静默）', () => {
  setSwitch(false)
  writeCard({ id: 'TASK-001' })
  claimIt('TASK-001')
  const result = done('TASK-001')
  assert.equal(result.ok, true, `关掉开关后必须放行：${JSON.stringify(result).slice(0, 300)}`)
  if (!result.ok) assert.fail('应放行')
  const notes = (result.naNotes ?? []).join('\n')
  assert.match(notes, /已关闭/u, `回执必须明说开关已关闭（否则读者以为判据判过了）：${notes}`)
  assert.match(notes, /requireOnDone/u, '要点名是哪个开关')
  assert.match(notes, /TASK-001/u, '要点名是哪张卡走了"关闭"这条路')
  // 关掉的是**完成点**拦截：门禁那一条（C-42）照旧说话（两件事不许混为一谈）
  assert.equal(c42().ok, false, 'C-42 不受该项目开关影响')
})

test('M230-05 落点二：状态块那一行与 C-42 的点名集**逐字一致**（同一个现算函数）', () => {
  // 开关关掉，把两张卡都真 done 出来：① 无评审的 ② 有 pass 但未采纳的
  setSwitch(false)
  writeCard({ id: 'TASK-001' })
  claimIt('TASK-001')
  assert.equal(done('TASK-001').ok, true, '夹具前提：开关关掉时 done 放行')
  writeCard({ id: 'TASK-002' })
  claimIt('TASK-002', 'dev-b')
  addPassReview('TASK-002')
  assert.equal(done('TASK-002', 'dev-b').ok, true, '夹具前提：第二张卡 done 放行')

  const line = statusLine()
  assert.notEqual(line, '', '状态块必须出现「待评审中大卡」这一行')
  assert.match(line, /待评审中大卡 2 张/u, `行里要报张数：${line}`)
  assert.match(line, /C-42/u, '行里要说明它与 C-42 是同一现算（否则读者会以为是第二套口径）')

  const named = (text: string): string[] => [...new Set(text.match(/TASK-\d+/gu) ?? [])].sort()
  const red = c42()
  assert.equal(red.ok, false, '两张卡都欠评审 ⇒ C-42 判红')
  assert.deepEqual(named(line), named(red.detail), `状态块点名集与 C-42 点名集必须逐字一致：行=${line} ／ C-42=${red.detail}`)
  // 两个桶都要被点名（missing 与 unadopted 不许互相掩盖 —— G-1 的教训）
  assert.deepEqual(named(line), ['TASK-001', 'TASK-002'])
})

test('M230-06 落点三：拆卡时注入「已通过独立评审」，已有同义条目**不重复注入**', () => {
  const result = office.planDecompose(impl(), {
    suggestions: [
      // ① 中大卡 + 产品写范围 ⇒ 注入
      { title: '中大卡要评审', goal: 'g', dod: ['实现可用'], role: 'developer', size: 'medium', writeScopes: ['src/m230/a/'] },
      // ② 已经有同义条目 ⇒ 不重复注入（人手写的两种写法都要认）
      { title: '已写同义条目', goal: 'g', dod: ['已通过独立评审（评审者≠作者）'], role: 'developer', size: 'medium', writeScopes: ['src/m230/b/'] },
      { title: '换了写法', goal: 'g', dod: ['已通过独立评审（评审者 != 作者）'], role: 'developer', size: 'medium', writeScopes: ['src/m230/c/'] },
      // ③ 小卡 ⇒ 不在考虑集（与 C-42 同一口径：拦它是 G6 的事）
      { title: '小卡不注入', goal: 'g', dod: ['实现可用'], role: 'developer', size: 'small', writeScopes: ['src/m230/d/'] },
      // ④ 评审卡自己 ⇒ 不注入（自我递归没有意义）
      { title: '评审卡', goal: 'g', dod: ['评审完成'], role: 'reviewer', size: 'medium', writeScopes: [] },
      // ⑤ 中大卡但**不产出产品工件**（只写台账/派生文档）⇒ 不在考虑集（R-12）
      { title: '文书卡', goal: 'g', dod: ['文档落地'], role: 'developer', size: 'medium', writeScopes: ['docs/'] },
    ] as never,
  })
  const byTitle = new Map(result.tasks.map((task) => [task.title, task]))
  const dodOf = (title: string): string[] => byTitle.get(title)?.dod ?? []
  assert.deepEqual(dodOf('中大卡要评审'), ['实现可用', INDEPENDENT_REVIEW_DOD], '中大卡必须被注入恰好一条')
  // 「不重复注入」要**逐字比数组**：只数字面量会被卡上本来就有的同义条目骗过去（1 条也是 1）
  assert.deepEqual(dodOf('已写同义条目'), [INDEPENDENT_REVIEW_DOD], '已有同义条目 ⇒ 不再注入第二条')
  assert.deepEqual(dodOf('换了写法'), ['已通过独立评审（评审者 != 作者）'], '`评审者 != 作者` 也算同义写法')
  assert.deepEqual(dodOf('小卡不注入'), ['实现可用'], '小卡不动 DoD')
  assert.deepEqual(dodOf('评审卡'), ['评审完成'], '评审卡不动 DoD')
  assert.deepEqual(dodOf('文书卡'), ['文档落地'], '不产出产品工件的卡不动 DoD')
  // 注入可审计：真源里要留一条 `task/updated`（fields 含 dod）
  const updated = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'task/updated')
  assert.equal(updated.length, 1, `只有"中大卡要评审"该被注入（其余五张都不在考虑集或已有同义条目）：${JSON.stringify(updated.map((event) => event.data))}`)
  assert.deepEqual(updated.map((event) => String(event.data['id'])), [byTitle.get('中大卡要评审')?.id])
  assert.deepEqual(updated[0]?.data['fields'], ['dod'], '痕迹要指向 dod 这一个字段')

  // **再来一次**：同一批建议再拆一次 ⇒ 去重后没有新卡，DoD 也不会被注入第二遍
  const again = office.planDecompose(impl(), {
    suggestions: [
      { title: '中大卡要评审', goal: 'g', dod: ['实现可用'], role: 'developer', size: 'medium', writeScopes: ['src/m230/a/'] },
    ] as never,
  })
  const againCard = again.tasks.find((task) => task.title === '中大卡要评审')
  assert.equal(
    (againCard?.dod ?? []).filter((item) => item === INDEPENDENT_REVIEW_DOD).length,
    1,
    '重复拆卡不得把同一条 DoD 注入第二遍',
  )
})
