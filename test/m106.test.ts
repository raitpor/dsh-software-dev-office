/**
 * M106: homogeneous decoupling between the ledgers and the task card (TASK-080 / DEF-051 / criterion `C-64`).
 *
 * ## The three gaps (DEF-051, same family as DEF-050)
 * A full-source audit found three places where a ledger is **write-only / never looked at again**:
 *   1. **The risk ledger never goes backwards.** All 7 risks read back as `open`, and the `risks.*`
 *      checks only exist in the spiral process, so **no criterion looks at a risk after the card
 *      that was supposed to remove it is finished** — and there was no link field between a card
 *      and a risk at all.
 *   2. **The card-level `inputs` / `outputs` are not judged.** They are read and dispatched
 *      (`integration/orchestrator.ts` renders them into the dispatch prompt), but **no criterion
 *      ever checks them** — a reader would assume a card's declaration had been verified.
 *   3. **A `small` card's review has no exit.** `C-42` (`review.required`) only covers
 *      `size >= medium`; the `done` receipt never shows the card's review state.
 *
 * ## The shape of the fix
 *   · `TaskCard.mitigates?: string[]` + `TaskCard.mitigatesWaiver?: Array<{id, waiveReason, waiveApprovedBy}>`
 *     (the two waiver keys are reused verbatim from the DEF-038 basis — no new concept);
 *   · criterion `C-64` (`details.mitigates-closed`, on waterfall/prototype/spiral **G5** and agile **G6**);
 *   · `ReportResult.reviewEcho?: string[]` in the `done` receipt (positive-only echo; it must never
 *     turn a red case green, and must never touch a card that has no review record at all).
 *
 * ## Assertion surface of this file
 *
 * | # | situation | expected |
 * |---|---|---|
 * | 01 | card `done` + `mitigates` a risk that is still `open`, no waiver | **red**, naming card id + risk id + current status |
 * | 02 | that risk is `mitigated` | green |
 * | 03 | risk still `open` but the card carries a waiver with both fields filled | green |
 * | 03b | waiver present but missing `waiveApprovedBy` | red, naming the missing field |
 * | 04 | the card is **not** `done`/`verified` (risk still open) | **not participating** (no false positive) |
 * | 04b | no card declares `mitigates` (the shape of the whole existing database) | `na` |
 * | 05 | card declares `mitigates`, the risk id is not in the ledger at all | red (declaration pinned to air) |
 * | 06 | passing run still prints the **open risk list** (visible = constraining) | green + the open risk id in the detail |
 * | 07 | `done` card declares `outputs` that no `artifact` evidence covers | **red**, naming card id + the declared item |
 * | 08 | the same declaration is covered by an `artifact` evidence item | green |
 * | 08b | same, via `inputs` | green / red by the same rule |
 * | 09 | card declares neither `inputs` nor `outputs` | not participating |
 * | 10 | `small` card with an adopted `pass` review | green + the review echoed by id in the receipt |
 * | 11 | `small` card with a `changes-requested` review carrying findings | blocked at `done`, receipt names the review id and the blocking state |
 * | 12 | the criterion id `C-64` is claimed exactly by the four process files | zero reuse |
 * | 13 | `sdo_task` parameters carry `mitigates` / `mitigatesWaiver` (JSON **text**) | present, or the value is silently dropped |
 *
 * ## Three disciplines
 *   ① **The criterion goes through the real wiring**: the assertions target
 *      `CHECKERS['details.mitigates-closed']` and the really-registered `sdo_task` tool — never a
 *      private copy of the rule (otherwise the criterion could change and these cases would stay green).
 *   ② **Red assertions name things**: `ok === false` alone would merge "the criterion never ran" with
 *      "the criterion judged red"; every red case pins the concrete ids (`TASK-…` / `RISK-…` / the
 *      declared item) and the language-pack text.
 *   ③ **Wording comes from the language pack**: `gates.ts` is pinned at zero hardcoded CJK by the m7
 *      ratchet, so this file samples the same keys and compares — it does not bake prose into assertions.
 *
 * Two-sided evidence: the red side was produced with this file against the pre-fix tree; the mutation
 * copies live under `node_modules/.sdo-test/m106-mutation/` (never `/tmp`, and never `git stash` —
 * the working tree carries uncommitted work from sibling cards).
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { CHECKERS } from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import { loadProcess } from '../src/domain/process.js'
import { createTask, listTasks, writeTask } from '../src/domain/plan.js'
import { report as reportTask } from '../src/domain/collab.js'
import { Journal } from '../src/infra/journal.js'
import { loadPackagedYaml } from '../src/infra/data.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import type { EvidenceItem, TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm106')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'm106-session'
const OWNER = 'm106-owner'
const CHECK = 'details.mitigates-closed'

type Pack = Record<string, Record<string, string>>

interface RegisteredTool {
  name: string
  parameters?: { type?: string; properties?: Record<string, { type?: string; description?: string }> }
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

interface Harness {
  tool: (name: string) => RegisteredTool
  exec: () => unknown
  fire: (event: string, payload: unknown) => void
}

let harness: Harness

/** One **real assembly**: the definitions `apply()` registers with the host tool table. */
function makeHarness(): Harness {
  const listeners = new Map<string, (payload: never) => void>()
  const registered = new Map<string, RegisteredTool>()
  const services: Record<string, unknown> = {
    tools: { register: (tool: RegisteredTool) => registered.set(tool.name, tool) },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (event: string, listener: never) => { listeners.set(event, listener); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  const tool = (name: string): RegisteredTool => {
    const found = registered.get(name)
    if (found === undefined) throw new Error(`the real assembly did not register ${name} (registry holds: ${[...registered.keys()].join(', ')})`)
    return found
  }
  return {
    tool,
    exec: () => ({ name: 'sdo_task', arguments: {}, agent: { session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } } }),
    fire: (event, payload) => listeners.get(event)?.(payload as never),
  }
}

function store(): SdoStore {
  return new SdoStore(join(WORKSPACE, '.sdo'))
}

function journal(): Journal {
  return new Journal(store())
}

/** The **real wiring of the criterion** (the registered one — not a private copy of the rule). */
function c64(): { ok: boolean; na: boolean; detail: string; remedy: string } {
  const checker = CHECKERS[CHECK]
  assert.equal(typeof checker, 'function', `${CHECK} must be registered in CHECKERS (that registration is C-64's anchor)`)
  if (checker === undefined) throw new Error(`${CHECK} is not registered`)
  const ctx = { workspace: WORKSPACE, store: store(), journal: journal(), requirements: [] } as unknown as GateContext
  const verdict = checker(ctx)
  return {
    ok: verdict.ok === true,
    na: verdict.na === true,
    detail: verdict.detail ?? '',
    remedy: verdict.remedy ?? '',
  }
}

/** Language-pack prose (criterion wording always lives there; assertions never hardcode it). */
function packs(): { zh: Pack; en: Pack } {
  return {
    zh: loadPackagedYaml<Pack>('src/data/lang/zh-CN.yml'),
    en: loadPackagedYaml<Pack>('src/data/lang/en.yml'),
  }
}

/** The **Chinese原文** of `section.key` (empty string when only the key falls back). */
function zhText(key: string): string {
  const [section, ...rest] = key.split('.')
  const value = (packs().zh[section ?? ''] ?? {})[rest.join('.')]
  return value === undefined || value === rest.join('.') ? '' : value
}

/** Static prefix of a template (the text before its first placeholder). */
function head(key: string): string {
  return zhText(key).split('{p1}')[0] ?? ''
}

/** Fixture card: only the fields this criterion cares about are pinned. */
function card(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes: ['src/m106-fixture/'],
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'done',
    requirements: [],
    fixes: [],
    mitigates: [],
    mitigatesWaiver: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

/** Persist a card through the real writer, then read it back through the real reader. */
function seedCard(source: TaskCard): TaskCard {
  writeTask(store(), source)
  const read = listTasks(store()).find((item) => item.id === source.id)
  assert.ok(read !== undefined, `${source.id} did not survive writeTask/listTasks`)
  return read
}

/**
 * Remove a card file outright.
 *
 * Why a test needs this: the criterion is a **gate** criterion - it sweeps every finished card in the
 * workspace, not just the one a case is about. When a case's first half is meant to be red and its
 * second half green, the red card has to leave the workspace, otherwise the green verdict stays red
 * because of the leftover (and the failure detail would name the *other* card, which reads as a bug
 * in the criterion when it is the criterion working as designed).
 */
function dropCard(id: string): void {
  rmSync(join(WORKSPACE, '.sdo', 'tasks', `${id}.yml`), { force: true })
}

/** A risk row in the real ledger shape (`RiskItem`). */
function seedRisk(id: string, status: string): void {
  store().writeYaml(['risks', `${id}.yml`], {
    risk: {
      id,
      title: `sample ${id}`,
      level: 'high',
      probability: 'high',
      impact: 'i',
      mitigation: 'm',
      owner: 'o',
      status,
      at: '2026-10-13T00:00:00.000Z',
    },
  })
}

function evidence(kind: EvidenceItem['kind'], detail: string): EvidenceItem {
  return { kind, detail, at: '2026-10-13T00:00:00.000Z' }
}

/** Record a review through the real writer (which also emits `review/recorded`). */
function seedReview(id: string, taskId: string, verdict: 'pass' | 'changes-requested', findings: string[]): void {
  store().writeYaml(['reviews', `${id}.yml`], {
    review: { id, taskId, reviewer: 'm106-reviewer', verdict, findings, at: '2026-10-13T00:00:00.000Z' },
  })
  journal().append('review/recorded', { id, taskId, verdict, findings: findings.length, contentHash: '' })
}

beforeEach(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  harness = makeHarness()
  harness.fire('session/created', { id: SESSION, header: { cwd: WORKSPACE } })
  const receipt = await harness.tool('sdo_init').execute(
    { name: 'M106 fixture', process: 'waterfall', scale: 'normal', stakeholders: 'approver,executor' },
    harness.exec(),
  )
  assert.match(String(receipt), /PRJ-001/u, `fixture init failed: ${String(receipt)}`)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// ————————————— Group 0: the declaration channel must exist (one missing slot = silently dropped) —————————————

test('M106-00 sdo_task parameters carry mitigates / mitigatesWaiver as JSON text (knowledge base tq_ff348198)', () => {
  const schema = harness.tool('sdo_task').parameters
  assert.ok(schema !== undefined, 'the registered sdo_task must carry parameters')
  assert.equal(schema.type, 'object', 'the sdo_task parameter surface must be an object schema')
  const properties = schema.properties
  assert.ok(properties !== undefined, 'the sdo_task parameter surface must have properties')
  const mitigates = properties.mitigates
  assert.ok(mitigates !== undefined, 'no `mitigates` on the tool boundary: the declaration can never enter from the model side')
  // **DEF-073 (2026-10-14)**: widened from JSON-text-only to **both shapes** (`oneOf: [string, array]`
  // plus the existing `compositeArg` normalisation). The old "not an array" wording WAS the defect:
  // a model passing an array was rejected by the host schema before the plugin ever saw the call.
  // Loose read on purpose: this file is also compiled against the **frozen pre-fix types** by
  // `test/task001-red-baseline`; writing `mitigates.oneOf` directly fails to compile there.
  const mitigatesShape = mitigates as { oneOf?: { type?: string }[] }
  assert.ok(mitigatesShape.oneOf !== undefined, 'mitigates must accept both shapes (string | array) or arrays get rejected by the host schema')
  const shapes = (mitigatesShape.oneOf ?? []).map((item) => item.type).sort()
  assert.deepEqual(shapes, ['array', 'string'], 'both shapes must be declared')
  assert.match(mitigates.description ?? '', /RISK-/u, `the description must name the id shape: ${mitigates.description ?? ''}`)
  assert.match(mitigates.description ?? '', /C-64/u, `the description must name the consuming criterion: ${mitigates.description ?? ''}`)
  const waiver = properties.mitigatesWaiver
  assert.ok(waiver !== undefined, 'no `mitigatesWaiver`: the explicit still-open reason has no entry point')
  // **DEF-073**: same widening as `mitigates` above — both shapes are accepted (JSON text and a real array).
  const waiverShape = waiver as { oneOf?: { type?: string }[] }
  assert.ok(waiverShape.oneOf !== undefined, 'mitigatesWaiver must accept both shapes (string | array)')
  const waiverShapes = (waiverShape.oneOf ?? []).map((item) => item.type).sort()
  assert.deepEqual(waiverShapes, ['array', 'string'], 'both shapes must be declared for mitigatesWaiver')
  assert.match(waiver.description ?? '', /waiveReason/u, `the description must name the two reused waiver keys: ${waiver.description ?? ''}`)
  // Counter-sample (guards against a vacuously-true assertion)
  assert.equal(properties.noSuchMitigatesField, undefined, 'a non-existent parameter name must not resolve')
})

// ————————————— Group 1: the risk ledger must go backwards —————————————

test('M106-01 card done + risk still open with no waiver => red, naming card id + risk id + current status', () => {
  seedRisk('RISK-901', 'open')
  seedCard(card('TASK-901', { mitigates: ['RISK-901'] }))

  const verdict = c64()
  assert.equal(verdict.ok, false, 'the card says the risk is handled while the ledger says open => must be red')
  assert.match(verdict.detail, /TASK-901/u, `the red detail must name the card: ${verdict.detail}`)
  assert.match(verdict.detail, /RISK-901/u, `the red detail must name the risk: ${verdict.detail}`)
  assert.match(verdict.detail, /open/u, `the red detail must give the current status: ${verdict.detail}`)
  assert.ok(verdict.detail.includes(head('uiGates.kMitigatesRowOpen')), `the red wording must come from the language pack: ${verdict.detail}`)
  assert.match(verdict.remedy, /RISK-901|sdo_risk/u, `the remedy must be executable: ${verdict.remedy}`)
})

test('M106-02 the same risk is mitigated => green (and the open-risk checklist is not a red by itself)', () => {
  seedRisk('RISK-902', 'mitigated')
  seedCard(card('TASK-902', { mitigates: ['RISK-902'] }))

  const verdict = c64()
  assert.equal(verdict.ok, true, `a mitigated risk must not be red: ${verdict.detail}`)
  assert.notEqual(verdict.na, true, 'the card did declare mitigates, so the criterion is applicable')
})

test('M106-03 risk still open but the card carries an explicit waiver with both fields => green', () => {
  seedRisk('RISK-903', 'open')
  seedCard(card('TASK-903', {
    mitigates: ['RISK-903'],
    mitigatesWaiver: [{ id: 'RISK-903', waiveReason: 'r', waiveApprovedBy: 'a' }],
  }))

  const verdict = c64()
  assert.equal(verdict.ok, true, `a fully signed waiver must be green: ${verdict.detail}`)
})

test('M106-03b waiver missing waiveApprovedBy => red, naming the missing field', () => {
  seedRisk('RISK-904', 'open')
  seedCard(card('TASK-904', {
    mitigates: ['RISK-904'],
    mitigatesWaiver: [{ id: 'RISK-904', waiveReason: 'r', waiveApprovedBy: '' }],
  }))

  const verdict = c64()
  assert.equal(verdict.ok, false, 'a waiver without a signer is not a waiver (same basis as DEF-038)')
  assert.match(verdict.detail, /TASK-904/u, `must name the card: ${verdict.detail}`)
  assert.match(verdict.detail, /RISK-904/u, `must name the risk: ${verdict.detail}`)
  assert.ok(verdict.detail.includes(zhText('uiGates.kMitigatesWaiveFieldApprover')), `must name the missing key: ${verdict.detail}`)
})

test('M106-04 a card that is not done/verified does not participate (no false positive)', () => {
  seedRisk('RISK-905', 'open')
  seedCard(card('TASK-905', { status: 'in-progress', mitigates: ['RISK-905'] }))

  const verdict = c64()
  assert.equal(verdict.na, true, `an unfinished card must not be judged: ${verdict.detail}`)
  assert.equal(verdict.ok, false, 'na is not "passed": an inapplicable criterion stays out of the pass count')
})

test('M106-04b no card declares mitigates (the shape of the whole existing ledger) => na', () => {
  seedRisk('RISK-906', 'open')
  seedCard(card('TASK-906'))

  const verdict = c64()
  assert.equal(verdict.na, true, `with nothing declared the criterion is not applicable: ${verdict.detail}`)
})

test('M106-05 a declared risk id that is not in the ledger => red (the declaration is pinned to air)', () => {
  seedRisk('RISK-907', 'open')
  seedCard(card('TASK-907', { mitigates: ['RISK-990'] }))

  const verdict = c64()
  assert.equal(verdict.ok, false, 'a missing risk id must be red, never silently skipped')
  assert.match(verdict.detail, /RISK-990/u, `must name the unknown id: ${verdict.detail}`)
})

test('M106-06 a passing run still prints the open risk list (visible = constraining)', () => {
  seedRisk('RISK-908', 'open')
  seedRisk('RISK-909', 'mitigated')
  seedCard(card('TASK-908', { mitigates: ['RISK-909'] }))

  const verdict = c64()
  assert.equal(verdict.ok, true, `the declared risk is mitigated, so green: ${verdict.detail}`)
  // **open 清单按台账现读**（不按声明过滤）：这样"卡声明之外的、还开着的风险"才看得见 ——
  // 本缺陷的成因正是"没人回头看风险台账"。
  assert.match(verdict.detail, /RISK-908/u, `the open risk must be listed even when green: ${verdict.detail}`)
  assert.doesNotMatch(verdict.detail, /RISK-909/u, `a mitigated risk must not be listed as open: ${verdict.detail}`)
})

// ————————————— Group 2: card-level inputs/outputs are now judged —————————————

test('M106-07 a declared output with no artifact evidence => red, naming card id + the declared item', () => {
  seedCard(card('TASK-920', { outputs: ['src/m106-fixture/out.js'] }))

  const verdict = c64()
  assert.equal(verdict.ok, false, 'a declared output that was never published must be red')
  assert.match(verdict.detail, /TASK-920/u, `must name the card: ${verdict.detail}`)
  assert.match(verdict.detail, /src\/m106-fixture\/out\.js/u, `must name the declared item: ${verdict.detail}`)
  assert.ok(verdict.detail.includes(head('uiGates.kDeclaredItemMissing')), `wording from the language pack: ${verdict.detail}`)
})

test('M106-08 the same declaration is covered by an artifact evidence item => green', () => {
  seedCard(card('TASK-921', {
    outputs: ['src/m106-fixture/out.js'],
    evidence: [evidence('command', 'npm test'), evidence('artifact', 'src/m106-fixture/out.js sha256=deadbeef')],
  }))

  const verdict = c64()
  assert.equal(verdict.ok, true, `a published output must be green: ${verdict.detail}`)
})

test('M106-08b inputs follow the same rule (both halves of the declaration are judged)', () => {
  seedCard(card('TASK-922', { inputs: ['docs/m106-in.md'] }))
  const red = c64()
  assert.equal(red.ok, false, 'a declared input absent from the evidence must be red')
  assert.match(red.detail, /docs\/m106-in\.md/u, `must name the input: ${red.detail}`)

  // 判据是**门禁判据**：它扫全库所有完成卡，所以红侧那张必须先离场，否则绿侧会被它拖红
  // （那种"绿侧仍红、详情却点名另一张卡"的读数正是判据按设计工作的样子，不是它坏了）。
  dropCard('TASK-922')
  seedCard(card('TASK-923', {
    inputs: ['docs/m106-in.md'],
    evidence: [evidence('artifact', './docs/m106-in.md sha256=deadbeef')],
  }))
  const green = c64()
  assert.equal(green.ok, true, `the normalized path must match (leading ./): ${green.detail}`)
})

test('M106-09 a card declaring neither inputs nor outputs does not participate', () => {
  seedCard(card('TASK-924'))
  const verdict = c64()
  assert.equal(verdict.na, true, `nothing declared => not applicable: ${verdict.detail}`)
})

// ————————————— Group 3: a small card's review now has an exit (echo, not interception) —————————————

test('M106-10 small card + pass review => done succeeds and the receipt echoes the review id', () => {
  seedCard(card('TASK-930', { status: 'in-progress', owner: OWNER }))
  seedReview('REV-930', 'TASK-930', 'pass', [])

  const result = reportTask(store(), journal(), {
    taskId: 'TASK-930',
    owner: OWNER,
    status: 'done',
    evidence: [evidence('command', 'npm test')],
  })
  assert.equal(result.ok, true, `a pass review must not block a small card: ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  const echo = (result.reviewEcho ?? []).join('\n')
  assert.match(echo, /REV-930/u, `the echo must name the review id: ${echo}`)
  assert.match(echo, /pass/u, `the echo must name the verdict: ${echo}`)
})

test('M106-11 small card + changes-requested review with findings => done blocked, receipt names the review id and the state', () => {
  seedCard(card('TASK-931', { status: 'in-progress', owner: OWNER }))
  seedReview('REV-931', 'TASK-931', 'changes-requested', ['finding one'])

  const result = reportTask(store(), journal(), {
    taskId: 'TASK-931',
    owner: OWNER,
    status: 'done',
    evidence: [evidence('command', 'npm test')],
  })
  assert.equal(result.ok, false, `a small card with an undigested changes-requested review must be blocked: ${JSON.stringify(result)}`)
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.code, 'review-open-findings', `the refusal must name the review path: ${result.code}`)
  assert.match(result.detail, /REV-931/u, `the refusal must name the review: ${result.detail}`)
  assert.match(result.detail, /changes-requested/u, `the refusal must name the verdict: ${result.detail}`)
})

test('M106-11b a card with no review record at all gets no echo (no collateral damage on small cards)', () => {
  seedCard(card('TASK-932', { status: 'in-progress', owner: OWNER }))

  const result = reportTask(store(), journal(), {
    taskId: 'TASK-932',
    owner: OWNER,
    status: 'done',
    evidence: [evidence('command', 'npm test')],
  })
  assert.equal(result.ok, true, `a card without reviews must finish normally: ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.reviewEcho, undefined, 'no review record => nothing echoed (positive-only echo)')
})

// ————————————— Group 4: anchors in the process definitions and the language packs —————————————

test('M106-12 C-64 is claimed by exactly four process files (zero reuse of the id)', () => {
  const files = ['waterfall', 'agile', 'prototype', 'spiral'].map((process) => `${process}.yml`)
  const processes = ['waterfall', 'agile', 'prototype', 'spiral']
  const seen: Array<[string, string, string]> = []
  for (const process of processes) {
    const definition = loadProcess(process)
    assert.ok(definition !== undefined, `process ${process} must load`)
    for (const gate of definition.gates) {
      for (const criterion of gate.criteria) {
        if (criterion.id === 'C-64') seen.push([`${process}.yml`, gate.id, criterion.check])
      }
    }
  }
  assert.deepEqual(
    seen.map((item) => item[1]),
    ['G5', 'G6', 'G5', 'G5'],
    `C-64 must sit on waterfall G5 / agile G6 / prototype G5 / spiral G5: ${JSON.stringify(seen)}`,
  )
  assert.deepEqual(seen.map((item) => item[0]), files, `C-64 must be claimed once per process, in order: ${JSON.stringify(seen)}`)
  for (const [file, , check] of seen) assert.equal(check, CHECK, `${file} must point at the registered checker`)
})

test('M106-13 the new wording lives in both language packs and the en side carries no CJK', () => {
  const keys = [
    'kMitigatesRowOpen',
    'kMitigatesRowMissing',
    'kMitigatesWaiveIncomplete',
    'kMitigatesWaiveFieldReason',
    'kMitigatesWaiveFieldApprover',
    'kMitigatesRemedy',
    'kMitigatesOpenRisks',
    'kDeclaredItemMissing',
    'kReviewEchoHeading',
    'kReviewEchoRow',
  ]
  const { zh, en } = packs()
  for (const key of keys) {
    assert.ok((zh.uiGates ?? {})[key] !== undefined, `zh-CN is missing uiGates.${key}`)
    assert.ok((en.uiGates ?? {})[key] !== undefined, `en is missing uiGates.${key}`)
    assert.doesNotMatch((en.uiGates ?? {})[key] ?? '', /[\u4e00-\u9fff]/u, `en.uiGates.${key} must not carry CJK`)
  }
})

test('M106-14 both declaration fields survive the real write/read round trip (the read-side whitelist)', () => {
  const read = seedCard(card('TASK-940', {
    mitigates: ['RISK-940'],
    mitigatesWaiver: [{ id: 'RISK-940', waiveReason: 'r', waiveApprovedBy: 'a' }],
  }))
  assert.deepEqual(read.mitigates, ['RISK-940'], 'mitigates was dropped by the read side (plan.ts whitelist)')
  assert.equal(read.mitigatesWaiver?.length, 1, 'mitigatesWaiver was dropped by the read side')
  assert.equal(read.mitigatesWaiver?.[0]?.waiveApprovedBy, 'a', 'the waiver fields must survive verbatim')
})

test('M106-15 createTask carries both fields (the structural/model channel drops nothing)', () => {
  // **注意**：`createTask` 的 id 由 `nextId` 现算（草稿里的标题不参与定号），所以这里断言的是
  // "返回的那张卡带着两个声明、并且真的落盘读得回来"，而不是某个写死的卡号。
  const created = createTask(store(), journal(), {
    title: 'm106-15',
    goal: 'g',
    dod: ['d'],
    role: 'developer',
    mitigates: ['RISK-941'],
    mitigatesWaiver: [{ id: 'RISK-941', waiveReason: 'r', waiveApprovedBy: 'a' }],
  })
  assert.match(created.id, /^TASK-\d+$/u, `createTask must mint a real card id: ${created.id}`)
  const read = listTasks(store()).find((item) => item.id === created.id)
  assert.ok(read !== undefined, `createTask did not persist ${created.id}`)
  assert.deepEqual(read.mitigates, ['RISK-941'], 'createTask dropped mitigates')
  assert.equal(read.mitigatesWaiver?.length, 1, 'createTask dropped mitigatesWaiver')
  assert.equal(read.mitigatesWaiver?.[0]?.waiveReason, 'r', 'the waiver reason must survive createTask')
})
