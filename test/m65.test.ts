/**
 * 第一轮整仓评审 §2 第 1 条（评审员"读码成立、两次探针都没能定住"）：**掩码只在卡处于 `in-progress` 时存在**。
 *
 * 归属（`claimsBySession`）要求认领事件的卡**仍然 `in-progress`**；卡一旦离开（done / dropped /
 * blocked / ready）归属即失效，`attributeRole` 于是退回 `unclaimed-child` ⇒ **掩码整段跳过**。
 * 也就是说：驾驶舱把卡 `drop` 掉（或卡被 done）之后，那个**仍在飞 / 仍存活**的子会话就再没有掩码了。
 *
 * ⚠️ **口径更新（第五批 §3.1 / `DEF-078`）**：上面那句「退回 `unclaimed-child` ⇒ 掩码整段跳过」
 * 说的是**修前**。现在认得出**血缘角色**的会话照旧按角色（本轮修法）；而**真的角色未知**的会话
 * （不是我们派的、或角色名坏掉）不再"跳过掩码"，而是落**声明给出的最小面**
 * （`roles.yml` 的 `unclaimed:`：保留认领与探查，收窄权威面与写类）。见 `M65-03`。
 *
 * 我的探针第一次也"没定住"：**角色缓存**（`roleCacheVersion` + 5 秒 TTL）只会在认领/回报时失效，
 * `drop` 不碰它，所以立刻重试仍是 DENY —— 等过 TTL 再试才现出原形：
 *
 * ```text
 * ② in-progress 时 reviewer 子会话调 `write`（掩码里没有）⇒ DENY
 * ③ 驾驶舱 drop 这张卡（真路径）
 * ④ 等过 5 秒 TTL 后再试 ⇒ ALLOW   ← 掩码消失，而 dispatch/started 血缘仍在
 * ```
 *
 * 修法（fail-closed）：**血缘角色兜底** —— 只要这个会话是被我们派发出去的（`dispatch/started`），
 * 没有活的认领时就用**派发那一刻记下的角色**（同一会话被复用多次 ⇒ 取最新一条）。角色来自追加式真源、
 * 不随卡的可手改状态改变；仍认不出的会话（不是我们派的子会话）保持原口径 fail-open。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { attributeRole, claimsBySession } from '../src/domain/roles.js'
import type { Context } from '@deepseek-ai/cordis'
import type { TaskCard } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm65')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}
type Hook = (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>

let store: SdoStore
let journal: Journal

function card(id: string, role: string, evidenceKind: 'artifact' | 'command' = 'artifact'): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: [evidenceKind],
    blockedBy: [], writeScopes: [`src/${id}/`], role: role as TaskCard['role'], size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
}

function harness(): { callTool: (name: string, args: Record<string, unknown>, sessionId: string, depth?: number) => Promise<string>; pre: Hook } {
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
  apply(makeCtx() as unknown as Context, Config({} as never))
  const agentOf = (id: string, depth: number): unknown => ({
    id,
    session: { header: { id, cwd: BASE, delegationDepth: depth, ...(depth === 0 ? {} : { parentSession: 'cockpit' }) } },
  })
  return {
    pre: listeners.get('tools/pre-execute') as Hook,
    async callTool(name, args, sessionId, depth = 1) {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `工具面缺少 ${name}`)
      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
      return String(await tool.execute(filtered, { agent: agentOf(sessionId, depth) }))
    },
  }
}

/** 走一次真实 pre-execute 钩子：这个会话能不能调这个工具（掩码判定的**唯一**生产路径）。 */
async function toolVerdict(pre: Hook, tool: string, sessionId: string, filePath = 'src/evil.ts'): Promise<'allow' | 'deny'> {
  const exec = {
    name: tool,
    arguments: { file_path: filePath, content: 'x', old_string: 'a', new_string: 'b' },
    agent: { id: sessionId, session: { header: { id: sessionId, cwd: BASE, delegationDepth: 1, parentSession: 'cockpit' } } },
  }
  const out = (await pre(exec, async () => ({ kind: 'allow' }))) as { kind?: string } | undefined
  return out?.kind === 'deny' ? 'deny' : 'allow'
}

/** 认领/回报会 +1 角色缓存版本号；`drop` 不会 —— 用它强制重算归属（= 等过 TTL 的等价物，快且确定）。 */
async function bumpRoleCacheVersion(callTool: (name: string, args: Record<string, unknown>, sessionId: string, depth?: number) => Promise<string>): Promise<void> {
  card('TASK-900', 'developer')
  // **`TASK-171`（`DEF-162` 第①条）**：这里原本用 `owner: 'cockpit'` 认领 `role: developer` 的卡
  // —— 那正是 `DEF-162` 的真机形态（流程官认领实现卡），认领面现在会**拒绝**它。
  // 本辅助函数的意图只是「让角色缓存版本 +1」（认领成功就会 +1），与"谁来认领"无关
  // ⇒ 换成合法形态 `subagent:developer:1`，四处用例的断言一字不动。
  const out = await callTool('sdo_task', { action: 'claim', id: 'TASK-900', owner: 'subagent:developer:1', expectedRevision: 1 }, 'cockpit', 0)
  assert.match(out, /in-progress/u, `前置：认领要成功（用于强制重算角色缓存）：${out}`)
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M65-01 卡离开 in-progress 后，仍在飞的子会话**不得**失去掩码（血缘角色兜底）', async () => {
  card('TASK-001', 'reviewer')
  const h = harness()
  const claimed = await h.callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'sub-reviewer', expectedRevision: 1 }, 'child-1')
  assert.match(claimed, /in-progress/u, `前置：reviewer 子会话认领成功：${claimed}`)
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-1', tools: 9, role: 'reviewer' })

  // ① 基线：卡 in-progress ⇒ reviewer 掩码里没有 `write` ⇒ 必须拒绝
  assert.equal(await toolVerdict(h.pre, 'write', 'child-1'), 'deny', '前置：in-progress 时掩码必须生效')
  assert.equal(await toolVerdict(h.pre, 'read', 'child-1'), 'allow', '掩码内工具不许被误拦')

  // ② 卡离开 in-progress（真路径：驾驶舱 drop）—— 归属随之失效（纯函数复核，不含缓存）
  // `DEF-244`（`TASK-270`）起 `drop` 必须声明分档：本格的断言对象是"卡离开 in-progress 之后掩码还在不在"，
  // 分档与本格无关 ⇒ 给最弱的那一档 `never-done`（四档里**唯一**不需要凭据的）。
  const dropped = await h.callTool('sdo_task', { action: 'drop', id: 'TASK-001', disposition: 'never-done' }, 'cockpit', 0)
  assert.match(dropped, /dropped/u, `前置：drop 要成功：${dropped}`)
  assert.deepEqual(claimsBySession(store, journal), [], '前置：卡离开 in-progress 后归属确实失效（这就是本缺陷的触发条件）')
  assert.deepEqual(
    attributeRole({ sessionId: 'child-1', delegationDepth: 1, parentSessionId: 'cockpit', claims: [], dispatchedRole: 'reviewer' }),
    { kind: 'dispatched', role: 'reviewer' },
    '血缘角色必须能独立撑起归属（不依赖卡状态）',
  )

  // ③ 强制重算角色缓存（等价于等过 5 秒 TTL）后：掩码必须**还在**
  await bumpRoleCacheVersion(h.callTool)
  assert.equal(await toolVerdict(h.pre, 'write', 'child-1'), 'deny', '卡 drop 掉不等于子会话的掩码消失（旧实现在这里放行）')
  assert.equal(await toolVerdict(h.pre, 'read', 'child-1'), 'allow', '兜底不许把掩码内的工具一起拦掉')
})

test('M65-02 血缘角色取**最新一次派发**（复用同一子会话换角色时，掩码跟着换）', async () => {
  card('TASK-001', 'reviewer')
  const h = harness()
  await h.callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'sub-x', expectedRevision: 1 }, 'child-1')
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-1', tools: 9, role: 'reviewer' })
  assert.equal(await toolVerdict(h.pre, 'write', 'child-1'), 'deny', '前置：reviewer 不能 write')

  // 卡离开进行中 + 复用同一子会话承接第二张 developer 卡（真实派发会写第二条 dispatch/started）
  // （分档同上一格：本格考的是"掩码跟着最新一次派发换"，与 `drop` 的分档无关）
  await h.callTool('sdo_task', { action: 'drop', id: 'TASK-001', disposition: 'never-done' }, 'cockpit', 0)
  card('TASK-002', 'developer')
  journal.append('dispatch/started', { task: 'TASK-002', provider: 'spawn', childSessionId: 'child-1', tools: 9, role: 'developer' })
  await bumpRoleCacheVersion(h.callTool)

  // 路径取**公共面**（`docs/`）：这条用例考的是「掩码跟着最新一次派发换」，
  // 写范围纪律（卡级 3b）另有 m76 专测 —— 两者分开考，断言才不会互相遮蔽
  assert.equal(await toolVerdict(h.pre, 'write', 'child-1', 'docs/m65.md'), 'allow', 'developer 掩码里有 write ⇒ 复用后要放行')
  assert.equal(await toolVerdict(h.pre, 'sdo_plan', 'child-1'), 'deny', 'developer 掩码里没有 sdo_plan ⇒ 仍要拒绝（新角色真的生效了）')
})

test('M65-03 口径已收紧（DEF-078）：**角色未知**的子会话落最小面（不再 fail-open），但认领与探查不受影响', async () => {
  const h = harness()
  card('TASK-001', 'reviewer')
  await h.callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'sub-reviewer', expectedRevision: 1 }, 'child-1')
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-1', tools: 9, role: 'reviewer' })
  assert.equal(await toolVerdict(h.pre, 'sdo_plan', 'child-1'), 'deny', '前置：认得出的派发角色受掩码约束（reviewer 没有 sdo_plan）')

  // **旧口径（本用例原来的断言）是"不认识 ⇒ 放行"** —— 那正是一条缺陷：它的工具面比任何角色都宽
  // （第四批复验 V7 实测 `sdo_plan` allow）。第五批按 `ADR-016` 收紧成**声明给出的最小面**：
  // 台账里没有 `child-2` 的派发记录 ⇒ 角色未知 ⇒ 权威面**收窄**，而认领通道与只读探查**保留**。
  assert.equal(await toolVerdict(h.pre, 'sdo_plan', 'child-2'), 'deny', '角色未知 ⇒ 权威面收窄（DEF-078；旧口径在这里放行）')
  assert.equal(await toolVerdict(h.pre, 'sdo_task', 'child-2'), 'allow', '认领协议通道必须保留（挡住认领 = 把正常派发卡死）')
  assert.equal(await toolVerdict(h.pre, 'read', 'child-2'), 'allow', '只读探查面必须保留')
  assert.equal(await toolVerdict(h.pre, 'write', 'child-2'), 'deny', '写类在最小面里显式挡住（它还没有卡）')

  // 血缘里有这个会话、但角色名不是八个角色之一（真源被写坏）⇒ 同样落最小面（角色未知）
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-3', tools: 9, role: 'wizard' })
  await bumpRoleCacheVersion(h.callTool)
  assert.equal(await toolVerdict(h.pre, 'sdo_plan', 'child-3'), 'deny', '角色名认不出 ⇒ 也落最小面（不猜，也不放行权威面）')
  assert.equal(await toolVerdict(h.pre, 'read', 'child-3'), 'allow', '只读面仍放行（不是全拒）')
})

test('M65-04 卡走**真实完成/阻塞**路径后掩码仍在（done 会自动 +1 角色缓存版本 ⇒ 不能用"缓存还没过期"解释）', async () => {
  const h = harness()
  // ① reviewer 卡：子会话认领 → 派发留痕 → 驾驶舱以 owner 身份 `done`（真实完成路径）
  card('TASK-010', 'reviewer', 'command')
  assert.match(await h.callTool('sdo_task', { action: 'claim', id: 'TASK-010', owner: 'sub-r', expectedRevision: 1 }, 'child-1'), /in-progress/u)
  journal.append('dispatch/started', { task: 'TASK-010', provider: 'spawn', childSessionId: 'child-1', tools: 9, role: 'reviewer' })
  assert.equal(await toolVerdict(h.pre, 'write', 'child-1'), 'deny', '前置：in-progress 时 reviewer 不能 write')
  const done = await h.callTool('sdo_task', {
    action: 'done', id: 'TASK-010', owner: 'sub-r', evidence: '[{"kind":"command","detail":"node --test 全绿","exitCode":0}]',
  }, 'child-1')
  assert.match(done, /done|完成/u, `前置：完成路径要真的走通：${done.slice(0, 120)}`)
  assert.deepEqual(claimsBySession(store, journal), [], '前置：卡 done 之后归属失效')
  assert.equal(await toolVerdict(h.pre, 'write', 'child-1'), 'deny', 'done 之后（缓存版本已自动 +1）掩码必须仍在')
  assert.equal(await toolVerdict(h.pre, 'sdo_review', 'child-1'), 'allow', 'reviewer 掩码内的工具不许被误拦')

  // ② tester 卡：子会话认领 → 驾驶舱把它标 **blocked**（另一条离开 in-progress 的真实路径）
  card('TASK-011', 'tester')
  assert.match(await h.callTool('sdo_task', { action: 'claim', id: 'TASK-011', owner: 'sub-t', expectedRevision: 1 }, 'child-2'), /in-progress/u)
  journal.append('dispatch/started', { task: 'TASK-011', provider: 'spawn', childSessionId: 'child-2', tools: 9, role: 'tester' })
  assert.equal(await toolVerdict(h.pre, 'edit', 'child-2'), 'deny', '前置：in-progress 时 tester 不能 edit')
  const blocked = await h.callTool('sdo_task', { action: 'block', id: 'TASK-011', owner: 'sub-t', note: '上游未就绪' }, 'child-2')
  assert.match(blocked, /blocked/u, `前置：阻塞路径要真的走通：${blocked.slice(0, 120)}`)
  await bumpRoleCacheVersion(h.callTool)
  assert.equal(await toolVerdict(h.pre, 'edit', 'child-2'), 'deny', 'blocked 之后掩码必须仍在')
  assert.equal(await toolVerdict(h.pre, 'read', 'child-2'), 'allow', '掩码内的工具仍要放行')
})
