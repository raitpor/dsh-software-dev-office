import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { JOURNAL_FILE, Journal, PROJECT_FILE } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import type { SdoProject } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../node_modules/.sdo-test/journal/', import.meta.url))

let store: SdoStore
let journal: Journal

function makeProject(): SdoProject {
  return {
    id: 'PRJ-001',
    name: '示例项目',
    created: '2026-09-29T00:00:00.000Z',
    process: 'waterfall',
    phase: 'intake',
    phaseHistory: [],
    scope: { in: ['需求审讯'], out: ['运维'] },
    stakeholders: [{ id: 'STK-01', role: '产品负责人', concerns: [] }],
    glossary: { 需求审讯: '结构化质询直到需求无歧义' },
    metrics: { success: ['需求一次通过率 ≥ 80%'], guardrail: [] },
  }
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  store = new SdoStore(join(ROOT, '.sdo'))
  store.ensureLayout()
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

test('追加事件：seq 单调递增并落盘为 JSONL', () => {
  const first = journal.append('project/created', { project: makeProject() })
  const second = journal.append('phase/entered', { phase: 'requirements', gate: 'G1' })
  assert.equal(first.seq, 1)
  assert.equal(second.seq, 2)

  const text = store.readText(JOURNAL_FILE) ?? ''
  assert.equal(text.split('\n').filter((l) => l !== '').length, 2)
  assert.equal(store.modeOf(JOURNAL_FILE), 0o600)
})

test('投影折叠：创建 → 阶段进入/退出 → 红队开关（会话内）', () => {
  journal.append('project/created', { project: makeProject() })
  journal.append('phase/entered', { phase: 'requirements', gate: 'G1' })
  journal.append('redteam/mode', { enabled: false, reason: '用户要求停用' })
  journal.append('phase/exited', { phase: 'requirements', result: 'passed', gate: 'G2' })

  const { project } = journal.loadProject()
  assert.ok(project !== undefined)
  assert.equal(project.phase, 'requirements')
  assert.equal(project.phaseHistory.length, 1)
  assert.equal(project.phaseHistory[0]?.exited !== undefined, true)
  assert.deepEqual(project.redTeam, { enabled: false, scope: 'session', at: project.redTeam?.at, reason: '用户要求停用' })
})

test('AC-006 / E2E-06：删掉 project.json 后能从 journal 重建', () => {
  journal.append('project/created', { project: makeProject() })
  journal.append('phase/entered', { phase: 'feasibility', gate: 'G1' })

  const first = journal.loadProject()
  assert.equal(first.rebuilt, false, 'append 时已把投影物化（派生视图跟随真源）')
  assert.equal(first.project?.phase, 'feasibility')
  assert.ok(store.exists(PROJECT_FILE), '重建后应落盘')
  assert.equal(store.modeOf(PROJECT_FILE), 0o600)

  const cached = journal.loadProject()
  assert.equal(cached.rebuilt, false, '已有投影时不应重复重建')

  store.remove(PROJECT_FILE)
  assert.equal(store.exists(PROJECT_FILE), false)

  const rebuilt = journal.loadProject()
  assert.equal(rebuilt.rebuilt, true, '投影被删除后应重建')
  assert.equal(rebuilt.project?.phase, 'feasibility')
  assert.deepEqual(rebuilt.project, cached.project, '重建结果必须与投影一致')
})

test('损坏尾部：截断到最后一个完整事件，不把半截记录当事实', () => {
  journal.append('project/created', { project: makeProject() })
  store.appendLine([JOURNAL_FILE], '{"seq":2,"at":"2026-09-29T00:01:00.000Z","actor":"sdo","type":"phase/entered"')

  const read = journal.read()
  assert.equal(read.truncated, true)
  assert.equal(read.badLine, 2)
  assert.equal(read.events.length, 1)

  const { project } = journal.loadProject()
  assert.equal(project?.phase, 'intake', '只认最后一个一致前缀')
})

test('序号不连续也视为损坏（不静默接受不一致的真源）', () => {
  store.writeText([JOURNAL_FILE], [
    JSON.stringify({ seq: 1, at: '2026-09-29T00:00:00.000Z', actor: 'sdo', type: 'project/created', data: { project: makeProject() } }),
    JSON.stringify({ seq: 5, at: '2026-09-29T00:00:01.000Z', actor: 'sdo', type: 'phase/entered', data: { phase: 'intake' } }),
  ].join('\n'))
  const read = journal.read()
  assert.equal(read.truncated, true)
  assert.equal(read.events.length, 1)
})

test('无 journal 时：没有项目、且不报错', () => {
  const read = journal.read()
  assert.deepEqual(read, { events: [], truncated: false })
  const loaded = journal.loadProject()
  assert.equal(loaded.project, undefined)
  assert.equal(loaded.rebuilt, false)
})

test('rebuild 与 loadProject 结果一致（纯折叠）', () => {
  journal.append('project/created', { project: makeProject() })
  journal.append('phase/entered', { phase: 'requirements' })
  const viaRebuild = journal.rebuild().project
  const viaLoad = journal.loadProject().project
  assert.deepEqual(viaRebuild, viaLoad)
  writeFileSync(join(store.root, 'noop.txt'), '', { mode: 0o600 })
})
