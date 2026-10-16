/**
 * **增量 183：第六批 §3.6（`DEF-080`）—— 派卡前检查「卡写范围 ∩ 未提交改动」。**
 *
 * 病根：写范围互斥只查**认领卡**与**卡与卡**，而"别人未提交的交付"不属于任何卡 ⇒
 * "某张卡的写范围正好压在别人未提交的改动上"这条路的派发**无人拦**。
 * 判定走唯一出口 `scopeOverlaps`；只算**被跟踪**文件（未跟踪草稿不算）；`git` 读不动 ⇒ 不拦。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { classifyNonDispatchable } from '../src/domain/plan.js'
import { readDirtyWorktree } from '../src/infra/git.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm183')
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition { name: string; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

function harness(): ToolDefinition[] {
  const list: ToolDefinition[] = []
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition) => { list.push(tool); return () => {} } }, sessions: {} }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return list
}
const git = (args: string[]): string => execFileSync('git', args, { cwd: WORKSPACE, encoding: 'utf8' })
const card = (status: string): TaskCard => ({
  id: 'TASK-001', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
  owner: 'dev-a', blockedBy: [], writeScopes: ['src/'], role: 'developer', size: 'small', revision: 1,
  status: status as TaskCard['status'], requirements: [], evidence: [], createdAt: '', updatedAt: '',
})

let call: { sessionId: string; cwd: string }
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'src'), { recursive: true })
  writeFileSync(join(WORKSPACE, 'src', 'app.ts'), 'export const a = 1\n')
  git(['init', '-q'])
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  call = { sessionId: 's-cockpit', cwd: WORKSPACE }
  office.noteSession(call.sessionId, WORKSPACE)
  office.init(call, { name: 'm183', scale: 'normal', stakeholders: ['x'] })
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-001.yml'], { task: card('planned') })
  git(['add', '-A'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M183-01 行为：卡写范围 ∩ **未提交的被跟踪改动** ⇒ 判"不可派发"并点名那条路径（真注册面回执）', async () => {
  const status = harness().find((item) => item.name === 'sdo_plan')
  assert.ok(status !== undefined)
  // ① 干净树 ⇒ 没有这一类
  const clean = String(await status.execute({ action: 'next', why: true }, { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }))
  assert.equal(clean.includes('未提交的被跟踪改动'), false, `干净树不许报这一类：${clean.slice(0, 200)}`)
  assert.equal(readDirtyWorktree(WORKSPACE).tracked.length, 0, '夹具：干净树')
  // ② 改一个**被跟踪**文件（在卡的写范围内）⇒ 判红并点名 `src/app.ts`
  writeFileSync(join(WORKSPACE, 'src', 'app.ts'), 'export const a = 2\n')
  assert.deepEqual(readDirtyWorktree(WORKSPACE).tracked, ['src/app.ts'], '读数：被跟踪改动就是它')
  const dirty = String(await status.execute({ action: 'next', why: true }, { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }))
  assert.match(dirty, /未提交的被跟踪改动/u, `必须报这一类：${dirty.slice(0, 300)}`)
  assert.match(dirty, /src\/app\.ts/u, `必须点名那条未提交路径：${dirty.slice(0, 300)}`)
  assert.match(dirty, /TASK-001/u, '必须点名被挡住的卡')
  // ③ 提交之后 ⇒ 这一类消失（反例：不是恒红）
  git(['add', '-A']); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'wip'])
  const again = String(await status.execute({ action: 'next', why: true }, { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }))
  assert.equal(again.includes('未提交的被跟踪改动'), false, '提交之后必须恢复可派发')
})

test('M183-02 反例（F2/F4 口径）：**未跟踪**草稿不算；多路径卡照样命中；读不动单列不假装干净', () => {
  // ① 未跟踪（`??`）不触发
  writeFileSync(join(WORKSPACE, 'src', 'scratch.ts'), '// wip\n')
  assert.deepEqual(readDirtyWorktree(WORKSPACE).tracked, [], '未跟踪文件不计入')
  assert.deepEqual(classifyNonDispatchable([card('planned')], undefined, []).dirty, undefined, '干净 ⇒ 键不出现')
  // ② 真数组：被跟踪改动 ⇒ 出现
  const rows = classifyNonDispatchable([card('planned')], undefined, ['src/app.ts'])
  assert.deepEqual(rows.dirty?.map((row) => row.task.id), ['TASK-001'], '被跟踪改动压在写范围上 ⇒ 出现这一行')
  assert.deepEqual(rows.dirty?.[0]?.over, ['src/app.ts'], '点名的是**那条未提交路径**')
  // ③ **F2（第七批 §3.1）**：多路径卡**照样命中** —— 上一批"只对单一路径 1:1 独占卡生效"的收窄
  // 把现象段逐字点名的 `TASK-109` 形态（3 条写范围、其中一条正脏）整类豁免掉了。
  const shared = { ...card('planned'), writeScopes: ['src/', 'docs/'] }
  const multi = classifyNonDispatchable([shared], undefined, ['src/app.ts']).dirty
  assert.deepEqual(multi?.map((row) => row.task.id), ['TASK-001'], '多路径卡必须命中（F2）')
  assert.deepEqual(multi?.[0]?.over, ['src/app.ts'], '必须点名那条脏路径（F2）')
  // `TASK-109` 的形状：3 条写范围、其中 `src/index.ts` 正脏 ⇒ 必须命中并点名它
  const three = { ...card('planned'), writeScopes: ['src/index.ts', 'src/domain/', 'test/'] }
  const hit = classifyNonDispatchable([three], undefined, ['src/index.ts', 'README.md']).dirty
  assert.deepEqual(hit?.[0]?.over, ['src/index.ts'], '三条写范围里脏的那条必须被点名（F2 的正例）')
  // 反例：与卡写范围**不相交**的脏文件 ⇒ 不命中
  assert.equal(classifyNonDispatchable([three], undefined, ['README.md', 'package.json']).dirty, undefined, '不相交 ⇒ 不命中')
  // ④ 工作区是**更大仓库的子目录**时：只报**工作区内**的改动，且路径相对工作区
  //（porcelain 的路径恒为仓库根相对 —— 不丢别处路径就会把派发面误拦）
  const sub = join(WORKSPACE, 'sub')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'inside.txt'), 'x\n')
  writeFileSync(join(WORKSPACE, 'outside.txt'), 'y\n')
  git(['add', '-A']); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'sub'])
  const nested = readDirtyWorktree(sub)
  assert.equal(nested.ok, true, '子目录仍在仓库里 ⇒ 判定可用')
  assert.deepEqual(nested.tracked, [], '子目录里没有改动 ⇒ 空（工作区外的 `outside.txt` 与 `src/app.ts` 都不算）')
  writeFileSync(join(sub, 'inside.txt'), 'changed\n')
  writeFileSync(join(WORKSPACE, 'outside.txt'), 'changed too\n')
  assert.deepEqual(
    readDirtyWorktree(sub).tracked,
    ['inside.txt'],
    '只报工作区内的改动（工作区外那条 `outside.txt` 也算脏，但不许混进来），且路径相对工作区',
  )
  // ④b **F4（第七批 §3.1）**：三态在**分类结果**层面两两可区分（干净 / 脏 / 读不动）
  const cleanPlan = classifyNonDispatchable([card('planned')], undefined, [])
  const dirtyPlan = classifyNonDispatchable([card('planned')], undefined, ['src/app.ts'])
  const blindPlan = classifyNonDispatchable([card('planned')], undefined, { ok: false, reason: 'git 不在' })
  assert.equal(cleanPlan.dirty, undefined, '干净 ⇒ 没有 dirty 键')
  assert.equal(cleanPlan.dirtyUnjudgeable, undefined, '干净 ⇒ 也没有"判不了"键')
  assert.equal(dirtyPlan.dirty?.length, 1, '脏 ⇒ 有 dirty 键')
  assert.equal(dirtyPlan.dirtyUnjudgeable, undefined, '脏 ⇒ 不许同时报"判不了"')
  assert.equal(blindPlan.dirty, undefined, '读不动 ⇒ 不许报出"脏"（那会假装判过）')
  assert.deepEqual(blindPlan.dirtyUnjudgeable, { reason: 'git 不在' }, '读不动 ⇒ 单列并带 reason')
  assert.notDeepEqual(cleanPlan, blindPlan, '干净与读不动**不许**逐字节相同（F4 的核心）')
  // ⑤ 读不动（路径不存在 ⇒ git 直接失败）⇒ `ok:false`，带上原因、**不假装干净**
  const none = readDirtyWorktree(join(BASE, 'does-not-exist'))
  assert.equal(none.ok, false, '读不动 ⇒ ok:false（判不了不拦，但绝不说"干净"）')
  assert.equal(none.tracked.length, 0, '判不了时不许假装有改动')
  assert.equal(typeof none.reason, 'string', '必须带可读原因')
})
