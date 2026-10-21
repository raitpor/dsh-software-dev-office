/**
 * **增量 172：DEF-042 ①③（major，第三批 §3.15）—— C-52 必须接到会话 uuid 上**。
 *
 * 修前现盘：`independenceViolations` 只比 `reviewer` **名字**（那是调用方自报的
 * `backend:role:序号` 字符串）⇒ **换个名字即可绕过独立性**（同名 ⇒ 判红 1 条；改成
 * `subagent:developer:2` ⇒ 判红 **0** 条）。`DEF-066`（已修）早已把**会话 uuid** 记进评审
 *（`review.sessionId`），却**没有接到 C-52 上**。
 *
 * ⚠️ 长期无人察觉的**机械原因**：`test/m4` 的既有守卫把"名字不同 ⇒ 独立"当成**正确行为**钉住了
 *（改个名字后断言 0 条）。本项连带把它改成按 uuid 断言（见该文件 M4 的评审独立性段）。
 *
 * 修法：判据**材料齐时 uuid 说了算**（名字不参与）——
 *   · 卡有认领会话（`task/claimed` 事件里的 uuid，**不看卡当前状态**：独立性判定发生在卡已 done 之后）
 *     且评审记了 `sessionId` ⇒ 有交集判红、无交集不判；
 *   · 材料不全（存量没带 uuid）⇒ 退回名字口径（如实降级，不假装判过）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { listReviews } from '../src/domain/records.js'
import { claimedSessionsByCard } from '../src/domain/roles.js'
import { independenceViolations } from '../src/integration/orchestrator.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m172/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const callAs = (sessionId: string): OfficeCall => ({ sessionId, cwd: WORKSPACE }) as unknown as OfficeCall

/** 一张**已经认领过**的卡（认领会话写成 `sessionId`，卡随后置 done —— 与真机流程一致）。 */
function cardClaimedBy(sessionId: string): string {
  const task: TaskCard = {
    id: 'TASK-001', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  const store = office.storeFor(WORKSPACE)
  store.writeYaml(['tasks', 'TASK-001.yml'], { task })
  const claimed = office.claimTask(callAs(sessionId), { taskId: 'TASK-001', owner: 'dev-a', expectedRevision: 1 })
  assert.equal(claimed.ok, true, `夹具前提：认领必须成功：${JSON.stringify(claimed)}`)
  office.reportTask(callAs(sessionId), {
    taskId: 'TASK-001', owner: 'dev-a', status: 'done', evidence: [{ kind: 'command', detail: '跑了', exitCode: 0 }],
  } as never)
  return 'TASK-001'
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-impl', WORKSPACE)
  office.init(callAs('s-impl'), { name: 'M172 独立性按会话', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M172-01 三态：同会话不同名 ⇒ **仍判红**；同名不同会话 ⇒ **不判**；真不同会话 ⇒ 不判', () => {
  const taskId = cardClaimedBy('s-impl')
  const journal = office.journalFor(WORKSPACE)
  // 材料：卡的认领会话就是 s-impl（且**卡已 done** —— 这一步正是"用当前归属去判会永远空集"的坑）
  assert.deepEqual(claimedSessionsByCard(journal).get(taskId), ['s-impl'], '认领会话账必须读得到（不看卡当前状态）')
  const reviews = office.reviews(callAs('s-impl'))
  assert.equal(reviews.length, 0, '前置：还没有评审')

  // ① **同会话 + 换名字** ⇒ 必须判红（修前：名字不同 ⇒ 0 条，绕过成立）
  office.addReview(callAs('s-impl'), {
    taskId, reviewer: 'subagent:reviewer:2', verdict: 'pass', findings: ['无阻塞问题'], sessionId: 's-impl',
  } as never)
  const sameSession = office.reviewViolations(callAs('s-impl'))
  assert.equal(sameSession.length, 1, `同会话不同名必须判红（修前这里是 0 = 绕过）：${JSON.stringify(sameSession)}`)
  assert.match(sameSession[0]?.detail ?? '', /同一个会话/u, '拒因要点明"按会话判"')
  assert.match(sameSession[0]?.detail ?? '', /s-impl/u, '拒因要点名会话 uuid')

  // ② **同名 + 不同会话** ⇒ 必须**不**判（名字不参与）
  office.addReview(callAs('s-impl'), {
    taskId, reviewer: 'dev-a', verdict: 'pass', findings: ['另一会话记的'], sessionId: 's-other',
  } as never)
  const namedSame = office.reviewViolations(callAs('s-impl')).filter((item) => item.reviewId === 'REV-002')
  assert.deepEqual(namedSame, [], '同名但不同会话 ⇒ 独立（名字不再参与判定）')

  // ③ 真不同会话 + 不同名 ⇒ 不判（零误报）
  office.addReview(callAs('s-impl'), {
    taskId, reviewer: 'reviewer-b', verdict: 'pass', findings: ['独立评审'], sessionId: 's-third',
  } as never)
  const all = office.reviewViolations(callAs('s-impl'))
  assert.deepEqual(all.map((item) => item.reviewId), ['REV-001'], `只该剩"同会话"那一条：${JSON.stringify(all)}`)

  // 判据面（C-52）走的是同一份材料：G6 的 C-52 必须判否
  const c52 = office.evaluate(callAs('s-impl'), 'G6').criteria.find((criterion) => criterion.id === 'C-52')
  assert.equal(c52?.ok, false, 'C-52 必须与 reviewViolations 同口径（同会话在 → 不独立）')
})

test('M172-02 存量降级（如实）：评审没带会话 uuid ⇒ 退回名字口径，不假装判过 uuid', () => {
  const taskId = cardClaimedBy('s-impl')
  // 存量记录：没有 sessionId ⇒ 材料不全 ⇒ 只能按名字判
  office.addReview(callAs('s-impl'), { taskId, reviewer: 'dev-a', verdict: 'pass', findings: ['旧格式'] } as never)
  const byName = office.reviewViolations(callAs('s-impl'))
  assert.equal(byName.length, 1, '没有 uuid 时按名字判（旧行为，如实降级）')
  assert.match(byName[0]?.detail ?? '', /同为/u, '降级路径的文案要说得清是"同名"而不是"同会话"')
  // 换名字的旧记录：名字口径下判 0（这是**已知**的降级边界，不假装已修）
  office.addReview(callAs('s-impl'), { taskId, reviewer: 'someone-else', verdict: 'pass', findings: ['旧格式'] } as never)
  assert.deepEqual(office.reviewViolations(callAs('s-impl')).map((item) => item.reviewId), ['REV-001'],
    '旧记录仍按名字判（降级边界如实保留，等这条记录被重记时才升级到 uuid 口径）')
})

test('M172-03 纯函数面：材料齐时 uuid 有交集判红、无交集不判；两者都无材料才看名字', () => {
  const tasks = [{ id: 'TASK-9', owner: 'dev-a' } as unknown as TaskCard]
  const claimed = new Map<string, string[]>([['TASK-9', ['uuid-1']]])
  const review = { id: 'REV-9', taskId: 'TASK-9', reviewer: 'any-name', verdict: 'pass' as const, findings: [], at: '', sessionId: 'uuid-1' }
  assert.equal(independenceViolations([review], tasks, claimed).length, 1, '同 uuid ⇒ 判红（名字无关）')
  assert.equal(independenceViolations([{ ...review, sessionId: 'uuid-2' }], tasks, claimed).length, 0, '不同 uuid ⇒ 不判（哪怕同名）')
  assert.equal(independenceViolations([{ ...review, reviewer: 'dev-a', sessionId: 'uuid-2' }], tasks, claimed).length, 0, '不同 uuid + 同名 ⇒ 仍不判（名字不参与）')
  assert.equal(independenceViolations([{ ...review, sessionId: undefined }], tasks).length, 0, '没有材料 ⇒ 不猜（默认空账 ⇒ 走名字口径，这里名字不同）')
  assert.equal(independenceViolations([{ ...review, reviewer: 'dev-a', sessionId: undefined }], tasks).length, 1, '没有材料 + 名字相同 ⇒ 旧口径判红')
})

test('M172-05 TC-125：真账评审**全部**带会话 uuid（名字不参与），C-52 判红只点名那两条', () => {
  // 真台账（仓库自己的 `.sdo/`）——只读：这条读数的作用是"口径覆盖到存量了吗"，不是再造一个夹具
  const repo = fileURLToPath(new URL('../../', import.meta.url))
  const realOffice = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  realOffice.noteSession('m172-real', repo)
  const reviews = listReviews(realOffice.storeFor(repo))
  assert.ok(reviews.length >= 50, `夹具前提：真台账里应有成规模的评审（实际 ${reviews.length} 条）`)

  // ① 覆盖率：**43/43 … 71/71** 那种全量，不是"抽样几条看看"（少一条说明还有降级路径在跑）
  const missing = reviews.filter((item) => String(item.sessionId ?? '').trim() === '').map((item) => item.id)
  assert.deepEqual(missing, [], `uuid 口径必须覆盖**全部** ${reviews.length} 条评审（无会话材料的：${missing.join(' ') || '（无）'}）`)

  // ② 出口：真账上被判红的只有这两条（都是"同一会话自评"）——台账新增同会话评审时必须重新确认这条读数
  const violations = realOffice.reviewViolations({ sessionId: 'm172-real', cwd: repo })
  assert.deepEqual(
    violations.map((item) => item.reviewId),
    ['REV-055', 'REV-068'],
    `真账的独立性判红必须恰好这两条（实际：${violations.map((item) => item.reviewId).join(' ') || '（无）'}）`,
  )
  for (const item of violations) {
    assert.match(item.detail, /同一个会话/u, `判红必须走 uuid 口径（不是名字）：${item.detail}`)
    assert.match(item.detail, /session-/u, '判词里要点名会话 uuid（可核对）')
  }

  // **判据面同源**不在这条里验：真账上跑 `evaluate('G6')` 要 5 秒（C-57 回归整表 + 六条准出准则），
  // 那是集成面的活；C-52 与出口共用 `independenceViolations` 这条已由 M172-01 ③ 在夹具上钉住。
})
