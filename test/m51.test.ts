/**
 * 整仓评审（`.review/2026-10-06-插件代码整体评审（评审员）.md`）里我**亲手复核成立**的条目回归：
 *   · **D1（blocker）** 宿主 `write`/`edit` 的真实入参键是 **`file_path`**，插件旧代码读 `path`/`file`/`paths`
 *     ⇒ `paths` 恒空、快照与 `truth/file-written` 在真机**一次都没跑过**。这里用**真实钩子 + 真实键**驱动。
 *   · **D2（blocker）** 撕尾（半写行）后 `append` 复用坏行声明的 `seq` 并把新事件**粘在坏行后** ⇒ 这里断言
 *     「新 seq 不撞车」且「行边界被修复（一行一个 JSON）」。
 *   · **D5/D11** 非法/缺失的 `status` / `outcome` 旧实现静默落成 `pass` ⇒ 现值必须**可读拒绝**。
 *   · **D6** 任意角色都能 `drop` 未完成的卡 ⇒ C-40 变绿 ⇒ 现值只允许流程官（或认领会话本人 release/update）。
 *   · **D9** 空 findings 的 `pass` 评审翻绿 C-42 ⇒ 现值必须显式写出 findings。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { claim } from '../src/domain/collab.js'
import type { SdoConfig } from '../src/config.js'
import type { Context } from '@deepseek-ai/cordis'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm51')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}
type Hook = (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
type PostHook = (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>

function harness(): { callTool: (name: string, args: Record<string, unknown>, sessionId: string) => Promise<string>; pre: Hook; post: PostHook } {
  const registered: ToolDefinition[] = []
  const listeners = new Map<string, unknown>()
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition): (() => void) => { registered.push(tool); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (event: string, listener: unknown) => { listeners.set(event, listener); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return {
    pre: listeners.get('tools/pre-execute') as Hook,
    post: listeners.get('tools/post-execute') as PostHook,
    async callTool(name, args, sessionId) {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `工具面缺少 ${name}`)
      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
      const exec = { agent: { id: sessionId, session: { header: { id: sessionId, cwd: BASE, delegationDepth: 1 } } } }
      return String(await tool.execute(filtered, exec))
    },
  }
}

function card(id: string, role = 'developer'): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: role as TaskCard['role'], size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  new SdoStore(join(BASE, '.sdo')).writeYaml(['tasks', `${id}.yml`], { task })
}

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

test('D1：真实钩子 + 宿主真实入参键 `file_path` ⇒ 改 `.sdo/` 真源要**先快照**、**写成功后有事件**', async () => {
  const { pre, post } = harness()
  mkdirSync(join(BASE, '.sdo', 'design'), { recursive: true })
  writeFileSync(join(BASE, '.sdo', 'design', 'deviations.yml'), 'DEV-001: 原始正文\n', 'utf8')

  // pre：写了 `.sdo/` 真源 ⇒ 快照（宿主 `write` 用的是 `file_path`，不是 `path`）
  const exec = { name: 'write', arguments: { file_path: '.sdo/design/deviations.yml', content: 'x' }, agent: { session: { header: { id: 's-cockpit', cwd: BASE, delegationDepth: 0 } } } }
  await pre(exec, async () => ({ kind: 'allow' }))
  const history = join(BASE, '.sdo', 'evidence', 'file-history')
  assert.equal(existsSync(history), true, 'D1：真实键下必须留下快照（旧代码读 `path` ⇒ 这里恒空）')
  const snaps = readdirSync(history)
  assert.equal(snaps.length, 1)
  assert.match(readFileSync(join(history, snaps[0] ?? ''), 'utf8'), /原始正文/u, '快照是**覆盖前**的内容')

  // post：**模拟宿主真的写了盘**（R2 之后"内容没变"不记账），再落 `truth/file-written`（含 sha256）
  writeFileSync(join(BASE, '.sdo', 'design', 'deviations.yml'), 'DEV-001: 改写后的正文\n', 'utf8')
  await post(exec, { kind: 'accept' }, async () => ({ kind: 'accept' }))
  const events = journal.read().events.filter((event) => event.type === 'truth/file-written')
  assert.equal(events.length, 1, 'D1：post 钩子也要用真实键（否则 C-25/G3 收不到信号）')
  assert.equal(events[0]?.data.path, '.sdo/design/deviations.yml')

  // 反向：非 `.sdo/` 路径不产生快照/事件（不制造噪音）
  const src = { name: 'write', arguments: { file_path: 'src/plain.ts', content: 'y' }, agent: { session: { header: { id: 's-cockpit', cwd: BASE, delegationDepth: 0 } } } }
  await pre(src, async () => ({ kind: 'allow' }))
  await post(src, { kind: 'accept' }, async () => ({ kind: 'accept' }))
  assert.equal(readdirSync(history).length, 1, '普通源码不写快照')
  assert.equal(journal.read().events.filter((event) => event.type === 'truth/file-written').length, 1)

  // **R2**：① 写**失败**（宿主 `isError: true`）不得记账 —— 一次失败的写入把 G3 签字作废是撒谎
  const failExec = { name: 'write', arguments: { file_path: '.sdo/design/deviations.yml', content: 'x' }, agent: { session: { header: { id: 's-cockpit', cwd: BASE, delegationDepth: 0 } } } }
  await pre(failExec, async () => ({ kind: 'allow' }))
  // 让盘上内容**真的变了**（模拟"写了一半"）——这样只有 isError 这道闸门能挡住记账，
  // 否则"内容没变"那道闸门会替它兜底，用例就测不出 isError（变异自证会漏）
  writeFileSync(join(BASE, '.sdo', 'design', 'deviations.yml'), 'DEV-001: 写了一半\n', 'utf8')
  await post(failExec, { isError: true }, async () => ({ isError: true }))
  assert.equal(
    journal.read().events.filter((event) => event.type === 'truth/file-written').length,
    1,
    'R2：写失败不得记 truth/file-written',
  )

  // **R2**：② 内容**没变**的重写也不记（只有真源真的变了才作废签字）
  const sameExec = { name: 'write', arguments: { file_path: '.sdo/design/deviations.yml', content: 'same' }, agent: { session: { header: { id: 's-cockpit', cwd: BASE, delegationDepth: 0 } } } }
  await pre(sameExec, async () => ({ kind: 'allow' }))
  await post(sameExec, { kind: 'accept' }, async () => ({ kind: 'accept' }))
  assert.equal(
    journal.read().events.filter((event) => event.type === 'truth/file-written').length,
    1,
    'R2：内容未变的重写不得记账',
  )
})

test('D2：撕尾（半写行声明 seq=4）之后 append 不得撞号、也不得粘行', () => {
  journal.append('project/created', { id: 'PRJ-001' })
  journal.append('project/updated', { id: 'PRJ-001' })
  journal.append('project/updated', { id: 'PRJ-001' })
  assert.deepEqual(journal.read().events.map((event) => event.seq), [1, 2, 3])

  // 模拟崩溃：末尾追加**没有换行**的半写行，且它声明了 seq=4
  const text = readFileSync(join(BASE, '.sdo', 'journal.jsonl'), 'utf8')
  writeFileSync(join(BASE, '.sdo', 'journal.jsonl'), text + '{"seq":4,"at":"x","type":"project/upd', 'utf8')

  const appended = journal.append('project/updated', { id: 'PRJ-001' })
  assert.equal(appended.seq, 5, 'D2：坏行声明的 seq=4 要被看见 ⇒ 新事件拿 5（旧实现会拿 4）')

  const raw = readFileSync(join(BASE, '.sdo', 'journal.jsonl'), 'utf8')
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  assert.equal(lines.length, 5, '行边界要被修复：坏行独立一行 + 新事件独立一行（不许粘成一行）')
  const parsed = lines.map((line) => { try { return JSON.parse(line) as { seq?: number } } catch { return undefined } })
  assert.equal(parsed.filter((item) => item !== undefined).length, 4, '四个可解析事件')
  assert.deepEqual(parsed.filter((item) => item !== undefined).map((item) => item?.seq), [1, 2, 3, 5], '可解析事件的 seq 单调且不重复')
})

test('D5 / D11：非法与缺失的 `status` / `outcome` 必须**可读拒绝**，不得静默落成 pass', async () => {
  const { callTool } = harness()
  const bad = await callTool('sdo_test', { action: 'record', caseId: 'TC-001', status: 'passed', evidence: 'node --test 全绿' }, 's-cockpit')
  assert.match(bad, /取值非法/u, `D5：status="passed" 必须被拒（真机曾被写成 pass）：${bad}`)
  const missing = await callTool('sdo_test', { action: 'record', caseId: 'TC-001', evidence: 'x' }, 's-cockpit')
  // 缺失 status 由既有的必填 guard 拦下（同样是"拒绝"，关键是不能落成 pass）
  assert.match(missing, /取值非法|需要 `caseId` 与 `status`/u, `D5：缺失 status 也要拒：${missing}`)

  const run = await callTool('sdo_deliver', { action: 'run', target: 'server', command: './run', evidence: 'log' }, 's-cockpit')
  assert.match(run, /outcome|结论取值非法/u, `D11：省略 outcome 的运行记录必须被拒：${run}`)
  // 写错的取值由**宿主 schema 校验**先挡下（工具面声明了 enum）—— 这里断言它确实被挡（抛错），
  // 而"**省略** outcome"这一条 schema 挡不住（缺字段合法）⇒ 必须由处理器拒（上面那条）。
  await assert.rejects(
    async () => callTool('sdo_deliver', { action: 'run', target: 'server', command: './run', outcome: 'ok', evidence: 'log' }, 's-cockpit'),
    /outcome/u,
    'D11：写错的 outcome 必须被挡（schema 或处理器都算）',
  )
  const good = await callTool('sdo_deliver', { action: 'run', target: 'server', command: './run', outcome: 'fail', evidence: 'crash.log' }, 's-cockpit')
  assert.match(good, /fail|失败/u, `D11：显式 fail 要如实记录：${good}`)
})

test('D6：非流程官会话不得 `drop` 未完成的卡（真机上这一下让 C-40 变绿）', async () => {
  card('TASK-001')
  // 真实形状：子代理是**被派发出去**的 ⇒ 真源里有 `dispatch/started`（D6 用它判"谁是被派出去的"）
  journal.append('dispatch/started', { task: 'TASK-001', childSessionId: 's-dev', role: 'developer', tools: 9, mode: 'continuable' })
  claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', sessionId: 's-dev', expectedRevision: 1 })
  const { callTool } = harness()

  const denied = await callTool('sdo_task', { action: 'drop', id: 'TASK-001', reason: '不想做' }, 's-dev')
  assert.match(denied, /职权/u, `D6：子代理不得放弃卡：${denied}`)
  assert.equal(journal.read().events.filter((event) => event.type === 'task/dropped').length, 0, '被拒不得落盘')

  // 反向：驾驶舱（未认领会话 ⇒ cockpit）可以
  const allowed = await callTool('sdo_task', { action: 'drop', id: 'TASK-001', reason: '重复卡' }, 's-cockpit')
  assert.doesNotMatch(allowed, /职权/u, `驾驶舱应可放弃：${allowed}`)
  assert.equal(journal.read().events.filter((event) => event.type === 'task/dropped').length, 1)
})

test('D9 / D10：空 findings 的 pass 评审被拒；plan-reviewed 回执不漏占位符', async () => {
  card('TASK-002')
  claim(store, journal, { taskId: 'TASK-002', owner: 'dev-b', sessionId: 's-dev2', expectedRevision: 1 })
  const { callTool } = harness()
  const empty = await callTool('sdo_review', { action: 'record', taskId: 'TASK-002', reviewer: 'subagent:reviewer:9', verdict: 'pass', findings: '[]' }, 's-other')
  assert.match(empty, /findings/u, `D9：空评审不得翻绿 C-42：${empty}`)

  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(source, /fmt\('uiIndex\.planReviewed', \{ p1: args\.approvedBy/u, 'D10：这一分支必须把 approvedBy 交给 fmt（否则回执漏 {x}）')
  assert.doesNotMatch(source, /return t\('uiIndex\.planReviewed'\)/u, 'D10：旧的裸 t() 必须消失')
})
