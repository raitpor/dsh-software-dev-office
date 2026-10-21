/**
 * **增量 210：`C-52` 口径收窄（2026-10-21 用户裁定「收窄两条」）。**
 *
 * 病根（追加任务书 §1）：`independenceViolations()` 原来把**每一条**"评审者与实现者是同一会话"的评审
 * 都计成违规 —— 两件性质完全不同的事被算成一件：
 *   · 自评的**放行**（`verdict=pass`）⇒ 真的自我放行；
 *   · 自评的**自我否定**（`changes-requested` / `reject`）⇒ 自己给自己挑毛病，不是放水；
 *   · 自评 `pass` 但该卡**另有独立且已采纳**的通过评审 ⇒ 依据在别处。
 * 后果是 `C-52` 在真账上变成一条**永远修不好的红**（历史不能改）⇒ 人迟早学会忽略它（Goodhart）。
 *
 * 收窄两条：
 *   ① 只有 `verdict === 'pass'` 的自评才可能违规（其余进 `noted` 留痕）；
 *   ② `pass` 自评只在**它是这张卡唯一可依据的独立面**时判红 —— 判据要现读"这张卡有没有
 *      「不同会话 + `verdict=pass` + `state=adopted`」的评审"（采纳态走 `reviewAdoption` 唯一出口）。
 *
 * 四态（任务书 §3 全都要）：
 *   ① 自评 `pass`、该卡没有别的评审 ⇒ **红**并点名 `REV-id`；
 *   ② 自评 `pass` + 另有一条不同会话且**已采纳**的 `pass` 评审 ⇒ **绿**，ok 文案点名「自评留痕」；
 *   ③ 自评 `changes-requested` ⇒ **绿**（不进违规），ok 文案点名留痕；
 *   ④ 独立评审**存在但未被采纳** ⇒ **红**（独立面必须是已采纳的 —— 钉住"别把口径放宽成有别的评审就算独立"）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { Review } from '../src/domain/records.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m210/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
/** 实现方会话（认领这张卡、也记自评）与评审方会话（记独立评审）。 */
const impl = (): OfficeCall => ({ sessionId: 's-impl', cwd: WORKSPACE }) as unknown as OfficeCall
const reviewer = (): OfficeCall => ({ sessionId: 's-rev', cwd: WORKSPACE }) as unknown as OfficeCall

/** `C-52` 的现算读数（走真实门禁，不另判一遍）。 */
function c52(): { ok: boolean; na?: boolean; detail: string } {
  const criterion = office.evaluate(impl(), 'G6').criteria.find((item) => item.id === 'C-52')
  assert.ok(criterion !== undefined, '前置：G6 必须声明 C-52（review.independent）')
  return criterion as { ok: boolean; na?: boolean; detail: string }
}

/** 记一条评审（`sessionId` 显式给：它才是独立性判据的材料）。 */
function addReview(input: {
  session: 's-impl' | 's-rev'
  reviewer: string
  verdict: 'pass' | 'changes-requested'
  findings: string[]
  repro?: string
}): Review {
  return office.addReview(input.session === 's-impl' ? impl() : reviewer(), {
    taskId: 'TASK-001',
    reviewer: input.reviewer,
    verdict: input.verdict,
    findings: input.findings,
    sessionId: input.session,
    ...(input.repro === undefined ? {} : { repro: input.repro }),
  } as never)
}

/** 把一条评审的每条发现都核实成"成立"⇒ 采纳态（核实人必须不是记录人）。 */
function adopt(review: Review, by: 's-impl' | 's-rev'): void {
  for (let index = 0; index < review.findings.length; index += 1) {
    const outcome = office.verifyReviewFinding(by === 's-impl' ? impl() : reviewer(), {
      reviewId: review.id,
      index,
      outcome: 'reproduced',
      evidence: '照着发现能复现 ⇒ exitCode=0（M210 夹具）',
      by: by === 's-impl' ? 'subagent:developer' : 'subagent:reviewer',
    })
    assert.equal(outcome.ok, true, `夹具前提：第 ${index + 1} 条发现必须能核实：${JSON.stringify(outcome)}`)
  }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-impl', WORKSPACE)
  office.noteSession('s-rev', WORKSPACE)
  office.init(impl(), { name: 'M210 C-52 收窄', scale: 'normal', stakeholders: ['业务方'] })
  const task: TaskCard = {
    id: 'TASK-001', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-001.yml'], { task })
  // 卡的**认领会话** = `s-impl`（独立性判据的材料来自 `task/claimed` 事件，不看卡当前状态）
  const claimed = office.claimTask(impl(), { taskId: 'TASK-001', owner: 'dev-a', expectedRevision: 1 })
  assert.equal(claimed.ok, true, `夹具前提：认领必须成功：${JSON.stringify(claimed)}`)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M210-01 态①：自评 `pass` 且该卡**没有**别的评审 ⇒ 判红并点名该 REV-id', () => {
  const self = addReview({ session: 's-impl', reviewer: 'dev-a', verdict: 'pass', findings: ['自评：无阻塞'] })
  const verdict = c52()
  assert.equal(verdict.ok, false, `自评放行且无独立面 ⇒ 必须判红：${verdict.detail}`)
  assert.notEqual(verdict.na, true, '不是"不适用"——这条卡有评审，判据必须开口')
  assert.ok(verdict.detail.includes(self.id), `判红要点名那条自评：${verdict.detail}`)
  assert.match(verdict.detail, /同一个会话/u, '判词要说清是按会话判的')
})

test('M210-02 态②：自评 `pass` + 另有**不同会话且已采纳**的 `pass` 评审 ⇒ 判绿，但点名自评留痕', () => {
  const self = addReview({ session: 's-impl', reviewer: 'dev-a', verdict: 'pass', findings: ['自评：无阻塞'] })
  const independent = addReview({ session: 's-rev', reviewer: 'reviewer-9', verdict: 'pass', findings: ['独立：无阻塞'] })
  adopt(independent, 's-impl')

  const verdict = c52()
  assert.equal(verdict.ok, true, `有独立采纳评审 ⇒ 自评不该再判红：${verdict.detail}`)
  // **留痕**：绿也要说清"另有几条自评只留痕"（否则读者以为一条自评都没有）
  assert.ok(verdict.detail.includes(self.id), `绿文案要点名那条自评留痕：${verdict.detail}`)
  assert.match(verdict.detail, /自评只留痕/u, `绿文案要给"只留痕不判违规"这个说法（语言包新键）：${verdict.detail}`)
})

test('M210-03 态③：自评 `changes-requested` ⇒ 判绿（自我否定不是放水），且点名留痕', () => {
  const self = addReview({
    session: 's-impl', reviewer: 'dev-a', verdict: 'changes-requested',
    findings: ['自评：这里还得改'], repro: 'node --test 仍然失败（M210 夹具）',
  })
  const verdict = c52()
  assert.equal(verdict.ok, true, `自评的自我否定不进违规集合：${verdict.detail}`)
  assert.ok(verdict.detail.includes(self.id), `绿文案要点名这条自评留痕：${verdict.detail}`)
  assert.match(verdict.detail, /自我否定/u, `要说明它是"自我否定"而不是放水：${verdict.detail}`)
})

test('M210-04 态④：独立评审**存在但未采纳** ⇒ 仍判红（口径不许放宽成"有别的评审就算独立"）', () => {
  const self = addReview({ session: 's-impl', reviewer: 'dev-a', verdict: 'pass', findings: ['自评：无阻塞'] })
  // 独立会话记了一条 `pass`，但**一条发现都没核实** ⇒ `reviewAdoption` 给 `unverified`，不是依据
  addReview({ session: 's-rev', reviewer: 'reviewer-9', verdict: 'pass', findings: [] })

  const verdict = c52()
  assert.equal(verdict.ok, false, `未采纳的独立评审不算"可依据的独立面"⇒ 仍要红：${verdict.detail}`)
  assert.ok(verdict.detail.includes(self.id), `判红要点名那条自评：${verdict.detail}`)
})

test('M210-05 出口与判据**同一份采纳集**：态②下 `reviewViolations` 不许再把它印成"独立性违规"', () => {
  // 这一格守的是"两处口径分家"（`DEF-044` 的教训）：`C-52` 判绿、而 `sdo_review action=list` 的
  //「⚠️ 独立性违规」那行仍把它列出来 —— 读者会看到自相矛盾的两句话。
  const self = addReview({ session: 's-impl', reviewer: 'dev-a', verdict: 'pass', findings: ['自评：无阻塞'] })
  const independent = addReview({ session: 's-rev', reviewer: 'reviewer-9', verdict: 'pass', findings: ['独立：无阻塞'] })
  adopt(independent, 's-impl')

  const verdict = c52()
  assert.equal(verdict.ok, true, `判据必须绿（依据在独立采纳评审上）：${verdict.detail}`)
  assert.ok(verdict.detail.includes(self.id), '判据的绿文案要点名这条自评留痕')

  const exit = office.reviewViolations(impl())
  assert.deepEqual(
    exit.map((item) => item.reviewId),
    [],
    `出口必须与判据同口径：被独立评审覆盖的自评**不许**再印成「独立性违规」（实际：${exit.map((item) => item.reviewId).join(' ') || '（无）'}）`,
  )
})
