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
 *   ⑥ `M230-06` 拆卡时往 DoD 注入「已通过独立评审（评审者≠作者）」，**已有同义条目则不重复注入**；
 *   ⑦ `M230-07` 待评审中大卡**超过列示上限 5** ⇒ 行里明写「等 N 张」（不静默截断），且行里点名集是
 *      `C-42` 点名集的**真子集**、张数与 `considered` 对账（`REV-089#1`：修前夹具只造 2 张，截断分支从未被执行）。
 *
 * 夹具口径：真写卡 → 真认领 → 真 `reportTask`（`done` 是执行者唯一必经的关口，测内部函数没有意义）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice, INDEPENDENT_REVIEW_DOD, REVIEW_PENDING_BIG_SHOWN } from '../src/office.js'
import { pendingReviewBigCards } from '../src/domain/collab.js'
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

test('M230-07 落点二：待评审中大卡 > 上限 5 ⇒ 行里明写「等 N 张」，且行里点名集是 C-42 点名集的**真子集**', () => {
  // `REV-089#1`：修前夹具（M230-05）只造 2 张 done 卡，而 `REVIEW_PENDING_BIG_SHOWN` 是 5 ——
  // 「超过上限就说等 N 张」这条分支**从未被执行过**，静默截断也照样全绿。本格把它钉住。
  // 开关关掉：done 不看评审，才能把「待评审中大卡」堆到上限之上。
  setSwitch(false)
  const namedOf = (text: string): string[] => [...new Set(text.match(/TASK-\d+/gu) ?? [])].sort()
  /** 造第 n 张 done 的中大卡（写范围逐张不同 ⇒ 认领时的写范围相交兜底不会误拦）。 */
  const doneCard = (n: number): string => {
    const id = `TASK-${String(n).padStart(3, '0')}`
    const owner = `dev-${n}`
    writeCard({ id, writeScopes: [`src/m230/t${n}/`] })
    claimIt(id, owner)
    assert.equal(done(id, owner).ok, true, `夹具前提：开关关掉时 ${id} 的 done 放行`)
    return id
  }

  // ——阶段一：夹具 **< 上限（2 张）**—— 先证明这条守卫**不冤枉人**：不该红的不会红。
  // 未超上限时必须**列全**、**不得**出现「等 N 张」，行里点名集与 C-42 逐个一致（相等，不是真子集）。
  const first2 = [doneCard(1), doneCard(2)]
  const line2 = statusLine()
  assert.match(line2, /待评审中大卡 2 张/u, `未超上限时行里要报准张数：${line2}`)
  assert.doesNotMatch(line2, /等 \d+ 张/u, `未超上限时**不得**出现截断提示（出现就是上限口径算错）：${line2}`)
  assert.deepEqual(namedOf(line2), first2, `未超上限时 2 张都要被点名：${line2}`)
  assert.deepEqual(namedOf(line2), namedOf(c42().detail), `未超上限时行里与 C-42 点名集必须一致：行=${line2}`)

  // ——阶段二：**≥ 6 张**（严格大于上限 5）—— 修前从未被测到的形态 ——
  const six = [...first2]
  for (let n = 3; n <= 6; n += 1) six.push(doneCard(n))
  const line = statusLine()
  const red = c42()
  const c42Named = namedOf(red.detail)
  assert.equal(red.ok, false, `六张都没有已采纳的通过评审 ⇒ C-42 判红：${red.detail}`)
  assert.equal(c42Named.length, 6, `C-42 要点名**全部** 6 张（它不受状态块列示上限约束）：${red.detail}`)
  assert.deepEqual(c42Named, [...six].sort(), 'C-42 点名集就是这 6 张')

  // ① 截断必须**说出来**：行里明写「等 6 张」（静默列 5 张会让读者以为只有 5 张欠评审）
  assert.match(line, /待评审中大卡 6 张/u, `行里要报全量张数：${line}`)
  assert.match(line, /等 6 张/u, `超上限时必须明写「等 N 张」，不许静默截断：${line}`)

  // ② 行里 named 集是 C-42 named 集的**真子集**（严格小于 ⇒ 上限 5 真的生效，不是两处各算一遍侥幸相同）
  const shown = namedOf(line)
  assert.equal(shown.length, REVIEW_PENDING_BIG_SHOWN, `超上限时行里只列 ${REVIEW_PENDING_BIG_SHOWN} 张：${line}`)
  for (const id of shown) {
    assert.ok(c42Named.includes(id), `${id} 必须属于 C-42 的点名集：行=${line} ／ C-42=${red.detail}`)
  }
  assert.ok(shown.length < c42Named.length, '真子集：必须**严格小于**（相等就说明上限没生效，或两处口径分叉）')
  // **故意不照抄 M230-05 的 `deepEqual`**：> 上限时按设计必然不等，照抄会写出一条必红的守卫。

  // ③ 数量与 `considered` 对账（走 `C-42` 的同一个现算函数，不另数一遍台账）
  const set = pendingReviewBigCards(office.storeFor(WORKSPACE), office.journalFor(WORKSPACE))
  assert.equal(set.considered.length, 6, `considered 是全部已 done 的中大卡 ⇒ 6 张：${JSON.stringify(set.considered)}`)
  assert.equal(set.pending.length, 6, '六张都缺评审 ⇒ 点名集等于全集（本夹具里 pending == considered）')
  assert.deepEqual([...set.pending].sort(), c42Named, '状态块与 C-42 的点名来源必须是同一份读数')
  const snapshot = office.status(impl()).reviewPendingBig
  if (snapshot === undefined) assert.fail('状态块必须有「待评审中大卡」字段')
  assert.equal(
    snapshot.count,
    set.considered.length,
    `行里报的张数要与 considered 对账：count=${snapshot.count} ／ considered=${set.considered.length}`,
  )
  assert.deepEqual(snapshot.ids, set.pending, '字段里的 ids 是**全量**（列示上限只影响 line 的排版，不改读数）')
  assert.equal(namedOf(snapshot.line).length, REVIEW_PENDING_BIG_SHOWN, '已排版的那一行同样只列上限张数')
})
