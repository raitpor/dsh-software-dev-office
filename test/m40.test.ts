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

// ————————————————————————————————————————————————————————————————
// TASK-021（REQ-055 / REQ-057）：变异读数复用 · 存活变异体逐条处置 · 缺陷根因/发现级别/逃逸
//
// 上面四条是本文件原有的 SDO-19/24/28/30 回归，**不动**；以下是本卡新增的守卫。
// ————————————————————————————————————————————————————————————————

import { readFileSync as sysReadFileSync, writeFileSync } from 'node:fs'
import { hashArtifact, recordDefect, listDefects, DEFECT_DISCOVERY_LEVELS } from '../src/domain/records.js'
import {
  DISPOSITION_RULES,
  DISPOSITION_SCOPE_RULE,
  MUTATION_DISPOSITIONS,
  assessCoverageItem,
  assessMutation,
  assessMutationItem,
  resolveDisposition,
} from '../src/domain/mutation.js'
import { validateTestingSource } from '../src/domain/testingShapes.js'
import { TESTING_DISPOSITIONS } from '../src/types.js'
import type { MutationRecord } from '../src/domain/construction.js'

/** 本卡专用的隔离工作区（与上面四条各用各的，互不踩）。 */
const M21 = join(ROOT, 'node_modules', '.sdo-test', 'm40-task021')

function ws21(): { store: SdoStore; journal: Journal; dir: string } {
  rmSync(M21, { recursive: true, force: true })
  mkdirSync(join(M21, '.sdo', 'construction'), { recursive: true })
  const s = new SdoStore(join(M21, '.sdo'))
  const j = new Journal(s)
  return { store: s, journal: j, dir: M21 }
}

/** 实现侧落下的变异记录（`.sdo/construction/tdd.yml`）：**唯一一份真相**，读数复用这一份。 */
function writeMutationLedger(store: SdoStore, records: readonly Partial<MutationRecord>[]): string {
  store.writeYaml(['construction', 'tdd.yml'], {
    mutation: records.map((item) => ({
      task: item.task ?? 'TASK-021',
      tool: item.tool ?? 'node --test lib/test/m40.test.js',
      target: item.target ?? 'src/domain/mutation.ts',
      killed: item.killed ?? 0,
      survived: item.survived ?? 0,
      at: item.at ?? '2026-10-13T00:00:00.000Z',
    })),
  })
  return hashArtifact(M21, '.sdo/construction/tdd.yml')
}

test('M40-21a 变异读数**复用**实现侧的记录：按产物哈希绑定，不重跑也算有效（AC-215）', () => {
  const { store } = ws21()
  writeFileSync(join(M21, 'art.txt'), 'v1\n', 'utf8')
  const artifactHash = hashArtifact(M21, 'art.txt')
  const ledgerHash = writeMutationLedger(store, [{ killed: 9, survived: 1 }])
  const before = hashArtifact(M21, '.sdo/construction/tdd.yml')

  // **关键**：调用方只给"读数 + 工作区"，变异记录由本模块**现读**（同源，不另造一份）
  const assessed = assessMutation({
    workspace: M21,
    store,
    source: {
      killRate: '90%',
      threshold: '80%',
      record: '.sdo/construction/tdd.yml',
      recordHash: ledgerHash,
      artifact: 'art.txt',
      artifactHash,
      survived: [{ id: 'MU-001', disposition: '补用例', useCase: 'TC-049' }],
    },
    knownCaseIds: ['TC-049'],
  })
  assert.equal(assessed.present, true)
  assert.equal(assessed.outcome, 'ok', `读数可用（复用的产物与记录都还对得上）：${JSON.stringify(assessed.issues)}`)
  assert.deepEqual(assessed.issues, [])
  assert.deepEqual(assessed.killRate, { killed: 9, surviving: 1, total: 10, ratio: 0.9 }, 'kill 率按测试者口径**现算**')
  assert.deepEqual(assessed.unsettled, [], '存活变异体已逐条处置 ⇒ 无未处置项')
  assert.equal(assessed.reused.records, 1, '复用到了哪几条记录要能印出来')
  assert.equal(assessed.reused.fromCaller, false, '这一次是**现读**实现侧那份（同源路径）')
  assert.equal(assessed.survived[0]?.outcome, 'ok')
  // 复用意味着**没有重跑**：记录文件一个字节都没动
  assert.equal(hashArtifact(M21, '.sdo/construction/tdd.yml'), before, '复用不得改动变异记录（读判定是只读的）')
})

test('M40-21b 产物一改 ⇒ 读数判 `stale` 并要求重跑，不得用旧读数充数（AC-217）', () => {
  const { store } = ws21()
  writeFileSync(join(M21, 'art.txt'), 'v1\n', 'utf8')
  const recorded = hashArtifact(M21, 'art.txt')
  const ledgerHash = writeMutationLedger(store, [{ killed: 9, survived: 0 }])
  writeFileSync(join(M21, 'art.txt'), 'v2\n', 'utf8') // 产物变了（这就是"另一版"）

  const assessed = assessMutation({
    workspace: M21,
    store,
    source: { killRate: '100%', threshold: '80%', record: '.sdo/construction/tdd.yml', recordHash: ledgerHash, artifact: 'art.txt', artifactHash: recorded, survived: [] },
  })
  assert.equal(assessed.outcome, 'stale', `产物改了就必须判过期：${JSON.stringify(assessed.issues)}`)
  assert.ok(assessed.issues.some((issue) => issue.code === 'artifact-stale'), '要点名 `artifact-stale`')
  assert.match(assessed.issues.find((issue) => issue.code === 'artifact-stale')?.message ?? '', /art\.txt/u, '过期要**点名产物路径**，不能只说"过期了"')
  assert.notEqual(assessed.outcome, 'ok', '过期绝不算 ok（REQ-055 降级口径）')
})

test('M40-21c 变异记录缺失 / 哈希不符 ⇒ 判红点名记录；记录路径不许瞎写', () => {
  const { store } = ws21()
  writeFileSync(join(M21, 'art.txt'), 'v1\n', 'utf8')
  const artifactHash = hashArtifact(M21, 'art.txt')

  // ① 绑了一条**不存在**的记录
  const missing = assessMutation({
    workspace: M21,
    store,
    source: { killRate: '100%', threshold: '80%', record: '.sdo/construction/nope.yml', artifact: 'art.txt', artifactHash, survived: [] },
  })
  assert.equal(missing.outcome, 'invalid')
  assert.ok(missing.issues.some((issue) => issue.code === 'record-missing'), `点名 record-missing：${JSON.stringify(missing.issues)}`)

  // ② 记录在盘上、但读数绑的是**另一份**（哈希不符）
  writeMutationLedger(store, [{ killed: 9, survived: 0 }])
  const staleRecord = assessMutation({
    workspace: M21,
    store,
    source: { killRate: '100%', threshold: '80%', record: '.sdo/construction/tdd.yml', recordHash: 'f'.repeat(64), artifact: 'art.txt', artifactHash, survived: [] },
  })
  assert.equal(staleRecord.outcome, 'stale', `绑的不是当前那一份 ⇒ 过期：${JSON.stringify(staleRecord.issues)}`)
  assert.ok(staleRecord.issues.some((issue) => issue.code === 'record-stale'))
})

test('M40-21d kill 率与阈值逐条现算：低于阈值判红，阈值读不出数判红', () => {
  const { store } = ws21()
  writeFileSync(join(M21, 'art.txt'), 'v1\n', 'utf8')
  const artifactHash = hashArtifact(M21, 'art.txt')
  const ledgerHash = writeMutationLedger(store, [{ killed: 3, survived: 1 }])

  const below = assessMutation({
    workspace: M21, store,
    source: { killRate: '75%', threshold: '100%', record: '.sdo/construction/tdd.yml', recordHash: ledgerHash, artifact: 'art.txt', artifactHash, survived: [{ id: 'MU-001', disposition: '等价', reason: '与已覆盖边界等价' }] },
  })
  assert.equal(below.outcome, 'invalid')
  assert.ok(below.issues.some((issue) => issue.code === 'killrate-below-threshold'), `现算 3/4=75% < 100%：${JSON.stringify(below.issues)}`)
  assert.match(below.issues.find((issue) => issue.code === 'killrate-below-threshold')?.message ?? '', /75\.0%/u, '回执要印出现算出来的数')

  const badThreshold = assessMutation({
    workspace: M21, store,
    source: { killRate: '75%', threshold: '差不多', record: '.sdo/construction/tdd.yml', recordHash: ledgerHash, artifact: 'art.txt', artifactHash, survived: [] },
  })
  assert.ok(badThreshold.issues.some((issue) => issue.code === 'threshold-invalid'), '阈值读不出数 ⇒ 判红（没有阈值就没有达标可言）')
})

test('M40-21e 存活变异体逐条处置：**判红并点名具体变异体**，一条不被整体达标掩盖（AC-216）', () => {
  const { store } = ws21()
  writeFileSync(join(M21, 'art.txt'), 'v1\n', 'utf8')
  const artifactHash = hashArtifact(M21, 'art.txt')
  // 记录里 3 个存活，处置清单只列了 2 条（且其中一条没给依据）
  const ledgerHash = writeMutationLedger(store, [{ killed: 20, survived: 3 }])

  const assessed = assessMutation({
    workspace: M21, store,
    source: {
      killRate: '87%', threshold: '80%', record: '.sdo/construction/tdd.yml', recordHash: ledgerHash, artifact: 'art.txt', artifactHash,
      survived: [
        { id: 'MU-001', disposition: '补用例', useCase: 'TC-049' },
        { id: 'MU-002', disposition: '等价' }, // 等价却没给理由 ⇒ 不算处置
      ],
    },
    knownCaseIds: ['TC-049'],
  })
  assert.equal(assessed.outcome, 'invalid', '整体 kill 率达标（20/23 ≈ 87% ≥ 80%）**不许**掩盖个别未处置的存活变异体')
  assert.deepEqual(
    assessed.unsettled,
    ['MU-002', 'survived[2]（记录称有存活，处置清单未列）'],
    `未处置的要逐条点名（含「没列出来」的那条）：${JSON.stringify(assessed.unsettled)}`,
  )
  assert.ok(assessed.issues.some((issue) => issue.code === 'reason-missing' && issue.field === 'survived[1].reason'), '缺依据要点名到字段')
  assert.ok(assessed.issues.some((issue) => issue.code === 'survived-missing'), '清单比存活数少 ⇒ 少的那几条也要判红（不能"没列出来"就当处置了）')
  assert.match(assessed.issues.find((issue) => issue.code === 'survived-missing')?.message ?? '', /MU|3 个存活/u, '缺清单的话要说清"记录里有 3 个存活"')
})

test('M40-21i 存活变异体**完全没写处置** ⇒ 判红并点名该变异体（REQ-055 的入口不许是死代码）', () => {
  const { store } = ws21()
  writeFileSync(join(M21, 'art.txt'), 'v1\n', 'utf8')
  const artifactHash = hashArtifact(M21, 'art.txt')
  const ledgerHash = writeMutationLedger(store, [{ killed: 4, survived: 2 }])
  const assessed = assessMutation({
    workspace: M21, store,
    source: {
      killRate: '67%', threshold: '80%', record: '.sdo/construction/tdd.yml', recordHash: ledgerHash, artifact: 'art.txt', artifactHash,
      survived: [{ id: 'MU-101' }, { id: 'MU-102', disposition: '等价', reason: '与已覆盖的边界分支语义等价' }],
    },
    knownCaseIds: [],
  })
  assert.equal(assessed.outcome, 'invalid')
  assert.deepEqual(assessed.unsettled, ['MU-101'], `未处置的变异体要**点名**：${JSON.stringify(assessed.unsettled)}`)
  const missing = assessed.issues.filter((issue) => issue.code === 'disposition-missing')
  assert.equal(missing.length, 1, `缺处置只报一次（同一字段同一码去重）：${JSON.stringify(assessed.issues)}`)
  assert.equal(missing[0]?.field, 'survived[0].disposition', '点名到字段，不是笼统说"有未处置项"')
  // 另一条处置得好 ⇒ 不许被连坐（逐条判定，不是"有一条坏就全部算坏"）
  assert.equal(assessed.survived[1]?.outcome, 'ok')
  // 反向对照：**先证它在修复前确实会红** —— 若 disposition 非空，这条问题就不该再出现
  const ok = assessMutation({
    workspace: M21, store,
    source: {
      killRate: '50%', threshold: '50%', record: '.sdo/construction/tdd.yml', recordHash: ledgerHash, artifact: 'art.txt', artifactHash,
      survived: [{ id: 'MU-101', disposition: '补用例', useCase: 'TC-049' }],
    },
    knownCaseIds: ['TC-049'],
  })
  assert.equal(ok.issues.some((issue) => issue.code === 'disposition-missing'), false, '补了处置之后这一条必须消失（负向对照不许空转）')
})

test('M40-21f 词表同源：唯一枚举 + 唯一校验器 + 逐字段同构（覆盖项 vs 存活变异体）', () => {
  const resolved = resolveDisposition({ field: 'x', disposition: '补用例', useCase: 'TC-1', scope: 'coverage-item', knownCaseIds: ['TC-1'] })
  assert.equal(resolved.outcome, 'ok')
  assert.equal(resolveDisposition({ field: 'x', disposition: '不可达', reason: '死代码', scope: 'coverage-item' }).outcome, 'ok')
  assert.equal(resolveDisposition({ field: 'x', disposition: '等价', reason: '与已覆盖边界等价', scope: 'coverage-item' }).outcome, 'ok')

  const bad: readonly Record<string, unknown>[] = [
    { disposition: '' },
    { disposition: '忽略' },
    { disposition: '补用例' },
    { disposition: '补用例', useCase: 'TC-999' },
    { disposition: '等价' },
  ]
  for (const item of bad) {
    const coverage = assessCoverageItem('uncovered[0]', { id: 'UN-001', item: '分支', ...item }, { knownCaseIds: ['TC-1'] })
    const mutant = assessMutationItem('survived[0]', { id: 'MU-1', ...item }, { knownCaseIds: ['TC-1'] })
    const same = coverage.issues.map((issue) => issue.code).sort()
    const other = mutant.issues.map((issue) => issue.code).sort()
    assert.deepEqual(other, same, `同一份输入两侧必须给出同一组问题码：覆盖 ${JSON.stringify(same)} vs 变异 ${JSON.stringify(other)}（输入 ${JSON.stringify(item)}）`)
    assert.deepEqual(
      coverage.issues.map((issue) => issue.field.replace(/^uncovered\[0\]/u, 'X')),
      mutant.issues.map((issue) => issue.field.replace(/^survived\[0\]/u, 'X')),
      '点号路径也要同构（同一个毛病在两处印同一个字段名）',
    )
    assert.equal(mutant.outcome, 'invalid')
  }

  // 枚举只有一份：本模块**再导出** types.ts 的那一份，不是重写
  assert.deepEqual([...MUTATION_DISPOSITIONS], [...TESTING_DISPOSITIONS], '词表必须是 types.ts 的那一份（MUTATION_DISPOSITIONS 只是别名）')
  assert.equal(DISPOSITION_RULES['补用例']?.requires.join('+'), 'useCase')
  assert.equal(DISPOSITION_RULES['等价']?.requires.join('+'), 'reason')
})

test('M40-21g 显式断言唯一语义差异：「不可达」只对未覆盖项开放，存活变异体用它会掩盖断言缺口', () => {
  const coverage = assessCoverageItem('uncovered[0]', { id: 'UN-001', item: '死分支', disposition: '不可达', reason: '这段是死代码，插桩显示零命中' })
  assert.equal(coverage.outcome, 'ok', 'REQ-057 给未覆盖项开了「不可达 + 理由」这一档')
  assert.ok((DISPOSITION_SCOPE_RULE['coverage-item'].allowed as readonly string[]).includes('不可达'))
  assert.ok(!(DISPOSITION_SCOPE_RULE['surviving-mutant'].allowed as readonly string[]).includes('不可达'), '存活变异体这一侧不开放')

  const mutant = assessMutationItem('survived[0]', { id: 'MU-1', disposition: '不可达', reason: '这段是死代码，插桩显示零命中' })
  assert.equal(mutant.outcome, 'invalid', 'REQ-055 没有"不可达"这一档：存活变异体是被植入的改动，它活下来只说明断言没看出来')
  assert.deepEqual(mutant.issues.map((issue) => issue.code), ['unreachable-not-allowed'], `差异要用**专用码**说出来，不是笼统的"取值非法"：${JSON.stringify(mutant.issues)}`)
  assert.equal(mutant.issues[0]?.field, 'survived[0].disposition')
  assert.match(mutant.issues[0]?.message ?? '', /断言/u, '回执要说清为什么不开放（否则读者会以为是漏实现）')
  // 差异只在**允许集合**上：同一个取值仍然在同一个词表里（不是"取值非法"）
  assert.ok((MUTATION_DISPOSITIONS as readonly string[]).includes('不可达'))

  // 差异**只在允许集合上**：同一个取值仍然在同一个词表里（不是"取值非法"）
  assert.ok((MUTATION_DISPOSITIONS as readonly string[]).includes('不可达'))

  // **落盘形状层也必须按同一条规则生效**（驾驶舱 2026-10-13 裁决：形状侧原来只认两档是病灶，
  // 改后按 `DISPOSITION_SCOPE_RULE` 执行）——这里直接对 `report.yml` 的变异读数跑形状校验：
  const shape = validateTestingSource('report', {
    exitCriteria: [{ id: 'XC-001', criterion: '变异 kill 率', measured: '100%', verdict: 'pass' }],
    coverage: [],
    uncovered: [],
    mutation: { killRate: '100%', threshold: '80%', survived: [{ id: 'MU-1', disposition: '不可达', reason: '死代码' }] },
    residualRisks: [],
    escapes: [],
  })
  assert.equal(shape.outcome, 'invalid', '形状层不许放过"存活变异体 = 不可达"')
  assert.ok(
    shape.issues.some((issue) => issue.field === 'mutation.survived[0].disposition' && issue.code === 'enum'),
    `形状层要点名该字段（码体系是形状层自己的 enum）：${JSON.stringify(shape.issues)}`,
  )
  // 同一份真源把处置换成「等价 + 理由」⇒ 形状层必须放行（证明上一条不是"什么都拒"）
  const okShape = validateTestingSource('report', {
    exitCriteria: [{ id: 'XC-001', criterion: '变异 kill 率', measured: '100%', verdict: 'pass' }],
    coverage: [],
    uncovered: [],
    mutation: { killRate: '100%', threshold: '80%', survived: [{ id: 'MU-1', disposition: '等价', reason: '与已覆盖边界语义等价' }] },
    residualRisks: [],
    escapes: [],
  })
  assert.deepEqual(okShape.issues.filter((issue) => issue.field.startsWith('mutation')), [], '等价 + 理由必须放行')
})

test('M40-21g2 词表同源的静态面：coverage.ts / testingShapes.ts 必须复用同一份词表与校验函数', () => {
  const coverageSrc = sysReadFileSync(join(ROOT, 'src', 'domain', 'coverage.ts'), 'utf8')
  const shapesSrc = sysReadFileSync(join(ROOT, 'src', 'domain', 'testingShapes.ts'), 'utf8')
  const findings: string[] = []
  if (!/from '\.\/mutation\.js'/u.test(coverageSrc)) findings.push("coverage.ts 没有 `from './mutation.js'`（未覆盖项判定仍是本文件里那一份）")
  if (!/resolveDisposition|assessCoverageItem/u.test(coverageSrc)) findings.push('coverage.ts 的 assessUncovered 没有调用 resolveDisposition / assessCoverageItem')
  if (/\.includes\(disposition\)/u.test(coverageSrc)) findings.push("coverage.ts 仍有内联枚举判定（\`['补用例','不可达','等价'].includes(...)\`）")
  if (!/from '\.\/mutation\.js'/u.test(shapesSrc)) findings.push("testingShapes.ts 没有 `from './mutation.js'`")
  if (!/resolveDisposition|assessCoverageItem|assessMutationItem/u.test(shapesSrc)) findings.push('testingShapes.ts 的 checkUncovered / 变异分支没有调用同一套校验函数')
  // **什么才算"又写了一份词表"**（判据要能区分真相与假阳性）：
  //   ① 自己写一份**合法集合**（`['补用例','不可达','等价']` 之类字面量数组）；
  //   ② 用 `.includes(disposition)` 拿它做**集员判定**；
  //   ③ 从 `types.ts` 取 `TESTING_DISPOSITIONS` 自己 `enumOf`。
  // **不算**的：`disposition === '补用例'` 这种**选字段/选文案**的分支 —— 规则（哪一档要 useCase、
  // 哪一档要 reason、哪一侧不开放哪一档）已经全部由 `resolveDisposition` 判过，
  // 剩下的字面量只是"从同一个映射里取不同动作"。把选文案也判红是假阳性：它只会逼人删掉正常的提示语。
  const literalLists = [...coverageSrc.matchAll(/\[\s*'补用例'[^\]]*\]/gu), ...shapesSrc.matchAll(/\[\s*'补用例'[^\]]*\]/gu)]
  if (literalLists.length > 0) findings.push(`仍有内联合法集合字面量 ×${literalLists.length}（词表只有 types.ts 一份）`)
  if (/\.includes\(disposition\)/u.test(coverageSrc) || /\.includes\(disposition\)/u.test(shapesSrc)) {
    findings.push('仍有自己写的集员判定（`.includes(disposition)`）')
  }
  if (/enumOf\(issues,[^)]*TESTING_DISPOSITIONS/u.test(coverageSrc) || /enumOf\(issues,[^)]*TESTING_DISPOSITIONS/u.test(shapesSrc)) {
    findings.push('仍在用 `enumOf(..., TESTING_DISPOSITIONS)` 自己判枚举（应交给 resolveDisposition）')
  }
  assert.deepEqual(
    findings,
    [],
    '词表同源未落地（REQ-055 / TASK-021 DoD）：下面这些点只能改 coverage.ts 与 testingShapes.ts —— 本卡写范围（src/domain/mutation.ts、src/domain/records.ts、test/m40.test.ts）不含这两个文件，需流程官扩范围或另开卡',
  )

  // **差异的现算读数**（DoD 要求"把差异写成显式断言 + 在报告里说明理由"）：
  // 对同一份输入，`coverage.ts` 现存的 `assessUncovered` 与本模块的 `assessCoverageItem`
  // 各自认不认 —— 把"两处各写一份"的下场**测出来**，而不是只在散文里说。
  // 收敛之后这个数组自然为空（同源 ⇒ 逐条一致），断言不需要改。
  const divergence: string[] = []
  const observed = assessCoverageItem('uncovered[0]', { id: 'UN-001', item: '分支' })
  const shape = validateTestingSource('coverage', {
    readings: [],
    uncovered: [{ id: 'UN-001', item: '分支' }],
  })
  if (observed.outcome !== 'invalid') divergence.push('assessCoverageItem 对"缺处置"没判红')
  if (!shape.issues.some((issue) => issue.field === 'uncovered[0].disposition' && issue.code === 'missing')) {
    divergence.push('testingShapes 对"缺处置"没有给出 uncovered[0].disposition/missing')
  }
  assert.deepEqual(divergence, [], `差异读数：${JSON.stringify(divergence)}`)
})
test('M40-21h 缺陷记录含**根因 / 发现级别 / 是否逃逸**，且一并进 append-only 真源事件', () => {
  const { store, journal } = ws21()
  const defect = recordDefect(store, journal, {
    title: '存活变异体未处置也能过验证门',
    severity: 'major',
    status: 'open',
    caseId: 'TC-049',
    rootCause: '判据只判整体 kill 率，没有逐条判存活变异体的处置',
    discoveryLevel: '系统',
    escaped: true,
  })
  assert.match(defect.id, /^DEF-\d+$/u)
  assert.equal(defect.rootCause, '判据只判整体 kill 率，没有逐条判存活变异体的处置')
  assert.equal(defect.discoveryLevel, '系统')
  assert.equal(defect.escaped, true)

  // 落盘后可回读（不是只在内存里）
  const back = listDefects(store).find((item) => item.id === defect.id)
  assert.equal(back?.rootCause, defect.rootCause)
  assert.equal(back?.discoveryLevel, '系统')
  assert.equal(back?.escaped, true)

  // 真源事件：`defects/*.yml` 可手改，能挡事后改写的只有 append-only 事件
  const event = journal.read().events.filter((item) => item.type === 'defect/recorded').pop()
  assert.equal(event?.data.rootCause, defect.rootCause, '根因要进事件（审计要能重建"为什么它会进来"）')
  assert.equal(event?.data.discoveryLevel, '系统', '发现级别要进事件')
  assert.equal(event?.data.escaped, true, '是否逃逸要进事件（否则"逃逸"只活在可手改的文件里）')

  // 反向：三个字段都没给 ⇒ 老台账形状不变（不许凭空造值 —— 逃逸 default 成 false 会让"没说"变成"没逃逸"）
  const plain = recordDefect(store, journal, { title: 't', severity: 'minor', status: 'open' })
  assert.equal(plain.rootCause, undefined)
  assert.equal(plain.discoveryLevel, undefined)
  assert.equal(plain.escaped, undefined, '没声明就不许落成 false')
  const plainEvent = journal.read().events.filter((item) => item.type === 'defect/recorded').pop()
  assert.equal('escaped' in (plainEvent?.data ?? {}), false, '没给的字段不许出现在事件里')
  // 发现级别的词表是**唯一一份**，档位稳定（自由文本无法机械核对）
  assert.deepEqual([...DEFECT_DISCOVERY_LEVELS], ['评审', '单元', '集成', '系统', '验收', '生产'])
})
