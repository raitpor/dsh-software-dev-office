/**
 * 子 agent **取汇报**（三方案）：
 *   ① `sdo_status` 里有「最近完成的派发」；② 子会话 `turn/end` ⇒ 落 `dispatch/finished` + 报告文件；③ 状态块给报告摘要。
 *
 * 为什么这些用例要走**真实监听器与真实工具**：真机上的缺陷恰恰都是"边界/接线"上的 ——
 * 派发是 fire-and-forget（只记 `dispatch/started`），子代理的报告只写在它自己的会话里；
 * 而 `session/event` 的监听器原本整段 `catch {}` 静默吞异常（真机丢过三次派发的观测）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { apply } from '../src/index.js'
import { SdoStore } from '../src/infra/store.js'
import { readChildReportAt, reportFileName } from '../src/domain/dispatchReports.js'
import type { SdoConfig } from '../src/config.js'
import type { Context } from '@deepseek-ai/cordis'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm34')
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

interface Harness {
  fireEvent: (session: unknown, event: unknown) => void
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
}

function harness(): Harness {
  const listeners = new Map<string, (session: unknown, event: unknown) => void>()
  const registered: { name: string; execute: (args: unknown, exec: unknown) => unknown }[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: never) => { registered.push(tool as never); return () => {} } },
    sessions: {},
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (name: string, listener: never) => { listeners.set(name, listener as never); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const exec = { agent: { id: 'cockpit', session: { header: { cwd: BASE } } } }
  return {
    fireEvent: (session, event) => {
      const listener = listeners.get('session/event')
      assert.ok(listener !== undefined, '真实装配必须注册 session/event 监听器')
      listener(session, event)
    },
    callTool: async (name, args) => {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `${name} 必须注册进工具表`)
      return String(await tool.execute(args, exec))
    },
  }
}

function dispatchTo(childSessionId: string): void {
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId, tools: 9, role: 'developer' })
}

function child(sessionId: string): unknown {
  return { header: { id: sessionId, cwd: BASE, delegationDepth: 1 } }
}

function assistantMessage(text: string): unknown {
  return { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

test('M34-01 取汇报②③：子会话 turn/end ⇒ 落 dispatch/finished + 报告文件（内容=最后一条助手消息），状态块能看到摘要', async () => {
  const h = harness()
  dispatchTo('child-1')

  h.fireEvent(child('child-1'), assistantMessage('第一段：先读角色卡。'))
  h.fireEvent(child('child-1'), assistantMessage('最终报告：改了 schema.sql 的复合键，契约测试 2 条、变异 killed 4。'))
  assert.equal(existsSync(join(BASE, '.sdo', 'evidence', 'child-reports', 'child-1.md')), false, '还没结算就不该有报告')
  h.fireEvent(child('child-1'), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })

  const finished = journal.read().events.filter((event) => event.type === 'dispatch/finished')
  assert.equal(finished.length, 1, 'turn/end 必须落一条 dispatch/finished')
  assert.equal(finished[0]?.data.task, 'TASK-001')
  assert.equal(finished[0]?.data.role, 'developer')
  assert.equal(finished[0]?.data.reason, 'completed')

  const reportPath = String(finished[0]?.data.report ?? '')
  assert.equal(reportPath, `evidence/child-reports/${reportFileName('child-1', 'TASK-001')}`, '报告名按「卡 + 子会话」切（复用时不覆盖，评审 N2）')
  const report = readChildReportAt(store, reportPath)
  assert.ok(report !== undefined, '报告文件必须写出（按记录的落点读回）')
  assert.match(report, /最终报告/u, '报告内容 = 最后一条助手消息')
  assert.doesNotMatch(report, /第一段/u, '不该把更早的消息当成报告')

  // ① 状态块（经**真实注册的 sdo_status**）+ ③ 摘要
  const status = await h.callTool('sdo_status', {})
  assert.match(status, /最近完成的派发/u, `状态块要能看到：${status.slice(-400)}`)
  assert.match(status, /TASK-001/u)
  assert.match(status, /child-reports\/TASK-001-child-1\.md/u, '要给出报告落点（含卡 id）')
  assert.match(status, /变异 killed 4/u, '要给出报告摘要（模型不必自己翻文件）')
})

test('M34-02 反向：无关会话的 turn/end 不许落账、也不许写报告（收紧类改动必须证明没拦错/没错收）', () => {
  const h = harness()
  dispatchTo('child-1')
  h.fireEvent(child('someone-else'), assistantMessage('我不是被派发的。'))
  h.fireEvent(child('someone-else'), { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(journal.read().events.filter((event) => event.type === 'dispatch/finished').length, 0, '无关会话不落账')
  assert.equal(existsSync(join(BASE, '.sdo', 'evidence', 'child-reports', 'someone-else.md')), false, '无关会话不写报告')
})

test('M34-03 采集失败必须留痕（真机丢过三次观测：静默 catch 让"没数据"和"没问题"长得一样）', () => {
  // 经真实监听器难以**稳定**逼出异常（采集路径本身被设计成容错），所以这里分两步断言：
  // ① 留痕机制可用（真写入一条，能读回）；② 监听器的 catch 确实调它（接线断言）。
  // 诚实边界：监听器路径上的失败留痕由接线断言覆盖，没有在本用例里复现真实异常。
  journal.append('dispatch/observe-failed', { sessionId: 'child-9', eventType: 'tool/call', error: 'boom' })
  assert.equal(journal.read().events.filter((event) => event.type === 'dispatch/observe-failed').length, 1)
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /office\.noteObserveFailure\(/u, '监听器的 catch 必须记账，不许静默')
  assert.match(index, /const rawType = String\(/u, '失败留痕要能拿到事件类型（哪怕后续抛错）')
})

test('M34-04 采集失败留痕的**确定性**复现（评审 N3）：报告目录被占成普通文件 ⇒ EEXIST ⇒ 留痕且**不**误记完成', () => {
  const h = harness()
  dispatchTo('child-1')
  // 把 `evidence/child-reports` 预占成一个**普通文件** ⇒ 写报告时 mkdir 必然 EEXIST
  mkdirSync(join(BASE, '.sdo', 'evidence'), { recursive: true })
  writeFileSync(join(BASE, '.sdo', 'evidence', 'child-reports'), 'not a directory', 'utf8')

  h.fireEvent(child('child-1'), assistantMessage('最终报告：……'))
  h.fireEvent(child('child-1'), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })

  const types = journal.read().events.map((event) => event.type)
  assert.equal(types.filter((type) => type === 'dispatch/observe-failed').length, 1, '写报告失败必须留痕')
  assert.equal(types.filter((type) => type === 'dispatch/finished').length, 0, '失败不许被伪装成"完成"')
})

test('M34-05 复用前瞻（评审 N2）：同一子会话为**两张卡**结算 ⇒ 两份报告，互不覆盖', () => {
  const h = harness()
  journal.append('dispatch/started', { task: 'TASK-041', provider: 'spawn', childSessionId: 'child-9', tools: 9, role: 'developer' })
  h.fireEvent(child('child-9'), assistantMessage('TASK-041 的报告'))
  h.fireEvent(child('child-9'), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })

  // 同一个子会话接着做第二张卡（方案 3 的复用形态：append 一条新的派发即可）
  journal.append('dispatch/started', { task: 'TASK-042', provider: 'spawn', childSessionId: 'child-9', tools: 9, role: 'developer' })
  h.fireEvent(child('child-9'), assistantMessage('TASK-042 的报告'))
  h.fireEvent(child('child-9'), { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'completed' } } })

  const reports = journal.read().events.filter((event) => event.type === 'dispatch/finished').map((event) => String(event.data.report))
  assert.equal(reports.length, 2, '两次结算两条记录')
  assert.notEqual(reports[0], reports[1], '报告落点必须按卡区分（否则第二张卡会覆盖第一张）')
  assert.match(String(reports[0]), /TASK-041/u)
  assert.match(String(reports[1]), /TASK-042/u)
  assert.match(String(readChildReportAt(store, String(reports[0]))), /TASK-041 的报告/u, '第一张卡的报告正文还在')
})

test('M34-06 取汇报③「推」半：子代理结算后，**下一次工具回执**就带上它的报告；只送一次', async () => {
  const h = harness()
  dispatchTo('child-1')
  h.fireEvent(child('child-1'), assistantMessage('最终报告：改了 schema 的复合键；契约测试 2 条、变异 killed 4。'))
  h.fireEvent(child('child-1'), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })

  // ① 下一次**任何** SDO 工具回执都要带上它（宿主不给投递通道，就用回执当载体）
  const first = await h.callTool('sdo_status', {})
  assert.match(first, /子代理报告（已自动送达）/u, `要自动送达：${first.slice(-500)}`)
  assert.match(first, /TASK-001/u)
  assert.match(first, /TASK-001-child-1\.md/u, '要给报告落点')
  assert.match(first, /变异 killed 4/u, '要给报告摘要')
  assert.equal(journal.read().events.filter((event) => event.type === 'dispatch/reported').length, 1, '送达要留痕（重启后不重推）')

  // ② 反向：送过一次就不再重复送（否则每次调用都刷屏）
  const second = await h.callTool('sdo_status', {})
  assert.doesNotMatch(second, /子代理报告（已自动送达）/u, '同一份报告只送一次')
})
