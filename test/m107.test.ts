/**
 * **M107：结构通道的判重依据三态 + 依据为空不得静默建卡 + 一次性收口动作**（TASK-104 / 缺陷 DEF-063）。
 *
 * ## 病根（DEF-063，用户 2026-10-13 实测两轮两批废卡 ⇒ 已立卡真修）
 *
 * 结构通道的判据只回答"**找不找得到覆盖证据**"，回执却把它说成了"**没人做**"。在**存量补录项目**里
 * 追溯边（`des-task`）**天然缺失**（本仓真源 `links.jsonl` 里是 **0 条**，见 DEF-063 并案的 REV-046
 * 第 1 条），于是每轮 `decompose` 都按"没人做"长出一批卡：实测先长出 10 模块那批（TASK-074 修掉了
 * 写范围那一半），本轮又长出 **12 张 2 模块的**。两条出路都不许是"继续静默建卡"。
 *
 * 与 **DEF-052** 的区别（本卡不许回退它）：DEF-052 是**判重依据选错**（拿标题子串当追溯边 ⇒ 漏判/误判），
 * 修法是"三选一的 OR 口径"（M101-01…04 钉住）；本卡是**判重依据为空时怎么办**——两条依据都不命中时
 * 既没有"已有卡"的证据、也没有"无需卡"的裁决，此时**只有两种合法处置**：拒绝生成（点名 + 给出路），
 * 或生成但标为待裁决。**"照样按没人做建卡"不在其中**。
 *
 * ## 本文件的断言面（卡的落点一/二/三/四/五）
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | 元素有 `des-task` 边 | 不生成；skip 依据点名 `des-task`（**覆盖证据存在**那一态） |
 * | ② | 元素有标题 marker | 不生成；skip 依据点名 `title-marker`（同一态的历史兜底口径） |
 * | ③ | 元素列入 `plan.noCardElements` | 不生成；skip 依据点名 `no-card-element`（**人已裁决无需卡**那一态） |
 * | ④ | 三者皆无 + 采纳依据门槛 | **拒绝生成**：不落盘、不进队列；`needsDisposition` 点名元素 id 与**缺哪三条依据**；回执印出三态原文 + 三条出路 + **一次性收口片段** |
 * | ⑤ | 三者皆无 + 未采纳门槛 | 落盘，但回执**如实**印"判重依据为空"，并说明怎么采纳（**不许静默**） |
 * | ⑥ | 回归 DEF-052：误判方向 | 跟该元素无关的卡（标题恰好含 `（DES-002）`）不得让 `DES-001` 被跳过 |
 * | ⑦ | 回归写范围护栏 | 超 3 模块 / 含 `{}` 展开语法一律拒（本卡不改它） |
 *
 * 断言**必须点名**（元素 id + 缺哪条依据），且第 ④/⑤/⑦ 条走**真实注册的 `sdo_plan`/`sdo_plan action=next`**
 * 工具面 —— 域层算得出、渲染函数能单独印对，**都不等于**工具回执印出来了（M101-14 的教训：把
 * `result.structural` 传成 `undefined` 时，只测渲染函数的用例照样全绿，变异体存活）。
 *
 * 纪律与 M101 一致：夹具只写真源（`.sdo/` 下的 yml / `links.jsonl` / `config.yml`），断言读
 * **结构化结果**与**盘上真源**，不读自述文案；**不替存量卡补 `des-task` 边**（那是数据迁移，另有其卡）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { decompose, listTasks, structuralPlanOf } from '../src/domain/plan.js'
import { link, readLinks } from '../src/domain/trace.js'
import { apply } from '../src/index.js'
import { describeStructuralPlan } from '../src/interface/describe.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { Requirement } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m107/', import.meta.url))

/** 声明式写范围（1 个模块 ⇒ 不触发写范围护栏，好让本文件的红只因"依据"而红）。 */
const BOUND = '写范围：src/domain/trace.ts（独占）'
/** 10 个模块 ⇒ 写范围护栏该拒它（落点五的回归面）。 */
const OVERSIZED = '写范围：src/a.ts、src/b.ts、src/c.ts、src/d.ts、src/e.ts、src/f.ts、src/g.ts、src/h.ts、src/i.ts、src/j.ts（独占）'
/** `{}` 展开语法 ⇒ 同样该拒（"一张卡写一批模块"）。 */
const GROUPS = '写范围：src/{domain,interface}/（独占）'

/** 结构通道的读数（本文件只读它，不看自述文案）。 */
interface StructuralRead {
  created: { designId: string; title: string; writeScopes: string[]; how: string }[]
  skipped: { designId: string; name: string; reason: string; how?: string | undefined; scopes?: string[] | undefined }[]
  basisPolicy?: string | undefined
  needsDisposition?: { designId: string; name: string; missing: string[] }[] | undefined
}

let store: SdoStore
let journal: Journal
let ws: string

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
  ws = join(BASE, `ws-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(ws, { recursive: true })
  store = new SdoStore(join(ws, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 已基线的需求真源（结构通道的输入）。 */
function seedRequirement(id = 'REQ-001'): Requirement {
  const requirement = {
    id,
    title: '追溯判重',
    statement: '结构通道按追溯边判重',
    rationale: '',
    kind: 'functional',
    priority: 'must',
    status: 'baselined',
    sourceStakeholder: '',
    acceptance: [],
    version: 1,
    revision: 1,
    ambiguity: { score: 16, dimensions: {} },
    openQuestions: [],
    createdAt: '',
    updatedAt: '',
  } as unknown as Requirement
  store.writeYaml(['requirements', `${id}.yml`], { requirement })
  return requirement
}

/** 一个组件视图元素（真源形状见 `.sdo/design/component.yml`）。 */
function seedElement(designId: string, responsibility: string, name = `元素 ${designId}`): void {
  const file = store.readYaml<{ view?: { elements?: unknown[] } }>('design', 'component.yml')
  const elements = Array.isArray(file?.view?.elements) ? (file?.view?.elements as unknown[]) : []
  elements.push({ id: designId, name, kind: '组件', responsibility, dependsOn: [], requires: [] })
  store.writeYaml(['design', 'component.yml'], { view: { kind: 'component', summary: '', elements } })
}

/** 需求 → 元素的 `req-des` 边（结构通道只从这条边发现元素）。 */
function seedDesign(designId: string, responsibility = BOUND): Requirement {
  const requirement = seedRequirement()
  seedElement(designId, responsibility)
  link(store, journal, { from: requirement.id, to: designId, kind: 'req-des' })
  return requirement
}

/** 一张既有卡（用于构造"已有卡"的两种命中口径）。 */
function seedCard(id: string, title: string, status = 'done', writeScopes: string[] = ['src/domain/records.ts']): void {
  store.writeYaml(['tasks', `${id}.yml`], {
    task: {
      id, title, goal: title, inputs: [], outputs: [], dod: ['完成'], evidenceRequired: ['artifact'],
      blockedBy: [], writeScopes, role: 'developer', size: 'small', revision: 1, status,
      requirements: [], evidence: [], createdAt: '', updatedAt: '',
    },
  })
}

/** 采纳"依据即门槛"（落点二选定的拒绝口径）。 */
function adoptBasisGate(): void {
  store.writeYaml(['config.yml'], { plan: { requireCoverageBasis: true } })
}

function structuralOf(result: ReturnType<typeof decompose>): StructuralRead {
  const structural = result.structural
  assert.ok(structural !== undefined, '回执必须给出结构通道的逐条读数')
  return structural as unknown as StructuralRead
}

/**
 * 真实工具面：仿 **M101-14** 的夹具（`apply` 真的把工具注册进假 ctx；`execute` 收到仿真 `exec`）。
 *
 * 为什么非走这一层（而不是只调 `describeStructuralPlan`）：域层有数据、渲染函数印得对，
 * **都不等于**工具回执印出来了 —— 中间还隔着 `index.ts` 把 `result.structural` 传没传下去。
 */
function toolHarness(workspace: string): {
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  office: SoftwareDevOffice
  call: { sessionId: string; cwd: string }
} {
  const registered: { name: string; parameters?: { properties?: Record<string, unknown> } | undefined; execute: (args: unknown, exec: unknown) => unknown }[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: never) => { registered.push(tool as never); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 's-plan-107', cwd: workspace }
  office.noteSession(call.sessionId, workspace)
  office.init(call, { name: 'M107 工具回执', scale: 'normal', stakeholders: ['业务方'] })
  return {
    office,
    call,
    callTool: async (name, args) => {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `工具面缺少 ${name}`)
      const properties = tool.parameters?.properties ?? {}
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
      const exec = { agent: { id: call.sessionId, session: { header: { id: call.sessionId, cwd: workspace, delegationDepth: 0 } } } }
      return String(await tool.execute(filtered, exec))
    },
  }
}

/** 在真实工具面的工作区里铺真源（需求 + 元素 + `req-des` 边）。 */
function seedToolDesign(
  toolWs: string,
  designIds: (string | [string, string, string])[],
): void {
  const toolStore = new SdoStore(join(toolWs, '.sdo'))
  const toolJournal = new Journal(toolStore)
  const requirement = {
    id: 'REQ-001', title: 't', statement: 's', rationale: '', kind: 'functional', priority: 'must',
    status: 'baselined', sourceStakeholder: '', acceptance: [], version: 1, revision: 1,
    ambiguity: { score: 16, dimensions: {} }, openQuestions: [], createdAt: '', updatedAt: '',
  }
  toolStore.writeYaml(['requirements', 'REQ-001.yml'], { requirement })
  for (const entry of designIds) {
    const [designId, name, responsibility] = typeof entry === 'string' ? [entry, `元素 ${entry}`, '只写职责，不声明写范围'] : entry
    const file = toolStore.readYaml<{ view?: { elements?: unknown[] } }>('design', 'component.yml')
    const elements = Array.isArray(file?.view?.elements) ? (file?.view?.elements as unknown[]) : []
    elements.push({ id: designId, name, kind: '组件', responsibility, dependsOn: [], requires: [] })
    toolStore.writeYaml(['design', 'component.yml'], { view: { kind: 'component', summary: '', elements } })
    link(toolStore, toolJournal, { from: 'REQ-001', to: designId, kind: 'req-des' })
  }
}

// ————————————————— 四态：三态可辨（落点一）+ 依据为空不得静默建卡（落点二） —————————————————

test('M107-01 依据①：元素有 `des-task` 边 ⇒ 不生成（**覆盖证据存在**），skip 依据点名 `des-task`', () => {
  const requirement = seedDesign('DES-001')
  seedCard('TASK-901', '结构通道判重改用追溯边')
  link(store, journal, { from: 'DES-001', to: 'TASK-901', kind: 'des-task' })

  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 0, '有 des-task 边的元素不得再生成卡')
  const row = structuralOf(result).skipped.find((item) => item.designId === 'DES-001')
  assert.ok(row !== undefined, '被跳过的元素要逐条回报')
  assert.equal(row.reason, 'already-covered', '这一态是"覆盖证据存在"，不是"依据为空"')
  assert.equal(row.how, 'des-task', '命中口径必须点名（主口径：追溯边）')
  assert.notEqual(row.reason, 'no-basis', '有依据的元素绝不许落进"依据为空"那一态')
})

test('M107-02 依据②：元素只有标题 marker ⇒ 不生成（同一态的历史兜底口径），点名 `title-marker`', () => {
  const requirement = seedDesign('DES-001')
  seedCard('TASK-902', '实现 元素 DES-001（DES-001）', 'dropped')

  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 0, '标题 marker 是历史兜底：存量 dropped 卡没有追溯边，靠这条不被重造')
  const row = structuralOf(result).skipped.find((item) => item.designId === 'DES-001')
  assert.equal(row?.reason, 'already-covered', '这条同样是"覆盖证据存在"')
  assert.equal(row?.how, 'title-marker', '要点名兜底口径')
  assert.deepEqual(structuralOf(result).needsDisposition ?? [], [], '有依据的元素不得进"待裁决"清单')
})

test('M107-03 依据③：元素列入 `plan.noCardElements` ⇒ 不生成（**人已裁决无需卡**），点名 `no-card-element`', () => {
  const requirement = seedDesign('DES-001')
  store.writeYaml(['config.yml'], { plan: { noCardElements: ['DES-001'] } })

  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 0, '被显式标记「无需卡」的元素不得建卡')
  const row = structuralOf(result).skipped.find((item) => item.designId === 'DES-001')
  assert.equal(row?.reason, 'no-card-needed', '这一态是"人已裁决"，与"覆盖证据存在"必须分开')
  assert.equal(row?.how, 'no-card-element', '要点名口径来源')
  assert.deepEqual(structuralOf(result).needsDisposition ?? [], [], '已裁决过的元素不是"待裁决"')
})

test('M107-04 依据为空 + 采纳门槛 ⇒ **拒绝生成**：不落盘、不进队列，`needsDisposition` 点名元素 id 与缺哪三条依据', () => {
  const requirement = seedDesign('DES-001')
  adoptBasisGate()

  const result = decompose(store, journal, [requirement])
  // ① 不落盘：这张卡一张都不许建
  assert.equal(result.structuralCount, 0, '依据为空 ⇒ 拒绝生成（落点二选定的拒绝口径）')
  assert.deepEqual(listTasks(store), [], '被拒的卡不得落盘 —— 派发队列里也不许有任何东西')
  // ② 三态可辨：这一态是 `no-basis`，不是 `already-covered` / `no-card-needed`
  const structural = structuralOf(result)
  const row = structural.skipped.find((item) => item.designId === 'DES-001')
  assert.ok(row !== undefined, `被拒的元素要逐条点名：${JSON.stringify(structural.skipped)}`)
  assert.equal(row.reason, 'no-basis', '拒因要可机械判定，且与其它三态不同')
  // ③ 待裁决：点名元素 id 与**缺哪几条依据**
  const gaps = structural.needsDisposition ?? []
  assert.equal(gaps.length, 1, `待裁决清单要点名元素：${JSON.stringify(structural.needsDisposition)}`)
  assert.equal(gaps[0]?.designId, 'DES-001', '要点名是哪个元素')
  assert.deepEqual(gaps[0]?.missing, ['des-task', 'title-marker', 'no-card-element'], '要逐条点名缺哪三条依据（不许一句笼统的"没依据"）')
  assert.equal(structural.basisPolicy, 'required', '回执要能读出本项目走的是哪条口径')
  // ④ 台账（同一份判定的读数）：`structuralPlanOf` 现算一遍，口径必须一致
  const plan = structuralPlanOf(store, [requirement]) as unknown as StructuralRead
  assert.deepEqual(plan.needsDisposition?.map((item) => item.designId), ['DES-001'], '两处同源：`next` 现算的读数与本次 decompose 一致')
  assert.deepEqual(plan.created, [], '现算的读数同样不许有"该建"的卡')
})

test('M107-05 依据为空 + 未采纳门槛 ⇒ 落盘但**如实标注**；回执写明怎么采纳（不许静默）', () => {
  const requirement = seedDesign('DES-001')

  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 1, '未采纳门槛的项目保持历史行为（依据为空仍建卡）')
  const structural = structuralOf(result)
  assert.equal(structural.basisPolicy, 'advisory', '回执要区分"未采纳"与"已采纳"两种口径')
  assert.equal(structural.created[0]?.how, 'none', '这一态由 `how: none` 如实标出（不是默认值，是"未命中任何覆盖判定"）')

  // 回执文本：这一态必须**说出来**（旧回执把它说成"没人做 ⇒ 所以才建卡"）
  const receipt = describeStructuralPlan(result.structural)
  assert.match(receipt, /判重依据为空/u, `回执要点出「判重依据为空」这一态：${receipt}`)
  assert.match(receipt, /找不到覆盖证据/u, '回执要说明这只证明"找不到覆盖证据"，不等于"没人做"')
  assert.match(receipt, /requireCoverageBasis/u, '未采纳时要给出采纳方式')
})

test('M107-06 三态 + 依据为空**同批共存**时逐条可辨（不混同、不合并成一句）', () => {
  const requirement = seedRequirement()
  seedElement('DES-001', BOUND)
  seedElement('DES-002', BOUND)
  seedElement('DES-003', BOUND)
  seedElement('DES-004', BOUND)
  for (const designId of ['DES-001', 'DES-002', 'DES-003', 'DES-004']) {
    link(store, journal, { from: requirement.id, to: designId, kind: 'req-des' })
  }
  // ① 覆盖证据（追溯边）② 覆盖证据（标题 marker）③ 人已裁决 ④ 依据为空
  seedCard('TASK-901', '已实现的手工卡', 'done', ['src/domain/a.ts'])
  link(store, journal, { from: 'DES-001', to: 'TASK-901', kind: 'des-task' })
  seedCard('TASK-902', '实现 元素 DES-002（DES-002）', 'dropped', ['src/domain/b.ts'])
  store.writeYaml(['config.yml'], { plan: { noCardElements: ['DES-003'], requireCoverageBasis: true } })

  const result = decompose(store, journal, [requirement])
  const structural = structuralOf(result)
  const reasonOf = (designId: string): string | undefined => structural.skipped.find((item) => item.designId === designId)?.reason
  assert.equal(reasonOf('DES-001'), 'already-covered', '① 追溯边命中 ⇒ 覆盖证据存在')
  assert.equal(reasonOf('DES-002'), 'already-covered', '② 标题 marker 命中 ⇒ 同一态的另一条口径')
  assert.equal(reasonOf('DES-003'), 'no-card-needed', '③ 人已明确裁决「无需卡」⇒ 独立的一态')
  assert.equal(reasonOf('DES-004'), 'no-basis', '④ 三条依据皆无 ⇒ 判重依据为空（与前三态都不同）')
  assert.deepEqual(structural.needsDisposition?.map((item) => item.designId), ['DES-004'], '待裁决清单里只该有第④态那一个')
  assert.equal(result.structuralCount, 0, '第④态在采纳门槛下拒绝生成')

  const receipt = describeStructuralPlan(result.structural)
  for (const designId of ['DES-001', 'DES-002', 'DES-003', 'DES-004']) assert.match(receipt, new RegExp(designId, 'u'), `回执要逐条点名 ${designId}`)
  assert.match(receipt, /des-task/u, '回执要点名①命中的是追溯边')
  assert.match(receipt, /（DES-xxx）/u, '回执要点名②命中的是标题 marker')
  assert.match(receipt, /无需卡/u, '回执要点名③是「无需卡」')
  assert.match(receipt, /判重依据为空/u, '回执要点名④是「依据为空」')
})

// ————————————————— 回执/工具面：三态与出路必须印出来（落点一 + 三） —————————————————

test('M107-07 `sdo_plan action=decompose` 回执：逐条点名元素 id、缺哪条依据、三条出路与**一次性收口片段**', async () => {
  const toolWs = join(BASE, 'receipt')
  mkdirSync(toolWs, { recursive: true })
  const h = toolHarness(toolWs)
  // 元素直写真源一次（理由同 M107-11：`upsertElement` 再写一遍会覆盖职责与名字）
  seedToolDesign(toolWs, ['DES-001', 'DES-002'])
  // 采纳门槛 + DES-002 已被裁决「无需卡」⇒ 只剩 DES-001 待裁决
  const toolStore = new SdoStore(join(toolWs, '.sdo'))
  toolStore.writeYaml(['config.yml'], { plan: { requireCoverageBasis: true, noCardElements: ['DES-002'] } })

  const receipt = await h.callTool('sdo_plan', { action: 'decompose' })
  assert.match(receipt, /DES-001/u, `回执要点名待裁决的元素 id：${receipt.slice(-900)}`)
  assert.match(receipt, /待裁决/u, '回执要有"待裁决"小节（不许静默）')
  assert.match(receipt, /des-task/u, '要逐条点名缺的第一条依据：追溯边')
  assert.match(receipt, /title-marker|（DES-xxx）/u, '要逐条点名缺的第二条依据：标题 marker')
  assert.match(receipt, /noCardElements/u, '要逐条点名缺的第三条依据：`noCardElements`')
  assert.match(receipt, /sdo_trace action=link/u, '出路①：补 des-task 边（要给出可照抄的命令）')
  assert.match(receipt, /plan\.noCardElements/u, '出路②：写进 `noCardElements`')
  assert.match(receipt, /suggestions/u, '出路③：显式提卡（模型通道）')
  // **一次性收口动作**：回执里就有现成片段（把这次列出的 id 一次写进去），不是让人逐条抄
  assert.match(receipt, /noCardElements:\s*\n\s*- DES-001/u, `回执要给出一次性收口的现成片段：${receipt.slice(-900)}`)
  assert.match(receipt, /DES-002/u, '已被裁决「无需卡」的元素仍要逐条列出（三态可辨）')
  assert.doesNotMatch(receipt, /kStructural|uiIndex\./u, `不许漏出语言包键名：${receipt.slice(-400)}`)
  // 拒绝生成的元素**不得落盘**
  assert.deepEqual(h.office.tasks(h.call), [], '拒绝生成的元素一张卡都不许落盘')

  // `next` 的回执从**同一份判定**现算，同样要印出来（它是"没派出去"时的解释面）
  const nextReceipt = await h.callTool('sdo_plan', { action: 'next', backend: 'inline' })
  assert.match(nextReceipt, /DES-001/u, `next 回执也要点名待裁决元素：${nextReceipt.slice(-900)}`)
  assert.match(nextReceipt, /判重依据为空/u, 'next 回执要印出「依据为空」这一态')
})

test('M107-08 域层与渲染层同源：`describeStructuralPlan` 直接吃 `structuralPlanOf` 的读数（不许各写一套口径）', () => {
  const requirement = seedDesign('DES-001')
  adoptBasisGate()
  const receipt = describeStructuralPlan(structuralPlanOf(store, [requirement]))
  assert.match(receipt, /DES-001/u, '`next` 那条路径（现算）要能印出同一批读数')
  assert.match(receipt, /判重依据为空/u, '同一份判定的文案必须一致')
  assert.match(receipt, /拒绝生成/u, '采纳门槛下的处置要说清是"拒绝生成"')
})

// ————————————————— 落点五：回归 DEF-052 与写范围护栏 —————————————————

test('M107-09 回归 DEF-052（判重依据选错）：跟元素无关的卡（标题含 `（DES-002）`）不得让 DES-001 被跳过', () => {
  const requirement = seedRequirement()
  seedElement('DES-001', BOUND)
  seedElement('DES-002', BOUND)
  link(store, journal, { from: requirement.id, to: 'DES-001', kind: 'req-des' })
  link(store, journal, { from: requirement.id, to: 'DES-002', kind: 'req-des' })
  // 卡标题里的 marker 是 **DES-002** —— 旧实现拿标题子串当判据时，DES-001 会被误判成"已有卡"
  seedCard('TASK-903', '实现 元素 DES-002（DES-002）', 'done', ['src/domain/b.ts'])

  const result = decompose(store, journal, [requirement])
  const structural = structuralOf(result)
  assert.equal(structural.skipped.find((item) => item.designId === 'DES-001'), undefined, 'DES-001 没有任何覆盖证据，不许被别的元素的 marker 跳过')
  assert.deepEqual(structural.created.map((row) => row.designId), ['DES-001'], '该建的还是要建（本卡不许把这些元素一并拒掉）')
  assert.equal(structural.skipped.find((item) => item.designId === 'DES-002')?.how, 'title-marker', 'DES-002 才是被 marker 覆盖的那个')
  // 而"依据为空"这一态只说"找不到覆盖证据"：DES-001 走的是 advisory（未采纳门槛），不是被静默拒
  assert.equal(structural.basisPolicy, 'advisory', '未采纳门槛时不许把 DEF-052 的"该建"变成"拒"')
})

test('M107-10 回归 DEF-052（依据为空）与写范围护栏：超 3 模块 / 含 `{}` 一律拒，且拒因与「依据为空」分开', () => {
  const requirement = seedRequirement()
  seedElement('DES-001', OVERSIZED)
  seedElement('DES-002', GROUPS)
  seedElement('DES-003', BOUND)
  for (const designId of ['DES-001', 'DES-002', 'DES-003']) {
    link(store, journal, { from: requirement.id, to: designId, kind: 'req-des' })
  }
  adoptBasisGate()

  const result = decompose(store, journal, [requirement])
  const structural = structuralOf(result)
  const reasonOf = (designId: string): string | undefined => structural.skipped.find((item) => item.designId === designId)?.reason
  assert.equal(reasonOf('DES-001'), 'scope-too-broad', '10 个模块 = 授权整块重写 ⇒ 写范围护栏拒它（本卡不改这条）')
  assert.equal(reasonOf('DES-002'), 'scope-too-broad', '`{}` 展开语法 = 一张卡写一批模块 ⇒ 同样拒')
  assert.equal(reasonOf('DES-003'), 'no-basis', '1 个模块、依据为空 ⇒ 走的是"依据为空"，**不是**写范围超限（两种拒因必须分开）')
  const rejected = structural.skipped.find((item) => item.designId === 'DES-001')
  assert.deepEqual(rejected?.scopes, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts', 'src/h.ts', 'src/i.ts', 'src/j.ts'], '要点名解析出来的那个写范围')
  assert.deepEqual(structural.needsDisposition?.map((item) => item.designId), ['DES-003'], '只有"依据为空"那一个进待裁决清单')
  assert.deepEqual(listTasks(store), [], '三者都不许落盘')
})

test('M107-11 工具面回归：`sdo_plan action=decompose` 仍逐条印出写范围超限的拒因（本卡不许把它吃掉）', async () => {
  const toolWs = join(BASE, 'regress-scope')
  mkdirSync(toolWs, { recursive: true })
  const h = toolHarness(toolWs)
  // **只铺一次真源**：元素由 `seedToolDesign` 直写（`upsertElement` 再写一遍会按 id 覆盖掉
  // 这里设的职责与名字 —— 第一版就是这么把 OVERSIZED 冲掉的，别再加第二次写入）
  seedToolDesign(toolWs, [
    ['DES-001', '超宽元素', OVERSIZED],
    ['DES-002', '展开语法元素', GROUPS],
  ])
  const toolStore = new SdoStore(join(toolWs, '.sdo'))
  toolStore.writeYaml(['config.yml'], { plan: { requireCoverageBasis: true } })

  const receipt = await h.callTool('sdo_plan', { action: 'decompose' })
  assert.match(receipt, /未建卡 DES-001（超宽元素）/u, `被拒的元素要列名：${receipt.slice(-800)}`)
  assert.match(receipt, /拒绝生成/u, '拒因要印出来')
  assert.match(receipt, /src\/i\.ts/u, '要点名**解析出来的那个写范围**里的模块')
  assert.match(receipt, /未建卡 DES-002（展开语法元素）/u, '`{}` 展开语法的那条也要列名')
  assert.match(receipt, /src\/\{domain/u, '`{}` 那种要按**模板原文**回报（切出来的 `src/{domain` 才是读者要核的东西）')
  // 这两个元素都是**写范围超限**（在"依据为空"之前判）⇒ 不许落进"待裁决"小节：
  // `needsDisposition` 指的是"没有依据、等着人裁"的元素，不是"护栏拒了它"的元素
  assert.doesNotMatch(receipt, /待裁决/u, `写范围超限的元素不该进待裁决小节：${receipt.slice(-800)}`)
  assert.deepEqual(h.office.tasks(h.call), [], '被拒的元素一张卡都不许落盘')
})

test('M107-12 不为存量卡补 `des-task` 边（本卡只让判定可辨，不做数据迁移）', () => {
  const requirement = seedDesign('DES-001')
  seedCard('TASK-904', '实现 元素 DES-001（DES-001）', 'dropped')
  adoptBasisGate()
  decompose(store, journal, [requirement])
  const history = listTasks(store).find((task) => task.id === 'TASK-904')
  assert.equal(history?.status, 'dropped', 'dropped 状态原样保留')
  assert.equal(history?.title, '实现 元素 DES-001（DES-001）', '标题不被改写')
  assert.equal(
    readLinks(store).some((item) => item.kind === 'des-task' && item.to === 'TASK-904'),
    false,
    '不为存量 dropped 卡补 des-task 边（补边属另一条线，由驾驶舱另行处置）',
  )
})
