import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { renderBoard } from '../src/board/render.js'
import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { describeStatus } from '../src/interface/describe.js'
import { renderStatusBlock } from '../src/interface/inject.js'
import { SoftwareDevOffice } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/office/', import.meta.url))

let workspace: string
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('session-1', workspace)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

const call = (): { sessionId: string } => ({ sessionId: 'session-1' })

test('init：建 .sdo/ 布局、写 config.yml 与真源，幂等', () => {
  const first = office.init(call(), { name: '示例项目', scopeOut: ['运维'] })
  assert.equal(first.created, true)
  assert.equal(first.project.id, 'PRJ-001')
  assert.equal(first.project.name, '示例项目')
  assert.equal(first.project.phase, 'intake')

  const sdo = join(workspace, '.sdo')
  for (const path of ['journal.jsonl', 'project.json', 'config.yml', 'requirements', 'questions', 'gates', 'evidence']) {
    assert.ok(existsSync(join(sdo, path)), `应创建 ${path}`)
  }

  // 只创建：重复 init（即使给了字段）也不改动——台账由 sdo_project 维护（设计 v0.9）
  const second = office.init(call(), { name: '别的名字' })
  assert.equal(second.created, false)
  assert.equal(second.project.name, '示例项目')
})

test('sdo_project：只写显式字段，可补齐 G2 需要的非目标与术语表', () => {
  office.init(call(), { name: '示例项目' })

  const nothing = office.updateProject(call(), {})
  assert.deepEqual(nothing.changed, [], '不给字段就不写')

  const updated = office.updateProject(call(), {
    scopeOut: ['自动调账', '财务凭证'],
    glossary: { 差异: '同一笔业务在两侧系统的不一致记录' },
    stakeholders: ['业务方', '开发'],
    metricsSuccess: ['差异识别率 ≥ 99%'],
  })
  assert.deepEqual(updated.changed.sort(), ['glossary', 'metrics', 'scope', 'stakeholders'])
  assert.deepEqual(updated.project.scope.out, ['自动调账', '财务凭证'])
  assert.equal(Object.keys(updated.project.glossary).length, 1)
  assert.deepEqual(updated.project.stakeholders.map((s) => s.id), ['STK-01', 'STK-02'])
  assert.equal(updated.project.name, '示例项目', '未给的字段不得被改')

  const events = office.journalFor(workspace).read().events.filter((event) => event.type === 'project/updated')
  assert.equal(events.length, 1, '台账变更必须留痕')

  const merged = office.updateProject(call(), { glossary: { 对账周期: 'T 日与 T-1 日' } })
  assert.equal(Object.keys(merged.project.glossary).length, 2, 'glossary 是合并而非替换')
})

test('status：阶段、门禁缺口、计数与投影来源', () => {
  office.init(call(), { name: '示例项目' })
  const status = office.status(call())
  assert.equal(status.project?.phase, 'intake')
  assert.equal(status.pendingGate, 'G0', 'intake 的出口门禁是 G0')
  assert.deepEqual(status.counts, { requirements: 0, questions: 0, openQuestions: 0, gates: 0, evidence: 0 })
  assert.equal(status.configSource, 'file')
  assert.equal(status.rebuilt, false, 'init 时已物化投影，因此这里是读缓存')
  assert.equal(status.truncated, false)

  const text = describeStatus(status, '.sdo')
  assert.match(text, /阶段：intake/u)
  assert.match(text, /门禁缺口：待判定 G0/u)
  assert.match(text, /\.sdo\/journal\.jsonl/u)
})

test('status：删掉投影后能重建（AC-006 / E2E-06）', () => {
  office.init(call(), { name: '示例项目' })
  office.status(call())
  rmSync(join(workspace, '.sdo', 'project.json'))
  const rebuilt = office.status(call())
  assert.equal(rebuilt.rebuilt, true)
  assert.equal(rebuilt.project?.name, '示例项目')
  assert.ok(existsSync(join(workspace, '.sdo', 'project.json')))
})

test('status：journal 损坏尾部 → 截断并报告（不静默）', () => {
  office.init(call(), { name: '示例项目' })
  writeFileSync(join(workspace, '.sdo', 'journal.jsonl'), '{"seq":1,"at":"x"\n', { flag: 'a' })
  const status = office.status(call())
  assert.equal(status.truncated, true)
  assert.equal(status.badLine, 2)
  assert.match(describeStatus(status, '.sdo'), /journal\.jsonl 尾部损坏/u)
})

test('未初始化：status 与状态块都给出明确下一步，不报错', () => {
  const status = office.status(call())
  assert.equal(status.project, undefined)
  assert.equal(status.pendingGate, undefined)
  assert.match(describeStatus(status, '.sdo'), /尚未初始化/u)

  const block = renderStatusBlock(status, '.sdo', 1500)
  assert.match(block, /SDO 研发办公室（尚未初始化）/u)
  assert.match(block, /sdo_init/u)
})

test('状态块：含项目行、遵守字符上限、条件行只在偏离默认时出现', () => {
  office.init(call(), { name: '示例项目' })
  const status = office.status(call())
  const block = renderStatusBlock(status, '.sdo', 1500)
  assert.match(block, /^## SDO 研发办公室/mu)
  assert.match(block, /项目：PRJ-001 示例项目/u)
  assert.doesNotMatch(block, /红队：/u, '默认状态下不该出现红队条件行')
  assert.ok(!block.includes(workspace), '不得注入绝对路径')

  const tight = renderStatusBlock(status, '.sdo', 200)
  assert.ok(tight.length <= 200, `截断后长度 ${tight.length} 应 ≤ 200`)
  assert.match(tight, /状态块已达上限/u)
})

test('状态块：红队被本会话停用时出现条件行', () => {
  office.init(call(), { name: '示例项目' })
  office.appendEvent(call(), 'redteam/mode', { enabled: false, reason: '用户要求停用' })
  const block = renderStatusBlock(office.status(call()), '.sdo', 1500)
  assert.match(block, /红队：停用（本会话，用户要求停用）/u)
})

test('文本看板：确定性（同状态两次逐字节相同）且含阶段与门禁', () => {
  const status = office.status(call())
  const model = {
    project: status.project,
    config: status.config,
    counts: status.counts,
    gates: office.gatesFor(call()),
    requirements: office.boardRequirements(call()),
    dataDirName: '.sdo',
    truncated: status.truncated,
  }
  const first = renderBoard(model)
  const second = renderBoard(model)
  assert.equal(first, second)
  assert.match(first, /尚未初始化/u)

  office.init(call(), { name: '示例项目' })
  const after = office.status(call())
  const board = renderBoard({
    project: after.project,
    config: after.config,
    counts: after.counts,
    gates: office.gatesFor(call()),
    requirements: office.boardRequirements(call()),
    dataDirName: '.sdo',
    truncated: after.truncated,
  })
  assert.match(board, /项目　PRJ-001 示例项目/u)
  assert.match(board, /▶ intake/u)
  assert.match(board, /门禁　待判定 G0/u)
  assert.equal(board, renderBoard({
    project: after.project,
    config: after.config,
    counts: after.counts,
    gates: office.gatesFor(call()),
    requirements: office.boardRequirements(call()),
    dataDirName: '.sdo',
    truncated: after.truncated,
  }))
})

test('多会话：各自工作目录互不串（不写到别人的项目里）', () => {
  const other = join(BASE, 'other')
  mkdirSync(other, { recursive: true })
  office.noteSession('session-2', other)

  office.init({ sessionId: 'session-2' }, { name: '另一个项目' })
  assert.ok(existsSync(join(other, '.sdo', 'project.json')))
  assert.equal(existsSync(join(workspace, '.sdo')), false, '不得写到另一个会话的目录')

  office.init(call(), { name: '本项目' })
  assert.ok(existsSync(join(workspace, '.sdo', 'project.json')))
  assert.equal(office.status(call()).project?.name, '本项目')
  assert.equal(office.status({ sessionId: 'session-2' }).project?.name, '另一个项目')
})

test('路径沙箱：数据目录名带 .. 也不会写到项目外', () => {
  const evil = new SoftwareDevOffice(resolveSettings(Config({ projectDir: '../outside' } as unknown as SdoConfig)))
  evil.noteSession('s', workspace)
  const store = evil.storeFor(workspace)
  assert.throws(() => store.path('..', 'x'), /逃出项目目录/u)
})
