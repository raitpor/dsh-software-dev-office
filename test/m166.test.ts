/**
 * **增量 166：DEF-025（major，第三批 §3.10）—— 环境登记的影响面提示与出路**。
 *
 * 修前现盘读数：
 *   · 不给 `env` 调 `action=env` ⇒ **可读拒绝**，于是"当前环境到底是什么"除了翻台账没别的办法拿到；
 *   · 登记回执只回 `env` + `at`（`src/index.ts`），**没有影响面**；而环境指纹是**项目级**动作 ——
 *     一次登记会让别的卡绑着旧环境的证据集体变成"证据过期"，读者却看不到是哪些、也不知道该补什么。
 *
 * 修法（三件，DoD 逐条对应）：
 *   ① **影响面**：登记时回执点名"因这次登记而新过期"的结果（复用唯一出口 `evidenceFreshness`：
 *      新环境判过期的 **减去** 登记前就已过期的 —— 只报**新**过期，不虚报）；
 *   ② **出路**：给可执行的补做/重跑命令（逐条 `sdo_test action=record … env=<新环境>`）；
 *   ③ **当前环境串只读可得**：`action=env` **不带 `env=`** ⇒ 只读回显当前串与登记时刻（**不写事件**）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m166/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition {
  name: string
  execute: (args: Record<string, unknown>, ctx: { agent?: unknown }) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>
const call = { sessionId: 's-batch3', cwd: WORKSPACE } as unknown as OfficeCall

const journalBytes = (): string => readFileSync(join(WORKSPACE, '.sdo', 'journal.jsonl'), 'utf8')

async function callTest(args: Record<string, unknown>): Promise<string> {
  const def = tools.find((item) => item.name === 'sdo_test')
  assert.ok(def !== undefined, '前置：工具面必须有 sdo_test')
  // 工作区由**会话上下文**给（与真机一致）：不给 stub 会报"无法确定本会话的工作区"
  const agentStub = { id: 's-batch3', session: { header: { id: 's-batch3', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await def.execute(args, { agent: agentStub }))
}

/** 造一条 pass 结果（env 由夹具指定；`latest-per-case` 口径下每个用例只留最新那条）。 */
function passResult(caseId: string, env: string): void {
  office.storeFor(WORKSPACE).writeYaml(['tests', `${caseId}.yml`], {
    testCase: { id: caseId, title: caseId, kind: 'unit', requirement: '', steps: [], expected: 'x', at: '' },
  })
  const outcome = office.addTestResult(call, {
    caseId,
    status: 'pass',
    evidence: 'jest 输出',
    ...(env === '' ? {} : { env }),
  } as never)
  assert.equal(outcome.ok, true, `夹具前提：${caseId} 必须记成功：${JSON.stringify(outcome)}`)
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-batch3', WORKSPACE)
  office.init(call, { name: 'M166 环境影响面', scale: 'normal', stakeholders: ['业务方'] })
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
  services['tools'] = { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M166-01（③ 只读可得）不带 `env=` 只回显当前环境：从未登记说「尚未登记」，已登记给串与时刻，且**不写事件**', async () => {
  const before = journalBytes()
  const never = await callTest({ action: 'env' })
  assert.match(never, /尚未登记过/u, `未登记时必须如实说没登记过：${never.slice(0, 200)}`)
  assert.equal(journalBytes(), before, '只读回显**不得**写事件（逐字节比较，不是"条数没变"）')

  const registered = await callTest({ action: 'env', env: 'jdk=21.0.2', reason: '换 JDK' })
  assert.match(registered, /已登记/u, `登记成功要有回执：${registered.slice(0, 160)}`)
  const afterRegister = journalBytes()
  const current = await callTest({ action: 'env' })
  assert.match(current, /jdk=21\.0\.2/u, `只读回显必须给出**当前环境串**：${current.slice(0, 200)}`)
  assert.equal(current.includes('尚未登记过'), false, '登记过之后不得再说"尚未登记"')
  assert.equal(journalBytes(), afterRegister, '只读回显**不得**写事件（第二次证：登记之后仍然如此）')
})

test('M166-02（① 影响面 + ② 出路）登记后点名"因这次登记而新过期"的结果，并给可执行重跑命令', async () => {
  passResult('TC-001', 'jdk=17')   // 会被新环境判过期（用例 id 必须是 TC-<数字>：listTestCases 只认这个文件名口径）
  passResult('TC-002', 'jdk=21')   // 与新环境一致 ⇒ 不受影响
  passResult('TC-003', '')        // 没记环境 ⇒ 归 unrecorded（**不得**混进影响面）
  const receipt = await callTest({ action: 'env', env: 'jdk=21', reason: '升 JDK' })
  assert.match(receipt, /影响面/u, `回执必须有点名影响面的一行：${receipt.slice(0, 400)}`)
  assert.match(receipt, /TC-001/u, '旧环境那条必须被点名')
  assert.equal(receipt.includes('TC-002'), false, '与新环境一致的证据不得被报成过期（不许一刀切）')
  assert.equal(receipt.includes('TC-003'), false, '没记环境的证据归 unrecorded，不得混进"因登记而过期"')
  assert.match(receipt, /sdo_test action=record/u, '必须给可执行的补做命令')
  assert.match(receipt, /env=/u, '补做命令必须带新环境串（否则补做了还是过期）')

  // **反例**：再登记**同一个**环境 ⇒ 影响面为 0（不虚报）
  const same = await callTest({ action: 'env', env: 'jdk=21', reason: '原样再登记一次' })
  assert.match(same, /影响面：\*\*0 条\*\*/u, `同一环境不得虚报影响面：${same.slice(0, 300)}`)
})

test('M166-03（① 的"只报新过期"）登记前就已过期的证据不得被算成"因这次登记而过期"', async () => {
  passResult('TC-001', 'jdk=17')
  // 先登记 jdk=21 ⇒ TC-OLD 第 1 次变成过期（这一次的"因登记而新过期"就是它）
  const first = await callTest({ action: 'env', env: 'jdk=21' })
  assert.match(first, /TC-001/u, '第一次登记时它是"新过期"的')
  // 再换到 jdk=22 ⇒ 回执里**不该**再出现"因这次登记而新过期"的 TC-OLD（它本来就过期了）
  passResult('TC-004', 'jdk=21')
  const second = await callTest({ action: 'env', env: 'jdk=22' })
  assert.match(second, /影响面[^\n]*1 条/u, `第二次登记只应新增 TC-FRESH 这一条：${second.slice(0, 400)}`)
  assert.equal(second.includes('TC-001'), false, '登记前就已过期的证据不得被反复计入影响面（虚报）')
  assert.match(second, /TC-004/u, '新变成过期的必须点名')

  // 零破坏：`noteEnvironment` 的返回仍含既有两位（工具面旧口径未变）
  const outcome = office.noteEnvironment(call, { env: 'jdk=23' })
  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.equal(outcome.env, 'jdk=23', '返回仍含 env')
    assert.equal(typeof outcome.at, 'string', '返回仍含 at')
    assert.equal(outcome.previousEnv, 'jdk=22', '顺带如实回报"登记前是什么"')
  }
})
