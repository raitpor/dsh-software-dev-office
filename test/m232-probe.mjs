/**
 * 临时探针（`TASK-231` 返工用，收工前删除）：把 m232 的**真账夹具**回执拆开，逐块量体积。
 * 跑法：`node test/m232-probe.mjs [--keep=<目录名>]`
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const LIB = (process.argv.slice(2).find((arg) => arg.startsWith('--lib=')) ?? '--lib=lib').slice('--lib='.length)
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm232probe')
const WS = join(BASE, 'proj')
const SESSION = 'session-0000m232-0000-4000-8000-00000000232a'
const url = (rel) => pathToFileURL(join(ROOT, LIB, rel)).href

const { Config, resolveSettings } = await import(url('src/config.js'))
const { SoftwareDevOffice } = await import(url('src/office.js'))
const { apply } = await import(url('src/index.js'))

rmSync(BASE, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })
cpSync(join(ROOT, '.sdo'), join(WS, '.sdo'), { recursive: true })
const tasksDir = join(WS, '.sdo', 'tasks')
for (const name of readdirSync(tasksDir)) {
  const path = join(tasksDir, name)
  const text = readFileSync(path, 'utf8')
  if (!text.includes('status: in-progress')) continue
  writeFileSync(path, text.replace(/status: in-progress/u, 'status: done'))
}
const office = new SoftwareDevOffice(resolveSettings(Config({})))
office.noteSession(SESSION, WS)
const services = {}
const tools = []
const makeCtx = () => ({
  logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  plugin: () => {},
  on: () => () => {},
  get: (name) => services[name],
  inject: (names, cb) => { if (names.every((name) => name in services)) cb(makeCtx()) },
  effect: (fn) => { fn(); return () => {} },
})
services['tools'] = { register: (tool) => { tools.push(tool); return () => {} } }
apply(makeCtx(), Config({}))

const planTool = tools.find((item) => item.name === 'sdo_plan')
const props = planTool.parameters?.properties ?? {}
const filtered = {}
for (const [key, value] of Object.entries({ action: 'next', limit: 1 })) if (key in props) filtered[key] = value
const agent = { id: SESSION, session: { header: { id: SESSION, cwd: WS, delegationDepth: 0 } } }
const receipt = String(await planTool.execute(filtered, { agent }))

const call = { sessionId: SESSION, cwd: WS }
const plan = office.poolPlan(call, { reuseIdle: true })

/* ———————————— 冻结夹具（M232-06 的同形副本）：卡集被接管，只让 journal 随账态变 ———————————— */
const FROZEN = join(BASE, 'frozen')
rmSync(FROZEN, { recursive: true, force: true })
mkdirSync(FROZEN, { recursive: true })
cpSync(join(ROOT, '.sdo'), join(FROZEN, '.sdo'), { recursive: true })
const frozenOffice = new SoftwareDevOffice(resolveSettings(Config({})))
frozenOffice.noteSession(SESSION, FROZEN)
const frozenDesignDir = join(FROZEN, '.sdo', 'design')
const designIds = [...new Set(readdirSync(frozenDesignDir)
  .filter((name) => name.endsWith('.yml'))
  .flatMap((name) => [...readFileSync(join(frozenDesignDir, name), 'utf8').matchAll(/DES-\d+/gu)].map((match) => match[0])))]
const markers = designIds.map((id) => `\uFF08${id}\uFF09`).join('')
const frozenTasks = join(FROZEN, '.sdo', 'tasks')
rmSync(frozenTasks, { recursive: true, force: true })
const frozenCard = (id, status, extra = {}) => {
  frozenOffice.storeFor(FROZEN).writeYaml(['tasks', `${id}.yml`], {
    task: {
      id, title: `frozen ${id} ${markers}`, goal: 'frozen goal', inputs: [], outputs: [],
      dod: [`\u5b8c\u6210\u5b9a\u4e49\uff08DoD\uff09\uff1a${'fixed fixture text. '.repeat(90)}`],
      evidenceRequired: ['command'], blockedBy: [], writeScopes: ['src/frozen/'],
      role: 'developer', size: 'small', revision: 1, status, requirements: [], evidence: [],
      createdAt: '', updatedAt: '', ...extra,
    },
  })
}
frozenCard('TASK-2180', 'ready')
frozenCard('TASK-2181', 'blocked', { blockReason: 'frozen blocked reason' })
frozenCard('TASK-2182', 'planned')
frozenCard('TASK-2183', 'in-progress', { owner: 'developer-frozen1' })
const frozenServices = {}
const frozenTools = []
const frozenCtx = () => ({
  logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  plugin: () => {}, on: () => () => {},
  get: (name) => frozenServices[name],
  inject: (names, cb) => { if (names.every((name) => name in frozenServices)) cb(frozenCtx()) },
  effect: (fn) => { fn(); return () => {} },
})
frozenServices['tools'] = { register: (tool) => { frozenTools.push(tool); return () => {} } }
frozenServices['subagents'] = {
  list: () => ['spawn'],
  start: async () => ({ id: 'child-oneshot-m232' }),
  startContinuable: async () => ({ childId: 'child-fresh-m232' }),
  sendMessage: async () => ({ messageId: 'msg-m232' }),
  getProvider: () => ({ capabilities: { toolFilter: true } }),
  listDescendants: async () => [],
}
apply(frozenCtx(), Config({}))
const frozenPlan = frozenTools.find((item) => item.name === 'sdo_plan')
const frozenProps = frozenPlan.parameters?.properties ?? {}
const frozenArgs = {}
for (const [key, value] of Object.entries({ action: 'next', limit: 1 })) if (key in frozenProps) frozenArgs[key] = value
const frozenAgent = { id: SESSION, session: { header: { id: SESSION, cwd: FROZEN, delegationDepth: 0 } } }
const frozenReceipt = String(await frozenPlan.execute(frozenArgs, { agent: frozenAgent }))
const countLines = (text, needle) => text.split('\n').filter((line) => line.includes(needle)).length
console.log(`[frozen] chars=${frozenReceipt.length} seatsLines=${countLines(frozenReceipt, 'dispatch-seats:')}`
  + ` danglingLines=${countLines(frozenReceipt, 'dangling-decided:')}`)
const fm = /原文 (\d+) 字符/u.exec(frozenReceipt)
console.log(`[frozen] original=${fm === null ? frozenReceipt.length : Number(fm[1])}`)

const originalLength = (text) => {
  const match = /原文 (\d+) 字符/u.exec(text)
  return match === null ? text.length : Number(match[1])
}
console.log(`LIB=${LIB}`)
console.log(`receipt chars=${receipt.length} original=${originalLength(receipt)} lines=${receipt.split('\n').length}`)
const issues = office.planIssues(call0())
function call0() { return { sessionId: SESSION, cwd: WS } }
console.log(`planIssues=${issues.length} chars=${issues.reduce((sum, issue) => sum + (issue.detail ?? '').length + (issue.remedy ?? '').length + 40, 0)}`)
console.log(`reuseSkipped=${plan.reuseSkipped.length} dispatchable=${plan.dispatch.length} queued=${plan.queued.length} blocked=${plan.blocked.length}`)
console.log(`seats=${plan.seats === undefined ? '<absent>' : JSON.stringify(plan.seats).length} dangling=${plan.danglingDecisions?.length ?? 0}`)
console.log(`health: orphans=${office.dispatchHealth(call).orphans.length} claimMissing=${office.dispatchHealth(call).claimMissing.length} reuseNoSignal=${office.reuseDeliveries(call).filter((row) => row.state === 'no-signal').length}`)

const lines = receipt.split('\n')
const buckets = new Map()
for (const line of lines) {
  const key = line.slice(0, 26).replace(/[\d]/gu, '#')
  const row = buckets.get(key) ?? { count: 0, chars: 0 }
  row.count += 1
  row.chars += line.length
  buckets.set(key, row)
}
const top = [...buckets.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 12)
console.log('--- top line-buckets (prefix26 -> count, chars):')
for (const [key, row] of top) console.log(`  ${String(row.chars).padStart(7)} chars / ${String(row.count).padStart(4)} lines  ${key}`)
console.log('--- longest 6 lines:')
for (const line of [...lines].sort((a, b) => b.length - a.length).slice(0, 6)) {
  console.log(`  ${String(line.length).padStart(6)} chars  ${line.slice(0, 120).replace(/\n/gu, ' ')}`)
}
const markerReal = (needle) => {
  const hits = lines.filter((line) => line.includes(needle))
  return `${needle}: ${hits.length} lines / ${hits.reduce((sum, line) => sum + line.length, 0)} chars`
}
for (const needle of ['在飞定位', 'dispatch-seats:', 'dangling-decided:', '跳过复用', 'dispatch queue', 'pool', 'echo']) {
  console.log(markerReal(needle))
}
if (existsSync(WS)) rmSync(BASE, { recursive: true, force: true })
