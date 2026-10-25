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
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice, INDEPENDENT_REVIEW_DOD, REVIEW_PENDING_BIG_SHOWN } from '../src/office.js'
import { pendingReviewBigCards } from '../src/domain/collab.js'
import { rolePools } from '../src/domain/pool.js'
import {
  FACE_DETAIL_ROWS,
  POOL_UNUSABLE_CHARS,
  POOL_UNUSABLE_IDS_PER_REASON,
  POOL_UNUSABLE_REASON_CHARS,
  POOL_UNUSABLE_REASON_SOURCE,
  childFaceLines,
  describePoolBlock,
} from '../src/interface/describe.js'
import { renderStatusBlock } from '../src/interface/inject.js'
import { realLedgerSkip } from './support/real-ledger.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { Review } from '../src/domain/records.js'
import type { EvidenceItem, TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
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

/* ————————————————————————————————————————————————————————————————————————————————
 * **增量 232（`TASK-210`）：读数面收口 —— `next` 回执不再按子会话平铺（`DEF-175` 的另一半）**
 *
 * 病灶：`next` 回执里的两块（`describePoolBlock` 的「不可复用」栏 + `childFaceLines` 的逐条观测）
 * 都是**一个子会话一段**，而历史子会话有上百个 ⇒ 真机实录 **57135 字符**、被宿主截到 8000，
 * 派发结论（派了谁 / 为什么 / 谁被挡）正好落在截断之外。
 *
 * 三条守卫（与卡上 DoD 的「守卫（两态）」一一对应）：
 *   · `M232-01` 子会话 **2 → 20** ⇒ 读数块体积**不随子会话数线性膨胀**（阈值断言，两态）；
 *   · `M232-02` **逐条原因**在缺省档与 `verbose` 档**都拿得到**（缺省档按原因归并、原因原话整句保留；
 *     `verbose` 档每个子会话一行，一字不少）；
 *   · `M232-03` 观测面：缺省档只逐条打 `FACE_DETAIL_ROWS` 条、**有问题的排前面**，其余折成计数归纳行；
 *     `verbose` 档把每一条都打出来；归纳行**不许**教读者一个工具面上不存在的参数（`REV-093#2`）。
 *   · `M232-04`（`REV-093#3` 的返工）**第 4 种原因不许整段消失**：只要原因种数在字符预算内，缺省档
 *     必须把它们**全部**印出来；只有"又多又长"时才折叠，且折叠时必须说出**被折叠的原因种数**。
 *   · `M232-05`（`REV-093#4` 的返工）原因原话超长 ⇒ 截断分支的两态（缺省档截断且**保留细节在整句前部**、
 *     `verbose` 档仍是原话全文），并且整段仍在字符预算之内。
 *
 * 编号沿用「增量」序列（`m231` 之后）：本卡写范围不含新建测试文件，故落在 `m230`。
 * 断言消息一律用英文（本文件不进 `KNOWN_PROSE_GAP`，内联中文会被散文棘轮记成未登记站点）。
 * ———————————————————————————————————————————————————————————————————————————————— */

/** 读数块体积的**增长预算**（字符）：2 → 20 个子会话，涨得比这多就算"线性膨胀"。 */
const GROWTH_BUDGET = 400

/** 种一个"空闲但不可复用"的子会话（真事件：派发 → 结算 → 观测；掩码是过期的旧指纹）。 */
function seedIdleChild(index: number): string {
  const child = `c0ffee${String(index).padStart(2, '0')}-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`
  office.recordDispatchStarted(impl(), {
    taskId: `TASK-8${String(index).padStart(3, '0')}`,
    provider: 'spawn',
    childSessionId: child,
    parentSessionId: 's-impl',
    tools: 3,
    role: 'developer',
    mode: 'continuable',
    // 过期掩码 ⇒ 该候选进 `unusable` 桶（这正是真机里那 101 个的形状）
    maskHash: 'deadbeefdeadbeef',
  })
  office.journalFor(WORKSPACE).append('dispatch/finished', { task: `TASK-8${String(index).padStart(3, '0')}`, childSessionId: child })
  office.noteChildFace(impl(), { childSessionId: child, tools: ['bash', 'edit', 'read'], violations: [], calls: [], callCount: 0 })
  return child
}

/** 一块真读数：真台账 → `office.poolPlan` → 回执里那两块（`next` 回执只在这两处按子会话平铺）。 */
function readoutOf(): { pools: ReturnType<SoftwareDevOffice['poolPlan']>['pools']; text: string } {
  const plan = office.poolPlan(impl(), { reuseIdle: false })
  return {
    pools: plan.pools,
    text: describePoolBlock(plan.pools, [], true, 60) + '\n' + childFaceLines(office.childFaces(impl())).join('\n'),
  }
}

test('M232-01 子会话 2 → 20：读数块体积不随子会话数线性膨胀（阈值断言，两态）', () => {
  seedIdleChild(1)
  seedIdleChild(2)
  const small = readoutOf()
  const smallCount = small.pools.reduce((sum, pool) => sum + pool.unusable.length, 0)
  assert.equal(smallCount, 2, `fixture premise: two unusable candidates: ${JSON.stringify(small.pools.map((pool) => pool.unusable.length))}`)

  for (let index = 3; index <= 20; index += 1) seedIdleChild(index)
  const large = readoutOf()
  const largeCount = large.pools.reduce((sum, pool) => sum + pool.unusable.length, 0)
  assert.equal(largeCount, 20, `fixture premise: twenty unusable candidates: ${JSON.stringify(large.pools.map((pool) => pool.unusable.length))}`)

  // 两态：同一块读数，只差子会话个数。**线性口径下**每多一个候选至少多一段「id + 原因」
  // （本夹具的原因原话 > 100 字符）⇒ 18 个候选本该多出上千字符。
  const grown = large.text.length - small.text.length
  assert.ok(
    grown >= 0,
    `the readout must not shrink when more sessions appear (else the comparison is meaningless): ${String(grown)}`,
  )
  assert.ok(
    grown <= GROWTH_BUDGET,
    `the readout grew by ${String(grown)} chars for +18 child sessions (budget ${String(GROWTH_BUDGET)}) — it is still per-session`,
  )
  // 有界不等于"看不见"：全量条数与原因原话（这里 20 个候选同因 ⇒ 归并成一组 ×20）都必须还在
  assert.ok(large.text.includes(String(largeCount)), `the readout must still state the full candidate count: ${large.text.slice(0, 300)}`)
  assert.ok(large.text.includes('×20'), `the readout must still state why they are not reusable, grouped by reason: ${large.text.slice(0, 400)}`)
})

test('M232-02 逐条原因在缺省档与 verbose 档都拿得到（缺省按原因归并，verbose 逐条）', () => {
  // 三种原因 × 9 个候选 = 27 个候选（每个原因分组都**超过**样本上限 ⇒ "列了几个"是可数的）
  const reasons = ['reason-alpha', 'reason-beta', 'reason-gamma']
  const children = Array.from({ length: 27 }, (_, index) => ({
    childSessionId: `cafe${String(index).padStart(4, '0')}-1111-4222-8333-4444444444${String(index % 100).padStart(2, '0')}`,
    role: 'developer',
    task: `TASK-7${String(index).padStart(2, '0')}`,
    mode: 'continuable' as const,
    state: 'idle' as const,
    rounds: 1,
    startedAt: '2026-10-08T00:00:00.000Z',
    finishedAt: '2026-10-08T00:01:00.000Z',
    maskHash: 'same',
  }))
  const pools = rolePools({
    children,
    roles: ['developer'],
    caps: { developer: 27 },
    defaultCap: 27,
    reuseBlockedOf: (child) => `${reasons[Number(child.childSessionId.slice(4, 8)) % reasons.length] ?? ''}（掩码不可比）`,
  })
  const folded = describePoolBlock(pools, [], true, 60)
  const verbose = describePoolBlock(pools, [], true, 60, { verbose: true })

  // ① 缺省档：三个原因**原话**都在（归并的是数量，不是原因）+ 每个原因带自己的计数
  for (const reason of reasons) {
    assert.ok(folded.includes(reason), `the folded readout must keep the reason verbatim (${reason}): ${folded}`)
    assert.ok(verbose.includes(reason), `the verbose readout must keep it too (${reason})`)
  }
  assert.equal((folded.match(/×9/gu) ?? []).length, reasons.length, `each printed reason group must carry its own count of 9: ${folded}`)
  // ② verbose 档：**每个**候选的子会话前 8 位都在（逐条，一个不少）
  for (const child of children) {
    const prefix = child.childSessionId.slice(0, 8)
    assert.ok(verbose.includes(prefix), `verbose must print every candidate (${prefix})`)
  }
  // ③ 缺省档**不许**把 27 个候选全列出来：列出的样本数 = 组数 × 每组样本数，并且**严格小于**全集
  const prefixes = children.map((child) => child.childSessionId.slice(0, 8))
  const listed = prefixes.filter((prefix) => folded.includes(prefix)).length
  const cap = reasons.length * POOL_UNUSABLE_IDS_PER_REASON
  assert.equal(listed, cap, `the folded readout must print exactly ${String(cap)} samples (${String(reasons.length)} groups × ${String(POOL_UNUSABLE_IDS_PER_REASON)}), got ${String(listed)}: ${folded}`)
  assert.ok(listed < children.length, 'bounded: the folded readout must print fewer ids than there are candidates')
  // ④ 常量本身钉住（改数字必须改守卫）
  assert.equal(POOL_UNUSABLE_IDS_PER_REASON, 3, 'the sample-per-reason cap is pinned')
  assert.ok(POOL_UNUSABLE_CHARS >= 400, `the char budget must be able to hold the real shape (a few reasons of ~168 chars each): ${String(POOL_UNUSABLE_CHARS)}`)
  assert.ok(POOL_UNUSABLE_REASON_CHARS >= 168, 'the reason cap must stay above the longest real reason (168 chars, measured on the live ledger)')
})

test('M232-04 (REV-093#3 rework) a 4th distinct reason must not vanish: every reason within the char budget is printed', realLedgerSkip() ?? {}, () => {
  // **两态**：`REV-093#3` 的形状是"4 种原因、第一版按组数封顶 ⇒ 第 4 种一个字都不印"。
  // 现在按**字符预算**封顶 ⇒ 只要原因种数在预算内，全部印出来；超过预算才折叠，且必须点名种数。
  const short = ['reason-A', 'reason-B', 'reason-C', 'reason-D', 'reason-E']
  const poolOf = (reasons: string[], per: number): ReturnType<typeof rolePools> => {
    const children = Array.from({ length: reasons.length * per }, (_, index) => ({
      childSessionId: `feed${String(index).padStart(4, '0')}-1111-4222-8333-444444444444`,
      role: 'developer',
      task: `TASK-6${String(index).padStart(2, '0')}`,
      mode: 'continuable' as const,
      state: 'idle' as const,
      rounds: 1,
      startedAt: '2026-10-08T00:00:00.000Z',
      finishedAt: '2026-10-08T00:01:00.000Z',
      maskHash: 'same',
    }))
    return rolePools({
      children,
      roles: ['developer'],
      caps: { developer: children.length },
      defaultCap: children.length,
      reuseBlockedOf: (child) => reasons[Number(child.childSessionId.slice(4, 8)) % reasons.length] ?? '',
    })
  }
  // ① 态一：5 种**短**原因 ⇒ 预算装得下 ⇒ **五种全在**（第一版这里只会印 3 种）
  const small = describePoolBlock(poolOf(short, 2), [], true, 60)
  for (const reason of short) {
    assert.ok(small.includes(reason), `every reason within the char budget must be printed (${reason}): ${small}`)
  }
  assert.equal(small.includes('reasons-not-shown'), false, `nothing may be folded when the budget holds everything: ${small}`)
  // ②的第三态（`REV-094#6`）：**不折叠时不许印指路**（否则每次派发都多一句噪音）
  assert.equal(small.includes(POOL_UNUSABLE_REASON_SOURCE), false, `the "where the full text lives" pointer must only appear when something was folded: ${small}`)

  // ② 态二：8 种**长**原因（每种 120 字符）⇒ 必然超预算 ⇒ 必须折叠，且**说出未展开的原因种数**
  const long = Array.from({ length: 8 }, (_, index) => `reason-${String(index)}-${'x'.repeat(110)}`)
  const big = describePoolBlock(poolOf(long, 2), [], true, 60)
  const folded = /\[reasons-not-shown=(\d+)\]/u.exec(big)
  assert.ok(folded !== null, `when the budget forces folding, the readout must say how many REASONS were not shown: ${big}`)
  const notShown = Number(folded[1] ?? '0')
  assert.ok(notShown > 0, `the folded reason count must be a real count: ${String(notShown)}`)
  const shownReasons = long.filter((reason) => big.includes(reason.slice(0, 60)))
  assert.equal(shownReasons.length + notShown, long.length, `shown + not-shown must add up to every distinct reason (${String(shownReasons.length)} + ${String(notShown)} != ${String(long.length)}): ${big}`)
  // ②的第四态（`REV-094#6`）：折叠时**必须指路** —— 被折叠原因的原话去哪读（计数不够，读者要知道去哪）
  assert.ok(big.includes(POOL_UNUSABLE_REASON_SOURCE), `when something was folded the readout must say where the full text lives: ${big}`)
  // 指路目标是**真的**：那条事件在现盘台账里逐条都带 `reason`（不是一句写着好看的话）
  const liveLedger = readFileSync(join(ROOT, '.sdo', 'journal.jsonl'), 'utf8')
  assert.ok(liveLedger.includes('dispatch/reuse-skipped'), 'fixture premise: the pointed-at event type really exists in the live ledger')
  assert.ok(liveLedger.includes('"reason"'), 'fixture premise: that event really carries the reason text')
  // ③ 有界：整段仍在预算量级（不再是"原因种数 × 原话长度"的无界乘积）
  // 那段文本所在行：用 ASCII 标记定位（散文棘轮的 READING 正则盯的是带该调用的行，注释里出现中文也会被记成站点）
  const line = big.split('\n').find((row) => row.includes('reasons-not-shown')) ?? ''
  assert.ok(line.length <= POOL_UNUSABLE_CHARS + POOL_UNUSABLE_REASON_CHARS + 80, `the folded line must stay bounded, got ${String(line.length)} chars: ${line}`)
})

test('M232-05 (REV-093#4 rework) the over-long reason truncation branch: default truncates but keeps the head, verbose keeps it whole', () => {
  // 修前这条分支（`reason.length > POOL_UNUSABLE_REASON_CHARS`）**没有任何用例走过** —— 评审指出它是空白区。
  // 前部细节用英文禁令名（真实原因原话里就是中文的'缺'后面跟这些英文工具名；这里只要形态）
  const head = 'subagent_fork workflow plugin_manager create_goal update_goal'
  const tailMarker = 'TAIL-MUST-SURVIVE-IN-VERBOSE'
  const reason = `${head}${'x'.repeat(POOL_UNUSABLE_REASON_CHARS)}${tailMarker}`
  assert.ok(reason.length > POOL_UNUSABLE_REASON_CHARS, 'fixture premise: the reason is longer than the cap')
  const children = Array.from({ length: 2 }, (_, index) => ({
    childSessionId: `d00d${String(index).padStart(4, '0')}-1111-4222-8333-444444444444`,
    role: 'developer',
    task: `TASK-5${String(index).padStart(2, '0')}`,
    mode: 'continuable' as const,
    state: 'idle' as const,
    rounds: 1,
    startedAt: '2026-10-08T00:00:00.000Z',
    finishedAt: '2026-10-08T00:01:00.000Z',
    maskHash: 'same',
  }))
  const pools = rolePools({ children, roles: ['developer'], caps: { developer: 2 }, defaultCap: 2, reuseBlockedOf: () => reason })
  const folded = describePoolBlock(pools, [], true, 60)
  const verbose = describePoolBlock(pools, [], true, 60, { verbose: true })
  // ① 缺省档：截断（有省略号）、**前部细节仍在**（"缺哪几条禁令"这句最有价值的话在句子前部）
  assert.ok(folded.includes('…'), `the default readout must mark the truncation: ${folded}`)
  assert.ok(folded.includes(head), `the truncation must keep the informative head: ${folded}`)
  assert.equal(folded.includes(tailMarker), false, `the truncation must really cut the tail: ${folded}`)
  // ② verbose 档：原话全文（尾标还在）—— 信息一点没丢
  assert.ok(verbose.includes(tailMarker), `the verbose readout must keep the full reason: ${verbose.slice(0, 200)}`)
  assert.ok(verbose.includes(reason), 'the verbose readout must carry the reason verbatim, byte for byte')
})

test('M232-03 观测面：缺省档只逐条打 FACE_DETAIL_ROWS 条且**有问题的排前面**，verbose 逐条全打', () => {
  const clean = (index: number): { childSessionId: string; tools: string[]; violations: string[]; calls: string[]; callCount: number } => ({
    childSessionId: `aaaa${String(index).padStart(4, '0')}-2222-4333-8444-5555555555${String(index).padStart(2, '0')}`,
    tools: ['bash', 'edit', 'read'],
    violations: [],
    calls: [],
    callCount: 0,
  })
  const dirty = {
    childSessionId: 'bbbb9999-2222-4333-8444-555555555555',
    tools: ['bash', 'sdo_release'],
    violations: ['sdo_release'],
    calls: ['sdo_plan'],
    callCount: 2,
  }
  const faces = [...Array.from({ length: 7 }, (_, index) => clean(index)), dirty]
  const folded = childFaceLines(faces)
  const verbose = childFaceLines(faces, { verbose: true })
  // ① 缺省档：逐条只有 FACE_DETAIL_ROWS 条（每条两行），其余折成**一行**归纳
  assert.equal(folded.length, FACE_DETAIL_ROWS * 2 + 1, `the folded face block must be ${String(FACE_DETAIL_ROWS)} details + 1 summary line: ${folded.join(' / ')}`)
  // ② 有问题的排前面（`DEF-041` 的信息不许被"只打前 N 条"埋掉）
  assert.ok(folded[0]?.includes('bbbb9999'), `the noteworthy face must come first: ${folded[0] ?? ''}`)
  assert.ok(folded.some((line) => line.includes('2')), `the summary must carry the outside-mask call count: ${folded.join(' / ')}`)
  // ③ verbose 档：每条子会话都在（2 行 × 8）
  assert.equal(verbose.length, faces.length * 2, `verbose must print every face (two lines each): ${String(verbose.length)}`)
  for (const face of faces) assert.ok(verbose.some((line) => line.includes(face.childSessionId)), `verbose must name ${face.childSessionId}`)
  // ④ 常量钉住
  assert.equal(FACE_DETAIL_ROWS, 3, 'the per-face detail cap is pinned')
  // ⑤ **回执不许教读者一个工具面上不存在的参数**（`REV-093#2`）：`sdo_plan` 的参数表里没有 `verbose`
  //   ⇒ 归纳行只能指一条真有的出路（台账原件），并且**产品面**这句话必须逐字出现在两处归纳行里。
  const summary = folded.at(-1) ?? ''
  assert.equal(summary.includes('verbose'), false, `the summary must not promise a parameter the tool face does not accept: ${summary}`)
  assert.ok(summary.includes('child-tools.jsonl'), `the summary must point at a real place to read every line: ${summary}`)
  // ⑤ 的第二半（`REV-094#2` 指出的**空断言**）：修前这里用 `children: []` 的池 ⇒ `unusable` 为空 ⇒
  //   `kPoolUnusable` 那行**根本不会渲染**，池块那半改前改后都过（"池块已被钉住"是假象）。
  //   夹具改成**至少 1 个不可复用候选**：先断言那行真的渲染出来（前提），再断言它不承诺 `verbose`。
  const poolFixture = rolePools({
    children: [{
      childSessionId: 'c0ffee00-1111-4222-8333-444444444444',
      role: 'developer',
      task: 'TASK-90',
      mode: 'continuable' as const,
      state: 'idle' as const,
      rounds: 1,
      startedAt: '2026-10-08T00:00:00.000Z',
      finishedAt: '2026-10-08T00:01:00.000Z',
      maskHash: 'other',
    }],
    roles: ['developer'],
    caps: { developer: 1 },
    defaultCap: 1,
    reuseBlockedOf: () => 'mask fingerprint changed',
  })
  const poolSummary = describePoolBlock(poolFixture, [], true, 60)
  assert.ok(poolSummary.includes('c0ffee00'), `fixture premise: the unusable line must really render (else this half is vacuous): ${poolSummary}`)
  assert.equal(poolSummary.includes('verbose'), false, `the pool block must not promise it either: ${poolSummary}`)
  // 同一夹具的第二态：函数级 `verbose` 档一个字都不许丢（它是本仓人手排查的出口）
  const poolVerbose = describePoolBlock(poolFixture, [], true, 60, { verbose: true })
  assert.ok(poolVerbose.includes('mask fingerprint changed'), `the verbose pool block must keep the reason verbatim: ${poolVerbose}`)
  // ⑥ **产品面**自证：`sdo_plan` / `sdo_status` 的参数表里确实没有 `verbose`（本文件与产品代码同源核对）
  const toolsSource = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  assert.equal(/\bverbose\b/u.test(toolsSource), false, 'fixture premise for ⑤: the tool schema has no verbose parameter — if it ever gains one, rewrite the summary text and this guard together')
})
