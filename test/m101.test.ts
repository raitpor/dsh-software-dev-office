/**
 * **M101：结构通道的判重口径 + 写范围护栏 + 回执逐条列名**（TASK-074 / 缺陷 DEF-052）。
 *
 * ## 病根（DEF-052，用户 2026-10-13 问「decompose 为何重复建卡、[它]是否登记」⇒ 已登记并立卡真修）
 * 旧实现用**标题子串**判「这个设计元素是否已经有卡」：
 *
 * ```ts
 * const marker = `（${designId}）`
 * const history = listTasks(store).filter((task) => task.title.includes(marker))
 * if (history.length > 0) continue
 * ```
 *
 * 两个方向都会错：
 *   · **漏判** —— 手工功能卡的标题不带 `（DES-xxx）` 标记（本仓绝大多数卡如此）⇒ 已实现的元素被判成
 *     「没人做」，重复生成「实现 X（DES-yyy）」卡。真机实测：三次 `decompose` 造出 TASK-069（写范围被
 *     解析成 **10 个模块**）与 TASK-070（写范围是不存在的模板目录），而 TASK-069 的写范围含
 *     `src/domain/plan.ts`，一度把真修卡 TASK-071 堵在派发队列外。
 *   · **误判** —— 任何标题里**恰好含**该串的卡都会算覆盖（哪怕它跟这个元素毫无关系）。
 *
 * 插件**自己就有**为这件事准备的第一类关系：追溯图的 `des-task` 边（同一个函数已在读 `readLinks`）。
 * 用标题子串替代追溯边是本末倒置，也与 C-21（覆盖率按边算）口径不一致。
 *
 * ## 本文件的断言面（卡上落点四 + 一条）
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | 元素有 `des-task` 追溯边 | **不生成**（主口径），skip 依据点名 `des-task` |
 * | ② | 元素只有「标题带 marker 的 dropped 卡」 | **不生成**（G-04 既有意图回归：放弃越多噪声越多） |
 * | ③ | 元素无任何覆盖 | 生成，且回执**按名字列出**该卡与写范围（不得只给数量） |
 * | ④ | 派生写范围超限（> 3 个模块 / 含 `{}` 展开语法） | **拒绝生成并点名**元素与解析出的写范围 |
 * | ⑤ | `config.yml` 的 `plan.noCardElements` 命中 | 不生成（另有 `noCardElements` 的 OR 分支用例） |
 *
 * 另加 `test/m101.test.ts` 单列的一条反例：模板里带 `{}`（`src/{a,b}/`）一律拒 —— 展开语法会把
 * 「一张卡写一个模块」变成「一张卡写一批模块」，与护栏的意图相反。
 *
 * 纪律与其它 m* 用例一致：夹具只写真源（`.sdo/` 下的 yml / links.jsonl），断言读**结构化结果**与
 * **盘上真源**，不读自述文案；既有 dropped 卡的历史不改写（本文件只**读**它们的形态）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { decompose, listTasks } from '../src/domain/plan.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import { describePlan, describeStructuralPlan } from '../src/interface/describe.js'
import { link, readLinks } from '../src/domain/trace.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import type { SdoConfig } from '../src/config.js'
import type { Requirement } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m101/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  store = new SdoStore(join(WORKSPACE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

const BOUND = '写范围：src/domain/trace.ts、src/domain/plan.ts、src/types.ts（独占）'
const OVERSIZED = '写范围：src/a.ts、src/b.ts、src/c.ts、src/d.ts、src/e.ts、src/f.ts、src/g.ts、src/h.ts、src/i.ts、src/j.ts（独占）'
const GROUPS = '写范围：src/{domain,interface}/、src/{a,b}/（独占）'

/** 写一份已基线的需求真源（结构通道的输入）。 */
function seedRequirement(): Requirement {
  const requirement = {
    id: 'REQ-001',
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
  store.writeYaml(['requirements', 'REQ-001.yml'], { requirement })
  return requirement
}

/** 写一个组件视图元素（真源形状见 `.sdo/design/component.yml`）。 */
function seedElement(designId: string, responsibility: string): void {
  const file = store.readYaml<{ view?: { elements?: unknown[] } }>('design', 'component.yml')
  const elements = Array.isArray(file?.view?.elements) ? (file?.view?.elements as unknown[]) : []
  elements.push({ id: designId, name: `元素 ${designId}`, kind: '组件', responsibility, dependsOn: [], requires: [] })
  store.writeYaml(['design', 'component.yml'], { view: { kind: 'component', summary: '', elements } })
}

/** 建需求 → 元素的追溯边（结构通道只认这条边）。 */
function seedDesign(designId: string, responsibility = BOUND): Requirement {
  const requirement = seedRequirement()
  seedElement(designId, responsibility)
  link(store, journal, { from: requirement.id, to: designId, kind: 'req-des' })
  return requirement
}

/**
 * 拆一遍，并把**落点三要求的回执数据**取出来。
 *
 * 返回类型**故意退化**成"结构形状 + `undefined`"（而不是 `StructuralPlan`）：修复前域层
 * 根本不返回这条数据 ⇒ 断言给出的是「回执没有逐条列名」这句缺陷症状本身，而不是一句类型错误。
 */
function structuralOf(result: ReturnType<typeof decompose>):
  | {
      created: { designId: string; title: string; writeScopes: string[]; how: string }[]
      skipped: { designId: string; name: string; reason: string; how?: string | undefined; scopes?: string[] | undefined }[]
    }
  | undefined {
  return result.structural
}

/** 生成一张卡（不经过结构通道），用于构造"已有人做过"的形态。 */
function seedCard(id: string, title: string, status = 'dropped', writeScopes: string[] = ['src/domain/plan.ts']): void {
  store.writeYaml(['tasks', `${id}.yml`], {
    task: {
      id, title, goal: title, inputs: [], outputs: [], dod: ['完成'], evidenceRequired: ['artifact'],
      blockedBy: [], writeScopes, role: 'developer', size: 'small', revision: 1, status,
      requirements: [], evidence: [], createdAt: '', updatedAt: '',
    },
  })
}

// ————————————————————————————— 覆盖判定（落点一） —————————————————————————————

test('M101-01 元素有 `des-task` 追溯边 ⇒ 不生成卡（主口径），且 skip 依据点名 `des-task`', () => {
  const requirement = seedDesign('DES-001')
  // 已实现、无 marker 标题的手工功能卡：旧实现判不出它已经做了这个元素（DEF-052 的漏判方向）
  seedCard('TASK-901', '结构通道判重改用追溯边', 'done')
  link(store, journal, { from: 'DES-001', to: 'TASK-901', kind: 'des-task' })

  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 0, '有 des-task 边的元素不得再生成卡（主口径）')
  assert.equal(listTasks(store).filter((task) => task.status !== 'dropped').length, 1, '不得新建任何卡')
  const structural = structuralOf(result)
  assert.ok(structural !== undefined, '回执必须给出结构通道的逐条明细')
  assert.deepEqual(structural.created, [], '本次没有生成结构卡')
  const skipped = structural.skipped.find((item) => item.designId === 'DES-001')
  assert.ok(skipped !== undefined, `被跳过的元素要逐条回报：${JSON.stringify(structural.skipped)}`)
  assert.equal(skipped.reason, 'already-covered', '跳过原因要可机械判定')
  assert.equal(skipped.how, 'des-task', '命中判定必须点名是哪一条口径（追溯边）')
})

test('M101-02 元素只有「标题带 marker 的 dropped 卡」⇒ 仍不生成（G-04 既有意图回归）', () => {
  const requirement = seedDesign('DES-001')
  seedCard('TASK-902', '实现 元素 DES-001（DES-001）')

  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 0, '标题 marker 是历史兜底：本仓 23 张 dropped 的「实现 X（DES-yyy）」卡没有 des-task 边')
  const structural = structuralOf(result)
  assert.ok(structural !== undefined, '回执必须给出结构通道的逐条明细')
  assert.equal(structural.skipped.find((item) => item.designId === 'DES-001')?.how, 'title-marker', '要点名兜底口径')
})

test('M101-03 `.sdo/config.yml` 的 `plan.noCardElements` 命中 ⇒ 不生成（显式「无需卡」）', () => {
  const requirement = seedDesign('DES-001')
  store.writeYaml(['config.yml'], { plan: { noCardElements: ['DES-001'] } })

  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 0, '被显式标记「无需卡」的元素不得建卡')
  const structural = structuralOf(result)
  assert.ok(structural !== undefined, '回执必须给出结构通道的逐条明细')
  assert.equal(structural.skipped.find((item) => item.designId === 'DES-001')?.how, 'no-card-element', '要点名口径来源')
})

test('M101-04 覆盖判定是「三选一」的 OR：只有 des-task 边命中的元素不生成，其余照常生成', () => {
  const requirement = seedRequirement()
  seedElement('DES-001', BOUND)
  seedElement('DES-002', BOUND)
  link(store, journal, { from: requirement.id, to: 'DES-001', kind: 'req-des' })
  link(store, journal, { from: requirement.id, to: 'DES-002', kind: 'req-des' })
  seedCard('TASK-903', '已实现的元素之一', 'done', ['src/domain/records.ts'])
  link(store, journal, { from: 'DES-001', to: 'TASK-903', kind: 'des-task' })

  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 1, '只有未被覆盖的那个元素该生成卡')
  const generated = listTasks(store).filter((task) => task.status !== 'dropped')
  assert.equal(generated.length, 2, '夹具里的既有卡 + 新生成的一张')
  const fresh = generated.find((task) => task.id !== 'TASK-903')
  assert.ok(fresh !== undefined, '新卡要真的落盘')
  assert.match(fresh.title, /DES-002/u, `生成的是未被覆盖的那个元素：${fresh.title}`)
})

// ————————————————————————————— 写范围护栏（落点二） —————————————————————————————

test('M101-05 派生写范围超限（10 个模块）⇒ 拒绝生成并点名元素与解析出的写范围', () => {
  const requirement = seedDesign('DES-001', OVERSIZED)
  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 0, '超限的写范围（10 个模块）= 授权整块重写，必须拒绝生成该卡')
  assert.equal(listTasks(store).length, 0, '被拒的卡不得落盘')

  const structural = structuralOf(result)
  assert.ok(structural !== undefined, '回执必须给出结构通道的逐条明细')
  const rejected = structural.skipped.find((item) => item.designId === 'DES-001')
  assert.ok(rejected !== undefined, `被拒的元素要逐条点名：${JSON.stringify(structural.skipped)}`)
  assert.equal(rejected.reason, 'scope-too-broad', '拒因要可机械判定')
  assert.deepEqual(
    rejected.scopes,
    ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts', 'src/h.ts', 'src/i.ts', 'src/j.ts'],
    '回执要点名"解析出来的那个写范围"本身（否则读者不知道是什么被拒了）',
  )
})

test('M101-06 派生写范围含 `{}` 展开语法 ⇒ 拒绝生成（展开语法 = 一张卡写一批模块）', () => {
  const requirement = seedDesign('DES-001', GROUPS)
  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 0, '模板变量残留（`{}` 展开语法）一律拒')
  const structural = structuralOf(result)
  assert.ok(structural !== undefined, '回执必须给出结构通道的逐条明细')
  assert.equal(structural.skipped.find((item) => item.designId === 'DES-001')?.reason, 'scope-too-broad')
})

test('M101-07 未超限的派生写范围照常建卡（护栏不误伤正常元素）', () => {
  const requirement = seedDesign('DES-001', BOUND)
  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 1)
  const task = listTasks(store)[0]
  assert.deepEqual(task?.writeScopes, ['src/domain/trace.ts', 'src/domain/plan.ts', 'src/types.ts'], '声明式写范围原样使用')
})

// ————————————————————————————— 回执逐条列名（落点三） —————————————————————————————

test('M101-08 回执逐条列出本次生成的结构卡：标题（含设计 id）+ 写范围 + 判定依据', () => {
  const requirement = seedDesign('DES-001')

  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 1)
  const structural = structuralOf(result)
  assert.ok(structural !== undefined, '回执不得只给一个数量（D-12 症状）—— 必须逐条列出')
  assert.equal(structural.created.length, 1, '逐个元素一条')
  const row = structural.created[0]
  assert.ok(row !== undefined)
  assert.equal(row.designId, 'DES-001', '标题要能看出对应哪个设计 id')
  assert.match(row.title, /DES-001/u, `卡标题含设计 id：${row.title}`)
  assert.deepEqual(row.writeScopes, ['src/domain/trace.ts', 'src/domain/plan.ts', 'src/types.ts'], '写范围要印出来')
  assert.equal(row.how, 'none', '未命中任何覆盖判定（这才叫"没有依据可跳过"）')

  // 逐条列名要对应**真的落盘**的那张卡（不是回执里凭空写的字符串）
  const created = listTasks(store)[0]
  assert.equal(created?.title, row.title, '回执里的标题必须与盘上真源一致')
  assert.deepEqual(created?.writeScopes, row.writeScopes, '回执里的写范围必须与盘上真源一致')
})

// ————————————————————————————— 护栏的假阳性（反向自证） —————————————————————————————

test('M101-09 模板里的 `{}` 由 config.yml 的 scopeTemplate 注入时同样被拒（口径不靠元素职责文本）', () => {
  const requirement = seedDesign('DES-001', '只写职责，不声明写范围')
  store.writeYaml(['config.yml'], { plan: { scopeTemplate: 'src/{domain,interface}/,src/{a,b}/' } })
  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 0, '模板来源的展开语法同样超限')
  const structural = structuralOf(result)
  assert.ok(structural !== undefined, '回执必须给出结构通道的逐条明细')
  const rejected = structural.skipped.find((item) => item.designId === 'DES-001')
  assert.equal(rejected?.reason, 'scope-too-broad')
  assert.deepEqual(
    rejected?.scopes,
    ['src/{domain,interface}/,src/{a,b}/'],
    '要点名**模板原文**：`{}` 里的逗号会让"解析结果"变成伪影（`src/{a` + `b}/`），读者要核的是他写下的那串模板',
  )
})

test('M101-10 `noCardElements` 与 `scopeTemplate` 同读一份 `plan` 段：互不干扰', () => {
  const requirement = seedDesign('DES-001', '只写职责，不声明写范围')
  store.writeYaml(['config.yml'], {
    plan: { noCardElements: ['DES-777'], scopeTemplate: 'src/core/,src/domain/' },
  })
  const result = decompose(store, journal, [requirement])
  assert.equal(result.structuralCount, 1, '未命中 noCardElements 的元素照常生成')
  assert.deepEqual(listTasks(store)[0]?.writeScopes, ['src/core/', 'src/domain/'], 'scopeTemplate 照旧生效')
})

test('M101-11 存量 dropped 卡的历史不被改写（本卡只让判定兼容它们）', () => {
  const requirement = seedDesign('DES-001')
  seedCard('TASK-904', '实现 元素 DES-001（DES-001）')
  decompose(store, journal, [requirement])
  const history = listTasks(store).find((task) => task.id === 'TASK-904')
  assert.equal(history?.status, 'dropped', 'dropped 状态原样保留')
  assert.equal(history?.title, '实现 元素 DES-001（DES-001）', '标题不被改写')
  assert.equal(
    readLinks(store).some((item) => item.kind === 'des-task' && item.to === 'TASK-904'),
    false,
    '不为存量 dropped 卡补 des-task 边（那是数据迁移，另有其卡）',
  )
})

// ————————————————————————————— 回执渲染（落点三的"印出来"那一半） —————————————————————————————

/**
 * 回执夹具：一个工作站 + 一个办公室实例（走**真实**的 `planDecompose` 与回执渲染函数）。
 *
 * 为什么这一层非测不可：域层给出结构数据**不等于**回执印出来了 —— 旧实现的病灶正是
 * "域层算得出、回执只印一个数量"（D-12 / DEF-052），只有断言到**回执文本**才算钉住。
 */
function openOffice(workspace: string): { office: SoftwareDevOffice; call: { sessionId: string; cwd: string }; workspace: string } {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-receipt', workspace)
  office.init({ sessionId: 's-receipt', cwd: workspace }, { name: 'M101 回执', scale: 'normal', stakeholders: ['业务方'] })
  return { office, call: { sessionId: 's-receipt', cwd: workspace }, workspace }
}

function seedReceiptDesign(office: SoftwareDevOffice, call: { sessionId: string; cwd: string }, designId: string, responsibility = '只写职责，不声明写范围'): void {
  office.upsertElement(call, { kind: 'component', id: designId, name: `元素 ${designId}`, elementKind: 'component', responsibility })
}

function receiptWorkspace(name: string): string {
  const dir = join(BASE, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

test('M101-12 回执逐条印出结构卡：标题（含设计 id）+ 写范围 + 判定依据；被拒的印元素 + 写范围 + 拒因', () => {
  const ws = receiptWorkspace('recv')
  const { office, call } = openOffice(ws)
  seedReceiptDesign(office, call, 'DES-001')
  const bare = { id: 'REQ-001', title: 't', statement: 's', rationale: '', kind: 'functional', priority: 'must', status: 'baselined', sourceStakeholder: '', acceptance: [], version: 1, revision: 1, ambiguity: { score: 16, dimensions: {} }, openQuestions: [], createdAt: '', updatedAt: '' } as unknown as Requirement
  const store = new SdoStore(join(ws, '.sdo'))
  const journal = new Journal(store)
  store.writeYaml(['requirements', 'REQ-001.yml'], { requirement: bare })
  link(store, journal, { from: 'REQ-001', to: 'DES-001', kind: 'req-des' })
  const result = office.planDecompose(call, {})
  const receipt = describeStructuralPlan(result.structural)

  // ① 标题（含设计 id）② 写范围 ③ 判定依据 —— 逐条，不许只给数量
  assert.match(receipt, /元素 DES-001/u, `回执要印元素名：${receipt}`)
  assert.match(receipt, /DES-001/u, '回执要印设计 id（标题里那个）')
  assert.match(receipt, /src\/des-001\//u, `回执要印写范围：${receipt}`)
  assert.match(receipt, /未命中任何覆盖判定/u, `回执要印判定依据（凭哪条覆盖判定跳过/建卡）：${receipt}`)
  assert.doesNotMatch(receipt, /uiIndex\.kStructural/u, `不许漏出键名：${receipt}`)
  // 计划正文里也要带上这一节（否则"回执印出来了"只是本函数自己说的）
  const summary = office.planDecompose(call, {}).tasks.length
  assert.equal(summary, 1, '第一遍拆出一张卡')
  const full = describePlan(office.tasks(call), office.planIssues(call), [], result.structural)
  assert.match(full, /DES-001/u, '看板与结构块同源，不能一个有一个没有')
})

test('M101-13 被拒的元素与未建卡的原因都要印：元素名 + 解析出的写范围 + 拒因；覆盖命中的印依据', () => {
  const ws = receiptWorkspace('recv2')
  const { office, call } = openOffice(ws)
  seedReceiptDesign(office, call, 'DES-001')
  seedReceiptDesign(office, call, 'DES-002', OVERSIZED)
  const requirement = { id: 'REQ-002', title: 't', statement: 's', rationale: '', kind: 'functional', priority: 'must', status: 'baselined', sourceStakeholder: '', acceptance: [], version: 1, revision: 1, ambiguity: { score: 16, dimensions: {} }, openQuestions: [], createdAt: '', updatedAt: '' } as unknown as Requirement
  const store = new SdoStore(join(ws, '.sdo'))
  const journal = new Journal(store)
  store.writeYaml(['requirements', 'REQ-002.yml'], { requirement })
  link(store, journal, { from: 'REQ-002', to: 'DES-001', kind: 'req-des' })
  link(store, journal, { from: 'REQ-002', to: 'DES-002', kind: 'req-des' })
  // DES-001 先建卡（第一遍）⇒ 第二遍应判"已有卡"并印依据
  office.planDecompose(call, {})
  const second = office.planDecompose(call, {})
  const receipt = describeStructuralPlan(second.structural)
  assert.match(receipt, /DES-001/u, '被覆盖的元素也要列名')
  assert.match(receipt, /已有卡/u, `要印未建卡的原因：${receipt}`)
  assert.match(receipt, /标记「（DES-xxx）」/u, '要印命中的是哪条覆盖口径（历史兜底那条）')
  assert.match(receipt, /DES-002/u, '被拒的元素要列名')
  assert.match(receipt, /拒绝生成/u, `要印拒因：${receipt}`)
  assert.match(receipt, /src\/e\.ts/u, '要印**解析出来的那个写范围**（否则读者不知道是什么被拒了）')
})

/**
 * **工具层回执**（TASK-074 落点三的最终判据）：走**真实注册的 `sdo_plan`**，断言拿到的那串文本。
 *
 * 为什么必须到这一层：域层有数据、渲染函数也能单独印对，**都不等于**工具回执印出来了 ——
 * 中间还隔着 `index.ts` 把 `result.structural` 传没传下去。实测：把 `describePlan(..., result.structural)`
 * 改回 `undefined`（本卡的第二号变异体）时，只测渲染函数的用例**照样全绿**（变异体存活）⇒
 * 断言必须落在工具真正返回的那串文本上，否则"回执列名"这件事没有被钉住。
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
  const call = { sessionId: 's-plan', cwd: workspace }
  office.noteSession(call.sessionId, workspace)
  office.init(call, { name: 'M101 工具回执', scale: 'normal', stakeholders: ['业务方'] })
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

test('M101-14 sdo_plan action=decompose 的**回执文本**逐条列名（标题 + 写范围 + 判定依据），被拒的印元素 + 写范围 + 拒因', async () => {
  const ws = receiptWorkspace('tool')
  const h = toolHarness(ws)
  seedReceiptDesign(h.office, h.call, 'DES-001')
  seedReceiptDesign(h.office, h.call, 'DES-002', OVERSIZED)
  const requirement = { id: 'REQ-003', title: 't', statement: 's', rationale: '', kind: 'functional', priority: 'must', status: 'baselined', sourceStakeholder: '', acceptance: [], version: 1, revision: 1, ambiguity: { score: 16, dimensions: {} }, openQuestions: [], createdAt: '', updatedAt: '' } as unknown as Requirement
  const store = new SdoStore(join(ws, '.sdo'))
  const journal = new Journal(store)
  store.writeYaml(['requirements', 'REQ-003.yml'], { requirement })
  link(store, journal, { from: 'REQ-003', to: 'DES-001', kind: 'req-des' })
  link(store, journal, { from: 'REQ-003', to: 'DES-002', kind: 'req-des' })

  const receipt = await h.callTool('sdo_plan', { action: 'decompose' })
  assert.match(receipt, /结构通道：本次生成 1 张卡、1 个元素未建卡/u, `回执要有结构通道的逐条小节：${receipt.slice(-700)}`)
  assert.match(receipt, /结构卡「实现 元素 DES-001（DES-001）」（设计 id DES-001）｜写范围：src\/des-001\/、test\/des-001\//u, '① 卡标题（含设计 id）+ ② 写范围要逐条印')
  assert.match(receipt, /写范围：src\/des-001\//u, '② 写范围要印出来')
  assert.match(receipt, /未命中任何覆盖判定/u, '③ 判定依据要印出来')
  assert.match(receipt, /未建卡 DES-002（元素 DES-002）/u, '被拒的元素要列名')
  assert.match(receipt, /拒绝生成/u, '拒因要印出来')
  assert.match(receipt, /src\/i\.ts/u, '要点名**解析出来的那个写范围**里的模块')
  assert.doesNotMatch(receipt, /kStructural|uiIndex\./u, `不许漏出键名：${receipt.slice(-400)}`)

  // `sdo_plan action=next` 的回执同样要逐条列名（卡片的写范围/判定依据在拆卸后仍看得到）
  const nextReceipt = await h.callTool('sdo_plan', { action: 'next', backend: 'inline' })
  assert.match(nextReceipt, /未建卡 DES-001（元素 DES-001）/u, `next 回执也要列出这批结构卡：${nextReceipt.slice(-600)}`)
  assert.match(nextReceipt, /已有卡/u, 'next 回执要说明"这张卡已经建过了"')
  assert.match(nextReceipt, /未建卡 DES-002（元素 DES-002）/u, 'next 回执也要列被拒的元素')
})
