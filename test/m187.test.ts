/**
 * **增量 187：第八批 §3.1 F5（`DEF-080` 第 4 面）—— glob / 宽范围写范围不许整类豁免。**
 *
 * 病根（V15）：字面 glob 形态的写范围（`src/**`、`src/integration/**`）在旧判定里**恒不相交**
 * （`scopePathsIntersect` 只做目录前缀）⇒ **既不拦也不提示**；而真台账里 `TASK-006.yml` 的写范围
 * 就是 `src/integration/**` ⇒ 与被修掉的"单路径收窄"是同一类**整类豁免**。
 *
 * 修法（两半，都在既有唯一出口上）：
 *   · `scopePathsIntersect` **支持 glob**（`**` 跨段 / `*` `?` 段内 / 覆盖任一段边界前缀）；
 *     两边都无 glob 时**逐字节保持原判定**（零破坏）。
 *   · `dirtyScopeHolds` 按**宽度分级**：无 glob 或字面前缀 ≥2 段的 glob ⇒ **拦**；
 *     超宽 glob（`**`、`src/**`、`src/*`、`test/m*.test.ts`）⇒ **只提示不拦**
 *     （否则任何脏文件都会把这种卡钉死 —— 那正是当初收窄要避免的噪声）。
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
import { dirtyGradeOf, dirtyScopeHolds } from '../src/domain/plan.js'
import { globLiteralDepth, scopePathsIntersect } from '../src/domain/scopePaths.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm187')
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
const drive = async (): Promise<string> => {
  const plan = harness().find((item) => item.name === 'sdo_plan')
  assert.ok(plan !== undefined)
  return String(await plan.execute({ action: 'next' }, { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'src', 'integration'), { recursive: true })
  writeFileSync(join(WORKSPACE, 'src', 'integration', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(WORKSPACE, 'README.md'), 'x\n')
  git(['init', '-q'])
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 's-cockpit', cwd: WORKSPACE }
  office.noteSession(call.sessionId, WORKSPACE)
  office.init(call, { name: 'm187', scale: 'normal', stakeholders: ['x'] })
  const store = office.storeFor(WORKSPACE)
  // 真台账形态：`TASK-006.yml` 的写范围就是 `src/integration/**`；再加一张**超宽 glob** 的卡做对照
  store.writeYaml(['tasks', 'TASK-006.yml'], { task: card('TASK-006', ['src/integration/**']) })
  store.writeYaml(['tasks', 'TASK-007.yml'], { task: card('TASK-007', ['src/**']) })
  git(['add', '-A'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M187-01 唯一出口：glob 语义（`**` 跨段 / `*` 段内 / 覆盖段边界前缀），且无 glob 时判定逐字节不变', () => {
  // ① glob 判定
  assert.equal(scopePathsIntersect('src/integration/**', 'src/integration/a.ts'), true, '`**` 必须覆盖域内文件')
  assert.equal(scopePathsIntersect('src/integration/**', 'src/integration/sub/b.ts'), true, '`**` 必须跨多段')
  assert.equal(scopePathsIntersect('src/**', 'src/integration/a.ts'), true, '`src/**` 覆盖更深路径')
  assert.equal(scopePathsIntersect('src/*', 'src/integration/a.ts'), true, '`*` 段内任意 + 段边界前缀 ⇒ 覆盖')
  assert.equal(scopePathsIntersect('src/**', 'test/a.ts'), false, '域外不许命中')
  assert.equal(scopePathsIntersect('src/integration/**', 'src/other/a.ts'), false, '兄弟目录不许命中')
  // ② **零破坏**：两边都无 glob ⇒ 原判定（目录边界前缀）
  assert.equal(scopePathsIntersect('src/', 'src/a.ts'), true)
  assert.equal(scopePathsIntersect('src/a/', 'src/b.ts'), false)
  assert.equal(scopePathsIntersect('src/a.ts', 'src/a.ts'), true)
  assert.equal(scopePathsIntersect('src', 'src/a.ts'), true)
  // ③ 分级读数
  assert.equal(globLiteralDepth('src/integration/**'), 2, '字面前缀 2 段')
  assert.equal(globLiteralDepth('src/**'), 1)
  assert.equal(globLiteralDepth('**'), 0)
  assert.equal(dirtyGradeOf(card('T', ['src/integration/**'])), 'block', '点了子树 ⇒ 拦')
  assert.equal(dirtyGradeOf(card('T', ['src/**'])), 'hint', '超宽 ⇒ 只提示')
  assert.equal(dirtyGradeOf(card('T', ['**'])), 'hint')
  assert.equal(dirtyGradeOf(card('T', ['src/*'])), 'hint')
  assert.equal(dirtyGradeOf(card('T', ['src/', 'docs/'])), 'block', '无 glob ⇒ 仍是拦（既有口径）')
})

test('M187-02 读数：域内脏文件 ⇒ 命中并分级（真台账形态 `src/integration/**` 是**拦**档）', () => {
  const rows = dirtyScopeHolds([card('TASK-006', ['src/integration/**']), card('TASK-007', ['src/**'])], ['src/integration/a.ts'])
  assert.deepEqual(rows.map((row) => [row.task.id, row.grade]), [['TASK-006', 'block'], ['TASK-007', 'hint']], '两张卡都命中，档不同')
  assert.deepEqual(rows[0]?.over, ['src/integration/a.ts'], '点名的必须是那条脏路径')
  // 反例②：域外脏文件 ⇒ 不命中
  assert.deepEqual(dirtyScopeHolds([card('TASK-006', ['src/integration/**'])], ['README.md']), [], '域外 ⇒ 不命中')
})

test('M187-03 真注册面：`src/integration/**` 的卡被**拦**并点名；`src/**` 的卡**只提示**仍照派', async () => {
  const clean = await drive()
  assert.equal(clean.includes('本轮不派发'), false, '干净时不许有拦')
  assert.equal(clean.includes('超宽 glob'), false, '干净时不许有提示')
  writeFileSync(join(WORKSPACE, 'src', 'integration', 'a.ts'), 'export const a = 2\n')
  const dirty = await drive()
  // ① 窄 glob（`src/integration/**`）⇒ 拦 + 点名
  assert.match(dirty, /本轮不派发/u, ``+'`src/integration/**`'+` 必须被拦：${dirty.slice(0, 400)}`)
  assert.match(dirty, /TASK-006/u, '被拦的卡号必须点名')
  assert.match(dirty, /src\/integration\/a\.ts/u, '必须点名那条相交的脏路径')
  // ② 超宽 glob（`src/**`）⇒ 只提示、**不进"不派发"名单**、且照旧进本次派发
  assert.match(dirty, /超宽 glob/u, '超宽 glob 必须给提示')
  assert.match(dirty, /本次派发 1 张\*\*：TASK-007/u, `超宽 glob 的卡不许被拦（它照派）：${dirty.slice(0, 300)}`)
  assert.equal(/本轮不派发[^\n]*TASK-007/u.test(dirty), false, '`src/**` 的卡不许出现在"不派发"名单里')
  // ③ 反例：提交之后两档都消失
  git(['add', '-A']); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'wip'])
  const again = await drive()
  assert.equal(again.includes('本轮不派发'), false)
  assert.equal(again.includes('超宽 glob'), false)
})
