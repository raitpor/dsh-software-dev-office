/**
 * 2026-10-07 报告里的两条收尾：
 *
 * · **SDO-36 升级为工具层双会话探针**：此前那条回归是**源码级**（只钉住判据文本），语义变异杀不掉它。
 *   这里用**真实注册的工具**（`apply` 后拿 `tools.register` 的定义）从**两个不同会话**各调一次
 *   `sdo_review action=record`：认领会话自评必须被拒、另一会话必须放行。
 * · **SDO-58 结算期报告体检**：真机 `TASK-187` 的报告只有 **235 字节**，事后才被复评员发现。
 *   现在结算之后由 `office.childReportHealth` 量一下，异常短/缺失在 `done` 回执里显式告警。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { CHILD_REPORT_MIN_BYTES } from '../src/domain/dispatchReports.js'
import type { SdoConfig } from '../src/config.js'
import type { Context } from '@deepseek-ai/cordis'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm48')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}

/** 真实装配 + 按 schema 过滤入参；**会话 id 可逐次指定**（SDO-36 的双会话探针需要）。 */
function toolHarness(ws: string): { callTool: (name: string, args: Record<string, unknown>, sessionId: string) => Promise<string> } {
  const registered: ToolDefinition[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition): (() => void) => { registered.push(tool); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  assert.ok(registered.length >= 20, `真实装配应注册全部工具，实际 ${registered.length}`)
  return {
    async callTool(name: string, args: Record<string, unknown>, sessionId: string): Promise<string> {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `工具面缺少 ${name}`)
      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
      const exec = { agent: { id: sessionId, session: { header: { id: sessionId, cwd: ws, delegationDepth: 1 } } } }
      return String(await tool.execute(filtered, exec))
    },
  }
}

function writeCard(id: string, role: string): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: role as TaskCard['role'], size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  new SdoStore(join(BASE, '.sdo')).writeYaml(['tasks', `${id}.yml`], { task })
}

let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-dev', BASE)
  office.noteSession('s-other', BASE)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('SDO-36（工具层双会话）：认领会话自评被拒、另一会话放行 —— 语义变异必须杀掉这条用例', async () => {
  writeCard('TASK-001', 'developer')
  const { callTool } = toolHarness(BASE)

  const claimed = await callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'dev-a', expectedRevision: 1 }, 's-dev')
  assert.match(claimed, /TASK-001/u, `前置：认领要成功（认领会话=s-dev）：${claimed}`)

  // ① 同一会话自评（只是把 reviewer 名字换掉）⇒ 必须被拒
  const self = await callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'subagent:reviewer:2', verdict: 'pass', findings: '["已逐条核对，无发现"]',
  }, 's-dev')
  assert.match(self, /同一会话不得自评/u, `同会话自评必须被拒（真机 REV-031 手法）：${self}`)

  // ② 换**另一个会话** ⇒ 放行（这才是"换人"）
  const other = await callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'subagent:reviewer:2', verdict: 'pass', findings: '["已逐条核对，无发现"]',
  }, 's-other')
  assert.doesNotMatch(other, /同一会话不得自评/u, `另一会话不得被误拒：${other}`)
  assert.match(other, /REV-\d+/u, `另一会话应真的落一条评审：${other}`)
})

test('SDO-58：结算期报告体检 —— 残片/缺失告警，正常报告不吵', () => {
  const call = { sessionId: 's-dev', cwd: BASE }
  // 没结算过 ⇒ none（卡可能是内联做的，不告警）
  assert.equal(office.childReportHealth(call, 'TASK-001').state, 'none')

  // ① 残片报告（真机 235 字节那一类）⇒ short，并给出字节数与落点
  office.noteDispatchFinished(call, {
    childSessionId: 'c-short', task: 'TASK-001', role: 'developer', turn: 1, reason: 'completed',
    startedAt: new Date().toISOString(), report: 'x'.repeat(120),
  })
  const short = office.childReportHealth(call, 'TASK-001')
  assert.equal(short.state, 'short')
  assert.ok((short.bytes ?? 0) < CHILD_REPORT_MIN_BYTES)
  assert.match(short.report ?? '', /child-reports/u, '要给出权威落点（不让人自己拼文件名）')

  // ② 正常报告 ⇒ ok（不吵）
  office.noteDispatchFinished(call, {
    childSessionId: 'c-ok', task: 'TASK-002', role: 'developer', turn: 1, reason: 'completed',
    startedAt: new Date().toISOString(), report: 'y'.repeat(CHILD_REPORT_MIN_BYTES + 50),
  })
  assert.equal(office.childReportHealth(call, 'TASK-002').state, 'ok')

  // ③ 结算记录在、但报告文件被删/读不到 ⇒ missing（审计链缺一环，仍然要说话）
  const health = office.childReportHealth(call, 'TASK-002')
  unlinkSync(join(BASE, '.sdo', ...(health.report ?? '').split('/')))
  assert.equal(office.childReportHealth(call, 'TASK-002').state, 'missing')
})

test('SDO-58（接线）：`done` 回执必须把残片告警带出来', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /office\.childReportHealth\(call, args\.id\)/u, 'done 要调体检')
  assert.match(index, /kChildReportShort/u, '残片要告警')
  assert.match(index, /kChildReportMissing/u, '缺失也要告警')
})

test('SDO-59（工具层）：省略 `status` 的缺陷更正**不得**改变状态；非法状态要可读拒绝', async () => {
  const { callTool } = toolHarness(BASE)
  // 造一条**已关闭**的缺陷，并带上写死的过时前缀（正是真机 DEF-022/023/024 的形状）
  const created = await callTool('sdo_test', { action: 'defect', title: '[open] 标题里写过时前缀', severity: 'minor', status: 'closed' }, 's-dev')
  const defectId = /DEF-\d+/u.exec(created)?.[0] ?? ''
  assert.ok(defectId !== '', `前置：要能建出缺陷：${created}`)

  // ① 只补 `evidence`（**不带** status）⇒ 状态必须**保持不变**（真机在这里被静默重开）
  const patched = await callTool('sdo_test', { action: 'defect', defectId, evidence: '〔更正说明〕' }, 's-dev')
  assert.doesNotMatch(patched, /status: closed -> open/u, `不得把已关闭缺陷重开：${patched}`)
  assert.match(patched, /titleStatusPrefix/u, '但前缀清理要发生（借这次更正清掉）')
  const after = await callTool('sdo_test', { action: 'list' }, 's-dev')
  assert.match(after, /\[minor\/closed\]/u, `状态应仍是 closed：${after}`)

  // ② 非法状态 ⇒ **可读拒绝**（而不是悄悄当成 open）
  const bad = await callTool('sdo_test', { action: 'defect', defectId, status: 'reopened' }, 's-dev')
  assert.match(bad, /取值非法/u, `非法状态必须被拒：${bad}`)
  assert.match(await callTool('sdo_test', { action: 'list' }, 's-dev'), /\[minor\/closed\]/u, '被拒后状态不得变化')
})
