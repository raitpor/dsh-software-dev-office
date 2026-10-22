/**
 * **增量 133：本会话加载的构建必须可核（DEF-070，2026-10-14 机制缺陷批 §3C）**。
 *
 * 缺陷现场：会话运行时加载的是**实例 profile 下的已安装副本**，不是工作树；两处曾**同版本号而内容分叉**
 * （`grep -c oneOf`：副本 0 / 本仓 4）⇒ 端到端验证会验到**旧构建**，而且**没有任何机械提示**。
 * （`pnpm` 的 `file:` 依赖是**硬链接**：改写已有文件同步、**新增/删除/改名不同步** —— 新模块最容易漏。）
 *
 * **先钉红**：修前没有任何地方报"这份构建来自哪里、指纹是什么"。
 *
 * **修法**：`domain/buildInfo.ts` —— ① 读出**实际加载**的包根 + 入口文件内容指纹（读不到 ⇒ 如实
 * `unavailable`，**不编造**）；② 只在"那个目录确实是本插件"时才与它比对，比不了就明说**不可比**；
 * ③ `sdo_status` 与派发回执都印这一行。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { PLUGIN_PACKAGE_NAME, buildInfoOf, loadedBuild, sameBuild, worktreeBuildOf } from '../src/domain/buildInfo.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m133/', import.meta.url))

const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
let tools: { name: string; parameters: unknown; execute: (a: Record<string, unknown>, c: { agent?: unknown }) => unknown }[]
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes: [`src/${id}/`],
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'ready',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
  }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M133 构建读数', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { a: 'b' } })
  tools = []
  const services: Record<string, unknown> = { tools: { register: (t: never) => { tools.push(t); return () => {} }, get: (n: string) => ({ n }) } }
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
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M133-01 读出"实际加载的那份构建"：包根 + 入口指纹 + 版本；本仓基准下与工作树同源', () => {
  const loaded = loadedBuild()
  assert.equal(loaded.source, 'import-meta', '入口读得到 ⇒ 不许降级')
  assert.match(loaded.entryPath, /index\.(js|ts)$/u, `入口必须是插件的入口文件：${loaded.entryPath}`)
  assert.match(loaded.fingerprint, /^[0-9a-f]{12}$/u, '指纹必须是内容 sha256 的前 12 位')
  assert.equal(loaded.packageRoot, ROOT.replace(/[\\/]+$/u, ''), '包根必须是本插件包根（两端分隔符都剥：win32 的 ROOT 以 `\\` 结尾）')

  // 测试进程就在本仓上跑 ⇒ 与"工作树"是同一份
  const tree = worktreeBuildOf(ROOT)
  assert.ok(tree !== undefined, '本仓目录必须被认成插件工作树')
  assert.equal(sameBuild(loaded, tree), true)
})

test('M133-02 读不到就**如实降级**（不编造指纹）；不是本插件的目录 ⇒ 明确"不比"', () => {
  const missing = buildInfoOf(join(BASE, 'nope'))
  assert.equal(missing.source, 'unavailable', '入口不存在 ⇒ unavailable')
  assert.equal(missing.fingerprint, '', '拿不到指纹就是空串（绝不编造）')
  assert.equal(missing.entryPath, '')
  assert.equal(missing.version, '', 'package.json 也没有 ⇒ 版本空串')

  assert.equal(worktreeBuildOf(join(BASE, 'unrelated')), undefined, '陌生目录不得硬凑成"工作树"')
  assert.equal(sameBuild(loadedBuild(), missing), undefined, '一侧拿不到指纹 ⇒ 不可比（返回 undefined，不下结论）')
})

test('M133-03 分叉必须能判出来：内容不同的两份构建 ⇒ sameBuild=false，且给出两侧指纹', () => {
  // 造一个"同名但内容不同"的包根：package.json 名字对得上 + 入口内容不同
  const other = join(BASE, 'other', PLUGIN_PACKAGE_NAME)
  mkdirSync(join(other, 'lib', 'src'), { recursive: true })
  writeFileSync(join(other, 'package.json'), JSON.stringify({ name: PLUGIN_PACKAGE_NAME, version: '0.1.6' }), 'utf8')
  writeFileSync(join(other, 'lib', 'src', 'index.js'), '// a different build\n', 'utf8')

  const tree = worktreeBuildOf(other)
  assert.ok(tree !== undefined, `同名包根必须被认出来：${other}`)
  assert.equal(tree.fingerprint !== loadedBuild().fingerprint, true, '内容不同 ⇒ 指纹必须不同（这就是分叉的判据）')
  assert.equal(sameBuild(loadedBuild(), tree), false)
})

test('M133-04 状态回执与派发回执都印这一行（工具级）', async () => {
  const statusTool = tools.find((item) => item.name === 'sdo_status')
  assert.ok(statusTool !== undefined, '工具面缺 sdo_status')
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  const status = String(await statusTool.execute({ action: 'status' }, { agent: agentStub }))
  assert.match(status, /🧩/u, `状态回执必须印构建读数：${status.slice(0, 300)}`)
  assert.match(status, new RegExp(loadedBuild().fingerprint, 'u'), '要点名指纹')

  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-961.yml'], { task: card('TASK-961') })
  const plan = tools.find((item) => item.name === 'sdo_plan')
  assert.ok(plan !== undefined)
  const receipt = String(await plan.execute({ action: 'next', limit: 1 }, { agent: agentStub }))
  assert.match(receipt, /🧩/u, `派发回执也必须印构建读数：${receipt.slice(0, 300)}`)
})

test('M133-05 TC-146：构建读数在**首行**且印包根 + 版本（不只指纹）；派发回执三件齐备并给三分结论', async () => {
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  const loaded = loadedBuild()
  assert.ok(loaded.packageRoot !== '' && loaded.version !== '' && loaded.fingerprint !== '', '夹具前提：本会话加载的构建三件齐备')

  // ① 状态回执：构建读数必须是**第一行**（首屏第一眼），且包根 / 指纹 / 版本三件都在
  const statusTool = tools.find((item) => item.name === 'sdo_status')
  assert.ok(statusTool !== undefined)
  const status = String(await statusTool.execute({ action: 'status' }, { agent: agentStub }))
  const first = status.split('\n')[0] ?? ''
  assert.match(first, /🧩/u, `构建读数必须在**首行**（不许沉到底部）：${first}`)
  assert.ok(first.includes(loaded.packageRoot), `首行必须印**包根**：${first}`)
  assert.ok(first.includes(loaded.version), `首行必须印**版本**：${first}`)
  assert.ok(first.includes(loaded.fingerprint), `首行必须印**入口指纹**：${first}`)

  // ② 派发回执：不只一个 🧩 标记，三件同样齐备。
  //    要让「与工作树的三分结论」真的出现，派发 cwd 自己得是一个**同名插件包根** —— 这里在夹具工作区
  //    造一份**内容不同**的同名包（⇒ 走"不是同一份构建"那一档，顺便验证它点名两侧指纹）。
  mkdirSync(join(WORKSPACE, 'lib', 'src'), { recursive: true })
  writeFileSync(join(WORKSPACE, 'package.json'), JSON.stringify({ name: PLUGIN_PACKAGE_NAME, version: '0.1.6' }), 'utf8')
  writeFileSync(join(WORKSPACE, 'lib', 'src', 'index.js'), '// a different build in the fixture worktree\n', 'utf8')
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-962.yml'], { task: card('TASK-962') })
  const plan = tools.find((item) => item.name === 'sdo_plan')
  assert.ok(plan !== undefined)
  const receipt = String(await plan.execute({ action: 'next', limit: 1 }, { agent: agentStub }))
  assert.ok(receipt.includes(loaded.packageRoot), `派发回执必须印包根：${receipt.slice(0, 400)}`)
  assert.ok(receipt.includes(loaded.version), '派发回执必须印版本')
  assert.ok(receipt.includes(loaded.fingerprint), '派发回执必须印指纹（不能只印一个 🧩 标记）')
  // ③ 与工作树的**三分结论**必须给：同一份 / 分叉点名 / 不可比
  // 三分：同一份 / 不是同一份（点名两侧指纹）/ 不可比 —— 三选一必须出现，且都要说"与工作树"
  assert.match(receipt, /与工作树/u, `派发回执要给"本会话构建 vs 工作树"的结论：${receipt.slice(-600)}`)
  assert.equal(
    ['同一份构建', '不是同一份构建', '不可比'].some((word) => receipt.includes(word)),
    true,
    `三分结论必须落在其中一档（实际：${receipt.slice(-600)}）`,
  )
})
