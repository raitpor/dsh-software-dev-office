/**
 * M90：**签字审核单的受审载荷与指纹**（2026-10-12 用户裁定，方案 3）。
 *
 * 背景（dsh-neuro-mimesis 会话的抱怨，逐字）："签字弹窗与 `sdo_render target=srs` 的产物
 * **都不含审查载荷** —— 需求清单只有正文、没有红队问答、没有风险台账、没有门禁判定。
 * 签字人看不到要审什么，**只能盲签**。"
 *
 * 用户的整改口径（两条硬约束）：
 *   ① **真源仍是 `.sdo`**：审核单只是**渲染快照**（内联正文，供人逐条判断"模型理解得对不对"）；
 *   ② **每次生成审核文档要对应指纹，真源变化审核文档失效** —— 签字前必须机械核对，
 *      核对不上就**拒签**，而且要**点名哪一条变了**（不许只报一句"已失效"）。
 *
 * 本文件守的就是这两条 + 一条"不许漏字段"（漏字段就是漏审）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { t } from '../src/domain/i18n.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
// 工具面的**最小形状**（与 m86 同款）：只用到 `parameters` 与 `execute(args, { agent })`
interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m90/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>

// `sessionId` 在宿主类型里带品牌；夹具按字面量构造后显式转换（与其它用例同款）
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

/** 真源里的叶子键（**所有**键路径的末段）—— 用来机械检查"渲染有没有漏字段"。 */
function leafKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item) => leafKeys(item))
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    item !== null && typeof item === 'object' ? leafKeys(item) : [key],
  )
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  // 宿主类型里的 `sessionId` 是品牌字符串：夹具先按字面量构造、再当 `unknown` 交给工具
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

const reviewDoc = (gate: string): string =>
  readFileSync(join(WORKSPACE, '.sdo', 'evidence', 'sign-reviews', `${gate}.md`), 'utf8')
const reviewRecord = (gate: string): { hash: string; collections: string[]; items: unknown[] } =>
  JSON.parse(readFileSync(join(WORKSPACE, '.sdo', 'evidence', 'sign-reviews', `${gate}.json`), 'utf8')) as {
    hash: string
    collections: string[]
    items: unknown[]
  }

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M90 审核单', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['审核单受审载荷'],
    scopeOut: ['自动签字'],
    metricsSuccess: ['签字人能看到逐条正文'],
    glossary: { 受审载荷: '签字前要通读的真源正文' },
  })
  office.capture(call, {
    title: '签字前必须能逐条看到受审载荷',
    statement: '系统须在签字卡片与右侧边栏内联受审载荷正文；缺任一条即视为盲签',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.capture(call, {
    title: '真源变化后审核单必须失效',
    statement: '审核单生成后真源若变化，签字必须被拒绝，并点名变化的条目',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.logRisk(call, {
    title: '审核单体积过大影响可读性',
    level: 'medium',
    probability: 'medium',
    impact: '签字人可能不读完',
    mitigation: '按集合分段并给条数，正文不截断',
    owner: '业务方',
  })

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
  services['tools'] = { register: (tool: ToolDefinition): (() => void) => { tools.push(tool); return () => {} } }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// ————————————————————— ① 载荷逐条内联：条数机械对账 + 不许漏字段 —————————————————————

test('M90-01 审核单内联受审载荷：条数必须与台账文件数机械一致，且逐条正文不许漏字段', () => {
  const review = office.signReview(call, 'G2')
  const doc = reviewDoc('G2')
  const record = reviewRecord('G2')
  const store = office.storeFor(WORKSPACE)

  assert.equal(review.record.hash, record.hash, '返回值里的指纹必须与落盘记录一致')
  assert.ok(review.record.seq >= 0, '必须记下生成时的 journal 序号')

  // **条数机械对账**：文档里报的条数 == 台账里的文件数（漏列即红）
  for (const collection of record.collections) {
    const onDisk = store.listNames(collection).filter((name) => /\.ya?ml$/u.test(name)).length
    assert.ok(
      doc.includes(`（${onDisk} 条）`) || doc.includes(`(${onDisk} items)`),
      `集合 ${collection} 的条数必须与本目录文件数一致（${onDisk}）：\n${doc.slice(0, 400)}`,
    )
    assert.equal(
      record.items.filter((item) => (item as { collection: string }).collection === collection).length,
      onDisk,
      `集合 ${collection} 的逐条索引条数必须等于台账文件数`,
    )
  }

  // **不许漏字段**：拿一条需求的真源叶子键，逐个必须在渲染结果里出现
  const names = store.listNames('requirements').sort()
  const first = store.readYaml<Record<string, unknown>>('requirements', names[0] ?? '')
  const keys = [...new Set(leafKeys(first))]
  assert.ok(keys.length >= 5, `夹具需求应当有足够多的字段：${keys.join(',')}`)
  for (const key of keys) {
    assert.ok(doc.includes(`**${key}**`), `字段 ${key} 必须出现在审核单里（漏字段就是漏审）`)
  }
  // id 也要点名（每条一段）
  assert.ok(doc.includes('#### REQ-001'), '每条必须有独立小节以便逐条判断')
  // 源路径要能追回去
  assert.ok(doc.includes('requirements/REQ-001.yml'), '每条必须给出源文件路径')
})

// ————————————————————— ② 指纹幂等 + 内容一变换指纹 —————————————————————

test('M90-02 指纹：同内容两次生成必须相同；真源改一个字就必须不同', () => {
  const first = office.signReview(call, 'G2').record.hash
  const second = office.signReview(call, 'G2').record.hash
  assert.equal(second, first, '同一份真源两次生成的指纹必须一致（否则签字永远对不上）')

  const store = office.storeFor(WORKSPACE)
  const raw = store.readYaml<{ requirement: Record<string, unknown> }>('requirements', 'REQ-001.yml')
  assert.ok(raw !== undefined, '夹具里应当有 REQ-001')
  store.writeYaml(['requirements', 'REQ-001.yml'], {
    requirement: { ...raw.requirement, title: `${String(raw.requirement['title'])}（改了一个字）` },
  })
  const third = office.signReview(call, 'G2').record.hash
  assert.notEqual(third, first, '真源变了指纹必须变')
})

// ————————————————————— ③ 真源变化 ⇒ 拒签 + 点名差异 + 不落签字 —————————————————————

test('M90-03 真源变了之后签字必须被拒：回执点名变化条目，且不落任何签字事件', () => {
  office.signReview(call, 'G2')
  const store = office.storeFor(WORKSPACE)
  const raw = store.readYaml<{ requirement: Record<string, unknown> }>('requirements', 'REQ-002.yml')
  assert.ok(raw !== undefined)
  store.writeYaml(['requirements', 'REQ-002.yml'], {
    requirement: { ...raw.requirement, statement: '被改写的陈述（模拟签字前真源变化）' },
  })

  const receipt = office.signReviewDrift(call, 'G2', office.signReviewRecord(call, 'G2') ?? { gate: '', at: '', seq: 0, hash: '', collections: [], items: [] })
  assert.equal(receipt.length, 1, `必须恰好点名一条变化：${receipt.join('；')}`)
  assert.match(receipt[0] ?? '', /REQ-002/u, '必须点名**哪一条**变了')
  assert.match(receipt[0] ?? '', /内容已变/u, '必须说明是内容变化，而不是笼统的失效')
})

test('M90-04 无审核单 ⇒ 拒签（不许盲签），且工具层不落签字事件', async () => {
  const journal = office.journalFor(WORKSPACE)
  const before = journal.read().events.filter((event) => event.type === 'gate/signed').length
  const receipt = await callTool('sdo_gate', {
    action: 'sign',
    gate: 'G2',
    channel: 'statement',
    quote: '我确认需求基线可以冻结',
    approvedBy: '张三',
  })
  assert.match(receipt, /还没有生成过/u, `必须明确说明"没有审核单"：${receipt}`)
  const after = journal.read().events.filter((event) => event.type === 'gate/signed').length
  assert.equal(after, before, '无审核单时不许落签字')
})

test('M90-05 真源变了之后再签 ⇒ 工具层拒签并点名差异，且不落签字事件', async () => {
  office.signReview(call, 'G2')
  const store = office.storeFor(WORKSPACE)
  const raw = store.readYaml<{ requirement: Record<string, unknown> }>('requirements', 'REQ-001.yml')
  assert.ok(raw !== undefined)
  store.writeYaml(['requirements', 'REQ-001.yml'], {
    requirement: { ...raw.requirement, title: '签字前被改掉的标题' },
  })
  const journal = office.journalFor(WORKSPACE)
  const before = journal.read().events.filter((event) => event.type === 'gate/signed').length

  const receipt = await callTool('sdo_gate', {
    action: 'sign',
    gate: 'G2',
    channel: 'statement',
    quote: '我确认需求基线可以冻结',
    approvedBy: '张三',
  })
  assert.match(receipt, /审核单已失效/u, `必须拒签并说明失效：${receipt}`)
  assert.match(receipt, /REQ-001/u, '必须点名变化条目')
  assert.equal(
    journal.read().events.filter((event) => event.type === 'gate/signed').length,
    before,
    '审核单失效时不许落签字',
  )
})

test('M90-06 question 通道：用户作答期间真源变了 ⇒ 拒签（审核单的"牙齿"就在这里）', async () => {
  const signLabel = t('uiSign.signOption')
  services['userQuestions'] = {
    ask: async (): Promise<unknown> => {
      // 模拟"用户还在读卡片时，别处把真源改了"
      const store = office.storeFor(WORKSPACE)
      const raw = store.readYaml<{ requirement: Record<string, unknown> }>('requirements', 'REQ-001.yml')
      if (raw !== undefined) {
        store.writeYaml(['requirements', 'REQ-001.yml'], {
          requirement: { ...raw.requirement, statement: '作答期间被改写的陈述' },
        })
      }
      return { answers: [{ id: 'sdo-gate-sign', selected: [signLabel] }] }
    },
  }
  const journal = office.journalFor(WORKSPACE)
  const receipt = await callTool('sdo_gate', { action: 'sign', gate: 'G2', channel: 'question' })
  assert.match(receipt, /审核单已失效/u, `作答期间真源变了必须拒签：${receipt}`)
  assert.equal(
    journal.read().events.filter((event) => event.type === 'gate/signed').length,
    0,
    '不许把"过期审核单上的签字"落进台账',
  )
})
