/**
 * **增量 182：第六批 §3.3（`DEF-079`）+ §3.10（`R17`）。**
 *
 * §3.3 的**核实结论**（与交接书不同，已如实上报）：`sdo_test action=plan` **本来就会**落
 * `test/recorded` 事件，而该事件**本来就在** `SIGNATURE_NEUTRAL_EVENTS` 里（⇒ 建案不作废签字）。
 * 缺的只是"**谁**建的"：事件的 `actor` 一律是缺省 `'sdo'`。⇒ 修法 = 把调用方身份如实记进 `actor`
 *（`TestCase` 文件形状一字不动 ⇒ 存量 149 条不追溯）。
 *
 * §3.10：拿不到 `sessionId` ⇒ 掩码路径 fail-open（`sdo_plan` allow）。可达性结论：**只有合成探针**能造出这一态
 *（真实工具调用一定发生在会话里）⇒ **有意放行**，理由写进 `roles.ts` 的注释与该用例的结构断言。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config } from '../src/config.js'
import { apply } from '../src/index.js'
import { checkDocFiles, repoDocFaces } from './docRefs.js'
import { SdoStore } from '../src/infra/store.js'
import { UNCLAIMED_CHILD_FACE, roleMaskDecision } from '../src/domain/roles.js'
import { isSignatureInvalidatingEvent } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm182')
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition { name: string; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

function registered(): ToolDefinition[] {
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

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, '.sdo'), { recursive: true })
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M182-01 §3.3（DEF-079）：建案事件带**建立者**，且该事件不作废签字；存量文件形状不追溯', async () => {
  const tool = registered().find((item) => item.name === 'sdo_test')
  assert.ok(tool !== undefined)
  const sessionId = 's-planner-7'
  const receipt = String(await tool.execute(
    { action: 'plan', title: 'A', kind: 'unit', steps: ['x'], expected: 'e' },
    { agent: { id: sessionId, session: { header: { id: sessionId, cwd: WORKSPACE, delegationDepth: 0 } } } },
  ))
  assert.match(receipt, /TC-001/u, `建案必须成功：${receipt.slice(0, 200)}`)
  const store = new SdoStore(join(WORKSPACE, '.sdo'))
  const events = store.readText('journal.jsonl') ?? ''
  const planned = events.split('\n').filter((line) => line.includes('"test/recorded"'))
  assert.equal(planned.length, 1, `建案必须落一条 test/recorded（实际 ${planned.length}）`)
  const event = JSON.parse(planned[0] as string) as { actor?: string; data?: Record<string, unknown>; at?: string }
  assert.equal(event.actor, sessionId, `事件的 actor 必须是**建案的那个会话**（不是缺省 sdo）：${planned[0]}`)
  assert.equal(event.data?.['id'], 'TC-001', '事件必须带 caseId')
  assert.equal(typeof event.at, 'string', '事件必须有时刻')
  // DoD ②：建案不作废签字（G2/G3 两侧同验）
  assert.equal(isSignatureInvalidatingEvent('G2', 'test/recorded'), false, 'G2 侧：建案不作废签字')
  assert.equal(isSignatureInvalidatingEvent('G3', 'test/recorded'), false, 'G3 侧：建案不作废签字')
  // DoD ③：存量形状不追溯（用例文件里**不**新增作者字段）
  const file = store.readYaml<{ testCase: Record<string, unknown> }>('tests', 'TC-001.yml')?.testCase ?? {}
  assert.equal('by' in file || 'author' in file, false, '作者只进真源事件，不进用例文件（存量形状不变）')
})

test('M182-02 §3.10（R17）：无 `sessionId` 的 fail-open 记为**有意放行**（留痕在位 + 可达性结论）', () => {
  const roles = readFileSync(join(ROOT, 'src', 'domain', 'roles.ts'), 'utf8')
  assert.match(roles, /六批 §3\.10/u, '`roles.ts` 必须写下 R17 的结论出处')
  assert.match(roles, /有意放行/u, '必须明确记"有意放行"（不许含糊）')
  assert.match(roles, /只有合成探针/u, '必须给可达性结论：只有合成探针能造出这一态')
  assert.match(roles, /fail-closed/u, '必须写明"若将来宿主真的允许无名会话 ⇒ 改成 fail-closed"的触发条件')
  // **DEF-086（第七批 §3.4）**：本条的结论必须**自足**（不外包给别处）。
  assert.match(roles, /理由就写在这一段里/u, '`roles.ts` 的 R17 留痕必须自述"理由写在这一段里"（自足）')
  // **DEF-088（第八批 §3.3）**：旧判据是"关键词 + DEF 号"一句 —— V16 实测**既不充分也不必要**
  //（合法引用假阳性 / 英文悬空漏判 / 保留措辞掏空语义仍绿）。现在换成**机制判据**（`test/docRefs.ts`）：
  // 只认①标识符的**可解析性**与②结构标记内的**逐字相等**，不认任何自然语言措辞 ⇒ 中英文同一判定。
  const { citations, witnesses } = repoDocFaces(ROOT)
  const issues = checkDocFiles(citations, witnesses).filter((issue) => /^DEF-\d/.test(issue.detail))
  assert.deepEqual(issues, [], `缺陷号引用必须可解析（悬空引用 = 红）：${JSON.stringify(issues).slice(0, 600)}`)
  // 行为三态（不因留痕改动而变）：无 sessionId ⇒ allow；带 sessionId 的未认领子会话 ⇒ 权威面 deny
  assert.deepEqual(roleMaskDecision('cockpit', 'sdo_plan'), { kind: 'allow' }, '驾驶舱不受限（口径不变）')
  assert.equal(roleMaskDecision(UNCLAIMED_CHILD_FACE, 'sdo_plan').kind, 'deny', '带会话的未认领子会话仍收窄（口径不变）')
})
