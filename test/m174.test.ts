/**
 * **增量 174：DEF-033（major，第三批 §3.13）—— 完成语义未区分"局部态"与"全局冻结态"**。
 *
 * 修前现盘：既**没有**"局部态/全局冻结态"的字段，也没有对应判据 ⇒ 「卡 `done` 时全量必须全绿」与
 * 「兄弟卡在飞」**结构性冲突**（一张卡没法在别人的半成品上宣布完成，而 `done` 又不允许"局部绿"）。
 * ⚠️ 与 `DEF-007` 的 `exclusive` **不是一回事**：后者管"同一时刻谁在跑"（派发面），`done` 路径不读它。
 *
 * 落法（DoD 的第一条路：**允许局部绿 + 显式声明未冻结**，两条都必须与"兄弟卡在飞"共存）：
 *   · `done` 的语义 = **本卡范围内全绿**；卡上 `unfrozen` 逐条点名**哪些在飞卡的工作没有并进来**；
 *   · 每条必须是**存在且当前确实在飞**的卡 id（写错 / 写一张已 done 的 / 写本卡自己 ⇒ **可读拒绝**、零写盘）；
 *   · 有在飞兄弟卡却**漏声明** ⇒ `done` 照常成功（**不拦收工**），但回执**逐条点名**缺失的那些；
 *   · 一条在飞兄弟卡都没有 ⇒ 回执明说"本次 `done` 等同于全量冻结"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { createOfficeTools } from '../src/interface/tools.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m174/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's-dev-a', cwd: WORKSPACE } as unknown as OfficeCall

interface ToolDefinition { name: string; parameters: { properties?: Record<string, unknown> }; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

/** 一张卡（`status` 由夹具给；写盘直给，免去认领链）。 */
function card(id: string, status: TaskCard['status']): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    // `owner` 必须与回报人一致（报告路径按 owner 核权）——夹具直给，免认领链
    owner: 'dev-a',
    blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'small', revision: 1,
    status, requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task })
}

const report = (unfrozen?: string[]): ReturnType<SoftwareDevOffice['reportTask']> =>
  office.reportTask(call, {
    taskId: 'TASK-001', owner: 'dev-a', status: 'done',
    evidence: [{ kind: 'command', detail: 'npm test', exitCode: 0 }],
    ...(unfrozen === undefined ? {} : { unfrozen }),
  } as never)

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
  apply(makeCtx() as unknown as Context, Config({} as SdoConfig))
  return async (name, args) => {
    const tool = tools.find((item) => item.name === name)
    assert.ok(tool !== undefined, `工具面缺少 ${name}`)
    const properties = tool.parameters.properties ?? {}
    const filtered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
    const exec = { agent: { id: 's-dev-a', session: { header: { id: 's-dev-a', cwd: WORKSPACE, delegationDepth: 1, parentSession: 'cockpit' } } } }
    return String(await tool.execute(filtered, exec))
  }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-dev-a', WORKSPACE)
  office.init(call, { name: 'M174 完成语义', scale: 'normal', stakeholders: ['业务方'] })
  card('TASK-001', 'in-progress')   // 本卡（夹具直接给 in-progress，免认领链；owner 与回报人一致）
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M174-01 三态：兄弟卡在飞 + 漏声明 ⇒ 逐条点名（不拦收工）；声明齐 ⇒ 局部绿；无在飞卡 ⇒ 全量冻结', () => {
  // ① 兄弟卡在飞、**漏声明** ⇒ done 成功 + unfrozenMissing 逐条点名
  card('TASK-002', 'in-progress')
  const missing = report()
  assert.equal(missing.ok, true, '**不拦收工**：done 的语义是本卡范围绿，不是"全量必须绿"（修前的结构性冲突就在这）')
  if (missing.ok) {
    assert.deepEqual(missing.unfrozenMissing, ['TASK-002'], '漏声明的在飞兄弟卡必须逐条点名')
    assert.equal(missing.unfrozen, undefined, '没声明 ⇒ 不写这个键（存量形状不变）')
  }

  // ② 声明齐 ⇒ done 成功 + 局部绿读数 + **落进卡**
  card('TASK-003', 'in-progress')
  const declared = office.reportTask(call, {
    taskId: 'TASK-001', owner: 'dev-a', status: 'done',
    evidence: [{ kind: 'command', detail: 'npm test', exitCode: 0 }],
    unfrozen: ['TASK-002', 'TASK-003'],
  } as never)
  assert.equal(declared.ok, true)
  if (declared.ok) {
    assert.deepEqual(declared.unfrozen, ['TASK-002', 'TASK-003'], '局部绿读数 = 未冻结清单')
    assert.equal(declared.unfrozenMissing, undefined, '声明齐了就不该再点名')
  }
  const stored = office.tasks(call).find((item) => item.id === 'TASK-001')
  assert.deepEqual(stored?.unfrozen, ['TASK-002', 'TASK-003'], '未冻结清单必须落进卡（否则下次读回来就没了）')

  // ③ 无在飞兄弟卡 ⇒ 两个读数都空（= 回执那句"等同于全量冻结"）
  // 注意：② 里的"声明"只对**那一次** done 说话，不会把兄弟卡冻结掉 ⇒ 这里先把它们收口
  card('TASK-002', 'done')
  card('TASK-003', 'done')
  card('TASK-004', 'in-progress')
  const frozen = office.reportTask(call, {
    taskId: 'TASK-004', owner: 'dev-a', status: 'done',
    evidence: [{ kind: 'command', detail: 'npm test', exitCode: 0 }],
  } as never)
  assert.equal(frozen.ok, true)
  if (frozen.ok) {
    assert.equal(frozen.unfrozen, undefined, '无在飞卡 ⇒ 不是局部绿')
    assert.equal(frozen.unfrozenMissing, undefined, '无在飞卡 ⇒ 没有未声明的兄弟卡')
  }
})

test('M174-02 反例（假声明可读拒绝、零写盘）：不存在的 id / 已 done 的卡 / 本卡自己', () => {
  card('TASK-002', 'in-progress')
  card('TASK-003', 'done')
  for (const [label, ids] of [
    ['不存在的 id', ['TASK-999']],
    ['已经 done 的卡', ['TASK-003']],
    ['本卡自己', ['TASK-001']],
  ] as const) {
    const outcome = report([...ids])
    assert.equal(outcome.ok, false, `${label} 必须被拒（假声明不能把"未冻结"糊过去）`)
    if (!outcome.ok) {
      assert.equal(outcome.code, 'unfrozen-bad-id', `拒因码要自成一类：${JSON.stringify(outcome)}`)
      assert.match(outcome.detail, new RegExp(ids[0] as string, 'u'), '拒因必须点名那条交代不清的 id')
      assert.match(outcome.detail, /没有写入/u, '拒因必须说清零写盘')
    }
  }
  // 零写盘：卡仍是 in-progress、没落 unfrozen 键
  const stored = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-001.yml')?.task
  assert.equal(stored?.status, 'in-progress', '被拒时卡状态不许变')
  assert.equal(stored?.unfrozen, undefined, '被拒时不许落键')
})

test('M174-03 工具面：回执把完成语义说清（局部绿 / 漏声明 / 等同于全量冻结），且参数进了注册面', async () => {
  const callTool = toolHarness()
  const c2 = createOfficeTools({} as never) as unknown as { name: string; parameters: { properties: Record<string, unknown> } }[]
  const taskTool = c2.find((item) => item.name === 'sdo_task')
  assert.ok(taskTool?.parameters.properties['unfrozen'] !== undefined, '注册面必须有 unfrozen（否则模型根本传不进来）')

  card('TASK-002', 'in-progress')
  // ① 漏声明 ⇒ 回执点名
  const missing = await callTool('sdo_task', {
    action: 'done', id: 'TASK-001', owner: 'dev-a', status: 'done',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
  })
  assert.match(missing, /被声明进未冻结清单/u, `回执必须点名漏声明的在飞卡：${missing.slice(0, 300)}`)
  assert.match(missing, /TASK-002/u, '点名要到 id')

  // ② 声明齐 ⇒ 回执说"局部绿"并列出未冻结面
  card('TASK-004', 'in-progress')
  const local = await callTool('sdo_task', {
    action: 'done', id: 'TASK-004', owner: 'dev-a', status: 'done',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
    // ① 之后 TASK-001 已经收口 ⇒ 在飞的只剩 TASK-002（声明的每条都必须在飞，否则可读拒绝）
    unfrozen: '["TASK-002"]',
  })
  assert.match(local, /局部绿/u, `回执必须说清"本次是局部绿"：${local.slice(0, 300)}`)
  assert.match(local, /TASK-002/u, '未冻结清单要出现在回执里')
  assert.match(local, /尚未冻结/u, '要说清全项目尚未冻结')
})

test('M174-04 结构：`unfrozen` 进了读端白名单（写盘能读回），且工具面参数在', () => {
  const store = office.storeFor(WORKSPACE)
  store.writeYaml(['tasks', 'TASK-009.yml'], {
    task: { ...({ id: 'TASK-009', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'], blockedBy: [], writeScopes: [], role: 'developer', size: 'small', revision: 1, status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '' } as TaskCard), unfrozen: ['TASK-002'] },
  })
  const read = office.tasks(call).find((item) => item.id === 'TASK-009')
  assert.deepEqual(read?.unfrozen, ['TASK-002'], '`unfrozen` 必须在读端白名单里（否则写了也读不回来 = 静默丢弃）')
})
