/**
 * **增量 170：DEF-048（major，第三批 §3.16）—— 未决项必须带"当前仍失败的复现命令"**。
 *
 * 修前现盘：一条"待修"主张（`changes-requested` / `reject`）**不带复现命令**也被原样接受，
 * 落盘键只有 `taskId/reviewer/verdict/findings/id/at` ⇒ 已收敛的问题被记成未决，后人照着去修
 * 一个不存在的缺口；而且门禁不会变红、读者也无从复核。既有机制里唯一相近的是 `verify-review` 的
 * `proof` 必填，但它只在 `blockingReview` 上消费。
 *
 * 修法（**唯一出口** `reviewReproIssue`，三处写入路径共用）：非 `pass` 的评审必须**二选一** ——
 * `repro`（一条当前仍然失败的复现命令）或 `unreproducible`（显式声明无法复现 + 为什么）；
 * 两个都给 ⇒ 可读拒绝（读者判不出哪个作准）；`pass` 不受约束。
 * 路径：`recordReview`（最低层，违反即抛）/ 工具面 `sdo_review action=record`（转可读回执）/
 * `appendReviewFindings`（第三条写入路径，可读拒绝）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config } from '../src/config.js'
import { apply } from '../src/index.js'
import { createOfficeTools } from '../src/interface/tools.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'
import { realLedgerSkip } from './support/real-ledger.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m170/', import.meta.url))

interface ToolDefinition {
  name: string
  parameters: { properties?: Record<string, unknown> }
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}

let store: SdoStore
let tools: ToolDefinition[]

/** 评审目录的逐字节读数（零写盘断言用）。 */
function reviewsFootprint(): string[] {
  const dir = join(BASE, '.sdo', 'reviews')
  try {
    return readdirSync(dir).sort().map((name) => name + ':' + readFileSync(join(dir, name), 'utf8'))
  } catch {
    return []
  }
}

function harness(): { callTool: (name: string, args: Record<string, unknown>, sessionId?: string) => Promise<string> } {
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } } }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as SdoConfig))
  return {
    async callTool(name, args, sessionId = 'child-rev') {
      const tool = tools.find((item) => item.name === name)
      assert.ok(tool !== undefined, `工具面缺少 ${name}`)
      const properties = tool.parameters.properties ?? {}
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
      const exec = { agent: { id: sessionId, session: { header: { id: sessionId, cwd: BASE, delegationDepth: 1, parentSession: 'cockpit' } } } }
      return String(await tool.execute(filtered, exec))
    },
  }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  void new Journal(store)
  const task: TaskCard = {
    id: 'TASK-001', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', 'TASK-001.yml'], { task })
  tools = []
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M170-01 三态（record 面）：带 repro ⇒ 收；带 unreproducible ⇒ 收；都没有 / 两个都给 ⇒ 可读拒绝且**零写盘**', async () => {
  const h = harness()
  const before = reviewsFootprint()

  // ① 都没有 ⇒ 可读拒绝（点名两种出路），且**零写盘**
  const missing = await h.callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'changes-requested', findings: '["f1：并发下会串号"]',
  })
  assert.match(missing, /复现命令/u, `拒因必须点名"要一条复现命令"：${missing.slice(0, 200)}`)
  assert.match(missing, /unreproducible/u, '拒因必须给出另一条出路（显式声明无法复现）')
  assert.match(missing, /没有写入/u, '拒因必须说清零写盘')
  assert.deepEqual(reviewsFootprint(), before, '被拒时**一条评审都不许落盘**')

  // ② 两个都给 ⇒ 同样可读拒绝（读者判不出哪个作准）
  const both = await h.callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'reject',
    repro: 'npm test（当前仍失败）', unreproducible: '环境已拆，无法复现',
    findings: '["f1"]',
  })
  assert.match(both, /只能给一个/u, `两个都给必须被拒：${both.slice(0, 200)}`)
  assert.deepEqual(reviewsFootprint(), before, '被拒时零写盘')

  // ③ 给 repro ⇒ 收，且复现命令**真的落进记录**（可离线读回）
  const viaRepro = await h.callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'changes-requested',
    repro: 'node --test test/m170.test.js（当前仍失败）',
    findings: '["f1：并发下会串号"]',
  }, 'child-rev-1')
  assert.match(viaRepro, /REV-001/u, `带复现命令必须收下：${viaRepro.slice(0, 200)}`)
  const landed = readFileSync(join(BASE, '.sdo', 'reviews', 'REV-001.yml'), 'utf8')
  assert.match(landed, /当前仍失败/u, '复现命令必须写进评审记录（不是只在回执里）')

  // ④ 给 unreproducible ⇒ 收（另一条出路）
  const viaUnrepro = await h.callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'rev-c', verdict: 'reject',
    unreproducible: '环境已拆：CI runner 退役，无法复现',
    findings: '["f2"]',
  }, 'child-rev-2')
  assert.match(viaUnrepro, /REV-002/u, `带"无法复现"声明必须收下：${viaUnrepro.slice(0, 200)}`)
  assert.match(readFileSync(join(BASE, '.sdo', 'reviews', 'REV-002.yml'), 'utf8'), /无法复现/u, '声明必须落盘')
})

test('M170-02 反例（不放宽）：`pass` 评审不受这条约束；真源事件里也留痕', async () => {
  const h = harness()
  const ok = await h.callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: '["无发现"]',
  })
  assert.match(ok, /REV-001/u, `pass 评审不该被这条判据拦（它没有"未决缺口"要复现）：${ok.slice(0, 200)}`)
  // **反例（判据没被放宽）**：非 pass 仍然拦
  const still = await h.callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'changes-requested', findings: '["x"]',
  }, 'child-rev-9')
  assert.match(still, /没有写入/u, '非 pass 且没复现出路 ⇒ 仍旧拒绝（这条判据没被 pass 那条冲掉）')
  // 真源事件里也带两条出路（离线可读）
  const events = new Journal(store).read().events.filter((event) => event.type === 'review/recorded')
  assert.equal(events.length, 1, '只该有一条 review/recorded（被拒的两条都没写）')
})

test('M170-03 append 面（第三条写入路径）：存量非 pass 评审缺出路 ⇒ 补录被拒；补上 ⇒ 收且落盘', async () => {
  const h = harness()
  // 造一条**存量**非 pass 评审（直接写盘，模拟修前留下的记录）
  const legacy = { id: 'REV-900', taskId: 'TASK-001', reviewer: 'rev-old', verdict: 'changes-requested', findings: ['历史发现一'], at: '' }
  store.writeYaml(['reviews', 'REV-900.yml'], { review: legacy })

  const refused = await h.callTool('sdo_review', { action: 'append', id: 'REV-900', findings: '["历史发现二"]' })
  assert.match(refused, /复现命令/u, `补录也必须给复现出路：${refused.slice(0, 200)}`)
  assert.deepEqual(
    (store.readYaml<{ review: { findings: string[] } }>('reviews', 'REV-900.yml')?.review.findings ?? []),
    ['历史发现一'],
    '被拒时不许改动既有正文',
  )

  const accepted = await h.callTool('sdo_review', {
    action: 'append', id: 'REV-900', findings: '["历史发现二"]', repro: 'npm test（当前仍失败）',
  })
  assert.match(accepted, /REV-900/u, `补上复现命令后必须收下：${accepted.slice(0, 200)}`)
  const after = store.readYaml<{ review: { findings: string[]; repro?: string } }>('reviews', 'REV-900.yml')?.review
  assert.deepEqual(after?.findings, ['历史发现一', '历史发现二'], '正文按原顺序追加')
  assert.equal(after?.repro, 'npm test（当前仍失败）', '补录带来的复现出路要落进记录')
})

test('M170-04 结构：工具面两个参数都注册（否则模型根本传不进来），且三处写入路径共用同一份判据', () => {
  const defs = createOfficeTools({} as never) as unknown as { name: string; parameters: { properties: Record<string, unknown> } }[]
  const review = defs.find((item) => item.name === 'sdo_review')
  assert.ok(review !== undefined, '前置：sdo_review 必须注册')
  assert.ok(review.parameters.properties['repro'] !== undefined, '注册面必须有 repro')
  assert.ok(review.parameters.properties['unreproducible'] !== undefined, '注册面必须有 unreproducible')
  const records = readFileSync(join(BASE, '..', '..', '..', 'src', 'domain', 'records.ts'), 'utf8')
  const collab = readFileSync(join(BASE, '..', '..', '..', 'src', 'domain', 'collab.ts'), 'utf8')
  const office = readFileSync(join(BASE, '..', '..', '..', 'src', 'office.ts'), 'utf8')
  assert.match(records, /export function reviewReproIssue/u, '唯一出口必须在 records.ts 定义')
  for (const [name, src] of [['records.ts', records], ['collab.ts', collab], ['office.ts', office]] as const) {
    assert.equal(src.includes('reviewReproIssue('), true, `${name} 必须复用唯一出口（不许另写一套）`)
  }
})

test('M170-05 TC-130：两条拒绝的**码**（不是只看文案）+ 真账 18 条存量**读侧不追溯、不抛错**', realLedgerSkip() ?? {}, async () => {
  const { reviewReproIssue } = await import('../src/domain/records.js')
  // ① 码是机器可判的那一层：文案会改，码不该改（TC-130 原先只查文案）
  assert.equal(reviewReproIssue({ verdict: 'changes-requested' })?.code, 'repro-missing', '两手空空 ⇒ repro-missing')
  assert.equal(
    reviewReproIssue({ verdict: 'reject', repro: 'npm test（仍失败）', unreproducible: '环境已拆' })?.code,
    'repro-ambiguous',
    '两条出路都给 ⇒ repro-ambiguous（读者判不出哪个作准）',
  )
  assert.equal(reviewReproIssue({ verdict: 'pass' }), undefined, 'pass 不受这条约束（反例）')
  assert.equal(reviewReproIssue({ verdict: 'reject', repro: 'npm test' })?.code, undefined, '只给 repro ⇒ 通过')

  // ② 真账读数：存量非 pass 评审里"两条出路都没有"的**恰 18 条**（写侧才有这条约束，读侧不得追溯、不得抛）
  const { Config, resolveSettings } = await import('../src/config.js')
  const { SoftwareDevOffice } = await import('../src/office.js')
  const repo = fileURLToPath(new URL('../../', import.meta.url))
  const real = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  real.noteSession('m170-real', repo)
  const reviews = real.reviews({ sessionId: 'm170-real', cwd: repo })
  const legacy = reviews.filter(
    (review) => review.verdict !== 'pass'
      && String(review.repro ?? '').trim() === ''
      && String(review.unreproducible ?? '').trim() === '',
  )
  assert.equal(legacy.length, 18, `真账存量必须是 18 条旧格式非 pass 评审（实际 ${legacy.length}；台账变化时要重新确认这条读数）`)
  // 读侧不抛错，且这些记录仍然是**可读的原始记录**（`repro` / `unreproducible` 都如实为空，不被补写）
  for (const review of legacy) {
    assert.equal(String(review.repro ?? ''), '', `${review.id} 的 repro 不许被读侧补写`)
    assert.equal(String(review.unreproducible ?? ''), '', `${review.id} 的 unreproducible 不许被读侧补写`)
    assert.equal(reviewReproIssue({ verdict: review.verdict, repro: review.repro, unreproducible: review.unreproducible })?.code, 'repro-missing',
      `${review.id} 若今天重记会被拒 —— 但它**已经在册**，读侧不许因此判红或抛错`)
  }
})
