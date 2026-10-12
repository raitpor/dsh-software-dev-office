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
import { gateLabel, t } from '../src/domain/i18n.js'
import { SoftwareDevOffice } from '../src/office.js'
import { titleFieldsOf } from '../src/domain/reviewView.js'
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

/**
 * 真源里的叶子键 —— 用来机械检查"渲染有没有漏字段"。
 *
 * `skip` 命中的键**整棵子树跳过**：那些字段是**有意不写进审核单**的（时间戳/内部评分明细…），
 * 它们的子键自然也不该被要求出现。
 */
function leafKeys(value: unknown, skip: (key: string) => boolean): string[] {
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item) => leafKeys(item, skip))
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    skip(key) ? [] : item !== null && typeof item === 'object' ? leafKeys(item, skip) : [key],
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
    rationale: '签字人只有看到逐条正文才能判断模型理解得对不对',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.capture(call, {
    title: '真源变化后审核单必须失效',
    statement: '审核单生成后真源若变化，签字必须被拒绝，并点名变化的条目',
    rationale: '背书的必须是同一个版本，否则签字没有意义',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call, {
    id: 'REQ-001',
    addAcceptance: [
      { id: 'AC-001', given: '插件已加载', when: '签字人打开签字卡片', then: '卡片显示摘要且右栏显示逐条正文' },
      { id: 'AC-002', given: '真源在生成之后被改动', when: '用户作答签字', then: '拒签并在回执里点名变化的条目' },
    ],
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

  // **人读形态**（2026-10-12 用户体验反馈后）：标题行必须带名称、字段必须用**人话标签**、
  // 内部字段不许出现。这三条正是"表达不清"的正面修复。
  assert.match(doc, /#### REQ-001　/u, '每条必须有 `#### <代号>　<名称>` 标题行（不能只写代号）')
  assert.ok(
    doc.includes('签字前必须能逐条看到受审载荷'),
    '标题行必须写出这条到底是什么（用户原话：只写 REQ-12 却不说内容是什么）',
  )
  assert.ok(doc.includes('**陈述**'), '长文字段必须用**人话标签**（`陈述`），不是 YAML 键名')
  assert.ok(doc.includes('**理由**'), '理由字段同样要用标签')
  assert.ok(doc.includes('| 编号 | 给定 | 当 | 则 |'), '验收标准必须渲染成表格（参考件的做法）')
  assert.ok(doc.includes('歧义评分'), '歧义评分要压成一行读数')
  // **不许把 YAML 键名当标签**（用户抱怨的主体就是这些原始键名）
  for (const raw of ['**statement**', '**title**', '**id**', '**requirement**', '**rationale**', '**acceptance**']) {
    assert.equal(doc.includes(raw), false, `不许把原始键名当标签：${raw}`)
  }
  // **与审核无关的字段不许占篇幅**（真源里仍在）
  for (const noisy of ['**at**', 'createdAt', 'updatedAt', 'modelDimensions']) {
    assert.equal(doc.includes(noisy), false, `与审核无关的字段不该出现：${noisy}`)
  }
  // 源路径要能追回去（短指纹在同一条上）
  assert.ok(doc.includes('requirements/REQ-001.yml'), '每条必须给出源文件路径')

  // **有意义字段不许漏**：忽略清单之外的叶子键，其**人话标签**必须出现
  const ignored = new Set([
    'at', 'createdAt', 'updatedAt', 'askedAt', 'answeredAt', 'answeredBy', 'authorizedByUser',
    'version', 'baseline', 'revision', 'contentHash', 'basis', 'basisSource', 'basisChecked',
    'recommendationFromModel', 'prototype', 'open', 'dimensions', 'score', 'angles', 'modelDimensions',
    'contentId', 'id',
  ])
  const names = store.listNames('requirements').sort()
  const first = store.readYaml<Record<string, unknown>>('requirements', names[0] ?? '')
  // 标题字段的内容写在 `#### <代号>　<名称>` 标题行里（上面已断言），不再要求出现字段标签
  for (const key of titleFieldsOf('requirements')) ignored.add(key)
  const keys = [...new Set(leafKeys(first, (key) => ignored.has(key)))]
  assert.ok(keys.length >= 4, `夹具需求应当有足够多的字段：${keys.join(',')}`)
  for (const key of keys) {
    const label = t(`uiSignField.${key}`, key)
    assert.ok(
      doc.includes(label),
      `字段 ${key} 的标签「${label}」必须出现在审核单里（漏字段就是漏审）`,
    )
  }
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

test('M90-07 DEF-002：门禁名传中文全名，不得被误判成「没有审核单 / 审核单已失效」', async () => {
  // 真机场景：工具说明与用户都用中文全名（`需求基线门禁（G2）`），而落盘用的是规范名 `G2`。
  const officeReview = office.signReview(call, 'G2')
  const record = office.signReviewRecord(call, 'G2')
  assert.ok(record !== undefined, '先得有记录')
  assert.equal(record.hash, officeReview.record.hash)

  // ① 中文全名要能解析到**同一份**记录（否则会被判成"没有审核单"）
  for (const alias of [gateLabel('G2'), `${gateLabel('G2')}（G2）`]) {
    const byAlias = office.signReviewRecord(call, alias)
    assert.equal(byAlias?.hash, record.hash, `别名「${alias}」必须解析到同一份记录`)
  }

  // ② 真源没变时，用别名重算指纹不得产出**虚假差异**（DEF-002 的正面判据）
  for (const alias of [gateLabel('G2'), `${gateLabel('G2')}（G2）`, 'G2']) {
    assert.deepEqual(office.signReviewDrift(call, alias, record), [], `别名「${alias}」不得报失效`)
  }

  // ③ 工具层：用中文全名走 statement 签字，不得被"没有审核单/已失效"挡住
  const receipt = await callTool('sdo_gate', {
    action: 'sign',
    gate: gateLabel('G2'),
    channel: 'statement',
    quote: '我确认需求基线可以冻结',
    approvedBy: '张三',
  })
  assert.equal(/没有生成过/u.test(receipt), false, `中文全名不得被判"没有审核单"：${receipt.slice(0, 200)}`)
  assert.equal(/审核单已失效/u.test(receipt), false, `中文全名不得被判"审核单已失效"：${receipt.slice(0, 200)}`)
})
