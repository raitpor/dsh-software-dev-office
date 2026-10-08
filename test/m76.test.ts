/**
 * **增量 76：写入范围纪律（3a 公共面 + 3b 卡级）与 `write`/`edit` 同权（2026-10-08 用户裁定）。**
 *
 * 起因（用户提问）：**tester 角色没有 `edit`，它把自己的测试脚本写错了怎么改？**
 * 核实结论（读码 + 真机子会话实录）：
 *   · tester 其实有 `write` 与 `bash` ⇒ "没有 edit"**既不是能力边界也不是路径边界**，
 *     只是把"改一处"逼成"读全文 → 整篇写回"（真机 architect 正是这么把登记簿覆盖掉、
 *     23 条 DEV 正文永久丢失 —— SDO-23）⇒ **口径改为 `write`/`edit` 同权，独立性由"写在哪里"机械控制**；
 *   · 原本唯一按路径的两处**都是空转的**：`disciplineAllowPaths` / `disciplineTools` 两个配置
 *     **从来没人读**（死配置），而 L3 的 `path.startsWith('src/')` 也判不到真机 ——
 *     宿主传的是**绝对路径**（实录：`{"file_path":"/home/raiptor/…/sdo-test-new/lib/parse.js"}`）。
 *
 * 本用例把两重限制都钉住（且**双向**：该拦的拦、不该拦的不拦）：
 *   3b 卡级 —— 有活卡时只能写卡的 `writeScopes`；没活卡只能写公共面；
 *   3a 公共面 —— `.sdo/`（台账）、`docs/`（派生文档）、`test/`（用例）不受卡范围约束；
 *   另外：驾驶舱/认不出人 ⇒ fail-open（不能变成"插件认不出人就干不了活"）、绝对路径必须能归一。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { ROLES } from '../src/domain/plan.js'
import { maskAllows } from '../src/domain/roles.js'
import { evaluateWriteScope, normalizeWorkspacePath } from '../src/domain/writeScope.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm76')
const SHARED = ['.sdo/', 'docs/', 'test/']
const GUARDED = ['write', 'edit', 'bash']

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

function card(id: string, role: string, scopes: string[]): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'],
    blockedBy: [], writeScopes: scopes, role: role as TaskCard['role'], size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
}

function writeCard(task: TaskCard): void {
  store.writeYaml(['tasks', `${task.id}.yml`], { task })
}

interface ToolDefinition { name: string; parameters: unknown; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

/** 真装配 + 真实 `tools/pre-execute` 钩子 + 真实工具（认领要走**生产路径**，否则钩子的归属缓存不刷新）。 */
function hookHarness(): {
  drive: (tool: string, sessionId: string, args: Record<string, unknown>, depth?: number) => Promise<{ kind: string; reason?: string }>
  callTool: (name: string, args: Record<string, unknown>, sessionId: string, depth?: number) => Promise<string>
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
  assert.ok(listener !== undefined, '真实装配必须注册 tools/pre-execute 监听器')
  return {
    async callTool(name, args, sessionId, depth = 1) {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `工具面缺少 ${name}`)
      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
      const exec = {
        agent: { id: sessionId, session: { header: { id: sessionId, cwd: BASE, delegationDepth: depth, ...(depth === 0 ? {} : { parentSession: 'cockpit' }) } } },
      }
      return String(await tool.execute(filtered, exec))
    },
    async drive(tool, sessionId, args, depth = 1) {
      const exec = {
        name: tool,
        arguments: args,
        agent: { id: sessionId, session: { header: { id: sessionId, cwd: BASE, delegationDepth: depth, ...(depth === 0 ? {} : { parentSession: 'cockpit' }) } } },
      }
      return (await listener(exec, async () => ({ kind: 'allow' }))) as { kind: string; reason?: string }
    },
  }
}

// ————————————————————————— 纯函数层：归一 —————————————————————————

test('M76-01 路径归一：真机的**绝对路径**必须能归到工作区相对路径（原 L3 纪律就是在这里空转的）', () => {
  assert.equal(normalizeWorkspacePath('/home/raiptor/proj/lib/parse.js', '/home/raiptor/proj'), 'lib/parse.js')
  assert.equal(normalizeWorkspacePath('./lib/parse.js', '/home/raiptor/proj'), 'lib/parse.js')
  assert.equal(normalizeWorkspacePath('lib/../src/x.ts', '/home/raiptor/proj'), 'src/x.ts')
  assert.equal(normalizeWorkspacePath('lib\\parse.js', '/home/raiptor/proj'), 'lib/parse.js')
  assert.equal(normalizeWorkspacePath('/home/raiptor/proj', '/home/raiptor/proj'), '')
  // 工作区外的绝对路径**原样保留**（不会被误当成工作区内路径 ⇒ 不会因为归一而"洗白"成允许）
  assert.equal(normalizeWorkspacePath('/tmp/elsewhere.ts', '/home/raiptor/proj'), 'tmp/elsewhere.ts')
})

// ————————————————————————— 纯函数层：两重限制 —————————————————————————

test('M76-02 3b 卡级：有活卡时只许写卡的 writeScopes；3a 公共面不受限', () => {
  const base = { role: 'developer', tool: 'edit', workspace: '/w', guardedTools: GUARDED, sharedPaths: SHARED }
  // 卡内 ⇒ 放行
  assert.equal(evaluateWriteScope({ ...base, paths: ['/w/lib/parse.js'], cardScopes: ['lib/'] }).kind, 'allow')
  // 卡外 ⇒ 拒（点名越界路径与卡的写范围）
  const out = evaluateWriteScope({ ...base, paths: ['/w/src/other.ts'], cardScopes: ['lib/'] })
  assert.equal(out.kind, 'deny')
  assert.equal(out.kind === 'deny' ? out.code : '', 'write-scope-violation')
  assert.deepEqual(out.kind === 'deny' ? out.violations : [], ['src/other.ts'])
  assert.deepEqual(out.kind === 'deny' ? out.scope : [], ['lib/'])
  // 3a 公共面：即使不在卡写范围内也放行（台账由 SDO 工具落、派生文档与用例是跨卡共用面）
  for (const path of ['/w/.sdo/design/deviations.yml', '/w/docs/DESIGN.md', '/w/test/parse.test.js']) {
    assert.equal(evaluateWriteScope({ ...base, paths: [path], cardScopes: ['lib/'] }).kind, 'allow', `${path} 属公共面`)
  }
  // 一次调用里混着公共面与卡内路径 ⇒ 仍放行；只要有一个越界 ⇒ 拒
  assert.equal(evaluateWriteScope({ ...base, paths: ['/w/docs/A.md', '/w/lib/a.js'], cardScopes: ['lib/'] }).kind, 'allow')
  assert.equal(evaluateWriteScope({ ...base, paths: ['/w/docs/A.md', '/w/src/a.ts'], cardScopes: ['lib/'] }).kind, 'deny')
})

test('M76-03 没活卡 / 空写范围 / bash 无路径：三种边界各有明确处置', () => {
  const base = { role: 'developer', tool: 'write', workspace: '/w', guardedTools: GUARDED, sharedPaths: SHARED }
  // 没活卡 ⇒ 只能写公共面（先把卡认领了，写范围以卡为准）
  const noClaim = evaluateWriteScope({ ...base, paths: ['/w/lib/a.js'] })
  assert.equal(noClaim.kind === 'deny' ? noClaim.code : '', 'write-scope-no-claim')
  assert.equal(evaluateWriteScope({ ...base, paths: ['/w/docs/a.md'] }).kind, 'allow')
  // 有卡但卡上没写范围（计划缺陷，C-31 会判红）⇒ 拒，且给出补救
  const empty = evaluateWriteScope({ ...base, paths: ['/w/lib/a.js'], cardScopes: [] })
  assert.equal(empty.kind === 'deny' ? empty.code : '', 'write-scope-empty-scope')
  // bash 没有路径参数 ⇒ 本模块判不了（**不许**假装拦住了）：如实 `checked: false`
  const bash = evaluateWriteScope({ ...base, tool: 'bash', paths: [], cardScopes: ['lib/'] })
  assert.equal(bash.kind, 'allow')
  assert.equal(bash.kind === 'allow' ? bash.checked : true, false, 'bash 要如实标"没检查"')
  // 不在管辖工具集里的工具 ⇒ 不管
  assert.equal(evaluateWriteScope({ ...base, tool: 'read', paths: ['/w/src/a.ts'], cardScopes: ['lib/'] }).kind, 'allow')
})

test('M76-04 fail-open：驾驶舱 / 认不出人 / 拿不到工作区', () => {
  const base = { tool: 'edit', paths: ['/w/src/a.ts'], workspace: '/w', guardedTools: GUARDED, sharedPaths: SHARED, cardScopes: ['lib/'] }
  assert.equal(evaluateWriteScope({ ...base, role: 'cockpit' }).kind, 'allow', '驾驶舱要能维护台账/真源')
  assert.equal(evaluateWriteScope({ ...base, role: '' }).kind, 'allow', '认不出人 ⇒ 放行（不能变成干不了活）')
  assert.equal(
    evaluateWriteScope({ ...base, role: 'developer', workspace: undefined }).kind,
    'allow',
    '拿不到工作区 ⇒ 绝对路径无法归一 ⇒ 不判（fail-open，与"认不出人"同向）',
  )
  // 接线层：认不出会话时**根本不调用**这一层（`attributed.kind === 'unknown'`）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /if \(attributed\.kind !== 'unknown'\) \{/u, '认不出会话 ⇒ 不调写范围纪律（fail-open）')
})

// ————————————————————————— 钩子层：真的会拦 —————————————————————————

test('M76-05 真实钩子：tester 能 `edit` 自己的用例；写 `src/` 被卡级写范围当场拒', async () => {
  // ① 掩码层：tester 现在**有** write/edit（"没有 edit"既不更安全、又把改一处逼成整篇重写）
  assert.equal(maskAllows('tester', 'edit'), true)
  assert.equal(maskAllows('tester', 'write'), true)
  for (const role of ROLES) {
    assert.equal(maskAllows(role, 'edit'), maskAllows(role, 'write'), `${role}：write 与 edit 必须同权`)
  }
  // 只读角色仍然是两个都没有
  for (const role of ['red-team', 'reviewer'] as const) {
    assert.equal(maskAllows(role, 'write'), false)
    assert.equal(maskAllows(role, 'edit'), false)
  }

  // ② 路径层（真钩子）：tester 认领一张写范围是 `test/` 的卡
  writeCard(card('TASK-001', 'tester', ['test/']))
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-t', tools: 9, role: 'tester' })
  const h = hookHarness()
  const claimed = await h.callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'sub-1', expectedRevision: 1 }, 'child-t')
  assert.match(claimed, /in-progress/u, `前置：tester 认领成功：${claimed}`)

  const own = await h.drive('edit', 'child-t', { file_path: join(BASE, 'test/parse.test.js'), old_string: 'a', new_string: 'b' })
  assert.equal(own.kind, 'allow', `改自己的用例必须放行：${own.reason}`)
  const impl = await h.drive('edit', 'child-t', { file_path: join(BASE, 'src/parse.js'), old_string: 'a', new_string: 'b' })
  assert.equal(impl.kind, 'deny', '**不得修改被测实现**：卡写范围是 `test/` ⇒ 写 `src/` 当场拒')
  assert.match(impl.reason ?? '', /越界写|write scopes/u, `拒绝要讲清是写范围问题：${impl.reason}`)
  assert.match(impl.reason ?? '', /test\//u, '要点名卡的写范围')
  // 公共面照旧放行（台账/派生文档/用例）
  for (const path of ['.sdo/design/deviations.yml', 'docs/DESIGN.md', 'test/other.test.js']) {
    const verdict = await h.drive('edit', 'child-t', { file_path: join(BASE, path), old_string: 'a', new_string: 'b' })
    assert.equal(verdict.kind, 'allow', `${path} 属公共面，应放行：${verdict.reason}`)
  }
})

test('M76-06 真实钩子：没认领的子会话写产品文件被拒；驾驶舱不受写范围管辖', async () => {
  writeCard(card('TASK-001', 'developer', ['lib/']))
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-d', tools: 9, role: 'developer' })
  const h = hookHarness()

  // 子会话还没认领 ⇒ 只能写公共面（协议本来就要求先 claim）
  const before = await h.drive('write', 'child-d', { file_path: join(BASE, 'lib/a.js'), content: 'x' })
  assert.equal(before.kind, 'deny', '没认领就写产品文件 ⇒ 拒')
  assert.match(before.reason ?? '', /认领|claim/u, `拒绝里要给出出路（先认领）：${before.reason}`)
  const shared = await h.drive('write', 'child-d', { file_path: join(BASE, 'docs/notes.md'), content: 'x' })
  assert.equal(shared.kind, 'allow', '公共面不要求先认领')

  // 认领之后：卡内放行、卡外仍拒（认领走**生产路径**：它会 +1 角色缓存版本号，钩子的归属缓存随之刷新）
  const claimed = await h.callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'sub-1', expectedRevision: 1 }, 'child-d')
  assert.match(claimed, /in-progress/u, `前置：认领要成功：${claimed}`)
  assert.equal((await h.drive('write', 'child-d', { file_path: join(BASE, 'lib/a.js'), content: 'x' })).kind, 'allow')
  assert.equal((await h.drive('write', 'child-d', { file_path: join(BASE, 'src/a.ts'), content: 'x' })).kind, 'deny')

  // 驾驶舱（depth 0）：不认人 ⇒ 写范围不管它（它是流程官，要维护台账/真源）
  const cockpit = await h.drive('write', 'cockpit-root', { file_path: join(BASE, 'src/a.ts'), content: 'x' }, 0)
  assert.equal(cockpit.kind, 'allow', '驾驶舱不受卡级写范围管辖')
})

// ————————————————————————— 接线与死配置守卫 —————————————————————————

test('M76-07 接线守卫：两个"死配置"必须真的被读（`disciplineTools` / `disciplineAllowPaths`）', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /guardedTools: settings\.disciplineTools/u, '`disciplineTools` 必须真的决定"哪些工具的写入受管"')
  assert.match(index, /sharedPaths: settings\.disciplineAllowPaths/u, '`disciplineAllowPaths` 必须真的作为公共放行面')
  assert.match(index, /evaluateWriteScope\(/u, '写范围纪律必须在真实钩子里被调用')
  assert.match(index, /normalizeWorkspacePath\(path, call\.cwd\)/u, '路径必须先按工作区归一（真机传绝对路径）')
  // 反向：不许再有"配了但没人读"的字段 —— 机械扫一遍 `SdoConfig` 的每个字段
  const config = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8')
  const body = /export interface SdoConfig \{([\s\S]*?)\n\}/u.exec(config)?.[1] ?? ''
  const fields = [...body.matchAll(/^ {2}([a-zA-Z]\w*)\??:/gmu)].map((match) => match[1] as string)
  assert.ok(fields.length > 10, `要能解析出配置字段：${fields.length}`)
  const sources = [index, readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8'), readFileSync(join(ROOT, 'src', 'interface', 'inject.ts'), 'utf8')].join('\n')
  const dead = fields.filter((field) => !sources.includes(`settings.${field}`) && !sources.includes(`config.${field}`))
  assert.deepEqual(dead, [], `这些配置字段声明了却没人读（死配置比没有更糟：它让人以为有这道关）：${dead.join(' ')}`)
  // 默认值必须是"台账 + 派生文档 + 用例"这三个公共面
  const settings = resolveSettings(Config({} as unknown as SdoConfig))
  assert.deepEqual(settings.disciplineAllowPaths, ['.sdo/', 'docs/', 'test/'])
  assert.ok(settings.disciplineTools.includes('write') && settings.disciplineTools.includes('edit'))
})
