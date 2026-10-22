/**
 * **增量 151：追加/补录类记录的条号自洽（DEF-072，§3E 族 5，major）**。
 *
 * 缺陷原文（三份 re-verify 的现盘读数）：`src/` 里 `originalIndex` / `originalTotal` / `findingsComplete`
 * **0 命中**；`appendReviewFindings` 的校验只有 `no-review`/`tampered`/`empty-findings`/`bad-findings` 四条，
 * 随后 `const fromIndex = findings.length` —— 序号是**自算**的，调用方"补的是原文第几条"的**声明**没地方写；
 * `sdo_review` 的 schema 也没有这三个参数 ⇒ **条号自洽校验 0 条**。后果有现盘物证：
 * `.sdo/reviews/REV-047.yml` 标题写「原第 4 条」正文写「原第 2 条」，`REV-053.yml` 标题写「原第 3 条 片段 1/2」正文写「原第 1 条」。
 *
 * **先钉红**（修前 `lib/` 产物上跑，可复算）：
 *   ```
 *   lib/src/ 里 originalIndex / originalTotal / findingsComplete 命中 = 0 / 0 / 0
 *   行为：appendReviewFindings({findings:[…], originalIndex:4, originalTotal:3})（超界+跳号）⇒ ok = true
 *        事件里 originalIndex 在册 = false ；记录里 originalTotal 在册 = false
 *   ```
 *
 * **修法**：让"原第 k 条 / 原共 m 条"成为**可校验的声明**（语言无关：只认数字，不解析标题散文）：
 *   · `Review.originalTotal` 落记录；事件里补记 `originalIndex` / `originalTotal`；
 *   · 写入前五条**可读拒绝**（全部零写盘）：声明不成对 / 非正整数 / **超界** / **重号** / **跳号**；
 *   · `sdo_review action=append` 暴露 `originalIndex` / `originalTotal` 两个参数（schema + 类型 + execute + 透传四处）。
 * 口径：**不声明 = 维持旧口径**（存量记录与旧调用方不受影响，历史不重写）；已补录区间从 **append-only 事件**读回，
 * 所以"重号/跳号"跨多次调用也成立。⚠️ 与 TASK-108 的**封印前缀** `sealedFindings` 无关：本卡不动
 * `reviewContentHash` 的覆盖范围（既有 54 条评审的指纹不受影响）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync as readFileSyncStrict, readdirSync as readdirSyncStrict, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { appendReviewFindings } from '../src/domain/collab.js'
import { listReviews, reviewContentHash } from '../src/domain/records.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { SdoStore } from '../src/infra/store.js'
import { realLedgerSkip } from './support/real-ledger.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m151/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>
let store: SdoStore
let journal: Journal
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

/** 一条**未追加过**的评审（正文 2 条，模拟"补录来源"） */
function seedReview(id = 'REV-001', findings = ['原第 1 条：a', '原第 2 条：b']): void {
  store.writeYaml(['reviews', `${id}.yml`], {
    review: { id, taskId: 'TASK-001', reviewer: 'r', verdict: 'pass', findings, sealedFindings: findings.length, at: 'x' },
  })
}

const findingCount = (id = 'REV-001'): number => listReviews(store).find((item) => item.id === id)?.findings.length ?? -1

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M151 条号自洽', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['追加记录的条号自洽'],
    scopeOut: ['改写既有评审正文'],
    metricsSuccess: ['补录时声明原第几条并当场校验'],
    glossary: { 补录: '把来源评审的发现项追加到既有评审' },
  })
  store = office.storeFor(WORKSPACE)
  journal = new Journal(store)
  tools = []
  services = {}
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
  })
  services['tools'] = { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M151-01 正例：按声明的原条号补录 ⇒ 落盘 + 事件留痕 + 结果回显（修前声明被静默丢弃）', () => {
  seedReview()
  const out = appendReviewFindings(store, journal, {
    reviewId: 'REV-001',
    findings: ['原第 3 条：c', '原第 4 条：d'],
    originalIndex: 3,
    originalTotal: 4,
  })
  assert.equal(out.ok, true, `合法补录必须通过：${JSON.stringify(out).slice(0, 200)}`)
  assert.equal(out.ok ? out.originalIndex : undefined, 3, '结果要回显声明的原条号')
  assert.equal(listReviews(store)[0]?.originalTotal, 4, '记录里要落 `originalTotal`（可事后复核）')
  const event = journal.read().events.filter((item) => item.type === 'review/appended').pop()
  assert.equal(Number(event?.data.originalIndex), 3, 'append-only 事件里必须有原条号（跨次调用判重号/跳号靠它）')
  assert.equal(findingCount(), 4, '发现项接在尾部')
})

test('M151-02 超界：补到原文条数之外 ⇒ 可读拒绝且**零写盘**', () => {
  seedReview()
  const out = appendReviewFindings(store, journal, {
    reviewId: 'REV-001',
    findings: ['原第 4 条：c', '原第 5 条：d'],
    originalIndex: 4,
    originalTotal: 4,
  })
  assert.equal(out.ok, false, '末条 5 > 共 4 ⇒ 必须拒')
  assert.equal(out.ok ? '' : out.code, 'original-overflow')
  assert.match(out.ok ? '' : out.detail, /第 5 条/u, `要点名超界的那条：${out.ok ? '' : out.detail}`)
  assert.equal(findingCount(), 2, '被拒时不得写盘')
  assert.equal(journal.read().events.filter((item) => item.type === 'review/appended').length, 0, '被拒时不得留追加事件')
})

test('M151-03 重号：同一段原文被补两遍 ⇒ 拒绝并点名已补区间（REV-047 那种形状写不进去了）', () => {
  seedReview()
  appendReviewFindings(store, journal, { reviewId: 'REV-001', findings: ['原第 3 条：c'], originalIndex: 3, originalTotal: 4 })
  const again = appendReviewFindings(store, journal, { reviewId: 'REV-001', findings: ['原第 3 条（另一份抄本）'], originalIndex: 3, originalTotal: 4 })
  assert.equal(again.ok, false, '重号必须拒')
  assert.equal(again.ok ? '' : again.code, 'original-overlap')
  assert.match(again.ok ? '' : again.detail, /3-3/u, '要点名已补过的区间')
  assert.equal(findingCount(), 3, '被拒时不得写盘')
})

test('M151-04 跳号：跳过中间几条 ⇒ 拒绝并告诉它该从第几条起（残缺不许读成"原文只有这些"）', () => {
  seedReview()
  appendReviewFindings(store, journal, { reviewId: 'REV-001', findings: ['原第 3 条：c', '原第 4 条：d'], originalIndex: 3, originalTotal: 6 })
  const skipped = appendReviewFindings(store, journal, { reviewId: 'REV-001', findings: ['原第 6 条：f'], originalIndex: 6, originalTotal: 6 })
  assert.equal(skipped.ok, false, '跳号必须拒')
  assert.equal(skipped.ok ? '' : skipped.code, 'original-gap')
  assert.match(skipped.ok ? '' : skipped.detail, /第 5 条|第 6 条/u, '要点名缺哪几条 / 该从哪起')
  assert.equal(findingCount(), 4, '被拒时不得写盘')
})

test('M151-05 形状：声明不成对 / 非正整数 ⇒ 各自可读拒绝（零写盘）', () => {
  seedReview()
  const half = appendReviewFindings(store, journal, { reviewId: 'REV-001', findings: ['原第 3 条：c'], originalIndex: 3 })
  assert.equal(half.ok ? '' : half.code, 'original-meta-incomplete', '只给一个 ⇒ 拒（半个声明无从判定）')
  const zero = appendReviewFindings(store, journal, { reviewId: 'REV-001', findings: ['原第 0 条：c'], originalIndex: 0, originalTotal: 4 })
  assert.equal(zero.ok ? '' : zero.code, 'original-index-invalid', '0 不是 1 起的条号')
  const fractional = appendReviewFindings(store, journal, { reviewId: 'REV-001', findings: ['原第 2.5 条：c'], originalIndex: 2.5, originalTotal: 4 })
  assert.equal(fractional.ok ? '' : fractional.code, 'original-index-invalid', '非整数必须拒')
  assert.equal(findingCount(), 2, '三次被拒都不得写盘')
})

test('M151-06 存量口径 + 工具面：不声明照旧可追加；真实注册的工具面能传这两个参数并落盘', async () => {
  seedReview()
  // ① 不声明 = 旧口径（存量记录与旧调用方不受影响）
  const plain = appendReviewFindings(store, journal, { reviewId: 'REV-001', findings: ['未声明条号的补录'] })
  assert.equal(plain.ok, true, '不声明必须照旧通过（存量不追溯）')
  assert.equal(listReviews(store)[0]?.originalTotal, undefined, '没声明就不落 `originalTotal`（不假装知道原文共几条）')
  // ② 工具面（真实注册的工具）—— 四处同改的第四处在 execute 映射上。
  // 用**另一条**评审做夹具：REV-001 的正文已被上面那条无声明追加撑到 3 条，
  // 再声明"原第 3 条"会（正确地）撞上正文 ⇒ 那不是这条用例要测的东西。
  seedReview('REV-002', ['原第 1 条：x', '原第 2 条：y'])
  const receipt = await callTool('sdo_review', { action: 'append', id: 'REV-002', findings: '["原第 3 条：z"]', originalIndex: 3, originalTotal: 4 })
  assert.equal(listReviews(store).find((item) => item.id === 'REV-002')?.originalTotal, 4, `工具面传的声明必须真的落盘：${receipt.slice(0, 240)}`)
  assert.match(receipt, /3/u, '回执要能看出补的是第几条')
  const tool = tools.find((item) => item.name === 'sdo_review')
  const properties = (tool?.parameters as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {}
  assert.equal(properties['originalIndex']?.type, 'number', 'schema 必须声明 originalIndex 为数字')
  assert.equal(properties['originalTotal']?.type, 'number', 'schema 必须声明 originalTotal 为数字')
  // ③ 封印口径未被本卡改动：追加不动内容指纹的覆盖前缀
  const review = listReviews(store).find((item) => item.id === 'REV-002')
  assert.ok(review !== undefined)
  assert.equal(reviewContentHash(review), reviewContentHash({ ...review, findings: review.findings.slice(0, review.sealedFindings ?? review.findings.length) }), '封印前缀之外的内容不参与指纹（既有 54 条评审的指纹口径未变）')
})

test('M151-07 TC-147：拒绝前后评审文件**逐字节**不变（不是只看条数）；历史条号矛盾文本**不回填**', realLedgerSkip() ?? {}, async () => {
  // ① 三种拒绝（超界 / 重号 / 跳号）各跑一次，每次都做**逐字节**快照
  seedReview()
  // 目录级快照：拒绝前后 `reviews/` 的文件清单不变（新文件、临时文件都不许留）
  const listing = (): string[] => {
    try {
      return readdirSyncStrict(store.path('reviews')).sort()
    } catch {
      return []
    }
  }
  const dirBefore = listing()
  const fileOf = (id: string): string => store.path('reviews', `${id}.yml`)
  const bytes = (id: string): string => readFileSyncStrict(fileOf(id), 'utf8')

  for (const attempt of [
    { label: '超界', findings: ['原第 5 条：e'], originalIndex: 5, originalTotal: 4 },
    { label: '形状（只给一半）', findings: ['原第 3 条：c'], originalIndex: 3 },
    { label: '形状（0 起）', findings: ['原第 0 条：c'], originalIndex: 0, originalTotal: 4 },
  ] as const) {
    const fileBefore = bytes('REV-001')
    const eventsBefore = journal.read().events.length
    const out = appendReviewFindings(store, journal, { reviewId: 'REV-001', ...attempt } as never)
    assert.equal(out.ok, false, `${attempt.label} 必须被拒`)
    assert.equal(bytes('REV-001'), fileBefore, `${attempt.label} 被拒后评审文件必须**逐字节**不变（原来只比条数）`)
    assert.equal(journal.read().events.length, eventsBefore, `${attempt.label} 被拒后 journal 事件条数也不许变`)
    assert.deepEqual(listing(), dirBefore, `${attempt.label} 被拒后 reviews/ 目录逐项不变（不许留临时文件）`)
  }

  // ② 真账历史：REV-047 / REV-053 的**条号矛盾文本**保持原样（新校验只挡"再生成"，不回填历史）
  const repo = fileURLToPath(new URL('../../', import.meta.url))
  const real = listReviews(new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig))).storeFor(repo))
  for (const [id, marker] of [['REV-047', '原第 4 条】原第 2 条'], ['REV-053', '原第 3 条 片段 1/2']] as const) {
    const review = real.find((item) => item.id === id)
    assert.ok(review !== undefined, `真账里必须有 ${id}`)
    const text = (review.findings ?? []).map(String).join('\n')
    assert.ok(text.includes(marker), `${id} 的历史文本必须**逐字**保留（实际：${text.slice(0, 120)}）`)
    // 读侧不许把条号"补"进结构字段（那是回填历史，等于替人改证据）
    assert.equal((review as unknown as { originalIndex?: number }).originalIndex, undefined, `${id} 不许被读侧回填 originalIndex`)
    assert.equal((review as unknown as { originalTotal?: number }).originalTotal, undefined, `${id} 不许被读侧回填 originalTotal`)
  }
})
