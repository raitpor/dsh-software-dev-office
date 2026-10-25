/** probe */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { reuseSkippedLines } from '../src/domain/pool.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm232')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'session-0000m232-0000-4000-8000-00000000232a'

test('probe real-account receipt size', async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  cpSync(join(ROOT, '.sdo'), join(WORKSPACE, '.sdo'), { recursive: true })
  assert.ok(existsSync(join(WORKSPACE, '.sdo', 'journal.jsonl')))
  // 让「本轮真的会派发」（现盘 4 张 in-progress 卡把全局预算占满 ⇒ 回执走"没有派发"那支，
  // 根本到不了 reuseSkipped 的渲染面）—— 只在**副本**里把它们置为 done。
  const tasksDir = join(WORKSPACE, '.sdo', 'tasks')
  let flipped = 0
  for (const name of readdirSync(tasksDir)) {
    const path = join(tasksDir, name)
    const text = readFileSync(path, 'utf8')
    if (!text.includes('status: in-progress')) continue
    writeFileSync(path, text.replace(/status: in-progress/u, 'status: done'))
    flipped += 1
  }
  console.log('[probe] flipped in-progress cards', flipped)
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: SESSION, cwd: WORKSPACE } as unknown as OfficeCall
  office.noteSession(SESSION, WORKSPACE)
  const tools: { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[] = []
  const services: Record<string, unknown> = {}
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
  services['tools'] = { register: (tool: unknown) => { tools.push(tool as (typeof tools)[number]); return () => {} } }
  services['subagents'] = {
    list: () => ['spawn'],
    start: async () => ({ id: 'child-oneshot-m232' }),
    startContinuable: async () => ({ childId: 'child-fresh-m232' }),
    sendMessage: async () => ({ messageId: 'msg-m232' }),
    getProvider: () => ({ capabilities: { toolFilter: true } }),
    listDescendants: async () => [],
  }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const plan = office.poolPlan(call, { reuseIdle: true })
  console.log('[probe] ready tasks in plan', plan.dispatch.length + plan.queued.length)
  console.log('[probe] reuseSkipped rows', plan.reuseSkipped.length)
  const perRole = new Map<string, number>()
  for (const row of plan.reuseSkipped) perRole.set(row.role, (perRole.get(row.role) ?? 0) + 1)
  console.log('[probe] rows per role', JSON.stringify([...perRole.entries()]))
  const reasons = new Map<string, number>()
  for (const row of plan.reuseSkipped) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1)
  console.log('[probe] distinct reasons', reasons.size)
  for (const [reason, count] of reasons) console.log('[probe]   reason len', reason.length, 'x', count, JSON.stringify(reason.slice(0, 90)))
  const multi = reuseSkippedLines(plan.reuseSkipped).join('\n')
  const single = reuseSkippedLines(plan.reuseSkipped).join('；')
  console.log('[probe] multiline block chars', multi.length, '/ single-line chars', single.length)
  const tool = tools.find((item) => item.name === 'sdo_plan')
  assert.ok(tool !== undefined)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const runner = async (args: Record<string, unknown>): Promise<string> => {
    const filtered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
    const agentStub = { id: SESSION, session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } }
    return String(await tool.execute(filtered, { agent: agentStub }))
  }
  const receipt = await runner({ action: 'next', limit: 1 })
  console.log('[probe] receipt len', receipt.length, 'orig', /原文 (\d+) 字符/u.exec(receipt)?.[1] ?? receipt.length)
  console.log('[probe] receipt head 600:', JSON.stringify(receipt.slice(0, 600)))
  console.log('[probe] chars 7900-8100:', JSON.stringify(receipt.slice(7900, 8100)))
  console.log('[probe] childSessionId occurrences', (receipt.match(/childSessionId=/gu) ?? []).length)
  const why = await runner({ action: 'next', limit: 1, why: true })
  console.log('[probe] why len', why.length)
  const fresh = await runner({ action: 'next', limit: 1, freshChild: true })
  const origLen = (text: string): number => {
    const match = /原文 (\d+) 字符/u.exec(text)
    return match === null ? text.length : Number(match[1])
  }
  console.log('[probe] freshChild receipt len', fresh.length, 'orig', origLen(fresh))
  for (const marker of ['没有被复用', '未复用的候选与原因', 'reuseIdle=']) {
    console.log('[probe] marker', marker, 'idx in fresh', fresh.indexOf(marker), 'idx in default', receipt.indexOf(marker))
  }
  const started = office.journalFor(WORKSPACE).read().events.filter((row) => row.type === 'dispatch/started')
  console.log('[probe] last started reused=', String(started.at(-1)?.data['reused']), 'skippedRows=', JSON.stringify((started.at(-1)?.data['reuseSkipped'] as unknown[] | undefined)?.length))
})
