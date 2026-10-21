/**
 * **增量 147：改既有行为的卡必须点名影响面（DEF-036，§3E 族 1「对账判据」）**。
 *
 * 缺陷原文（纪律 B-25，`docs/plan/2026-10-13-流程缺陷候选.md:97`，真机 TASK-054）：
 * 「引入新语义的卡，DoD 没有要求先扫『既有夹具/守卫会不会被它撞红』」—— 它的落点让 `record`
 * 从此**必填 oracle**（卡面要求的新语义），于是 TASK-039 的夹具 `test/m94.test.ts` 里 4 条用例
 * **在写卡时没被预料到**，落地后全红；它只能在「改夹具口径」与「回滚自己的改动」之间选。
 *
 * **先钉红**（本仓修前 `lib/` 产物上跑，两条分支都 0 命中）：
 *   ```
 *   卡 A：fixes=['DEF-036']（声明在改既有行为）、无 impact/undecidable ⇒ 码集 []
 *   卡 B：写范围与已落地卡相交、无 impact/undecidable               ⇒ 码集 []
 *   lib/src/domain/plan.js 里 impact 出现次数 = 0（字段面根本没有承载）
 *   ```
 *
 * **修法**：`validatePlan` 加第八条机械校验 `impact-undeclared` —— 卡**声明了在改既有行为**时，
 * 必须点名影响面（`impact`）或声明推不出来（`undecidable`）。两条「声明了在改既有行为」的**结构**信号
 * （不读散文，判据必须语言无关）：① `fixes` 非空；② 写范围与**已落地**（done/verified）卡相交。
 * 为什么不从路径推断语义：并行卡的写范围互斥已由 `write-scope-disjoint`（DEF-067）承担，那是**并行**轴；
 * 而 B-25 真机撞的是**调用点** —— TASK-054 写 `src/domain/records.ts`、撞红 `test/m94.test.ts`，
 * 两张卡写范围根本不相交 ⇒ 语言无关口径下没有可靠的推断信号，语义影响只能由项目自己声明。
 *
 * **反例一起给**（否则就是「全判红」）：点了 `impact` 或 `undecidable` ⇒ 转绿（M147-01/02）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { createTask, readTask } from '../src/domain/plan.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m147/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, status: TaskCard['status'], writeScopes: string[], overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes,
    role: 'developer',
    size: 'small',
    revision: 1,
    status,
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function writeCard(task: TaskCard): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${task.id}.yml`], { task })
}

/** 这张卡上 `impact-undeclared` 的 issue（没有就是空数组） */
function impactIssues(id: string): { detail: string }[] {
  return office.planIssues(call).filter((issue) => issue.taskId === id && issue.code === 'impact-undeclared')
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M147 影响面声明', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['影响面声明通道'],
    scopeOut: ['从路径推断语义'],
    metricsSuccess: ['改既有行为的卡在拆卡期就点名影响面'],
    glossary: { 影响面: '本卡改动会影响到的文件/用例' },
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
  services['tools'] = { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M147-01 反例 A：声明在改既有行为，但点名了 impact ⇒ 判据转绿（不许全判红）', () => {
  writeCard(card('TASK-971', 'planned', ['src/a/'], { fixes: ['DEF-036'], impact: ['test/m94.test.ts'] }))
  assert.deepEqual(impactIssues('TASK-971'), [], '点了影响面就必须绿')
})

test('M147-02 反例 B：给不出影响面但声明了 undecidable ⇒ 同样转绿（"推不出来"必须说得出来）', () => {
  writeCard(card('TASK-972', 'planned', ['src/a/'], { fixes: ['DEF-036'], undecidable: '影响面要跑全量才能扫出来，本卡先按调用点人工列举' }))
  assert.deepEqual(impactIssues('TASK-972'), [], '声明推不出来的理由后必须绿')
})

test('M147-03 分支 A 判红：声明修既有缺陷却两条出口皆空 ⇒ 判红并点名缺陷号', () => {
  writeCard(card('TASK-973', 'planned', ['src/a/'], { fixes: ['DEF-036', 'DEF-024'] }))
  const issues = impactIssues('TASK-973')
  assert.equal(issues.length, 1, `必须恰好一条（修前这里是 0 条）：${JSON.stringify(office.planIssues(call))}`)
  assert.match(issues[0]?.detail ?? '', /DEF-036/u, '要点名卡上声明的缺陷号（可核对）')
  assert.match(issues[0]?.detail ?? '', /DEF-024/u, '多号要全部点名')
  // 出路必须是可执行的：remedy 要说清两条出口
  const remedy = office.planIssues(call).find((issue) => issue.taskId === 'TASK-973')?.remedy ?? ''
  assert.match(remedy, /impact/u, 'remedy 必须给出 impact 这条出路')
  assert.match(remedy, /undecidable/u, 'remedy 必须给出 undecidable 这条出路')
})

test('M147-04 分支 B 判红：写范围与已落地的卡相交 ⇒ 判红并点名那张卡与相交路径', () => {
  writeCard(card('TASK-974', 'done', ['src/shared/']))
  writeCard(card('TASK-975', 'planned', ['src/shared/']))
  const issues = impactIssues('TASK-975')
  assert.equal(issues.length, 1, `改一块已有落地物的地必须判红：${JSON.stringify(office.planIssues(call))}`)
  assert.match(issues[0]?.detail ?? '', /TASK-974/u, '要点名已落地的那张卡')
  // 路径按唯一出口 `scopeOverlaps` 归一后报出（尾部斜杠会被去掉 —— 与写范围判定同款口径）
  assert.match(issues[0]?.detail ?? '', /src\/shared/u, '要点名相交路径（可核对）')
})

test('M147-05 时机与存量口径：已落地/已作废的卡不追溯（落地后是历史，不重写）', () => {
  writeCard(card('TASK-976', 'done', ['src/b/'], { fixes: ['DEF-036'] }))
  writeCard(card('TASK-977', 'verified', ['src/b/'], { fixes: ['DEF-036'] }))
  writeCard(card('TASK-978', 'dropped', ['src/b/'], { fixes: ['DEF-036'] }))
  assert.deepEqual(impactIssues('TASK-976'), [], 'done 卡不追溯')
  assert.deepEqual(impactIssues('TASK-977'), [], 'verified 卡不追溯')
  assert.deepEqual(impactIssues('TASK-978'), [], 'dropped 卡不参校验')
})

test('M147-06 反例 C：既没声明改既有行为、也不碰落地物 ⇒ 不受影响（防"所有卡都判红"）', () => {
  writeCard(card('TASK-979', 'done', ['src/landed/']))
  writeCard(card('TASK-980', 'planned', ['src/fresh/']))
  assert.deepEqual(impactIssues('TASK-980'), [], '全新落地面的卡不该被要求点名影响面')
  assert.deepEqual(impactIssues('TASK-979'), [], '落地卡自己也不该被判')
})

test('M147-07 写侧通路（工具面，真实注册的工具）：impact / undecidable 都能落盘并让判据转绿', async () => {
  writeCard(card('TASK-981', 'planned', ['src/a/'], { fixes: ['DEF-036'] }))
  assert.equal(impactIssues('TASK-981').length, 1, '夹具前提：先红')
  const receipt = await callTool('sdo_task', { action: 'update', id: 'TASK-981', impact: '["test/m94.test.ts"]' })
  assert.equal(impactIssues('TASK-981').length, 0, `工具面写的声明必须真的落盘（静默丢弃会让判据永远红）：${receipt}`)
  assert.deepEqual(office.taskById(call, 'TASK-981')?.impact, ['test/m94.test.ts'], '读端白名单必须能读回（否则判据看不见）')
  // 另一条出口：撤回 impact 后改声明 undecidable
  await callTool('sdo_task', { action: 'update', id: 'TASK-981', impact: '[]', undecidable: '要跑全量才扫得出来' })
  const after = office.taskById(call, 'TASK-981')
  assert.deepEqual(after?.impact, [], 'impact 整份替换（空数组 = 撤回）')
  assert.equal(after?.undecidable, '要跑全量才扫得出来', 'undecidable 必须落盘')
  assert.equal(impactIssues('TASK-981').length, 0, '换成 undecidable 后仍须绿')
  // 空串 = 撤回声明（键随之消失，不留空值）—— 撤回后判据重新变红（说明它没有变成"写过就永久绿"）
  await callTool('sdo_task', { action: 'update', id: 'TASK-981', undecidable: '' })
  assert.equal(office.taskById(call, 'TASK-981')?.undecidable, undefined, '空串必须把声明撤回干净')
  assert.equal(impactIssues('TASK-981').length, 1, '两条出口都撤回后必须重新判红')
})

test('M147-08 schema 声明面：sdo_task 收 impact(oneOf string|array) 与 undecidable(string)', () => {
  const tool = tools.find((item) => item.name === 'sdo_task')
  const properties = (tool?.parameters as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {}
  assert.ok(properties['impact'] !== undefined, 'schema 必须声明 impact（否则 DSH 侧先拒，域层永远收不到）')
  assert.ok(Array.isArray((properties['impact'] as { oneOf?: unknown }).oneOf), 'impact 必须接受 JSON 文本或真数组两种形状')
  assert.equal((properties['undecidable'] as { type?: string }).type, 'string', 'undecidable 是普通字符串，不走 JSON')
})

test('M147-10 建卡通路的白名单：createTask（结构通道与模型通道都经它落盘）不得吃掉这两条声明', () => {
  // ⚠️ 变异自证（MUT-04）实测：把读端白名单里的 `impact` 删掉，本用例**照样绿** —— 因为
  // `readTaskChecked` 先做 `...record` 原始展开，白名单对**本字段**的职责是**归一化 + 形状提示**、
  // 不是可见性。真正的可见性守卫在**写入侧**（本用例 + M147-07 钉的就是那几处）。
  const store = office.storeFor(WORKSPACE)
  const created = createTask(store, new Journal(store), {
    title: '夹具卡',
    dod: ['d'],
    role: 'developer',
    writeScopes: ['src/a/'],
    fixes: ['DEF-036'],
    impact: ['test/m94.test.ts'],
    undecidable: '',
  } as never)
  assert.deepEqual(created.impact, ['test/m94.test.ts'], '建卡时给的 impact 必须进卡面')
  assert.equal(created.undecidable, undefined, '空串不落盘（否则「写着但空」与「未声明」会变成两种形态）')
  assert.deepEqual(readTask(store, created.id)?.impact, ['test/m94.test.ts'], '且必须能读回')
  assert.deepEqual(impactIssues(created.id), [], '点了影响面的新建卡必须绿')
})

test('M147-11 标量形状归一：YAML 里 `impact` 写成标量 ⇒ 单元素 + 形状提示（口径与 changes 真源一致）', () => {
  // 手写卡面的常见形态：不是"无视语义地静默丢弃"，而是**归一 + 提示**（这是读端白名单的真实职责）
  writeCard(card('TASK-983', 'planned', ['src/a/'], { fixes: ['DEF-036'], impact: 'test/m94.test.ts' as never }))
  assert.deepEqual(office.taskById(call, 'TASK-983')?.impact, ['test/m94.test.ts'], '标量必须被归一成单元素')
  const notes = office.shapeNotes(call).map((note) => `${note.entity}.${note.field}`)
  assert.equal(notes.includes('task.impact'), true, `标量形态必须留下形状提示（可复核）：${JSON.stringify(notes.slice(0, 8))}`)
  assert.deepEqual(impactIssues('TASK-983'), [], '归一后即视为已声明 ⇒ 绿')
})

test('M147-09 顺手补口：DEF-027 的 mutationExpected 在 update 面曾被静默丢弃，现已接通', async () => {
  writeCard(card('TASK-982', 'planned', ['src/a/'], { impact: ['src/a.ts'] }))
  await callTool('sdo_task', { action: 'update', id: 'TASK-982', mutationExpected: 3 })
  assert.equal(office.taskById(call, 'TASK-982')?.mutationExpected, 3, 'update 面必须真的接收这个声明（修前传进来会被丢掉）')
  const rejected = await callTool('sdo_task', { action: 'update', id: 'TASK-982', mutationExpected: -1 })
  assert.match(rejected, /非负整数|-1/u, '非法条数要可读拒绝，不静默丢弃')
  assert.equal(office.taskById(call, 'TASK-982')?.mutationExpected, 3, '拒绝后卡面不动')
})

test('M147-12 TC-119：`impact-undeclared` **只提示不拦派发**（判据面与派发准入是两条线）', () => {
  writeCard(card('TASK-981', 'planned', ['src/a/'], { fixes: ['DEF-036'] }))
  // ① 判据面：这条卡确实被判红（前置，否则下面的"不拦"是废话）
  const issues = impactIssues('TASK-981')
  assert.equal(issues.length, 1, `夹具前提：判据必须判红：${JSON.stringify(office.planIssues(call))}`)
  assert.equal(office.planIssues(call).find((issue) => issue.taskId === 'TASK-981')?.code, 'impact-undeclared', '拒因码必须是 impact-undeclared')

  // ② 派发准入：同一张卡仍必须进 `dispatch`（判据只提示，不改派发决策）
  const plan = office.poolPlan(call, { reuseIdle: false })
  const dispatched = plan.dispatch.map((row) => row.task.id)
  assert.equal(dispatched.includes('TASK-981'), true, `impact-undeclared 不许把卡挡在派发之外（实际派发集：${dispatched.join(' ') || '（空）'}）`)
  // 也不许被"挤进队列"或"被挡下"——那两种形态同样等于拦了派发
  assert.equal(plan.queued.map((task) => task.id).includes('TASK-981'), false, '不许把它算成"排队中"')
  assert.equal(plan.blocked.map((row) => row.task.id).includes('TASK-981'), false, '不许报它被预算挡住（那不是真相）')
  // ③ 反向对照（防"planIssues 恒空、所以当然不拦"）：判据确实产生了问题清单
  assert.ok(office.planIssues(call).some((issue) => issue.code === 'impact-undeclared'), '问题清单里必须有它（这条与 ② 一起才有意义）')
})
