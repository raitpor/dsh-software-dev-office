/**
 * **增量 184：第六批 §3.7（`DEF-081`）+ §3.5（`D1`）。**
 *
 * §3.7：`blockedBy` 是**别人写在我身上**的声明 ⇒ 把被引用那张卡作废，引用者的依赖**永远等不到**
 * （`blockedTasks` 只认"指向未结束的卡"，被作废的引用就变成"等一张永远不会完成的卡"而**永久卡住**）。
 * 修法：作废前点名**直接引用者 + 传递下游**；`'*'`（等所有卡）不算下游。
 *
 * §3.5：`lib/` 是交付产物 ⇒「变异/试验只在副本树里做」＋「变异先自证字节变了」＋
 * 「`lib/` 不被 git 跟踪 ⇒ 用 sha256/cmp 判定」三条必须写进**随包交付的角色卡**与 docs 约定处。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { dropDependents } from '../src/domain/plan.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm184')
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
const card = (id: string, blockedBy: string[]): TaskCard => ({
  id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
  owner: 'dev-a', blockedBy, writeScopes: [`src/${id}/`], role: 'developer', size: 'small', revision: 1,
  status: 'in-progress', requirements: [], evidence: [], createdAt: '', updatedAt: '',
})

let call: { sessionId: string; cwd: string }
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, '.sdo'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  call = { sessionId: 's-cockpit', cwd: WORKSPACE }
  office.noteSession(call.sessionId, WORKSPACE)
  office.init(call, { name: 'm184', scale: 'normal', stakeholders: ['x'] })
  const store = office.storeFor(WORKSPACE)
  store.writeYaml(['tasks', 'TASK-001.yml'], { task: card('TASK-001', []) })
  store.writeYaml(['tasks', 'TASK-002.yml'], { task: card('TASK-002', ['TASK-001']) })
  store.writeYaml(['tasks', 'TASK-003.yml'], { task: card('TASK-003', ['TASK-002']) })
  store.writeYaml(['tasks', 'TASK-004.yml'], { task: card('TASK-004', ['*']) })
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M184-01 §3.7 行为（真注册面）：直接引用者 + 传递下游 ⇒ `drop` 被拒、点名、**零写盘**', async () => {
  const drop = harness().find((item) => item.name === 'sdo_task')
  assert.ok(drop !== undefined)
  const exec = { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }
  const refused = String(await drop.execute({ action: 'drop', id: 'TASK-001', reason: '拆错了' }, exec))
  assert.match(refused, /被拒/u, `必须可读拒绝：${refused.slice(0, 300)}`)
  assert.match(refused, /TASK-002/u, '必须点名直接引用者')
  assert.match(refused, /TASK-003/u, '必须点名传递下游（B 引 A、C 引 B）')
  assert.equal(refused.includes('TASK-004'), false, '`*` 不算下游（它等的是全部，少一张没被吊住）')
  const still = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-001.yml')?.task
  assert.equal(still?.status, 'in-progress', '被拒时**零写盘**（卡状态不许变）')
  // 反例：没有人引用它 ⇒ 放行（不是恒拒）
  const ok = String(await drop.execute({ action: 'drop', id: 'TASK-004', reason: '不需要了' }, exec))
  assert.equal(ok.includes('被拒'), false, `没人吊着就必须放行：${ok.slice(0, 200)}`)
  assert.equal(office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-004.yml')?.task?.status, 'dropped', '放行后真的作废')
})

test('M184-02 §3.7 读数（`dropDependents`）：直接/传递分层，`*` 与已结束的卡都不算', () => {
  const tasks = [
    card('TASK-001', []), card('TASK-002', ['TASK-001']), card('TASK-003', ['TASK-002']),
    card('TASK-004', ['*']), { ...card('TASK-005', ['TASK-003']), status: 'done' as TaskCard['status'] },
  ]
  const one = dropDependents(tasks, 'TASK-001')
  assert.deepEqual(one.direct.map((task) => task.id), ['TASK-002'], '直接引用者只有 TASK-002')
  assert.deepEqual(one.downstream.map((task) => task.id), ['TASK-003'], '传递下游只有 TASK-003（已 done 的 TASK-005 不算）')
  assert.deepEqual(dropDependents(tasks, 'TASK-004'), { direct: [], downstream: [] }, '没人引用 ⇒ 空（可作废）')
  assert.deepEqual(dropDependents(tasks, 'TASK-003').downstream, [], '末端卡没有下游')
})

test('M184-03 §3.5（D1）结构：三条纪律写进了三张角色卡与 docs 约定处', () => {
  const targets = ['skills/role-developer.md', 'skills/role-tester.md', 'skills/role-reviewer.md', 'docs/README.md']
  for (const rel of targets) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    assert.match(text, /变异与交付产物的纪律/u, `${rel} 缺 D1 那一节`)
    assert.match(text, /绝不改仓库的 `lib\/`/u, `${rel} 必须逐字写明"绝不改仓库的 lib/"`)
    assert.match(text, /副本树/u, `${rel} 必须写"在副本树里做"`)
    assert.match(text, /自证「字节真的变了」/u, `${rel} 必须写"变异先自证字节变了"`)
    assert.match(text, /`sha256sum` \/ `cmp`/u, `${rel} 必须写"用 sha256sum/cmp 判定交付产物有没有被改（git status 看不出来）"`)
    assert.match(text, /`git checkout --` \/ `git restore` \/ `git stash`/u, `${rel} 必须写明不许用哪三条命令`)
  }
})
