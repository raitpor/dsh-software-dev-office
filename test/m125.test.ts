/**
 * **增量 125 / 0.1.7 批3 改口径：派发前置检查（`DEF-067` → `REQ-066` / `ADR-025`，`TASK-172`）**。
 *
 * 不变量（`ADR-009` 拟定）：**一张卡被派出时，它必须能够认领成功**。
 * 「可派发」= 依赖已满足 **∧** 写范围与在飞卡的相交**不属于"必须串行"的那两类**。
 *
 * 两代口径（同一份实现 `scopeIntersections` / `scopeSerialKindOf`，认领面与派发面共用）：
 *   · **修前**（`DEF-067` / `DEF-128`）：相交 ⇒ **一律**不派 / 拒签。真机现场：三张核实卡写同一批文件，
 *     两张认领失败、各白烧一轮会话；而回执里**没有**任何"暂不可派"行（`DEF-058` 的误判来源）。
 *   · **现在**（`ADR-025` / 用户 2026-10-22 裁定）：相交**默认照派**，但回执必须**点名**两张卡与具体路径
 *     （可见即约束）；只有两类**真需要串行**：任一方声明**独占窗口**（跑全量测试那种）、
 *     或写范围**缺失/为空无法判定**（fail-closed，按整仓处理）。
 *
 * **反向守卫同样重要**：把 `merge` 的卡**拦住不派**也是错的（相交 ≠ 真冲突 —— git 对同一文件的不同
 * 区域本来就能干净合并，一律拦下只会让人白拆卡）。本文件每条正向格都配一条反向格。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { scopeHeldTasks, scopeIntersections } from '../src/domain/plan.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m125/', import.meta.url))
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

function baseCard(id: string, status: TaskCard['status'], writeScopes: string[], overrides: Partial<TaskCard> = {}): TaskCard {
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
  office.init(call, { name: 'M125 派发前置检查', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['派发前置检查'],
    scopeOut: ['自动改 blockedBy'],
    metricsSuccess: ['派出即能认领'],
    glossary: { 在飞卡: '已认领、正在做的卡' },
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

test('M125-01 分类矩阵：相交只点名（merge）；两类才串行（独占窗口 / 写范围缺失 fail-closed）', () => {
  // ① 同一路径、无独占声明 ⇒ **merge**：点名、不挡
  const merge = [
    baseCard('TASK-911', 'in-progress', ['.sdo/reviews/']),
    baseCard('TASK-912', 'ready', ['.sdo/reviews/']),
    baseCard('TASK-913', 'ready', ['src/a.tsx']),
    baseCard('TASK-914', 'ready', ['src/a.ts'], { blockedBy: ['TASK-911'] }),
  ]
  const named = scopeIntersections(merge).map((row) => [row.task.id, row.holder.id, row.kind, row.overlap])
  assert.deepEqual(
    named,
    [['TASK-912', 'TASK-911', 'merge', ['.sdo/reviews']]],
    '同一路径 ⇒ 一条 merge 相交（点名卡、持有者、路径）；TASK-914 显式声明了先后 ⇒ 不算意外相交；TASK-913 是另一个文件 ⇒ 不相交',
  )
  assert.deepEqual(scopeHeldTasks(merge), [], 'merge 那支**不挡**（挡住 = 过度保守，反向守卫会红）')

  // ② **文件名前缀**不是相交（`src/a.ts` × `src/a.tsx`）——旧实现判互斥，那是假阳性
  const prefixFixture = [
    baseCard('TASK-921', 'in-progress', ['src/a.ts']),
    baseCard('TASK-922', 'ready', ['src/a.tsx']),
  ]
  assert.deepEqual(scopeIntersections(prefixFixture), [], 'src/a.tsx 是另一个路径，不相交')
  assert.deepEqual(scopeHeldTasks(prefixFixture), [], '也不挡')

  // ③ **目录边界**：`src/` × `src/a.ts` **相交**（目录包含文件），且点名重叠的那条**路径**
  const dirFixture = [
    baseCard('TASK-923', 'in-progress', ['src/']),
    baseCard('TASK-924', 'ready', ['src/a.ts']),
  ]
  const dirRows = scopeIntersections(dirFixture)
  assert.equal(dirRows.length, 1, '目录 × 其下文件必须算相交')
  assert.equal(dirRows[0]?.kind, 'merge')
  assert.deepEqual(dirRows[0]?.overlap, ['src/a.ts'], '点名的是**重叠的那条路径**，不是对方的全量写范围')

  // ④ **独占窗口**（任一方声明）⇒ 串行，且 kind 说得清是哪一支
  const exclusive = [
    baseCard('TASK-931', 'in-progress', ['src/x.ts'], { exclusive: 'full-suite' }),
    baseCard('TASK-932', 'ready', ['src/x.ts']),
  ]
  const heldExclusive = scopeHeldTasks(exclusive)
  assert.equal(heldExclusive.length, 1, '任一方声明独占窗口 ⇒ 必须串行')
  assert.equal(heldExclusive[0]?.kind, 'exclusive-window')
  assert.deepEqual(heldExclusive[0]?.overlap, ['src/x.ts'], '串行也要点名重叠路径（回执要能照着办）')

  // ⑤ **写范围缺失/为空 ⇒ 无法判定 ⇒ fail-closed**（按整仓处理，不许当空集放过）
  const unknown = [
    baseCard('TASK-941', 'in-progress', ['src/y.ts']),
    baseCard('TASK-942', 'ready', []),
  ]
  const heldUnknown = scopeHeldTasks(unknown)
  assert.equal(heldUnknown.length, 1, '写范围为空必须 fail-closed（空集 ≠ 不相交）')
  assert.equal(heldUnknown[0]?.kind, 'unknown-scope')
  assert.deepEqual(heldUnknown[0]?.overlap, [], '判不了就不编造路径（回执改说"写范围为空/缺失"）')

  // ⑥ 反向：不相交的卡既不点名也不挡（证明不是"全都不报/全都报"）
  const disjoint = [
    baseCard('TASK-951', 'in-progress', ['src/m/']),
    baseCard('TASK-952', 'ready', ['src/n/']),
  ]
  assert.deepEqual(scopeIntersections(disjoint), [], '不相交 ⇒ 不点名')
  assert.deepEqual(scopeHeldTasks(disjoint), [], '不相交 ⇒ 不挡')
})

test('M125-02 dispatchPlan：相交的卡**照派**（不阻断）；只有两类串行卡不进派发集', async () => {
  const holder = baseCard('TASK-971', 'ready', ['src/a.ts'])
  writeCard(holder)
  const claimed = office.claimTask(call, { taskId: 'TASK-971', owner: 'subagent:developer:1', expectedRevision: 1 })
  assert.equal(claimed.ok, true, `夹具前提：先有一张在飞卡（${JSON.stringify(claimed).slice(0, 120)}）`)

  writeCard(baseCard('TASK-972', 'ready', ['src/a.ts'])) // merge 相交
  writeCard(baseCard('TASK-973', 'ready', ['src/b.ts'])) // 不相交
  writeCard(baseCard('TASK-974', 'ready', ['src/a.ts'], { exclusive: 'full-suite' })) // 独占窗口
  writeCard(baseCard('TASK-975', 'ready', [])) // 写范围缺失 ⇒ fail-closed

  const plan = office.dispatchPlan(call, 8)
  const dispatched = plan.dispatch.map((task) => task.id)
  assert.equal(dispatched.includes('TASK-972'), true, '相交**不是**真冲突 ⇒ 必须照派（拦住它就是过度保守）')
  assert.equal(dispatched.includes('TASK-973'), true, '不相交的卡照旧可派')
  assert.equal(dispatched.includes('TASK-974'), false, '声明独占窗口 ⇒ 串行（本轮不派）')
  assert.equal(dispatched.includes('TASK-975'), false, '写范围为空 ⇒ 判不了 ⇒ 串行（fail-closed）')

  const heldIds = plan.held.map((row) => row.task.id)
  assert.deepEqual(heldIds.sort(), ['TASK-974', 'TASK-975'], 'held 只装**真需要串行**的那两类（merge 不在里面）')
  const row = plan.held.find((item) => item.task.id === 'TASK-974')
  assert.equal(row?.holder.id, 'TASK-971', '点名挡路的在飞卡')
  assert.deepEqual(row?.overlap, ['src/a.ts'], '点名重叠路径')
})

test('M125-03 poolPlan：heldByScope 回读**两种处置**（merge 照派 / 串行挡住），各带 kind', async () => {
  writeCard(baseCard('TASK-981', 'ready', ['.sdo/reviews/']))
  const claimed = office.claimTask(call, { taskId: 'TASK-981', owner: 'subagent:developer:9', expectedRevision: 1 })
  assert.equal(claimed.ok, true)
  writeCard(baseCard('TASK-982', 'ready', ['.sdo/reviews/'])) // merge：点名 + 照派
  writeCard(baseCard('TASK-983', 'ready', ['.sdo/reviews/'], { exclusive: 'full-suite' })) // 串行

  const admission = office.poolPlan(call, { reuseIdle: false })
  assert.equal(
    admission.dispatch.some((entry) => entry.task.id === 'TASK-982'),
    true,
    'merge 相交的卡必须进派发集（ADR-025：相交 ≠ 真冲突）',
  )
  assert.equal(
    admission.dispatch.some((entry) => entry.task.id === 'TASK-983'),
    false,
    '独占窗口的卡不得进派发集',
  )
  const rows = admission.heldByScope ?? []
  assert.equal(rows.length, 2, `两条读数都要回读（实际 ${JSON.stringify(rows)}）`)
  const mergeRow = rows.find((item) => item.taskId === 'TASK-982')
  assert.equal(mergeRow?.kind, 'merge', '照派的那些也要在读数里出现（可见即约束）')
  assert.equal(mergeRow?.holderId, 'TASK-981')
  assert.equal(mergeRow?.holderOwner, 'subagent:developer:9', 'owner 要能指向人（便于找人让路）')
  assert.deepEqual(mergeRow?.overlap, ['.sdo/reviews'])
  const serialRow = rows.find((item) => item.taskId === 'TASK-983')
  assert.equal(serialRow?.kind, 'exclusive-window')
})

test('M125-04 工具回执：相交**照派**并单列一行点名两卡与路径；独占窗口才走「暂不可派」', async () => {
  writeCard(baseCard('TASK-991', 'ready', ['src/a.ts']))
  const claimed = office.claimTask(call, { taskId: 'TASK-991', owner: 'subagent:developer:4', expectedRevision: 1 })
  assert.equal(claimed.ok, true)
  writeCard(baseCard('TASK-992', 'ready', ['src/a.ts'])) // merge：照派 + 点名
  writeCard(baseCard('TASK-993', 'ready', ['src/b.ts'])) // 不相交
  writeCard(baseCard('TASK-994', 'ready', ['src/a.ts'], { exclusive: 'full-suite' })) // 串行

  // **注意 `why`**：`why=true` 是**诊断面**（不派发任何卡）⇒ 要验"派出去了哪些、挡下了哪些"
  // 必须走**普通**回执（这正是主路径以前看不见"某卡没派出去"的原因）。
  const receipt = await callTool('sdo_plan', { action: 'next', limit: 4 })

  // ① 相交的卡**真的被派**（反向守卫：拦住它 ⇒ 本行断言就红）
  assert.match(receipt, /claim id=TASK-992/u, `相交的卡必须照派：${receipt.slice(0, 300)}`)
  assert.match(receipt, /claim id=TASK-993/u, '不相交的卡照旧派出')
  // ② 独占窗口的那张**不派**，且回执单列一行「暂不可派」点名它、挡路的卡与重叠路径
  assert.equal(receipt.includes('claim id=TASK-994'), false, '独占窗口的卡不得被下发认领指令')
  const heldLines = receipt.split('\n').filter((line) => line.includes('暂不可派'))
  assert.equal(heldLines.length, 1, `串行的卡必须**单列一行**点名（实际 ${heldLines.length} 行）：${receipt.slice(0, 400)}`)
  assert.match(heldLines[0] ?? '', /TASK-994/u, '要点名被挡的卡')
  assert.match(heldLines[0] ?? '', /TASK-991/u, '要点名挡住它的在飞卡')
  assert.match(heldLines[0] ?? '', /src\/a\.ts/u, '要点名重叠的那个路径')
  // ③ merge 那一支**也有自己的一行**（可见即约束），且说的是"照常派发"而不是"暂不可派"
  const mergeLines = receipt.split('\n').filter((line) => line.includes('写范围相交') && line.includes('照常派发'))
  assert.equal(mergeLines.length, 1, `相交照派必须留一行点名（实际 ${mergeLines.length} 行）：${receipt.slice(0, 600)}`)
  assert.match(mergeLines[0] ?? '', /TASK-992/u, '要点名计划派的卡')
  assert.match(mergeLines[0] ?? '', /TASK-991/u, '要点名在飞的那张卡')
  assert.match(mergeLines[0] ?? '', /src\/a\.ts/u, '要点名相交的那个路径')

  // ④ 诊断面同样可见（`why=true` 不派发，但必须说清谁被挡、与谁相交）
  const why = await callTool('sdo_plan', { action: 'next', limit: 4, why: true })
  assert.ok(why.includes('暂不可派') && why.includes('TASK-994'), `诊断面也要点名串行的卡：${why.slice(0, 300)}`)
})

test('M125-05 落点三：计划读数的修法文案必须给"把该路径拆成独立卡"这条处置', () => {
  const zh = readFileSync(join(ROOT, 'src', 'data', 'lang', 'zh-CN.yml'), 'utf8')
  const en = readFileSync(join(ROOT, 'src', 'data', 'lang', 'en.yml'), 'utf8')
  for (const [name, text] of [['zh-CN.yml', zh], ['en.yml', en]] as const) {
    assert.match(text, /kScopeSplitSuggestion:/u, `${name} 缺 kScopeSplitSuggestion（拆卡建议）`)
    assert.match(text, /kDispatchHeldByScope:/u, `${name} 缺 kDispatchHeldByScope（暂不可派行）`)
    // `ADR-025` 新增的两条：照派点名行 / 写范围缺失（fail-closed）行
    assert.match(text, /kDispatchScopeMergeLine:/u, `${name} 缺 kDispatchScopeMergeLine（相交照派点名行）`)
    assert.match(text, /kDispatchUnknownScopeLine:/u, `${name} 缺 kDispatchUnknownScopeLine（写范围缺失 fail-closed 行）`)
  }
  const plan = readFileSync(join(ROOT, 'src', 'domain', 'plan.ts'), 'utf8')
  assert.match(plan, /t\('uiPlan\.kScopeSplitSuggestion'\)/u, 'write-scope-disjoint 的修法必须带上拆卡建议')
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /heldByScopeSection/u, '`next` 的回执必须接上"暂不可派"段')
  // 两种处置**同一份读数**渲染（`kind` 分流）：不许一处读 held、另一处再算一遍
  assert.match(index, /heldRows\.filter\(\(row\) => row\.kind !== 'merge'\)/u, '串行那一段必须按 kind 分流')
  assert.match(index, /heldRows\.filter\(\(row\) => row\.kind === 'merge'\)/u, '照派那一段必须按 kind 分流')
})

test('M125-06 认领面同口径（TC-129）：merge 相交**放行**并留痕；两类串行才拒签且点名重叠路径', async () => {
  // 在飞卡写 3 条范围，只有一条与后面那张卡重叠 —— 拒签文案只该说那一条
  writeCard(baseCard('TASK-951', 'ready', ['src/holder/a.ts', 'src/holder/b.ts', 'src/shared/x.ts']))
  const held = office.claimTask(call, { taskId: 'TASK-951', owner: 'subagent:developer:1', expectedRevision: 1 })
  assert.equal(held.ok, true, `夹具前提：在飞卡必须认领成功（${JSON.stringify(held).slice(0, 120)}）`)

  // ① **merge 相交 ⇒ 认领放行**（派发面照派，认领面若还拒签就是白烧一轮会话 = DEF-067 原病）
  writeCard(baseCard('TASK-952', 'ready', ['src/shared/x.ts', 'src/mine/z.ts']))
  const allowed = office.claimTask(call, { taskId: 'TASK-952', owner: 'subagent:developer:2', expectedRevision: 1 })
  assert.equal(allowed.ok, true, '相交 ≠ 真冲突：认领必须放行（两条各在自己的工作副本里写，完成时合并）')
  const claimedEvents = office.journalFor(WORKSPACE).read().events.filter(
    (event) => event.type === 'task/claimed' && String(event.data['id'] ?? '') === 'TASK-952',
  )
  assert.equal(claimedEvents.length, 1, '放行也要留**追加式**留痕（task/claimed）')

  // ② **独占窗口 ⇒ 拒签**，且点名重叠路径、不倒出对方全量写范围、给出三条出路
  writeCard(baseCard('TASK-953', 'ready', ['src/shared/x.ts', 'src/mine/y.ts'], { exclusive: 'full-suite' }))
  const denied = office.claimTask(call, { taskId: 'TASK-953', owner: 'subagent:developer:3', expectedRevision: 1 })
  assert.equal(denied.ok, false, '声明了独占窗口 ⇒ 串行，认领必须被拒')
  if (denied.ok) assert.fail('应当拒绝')
  assert.equal(denied.code, 'write-scope-conflict')
  assert.match(denied.detail, /src\/shared\/x\.ts/u, `拒签必须点名重叠路径：${denied.detail}`)
  assert.equal(denied.detail.includes('src/holder/a.ts'), false, `不许倒出对方不相关的写范围：${denied.detail}`)
  assert.equal(denied.detail.includes('src/holder/b.ts'), false, `不许倒出对方不相关的写范围：${denied.detail}`)
  assert.match(denied.detail, /TASK-951/u, '要点名挡路的卡')
  assert.match(denied.detail, /subagent:developer:1/u, '要点名 owner（便于找人让路）')
  assert.match(denied.detail, /release/u, '要给出"让它让路"这条可执行出路')

  // ③ **写范围为空**：fail-closed 只在**派发**面生效（任务书 §2.1.4："这两类情形下**不派发**"）——
  //    那一层能补救（补写范围 / 拆卡）；认领面**不加**第二条闸门（它会连"本来就不经派发的卡"一起钉死，
  //    例如驾驶舱 inline 开工、以及 `writeScopes` 为空的文书/复核卡，那是认领面的假阳性）。
  //    所以这里判两件事：认领**放行**；派发面**仍然**把它按整仓串行（反向守卫见 M125-01 ⑤ / M125-02）。
  writeCard(baseCard('TASK-954', 'ready', []))
  const unknown = office.claimTask(call, { taskId: 'TASK-954', owner: 'subagent:developer:4', expectedRevision: 1 })
  assert.equal(unknown.ok, true, '认领面不重复实现派发面那条 fail-closed（空范围卡照常能认领）')
  // 派发面那一支（同一张空范围卡 ⇒ `unknown-scope` ⇒ 串行）由 M125-01 ⑤ 与 M125-02 反向钉住：
  // 两处读的是**同一个** `scopeIntersections`，所以不需要在认领面再抄一遍判据。

  // ④ 零写盘 + 追加式留痕：被拒的卡状态/owner/revision 都不动，拒签事件进 journal
  const after = office.taskById(call, 'TASK-953')
  assert.equal(after?.status, 'ready', '被拒的认领不许改卡状态')
  assert.equal(after?.owner ?? '', '', '被拒的认领不许占 owner')
  assert.equal(after?.revision, 1, '被拒的认领不许推进 revision')
  const rejected = office.journalFor(WORKSPACE).read().events.filter(
    (event) => event.type === 'task/claim-rejected' && String(event.data['id'] ?? '') === 'TASK-953',
  )
  assert.equal(rejected.length, 1, '拒签必须留**追加式**留痕（task/claim-rejected）')
})
