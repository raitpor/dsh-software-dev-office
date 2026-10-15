/**
 * **增量 179：DEF-078（major，第五批 §3.1）—— 未认领的子会话拿到比任何角色都宽的工具面**。
 *
 * 现象（第四批复验 V7 实测）：一个子会话若**只有登记、既无认领也无 `dispatch/started`**，归属落
 * `unclaimed-child`（`roles.ts` 三处返回它）⇒ 旧口径"**角色未知 ⇒ 不施加掩码**" ⇒ 它**能调用权威面**
 * （`sdo_plan` 在该钩子面 **allow**）。暴露面要说准：它**写不了产品文件**（路径级写范围闸门要"活着的认领卡"），
 * 但**工具面比任何角色都宽**。
 *
 * 根因：掩码是**按角色**施加的，而 `roles.yml` 只有 8 个真角色 ⇒ "没有角色"被落成了"不施加"，
 * **缺一份"默认最小面"**。
 *
 * 修法（`ADR-016`）：给"角色未知"一份**最小面**，且它的组成**由声明给出** —— `roles.yml` 新增
 * `unclaimed:`（与 `roles[].allow/deny` **同一条** `maskAllows` 出口，不另写判据）：
 *   · **保留**：`sdo_task`（认领协议通道）、`sdo_status` / `sdo_hash`（只读核查）、`read`/`grep`/`glob`
 *     （+ 代码里对**所有**面并入的 `READ_ONLY_INSPECTION_TOOLS`，含 `read_image`）；
 *   · **收窄**：权威面（`sdo_plan` 派发 / `sdo_gate` 签字豁免 / `sdo_deliver` 交付 / `sdo_review` 评审）
 *     与其余 SDO 流程面（白名单自然收窄）；**写类**（`write`/`edit`/`bash`）显式挡住。
 *   · **不硬编码工具名单**：插件里没有第二份清单（`DEF-077` 的教训）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { UNCLAIMED_CHILD_FACE, listRoleCards, maskAllows, roleMaskDecision, unclaimedFace } from '../src/domain/roles.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm179')

const CARD_REVISION = 1

interface ToolDefinition { name: string; parameters: unknown; execute: (args: Record<string, unknown>, exec: unknown) => unknown }
type Decision = { kind: string; reason?: string }

/** **真机面**：真 `apply()` 装配出来的 `tools/pre-execute` 钩子 + 真注册的工具面。 */
function hookHarness(): {
  drive: (tool: string, args: Record<string, unknown>, opts?: { sessionId?: string; cwd?: string | undefined; depth?: number }) => Promise<Decision>
  registerSession: (sessionId: string, cwd: string) => void
  toolNames: string[]
  claim: (sessionId: string, taskId: string, cwd: string) => Promise<string>
} {
  const registered: ToolDefinition[] = []
  const listeners = new Map<string, (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } },
    sessions: {},
  }
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
  assert.ok(listener !== undefined, '真实装配必须注册 tools/pre-execute')
  const sessionCreated = listeners.get('session/created')
  assert.ok(sessionCreated !== undefined, '真实装配必须注册 session/created')
  return {
    toolNames: registered.map((tool) => tool.name),
    registerSession(sessionId, cwd) { sessionCreated({ id: sessionId, header: { cwd } }, async () => undefined) },
    async drive(tool, args, opts = {}) {
      const sessionId = opts.sessionId ?? 'child-orphan'
      const depth = opts.depth ?? 1
      const header: Record<string, unknown> = { id: sessionId, delegationDepth: depth }
      if (opts.cwd !== undefined) header['cwd'] = opts.cwd
      if (depth > 0) header['parentSession'] = 'cockpit'
      return (await listener(
        { name: tool, arguments: args, agent: { id: sessionId, session: { header } } },
        async () => ({ kind: 'allow' }),
      )) as Decision
    },
    async claim(sessionId, taskId, cwd) {
      const tool = registered.find((item) => item.name === 'sdo_task')
      assert.ok(tool !== undefined, '工具面缺少 sdo_task')
      const exec = { agent: { id: sessionId, session: { header: { id: sessionId, cwd, delegationDepth: 1, parentSession: 'cockpit' } } } }
      return String(await tool.execute({ action: 'claim', id: taskId, owner: sessionId, expectedRevision: CARD_REVISION }, exec))
    },
  }
}

/** 一个"项目"（`.sdo/`）+ 一张可认领的卡。 */
function projectAt(dir: string, scopes: string[]): void {
  mkdirSync(join(dir, '.sdo', 'tasks'), { recursive: true })
  const store = new SdoStore(join(dir, '.sdo'))
  const task: TaskCard = {
    id: 'TASK-901', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'],
    blockedBy: [], writeScopes: scopes, role: 'developer', size: 'small', revision: CARD_REVISION,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', 'TASK-901.yml'], { task })
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M179-01 行为（真机面）：未认领子会话调**权威面** ⇒ deny 且可读点名；认领/探查面不受影响', async () => {
  const h = hookHarness()
  projectAt(BASE, ['src/index.ts'])
  h.registerSession('cockpit', BASE)   // 工作区**可解析**（`cwd` 自己含 `.sdo/`），只是这个会话没认领
  for (const tool of ['sdo_plan', 'sdo_gate', 'sdo_deliver', 'sdo_review']) {
    const decision = await h.drive(tool, {}, { cwd: BASE })
    assert.equal(decision.kind, 'deny', `未认领子会话不得调用权威面 ${tool}（修前这里是 allow）`)
    const reason = decision.reason ?? ''
    assert.match(reason, /未认领/u, `${tool} 的拒因必须说清"未认领 ⇒ 角色未知"：${reason}`)
    assert.match(reason, new RegExp(tool, 'u'), `${tool} 的拒因必须点名工具`)
    assert.match(reason, /sdo_task/u, `${tool} 的拒因必须给出"拿到角色的唯一途径"（认领）：${reason}`)
  }
  // **保留面**：认领协议通道 + 只读核查 + 探查
  for (const tool of ['sdo_task', 'sdo_status', 'sdo_hash', 'read', 'grep', 'glob', 'read_image']) {
    const decision = await h.drive(tool, {}, { cwd: BASE })
    assert.equal(decision.kind, 'allow', `最小面里的 ${tool} 必须放行（挡住认领 = 把正常派发卡死）：${decision.reason ?? ''}`)
  }
  // **写类**：它还没有卡 ⇒ 显式挡住（声明里 deny）
  for (const tool of ['write', 'edit', 'bash']) {
    const decision = await h.drive(tool, {}, { cwd: BASE })
    assert.equal(decision.kind, 'deny', `未认领子会话不得用写类 ${tool}`)
  }
})

test('M179-02 反例（不是恒拒）：认领之后换成那张卡的角色面，一切照旧', async () => {
  const h = hookHarness()
  projectAt(BASE, ['src/index.ts'])
  h.registerSession('cockpit', BASE)
  // 前置：未认领时是不是"最小面"（`sdo_plan` deny、`read` allow）
  assert.equal((await h.drive('sdo_plan', {}, { cwd: BASE })).kind, 'deny', '前置：未认领 ⇒ 权威面收窄')
  const receipt = await h.claim('child-dev', 'TASK-901', BASE)
  assert.match(receipt, /TASK-901/u, `夹具前提：认领必须成功：${receipt.slice(0, 200)}`)
  // 认领后 = developer 面：写类放行、SDO 流程面按角色白名单、派发仍被执行者禁令挡住
  const asDev = { sessionId: 'child-dev', cwd: BASE } as const
  assert.equal((await h.drive('bash', {}, asDev)).kind, 'allow', 'developer 面里有 bash ⇒ 认领后必须放行')
  assert.equal((await h.drive('edit', { file_path: join(BASE, 'src/index.ts') }, asDev)).kind, 'allow', '范围内的编辑放行')
  assert.equal((await h.drive('sdo_gate', {}, asDev)).kind, 'deny', 'developer 掩码里没有 sdo_gate（角色面，不是最小面）')
  assert.equal((await h.drive('sdo_plan', {}, asDev)).kind, 'deny', '执行者禁令：被派发的执行者不得派发')
  assert.equal((await h.drive('sdo_test', {}, asDev)).kind, 'allow', 'developer 面里有 sdo_test ⇒ 认领后放行')
  // 对照：**同一个工具**在未认领时会话里是 deny（说明上一条不是"恒放行"）
  assert.equal((await h.drive('bash', {}, { sessionId: 'child-orphan', cwd: BASE })).kind, 'deny', '反例：未认领的另一个会话仍被最小面挡住')
})

test('M179-03 结构：最小面**完全由声明给出**（插件里没有第二份工具名单）', () => {
  const face = unclaimedFace()
  assert.ok(face !== undefined, '`src/data/roles.yml` 必须有 `unclaimed:` 声明（最小面的唯一来源）')
  assert.ok(face.allow.length > 0, '最小面不许为空（那会把认领也挡掉）')
  assert.ok(face.deny.includes('write') && face.deny.includes('edit') && face.deny.includes('bash'), '写类必须在声明里显式挡住')
  // ① **推导读数**：对真实注册的**每一个** `sdo_*` 工具，行为必须与声明逐条一致
  const h = hookHarness()
  const sdoNames = h.toolNames.filter((name) => name.startsWith('sdo_'))
  assert.ok(sdoNames.length > 10, `夹具前提：插件注册的 sdo_* 工具应有十来个（实际 ${sdoNames.length}）`)
  for (const name of sdoNames) {
    assert.equal(
      maskAllows(UNCLAIMED_CHILD_FACE, name),
      face.allow.includes(name),
      `未认领面对 ${name} 的判定必须**只**由声明给出（代码里多一分/少一分都是第二份名单）`,
    )
  }
  // ② 反向：8 个真角色的面**不受**这份声明影响（别把最小面串到角色面上）
  for (const card of listRoleCards()) {
    assert.notEqual(card.code, UNCLAIMED_CHILD_FACE, '最小面不是第 9 个角色（`roles:` 必须仍是 8 个）')
  }
  assert.equal(listRoleCards().length, 8, '`roles:` 恰好 8 个真角色（最小面在独立声明里）')
  // ③ 权威面在**声明**里没有授权（不是代码里挡的）
  for (const authority of ['sdo_plan', 'sdo_gate', 'sdo_deliver', 'sdo_review']) {
    assert.equal(face.allow.includes(authority), false, `权威面 ${authority} 不许出现在最小面的 allow 里`)
    assert.equal(maskAllows(UNCLAIMED_CHILD_FACE, authority), false, `${authority} 必须被判为不可用`)
    assert.equal(roleMaskDecision(UNCLAIMED_CHILD_FACE, authority).kind, 'deny', `${authority} 的判定必须是 deny`)
  }
  // ④ 认不出的面码仍然 fail-closed（不是拿最小面兜底）
  assert.equal(maskAllows('no-such-role', 'read'), false, '认不出的角色码 ⇒ 一律不许（fail-closed）')
  assert.deepEqual(roleMaskDecision('no-such-role', 'read'), { kind: 'allow' }, '但"认不出的面码"在钩子层仍是 fail-open（`unknown` 那一态的老口径）')
})

test('M179-04 向后兼容：驾驶舱不受限、派发过的会话仍按它的角色面、拿不到会话信息仍 fail-open', async () => {
  const h = hookHarness()
  projectAt(BASE, ['src/index.ts'])
  h.registerSession('cockpit', BASE)
  // ① 驾驶舱（depth 0）：权威面照旧全放行
  for (const tool of ['sdo_plan', 'sdo_gate', 'sdo_deliver', 'sdo_review', 'write', 'edit', 'bash']) {
    assert.equal((await h.drive(tool, {}, { sessionId: 'cockpit', cwd: BASE, depth: 0 })).kind, 'allow', `驾驶舱必须能用 ${tool}`)
  }
  // ② 角色名认不出（`dispatch/started` 记的角色不是八个之一 ⇒ 归属仍是 unclaimed-child）⇒ 最小面，不是全拒
  const journal = new (await import('../src/infra/journal.js')).Journal(new SdoStore(join(BASE, '.sdo')))
  journal.append('dispatch/started', { role: 'not-a-role', childSessionId: 'child-bad', parentSessionId: 'cockpit' })
  assert.equal((await h.drive('sdo_plan', {}, { sessionId: 'child-bad', cwd: BASE })).kind, 'deny', '角色名坏掉 ⇒ 落最小面（权威面仍收窄）')
  assert.equal((await h.drive('read', {}, { sessionId: 'child-bad', cwd: BASE })).kind, 'allow', '只读面仍放行（不是全拒）')
  // ③ 拿不到会话信息（没有 sessionId）⇒ 老口径 fail-open（与"角色未知"不是一回事）
  const unknown = await h.drive('sdo_plan', {}, { sessionId: '', cwd: BASE })
  assert.equal(unknown.kind, 'allow', '拿不到会话信息 ⇒ 按驾驶舱放行（fail-open 那一态不许被本次改动收紧）')
})

test('M179-05 结构：最小面的**上下界**由声明给出且判据单一出口', () => {
  // 判据只有一处：`roleMaskDecision` / `maskAllows` 都走 `faceCard`（8 角色 ∪ 未认领面）。
  // 这里用"声明改动即行为改动"的方式钉住：把声明当成唯一真源，行为读数必须跟着它走。
  const face = unclaimedFace()
  assert.ok(face !== undefined)
  for (const tool of [...face.allow]) {
    assert.equal(maskAllows(UNCLAIMED_CHILD_FACE, tool), true, `${tool} 在声明 allow 里 ⇒ 必须放行`)
  }
  for (const tool of [...face.deny]) {
    assert.equal(maskAllows(UNCLAIMED_CHILD_FACE, tool), false, `${tool} 在声明 deny 里 ⇒ 必须挡住`)
    assert.equal(maskAllows(UNCLAIMED_CHILD_FACE, tool), false, 'deny 永远优先（两层语义同源）')
  }
  // 通用面：没被 deny 的继承宿主默认（不能把通用面一起清空 —— 那正是 2026-10-08 真机事故）
  assert.equal(maskAllows(UNCLAIMED_CHILD_FACE, 'memory_save'), true, '通用面没 deny ⇒ 继承宿主默认（别把沉淀面清掉）')
  assert.equal(maskAllows(UNCLAIMED_CHILD_FACE, 'technique_apply'), true, '沉淀/上报面保留（用户点名要回的正是它）')
})
