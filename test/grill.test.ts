import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { answerQuestion, askQuestions, listQuestions, loadBank, redTeamQuestions, selectQuestions } from '../src/domain/grill.js'
import { listRequirements } from '../src/domain/requirements.js'
import { loadScoring } from '../src/domain/scoring.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { Requirement } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/grill/', import.meta.url))
const model = loadScoring()

let workspace: string
let store: SdoStore
let journal: Journal
let office: SoftwareDevOffice

const call = (): { sessionId: string } => ({ sessionId: 's1' })

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: '审讯测试', scopeOut: ['运维'], stakeholders: ['业务方'], metricsSuccess: ['识别率 ≥ 99%'] })
  store = office.storeFor(workspace)
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function captureVague(): Requirement {
  const result = office.capture(call(), {
    title: '对账差异检测',
    statement: '系统要尽快识别对账差异',
    rationale: '人工核对太慢',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  return result.requirement
}

test('问题库：16 问，覆盖八个维度，每题都带选项与代价', () => {
  const bank = loadBank()
  assert.equal(bank.length, 16)
  assert.deepEqual([...new Set(bank.map((question) => question.dimension))].sort(), [
    'acceptance',
    'boundary',
    'constraint',
    'data',
    'goal',
    'interface',
    'scenario',
    'user',
  ])
  for (const question of bank) {
    assert.ok(question.options.length >= 2, `${question.id} 至少 2 个选项`)
    assert.ok(question.options.every((option) => option.cost.trim() !== ''), `${question.id} 每个选项都要有代价`)
    assert.ok(question.defaultRecommendation.trim() !== '', `${question.id} 必须有默认建议`)
  }
})

test('提问排序：≤4 问、按 架构影响×不确定性×阻塞程度，且不与已回答重复', () => {
  const requirement = captureVague()
  const selected = selectQuestions({ requirements: [requirement], existing: [], model })
  assert.ok(selected.length > 0 && selected.length <= 4, `批量上限 4，实得 ${selected.length}`)

  const existing = askQuestions(store, journal, office.status(call()).project, {
    requirementIds: [requirement.id],
    includeBanned: true,
  })
  assert.ok(existing.questions.length > 0)
  assert.ok(existing.questions.length <= 4, `批量上限 4（含禁词问题），实得 ${existing.questions.length}`)
  assert.ok(
    existing.questions.some((question) => question.origin === 'banned-word'),
    '禁词问题必须先占坑（P0 硬阻塞）',
  )

  const again = selectQuestions({ requirements: [listRequirements(store)[0] as Requirement], existing: listQuestions(store), model })
  for (const item of again) {
    assert.ok(
      !existing.questions.some((question) => question.why.includes(`#${item.template.id}`)),
      '同一模板不得对同一需求重复提问',
    )
  }
})

test('quick 档：只问 P0', () => {
  const requirement = captureVague()
  const selected = selectQuestions({ requirements: [requirement], existing: [], model, quick: true })
  assert.ok(selected.length > 0)
  assert.ok(selected.every((item) => item.template.severity === 'P0'))
})

test('禁词：capture 后 grill 生成「强制量化」问题（origin=banned-word）', () => {
  const requirement = captureVague()
  const asked = askQuestions(store, journal, office.status(call()).project, {
    requirementIds: [requirement.id],
    includeBanned: true,
  })
  const banned = asked.questions.filter((question) => question.origin === 'banned-word')
  assert.ok(banned.length >= 1, '「尽快」应触发强制量化问题')
  assert.ok(banned[0]?.text.includes('尽快'))
  assert.equal(banned[0]?.severity, 'P0')

  const events = journal.read().events.filter((event) => event.type === 'question/asked')
  assert.ok(events.length >= 1, '问题入账要留痕')
})

test('问题入账会回写需求的未决列表', () => {
  const requirement = captureVague()
  askQuestions(store, journal, office.status(call()).project, { requirementIds: [requirement.id] })
  const refreshed = listRequirements(store)[0]
  assert.ok((refreshed?.ambiguity.open.length ?? 0) > 0)
})

test('回答：answered 与 assumed（采用默认建议并记为假设）', () => {
  const requirement = captureVague()
  const asked = askQuestions(store, journal, office.status(call()).project, { requirementIds: [requirement.id] })
  const question = asked.questions[0]
  assert.ok(question !== undefined)

  const answered = answerQuestion(store, journal, office.status(call()).project, {
    id: question.id,
    answer: 'T+1 批处理',
    pickedOption: 0,
    modelDimensions: { goal: 2, scenario: 2 },
  })
  assert.ok(answered !== undefined)
  assert.equal(answered.question.status, 'answered')
  assert.match(answered.question.answer ?? '', /T\+1 批处理/)
  assert.match(answered.question.answer ?? '', /选择：/)
  assert.equal(answered.updated[0]?.ambiguity.dimensions.goal, 1, '禁词把 goal 压在 1：硬上限优先于模型分')

  const second = asked.questions[1] ?? question
  const assumed = answerQuestion(store, journal, office.status(call()).project, {
    id: second.id,
    answer: '',
    assume: true,
  })
  assert.equal(assumed?.question.status, 'assumed')
  assert.equal(assumed?.question.answer, second.defaultRecommendation)
})

test('红队：七个攻击角度都能落成 P0 问题', () => {
  const requirement = captureVague()
  const angles = redTeamQuestions()
  assert.equal(angles.length, 7)
  const asked = askQuestions(store, journal, office.status(call()).project, {
    requirementIds: [requirement.id],
    includeRedTeam: true,
    limit: 7,
  })
  const redTeam = asked.questions.filter((question) => question.origin === 'red-team')
  assert.equal(redTeam.length, 7)
  assert.ok(redTeam.every((question) => question.severity === 'P0'))
})
