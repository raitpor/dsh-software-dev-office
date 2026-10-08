/**
 * **子代理看不了图片**（真机 TASK-183 原话：「developer 角色掩码里没有 `read_image`（这是插件的角色掩码
 * 决定的，不是模型不支持），所以我**看不了截图**」）的回归。
 *
 * 根因不是"漏了一个工具"，而是掩码是**白名单**：`roles.yml` 没列的就被 `roleMaskDecision` 拒。
 * 宿主提供 `read_image` 与 `pdf` 两个只读检视工具，而 **8 个角色的 allow 里一个都没有** ⇒ 所有子代理
 * （developer / tester / reviewer / architect / analyst / delivery / office / red-team）都看不见图。
 *
 * 修法（机制化，不逐条补数据）：把只读检视工具并入**每个角色的基础面**（`deny` 仍然优先）。
 * 本用例两层都钉住：① 八个角色的面都含它们；② **真实 `tools/pre-execute` 钩子**对已认领角色的
 * `read_image` / `pdf` 放行，同时对掩码外工具照旧拒绝（证明没有把闸门整体放开）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { claim } from '../src/domain/collab.js'
import { READ_ONLY_INSPECTION_TOOLS, filterKnownTools, maskAllows, roleCard, toolAllowList } from '../src/domain/roles.js'
import { ROLES } from '../src/domain/plan.js'
import type { SdoConfig } from '../src/config.js'
import type { Context } from '@deepseek-ai/cordis'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm46')
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

function writeCard(id: string, role: string): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: role as TaskCard['role'], size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
}

/** 真装配（`apply`）并捕获 `tools/pre-execute` 监听器（与 M31-08 同款）。 */
function hookHarness(): { drive: (name: string, sessionId: string) => Promise<{ kind: string; reason?: string }> } {
  const listeners = new Map<string, (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  const services: Record<string, unknown> = { tools: { register: () => () => {} }, sessions: {} }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (event: string, listener: never) => { listeners.set(event, listener); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const listener = listeners.get('tools/pre-execute')
  assert.ok(listener !== undefined, '真实装配必须注册 tools/pre-execute 监听器')
  return {
    async drive(name: string, sessionId: string): Promise<{ kind: string; reason?: string }> {
      const exec = { name, arguments: {}, agent: { session: { header: { id: sessionId, cwd: BASE, delegationDepth: 1 } } } }
      return (await listener(exec, async () => ({ kind: 'allow' }))) as { kind: string; reason?: string }
    },
  }
}

test('八个角色的工具面都含只读检视工具（含 `read_image`）—— 掩码不再让任何人"看不见图"', () => {
  assert.deepEqual([...READ_ONLY_INSPECTION_TOOLS], ['read', 'grep', 'glob', 'read_image'])
  for (const role of ROLES) {
    const face = toolAllowList(role)
    for (const tool of READ_ONLY_INSPECTION_TOOLS) {
      assert.equal(face.includes(tool), true, `${role} 的工具面缺 ${tool}（子代理会"看不了图"）`)
      assert.equal(maskAllows(role, tool), true, `${role} 必须能调 ${tool}`)
    }
  }
  // **反向**：deny 仍然优先、写类/流程类工具照旧逐条列举（没有把闸门整体放开）
  assert.equal(maskAllows('architect', 'bash'), false, 'deny 优先')
  assert.equal(maskAllows('delivery', 'sdo_design'), false)
  assert.equal(maskAllows('reviewer', 'write'), false, 'reviewer 仍然不能写')
  assert.equal(maskAllows('developer', 'sdo_gate'), false, '流程工具仍按角色列举')
  assert.equal(maskAllows('tester', 'read_image'), true, '跑测试的人要能看渲染截图')
})

test('接线：派发前必须按宿主注册表过滤工具面（`filterKnownTools` 在 index.ts 的派发路径上）', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /filterKnownTools\(request\.toolDeny, probe\)/u, 'deny 面要过过滤（restrict() 对未知名硬校验）')
  assert.match(index, /kToolFilterDropped/u, '被剔掉的名字要如实回报')
  // **D-14（blocker）**：探针必须带上调用方 agent 的作用域（省略 scope 只查全局层 ⇒ 整份名单全判未知）
  assert.match(index, /api\.get\?\.\(name, scope\)/u, '探针要按 agent 作用域查（D-14 的根因就在这里）')
  assert.match(index, /kToolFilterProbeBlind/u, '探针整份名单全未知时必须显式告警，不得静默清空白名单')
  assert.match(index, /denyTools: denyFiltered\.applied\.length/u, 'dispatch/started 记的是**实际下发**的 deny 面条数')
  assert.match(index, /tools: request\.sdoAllow\.length/u, 'SDO 流程面白名单条数也要进台账')
  // **2026-10-08 口径纠正**：下发的只有 deny（allow 一填就把整个通用面挡掉了 —— 真机事故）
  assert.match(index, /sdoNames: officeToolNames/u, 'deny 面必须按**真实注册名**算（不硬编码第二份）')
  assert.doesNotMatch(index, /toolFilter: allowFiltered\.applied/u, '不许再把 allow 当白名单下发')
  // 成功回执也必须报**实际下发**的那份（变异自证：把这里换回角色意图必须有用例变红）
  const startedCall = index.slice(index.indexOf('describeDispatchStarted('))
  assert.match(startedCall.slice(0, 800), /denyFiltered\.applied/u, '成功回执要报实际下发的 deny 面')
})

test('工具面里**不许出现宿主未注册的名字**（真机回归：`pdf` 让 `tools.restrict()` 抛错、整份工具面失效）', () => {
  // 宿主已注册、且角色卡允许引用的工具（含插件自己的 sdo_*）。**新名字要先确认真机注册过再加**。
  const HOST_TOOLS = new Set(['skill', 'read', 'write', 'edit', 'glob', 'grep', 'read_image', 'bash', 'ask_user_question'])
  const isPluginTool = (name: string): boolean => name.startsWith('sdo_')
  for (const role of ROLES) {
    const names = [...toolAllowList(role), ...(roleCard(role)?.deny ?? [])]
    for (const name of names) {
      assert.ok(
        HOST_TOOLS.has(name) || isPluginTool(name),
        `${role} 的工具名「${name}」不在宿主已注册清单里 —— 它会进 toolFilter，而宿主 tools.restrict() 对未知名**直接抛错**（真机 pdf 回归：子代理连 read_image 都拿不到）`,
      )
    }
  }

  // `filterKnownTools`：按宿主注册表剔除未知名，并如实报告剔掉了什么
  const known = (name: string): boolean => HOST_TOOLS.has(name) || isPluginTool(name)
  const filtered = filterKnownTools(['read', 'read_image', 'pdf', 'sdo_task'], known)
  assert.deepEqual(filtered.kept, ['read', 'read_image', 'sdo_task'])
  assert.deepEqual(filtered.dropped, ['pdf'], '剔掉的名字要能回报（绝不静默改小工具面）')

  // 模拟宿主 `tools.restrict()` 的硬校验：过滤后的列表必须被接受（未过滤的必须被拒）
  const restrict = (filter: { allow: string[]; deny: string[] }): void => {
    const unknown = [...filter.allow, ...filter.deny].filter((name) => !known(name))
    if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`)
  }
  assert.doesNotThrow(() => restrict({ allow: filtered.kept, deny: [] }), '过滤后的工具面必须能被宿主接受')
  assert.throws(() => restrict({ allow: ['read', 'pdf'], deny: [] }), /unknown global tool/u, '不过滤就会被宿主拒（这就是真机症状）')
})

test('真实钩子：已认领 developer 会话调 `read_image` 放行；掩码外工具照旧拒绝', async () => {
  writeCard('TASK-001', 'developer')
  claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', sessionId: 's-dev', expectedRevision: 1 })
  const { drive } = hookHarness()

  assert.equal((await drive('read_image', 's-dev')).kind, 'allow', '子代理必须能读图（真机缺陷就是这里被拒）')
  assert.equal((await drive('read', 's-dev')).kind, 'allow')
  assert.equal((await drive('write', 's-dev')).kind, 'allow', 'developer 的写工具照旧放行')

  // 反向：掩码仍然咬人（否则修法就成了"整体放行"）
  const denied = await drive('sdo_gate', 's-dev')
  assert.equal(denied.kind, 'deny', 'developer 调 sdo_gate 仍必须被拒')
  assert.match(denied.reason ?? '', /developer/u)
})
