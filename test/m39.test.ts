/**
 * rpsidease-reboren 第二份真机报告（`2026-10-05-测试报告-变更控制与门禁自锁.md`，SDO-16…SDO-30）的回归。
 *
 * 这一轮的主题是**自锁**与**类别**：
 *   · **SDO-16/17（blocker）**：消化变更这条路本身要先认领卡，而认领被 `change-not-digested` 全局封锁
 *     ⇒「用流程修流程」进不去（真机 TASK-128 连拒 4 轮，只能无卡直接执行）。修法：冻结只针对
 *     **施工/验证/交付**角色，流程侧角色（analyst/architect/office）可以开工去消化它，回执点名这条路。
 *   · **SDO-20（复发 7 次）**：`contract-test-missing` 只能逐卡豁免，而它会打到「工具面里没有
 *     `sdo_test`」的卡（评审/架构裁决/需求侧修正）⇒ 现在按**角色工具面**直接判 N/A（类别规则）。
 *   · **SDO-21**：认领被拒后卡没有 owner ⇒ `block` 也被 `not-owner` 拒，台账看不出"被机制卡住"。
 *     现在允许无主卡上报阻塞并记 `task/claim-blocked`。
 *   · **SDO-18**：`trace/linked` 里**施工期覆盖边**（`req-task`/`req-tc`）不进 `DESIGN.md`，
 *     但 C-25（文档新鲜度）此前一刀切 ⇒ 真机上补两条覆盖边就把刚渲染的文档判陈旧。
 *   · **SDO-19/26（事故）**：直接 `write` 覆盖 `.sdo/` 真源既不产生事件、又能毁掉正文（真机 23 条 DEV
 *     永久丢失）⇒ 写前**留快照**（不改行为，fail-open）。
 *   · **SDO-27**：单一子代理被复用 19 轮至上下文耗尽 ⇒ `sdo_plan action=next freshChild=true` 强制新起。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { claim, report } from '../src/domain/collab.js'
import { doneGaps, readConstructionProfile, writeConstructionProfile } from '../src/domain/construction.js'
import { readFileSync as _rf } from 'node:fs'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm39')
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

function card(id: string, role: string, requirements: string[] = []): TaskCard {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: role as TaskCard['role'], size: 'small', revision: 1,
    status: 'ready', requirements, evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
  return task
}

/** 造一个"已批准但未消化"的变更（真机形态）。 */
function approvedChange(): void {
  journal.append('change/requested', { id: 'CR-001', requirement: 'REQ-001' })
  journal.append('change/decided', { id: 'CR-001', decision: 'approved', by: 'human' })
}

test('SDO-16 / SDO-17：未消化变更**不再锁死解冻路径**（流程侧角色可认领），其余角色仍被拒且回执点名出路', () => {
  approvedChange()
  // ① 施工/验证/交付角色：仍被拒（冻结是硬约束）
  const dev = card('TASK-100', 'developer')
  const blocked = claim(store, journal, { taskId: dev.id, owner: 'dev-a', expectedRevision: 1 })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.ok ? '' : blocked.code, 'change-not-digested')
  assert.match(blocked.ok ? '' : blocked.detail, /解冻路径/u, '被拒时要给出可执行的解除路径（SDO-17 的诉求）')
  assert.match(blocked.ok ? '' : blocked.detail, /analyst/u, '要点名哪些角色能开工')

  // ② 流程侧角色（需求/架构）：可以认领 —— 它们就是消化变更的那条路
  for (const [id, role] of [['TASK-128', 'analyst'], ['TASK-129', 'architect']] as const) {
    const flow = card(id, role)
    const ok = claim(store, journal, { taskId: flow.id, owner: 'cockpit', expectedRevision: 1 })
    assert.equal(ok.ok, true, `${role} 的解冻卡必须能认领（真机：TASK-128 被同一检查连拒 4 轮）`)
  }
})

test('SDO-20：角色工具面里没有 `sdo_test` ⇒ `contract-test-missing` 判 N/A（不再逐卡豁免，已复发 7 次）', () => {
  // contract-first 画像 + 一张"评审角色"的卡（工具面里没有 sdo_test）
  writeConstructionProfile(store, {
    version: 1, decidedAt: '', decidedBy: 'office', packages: ['contract-first'], scope: 'all',
    derivedFrom: ['scale=critical'], reason: 'r', exempt: [], history: [],
  })
  const reviewer = card('TASK-200', 'reviewer')
  const developer = card('TASK-201', 'developer')
  const gapsFor = (task: TaskCard): string[] =>
    doneGaps(store, journal, task, readConstructionProfile(store).profile, { scale: 'critical' }).map((item) => item.check)

  assert.equal(gapsFor(reviewer).includes('contract-test-missing'), false, '评审角色拿不到契约测试证据 ⇒ 应判 N/A')
  assert.equal(gapsFor(developer).includes('contract-test-missing'), true, 'developer 的工具面有 sdo_test ⇒ 该检查照旧生效（不许放宽）')
})

test('SDO-21：认领被拒后卡没有 owner ⇒ `block` 仍可用，并记 `task/claim-blocked`（台账看得出"被机制卡住"）', () => {
  const task = card('TASK-300', 'developer')
  const failed = claim(store, journal, { taskId: task.id, owner: 'nobody', expectedRevision: 99 })
  assert.equal(failed.ok, false, '先用 CAS 失败制造"没有 owner 的卡"')

  const blocked = report(store, journal, { taskId: task.id, owner: 'dev-a', status: 'blocked', note: '被 change-not-digested 拦住，未开工' })
  assert.equal(blocked.ok, true, `无主卡的阻塞必须能记账：${blocked.ok ? '' : blocked.detail}`)
  assert.equal(blocked.ok ? blocked.task.status : '', 'blocked')
  const events = journal.read().events.filter((event) => event.type === 'task/claim-blocked')
  assert.equal(events.length, 1, '要与真正的 task/blocked 分开留痕')
  assert.match(String(events[0]?.data.reason ?? ''), /未开工/u)

  // 反向：**有主卡**仍只认 owner（不许借这条路径替别人挂起）
  const owned = card('TASK-301', 'developer')
  claim(store, journal, { taskId: owned.id, owner: 'owner-a', expectedRevision: 1 })
  const wrong = report(store, journal, { taskId: owned.id, owner: 'someone-else', status: 'blocked', note: 'x' })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.ok ? '' : wrong.code, 'not-owner')
})

test('SDO-18：C-25 的"文档真源变更"按 kind 分流 —— 施工期覆盖边不再把刚渲染的文档判陈旧', () => {
  const gates = _rf(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8')
  assert.match(gates, /nonDocTraceEdge/u, 'C-25 的过滤要用同一个作用域口径')
  assert.match(gates, /kind === 'req-task' \|\| kind === 'req-tc'/u)
  // 反向：拿不到 kind 时仍保守视为"会改文档"（黑名单方向不变）—— 由同一函数的两条分支保证
  assert.match(gates, /if \(event\.type !== 'trace\/linked' && event\.type !== 'trace\/unlinked'\) return false/u)
})

test('SDO-19 / SDO-26：直接写 `.sdo/` 真源前**留快照**（事故：23 条 DEV 正文永久丢失），且对非真源路径不产生噪音', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }
  const target = join(BASE, '.sdo', 'design', 'deviations.yml')
  mkdirSync(join(BASE, '.sdo', 'design'), { recursive: true })
  writeFileSync(target, 'DEV-001: 原始正文（会被覆盖）\n', 'utf8')

  const snapshot = office.snapshotTruthFile(call, '.sdo/design/deviations.yml')
  assert.ok(snapshot !== undefined && snapshot.includes('file-history'), `要落到 evidence/file-history：${String(snapshot)}`)
  assert.match(readFileSync(join(BASE, String(snapshot)), 'utf8'), /原始正文/u, '快照必须是**覆盖前**的内容')

  // 反向：非 `.sdo/` 路径、以及 journal 自身，都不留快照（不制造噪音）
  writeFileSync(join(BASE, 'src-notes.md'), 'x', 'utf8')
  assert.equal(office.snapshotTruthFile(call, 'src-notes.md'), undefined)
  assert.equal(office.snapshotTruthFile(call, '.sdo/journal.jsonl'), undefined)
})

test('SDO-23 / SDO-25 / SDO-27：architect 拿到 `edit`；confirm 接受 `basis`；派发支持强制新起子代理', () => {
  const roles = _rf(join(ROOT, 'src', 'data', 'roles.yml'), 'utf8')
  const architect = roles.slice(roles.indexOf('- code: architect'), roles.indexOf('- code: office'))
  assert.match(architect, /allow: \[[^\]]*edit/u, 'architect 必须有 edit（否则只能「read 全文 → 整篇 write」，真机因此毁掉登记簿）')
  assert.doesNotMatch(architect, /deny: \[[^\]]*edit/u, 'edit 不能同时留在 deny 里')

  const receipt = _rf(join(ROOT, 'src', 'interface', 'designReceipt.ts'), 'utf8')
  assert.match(receipt, /args\.basis \?\? args\.note \?\? args\.reason/u, 'confirm 必须优先采纳 `basis`（用户授权原话）')
  const tools = _rf(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  assert.match(tools, /basis: typeof args\.basis === 'string'/u, '`basis` 要进 execute 映射（否则又在工具边界被静默丢掉）')
  assert.match(tools, /freshChild: args\.freshChild === true/u, '`freshChild` 要进 execute 映射')
  const index = _rf(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /reuseIdle: reuse\.supported && !freshChild/u, 'freshChild 要真的跳过复用')
})
