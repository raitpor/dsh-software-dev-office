/**
 * **长文本 JSON 参数的报错分流与位置点名**（修复 DEF-046）。
 *
 * 前提（上一轮实测更正）：两类报错来自**两个不同层** ——
 *   - 「参数 X must be a string」来自**宿主 harness 的 schema 校验**（`grep -rn "must be a string" src/`
 *     全仓只有 `tools.ts:561` 一句描述性注释）⇒ 那次调用**根本没到插件**，插件侧**无路径可改**；
 *   - 「参数 X 不是合法 JSON」来自插件的 `jsonOr`（`src/index.ts`，**37 个调用点**的唯一出口）且已分流。
 *
 * ⇒ 真缺口只有一条：`JSON.parse` 的报错**只说形状、不点名位置**。本文件钉住修复后的分流：
 *   ① 值里含 ASCII **双引号** ⇒ 点名**位置与字符**；
 *   ② 值里含 ASCII **单引号** ⇒ 同上（实测盲区，必须覆盖）；
 *   ③ **形状**错误（非数组 / 裸换行）⇒ 报「形状」类，且与值类**可区分**；
 *   ④ 正常值（含中文引号）⇒ 通过。
 *
 * 另有一条**经工具面**的端到端：`sdo_adr action=record` 的 `alternatives` 走同一个 `jsonOr`，
 * 确保"导出函数绿了但工具面拿不到"这种空转不会发生（`tq_ff348198` 同源教训）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { Config, resolveSettings } from '../src/config.js'
import { apply, jsonOr } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m104/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub } as unknown as Parameters<typeof tool.execute>[1]))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  tools = []
  services = {}
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
  services['tools'] = { register: (tool: ToolDefinition): (() => void) => { tools.push(tool); return () => {} } }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// ————————————————————— ① ASCII 双引号 ⇒ 点名位置与字符 —————————————————————

test('M104-01 值里含 ASCII 双引号 ⇒ 报错点名**第 N 个字符**与该字符', () => {
  // 显式写出要测的那个文本：第 1 个字符处就是 `[`，引号在第 2 个字符处
  const bad = '["参考 src/x.ts:10 的 \"helper\" 实现"]'
  const result = jsonOr<string[]>(bad, 'findings')
  assert.ok(result.error !== undefined, '值里有未转义 ASCII 双引号时必须报错')
  const text = result.error ?? ''
  assert.match(text, /findings/, `必须点名参数名：${text}`)
  assert.match(text, /第 \d+ 个字符/, `必须点名位置：${text}`)
  assert.ok(text.includes('"'), '必须点出可疑字符本身（双引号）')
  assert.match(text, /中文引号|转义/, `必须给可操作修法：${text}`)
  assert.equal(text.includes('形状'), false, '引号类**不得**混进"形状"类文案')
})

test('M104-01b 位置必须是真的（更靠后的引号要报到更大的位置）', () => {
  // 两条都只坏在引号上（把 ASCII 引号换成中文引号即可解析），差别是引号位置更靠后
  const a = jsonOr<string[]>('["这里 " 引号"]', 'findings').error ?? ''
  const b = jsonOr<string[]>('["更长一点 " 引号"]', 'findings').error ?? ''
  const num = (text: string): number => Number(/第 (\d+) 个字符/.exec(text)?.[1] ?? '0')
  assert.ok(num(a) > 0 && num(b) > num(a), `更靠后的引号必须报到更大的位置：${num(a)} vs ${num(b)}`)
})

// ————————————————————— ② ASCII 单引号（实测盲区）————————————————————

test('M104-02 值里含 ASCII 单引号 ⇒ 同样点名位置与字符（实测盲区，必须覆盖）', () => {
  const bad = "['用 ' 引号包住的片段']"
  const result = jsonOr<string[]>(bad, 'findings')
  assert.ok(result.error !== undefined, '单引号会让 JSON 解析失败时同样要点名')
  const text = result.error ?? ''
  assert.match(text, /第 \d+ 个字符/, `必须点名位置：${text}`)
  assert.ok(text.includes("'"), '必须点出可疑字符本身（单引号）')
  assert.equal(text.includes('形状'), false, '单引号类也不得混进"形状"类文案')
})

// ————————————————————— ③ 形状错误 ⇒ 与值类可区分 —————————————————————

test('M104-03 形状错误（裸换行 / 不是数组的裸词）⇒ 报"形状"类，且与值类可区分', () => {
  const newline = jsonOr<string[]>('["第一行\n第二行"]', 'findings')
  assert.ok(newline.error !== undefined, '字符串里的裸换行必须报错')
  const shapeText = newline.error ?? ''
  assert.match(shapeText, /形状/, `形状类文案要点明"形状"：${shapeText}`)
  assert.match(shapeText, /findings/, '仍要点名参数名')
  assert.equal(/第 \d+ 个字符/.test(shapeText), false, '形状类**不得**给出引号位置（两类必须可区分）')

  const bare = jsonOr<string[]>('not json at all', 'findings')
  assert.ok(bare.error !== undefined)
  assert.match(bare.error ?? '', /形状/, `裸词也是形状类：${bare.error}`)
})

// ————————————————————— ④ 正常值（含中文引号）⇒ 通过 —————————————————————

test('M104-04 正常值（值里用中文引号）⇒ 解析通过，且不产生任何报错', () => {
  const good = jsonOr<string[]>(JSON.stringify(['参考 src/x.ts:10 的「helper」实现']), 'findings')
  assert.equal(good.error, undefined, '值里用中文引号必须能解析')
  assert.deepEqual(good.value, ['参考 src/x.ts:10 的「helper」实现'])

  // 转义写法也必须照样通过
  const escaped = jsonOr<string[]>(JSON.stringify(['参考 "helper" 实现']), 'findings')
  assert.equal(escaped.error, undefined, '按 JSON 规则正确转义的 ASCII 引号必须能解析')
})

// ————————————————————— 端到端：经工具面（防"导出绿了、工具面拿不到"）————————————————————

test('M104-05 经工具面：sdo_adr action=record 的 alternatives 坏 JSON ⇒ 回执按新口径点名位置', async () => {
  const receipt = await callTool('sdo_adr', {
    action: 'record',
    title: '选型：真源目录用 YAML 还是 JSON',
    decision: '用 YAML 子集',
    alternatives: '[{"option":"YAML","pros":"可读"}]',
  })
  // 这条 alternatives 本身合法 —— 先确认正常路径不被误伤
  assert.equal(/第 \d+ 个字符/.test(receipt), false, `正常 alternatives 不该报位置：${receipt}`)

  const broken = await callTool('sdo_adr', {
    action: 'record',
    title: '选型：第二个',
    decision: '用 JSON',
    alternatives: '[{"option":"JSON","pros":""工具"友好"}]',
  })
  assert.match(broken, /alternatives/, `工具面回执必须点名参数名：${broken}`)
  assert.match(broken, /第 \d+ 个字符/, `工具面回执必须点名位置（否则只是导出的函数绿了）：${broken}`)
})
