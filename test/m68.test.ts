/**
 * **评审核实：工具层**（真实装配 + 真实 `sdo_review` 工具）。
 *
 * 域层用例（`test/m67.test.ts`）钉的是判定口径；这一条钉的是**接线**：
 *   · `action=record` 的回执必须明说「评审结果不会自动被采纳，要由实现方逐条核实」；
 *   · `action=verify` 由**该卡的实现会话**调 ⇒ 成功，回执给出「已核实 i/n」与是否可采纳；
 *   · 由**记录评审的那个会话**调 ⇒ 被拒（不能自己核实自己）；
 *   · `action=list` 必须把"核实进度 / 采纳状态"印出来（否则静默的未核实状态看不见）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { renderStatusBlock } from '../src/interface/inject.js'
import { maskAllows } from '../src/domain/roles.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { Context } from '@deepseek-ai/cordis'
import type { TaskCard } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm68')
let store: SdoStore
let journal: Journal

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}

function harness(): { callTool: (name: string, args: Record<string, unknown>, sessionId: string, depth?: number) => Promise<string> } {
  const registered: ToolDefinition[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition): (() => void) => { registered.push(tool); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as never))
  return {
    async callTool(name, args, sessionId, depth = 1) {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `工具面缺少 ${name}`)
      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
      const exec = {
        agent: {
          id: sessionId,
          session: { header: { id: sessionId, cwd: BASE, delegationDepth: depth, ...(depth === 0 ? {} : { parentSession: 'cockpit' }) } },
        },
      }
      return String(await tool.execute(filtered, exec))
    },
  }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
  const task: TaskCard = {
    id: 'TASK-001', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', 'TASK-001.yml'], { task })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M68-01 工具层：record 回执要说"待核实"；实现会话 verify 成功；记录者自己 verify 被拒；list 要印核实进度', async () => {
  const h = harness()
  // 开发会话认领这张卡（认领会话 = 实现方）
  assert.match(await h.callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'dev-a', expectedRevision: 1 }, 'child-dev'), /in-progress/u)

  // ① 评审会话记一条**要求改动**的评审：回执必须明说"不会自动被采纳"
  const recorded = await h.callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'changes-requested', findings: '["f1：并发下会串号","f2：缺失败路径用例"]',
  }, 'child-rev')
  assert.match(recorded, /REV-001/u, `记录要成功：${recorded}`)
  assert.match(recorded, /核实/u, `回执要说清"要核实才能采纳"：${recorded}`)

  // ② 记录评审的会话自己核实 ⇒ 拒
  const selfVerify = await h.callTool('sdo_task', {
    action: 'verify-review', id: 'TASK-001', review: 'REV-001', index: 1, outcome: 'reproduced', proof: '我说有就有',
  }, 'child-rev')
  assert.match(selfVerify, /self-verify/u, `同会话自核实必须被拒：${selfVerify}`)

  // ③ 实现会话核实第一条 ⇒ 成功，且如实说"还有一条没核实"
  const first = await h.callTool('sdo_task', {
    action: 'verify-review', id: 'TASK-001', review: 'REV-001', index: 1, outcome: 'reproduced', proof: '按发现构造两个并发请求 ⇒ 复现串号',
  }, 'child-dev')
  assert.match(first, /已核实 1\/2/u, `回执要给核实进度：${first}`)
  assert.match(first, /尚未被采纳/u, `还有一条没核实 ⇒ 不能说已采纳：${first}`)

  // ④ 第二条反驳（给反证）⇒ 整条可采纳
  const second = await h.callTool('sdo_task', {
    action: 'verify-review', id: 'TASK-001', review: 'REV-001', index: 2, outcome: 'refuted', proof: '反证：失败路径用例在 TC-007 里已覆盖（附输出）',
  }, 'child-dev')
  assert.match(second, /已核实 2\/2/u, `回执要给核实进度：${second}`)
  assert.match(second, /可采纳/u, `全部核实完 ⇒ 要说可采纳：${second}`)

  // ⑤ list 必须印出核实进度与采纳状态（未核实的状态不许静默）
  const listed = await h.callTool('sdo_review', { action: 'list' }, 'cockpit', 0)
  assert.match(listed, /REV-001/u)
  assert.match(listed, /2\/2/u, `list 要印核实进度：${listed}`)
  assert.match(listed, /已核实采纳/u, `list 要印采纳状态：${listed}`)

  // ⑥ 空 findings 的评审（任何 verdict）都不许记（否则没有任何可核实的东西）
  const empty = await h.callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'rev-c', verdict: 'reject', findings: '[]',
  }, 'child-rev')
  assert.match(empty, /findings/u, `空评审必须被拒：${empty}`)
  assert.equal(journal.read().events.filter((event) => event.type === 'review/recorded').length, 1, '被拒的评审不许留事件')
})

test('M68-02 状态块：未核实的评审必须每轮说出来（核实完就消失）—— 不许静默', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as never)))
  office.noteSession('s1', BASE)
  const call = { sessionId: 's1' }
  office.init(call, { name: 'P', scale: 'normal', stakeholders: ['业务方'] })
  const review = office.addReview(call, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: ['f1：边界没测'] })
  const block = (): string => renderStatusBlock(office.status(call), '.sdo', 200)
  assert.match(block(), new RegExp(review.id, 'u'), `状态块要点名待核实的评审：${block()}`)
  assert.match(block(), /待核实/u)

  office.verifyReviewFinding(call, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: '复现成功，已修' })
  assert.doesNotMatch(block(), /待核实/u, `核实完就不再提示：${block()}`)
})

test('M68-03 可达性：实现角色必须够得着核实动作（`sdo_task` 协议通道），而 `sdo_review` 仍是评审员的（职责分离不放松）', () => {
  // **为什么必须钉这条**：核实要由**实现会话**做，而 `sdo_review` 在 developer/tester/delivery 的
  // 掩码里是**显式 deny**（职责分离）。如果把动作挂在 `sdo_review` 上，机制在真机上根本够不着
  // （域层规则再对也没用 —— 这正是本项目反复出现的"检查存在但够不着"）。
  for (const role of ['developer', 'tester', 'delivery', 'analyst', 'architect', 'reviewer', 'office', 'red-team'] as const) {
    assert.equal(maskAllows(role, 'sdo_task'), true, `${role} 必须能走协议通道（核实在它上面）`)
  }
  for (const role of ['developer', 'tester', 'delivery'] as const) {
    assert.equal(maskAllows(role, 'sdo_review'), false, `${role} 仍不得看见评审工具（职责分离）`)
  }
  // （"派发提示里提到的工具必须在掩码里"那条机械守卫在 `m31-04`，此处不重复造第二套口径。）
})

test('M68-04 工具层闭环（报告 §6 未实测的那条）：改动要求未核实完 ⇒ `done` 被拒；逐条核实完才放行', async () => {
  const h = harness()
  assert.match(await h.callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'dev-a', expectedRevision: 1 }, 'child-dev'), /in-progress/u)
  const review = await h.callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'changes-requested', findings: '["f1：并发下串号","f2：缺失败路径用例"]',
  }, 'child-rev')
  assert.match(review, /REV-001/u)

  // ① 未核实完就报完成 ⇒ 工具回执里必须看到 `review-open-findings` 与还差哪几条
  const blocked = await h.callTool('sdo_task', {
    action: 'done', id: 'TASK-001', owner: 'dev-a', evidence: '[{"kind":"command","detail":"node --test 全绿","exitCode":0}]',
  }, 'child-dev')
  assert.match(blocked, /review-open-findings/u, `工具回执要说清拒绝码：${blocked}`)
  assert.match(blocked, /REV-001/u, `要点名评审：${blocked}`)
  assert.match(blocked, /1、2/u, `要点名还差第几条发现：${blocked}`)
  assert.equal(journal.read().events.filter((event) => event.type === 'task/done').length, 0, '被拒的完成不许留 task/done')

  // ② 逐条核实（一条复现、一条反驳）⇒ 完成放行
  assert.match(await h.callTool('sdo_task', { action: 'verify-review', id: 'TASK-001', review: 'REV-001', index: 1, outcome: 'reproduced', proof: '构造并发请求 ⇒ 复现串号' }, 'child-dev'), /已核实 1\/2/u)
  assert.match(await h.callTool('sdo_task', { action: 'verify-review', id: 'TASK-001', review: 'REV-001', index: 2, outcome: 'refuted', proof: '反证：TC-007 已覆盖失败路径' }, 'child-dev'), /已核实 2\/2/u)
  const done = await h.callTool('sdo_task', {
    action: 'done', id: 'TASK-001', owner: 'dev-a', evidence: '[{"kind":"command","detail":"node --test 全绿","exitCode":0}]',
  }, 'child-dev')
  assert.doesNotMatch(done, /review-open-findings/u, `核实完必须能完成：${done}`)
  assert.equal(journal.read().events.filter((event) => event.type === 'task/done').length, 1, '这次要真的落 task/done')
})
