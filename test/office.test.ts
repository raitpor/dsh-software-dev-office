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
import { callOf, createOfficeTools } from '../src/interface/tools.js'
import { describeGate } from '../src/interface/describe.js'
import { findProjectRoot } from '../src/infra/discovery.js'

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
  // **SDO-08**：立项时要把插件/宿主/node 版本记进真源（跨版本复现的外部线索）
  const env = office.journalFor(workspace).read().events.filter((event) => event.type === 'project/environment')
  assert.equal(env.length, 1)
  assert.equal(env[0]?.data.plugin, 'dsh-software-dev-office')
  assert.equal(typeof env[0]?.data.pluginVersion, 'string')
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

test('status：journal 损坏 → 截断并报告（不静默，且说明事件流类判定此刻无法判定）', () => {
  office.init(call(), { name: '示例项目' })
  writeFileSync(join(workspace, '.sdo', 'journal.jsonl'), '{"seq":1,"at":"x"\n', { flag: 'a' })
  const status = office.status(call())
  assert.equal(status.truncated, true)
  // **SDO-08** 让 `init` 多写一条 `project/environment`（插件/宿主/node 版本入账）⇒ 坏行行号随合法事件数走
  assert.equal(status.badLine, office.journalFor(workspace).read().events.length + 1)
  // 口径（第四份评审员报告 §3）：坏行**不一定是尾部**（中段同样触发），且此刻凡以事件流为证据的判定
  // （签字失效 / 渲染佐证 / 红队记录 / 回退留痕）都必须声明「无法判定」，不能拿截断前缀自信作答。
  const receipt = describeStatus(status, '.sdo')
  assert.match(receipt, /journal\.jsonl/u, '必须点名坏真源')
  // 坏行行号随合法事件数走（SDO-08 让 init 多写一条 project/environment）
  assert.match(receipt, new RegExp(`第 ${office.journalFor(workspace).read().events.length + 1} 行`, 'u'), '必须点名坏行')
  assert.match(receipt, /损坏/u, '必须说明真源损坏')
  assert.match(receipt, /无法判定/u, '必须说明事件流类判定此刻无法判定')
  assert.match(receipt, /不会被重建/u, '必须说明派生投影不会被重建')
})

test('未初始化：status 与状态块都给出明确下一步，不报错', () => {
  const status = office.status(call())
  assert.equal(status.project, undefined)
  assert.equal(status.pendingGate, undefined)
  assert.match(describeStatus(status, '.sdo'), /尚未初始化/u)

  const block = renderStatusBlock(status, '.sdo', 1500)
  assert.match(block, /尚未初始化/u)
  assert.match(block, /sdo_init/u)
  // 状态块是**背景**，不能写成指令：否则模型会在"你好"这类寒暄上主动调用 sdo_* 工具
  assert.match(block, /背景状态/u)
  assert.match(block, /不需要/u)
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
    process: office.process(call()),
    pendingGate: status.pendingGate,
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
    process: office.process(call()),
    pendingGate: after.pendingGate,
    dataDirName: '.sdo',
    truncated: after.truncated,
  })
  assert.match(board, /项目　PRJ-001 示例项目/u)
  assert.match(board, /▶ 立项/u, '阶段名来自流程数据（瀑布：立项/可行性/…）')
  assert.match(board, /门禁　待判定 立项门禁/u, '门禁要显示中文名，不暴露 G0 这类标识')
  assert.equal(/待判定 G\d/u.test(board), false, '看板不得出现裸门禁标识')
  assert.equal(board, renderBoard({
    project: after.project,
    config: after.config,
    counts: after.counts,
    gates: office.gatesFor(call()),
    requirements: office.boardRequirements(call()),
    process: office.process(call()),
    pendingGate: after.pendingGate,
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

test('DEF：新会话 + 新工作区不得显示别的会话的项目（跨会话串味）', () => {
  const a = join(BASE, 'ws-a')
  const b = join(BASE, 'ws-b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })

  // 会话 A：在 ws-a 立项
  office.noteSession('session-A', a)
  office.init({ sessionId: 'session-A' }, { name: 'A 项目' })
  assert.equal(office.status({ sessionId: 'session-A' }).project?.name, 'A 项目')

  // 会话 B：系统还没记录它的 cwd → **明确报错**（不兜底到 A 的工作区，也不用 process.cwd()）
  const stB = office.status({ sessionId: 'session-B' })
  assert.equal(stB.workspaceUnknown, true, '工作区未知应友好降级，而不是抛错')
  assert.equal(stB.project, undefined, '不得看到别的会话的项目')

  // 会话 B 带上自己的 cwd → 只认自己的
  assert.equal(office.status({ sessionId: 'session-B', cwd: b }).project, undefined, 'ws-b 里没有项目')
  office.init({ sessionId: 'session-B', cwd: b }, { name: 'B 项目' })
  assert.equal(office.status({ sessionId: 'session-B', cwd: b }).project?.name, 'B 项目')
  // A 仍然是 A（互不覆盖）
  assert.equal(office.status({ sessionId: 'session-A' }).project?.name, 'A 项目')

  rmSync(a, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})

test('DEF：注入路径与成本缓存也按工作区隔离（不得跨会话/跨工作区）', () => {
  const a = join(BASE, 'iso-a')
  const b = join(BASE, 'iso-b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })

  office.noteSession('sA', a)
  office.noteSession('sB', b)
  office.init({ sessionId: 'sA' }, { name: 'A 项目' })
  office.init({ sessionId: 'sB' }, { name: 'B 项目' })

  // 作用域能对上 → 用该会话的工作区
  assert.equal(office.status(office.callForScope('sA')).project?.name, 'A 项目')
  assert.equal(office.status(office.callForScope('sB')).project?.name, 'B 项目')
  // 作用域对不上 → 空上下文（落到进程 cwd），**绝不复用另一个会话**
  assert.equal(office.callForScope('无关作用域').sessionId, undefined)
  assert.equal(office.callForScope(undefined).sessionId, undefined)
  assert.equal(office.callForScope(null).sessionId, undefined)

  // 成本缓存按工作区：给 A 记一个值，B 的状态块不受影响
  office.costReport({ sessionId: 'sA' }, { rows: [], available: true })
  office.setBudget({ sessionId: 'sA' }, { total: 10 })
  const lineA = office.status({ sessionId: 'sA' }).costLine
  const lineB = office.status({ sessionId: 'sB' }).costLine
  assert.ok(lineA !== undefined)
  assert.equal(lineB, undefined, 'B 没设预算，不该出现 A 的成本行')

  rmSync(a, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})

test('真源是 .sdo/：成本快照跨实例可读（不依赖内存缓存）', () => {
  const ws = join(BASE, 'truth-ws')
  mkdirSync(ws, { recursive: true })
  const first = office
  first.noteSession('s1', ws)
  first.init({ sessionId: 's1' }, { name: '真源项目' })
  first.setBudget({ sessionId: 's1' }, { total: 10 })
  first.costReport({ sessionId: 's1' }, { rows: [], available: true })

  // 全新实例（等价于"重启进程"）：状态块仍能给出成本行 → 说明它读的是 .sdo/ 而不是内存
  const second = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const status = second.status({ sessionId: 's1', cwd: ws })
  assert.ok(status.costLine !== undefined, '成本行应来自 .sdo/cost.yml')
  assert.ok(existsSync(join(ws, '.sdo', 'cost.yml')), '成本快照必须落在 .sdo/')
  // journal 仍是真源：有 cost/updated 事件
  const events = second.journalFor(ws).read().events
  assert.ok(events.some((event) => event.type === 'cost/updated'), '成本也要进 journal')
  rmSync(ws, { recursive: true, force: true })
})

test('DEF：定位只看本层——上层目录有 .sdo/ 也不许命中（"仍串工作区"的根因）', () => {
  const parent = join(BASE, 'upper')
  const child = join(parent, 'child')
  mkdirSync(child, { recursive: true })
  // 在上层伪造一个别的项目
  const other = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  other.noteSession('other', parent)
  other.init({ sessionId: 'other' }, { name: '上层项目' })

  // 子目录里的会话（cwd 明确为 child）→ 本层没有 .sdo/ ⇒ 必须视为未初始化
  const status = office.status({ sessionId: 'child-session', cwd: child })
  assert.equal(status.project, undefined, '不得命中上层目录的 .sdo/（那正是串工作区）')
  assert.match(renderStatusBlock(status, '.sdo', 1500), /尚未初始化|没有/u)
  rmSync(parent, { recursive: true, force: true })
})

test('项目发现工具：findProjectRoot 仍可用于显式探测（不参与自动定位）', () => {
  const root = join(BASE, 'discover')
  const nested = join(root, 'a', 'b', 'c')
  mkdirSync(nested, { recursive: true })
  mkdirSync(join(root, '.sdo'), { recursive: true })
  assert.equal(findProjectRoot(nested, '.sdo'), root, '应从子目录向上发现含 .sdo/ 的目录')
  assert.equal(findProjectRoot(join(BASE, 'nowhere'), '.sdo'), undefined, '找不到就返回 undefined，不猜')
  rmSync(root, { recursive: true, force: true })
})

test('DEF：工作区未知时明确报错，绝不使用外部目录兜底', () => {
  const bare = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  // 没有会话、没有 cwd → 工作区未知
  assert.equal(bare.workspaceFor({}), undefined, '不得回退到 process.cwd()')
  assert.equal(bare.workspaceFor({ sessionId: '未知会话' }), undefined)
  assert.throws(() => bare.requireWorkspace({}), /无法确定本会话的工作区/u)
  // 工作区未知时 → **友好降级**（不抛错）：状态明确说明，且 project 为 undefined
  const snapshot = bare.status({})
  assert.equal(snapshot.workspaceUnknown, true)
  assert.equal(snapshot.project, undefined)
  // 有 cwd 就正常
  const ws = join(BASE, 'no-fallback')
  mkdirSync(ws, { recursive: true })
  assert.equal(bare.workspaceFor({ cwd: ws }), ws)
  rmSync(ws, { recursive: true, force: true })
})

test('全链路：agent 形状的调用（session.header.cwd）应能定位工作区并立项', () => {
  const ws = join(BASE, 'agent-shaped')
  mkdirSync(ws, { recursive: true })
  // 模拟宿主真实形状：Agent 只有 session.header.cwd（这正是原先读错的字段）
  const shaped = { sessionId: 'agent-1', agent: { id: 'agent-1', session: { header: { cwd: ws } } } } as never
  const call = callOf(shaped)
  assert.equal(call.cwd, ws)
  office.init(call, { name: '形状测试项目', process: 'waterfall', scale: 'normal', stakeholders: ['我'] })
  assert.equal(office.status(call).project?.name, '形状测试项目', '映射为空也要能靠 agent.session.header.cwd 定位（解冻被固化的缺陷）')
  rmSync(ws, { recursive: true, force: true })
})

test('门禁必须用中文名讲给用户（只给 G1 一般用户看不懂）', () => {
  const ws = join(BASE, 'gate-label')
  mkdirSync(ws, { recursive: true })
  office.noteSession('gate-s', ws)
  office.init({ sessionId: 'gate-s' }, { name: '门禁文案', process: 'waterfall', scale: 'normal', stakeholders: ['我'] })
  const text = describeGate(office.checkGate({ sessionId: 'gate-s' }, '可行性门禁'))
  assert.match(text, /可行性门禁/u, '必须出现中文门禁名')
  assert.match(text, /（G1）/u, '内部编号放在括号里，便于追溯')
  // 工具参数说明里不得再裸列编号
  const tools = createOfficeTools({} as never)
  const gateTool = tools.find((tool) => tool.name === 'sdo_gate')
  const desc = JSON.stringify(gateTool?.parameters ?? {})
  assert.match(desc, /可行性门禁/u, '参数描述要给中文名')
  assert.doesNotMatch(desc, /e\.g\. 'G0', 'G1'/u, '不得再裸列编号')
  rmSync(ws, { recursive: true, force: true })
})

test('DEF-08b：红队不许反复问同一题——上一批未答完时拒绝再次攻击', () => {
  const ws = join(BASE, 'redteam-repeat')
  mkdirSync(ws, { recursive: true })
  const o = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  o.noteSession('rt', ws)
  o.init({ sessionId: 'rt' }, { name: '红队重复', process: 'waterfall', scale: 'normal', stakeholders: ['我'] })
  const c = o.capture({ sessionId: 'rt' }, {
    title: 'r', statement: '系统须支持 X；P99 < 1 秒', priority: 'must', sourceRaw: '用户原话',
  })
  const first = o.redTeamAttack({ sessionId: 'rt' }, [c.requirement.id], 3)
  assert.equal(first.questions.length, 3)
  const second = o.redTeamAttack({ sessionId: 'rt' }, [c.requirement.id], 3)
  assert.equal(second.questions.length, 0, '上一批未答完不得再生成')
  assert.match(second.blocked ?? '', /未决/u)
  // 题目带需求号，跨需求不会看起来是"同一题"
  assert.match(first.questions[0]?.text ?? '', /针对「/u, '问题须指向具体需求（标题派生）')
  rmSync(ws, { recursive: true, force: true })
})
