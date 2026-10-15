/**
 * **增量 178：DEF-033 第三面（第四批 §3.5 / `ADR-015`）—— 门禁面缺口：`unfrozen` 只在回执上可见**。
 *
 * 现象：`grep -rn unfrozen src/domain/gates.ts` **无命中** ⇒「卡 `done` ≠ 全局冻结」在回执上可见、
 * 在**门禁上不存在** —— 交付/验证门禁不会因"有一批卡声明了未冻结"说一句话。
 *
 * 用户裁决（`ADR-015`）：判据＝「**有 `unfrozen` 非空的卡 ⇒ 交付前必须有一次全量绿**」，挂 **G7 交付门禁**
 * （按"交付前"的字面期限；**不在 G6 重复声明** —— 同一概念两处判据是 `DEF-044` 的教训）。
 *
 * 落法：`TestResult.fullSuite`（结构化声明"这条结论覆盖全量"）+ 判据 **C-67 `defects.unfrozen-full-green`**：
 * 有未冻结完成的卡 ⇒ 必须存在一条 `status=pass` 且 `fullSuite=true`、且时刻**晚于**最后一次未冻结完成
 * 的 `done` 的结论；否则判红并逐条点名。"全量"由**项目/调用方声明**（插件不认任何跑法、不硬编码命令与路径）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { unfrozenFullGreenState } from '../src/domain/unfrozen.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'
import type { TestResult } from '../src/domain/records.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m178/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's-cockpit', cwd: WORKSPACE } as unknown as OfficeCall

interface ToolDefinition { name: string; parameters: { properties?: Record<string, unknown> }; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

function c67(): { ok: boolean; na?: boolean; detail: string; remedy?: string } {
  const criterion = office.evaluate(call, 'G7').criteria.find((item) => item.id === 'C-67')
  assert.ok(criterion !== undefined, '前置：G7 必须声明 C-67（defects.unfrozen-full-green）')
  return criterion as { ok: boolean; na?: boolean; detail: string; remedy?: string }
}

/** 一张**局部收工**的卡（`unfrozen` 非空）+ 它的 `done` 时刻。 */
function unfrozenCard(id: string, unfrozen: string[], doneAt: string): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/'], role: 'developer', size: 'small', revision: 2,
    status: 'done', requirements: [], evidence: [], createdAt: '', updatedAt: doneAt, unfrozen,
  }
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task })
}

/** 一条"覆盖全量"的测试结论，时刻可指定（夹具直写：不经过 `recordTestResult` 的"现在"）。 */
function fullGreen(id: string, at: string): void {
  const result: TestResult = { id, caseId: 'TC-001', status: 'pass', evidence: '全量跑过一次', at, fullSuite: true }
  office.storeFor(WORKSPACE).writeYaml(['tests', 'results', `${id}.yml`], { result })
}

function toolHarness(): (name: string, args: Record<string, unknown>) => Promise<string> {
  const tools: ToolDefinition[] = []
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } } }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return async (name, args) => {
    const tool = tools.find((item) => item.name === name)
    assert.ok(tool !== undefined, `工具面缺少 ${name}`)
    const exec = { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }
    return String(await tool.execute(args, exec))
  }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-cockpit', WORKSPACE)
  office.init(call, { name: 'M178 未冻结完成要有全量绿', scale: 'normal', stakeholders: ['业务方'] })
  // 一条在用用例（`fullSuite` 结论仍要求 `caseId` 对得上 —— 不在本卡里放宽这条既有口径）
  office.storeFor(WORKSPACE).writeYaml(['tests', 'TC-001.yml'], {
    testCase: { id: 'TC-001', title: 't', kind: 'unit', requirement: '', steps: [], expected: 'x', at: '' },
  })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M178-01 三态：没有未冻结卡 ⇒ N/A；有未冻结卡而**无全量绿** ⇒ 判红并点名；补一条 ⇒ 转绿（反例）', () => {
  // ① 没有 `unfrozen` 非空的卡 ⇒ 本条**不适用**（既不是判红也不是判绿）
  const na = c67()
  assert.equal(na.na, true, `没有局部收工的完成时，本条必须 N/A：${JSON.stringify(na)}`)
  assert.match(na.detail, /不适用/u, 'N/A 必须说清为什么')

  // ② 有未冻结完成的卡、却没有全量绿 ⇒ 判红 + 逐条点名 + 可执行修法
  unfrozenCard('TASK-001', ['TASK-002'], '2026-10-01T00:00:00.000Z')
  const red = c67()
  assert.equal(red.ok, false, '未冻结完成之后没有全量绿必须判红')
  assert.equal(red.na, undefined, '这不是 N/A')
  assert.match(red.detail, /TASK-001/u, `判红必须点名是哪几张卡引出的：${red.detail}`)
  assert.match(red.remedy ?? '', /fullSuite=true/u, '修法必须给出可执行写法')
  assert.match(red.remedy ?? '', /晚于/u, '修法必须说清时序（要晚于那次 done）')

  // ③ 补一条**晚于**那次 done 的全量 pass ⇒ 转绿（判据不是"永远红"）
  fullGreen('TR-001', '2026-10-02T00:00:00.000Z')
  const green = c67()
  assert.equal(green.ok, true, `补上全量绿之后必须转绿（反例）：${green.detail}`)
  assert.match(green.detail, /TR-001/u, '转绿时要回显是哪条结论兑现的')
})

test('M178-02 反例（时序）：**早于**未冻结完成的全量绿不算数；之后再有一次才算', () => {
  fullGreen('TR-001', '2026-10-01T00:00:00.000Z')
  unfrozenCard('TASK-001', ['TASK-002'], '2026-10-05T00:00:00.000Z')
  const stale = c67()
  assert.equal(stale.ok, false, '先跑全量、后局部收工 ⇒ 那次全量**覆盖不到**后来的改动，不许算数')
  assert.match(stale.detail, /TASK-001/u, '仍要点名')
  // 时刻相同也不算（严格晚于）
  fullGreen('TR-002', '2026-10-05T00:00:00.000Z')
  assert.equal(c67().ok, false, '同一时刻不算"晚于"')
  fullGreen('TR-003', '2026-10-06T00:00:00.000Z')
  assert.equal(c67().ok, true, '晚于之后必须转绿')
  // 唯一出口同口径
  const state = unfrozenFullGreenState(office.storeFor(WORKSPACE), office.journalFor(WORKSPACE))
  assert.deepEqual(state.cards.map((card) => card.id), ['TASK-001'], '读数：引出的卡')
  assert.equal(state.satisfiedBy, 'TR-003', '读数：兑现的结论')
})

test('M178-03 工具面（真注册面）：`fullSuite=true` 落进真源 + 转绿（四处同改的机械证据）', async () => {
  unfrozenCard('TASK-001', ['TASK-002'], '2026-10-01T00:00:00.000Z')
  assert.equal(c67().ok, false, '前置：先红')
  const callTool = toolHarness()
  const receipt = await callTool('sdo_test', {
    action: 'record', caseId: 'TC-001', status: 'pass', evidence: '全量跑过',
    fullSuite: true, oracle: '{"kind":"expert","expert":"tester"}',
  })
  assert.match(receipt, /TR-001/u, `工具面必须真的记下这条结论：${receipt.slice(0, 300)}`)
  const stored = office.storeFor(WORKSPACE).readYaml<{ result: TestResult }>('tests/results', 'TR-001.yml')?.result
  assert.equal(stored?.fullSuite, true, '`fullSuite` 必须落进真源（工具层漏传 = 静默丢弃）')
  // 真源事件里也要有（文件可手改，append-only 的事件挡得住事后补标）
  const events = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'test/recorded')
  assert.ok(events.some((event) => event.data['fullSuite'] === true), '`test/recorded` 事件必须带上 fullSuite')
  assert.equal(c67().ok, true, `记完必须转绿：${c67().detail}`)
})

test('M178-04 结构：C-67 挂在 **G7**（不重复进 G6）、四流程逐字一致、且**不硬编码任何跑法**', () => {
  assert.match(readFileSync(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8'), /'defects\.unfrozen-full-green':/u, '判据必须注册')
  const lines: string[] = []
  for (const name of ['waterfall', 'prototype', 'agile', 'spiral']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'processes', `${name}.yml`), 'utf8')
    const line = text.split('\n').find((item) => item.includes('id: C-67'))
    assert.ok(line !== undefined, `${name}.yml 必须声明 C-67`)
    lines.push(line.trim())
    const g6 = text.indexOf('- id: G6')
    const g7 = text.indexOf('- id: G7')
    const at = text.indexOf('id: C-67')
    assert.ok(g7 > 0 && at > g7, `C-67 必须挂在 G7（交付门禁）`)
    assert.ok(at > g6, 'G6 在 G7 之前（夹具前提）')
    // **不在 G6 重复声明**：G6 段里不许出现这条 check
    const g6Block = text.slice(g6, g7)
    assert.equal(g6Block.includes('unfrozen-full-green'), false, '同一概念不许在两处判据里各写一份（DEF-044 的教训）')
  }
  assert.equal(new Set(lines).size, 1, `四个流程文件的 C-67 必须逐字一致：\n${lines.join('\n')}`)
  const desc = lines[0] as string
  // **DoD ④**：插件不硬编码任何跑法 —— 判据措辞里不许出现具体跑命令/具体路径
  for (const runner of ['npm', 'node --test', 'pytest', 'mvn ', 'gradle', 'make ']) {
    assert.equal(desc.includes(runner), false, `判据措辞不许硬编码跑法：${runner}`)
  }
})


/**
 * **R12（第五批 §3.4）：`C-67` 的**端到端链**要有单一用例。**
 *
 * 复验 V8 的现象：`M174-01` 覆盖"`done` 写 `unfrozen`"、`M178-01..04` 覆盖"`C-67` 读 `unfrozen`"，
 * 但 `M178` 的夹具是**直写 `tasks/*.yml`** ⇒ **删掉 `src/domain/collab.ts` 里那一行落键，
 * `M178-*` 仍全绿** —— 真实跨跳链（真 `done(unfrozen)` 落键 ⇒ `C-67` 读到并判红）**没有用例钉住**。
 * V8 实测这条链**是通的**；本用例把它钉成机械读数，且**两端都走真注册面**。
 */
test('M178-05 端到端（真注册面）：真 `done(unfrozen)` 落键 ⇒ `C-67` 判红并点名；补全量绿 ⇒ 转绿（R12）', async () => {
  const callTool = toolHarness()
  // 本卡（in-progress）+ 一张在飞兄弟卡（`unfrozen` 因此**必须**声明）
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-101.yml'], {
    task: {
      id: 'TASK-101', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
      owner: 'dev-a', blockedBy: [], writeScopes: ['src/'], role: 'developer', size: 'small', revision: 1,
      status: 'in-progress', requirements: [], evidence: [], createdAt: '', updatedAt: '',
    },
  })
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-102.yml'], {
    task: {
      id: 'TASK-102', title: 't2', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
      owner: 'dev-b', blockedBy: [], writeScopes: ['src/'], role: 'developer', size: 'small', revision: 1,
      status: 'in-progress', requirements: [], evidence: [], createdAt: '', updatedAt: '',
    },
  })
  assert.equal(c67().na, true, '前置：还没有"未冻结完成"的卡 ⇒ C-67 是 N/A')

  // ① **真注册的 `sdo_task action=done`**（真机面）声明未冻结 ⇒ 必须**落进卡**（删掉那一跳这条就红）
  const done = await callTool('sdo_task', {
    action: 'done', id: 'TASK-101', owner: 'dev-a',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
    unfrozen: ['TASK-102'],
  })
  assert.match(done, /局部绿/u, `真机面必须真的收工：${done.slice(0, 300)}`)
  const stored = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-101.yml')?.task
  assert.deepEqual(stored?.unfrozen, ['TASK-102'], '`done` 必须把未冻结清单**落进卡**（R12：这一跳没有别的用例钉）')

  // ② **跨跳**：`C-67` 读到这张卡 ⇒ 判红并**点名它**（`doneAt` 来自 `task/done` 真源事件）
  const red = c67()
  assert.equal(red.ok, false, '有未冻结完成、又没有全量绿 ⇒ 必须判红（这就是端到端链）')
  assert.match(red.detail, /TASK-101/u, `判红必须点名是哪张卡引出的：${red.detail}`)
  const state = unfrozenFullGreenState(office.storeFor(WORKSPACE), office.journalFor(WORKSPACE))
  assert.deepEqual(state.cards.map((card) => card.id), ['TASK-101'], '读数：引出的卡就是刚 done 的那张')
  assert.notEqual(state.lastDoneAt, '', '读数：`done` 时刻必须来自真源事件（`task/done`）')

  // ③ 补一条**真注册的**全量 pass 结论 ⇒ 转绿（反例：这条链不是"永远红"）
  const green = await callTool('sdo_test', {
    action: 'record', caseId: 'TC-001', status: 'pass', evidence: '全量跑过一次',
    fullSuite: true, oracle: '{"kind":"expert","expert":"tester"}',
  })
  assert.match(green, /TR-/u, `全量结论必须记成功：${green.slice(0, 300)}`)
  assert.equal(c67().ok, true, `补上全量绿之后必须转绿：${c67().detail}`)
})
