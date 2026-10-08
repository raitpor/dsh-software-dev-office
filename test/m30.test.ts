/**
 * 开发阶段加固（A1/A2/C7/D9）的回归用例。
 *
 * 这些改动都落在**执行者唯一必经的关口**上（`sdo_task action=claim|done` 与 G5 判据），
 * 因此用例也贴着那条路径写：真写卡 → 真回报 → 看回执/判据，而**不是**测内部函数。
 *
 * A1（本文件前半）：done 的证据要与**卡上声明的种类**和**工作区里真实存在的东西**对账。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { claim, report } from '../src/domain/collab.js'
import { auditDoneEvidence, parseArtifactDetail } from '../src/domain/evidence.js'
import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { changedFilesSince, readWorkspaceChanges, recordWorkspaceChanges, unresolvedSeqs } from '../src/domain/workspaceChanges.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import { createOfficeTools } from '../src/interface/tools.js'
import type { SdoConfig } from '../src/config.js'
import type { EvidenceItem } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m30/', import.meta.url))
let workspace: string
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(join(workspace, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(workspace, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 写一张"已被认领"的卡（owner=cockpit），字段平铺，与 readTask 的读法一致。 */
function writeCard(overrides: Record<string, unknown> = {}): void {
  // 磁盘形态：卡片正文嵌在 `task:` 之下（readTaskChecked 读的是 `?.task`）
  store.writeYaml(['tasks', 'TASK-001.yml'], {
   task: {
    id: 'TASK-001',
    title: '实现差异检测',
    goal: '实现对账差异检测',
    inputs: [],
    outputs: [],
    dod: ['差异检测可用'],
    evidenceRequired: ['command', 'artifact'],
    blockedBy: [],
    writeScopes: ['src/det/'],
    role: 'developer',
    size: 'medium',
    status: 'ready',
    requirements: [],
    owner: 'cockpit',
    revision: 1,
    evidence: [],
    ...overrides,
   },
  })
}

function call(): { sessionId: string; cwd: string } {
  return { sessionId: 's1', cwd: workspace }
}

function artifact(file: string, content: string, withHash: boolean): EvidenceItem {
  mkdirSync(join(workspace, 'src', 'det'), { recursive: true })
  writeFileSync(join(workspace, file), content, 'utf8')
  const hash = createHash('sha256').update(content).digest('hex')
  return { kind: 'artifact', detail: withHash ? `${file} sha256=${hash}` : file, at: '2026-10-02T00:00:00.000Z' }
}

test('M30-01 A1 证据种类必须覆盖卡上声明（缺种类即判红，且点名缺哪个）', () => {
  writeCard()
  const only = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [artifact('src/det/a.ts', 'export const a = 1\n', false)],
  })
  assert.equal(only.ok, false)
  assert.equal(only.ok === false ? only.code : '', 'evidence-kind-missing')
  assert.match(only.ok === false ? only.detail : '', /command/u, '要点名缺的是 command')
})

test('M30-02 A1 artifact 必须指向真实存在的产物；越出工作区的路径也判红', () => {
  writeCard({ evidenceRequired: ['artifact'] })
  const missing = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [{ kind: 'artifact', detail: 'src/det/不存在.ts', at: 'x' }],
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.ok === false ? missing.code : '', 'evidence-artifact-missing')

  const outside = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [{ kind: 'artifact', detail: '../outside.ts', at: 'x' }],
  })
  assert.equal(outside.ok, false)
  assert.equal(outside.ok === false ? outside.code : '', 'evidence-artifact-outside')
})

test('M30-03 A1 artifact 带哈希时必须复算比对（对→放行；错→判红并给出两个前缀）', () => {
  writeCard({ evidenceRequired: ['artifact'] })
  // 反向 ①：不带哈希也能过（不能因为"没给哈希"就拦 —— 那会逼人编造）
  const noHash = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [artifact('src/det/b.ts', 'export const b = 2\n', false)],
  })
  assert.equal(noHash.ok, true, `不带哈希应放行：${JSON.stringify(noHash)}`)

  // 反向 ②：哈希正确 → 放行
  writeCard({ evidenceRequired: ['artifact'] })
  const good = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [artifact('src/det/c.ts', 'export const c = 3\n', true)],
  })
  assert.equal(good.ok, true, `哈希一致应放行：${JSON.stringify(good)}`)

  // 正向：哈希不符 → 判红
  writeCard({ evidenceRequired: ['artifact'] })
  const wrong: EvidenceItem = { kind: 'artifact', detail: `src/det/c.ts sha256=${'0'.repeat(64)}`, at: 'x' }
  const bad = report(store, journal, { taskId: 'TASK-001', owner: 'cockpit', status: 'done', evidence: [wrong] })
  assert.equal(bad.ok, false)
  assert.equal(bad.ok === false ? bad.code : '', 'evidence-artifact-hash')
  assert.match(bad.ok === false ? bad.detail : '', /000000000000/u, '要给出证据里写的那个前缀，便于对照')
})

test('M30-04 A1 command 证据的退出码非 0 不算完成；不给退出码不拦', () => {
  writeCard({ evidenceRequired: ['command'] })
  const failed = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [{ kind: 'command', detail: 'npm test（3 failed）', at: 'x', exitCode: 1 }],
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.ok === false ? failed.code : '', 'evidence-command-failed')

  writeCard({ evidenceRequired: ['command'] })
  const zero = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [{ kind: 'command', detail: 'npm test（388 passed）', at: 'x', exitCode: 0 }],
  })
  assert.equal(zero.ok, true, `退出码 0 应放行：${JSON.stringify(zero)}`)

  writeCard({ evidenceRequired: ['command'] })
  const noCode = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [{ kind: 'command', detail: 'npm test（输出摘要）', at: 'x' }],
  })
  assert.equal(noCode.ok, true, '没给退出码不拦（避免逼人编造退出码）')
})

test('M30-05 A1 纯函数层：解析路径/哈希的三种写法 + 对账结果形状', () => {
  assert.deepEqual(parseArtifactDetail('a/b.ts'), { path: 'a/b.ts' })
  assert.deepEqual(parseArtifactDetail('a/b.ts sha256=' + 'a'.repeat(64)), { path: 'a/b.ts', sha256: 'a'.repeat(64) })
  assert.deepEqual(parseArtifactDetail('a/b.ts #' + 'b'.repeat(64)), { path: 'a/b.ts', sha256: 'b'.repeat(64) })
  const card = { id: 'TASK-009', evidenceRequired: ['command'] as EvidenceItem['kind'][], evidence: [{ kind: 'command' as const, detail: '旧证据', at: 'x' }] }
  assert.deepEqual(auditDoneEvidence(card, [], workspace), { ok: true }, '卡上已挂过的证据也算覆盖（不重复要求）')
})

// —————————————————————— A2：workspace/changes 采集 + 写范围对账 ——————————————————————

test('M30-06 A2 采集开关与工作区判定：关掉不写、没有 .sdo/ 不写、开启才记', () => {
  const before = store.listNames('evidence')
  const off = recordWorkspaceChanges({ store, sessionId: 's1', seq: 3, journalSeq: 3, summary: { files: [{ path: 'src/a.ts' }] }, enabled: false, hasProject: true })
  assert.equal(off, undefined)
  assert.deepEqual(store.listNames('evidence'), before, '关闭时不得落盘')

  const noProject = recordWorkspaceChanges({ store, sessionId: 's1', seq: 3, journalSeq: 3, summary: { files: [{ path: 'src/a.ts' }] }, enabled: true, hasProject: false })
  assert.equal(noProject, undefined, '没有 .sdo/ 的工作区不记账')

  const on = recordWorkspaceChanges({ store, sessionId: 's1', seq: 3, journalSeq: 3, summary: { turn: 2, files: [{ path: 'src/a.ts' }, { display: 'docs/b.md' }] }, enabled: true, hasProject: true })
  assert.equal(on?.files.length, 2, 'path 与 display 两种写法都要收')
  const read = readWorkspaceChanges(store)
  assert.equal(read.entries.length, 1)
  assert.equal(read.badLines, 0)
})

test('M30-07 A2 changedFilesSince：只取"本会话 + 基线之后"的清单，坏行不毁对账', () => {
  recordWorkspaceChanges({ store, sessionId: 's1', seq: 5, journalSeq: 5, summary: { files: [{ path: 'src/old.ts' }] }, enabled: true, hasProject: true })
  recordWorkspaceChanges({ store, sessionId: 's2', seq: 9, journalSeq: 9, summary: { files: [{ path: 'src/other-session.ts' }] }, enabled: true, hasProject: true })
  recordWorkspaceChanges({ store, sessionId: 's1', seq: 9, journalSeq: 9, summary: { files: [{ path: 'src/new.ts' }, { path: 'src/old.ts' }] }, enabled: true, hasProject: true })
  store.appendLine(['evidence', 'workspace-changes.jsonl'], '{ 这不是 JSON\n')
  const hit = changedFilesSince(store, 's1', 5)
  assert.deepEqual(hit.files, ['src/new.ts', 'src/old.ts'], '只取 s1 且 seq>5，去重')
  assert.equal(hit.entries, 1)
  assert.equal(hit.audited, true, '每条命中条目都带宿主摘要 → 这才叫"已对账"')
  assert.equal(readWorkspaceChanges(store).badLines, 1, '坏行计数但不影响其它条目')
  // 反向：没有会话/基线时如实返回"没数据"（调用方据此报"未对账"）
  assert.deepEqual(changedFilesSince(store, undefined, 5), { files: [], entries: 0, audited: false })
  assert.deepEqual(changedFilesSince(store, 's1', undefined), { files: [], entries: 0, audited: false })
})

test('M30-08 A2 done 写范围对账：越界即判红并点名；范围内放行；采不到时**不得冒充已核对**', () => {
  // ① 越界：认领（记会话）→ 采集一条基线之后、写范围之外的改动 → done 判红
  writeCard({ writeScopes: ['src/det/'], evidenceRequired: ['artifact'] })
  const claimed = claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', sessionId: 's1', expectedRevision: 1 })
  assert.equal(claimed.ok, true)
  const claimSeq = journal.read().events.filter((event) => event.type === 'task/claimed').map((event) => event.seq).pop() as number
  recordWorkspaceChanges({ store, sessionId: 's1', seq: claimSeq + 1, journalSeq: claimSeq + 1, summary: { files: [{ path: 'src/other/escape.ts' }] }, enabled: true, hasProject: true })
  const violated = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [artifact('src/det/d.ts', 'export const d = 4\n', false)],
  })
  assert.equal(violated.ok, false)
  assert.equal(violated.ok === false ? violated.code : '', 'write-scope-violation')
  assert.match(violated.ok === false ? violated.detail : '', /src\/other\/escape\.ts/u, '要点名越界文件')

  // ② 范围内：同样流程但改动落在写范围里 → 放行且 checked=true
  writeCard({ writeScopes: ['src/det/'], evidenceRequired: ['artifact'] })
  claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', sessionId: 's1', expectedRevision: 1 })
  const seq2 = journal.read().events.filter((event) => event.type === 'task/claimed').map((event) => event.seq).pop() as number
  recordWorkspaceChanges({ store, sessionId: 's1', seq: seq2 + 1, journalSeq: seq2 + 1, summary: { files: [{ path: 'src/det/inside.ts' }] }, enabled: true, hasProject: true })
  const ok = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [artifact('src/det/e.ts', 'export const e = 5\n', false)],
  })
  assert.equal(ok.ok, true, `范围内应放行：${JSON.stringify(ok)}`)
  assert.deepEqual(ok.ok === true ? ok.workspaceAudit : undefined, { checked: true, changed: 1 })

  // ③ 反向：采不到数据 → 放行但 **checked=false**（"没数据"必须与"已核对"区分开）
  writeCard({ writeScopes: ['src/det/'], evidenceRequired: ['artifact'] })
  claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', sessionId: 's-nocapture', expectedRevision: 1 })
  const blind = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [artifact('src/det/f.ts', 'export const f = 6\n', false)],
  })
  assert.equal(blind.ok, true, `无采集数据不得判红（absence ≠ violation）：${JSON.stringify(blind)}`)
  assert.deepEqual(blind.ok === true ? blind.workspaceAudit : undefined, { checked: false, changed: 0 })
})

// —————————————————————— C7：测试先行 ——————————————————————

/** 写一份项目台账（只为规模档位）。 */
function writeProject(scale: string): void {
  store.writeJson(['project.json'], { id: 'PRJ-001', name: 'M30', process: 'waterfall', phase: 'construction', tailoring: { scale } })
  // 本文件测的是 C7/A1/A2 语义，不测实现阶段方法包：写一份**显式不选包**的中立 profile
  // （对照 `test/m33.test.ts` —— 那边才是方法包门禁本身的用例）
  store.writeYaml(['construction', 'profile.yml'], {
    profile: { version: 1, decidedAt: '', decidedBy: 'office', packages: [], scope: 'all', derivedFrom: [], reason: '本夹具不启用实现阶段方法包', exempt: [], history: [] },
  })
}

test('M30-09 C7 normal 档：需求没有用例计划就不给认领；有计划后放行', () => {
  writeProject('normal')
  writeCard({ requirements: ['REQ-001'] })
  const blocked = claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', expectedRevision: 1 })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.ok === false ? blocked.code : '', 'test-case-missing')
  assert.match(blocked.ok === false ? blocked.detail : '', /REQ-001/u, '要点名缺用例的需求')

  office_addCase('REQ-001')
  const ok = claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', expectedRevision: 1 })
  assert.equal(ok.ok, true, `有用例计划后应可认领：${JSON.stringify(ok)}`)
})

test('M30-10 C7 done 前要有结果：没结果判红、fail 判红、pass 放行、skip 要带理由', () => {
  writeProject('normal')
  writeCard({ requirements: ['REQ-001'], evidenceRequired: ['artifact'] })
  const caseId = office_addCase('REQ-001')
  assert.equal(claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', expectedRevision: 1 }).ok, true)
  const evidence = [artifact('src/det/g.ts', 'export const g = 7\n', false)]

  const noResult = report(store, journal, { taskId: 'TASK-001', owner: 'cockpit', status: 'done', evidence })
  assert.equal(noResult.ok, false)
  assert.equal(noResult.ok === false ? noResult.code : '', 'test-result-missing')

  recordTestResult(store, journal, { caseId, status: 'fail', evidence: 'p99=900ms' })
  const failing = report(store, journal, { taskId: 'TASK-001', owner: 'cockpit', status: 'done', evidence })
  assert.equal(failing.ok, false)
  assert.equal(failing.ok === false ? failing.code : '', 'test-failing')

  recordTestResult(store, journal, { caseId, status: 'pass', evidence: 'exit=0' })
  const passed = report(store, journal, { taskId: 'TASK-001', owner: 'cockpit', status: 'done', evidence })
  assert.equal(passed.ok, true, `pass 应放行：${JSON.stringify(passed)}`)

  // 反向：skip **必须给理由**才算"有结果"（显式 N/A 不是默默跳过）
  writeProject('normal')
  writeCard({ requirements: ['REQ-002'], evidenceRequired: ['artifact'] })
  const caseId2 = office_addCase('REQ-002')
  claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', expectedRevision: 1 })
  recordTestResult(store, journal, { caseId: caseId2, status: 'skip', evidence: '   ' })
  const emptySkip = report(store, journal, { taskId: 'TASK-001', owner: 'cockpit', status: 'done', evidence })
  assert.equal(emptySkip.ok, false, 'skip 不给理由不算有结果')
  assert.equal(emptySkip.ok === false ? emptySkip.code : '', 'test-skip-unjustified', 'skip 无理由要点名它自己的失败码')
  assert.match(emptySkip.ok === false ? emptySkip.detail : '', /skip 但\*\*没写理由\*\*/u, '文案必须说 skip，不能说成 fail')
  assert.doesNotMatch(emptySkip.ok === false ? emptySkip.detail : '', /结果是 fail/u, '不得把用户如实记的 skip 说成 fail')
  recordTestResult(store, journal, { caseId: caseId2, status: 'skip', evidence: '本卡不涉及该需求的运行路径，由 TASK-002 覆盖' })
  const reasoned = report(store, journal, { taskId: 'TASK-001', owner: 'cockpit', status: 'done', evidence })
  assert.equal(reasoned.ok, true, `skip + 理由应放行：${JSON.stringify(reasoned)}`)
})

test('M30-11 C7 豁免方向：trivial 档、以及卡上无需求时都不拦（避免逼人造假用例）', () => {
  writeProject('trivial')
  writeCard({ requirements: ['REQ-003'] })
  assert.equal(claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', expectedRevision: 1 }).ok, true, 'trivial 档豁免')

  writeProject('normal')
  writeCard({ requirements: [], evidenceRequired: ['artifact'] })
  assert.equal(claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', expectedRevision: 1 }).ok, true, '卡上没有需求时豁免')
  const done = report(store, journal, { taskId: 'TASK-001', owner: 'cockpit', status: 'done', evidence: [artifact('src/det/h.ts', 'export const h = 8\n', false)] })
  assert.equal(done.ok, true, `无需求的卡 done 不受 C7 限制：${JSON.stringify(done)}`)
})

/** 记一条用例并返回 caseId。 */
function office_addCase(requirement: string): string {
  const testCase = recordTestCase(store, journal, { title: `覆盖 ${requirement}`, kind: 'unit', requirement, steps: ['跑'], expected: '通过' })
  return testCase.id
}

// —————————————————————— D9：G5 对中大卡强制通过评审 ——————————————————————

test('M30-12 D9 G5-C-42：size ≥ medium 的完成卡没有通过评审即判红；有评审放行；小卡不受这条约束', () => {
  writeProject('normal')
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  const gate = (): { ok: boolean; detail: string } => {
    const criterion = office.evaluate(call(), 'G5').criteria.find((item) => item.id === 'C-42')
    assert.ok(criterion !== undefined, 'G5 必须含 C-42（本轮新增）')
    return { ok: criterion.ok, detail: criterion.detail }
  }

  // ① 一张 medium 的完成卡、没有评审 → 判红并点名
  writeCard({ requirements: [], size: 'medium', status: 'done', evidenceRequired: ['artifact'], evidence: [{ kind: 'artifact', detail: 'src/det/i.ts', at: 'x' }] })
  const red = gate()
  assert.equal(red.ok, false, '中大卡无通过评审必须判红')
  assert.match(red.detail, /TASK-001/u, '要点名是哪张卡')

  // ② 记一条别人（评审人）给的 pass 评审 → **还不够**（2026-10-08 口径：评审结果要被核实才能采纳）
  const review = office.addReview(call(), { taskId: 'TASK-001', reviewer: 'reviewer-b', verdict: 'pass', findings: ['已逐条核对，无阻塞问题'] })
  const beforeVerify = gate()
  assert.equal(beforeVerify.ok, false, '没核实的通过评审不得被采纳（原来这里直接放行）')
  assert.match(beforeVerify.detail, /未核实/u, `理由要说清是"没核实"而不是"没评审"：${beforeVerify.detail}`)

  // ③ 由实现方逐条核实（复现）→ 才被采纳、才放行
  office.verifyReviewFinding(call(), { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: '逐条复核：确无阻塞问题', by: 'dev-a' })
  assert.equal(gate().ok, true, `核实后应放行：${JSON.stringify(gate())}`)

  // ④ 反向：**另一张 small 卡**完成、且完全没有评审 → 这条不拦（拦它是 G6 的 C-52 的事）
  //    用第二张卡是为了让"忽略 size 的变异"能被这条咬住：若把 size 判定删掉，这里就会红。
  store.writeYaml(['tasks', 'TASK-002.yml'], {
    task: {
      id: 'TASK-002', title: '小改动', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'],
      blockedBy: [], writeScopes: ['src/small/'], role: 'developer', size: 'small', status: 'done', requirements: [],
      owner: 'cockpit', revision: 1, evidence: [{ kind: 'artifact', detail: 'src/det/j.ts', at: 'x' }],
    },
  })
  assert.equal(gate().ok, true, 'small 卡不被 G5-C-42 拦')
})

test('M30-13 A2 缺陷同路径：采到条目但**没有文件信息**时必须报"未对账"（不得冒充零越界）', () => {
  writeProject('normal')
  // ① 宿主没有 workspaceChanges 服务 / summary() 返回 undefined → 条目在、文件信息没有
  writeCard({ writeScopes: ['src/det/'], evidenceRequired: ['artifact'] })
  claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', sessionId: 's1', expectedRevision: 1 })
  const seq = journal.read().events.filter((event) => event.type === 'task/claimed').map((event) => event.seq).pop() as number
  const entry = recordWorkspaceChanges({ store, sessionId: 's1', seq: seq + 1, journalSeq: seq + 1, summary: undefined, enabled: true, hasProject: true })
  assert.equal(entry?.summaryAvailable, false, '采到了条目，但要如实记下"没有摘要"')
  assert.deepEqual(changedFilesSince(store, 's1', seq).audited, false, '无摘要 → 不算已对账')
  const blind = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [artifact('src/det/k.ts', 'export const k = 9\n', false)],
  })
  assert.equal(blind.ok, true)
  assert.deepEqual(blind.ok === true ? blind.workspaceAudit : undefined, { checked: false, changed: 0 },
    '这条正是评审抓到的缺陷：不得给出 checked:true 的干净回执')

  // ② 对照：宿主**明确**回了"零改动"的摘要 → 那是"看过了、没有改动"，算已对账
  writeProject('normal')
  writeCard({ writeScopes: ['src/det/'], evidenceRequired: ['artifact'] })
  claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', sessionId: 's1', expectedRevision: 1 })
  const seq2 = journal.read().events.filter((event) => event.type === 'task/claimed').map((event) => event.seq).pop() as number
  recordWorkspaceChanges({ store, sessionId: 's1', seq: seq2 + 1, journalSeq: seq2 + 1, summary: { files: [] }, enabled: true, hasProject: true })
  const looked = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [artifact('src/det/l.ts', 'export const l = 10\n', false)],
  })
  assert.deepEqual(looked.ok === true ? looked.workspaceAudit : undefined, { checked: true, changed: 0 },
    '"宿主说零改动"与"根本没摘要"必须区分开')

  // ③ 旧条目（没有 summaryAvailable 字段）保守地按"未对账"处理
  writeProject('normal')
  writeCard({ writeScopes: ['src/det/'], evidenceRequired: ['artifact'] })
  claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', sessionId: 's1', expectedRevision: 1 })
  const seq3 = journal.read().events.filter((event) => event.type === 'task/claimed').map((event) => event.seq).pop() as number
  store.appendLine(['evidence', 'workspace-changes.jsonl'], JSON.stringify({ sessionId: 's1', seq: seq3 + 1, at: 'x', files: ['src/det/legacy.ts'] }) + '\n')
  assert.equal(changedFilesSince(store, 's1', seq3).audited, false, '旧条目缺 summaryAvailable ⇒ 保守当"未对账"')
})

test('M30-14 A1 的可发现性：证据形状（含 exitCode 是独立字段）必须写在模型看得到的参数描述里', () => {
  // 检查本身再强，调用方够不着就等于没有 —— 这条把"形状说明"钉在工具定义上（评审 minor 2）。
  const tools = createOfficeTools({ office: {} as never, lang: 'zh-CN' } as never)
  const task = tools.find((tool) => tool.name === 'sdo_task')
  assert.ok(task !== undefined, 'sdo_task 必须存在')
  const evidence = (task.parameters as { properties?: Record<string, { description?: string }> }).properties?.evidence
  assert.ok(evidence?.description !== undefined, 'evidence 参数必须有描述')
  assert.match(evidence.description, /exitCode/u, '要说清 exitCode 字段')
  assert.match(evidence.description, /独立字段/u, '要明说它必须是字段，写进 detail 文本不生效')
  assert.match(evidence.description, /sha256/u, 'artifact 的哈希写法也要给出来')
})

// —————————————————————— 评审 T-2 / T-3：回执文案必须能读懂 ——————————————————————

test('M30-15 T-2 哈希不符要打印**能区分**的指纹（前 12 位相同、尾巴不同时不能看起来一样）', () => {
  writeProject('normal')
  writeCard({ requirements: [], evidenceRequired: ['artifact'] })
  mkdirSync(join(workspace, 'src', 'det'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'det', 'm.ts'), 'export const m = 1\n', 'utf8')
  const real = createHash('sha256').update('export const m = 1\n').digest('hex')
  // 现场形态：模型编了个"前 12 位正确、尾巴是编的"哈希
  const said = real.slice(0, 12) + 'a'.repeat(52)
  assert.notEqual(said, real)
  const bad = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [{ kind: 'artifact', detail: `src/det/m.ts sha256=${said}`, at: 'x' }],
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.ok === false ? bad.code : '', 'evidence-artifact-hash')
  const detail = bad.ok === false ? bad.detail : ''
  // 两个指纹必须不同（评审前的实现只打印前 12 位 ⇒ 两句看起来一模一样）
  const shown = [...detail.matchAll(/([0-9a-f]{8,}…[0-9a-f]{4})/gu)].map((match) => match[1] as string)
  assert.equal(shown.length, 2, `要同时给出"现算"与"证据写的是"两个指纹：${detail}`)
  assert.notEqual(shown[0], shown[1], '两个指纹必须能区分开')
  assert.match(detail, /第 13 位起不同/u, '要指出首个不同位，便于一眼定位')
})

test('M30-16 T-3 detail 后面跟说明文字时，报错要**教怎么改**（而不是只说产物不存在）', () => {
  writeProject('normal')
  writeCard({ requirements: [], evidenceRequired: ['artifact'] })
  mkdirSync(join(workspace, 'src', 'det'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'det', 'n.ts'), 'export const n = 1\n', 'utf8')
  const real = createHash('sha256').update('export const n = 1\n').digest('hex')
  const task = { id: 'TASK-001', evidenceRequired: ['artifact'] as EvidenceItem['kind'][], evidence: [] as EvidenceItem[] }
  const clean = { path: 'src/det/n.ts', workspace, task }

  // ① 路径后直接跟说明
  const first = auditDoneEvidence(clean.task, [{ kind: 'artifact', detail: 'src/det/n.ts（已通过 mvn 编译）', at: 'x' }], clean.workspace)
  assert.equal(first.ok, false)
  assert.equal(first.ok === false ? first.code : '', 'evidence-artifact-detail', '是写法问题，不是"产物不存在"')
  assert.match(first.ok === false ? first.detail : '', /之后还有「（已通过 mvn 编译）」/u, '要点出多余的那段文字')
  assert.match(first.ok === false ? first.detail : '', /另一条 evidence/u, '要给出可执行的修法')

  // ② **合法哈希之后**再跟说明：文案必须说「哈希没问题」，别误导用户删掉哈希
  //    这里刻意覆盖**两种**变体：说明带内部空格、以及**不带空格**的短括号（评审 T-3 残留变体：
  //    锚定正则下 `\S+` 会一路吃到结尾，把合法哈希误报成"不是 64 位十六进制"）。
  for (const tail of ['（已通过 mvn 编译）', '（已通过）', ' 已通过']) {
    const result = auditDoneEvidence(clean.task, [{ kind: 'artifact', detail: `src/det/n.ts sha256=${real}${tail}`, at: 'x' }], clean.workspace)
    assert.equal(result.ok, false, `哈希后跟「${tail}」必须被拒（detail 写法不合法）`)
    assert.equal(result.ok === false ? result.code : '', 'evidence-artifact-detail', `「${tail}」应报写法问题而不是哈希问题`)
    assert.match(result.ok === false ? result.detail : '', /与哈希都合法/u, '要说明路径与哈希本身都合法')
    assert.match(result.ok === false ? result.detail : '', /哈希之后还有/u, '要指出多出来的是哈希之后的说明')
  }

  // 反向：合法两种写法仍必须放行（收紧不能变成乱拦）
  for (const detail of ['src/det/n.ts', `src/det/n.ts sha256=${real}`]) {
    assert.equal(auditDoneEvidence(clean.task, [{ kind: 'artifact', detail, at: 'x' }], clean.workspace).ok, true, `${detail} 必须放行`)
  }
})

test('M30-17 A2 竞态修复：采集时拿不到清单 → done 时补记，对账从此真的成立', () => {
  // 复刻宿主行为：先 append `workspace/changes` 事件（监听器此刻触发、拿不到摘要），之后才写记录。
  writeProject('normal')
  writeCard({ writeScopes: ['src/det/'], evidenceRequired: ['artifact'] })
  claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', sessionId: 's1', expectedRevision: 1 })
  const seq = journal.read().events.filter((event) => event.type === 'task/claimed').map((event) => event.seq).pop() as number
  recordWorkspaceChanges({ store, sessionId: 's1', seq: seq + 1, journalSeq: seq + 1, summary: undefined, enabled: true, hasProject: true })
  assert.deepEqual(unresolvedSeqs(store, 's1', seq), [seq + 1], '没有摘要的 seq 要列出来供 done 补取')
  assert.equal(changedFilesSince(store, 's1', seq).audited, false, '补取之前：未对账')

  // done 时再取一次并补记（带越界文件）→ 对账成立并且**真的判红**
  recordWorkspaceChanges({ store, sessionId: 's1', seq: seq + 1, journalSeq: seq + 1, summary: { files: [{ path: 'src/other/escape.ts' }] }, enabled: true, hasProject: true })
  assert.deepEqual(unresolvedSeqs(store, 's1', seq), [], '同一 seq 已有带摘要的记录 → 不再缺')
  const after = changedFilesSince(store, 's1', seq)
  assert.equal(after.audited, true, '同一 seq 只要有一条带摘要就算对过账')
  assert.deepEqual(after.files, ['src/other/escape.ts'])
  const violated = report(store, journal, {
    taskId: 'TASK-001',
    owner: 'cockpit',
    status: 'done',
    evidence: [artifact('src/det/z.ts', 'export const z = 26\n', false)],
  })
  assert.equal(violated.ok, false)
  assert.equal(violated.ok === false ? violated.code : '', 'write-scope-violation', '补取到的越界文件必须判红')
  assert.match(violated.ok === false ? violated.detail : '', /src\/other\/escape\.ts/u, '要点名越界文件')
})

test('M30-18 A2 补取的接线：done 之前先补，且补不到不拦', () => {
  const index = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.match(index, /office\.pendingWorkspaceChanges\(call, args\.id\)/u, 'done 时必须查"还缺清单的 seq"')
  assert.match(index, /service\?\.summary\?\.\(item\.sessionId, item\.seq\)/u, '要用宿主的 workspaceChanges.summary 再取一次')
  assert.match(index, /office\.noteResolvedWorkspaceChanges\(call/u, '取到就补记（append-only）')
  assert.match(index, /if \(files\.length > 0\)/u, '空清单不补记（避免制造"零改动"的假对账）')
  const office = readFileSync(new URL('../../src/office.ts', import.meta.url), 'utf8')
  assert.match(office, /pendingWorkspaceChanges\(call: OfficeCall, taskId: string\)/u)
  assert.match(office, /noteResolvedWorkspaceChanges\(call: OfficeCall/u)
})

test('M30-19 文档守卫：CHANGELOG 不许写死"全量 N/N"（两次漂移后改为与测试输出同源）', () => {
  // 事故史：写「全量 430/430」→ 加用例后变 433；改「438」→ 又变 441。写死的计数必然漂移，
  // 所以改成"以 node scripts/run-tests.mjs 输出为准"，并在这里禁止它再出现。
  const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')
  const hardcoded = [...changelog.matchAll(/全量 \*\*\d+\/\d+\*\*/gu)].map((match) => match[0])
  assert.deepEqual(hardcoded, [], `CHANGELOG 里不要写死测试计数（会漂移）：${hardcoded.join('、')}`)
  assert.match(changelog, /run-tests\.mjs/u, '要指向真正的计数来源')
})

test('M30-20 C7 也有来源核对（评审建议 1）：结果文件在 journal 里没有事件 ⇒ 不算数、done 判红', () => {
  writeProject('normal')
  writeCard({ requirements: ['REQ-001'], evidenceRequired: ['artifact'] })
  const caseId = office_addCase('REQ-001')
  assert.equal(claim(store, journal, { taskId: 'TASK-001', owner: 'cockpit', expectedRevision: 1 }).ok, true)
  const evidence = [artifact('src/det/g.ts', 'export const g = 7\n', false)]

  // ① **只写文件**、不写 journal 事件（模拟手写/伪造）⇒ 来源不可追溯，done 判红
  store.writeYaml(['tests', 'results', 'TR-001.yml'], { result: { id: 'TR-001', caseId, status: 'pass', evidence: 'x', at: '' } })
  const forged = report(store, journal, { taskId: 'TASK-001', owner: 'cockpit', status: 'done', evidence })
  assert.equal(forged.ok, false)
  assert.equal(forged.ok === false ? forged.code : '', 'tdd-result-untraceable')
  assert.ok(forged.ok === false && forged.detail.includes('TR-001'), `要点名是哪些结果：${forged.ok === false ? forged.detail : ''}`)

  // ② 把那条伪造文件删掉，再走**真实路径**（文件 + 事件都写）⇒ 放行
  rmSync(join(workspace, '.sdo', 'tests', 'results', 'TR-001.yml'), { force: true })
  recordTestResult(store, journal, { caseId, status: 'pass', evidence: 'exit=0' })
  const ok = report(store, journal, { taskId: 'TASK-001', owner: 'cockpit', status: 'done', evidence })
  assert.equal(ok.ok, true, ok.ok === false ? ok.detail : '')
})
