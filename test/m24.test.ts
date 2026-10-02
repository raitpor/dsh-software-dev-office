/**
 * 文档守卫：**README ↔ 实现同源**。
 *
 * README 是用户的第一入口，它列出的工具 / 动作 / 命令 / 配置键必须与实现一致。
 * 历史上这里翻过两次车：动作清单三处漂移（F-17 / F-18）、README 的命令写法与解析器不一致（m10 的 DEF）。
 *
 * 口径（用户对 README 的定位）：README 只讲**介绍与用法** —— 因此它必须完整列出工具（含动作）、
 * 斜杠命令与配置键；同时**不得**再出现"设计决策 / 为什么这么做"这类小节。本用例只钉这两件事，
 * 不审措辞、不审长度。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Config } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { apply } from '../src/index.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const CONFIG_SOURCE = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8')

interface ToolDefinition {
  name: string
  parameters: { properties?: Record<string, { enum?: string[]; description?: string }> }
}

/** 用真实装配拿到注册进宿主的工具与命令（与 m15/m17 同一套假 ctx 形态）。 */
function register(): { tools: ToolDefinition[]; commands: string[] } {
  const tools: ToolDefinition[] = []
  const commands: string[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition): (() => void) => { tools.push(tool); return () => {} } },
    commands: { register: (command: { name: string }): (() => void) => { commands.push(command.name); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  return { tools, commands }
}

const { tools, commands } = register()

/**
 * README 的表格行里，工具那一格必须写成 `` `sdo_x`（动作 / 动作）``。
 *
 * 动作清单有两种落地形态（与 m17 的 `actionList` 口径一致）：
 *   · schema 里是 `enum`；或
 *   · schema 里是 `description`（`proseSuffix`，如 `sdo_redteam`）—— 取其第一段（`（` 之前）即清单。
 * 只认 `enum` 会漏掉后者（变异自证时发现的）：那样的工具就没人守着，动作清单可以随便漂。
 */
function actionNames(tool: ToolDefinition): string[] | undefined {
  const action = tool.parameters.properties?.['action']
  if (action === undefined) return undefined
  if (action.enum !== undefined && action.enum.length > 0) return [...action.enum]
  const description = action.description
  if (description === undefined) return undefined
  // 形态 A：`attack / propose / file（说明…）` —— 取 `（` 之前那一段
  const head = description.split('（')[0]?.trim() ?? ''
  if (/^[a-z][a-z-]*(\s*\/\s*[a-z][a-z-]*)+$/u.test(head)) {
    return head.split('/').map((part) => part.trim())
  }
  // 形态 B：`'show' | 'set'. show＝…` —— 取第一句里的引号标识
  const firstSentence = description.split(/[.。]/u)[0] ?? ''
  const quoted = [...firstSentence.matchAll(/'([a-z][a-z-]*)'/gu)].map((match) => match[1] ?? '')
  return quoted.length > 0 ? quoted : undefined
}

/** README 的表格行里，工具那一格必须写成 `` `sdo_x`（动作 / 动作）``。 */
function expectedActionCell(tool: ToolDefinition): string | undefined {
  const list = actionNames(tool)
  if (list === undefined || list.length === 0) return undefined
  return `\`${tool.name}\`（${list.join(' / ')}）`
}

test('README 与实现一致：20 个工具及其动作清单都写在 README 里（同源、同顺序）', () => {
  assert.equal(tools.length, 20, `应注册 20 个工具，实际 ${tools.length}`)
  for (const tool of tools) {
    assert.ok(README.includes(`\`${tool.name}\``), `README 必须列出工具 ${tool.name}`)
    const cell = expectedActionCell(tool)
    if (cell === undefined) continue
    assert.ok(
      README.includes(cell),
      `README 的 ${tool.name} 动作清单必须与实现一致（缺这一格：${cell}）`,
    )
  }
})

test('README 与实现一致：17 条斜杠命令都写在 README 里', () => {
  assert.equal(commands.length, 17, `应注册 17 条命令，实际 ${commands.length}`)
  for (const name of commands) {
    assert.ok(README.includes(`\`/${name}\``), `README 必须列出命令 /${name}`)
  }
})

test('README 与实现一致：配置键（带默认值的）都写进 README', () => {
  // 从**源码**提取（不硬编码清单，避免用例自身漂移）：`key: z.…default(`
  const keys = [...CONFIG_SOURCE.matchAll(/^ {2}(\w+): z\.[\s\S]*?\.default\(/gmu)].map((match) => match[1])
  assert.ok(keys.length >= 10, `应从 config.ts 提取到配置键，实际 ${keys.length}`)
  for (const key of keys) {
    assert.ok(README.includes(`\`${key}\``), `README 的配置表必须写出配置键 ${key}`)
  }
})

test('README 只讲介绍与用法：不得再出现「设计决策 / 为什么这么做」小节', () => {
  const headings = README.split('\n').filter((line) => line.startsWith('#'))
  for (const banned of ['为什么', '设计要点', '设计决策', '取舍', '理由']) {
    const hit = headings.filter((line) => line.includes(banned))
    assert.deepEqual(hit, [], `README 的小节标题不得包含「${banned}」：${hit.join(' / ')}`)
  }
})
