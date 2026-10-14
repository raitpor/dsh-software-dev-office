/**
 * **增量 139：注册面的参数 schema 必须过宿主的 schema 校验（真机事故回归，2026-10-14）**。
 *
 * **真机现场**（用户报告"跟另一个会话对话直接报错"）：会话一开口就 400 ——
 * ```
 * Invalid schema for function 'sdo_adr': "json" is not valid under any of the schemas
 * listed in the 'anyOf' keyword
 * ```
 *
 * **根因（已在现盘定位）**：本批 DEF-073 的"列表参数一处归一"用
 * `{ type: 'array', items: { type: 'json' } }` 拼 schema，而 `type: 'json'` 是**宿主作者侧 DSL 的伪类型** ——
 * 它只在 `defineTool` **内部**被编译成"仅注解的空 schema"；归一发生在 `defineTool` **之后** ⇒
 * 伪类型原样进了最终 schema ⇒ 供应商侧校验失败。实测注册面有 **23 个**参数带着它。
 *
 * **修法**：直接写**编译产物**（空 schema `{}` = 任意 JSON），语义与作者侧 `json` 完全一致。
 *
 * **本用例的守卫口径**：用**宿主自己的** `assertSupportedJsonSchema` 校验**每一个**已注册参数的
 * schema —— 与供应商侧看到的是同一份约束，所以这类"伪类型漏到线上"的事故不会再无声发生。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m139/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface RegisteredTool {
  name: string
  parameters: { properties?: Record<string, unknown> }
}

let tools: RegisteredTool[]
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M139 schema 合法性', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { a: 'b' } })
  tools = []
  const services: Record<string, unknown> = { tools: { register: (t: RegisteredTool) => { tools.push(t); return () => {} }, get: (n: string) => ({ n }) } }
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

test('M139-01 每个已注册参数的 schema 都必须过宿主的 `assertSupportedJsonSchema`', () => {
  let checked = 0
  for (const tool of tools) {
    for (const [name, param] of Object.entries(tool.parameters.properties ?? {})) {
      checked += 1
      try {
        assertSupportedJsonSchema(param)
      } catch (error) {
        assert.fail(`${tool.name}.${name} 的 schema 非法（供应商侧会直接 400）：${(error as Error).message.slice(0, 200)}`)
      }
    }
  }
  assert.ok(checked >= 200, `夹具前提：注册面参数应有两百多个（实际 ${checked}）`)
})

test('M139-02 联合形态的数组分支不得再出现作者侧伪类型 `json`', () => {
  const offenders: string[] = []
  for (const tool of tools) {
    for (const [name, param] of Object.entries(tool.parameters.properties ?? {})) {
      const text = JSON.stringify(param)
      if (/"type":"json"/u.test(text)) offenders.push(`${tool.name}.${name}`)
    }
  }
  assert.deepEqual(offenders, [], '`type: json` 是宿主作者侧 DSL 的伪类型，只允许出现在 defineTool 之前（源码里），不得进注册面')
  // 列表参数的数组分支：空 schema（= 宿主编译 `json` 的产物）
  const task = tools.find((tool) => tool.name === 'sdo_task')
  const dod = (task?.parameters.properties ?? {})['dod'] as { oneOf?: { items?: unknown }[] } | undefined
  const arrayBranch = (dod?.oneOf ?? []).find((branch) => (branch as { type?: string }).type === 'array')
  assert.deepEqual(arrayBranch?.items, {}, '数组分支的 items 必须是空 schema（与宿主编译产物一致）')
})

test("M139-03 源码级防回退：**归一函数体内**不得写 `items: { type: 'json' }`", async () => {
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync(new URL('../../src/interface/tools.ts', import.meta.url), 'utf8')
  // **只查归一函数体**：作者侧声明（`findings` / `suggestions` / `addWriteScopes` 的字面量）在
  // `defineTool` **之前**，伪类型会被宿主编译成空 schema ⇒ 那里写它是**正确**的；
  // 只有"在 `defineTool` 之后拼 schema"的归一函数不能写（真机 400 就是它造成的）。
  const start = raw.indexOf('function listSchema(')
  assert.ok(start > 0, '找不到归一函数 listSchema（改名了？那这条守卫就失效了）')
  const body = raw.slice(start, raw.indexOf('\n}', start))
  const code = body
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.equal(
    /items:\s*\{\s*type:\s*'json'\s*\}/u.test(code),
    false,
    "归一发生在 defineTool 之后 ⇒ 不能写伪类型；要用空 schema（见本用例头注释的真机事故）",
  )
  assert.match(code, /items:\s*\{\s*\}/u, '数组分支必须是空 schema（= 宿主编译 `json` 的产物）')
})
