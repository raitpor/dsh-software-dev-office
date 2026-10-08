/**
 * **提示面 ↔ 工具面同源守卫**（2026-10-08，从一次真缺陷里长出来的）。
 *
 * 背景（我自己引入并修掉的）：评审核实动作最初挂在 `sdo_review action=verify` 上，而 `sdo_review`
 * 在 developer / tester / delivery 的掩码里是**显式 deny** ⇒ 真正该核实的人够不着；同时所有
 * 回执/门禁补救/状态块**都在教模型敲这条命令**。这类缺陷域层单测与"直接调工具"的用例都发现不了
 * （它们绕过钩子），而 `m29` 只守**角色卡**、`m24` 只守**动作清单是否写进 README**，
 * **语言包与 README 里的命令行**此前无人守。
 *
 * 本守卫：把语言包（zh / en）、README、角色卡里出现的**所有** `sdo_X action=Y` 抽出来，
 * 与**真实注册**的工具表对照：
 *   ① 工具必须真实存在；
 *   ② `action` 必须是该工具**真实存在**的动作（占位符 `<序号>` / `…` 之类跳过）；
 *   ③ 命令里出现的动作若属于任务卡协议（`sdo_task`），该工具必须对**全部 8 个角色**可用
 *      （协议通道口径，`m31-04` 有独立守卫）—— 这一步专门兜住"教模型做一件它做不到的事"。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Config } from '../src/config.js'
import { maskAllows } from '../src/domain/roles.js'
import { ROLES } from '../src/domain/plan.js'
import { apply } from '../src/index.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

interface ToolDefinition {
  name: string
  parameters: { properties?: Record<string, { enum?: string[]; description?: string }> }
}

/** 用真实装配拿注册进宿主的工具（含动作清单），与 `m24` 同一套形态。 */
function registeredTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition): (() => void) => { tools.push(tool); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  return tools
}

/** 动作清单（enum 优先；否则从 description 的第一段解析，与 `m24`/`m17` 同口径）。 */
function actionNames(tool: ToolDefinition): string[] {
  const action = tool.parameters.properties?.['action']
  if (action === undefined) return []
  if (action.enum !== undefined && action.enum.length > 0) return [...action.enum]
  const description = action.description ?? ''
  const head = description.split('（')[0]?.trim() ?? ''
  if (/^[a-z][a-z-]*(\s*\/\s*[a-z][a-z-]*)+$/u.test(head)) return head.split('/').map((part) => part.trim())
  return [...(description.split(/[.。]/u)[0] ?? '').matchAll(/'([a-z][a-z-]*)'/gu)].map((match) => match[1] ?? '')
}

const TOOLS = registeredTools()
const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, actionNames(tool)]))

/** 提示面：语言包（两包）、README、全部角色卡。 */
function promptFiles(): { label: string; text: string }[] {
  const files: { label: string; text: string }[] = [
    { label: 'src/data/lang/zh-CN.yml', text: readFileSync(join(ROOT, 'src', 'data', 'lang', 'zh-CN.yml'), 'utf8') },
    { label: 'src/data/lang/en.yml', text: readFileSync(join(ROOT, 'src', 'data', 'lang', 'en.yml'), 'utf8') },
    { label: 'README.md', text: readFileSync(join(ROOT, 'README.md'), 'utf8') },
  ]
  const skills = join(ROOT, 'skills')
  for (const name of readdirSync(skills).filter((item) => item.endsWith('.md')).sort()) {
    files.push({ label: `skills/${name}`, text: readFileSync(join(skills, name), 'utf8') })
  }
  // 流程数据也是**用户可见**的说明面（`desc` / 注释会写给流程官看），一并纳入。
  const processes = join(ROOT, 'src', 'data', 'processes')
  for (const name of readdirSync(processes).filter((item) => item.endsWith('.yml')).sort()) {
    files.push({ label: `src/data/processes/${name}`, text: readFileSync(join(processes, name), 'utf8') })
  }
  return files
}

/** 抽出 `sdo_X action=Y`（`Y` 必须是 ASCII 动作名；占位符一律跳过）。 */
function commandsIn(text: string): { tool: string; action: string }[] {
  const out: { tool: string; action: string }[] = []
  for (const match of text.matchAll(/(sdo_[a-z_]+)[^\n]{0,24}?action=([a-z][a-z-]*)/gu)) {
    out.push({ tool: match[1] as string, action: match[2] as string })
  }
  return out
}

test('M69-01 提示面里的每一条 `sdo_X action=Y` 都必须是真实工具 + 真实动作（否则模型照着敲必然失败）', () => {
  const problems: string[] = []
  let checked = 0
  for (const file of promptFiles()) {
    for (const { tool, action } of commandsIn(file.text)) {
      checked += 1
      const actions = BY_NAME.get(tool)
      if (actions === undefined) {
        problems.push(`${file.label}: 提到了不存在的工具 ${tool}`)
        continue
      }
      if (actions.length > 0 && !actions.includes(action)) {
        problems.push(`${file.label}: ${tool} 没有动作 ${action}（真实动作：${actions.join(' / ')}）`)
      }
    }
  }
  assert.ok(checked >= 20, `应能抽出足够多的命令做检查（实际 ${checked} 条）——正则失效会让这条守卫空转`)
  assert.deepEqual(problems, [], `提示面与实现不一致：\n${problems.join('\n')}`)
})

test('M69-02 协议通道口径：`sdo_task` 必须对全部 8 个角色可用（提示里让它敲的任务动作不能有人敲不动）', () => {
  for (const role of ROLES) {
    assert.equal(maskAllows(role, 'sdo_task'), true, `${role} 必须能用协议通道 sdo_task`)
  }
  // 直接钉住本次事故的教训：实现角色必须够得着"核实评审发现"那条命令所在的工具。
  // （动作本身挂在 sdo_task 上；`m68-03` 另有端到端可达性断言。这里从**提示面**反推：）
  for (const file of promptFiles()) {
    for (const { tool } of commandsIn(file.text)) {
      if (tool !== 'sdo_task') continue
      for (const role of ['developer', 'tester', 'delivery'] as const) {
        assert.equal(maskAllows(role, 'sdo_task'), true, `${file.label} 教模型敲 sdo_task，而 ${role} 够不着`)
      }
    }
  }
})
