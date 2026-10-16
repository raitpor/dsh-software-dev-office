/**
 * **增量 185：第七批 §3.1（`DEF-080`）的 F1 与 F4 —— 都在**真注册面**上验。**
 *
 * F1（真拦）：上一批只把 `dirty` 接进诊断面（`describeNonDispatchable`），于是**派发主路径**
 *（`sdo_plan action=next`，不带 `why`）**既不停卡、回执也一个字不提**。本用例走的就是那条主路径：
 * 脏 ⇒ 该卡**不进本轮派发**（摘要张数为 0）且回执单列一行点名**相交的那条未提交路径**；
 * 干净 ⇒ 恢复（摘要重新把它算进候选）。
 *
 * F4（读不动可辨）：`git` 不可用时**不许**折叠成"干净"—— 回执必须**单列**"无法判定"并带 `reason`，
 * 且**不许**出现"本轮不派发"（那会假装判过）。三态在同一命令下**两两可区分**。
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
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm185')
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
const card = (id: string, writeScopes: string[]): TaskCard => ({
  id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
  owner: 'dev-a', blockedBy: [], writeScopes, role: 'developer', size: 'small', revision: 1,
  status: 'planned', requirements: [], evidence: [], createdAt: '', updatedAt: '',
})

let office: SoftwareDevOffice
const drive = async (args: Record<string, unknown>): Promise<string> => {
  const plan = harness().find((item) => item.name === 'sdo_plan')
  assert.ok(plan !== undefined)
  return String(await plan.execute(args, { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'src'), { recursive: true })
  writeFileSync(join(WORKSPACE, 'src', 'app.ts'), 'export const a = 1\n')
  git(['init', '-q'])
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 's-cockpit', cwd: WORKSPACE }
  office.noteSession(call.sessionId, WORKSPACE)
  office.init(call, { name: 'm185', scale: 'normal', stakeholders: ['x'] })
  const store = office.storeFor(WORKSPACE)
  // 两张卡：TASK-001 的写范围会被脏改动压住；TASK-002 是**干净的对照**（让派发主路径真的跑起来）
  store.writeYaml(['tasks', 'TASK-001.yml'], { task: card('TASK-001', ['src/']) })
  store.writeYaml(['tasks', 'TASK-002.yml'], { task: card('TASK-002', ['docs/']) })
  git(['add', '-A'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M185-01 §3.1 F1：派发**主路径**上脏卡本轮不派 + 回执点名相交路径；干净 ⇒ 恢复', async () => {
  // ① 干净：候选里有它（摘要按 1 张算）
  const clean = await drive({ action: 'next' })
  // 默认 `limit=1`：两张都在候选里（一张派出、一张排队）—— 摘要与会话上限都照实说
  assert.match(clean, /本次派发 1 张\*\*：TASK-001/u, `干净时 TASK-001 该进候选：${clean.slice(0, 300)}`)
  assert.match(clean, /另有 1 张/u, '干净时两张都在候选里（第二张因上限排队）')
  assert.equal(clean.includes('本轮不派发'), false, '干净时不许出现这一类提示')
  // ② 脏（被跟踪文件，落在卡的写范围内）⇒ 本轮不派 + 点名
  writeFileSync(join(WORKSPACE, 'src', 'app.ts'), 'export const a = 2\n')
  const dirty = await drive({ action: 'next' })
  assert.match(dirty, /本次派发 1 张\*\*：TASK-002/u, `脏卡不许进候选、干净卡照派（F1 真拦）：${dirty.slice(0, 400)}`)
  assert.equal(/本次派发[^\n]*TASK-001/u.test(dirty), false, '被挡下的卡不许出现在本次派发名单里')
  assert.equal(dirty.includes('另有 1 张'), false, '脏卡不该还占着候选名额（它是被拦住、不是排队）')
  assert.match(dirty, /本轮不派发/u, '必须单列"本轮不派发"')
  assert.match(dirty, /TASK-001/u, '必须点名那张卡')
  assert.match(dirty, /src\/app\.ts/u, '必须点名**相交的那条未提交路径**')
  // ③ 提交之后 ⇒ 恢复（反例：不是恒拦）
  git(['add', '-A']); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'wip'])
  const again = await drive({ action: 'next' })
  assert.match(again, /本次派发 1 张\*\*：TASK-001/u, '提交之后必须恢复可派发（TASK-001 重新进候选）')
  assert.match(again, /另有 1 张/u, '恢复后两张都在候选里')
  assert.equal(again.includes('本轮不派发'), false, '恢复后不许留着那行')
})

test('M185-02 §3.1 F4：`git` 不可用 ⇒ 单列"无法判定"（带原因），且**不**混进"脏"', async () => {
  writeFileSync(join(WORKSPACE, 'src', 'app.ts'), 'export const a = 3\n')
  const dirty = await drive({ action: 'next' })
  assert.match(dirty, /本轮不派发/u, '前置：脏的那一态')
  const saved = process.env['PATH']
  let blind: string
  try {
    process.env['PATH'] = join(BASE, 'no-such-bin')   // git 解析不到 ⇒ `readDirtyWorktree` 失败
    blind = await drive({ action: 'next' })
    // 诊断面也要带上它（describeNonDispatchable 的那一支）
    const blindWhy = await drive({ action: 'next', why: true })
    assert.match(blindWhy, /无法判定工作树/u, `诊断面必须单列"无法判定"：${blindWhy.slice(0, 300)}`)
  } finally {
    if (saved === undefined) delete process.env['PATH']
    else process.env['PATH'] = saved
  }
  // ① **不许**把"读不动"说成"脏"（那会假装判过）
  assert.equal(blind.includes('本轮不派发'), false, `读不动不许混进"脏"：${blind.slice(0, 300)}`)
  // ② **判不了 ⇒ 不拦**：候选与"干净"时一致（这是口径，不是"确认干净"）
  assert.match(blind, /本次派发 1 张\*\*：TASK-001/u, `读不动时按"不拦"处理：${blind.slice(0, 300)}`)
  // ③ 必须单列 + 带原因（`ENOENT` 之类）
  assert.match(blind, /无法判定工作树是否干净/u, `必须单列"无法判定"：${blind.slice(0, 400)}`)
  assert.match(blind, /ENOENT|not found|spawnSync/u, `必须带上可读原因：${blind.slice(0, 400)}`)
  // ④ 三态两两可区分（把三份回执**逐字节**比对）—— 先**真的**把树弄干净（提交），否则"干净"那份其实还是脏的
  git(['add', '-A']); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'wip'])
  const clean = await drive({ action: 'next' })
  assert.notEqual(blind, clean, '读不动 ≠ 干净')
  assert.notEqual(blind, dirty, '读不动 ≠ 脏')
  assert.notEqual(clean, dirty, '干净 ≠ 脏')
})
