/**
 * `TASK-231` 的**同一条读数探针**：修复前 / 修复后共用一套断言面，只换被测构建。
 *
 * 它只做一件事：**在同一个账态上**把 `sdo_plan action=next` / `sdo_status` 回执里那几行原文摘出来 ——
 *   · `inflight`  「在飞定位」那一行（`kPoolBusyMap` 的投影）
 *   · `seats`     占位/容量读数（`dispatch-seats:`；修前**没有**这一行）
 *   · `capacity`  队列表里被判 `capacity` 的卡（`budget=N/4`）
 *   · `dangling`  悬空派发决定（`dangling-decided:`；修前**没有**这一行）
 *   · `decided`   台账里每条 `dispatch/decided` 的收口字段（`outcome` / `failureReason`）
 *
 * 五个账态（同一次运行里依次造）：
 *   A **幽灵决定**：只有 `dispatch/decided`、零 `started`，卡仍是 `planned`、`owner` 空
 *     （`DEF-214` 描述的形状；其中 TASK-221 / TASK-224 就是它点名的那两笔）；
 *   B **真派发之后**再看一次池读数（`dispatch/started` 已经落地）；
 *   C **起会话失败**：宿主 provider 在、`start` 抛错 ⇒ 收口应当 = `failed`；
 *   D **降级 inline**：没有 `subagents` 服务 ⇒ 收口应当 = `inline`（没有子会话可起）；
 *   E **容量**：3 张 `in-progress` + 1 张"已派发但未认领"（`started` 活着、卡不是 `in-progress`）
 *     + 1 张 ready ⇒ 占位该是 4/4（修前只数 `in-progress` ⇒ 3/4，于是那张 ready 卡被**错派**）。
 *
 * 跑法：`node test/m244-readout.mjs [--lib=<构建目录>]`
 *   · `--lib=lib`（缺省）= 当前工作树；
 *   · `--lib=node_modules/.sdo-test/base231/lib` = 基线副本（`git archive HEAD` + `tsc`，见报告）。
 * 它**不判红绿**（判据在 `test/m244.test.ts`）；它是**证据本身**，要留在盘上可复跑。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm244-readout')
const SESSION = 'session-0000m244-0000-4000-8000-00000000231a'
const SESSION2 = 'session-0000m244-0000-4000-8000-00000000231b'
/** `--lib=<目录>`（相对仓库根）指向**被测构建**：缺省 `lib`（当前工作树）；红态指向基线副本。 */
const LIB = (process.argv.slice(2).find((arg) => arg.startsWith('--lib=')) ?? '--lib=lib').slice('--lib='.length)
const url = (rel) => pathToFileURL(join(ROOT, LIB, rel)).href

const { Config, resolveSettings } = await import(url('src/config.js'))
const { SoftwareDevOffice } = await import(url('src/office.js'))
const { apply } = await import(url('src/index.js'))

rmSync(BASE, { recursive: true, force: true })
const WS = join(BASE, 'proj')
const WS2 = join(BASE, 'seats')
mkdirSync(WS, { recursive: true })
mkdirSync(WS2, { recursive: true })

const office = new SoftwareDevOffice(resolveSettings(Config({})))
office.noteSession(SESSION, WS)
office.noteSession(SESSION2, WS2)
const call = { sessionId: SESSION, cwd: WS }
const call2 = { sessionId: SESSION2, cwd: WS2 }

const card = (id, over = {}) => ({
  id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
  blockedBy: [], writeScopes: [`src/m244/${id}.ts`], role: 'developer', size: 'small', revision: 1,
  status: 'planned', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  ...over,
})
const writeCard = (ws, item) => office.storeFor(ws).writeYaml(['tasks', `${item.id}.yml`], { task: item })

/**
 * 把"派发决定"直接**写一行**进台账（绕过 office 的收口入口 —— 这正是历史悬空决定的形状：
 * 没有 `outcome` 字段，也没有随后的 `dispatch/started`）。用原样落行是因为 `Journal.append()`
 * 只给"现在"的时间戳，而这一格要造的正是"几小时前的决定至今没有收口"。
 */
const seedDecision = (ws, taskId, at, extra = {}) => {
  const store = office.storeFor(ws)
  const text = store.readText('journal.jsonl') ?? ''
  const seq = text.split('\n').filter(Boolean).length + 1
  store.appendLine(['journal.jsonl'], JSON.stringify({
    seq, at, actor: 'sdo', type: 'dispatch/decided',
    data: {
      task: taskId, backend: 'subagent', owner: 'developer', degradedReason: '', overrideNote: '',
      orderBasis: 'sizeRank->lastDispatched->id', candidates: [], selectedWhy: 'seed', ...extra,
    },
  }))
}
const isoAgo = (seconds) => new Date(Date.now() - seconds * 1000).toISOString()

/**
 * 宿主桩。
 *   · `'ok'`           —— `start` / `startContinuable` 真的给一个子会话 id ⇒ `dispatch/started` 落地；
 *   · `'no-service'`   —— 压根没有 `subagents` 服务 ⇒ 后端降级成 `inline`（收口 = inline）；
 *   · `'start-throws'` —— 服务在、provider 在，但 `start` 抛错 ⇒ 起会话**失败**（收口 = failed）。
 */
const mountHost = (mode = 'ok') => {
  const tools = []
  const services = {}
  const makeCtx = () => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name) => services[name],
    inject: (names, cb) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn) => { fn(); return () => {} },
  })
  services['tools'] = { register: (tool) => { tools.push(tool); return () => {} } }
  if (mode !== 'no-service') {
    const boom = async () => { throw new Error('宿主拒绝：无法创建子代理（探针桩）') }
    services['subagents'] = {
      list: () => ['spawn'],
      start: mode === 'start-throws' ? boom : async () => ({ id: 'm244-child-0000-4000-8000-00000000abcd' }),
      startContinuable: mode === 'start-throws' ? boom : async () => ({ childId: 'm244-fresh-0000-4000-8000-000000000001' }),
      sendMessage: mode === 'start-throws' ? boom : async () => ({ messageId: 'm244-msg' }),
      getProvider: () => ({ capabilities: { toolFilter: true } }),
      listDescendants: async () => [],
    }
  }
  apply(makeCtx(), Config({}))
  return tools
}

const callTool = async (tools, sessionId, cwd, name, args) => {
  const tool = tools.find((item) => item.name === name)
  if (tool === undefined) throw new Error(`工具面缺少 ${name}`)
  const props = tool.parameters?.properties ?? {}
  const filtered = {}
  for (const [key, value] of Object.entries(args)) if (key in props) filtered[key] = value
  const agent = { id: sessionId, session: { header: { id: sessionId, cwd, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent }))
}
const pick = (text, needle) => text.split('\n').filter((line) => line.includes(needle))
const show = (label, lines) => {
  if (lines.length === 0) {
    console.log(`${label}=<absent>`)
    return
  }
  for (const line of lines) console.log(`${label}=${line}`)
}

/* ———————————————————————————— 账态 A：幽灵决定（DEF-214 的形状） ———————————————————————————— */
office.init(call, { name: 'M244 读数探针', scale: 'normal', stakeholders: ['业务方'] })
// 两笔「历史悬空决定」：`DEF-214` 点名的 TASK-221 / TASK-224（卡 planned、owner 空、零 started）
writeCard(WS, card('TASK-221'))
writeCard(WS, card('TASK-224'))
seedDecision(WS, 'TASK-221', isoAgo(3600))
seedDecision(WS, 'TASK-224', isoAgo(3600))
// 今天的幽灵：只决定、不 started
writeCard(WS, card('TASK-931'))
seedDecision(WS, 'TASK-931', isoAgo(900))
// 真卡：容量面要能派出去
writeCard(WS, card('TASK-932', { status: 'ready' }))

const tools = mountHost('ok')
const receiptA = await callTool(tools, SESSION, WS, 'sdo_plan', { action: 'next', limit: 1 })
console.log(`--- receipt A (ghost decided) chars=${receiptA.length}`)
show('inflight', pick(receiptA, '在飞定位'))
show('seats', pick(receiptA, 'dispatch-seats:'))
show('capacity', pick(receiptA, 'capacity'))
show('dangling', pick(receiptA, 'dangling-decided:'))
show('started-line', pick(receiptA, '已真正派发'))

/* ———————————————————————————— 账态 B：真派发之后的池读数 ———————————————————————————— */
const statusB = await callTool(tools, SESSION, WS, 'sdo_status', {})
console.log(`--- readout B (after a real dispatch) chars=${statusB.length}`)
show('inflight', pick(statusB, '在飞定位'))
show('seats', pick(statusB, 'dispatch-seats:'))

/* ———————————————————————————— 账态 C：起会话失败（收口 = failed） ———————————————————————————— */
writeCard(WS, card('TASK-941', { status: 'ready' }))
const throwing = mountHost('start-throws')
const receiptC = await callTool(throwing, SESSION, WS, 'sdo_plan', { action: 'next', limit: 1 })
console.log(`--- receipt C (host start throws) chars=${receiptC.length}`)
show('not-started', pick(receiptC, '未真正派发'))
show('dangling', pick(receiptC, 'dangling-decided:'))

/* ———————————————————————————— 账态 D：降级 inline（收口 = inline） ———————————————————————————— */
writeCard(WS, card('TASK-942', { status: 'ready' }))
const noHost = mountHost('no-service')
const receiptD = await callTool(noHost, SESSION, WS, 'sdo_plan', { action: 'next', limit: 1 })
console.log(`--- receipt D (no subagents service) chars=${receiptD.length}`)
show('dangling', pick(receiptD, 'dangling-decided:'))

/* ———————————————————————————— 账态 E：容量占位（真派发但未认领） ———————————————————————————— */
office.init(call2, { name: 'M244 占位探针', scale: 'normal', stakeholders: ['业务方'] })
for (const id of ['TASK-951', 'TASK-952', 'TASK-953']) {
  writeCard(WS2, card(id, { status: 'in-progress', owner: 'developer-00000000' }))
}
// 已派发但**从未认领**：子会话活着（`started` 无 `finished`），卡仍是 planned
writeCard(WS2, card('TASK-954'))
office.recordDispatchStarted(call2, {
  taskId: 'TASK-954', provider: 'spawn', childSessionId: 'm244-live-0000-4000-8000-000000000954',
  tools: 3, role: 'developer', mode: 'continuable',
})
writeCard(WS2, card('TASK-955', { status: 'ready' }))
const hostE = mountHost('ok')
const receiptE = await callTool(hostE, SESSION2, WS2, 'sdo_plan', { action: 'next', limit: 1 })
console.log(`--- receipt E (3 in-progress + 1 live-but-unclaimed + 1 ready) chars=${receiptE.length}`)
show('seats', pick(receiptE, 'dispatch-seats:'))
show('capacity', pick(receiptE, 'capacity'))
show('started-line', pick(receiptE, '已真正派发'))
show('inflight', pick(receiptE, '在飞定位'))

/* ———————————————————————————— 台账读数（与回执同源） ———————————————————————————— */
for (const [label, ws] of [['main', WS], ['seats', WS2]]) {
  const events = office.journalFor(ws).read().events
  const decisions = events.filter((event) => event.type === 'dispatch/decided')
  console.log(`[${label}] decided=${decisions.length} started=${events.filter((e) => e.type === 'dispatch/started').length}`)
  for (const event of decisions) {
    const data = event.data
    console.log(`[${label}] decided-seq=${event.seq} task=${String(data.task)} backend=${String(data.backend)}`
      + ` outcome=${data.outcome === undefined ? '<absent>' : String(data.outcome)}`
      + ` failureReason=${data.failureReason === undefined ? '<absent>' : String(data.failureReason).slice(0, 48)}`)
  }
}
const health = typeof office.dispatchDecisionHealth === 'function' ? office.dispatchDecisionHealth(call) : undefined
console.log(`health=${health === undefined
  ? '<absent>'
  : `ok=${String(health.ok)} settled=${String(health.settled)} failed=${String(health.failed)} inline=${String(health.inline)} pending=${String(health.pending.length)}`}`)
if (health !== undefined) show('health-line', health.lines)

rmSync(BASE, { recursive: true, force: true })
