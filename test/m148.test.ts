/**
 * **增量 148：done 回执的产物证据面（DEF-013，§3E 族 3，minor）**。
 *
 * 缺陷原文（三份 re-verify 的现盘读数）：真实工具面 done（note 自述「6 处核实 + 3 条变异」）的回执
 * 只有「卡面 + 证据 2 条 + 未对账告警」——**既没有完整 64 位 sha256、也没有任何条数比对句**；
 * 唯一绑指纹的动作（`auditDoneEvidence` 的现算对账）**只活在拒绝路径上** ⇒ 通过之后什么都不印，
 * 读者无法自己核对"这份产物到底是什么"，只能重新跑一遍工具。
 *
 * **先钉红**（修前 `lib/` 产物上跑，静态可复算）：
 *   ```
 *   lib 里 kArtifactEcho 类键命中 = 0
 *   lib 里 artifactEchoRows / evidenceTally 命中 = 0
 *   lib 里 mtime 命中（index/evidence）= 0 / 0
 *   lib/src/index.js 里 artifactSha256.slice(0, 12) ⇒ 在册（完整 64 位不可见）
 *   ```
 *
 * **修法（只加回显、不动判据 —— §9 定案）**：
 *   ① done 回执对每条 `artifact` 证据回显**现算的完整 64 位 sha256 + 文件 mtime**（读不到就如实标原因，
 *      绝不因此拦下 done；fail-open，与 A2 补记同款）；
 *   ② 「本次自述条数」与「台账累计条数」**并列**印出，差额就**点名**——但**不判红**：自述常写在 `note`
 *      的自然语言里，解析散文等于把判据绑在某种写法上（判据必须语言无关 — 长期约束）；
 *   ③ `deliver action=run` 的绑定回显也由「前 12 位」改为**完整 sha256**（同一族：完整指纹不可见）。
 *
 * ⚠️ **批内反例（必须保住）**：调用方**自己写错哈希**仍由既有的 `evidence-artifact-hash` 拒收
 * （批前 `fb81ff9` 已有）——那不是本条的成果，也不因为多印一行而放宽（M148-04 钉住）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { artifactEchoRows, evidenceTally } from '../src/domain/evidence.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { EvidenceItem, TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m148/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')
const ARTIFACT = 'build/out.txt'

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['artifact'],
    blockedBy: [],
    writeScopes: ['build/'],
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'planned',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function live(task: TaskCard, owner = 'dev'): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${task.id}.yml`], { task })
  const claimed = office.claimTask(call, { taskId: task.id, owner, expectedRevision: 1 })
  assert.equal(claimed.ok, true, `夹具前提：${task.id} 必须认领成功（${JSON.stringify(claimed).slice(0, 120)}）`)
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

/** 现算产物的完整 sha256 与 mtime（与被测实现相互独立 —— 用 node 自己的 crypto/fs 算） */
function truthOf(relativePath: string): { sha256: string; mtime: string } {
  const absolute = join(WORKSPACE, relativePath)
  return {
    sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
    mtime: statSync(absolute).mtime.toISOString(),
  }
}

const evidenceJson = (items: { kind: string; detail: string; exitCode?: number }[]): string =>
  JSON.stringify(items.map((item) => ({ ...item, at: '2026-10-14T00:00:00.000Z' })))

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'build'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M148 产物证据回显', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['done 回执的产物证据面'],
    scopeOut: ['放宽 evidence-artifact-hash'],
    metricsSuccess: ['回执里能自己核对完整指纹与条数'],
    glossary: { 回显: '只印不判' },
  })
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

test('M148-01 正例：done 回执回显**完整 64 位** sha256 与文件 mtime（修前两者都不可见）', async () => {
  writeFileSync(join(WORKSPACE, ARTIFACT), 'artifact body v1\n')
  live(card('TASK-991'))
  const truth = truthOf(ARTIFACT)
  const receipt = await callTool('sdo_task', {
    action: 'done',
    id: 'TASK-991',
    owner: 'dev',
    note: '夹具：一条产物证据',
    evidence: evidenceJson([{ kind: 'artifact', detail: `${ARTIFACT} sha256=${truth.sha256}` }]),
  })
  assert.ok(receipt.includes(truth.sha256), `回执必须回显**完整** 64 位 sha256（修前只有前 12 位）：${receipt.slice(0, 400)}`)
  assert.match(receipt, /[0-9a-f]{64}/u, '回执里必须出现完整的 64 位十六进制指纹')
  assert.ok(receipt.includes(truth.mtime), `必须回显该文件的 mtime（ISO）：${receipt.slice(0, 400)}`)
  assert.match(receipt, /artifact 1/u, '条数对账要把 artifact 条数印出来')
})

test('M148-02 「自述 vs 台账」并列 + 不一致就点名（差额来自更早的回报），但**不判红**', async () => {
  writeFileSync(join(WORKSPACE, ARTIFACT), 'artifact body v2\n')
  live(card('TASK-992', {
    evidence: [
      { kind: 'artifact', detail: `${ARTIFACT} sha256=deadbeef`, at: '2026-10-13T00:00:00.000Z' },
      { kind: 'command', detail: 'node --test（更早那轮）', at: '2026-10-13T00:01:00.000Z', exitCode: 0 },
    ] as EvidenceItem[],
  }))
  const truth = truthOf(ARTIFACT)
  const receipt = await callTool('sdo_task', {
    action: 'done',
    id: 'TASK-992',
    owner: 'dev',
    note: '自述：7 处核实 + 4 条变异',
    evidence: evidenceJson([{ kind: 'artifact', detail: `${ARTIFACT} sha256=${truth.sha256}` }]),
  })
  assert.match(receipt, /自述 1 条/u, `自述条数（本次 1 条）必须印出来：${receipt.slice(0, 500)}`)
  assert.match(receipt, /台账累计 3 条/u, '台账累计条数（1 + 2 条更早）必须并列印出')
  assert.match(receipt, /多 2 条/u, '差额必须点名（2 条来自更早的回报）')
  // 「不判红」：卡确实完成了（回显不是拦截）
  assert.equal(office.taskById(call, 'TASK-992')?.status, 'done', '回显差额不得拦下 done')
  // 而且**没有**把 note 的自然语言解析成数字（口径：散文不解析）
  assert.match(receipt, /不解析/u, '回执应说明它不解析 note 里的自述文字（避免读者误以为它比对了散文）')
})

test('M148-03 域层降级（诚实标原因，不假装有指纹）+ 机械计数不数散文', () => {
  const items: EvidenceItem[] = [
    { kind: 'artifact', detail: 'build/out.txt', at: '' },              // 真实存在
    { kind: 'artifact', detail: '', at: '' },                            // 没给路径
    { kind: 'artifact', detail: 'build/nope.txt', at: '' },             // 不存在
    { kind: 'artifact', detail: '../outside.txt', at: '' },             // 越出工作区
    { kind: 'command', detail: '自述：做了 9 件事（散文不许被当成计数）', at: '' },
  ]
  writeFileSync(join(WORKSPACE, ARTIFACT), 'artifact body v3\n')
  const rows = artifactEchoRows(WORKSPACE, items)
  assert.equal(rows.length, 4, '只回显 artifact 类证据（command 不进这个面）')
  assert.equal(rows[0]?.sha256, truthOf(ARTIFACT).sha256, '存在且在工作区内的产物必须现算出完整指纹')
  assert.equal(rows[0]?.mtime, truthOf(ARTIFACT).mtime, '并且带上 mtime')
  assert.equal(rows[1]?.unreadable, 'no-path', '没给路径 ⇒ 如实标 no-path，不编一个指纹')
  assert.equal(rows[2]?.unreadable, 'missing', '不存在 ⇒ missing')
  assert.equal(rows[3]?.unreadable, 'outside', '越出工作区 ⇒ 不去读它（回显不越权）')
  assert.equal(rows.every((row) => row.sha256 !== undefined || row.unreadable !== undefined), true, '每一行要么有指纹、要么有原因')
  const tally = evidenceTally(items, [...items, ...items])
  assert.deepEqual(
    { selfTotal: tally.selfTotal, selfArtifact: tally.selfArtifact, selfCommand: tally.selfCommand, selfOther: tally.selfOther, ledgerTotal: tally.ledgerTotal, ledgerArtifact: tally.ledgerArtifact },
    { selfTotal: 5, selfArtifact: 4, selfCommand: 1, selfOther: 0, ledgerTotal: 10, ledgerArtifact: 8 },
    '机械计数只看结构化条目 —— 散文里的「9 件事」既不算进自述、也不算进台账',
  )
})

test('M148-04 反例（批内红线）：调用方写错的哈希仍被 `evidence-artifact-hash` 拒，且卡没有 done', async () => {
  writeFileSync(join(WORKSPACE, ARTIFACT), 'artifact body v4\n')
  live(card('TASK-993'))
  const wrong = 'f'.repeat(64)
  const receipt = await callTool('sdo_task', {
    action: 'done',
    id: 'TASK-993',
    owner: 'dev',
    evidence: evidenceJson([{ kind: 'artifact', detail: `${ARTIFACT} sha256=${wrong}` }]),
  })
  assert.match(receipt, /evidence-artifact-hash/u, `自写错哈希必须仍被拒（批前 fb81ff9 的成果，不许放宽）：${receipt.slice(0, 300)}`)
  assert.equal(office.taskById(call, 'TASK-993')?.status !== 'done', true, '被拒的卡不得 done')
})

test('M148-05 同一族的另一半：`deliver action=run` 的绑定回显也回**完整** sha256（不再是前 12 位）', async () => {
  writeFileSync(join(WORKSPACE, ARTIFACT), 'artifact body v5\n')
  const truth = truthOf(ARTIFACT)
  const receipt = await callTool('sdo_deliver', {
    action: 'run',
    target: '真机冒烟',
    command: 'node bin/check.mjs',
    outcome: 'pass',
    artifact: ARTIFACT,
    evidence: 'logs/run-2026-10-14.txt（夹具）',
    by: 'dev',
  })
  assert.ok(receipt.includes(truth.sha256), `run 回执必须给完整哈希（修前是 slice(0,12)）：${receipt.slice(0, 300)}`)
})

test('M148-06 反例：没有 artifact 证据的卡 ⇒ 回执不长出回显块（防"所有回执都拖尾巴"）', async () => {
  live(card('TASK-994', { evidenceRequired: ['command'] }))
  const receipt = await callTool('sdo_task', {
    action: 'done',
    id: 'TASK-994',
    owner: 'dev',
    evidence: evidenceJson([{ kind: 'command', detail: 'node -e 1 → 0', exitCode: 0 }]),
  })
  assert.equal(receipt.includes('产物证据回显'), false, `无产物证据时不得印回显块：${receipt.slice(0, 300)}`)
  assert.equal(office.taskById(call, 'TASK-994')?.status, 'done', '夹具前提：这张卡确实完成了')
})
