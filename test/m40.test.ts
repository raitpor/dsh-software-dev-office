/**
 * rpsidease-reboren 第二份真机报告里**上一轮明确留待下一批**的四条（SDO-19 检测半 / SDO-24 / SDO-28 / SDO-30）。
 *
 *   · **SDO-19（过松那一面）**：直接 `write`/`edit` 改 `.sdo/` 真源此前**不产生任何事件** ⇒ 既不掀 G3 签字、
 *     也不让 `DESIGN.md` 判陈旧；同一机制还被用来整篇覆盖真源（事故 SDO-26）。现在写成功后落
 *     `truth/file-written`（含 sha256），并把它列进「会改文档」的事件表。
 *   · **SDO-24**：`DESIGN.md` 的元素条目只写「ID｜名称（类型）｜来源需求｜置信度」，**证明不了真源变更
 *     在文档里可见**（真机上架构师改的 6 处职责正文零命中）。现在把职责正文与契约 `schema` 正文渲染进去。
 *   · **SDO-28**：报告说 `adr supersede` 不在旧记录留指针、不发事件 —— 本轮**核实为已实现**（反证），
 *     这里把两条事实钉成回归，防止将来被改回去。
 *   · **SDO-30**：派发固定按 `size → id` 排序 ⇒ 关键小卡排在同类卡之后反复被跳过（新卡饿死）。
 *     现在按「最近派发时间」升序（**没派过的排最前**），同时间再按 id。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { DESIGN_DOC_SOURCE_EVENTS, isSignatureInvalidatingEvent } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm40')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function card(id: string): TaskCard {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
  return task
}

test('SDO-19：直接改 `.sdo/` 真源要记 `truth/file-written`（含 sha256），并让 G3 签字失效 + `DESIGN.md` 判陈旧', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }
  mkdirSync(join(BASE, '.sdo', 'design'), { recursive: true })
  store.writeText(['design', 'component.yml'], 'view:\n  kind: component\n', { mode: 0o600 })

  const recorded = office.noteTruthFileWrites(call, ['.sdo/design/component.yml', 'src/not-truth.ts', '.sdo/evidence/x.jsonl'])
  assert.equal(recorded, 1, '只记 `.sdo/` 下的真源（非真源路径与 evidence/ 都不记）')
  const events = journal.read().events.filter((event) => event.type === 'truth/file-written')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.data.path, '.sdo/design/component.yml')
  assert.match(String(events[0]?.data.sha256 ?? ''), /^[0-9a-f]{64}$/u, '要带内容指纹（可定位是哪次写覆盖的）')

  // 两面都堵上：① 不在中性表里 ⇒ G3 签字失效；② 列进"会改文档" ⇒ C-25 判陈旧
  assert.equal(isSignatureInvalidatingEvent('G3', 'truth/file-written'), true, '直接改真源必须掀 G3 签字')
  assert.equal((DESIGN_DOC_SOURCE_EVENTS as readonly string[]).includes('truth/file-written'), true, '也必须让文档判陈旧')
  // 反向：仍不认非真源事件（口径不许放宽）
  assert.equal(isSignatureInvalidatingEvent('G3', 'design/rendered'), false)

  // 接线：必须在**写成功之后**记录（pre 阶段把"被拒的写"记成真源变更是另一种撒谎）
  const index = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.match(index, /'tools\/post-execute'/u, '要在 post-execute 阶段记录')
  assert.match(index, /office\.noteTruthFileWrites\(postCall, changed\)/u)
  // **R2（复审 major）**：宿主明确「tool failures still receive post-execute」⇒ 写失败不得记账
  assert.match(index, /isError === true/u, 'post 钩子必须判 isError')
  assert.match(index, /truthFileHash/u, '内容没变的重写不得记账（pre/post 哈希比对）')
})

test('SDO-24：`DESIGN.md` 渲染出元素**职责正文**与契约 **schema 正文**（人审文档要能自证内容）', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }
  const element = office.upsertElement(call, {
    kind: 'component',
    id: 'DES-CMP-901',
    name: '站票配额组件',
    responsibility: '职责正文：把站票配额按（车次, 车厢）落库并在订单侧可回读',
    requires: ['REQ-001'],
    confidence: 'high',
  })
  assert.equal(element.created, true)
  store.writeYaml(['requirements', 'REQ-001.yml'], { requirement: { id: 'REQ-001', title: 'R', kind: 'functional', statement: 's', rationale: 'r', status: 'draft' } })

  const contract = office.recordContract(call, {
    id: 'CT-901',
    name: '站票占用',
    kind: 'rpc',
    producer: 'DES-CMP-901',
    consumer: 'DES-CMP-901',
    schema: 'schema 正文：{ trainRunId, carriage, sold, capacity }',
    failureSemantics: { timeout: '5s' },
  })
  assert.match(contract.id, /^CT-/u)

  const rendered = office.renderDesign(call)
  const doc = readFileSync(join(BASE, rendered.path), 'utf8')
  assert.match(doc, /职责正文：把站票配额按（车次, 车厢）落库/u, '元素条目要带职责正文（真机上 6 处职责在文档里零命中）')
  assert.match(doc, /schema 正文：\{ trainRunId, carriage, sold, capacity \}/u, '契约条目要带 schema 正文')
})

test('SDO-28（反证）：`adr supersede` **已经**在旧记录留 `supersededBy` 且发事件 —— 报告所述"不留指针、不发事件"是手改真源造成的', () => {
  const source = readFileSync(new URL('../../src/domain/adr.ts', import.meta.url), 'utf8')
  assert.match(source, /writeAdr\(store, \{ \.\.\.previous, status: 'superseded', supersededBy: adr\.id \}\)/u, '旧记录要留指针')
  assert.match(source, /journal\.append\('adr\/recorded', \{ id: previous\.id, supersededBy: adr\.id \}\)/u, '要发事件')
})

test('SDO-30：派发对"最近派过"的卡置后 —— 没派过的小卡优先（真机上关键卡被同类卡挤掉只能人肉指派）', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }
  office.init(call, { process: 'waterfall' })
  journal.append('phase/entered', { phase: 'construction' })
  card('TASK-001')
  card('TASK-002')
  // TASK-001 已经派过一次并结算（但它仍是 ready —— 例如被 release 回来）
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'c1', tools: 9, role: 'developer', mode: 'continuable' })
  journal.append('dispatch/finished', { childSessionId: 'c1', task: 'TASK-001', role: 'developer', turn: 1, reason: 'completed' })

  const plan = office.poolPlan(call, { reuseIdle: true })
  assert.equal(plan.dispatch[0]?.task.id, 'TASK-002', `没派过的卡要排最前（否则新卡饿死）：${plan.dispatch.map((item) => item.task.id).join(' ')}`)
  assert.equal(plan.dispatch[1]?.task.id, 'TASK-001', '派过的排后面')

  // 反向：没有任何派发历史时，顺序 = 卡面顺序（不许把既有排序完全打乱）
  rmSync(join(BASE, '.sdo', 'evidence'), { recursive: true, force: true })
  const fresh = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const BASE2 = join(ROOT, 'node_modules', '.sdo-test', 'm40-fresh')
  rmSync(BASE2, { recursive: true, force: true })
  mkdirSync(join(BASE2, '.sdo', 'tasks'), { recursive: true })
  const store2 = new SdoStore(join(BASE2, '.sdo'))
  const journal2 = new Journal(store2)
  const call2 = { sessionId: 'cockpit', cwd: BASE2 }
  fresh.init(call2, { process: 'waterfall' })
  journal2.append('phase/entered', { phase: 'construction' })
  for (const id of ['TASK-001', 'TASK-002']) {
    store2.writeYaml(['tasks', `${id}.yml`], { task: { ...card(id), writeScopes: [`src/${id}/`] } })
  }
  const noHistory = fresh.poolPlan(call2, { reuseIdle: true })
  assert.deepEqual(noHistory.dispatch.map((item) => item.task.id), ['TASK-001', 'TASK-002'], '无历史时保持原有顺序')
  rmSync(BASE2, { recursive: true, force: true })
})
