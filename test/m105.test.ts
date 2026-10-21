/**
 * **blocked 卡的恢复通道**（修复 DEF-049 / TASK-078）。
 *
 * 病灶：`blocked` 是卡生命周期的**死胡同** —— `readyTasks`（`plan.js`）的派发准入只认
 * `planned` / `ready`，而工具面**没有**任何恢复动作。于是本项目**在每张卡派发协议里鼓励**的动作
 * （「做不下去就 block，不要硬撑也不要静默改范围」）反而把人送进死胡同：真机上驾驶舱只能
 * **语义外地**用 `release` 把卡捞回 ready。本文件钉住修复后的四态 + 门禁侧联动：
 *
 *   ① blocked 卡经 `unblock` ⇒ 变 `ready`、留 `task/unblocked` 事件、且**随后可被 `readyTasks` 取到**；
 *   ② 越权调用（既非驾驶舱也非该卡 owner）⇒ **可读拒绝**，且不静默改状态；
 *   ③ `sdo_plan action=next why=true` ⇒ **分列**「blocked 卡」与「写范围冲突 / 依赖未满足」，
 *      显式点出 blocked 卡需 `unblock` 或 `drop`，且**这一轮不派发任何卡**；
 *   ④ 对**非 blocked** 的卡调用 `unblock` ⇒ 可读拒绝（不得静默改动状态）；
 *   ⑤ C-40（`tasks.all_done`）判红时，把「已阻塞 N」与**处置动作**连起来（不只是报个数字）。
 *
 * 纪律：② 与 ③ **在修复前就是红的**（现状是笼统一句话、且工具面无分辨能力），本文件先跑红再改；
 * 这一层必须**走真实注册的工具面**（`apply()` 注册后的 `sdo_task` / `sdo_plan`），
 * 因为"导出函数绿了但工具面拿不到"在本仓是实测过的空转形态（知识库 `tq_ff348198` 同源）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import { setLocale, t } from '../src/domain/i18n.js'
import { listTasks, readyTasks, writeTask } from '../src/domain/plan.js'
import { CHECKERS } from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import type { Journal } from '../src/infra/journal.js'
import type { SdoStore } from '../src/infra/store.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m105/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>

/** 该会话 id 的 store / journal（建卡与断言状态时直接读盘）。 */
function contextOf(sessionId: string): { store: SdoStore; journal: Journal } {
  return office.contextFor({ sessionId, cwd: WORKSPACE }) as unknown as { store: SdoStore; journal: Journal }
}

/**
 * 直接种一张卡（**本卡不做 claim 路径的断言**，只关心 blocked 的恢复通道）。
 * `blocked` 是既有实现的合法状态（`report(status='blocked')` 会写它），这里如实复现该状态。
 */
function seedTask(id: string, over: Partial<TaskCard> = {}): TaskCard {
  const { store } = contextOf('s1')
  const card: TaskCard = {
    id,
    title: `${id} 标题`,
    goal: `${id} 目标`,
    inputs: [],
    outputs: [],
    dod: ['做点什么'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes: [`src/only-${id}.ts`],
    requirements: [],
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'ready',
    evidence: [],
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...over,
  }
  writeTask(store, card)
  return card
}

/** 走**真实注册的工具**调用（参数按 schema 过滤，与宿主一致）。 */
async function callTool(name: string, args: Record<string, unknown>, sessionId = 's1'): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: sessionId, session: { header: { id: sessionId, cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub } as unknown as Parameters<typeof tool.execute>[1]))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  tools = []
  services = {}
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
  })
  services['tools'] = { register: (tool: ToolDefinition): (() => void) => { tools.push(tool); return () => {} } }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  // 语言是**进程级**状态：本文件会切到 en 做对照，退出前必须切回基准语言，
  // 否则同一次 `node --test` 里后跑的其它文件会拿到英文（污染别人=最隐蔽的空转）。
  setLocale('zh-CN')
  rmSync(BASE, { recursive: true, force: true })
})

// ————————————————————— ① 恢复通道本身 —————————————————————

test('M105-01 blocked 卡经 unblock ⇒ ready + task/unblocked 事件 + 随后可被 readyTasks 取到', async () => {
  seedTask('TASK-901', { status: 'blocked', owner: 'subagent:developer:1', blockedReason: '缺上游契约 CT-009' })

  const before = readyTasks(listTasks(contextOf('s1').store), 64).map((task) => task.id)
  assert.equal(before.includes('TASK-901'), false, 'blocked 卡在修复前就不该出现在可派发集合里（病灶本身）')

  const out = await callTool('sdo_task', { action: 'unblock', id: 'TASK-901', reason: 'CT-009 已冻结，接着做' })
  assert.match(out, /TASK-901/, `回执要点名卡：${out}`)
  assert.match(out, /ready/, `回执要说明落到了 ready：${out}`)
  // 回执必须写明「原阻塞原因」与「本次恢复理由」—— 恢复**不得**做成静默动作
  assert.match(out, /缺上游契约 CT-009/, `回执要带出原阻塞原因：${out}`)
  assert.match(out, /CT-009 已冻结，接着做/, `回执要带出本次恢复理由：${out}`)

  const { store, journal } = contextOf('s1')
  const card = listTasks(store).find((task) => task.id === 'TASK-901')
  assert.equal(card?.status, 'ready', '状态必须变 ready')
  assert.equal(card?.owner ?? '', '', 'owner 要清空（回到"可再派"的语义，与 release 一致）')
  assert.equal(card?.blockedReason ?? '', '', '原阻塞原因随恢复清掉')

  // 口径说明：`task/unblocked` 是本次新增的事件类型（`src/types.ts` 的 `SdoEventType` 一并登记）；
  // 这里按字符串比较，避免把"事件类型登记与否"这一件事混进本用例的断言面。
  const events = journal.read().events.filter((event) => String(event.type) === 'task/unblocked')
  assert.equal(events.length, 1, '必须留**追加式**的 task/unblocked 事件')
  assert.equal(events[0]?.data.id, 'TASK-901')
  assert.equal(events[0]?.data.blockedReason, '缺上游契约 CT-009', '事件里要留原阻塞原因（审计用）')
  assert.equal(events[0]?.data.reason, 'CT-009 已冻结，接着做', '事件里要留本次恢复理由')

  // 恢复的**目的**就是回到派发队列：这条断言才是"确实通了"，不是"状态字段好看"
  const after = readyTasks(listTasks(store), 64).map((task) => task.id)
  assert.ok(after.includes('TASK-901'), `恢复后必须能被 readyTasks 取到：${after.join(' ')}`)
})

// ————————————————————— ② 越权（修复前必须红）————————————————————

test('M105-02 越权调用（被派发出去的子代理、且非该卡 owner）⇒ 可读拒绝且不改状态', async () => {
  // 授权口径的可证部分（`office.canAdministerTasks` 的注释里写明了边界）：本仓唯一**正面**可证的
  // "不是驾驶舱"信号是 `dispatch/started.childSessionId` —— 被派发出去的子代理只有**自己那张卡**的
  // 处置权。这里如实造出这个形态：s2 被派去干 TASK-999，然后去 unblock 别人的 TASK-902。
  seedTask('TASK-902', { status: 'blocked', owner: 'subagent:developer:1', blockedReason: '等外部输入' })
  office.recordDispatchStarted({ sessionId: 's1', cwd: WORKSPACE }, {
    taskId: 'TASK-999',
    provider: 'subagent',
    childSessionId: 's2',
    tools: 12,
    role: 'reviewer',
    mode: 'one-shot',
  })

  const out = await callTool('sdo_task', { action: 'unblock', id: 'TASK-902', reason: '我想接着做' }, 's2')
  // 断言"这是**权限**拒绝"，而不是"这个动作不认识 / 没有这张卡"
  assert.match(out, /权限|无权|owner|驾驶舱|流程官|职权|只允许/u, `越权必须是可读的权限拒绝：${out}`)
  assert.match(out, /TASK-902/, `拒绝要点名是哪张卡：${out}`)
  assert.equal(/未知动作|不支持|不认识/u.test(out), false, `不得退化成"动作不存在"：${out}`)

  const card = listTasks(contextOf('s1').store).find((task) => task.id === 'TASK-902')
  assert.equal(card?.status, 'blocked', '越权被拒后状态**不得**被静默改动')
  assert.equal(card?.owner, 'subagent:developer:1', 'owner 也不得被动')
  assert.equal(card?.revision, 1, '被拒的调用不得推进 revision')

  // 反向对照（防"谁都拒"的空转）：同一个 s2 对**它自己**的卡（认领会话 = s2）是被允许的
  seedTask('TASK-903', { status: 'blocked', owner: 'x' })
  const { journal } = contextOf('s2')
  journal.append('task/claimed', { id: 'TASK-903', owner: 'x', revision: 2, sessionId: 's2' })
  const own = await callTool('sdo_task', { action: 'unblock', id: 'TASK-903', reason: '阻塞解除了' }, 's2')
  assert.equal(/权限|无权|只允许/u.test(own), false, `自己认领过的卡应当放行：${own}`)
  assert.equal(listTasks(contextOf('s1').store).find((task) => task.id === 'TASK-903')?.status, 'ready', '原 owner 路径必须真的能恢复')
})

// ————————————————————— ③ 分列诊断（修复前必须红）————————————————————

test('M105-03 why=true ⇒ 分列「blocked 卡」与「依赖未满足」两类原因，且不派发', async () => {
  // 三张卡：一张 blocked；一张 ready 但 blockedBy 指着那张 blocked 卡（依赖未满足）；
  // 一张干净的 ready。因为存在 blocked 卡，这一轮**一张都不该派出去**。
  seedTask('TASK-911', { status: 'blocked', owner: 'subagent:developer:1', blockedReason: '等外部输入' })
  seedTask('TASK-912', { status: 'ready', blockedBy: ['TASK-911'] })
  seedTask('TASK-913', { status: 'ready' })

  const out = await callTool('sdo_plan', { action: 'next', why: true })

  // ① blocked 类必须**分列出来**并带可执行动作；② 非 blocked 类（依赖未满足）也必须分列
  assert.match(out, /blocked/iu, `必须分列出 blocked 卡这一类：${out}`)
  assert.match(out, /unblock/u, `blocked 类要给出恢复动作 unblock：${out}`)
  assert.match(out, /drop/u, `blocked 类要给出放弃动作 drop：${out}`)
  assert.match(out, /TASK-911/u, `blocked 类要点名是哪张卡：${out}`)
  assert.match(out, /等待|依赖|blockedBy|未满足/u, `非 blocked 类（依赖未满足）要单独分列：${out}`)
  assert.match(out, /TASK-912/u, `依赖未满足的卡也要点名：${out}`)

  // 「不派发」必须是**显式裁决**，不是"回了一句空话"
  assert.match(out, /没有派发|未派发|不派发/u, `本次不派发要有明确裁决：${out}`)

  // 反过来对照：这一轮确实没把干净卡派出去
  const { journal } = contextOf('s1')
  const started = journal.read().events.filter((event) => event.type === 'dispatch/started' || event.type === 'dispatch/decided')
  assert.deepEqual(started.map((event) => event.data.task), [], '有 blocked 卡时这一轮不得派发任何卡')
})

// ————————————————————— ④ 非 blocked 卡上的可读拒绝 —————————————————————

test('M105-04 对非 blocked 的卡调用 unblock ⇒ 可读拒绝且不改状态', async () => {
  seedTask('TASK-921', { status: 'ready' })

  const out = await callTool('sdo_task', { action: 'unblock', id: 'TASK-921', reason: '手滑' })
  assert.match(out, /TASK-921/u, `拒绝要点名卡：${out}`)
  assert.match(out, /不是 blocked|无需恢复|未阻塞|blocked/u, `要说清"它本来就不是 blocked"：${out}`)

  const card = listTasks(contextOf('s1').store).find((task) => task.id === 'TASK-921')
  assert.equal(card?.status, 'ready', '非 blocked 卡的状态**不得**被静默改动')
  assert.equal(card?.revision, 1, '被拒的调用不得推进 revision（留痕只能由真改动产生）')
})

// ————————————————————— ⑤ C-40 门禁侧联动 —————————————————————

test('M105-05 C-40 判红时把「已阻塞 N」与处置动作连起来（不只报数字）', async () => {
  seedTask('TASK-931', { status: 'blocked', owner: 'subagent:developer:1', blockedReason: '等外部输入' })
  seedTask('TASK-932', { status: 'ready' })
  const { store, journal } = contextOf('s1')
  const ctx = { workspace: WORKSPACE, store, journal } as unknown as GateContext

  const check = CHECKERS['tasks.all_done']
  assert.ok(check !== undefined, 'C-40 的检查器必须注册（tasks.all_done）')

  const failed = check(ctx)
  assert.equal(failed.ok, false, '有 blocked 卡与未完成卡 ⇒ C-40 判红')
  const detail = failed.detail ?? ''
  assert.match(detail, /1/u, `要报出已阻塞的条数：${detail}`)
  // 只报数字不够：必须**点出处置动作**（驾驶舱 unblock / 改派 / 放弃）
  assert.match(detail, /unblock/u, `判红文案要指向恢复动作：${detail}`)
  assert.match(detail, /drop|放弃/u, `判红文案要给出"确实不做"的出口：${detail}`)

  // 反向对照（防止"永远多印一句"）：卡全部完成且带证据时，C-40 转绿且**不带** blocked 建议
  for (const task of listTasks(store)) {
    writeTask(store, {
      ...task,
      status: 'done',
      evidence: [{ kind: 'command', detail: 'node --test（1 passed）', exitCode: 0, at: '2026-10-13T00:00:00.000Z' }],
    })
  }
  const passed = check({ workspace: WORKSPACE, store, journal } as unknown as GateContext)
  assert.equal(passed.ok, true, '全完成+带证据 ⇒ C-40 必须转绿')
  assert.equal(/unblock/u.test(passed.detail ?? ''), false, `转绿时不得再印恢复建议：${passed.detail ?? ''}`)
})

// ————————————————————— ⑥ 语言包（en 侧零中文 + 键真的存在）————————————————————

test('M105-06 新增/改写文案在语言包两侧都可解析（en 侧零中文）', async () => {
  // 两张 blocked 卡：一张在**英文**那一步之前被恢复（证明 en 侧动作回执），另一张留到 en 诊断里
  // 当"blocked 类被分列"的证据 —— 否则"分列"在 en 侧无从观察（只剩一张干净卡 ⇒ 回退到 idle 文案）。
  // 阻塞原因用 **ASCII**：那是**用户数据**（原样透传），带中文会让下面的"en 侧零中文"无从判定
  // —— 该守的是**文案**不许漏翻，不是"用户数据里不许出现中文"。
  seedTask('TASK-941', { status: 'blocked', owner: 'subagent:developer:1', blockedReason: 'waiting for external input' })
  seedTask('TASK-942', { status: 'blocked', owner: 'subagent:developer:1', blockedReason: 'waiting for external input' })
  const zh = await callTool('sdo_task', { action: 'unblock', id: 'TASK-941', reason: '可以继续了' })
  assert.match(zh, /可以继续了/u, `zh 侧要带出恢复理由：${zh}`)

  setLocale('en')
  const en = await callTool('sdo_plan', { action: 'next', why: true })
  // ① en 侧零中文（落点二/三/五的新文案都必须在 en 语言包里）
  assert.equal(/[\u4e00-\u9fff]/u.test(en), false, `切换到 en 后回执里不得有中文：${en}`)
  // ② en 侧的 blocked 类必须**真的分列**：点名那张卡、给出恢复动作，且**不得**退化成 idle 文案
  assert.match(en, /blocked/u, `en 侧要分列出 blocked 类：${en}`)
  assert.match(en, /unblock/u, `en 侧 blocked 类要给恢复动作：${en}`)
  assert.match(en, /TASK-942/u, `en 侧 blocked 类要点名是哪张卡：${en}`)
  assert.match(en, /waiting for external input|等待外部输入/u, `en 侧要带出原阻塞原因：${en}`)
  assert.equal(en.includes('no card is dispatchable'), false, `有 blocked 卡时不得回退到 idle 文案：${en}`)

  // ③ 两侧文案必须真的不同（防"语言没切成功"的恒真断言）
  const enUnblock = await callTool('sdo_task', { action: 'unblock', id: 'TASK-941', reason: 'continue now' })
  assert.notEqual(zh, enUnblock, 'zh 与 en 的同一次动作回执必须真的不同')
  assert.equal(/[\u4e00-\u9fff]/u.test(enUnblock), false, `en 侧 unblock 回执不得有中文：${enUnblock}`)

  // ④ 落点五：旧文案（把 blocked 与 release 绑在一起）必须已被改写
  const hint = t('uiPlan.kScopeReleaseHint')
  assert.ok(hint.includes('unblock'), `kScopeReleaseHint 必须指向 unblock：${hint}`)
  assert.equal(/先 `sdo_task action=release`/u.test(hint), false, `不得再教"先 release 腾范围"这条老路：${hint}`)
  assert.match(hint, /blocked/u, `它仍要说明这是 blocked 卡的情形：${hint}`)
})

test('M105-07 TC-111：`task/unblocked` 事件必须带 `previousOwner`（恢复不是静默换手），无主卡要如实说"（无）"', async () => {
  // ① 有主的 blocked 卡：事件里要留**原 owner**（审计：这张卡原先在谁手里）
  seedTask('TASK-911', { status: 'blocked', owner: 'subagent:developer:2', blockedReason: '等评审' })
  const out = await callTool('sdo_task', { action: 'unblock', id: 'TASK-911', reason: '评审已回' })
  const event = contextOf('s1').journal.read().events.filter((item) => String(item.type) === 'task/unblocked').at(-1)
  assert.equal(event?.data.previousOwner, 'subagent:developer:2', '事件里必须留原 owner（`collab.ts` 写了、原先没人断）')
  assert.match(out, /subagent:developer:2/u, `回执也要带出原主人（可核对是谁的卡被恢复了）：${out}`)

  // ② 无主卡：事件里是空串，回执如实印「（无）」——不许编一个 owner，也不许把这一格省掉
  seedTask('TASK-912', { status: 'blocked', owner: '', blockedReason: '等外部输入' })
  const bare = await callTool('sdo_task', { action: 'unblock', id: 'TASK-912', reason: '外部输入到了' })
  const bareEvent = contextOf('s1').journal.read().events.filter((item) => String(item.type) === 'task/unblocked').at(-1)
  assert.equal(bareEvent?.data.previousOwner, '', '无主卡的原 owner 必须是空串（不是 undefined、不是上一张卡的 owner）')
  assert.match(bare, /（无）/u, `无主卡的回执要如实写「（无）」：${bare}`)
})
