/**
 * M108: the card-level `inputs` / `outputs` clause of `C-64` must not judge **prose** declarations
 * red — and must not swallow them either (TASK-106 / DEF-064, converging REV-043 findings 1 + 2).
 *
 * ## The defect (DEF-064, found by REV-043 on TASK-080)
 * `C-64` clause ②/③ compared every declared `inputs` / `outputs` entry against the card's own
 * `artifact` evidence. But the **existing** cards do not declare paths there: TASK-001 declares
 * `inputs: [<the whole DES-031 responsibility text>, <11 REQ ids + "the acceptance criteria">]` and
 * `outputs: [<a capability name>]`, and TASK-007 has the same shape — both `status: done`. A prose
 * sentence can never be contained in a file path, so the criterion produced
 * `kDeclaredItemMissing` rows for cards that were finished long before this field was judged
 * (measured on the real ledger: 6 rows, all for TASK-001 / TASK-007).
 *
 * ## The convergence (what this file pins)
 *   · **Discriminant**: only **path-shaped** declarations take part in the criterion (a `/`, or a
 *     bare `name.ext`). Prose / capability names / id lists do **not** — no data migration.
 *   · **Explicit disposition, echoed in the receipt**: every non-participating declaration is echoed
 *     row by row with the reason, in the receipt of **both** outcomes (green and red). Silently
 *     dropping them would be the same failure mode as the original defect, one level up.
 *   · **The red side does not regress**: a path-shaped declaration that no `artifact` evidence covers
 *     is still red, naming the card and the declared item.
 *
 * ## Assertion surface
 *
 * | # | situation | expected |
 * |---|---|---|
 * | 01 | done card whose `inputs`/`outputs` are prose (the shape of TASK-001/007) | **green** + every declaration echoed with the reason |
 * | 02 | the same card carries a path-shaped declaration nobody covered | **red** for that item only + prose still echoed |
 * | 03 | path-shaped declaration, no `artifact` evidence covers it | **red**, naming card + item (no regression) |
 * | 04 | the same declaration covered by an `artifact` item (with `./` and a `sha256=` suffix) | green |
 * | 05 | bare word (capability name, no separator, no extension) vs bare filename (`out.js`) | word not judged / filename judged |
 * | 06 | done card declaring neither column (and no `mitigates`) | `na`, receipt is exactly the pack text (no echo) |
 * | 07 | the three self-descriptions no longer claim the two columns read empty ledger-wide | no "whole ledger is empty" claim; the shape discriminant is stated |
 *
 * ## Disciplines
 *   ① Every assertion goes through the **registered** `CHECKERS['details.mitigates-closed']` — never
 *      a private copy of the rule (this file deliberately does not import the helper, so it still
 *      loads and goes red on the pre-fix tree).
 *   ② The green half asserts `ok === true`, not "some wording is absent": the criterion fails as soon
 *      as one row is pushed, so `ok` is what proves the prose was **not** judged.
 *   ③ Wording comes from the language pack (`head(...)` / `zhText(...)`), never from this file.
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { CHECKERS } from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import { listTasks, writeTask } from '../src/domain/plan.js'
import { Journal } from '../src/infra/journal.js'
import { loadPackagedYaml } from '../src/infra/data.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import type { EvidenceItem, TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm108')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'm108-session'
const CHECK = 'details.mitigates-closed'

type Pack = Record<string, Record<string, string>>

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

interface Harness {
  tool: (name: string) => RegisteredTool
  exec: () => unknown
  fire: (event: string, payload: unknown) => void
}

let harness: Harness

/** The real assembly (`apply()` registers the tools the host would call). */
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
  return {
    tool: (name) => {
      const found = registered.get(name)
      if (found === undefined) throw new Error(`the real assembly did not register ${name}`)
      return found
    },
    exec: () => ({ name: 'sdo_task', arguments: {}, agent: { session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } } }),
    fire: (event, payload) => listeners.get(event)?.(payload as never),
  }
}

function store(): SdoStore {
  return new SdoStore(join(WORKSPACE, '.sdo'))
}

/** The **registered** criterion (the anchor of `C-64`), never a private copy of the rule. */
function c64(): { ok: boolean; na: boolean; detail: string; remedy: string } {
  const checker = CHECKERS[CHECK]
  assert.equal(typeof checker, 'function', `${CHECK} must be registered in CHECKERS`)
  if (checker === undefined) throw new Error(`${CHECK} is not registered`)
  const ctx = { workspace: WORKSPACE, store: store(), journal: new Journal(store()), requirements: [] } as unknown as GateContext
  const verdict = checker(ctx)
  return { ok: verdict.ok === true, na: verdict.na === true, detail: verdict.detail ?? '', remedy: verdict.remedy ?? '' }
}

/** Language-pack prose (the criterion's wording always lives there). */
function packs(): { zh: Pack; en: Pack } {
  return {
    zh: loadPackagedYaml<Pack>('src/data/lang/zh-CN.yml'),
    en: loadPackagedYaml<Pack>('src/data/lang/en.yml'),
  }
}

function zhText(key: string): string {
  const [section, ...rest] = key.split('.')
  const value = (packs().zh[section ?? ''] ?? {})[rest.join('.')]
  return value === undefined || value === rest.join('.') ? '' : value
}

/** Static prefix of a template (the text before its first placeholder). */
function head(key: string): string {
  return zhText(key).split('{p1}')[0] ?? ''
}

/** The disposition heading from the pack, asserted non-empty (a `''` head would assert nothing). */
function dispositionHeading(): string {
  const text = head('uiGates.kDeclaredItemProseHeading')
  assert.notEqual(text, '', 'the disposition heading must exist in the language pack')
  return text
}

/** Fixture card: only the fields this criterion reads are pinned. */
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
    writeScopes: ['src/m108-fixture/'],
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

function seedCard(source: TaskCard): TaskCard {
  writeTask(store(), source)
  const read = listTasks(store()).find((item) => item.id === source.id)
  assert.ok(read !== undefined, `${source.id} did not survive writeTask/listTasks`)
  return read
}

/** The criterion is a gate: it sweeps **every** finished card, so a red half must leave the ledger. */
function dropCard(id: string): void {
  rmSync(join(WORKSPACE, '.sdo', 'tasks', `${id}.yml`), { force: true })
}

function evidence(kind: EvidenceItem['kind'], detail: string): EvidenceItem {
  return { kind, detail, at: '2026-10-14T00:00:00.000Z' }
}

/** The two prose shapes the existing ledger actually carries (`TASK-001`/`TASK-007`). */
const PROSE_RESPONSIBILITY = 'DES-031 的职责：.sdo/testing/ 下的测试真源：profile.yml（方法包选择与依据）、plan.yml（层级/入口出口准则）'
const PROSE_ACCEPTANCE = 'REQ-045、REQ-046、REQ-047 的验收标准'
const PROSE_CAPABILITY = '测试域七类（0.1.6 新增） 的实现'

beforeEach(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  harness = makeHarness()
  harness.fire('session/created', { id: SESSION, header: { cwd: WORKSPACE } })
  const receipt = await harness.tool('sdo_init').execute(
    { name: 'M108 fixture', process: 'waterfall', scale: 'normal', stakeholders: 'approver,executor' },
    harness.exec(),
  )
  assert.match(String(receipt), /PRJ-001/u, `fixture init failed: ${String(receipt)}`)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// ————————————— Group 1: the relaxation direction (DEF-064's reason for existing) —————————————

test('M108-01 a done card whose declarations are prose is NOT judged red, and each one is echoed with the reason', () => {
  seedCard(card('TASK-950', {
    inputs: [PROSE_RESPONSIBILITY, PROSE_ACCEPTANCE],
    outputs: [PROSE_CAPABILITY],
    evidence: [evidence('artifact', 'src/m108-fixture/out.js sha256=deadbeef')],
  }))

  const verdict = c64()
  // ② `ok === true` is the real assertion: the criterion pushes a row (and fails) the moment one
  // declaration is judged, so green here means the prose was not judged — not that wording is absent.
  assert.equal(verdict.ok, true, `prose declarations must not be judged red: ${verdict.detail}`)
  assert.notEqual(verdict.na, true, 'the card does declare things, so this is not "not applicable"')
  assert.ok(verdict.detail.includes(dispositionHeading()), `the receipt must carry the explicit disposition heading: ${verdict.detail}`)
  for (const value of [PROSE_RESPONSIBILITY, PROSE_ACCEPTANCE, PROSE_CAPABILITY]) {
    assert.ok(verdict.detail.includes(value), `every non-participating declaration must be echoed verbatim: ${verdict.detail}`)
  }
  assert.match(verdict.detail, /TASK-950/u, `the echo must name the card: ${verdict.detail}`)
})

test('M108-02 prose does not hide a real gap: the path-shaped declaration is still red, and the prose is still echoed', () => {
  seedCard(card('TASK-951', {
    inputs: [PROSE_RESPONSIBILITY],
    outputs: ['src/m108-fixture/missing.js'],
  }))

  const verdict = c64()
  assert.equal(verdict.ok, false, 'an uncovered path-shaped declaration must stay red')
  assert.match(verdict.detail, /TASK-951/u, `must name the card: ${verdict.detail}`)
  assert.match(verdict.detail, /src\/m108-fixture\/missing\.js/u, `must name the judged declaration: ${verdict.detail}`)
  // The explicit disposition must not be a green-path-only courtesy: it is echoed on the red path too.
  assert.ok(verdict.detail.includes(dispositionHeading()), `the red receipt must still echo the non-participating declarations: ${verdict.detail}`)
  assert.ok(verdict.detail.includes(PROSE_RESPONSIBILITY), `and it must echo them verbatim: ${verdict.detail}`)
  assert.ok(verdict.detail.includes(head('uiGates.kMitigatesUnclosed')), `the red wording must come from the pack: ${verdict.detail}`)
  assert.ok(verdict.remedy !== '', 'a red verdict must come with an executable remedy')
})

// ————————————— Group 2: the red side must not regress (path-shaped declarations are judged) —————————————

test('M108-03 a path-shaped declaration with no artifact evidence is still red, naming card + item', () => {
  seedCard(card('TASK-952', { inputs: ['docs/m108-in.md'] }))

  const verdict = c64()
  assert.equal(verdict.ok, false, 'a declared path nobody published must be red')
  assert.match(verdict.detail, /TASK-952/u, `must name the card: ${verdict.detail}`)
  assert.match(verdict.detail, /docs\/m108-in\.md/u, `must name the declared item: ${verdict.detail}`)
})

test('M108-04 the same declaration covered by an artifact evidence item (with `./` and a hash suffix) is green', () => {
  seedCard(card('TASK-953', {
    inputs: ['docs/m108-in.md'],
    evidence: [evidence('command', 'npm test'), evidence('artifact', './docs/m108-in.md sha256=deadbeef')],
  }))

  const verdict = c64()
  assert.equal(verdict.ok, true, `the normalized path must match: ${verdict.detail}`)
  // Counter-sample for M108-01: nothing was skipped here, so the disposition block must be absent.
  // (`head(...)` is asserted non-empty first — `includes('')` would be vacuously true.)
  assert.equal(verdict.detail.includes(dispositionHeading()), false, `nothing was skipped, so no disposition block: ${verdict.detail}`)
})

// ————————————— Group 3: the discriminant itself (boundary of "path-shaped") —————————————

test('M108-05 a bare capability name does not participate; a bare filename does', () => {
  // Half one: a bare word (no separator, no extension) — the shape of the existing "outputs".
  seedCard(card('TASK-954', { outputs: ['Deliverable'] }))
  const green = c64()
  assert.equal(green.ok, true, `a bare capability name must not be judged: ${green.detail}`)
  assert.ok(green.detail.includes('Deliverable'), `and it must still be echoed: ${green.detail}`)

  dropCard('TASK-954')

  // Half two: a bare filename (no separator, but `name.ext`) — that one IS a path shape.
  seedCard(card('TASK-955', { outputs: ['out.js'] }))
  const red = c64()
  assert.equal(red.ok, false, `a bare filename is a path shape and must be judged: ${red.detail}`)
  assert.match(red.detail, /out\.js/u, `must name it: ${red.detail}`)

  dropCard('TASK-955')

  // Half three (counter-sample): a covered bare filename goes green — the discriminant did not
  // simply stop judging this shape.
  seedCard(card('TASK-956', {
    outputs: ['out.js'],
    evidence: [evidence('artifact', 'dist/out.js sha256=deadbeef')],
  }))
  const covered = c64()
  assert.equal(covered.ok, true, `a covered bare filename must be green: ${covered.detail}`)
})

test('M108-06 a card declaring neither column (and no mitigates) stays N/A — with no echo at all', () => {
  seedCard(card('TASK-957'))

  const verdict = c64()
  assert.equal(verdict.na, true, `nothing declared => not applicable: ${verdict.detail}`)
  assert.equal(verdict.detail, zhText('uiGates.kMitigatesNa'), `the N/A receipt is exactly the pack text (no echo): ${verdict.detail}`)
})

// ————————————— Group 4: the three self-descriptions (DEF-064 落点三) —————————————

/**
 * The three sites that used to state "the two columns read empty across the whole ledger" as a fact
 * (REV-043 finding 1: `zh-CN.yml#kMitigatesNa`, the `gates.ts` doc comment, the `collab.ts` doc
 * comment). That sentence was the *reason* the defect shipped, so it is guarded, not just edited.
 */
test('M108-07 no self-description claims the two columns are empty ledger-wide; the shape discriminant is stated', () => {
  const { zh, en } = packs()
  const zhNa = zh['uiGates']?.['kMitigatesNa'] ?? ''
  const enNa = en['uiGates']?.['kMitigatesNa'] ?? ''
  assert.notEqual(zhNa, '', 'zh-CN.yml#uiGates.kMitigatesNa must exist')
  assert.notEqual(enNa, '', 'en.yml#uiGates.kMitigatesNa must exist')

  // The false claim (REV-043 finding 1 measured it against TASK-001 / TASK-007).
  assert.equal(/现读全库为空|现读全库/u.test(zhNa), false, `kMitigatesNa still claims the whole ledger reads empty: ${zhNa}`)
  assert.equal(/read back empty across the whole ledger/u.test(enNa), false, `en kMitigatesNa still claims the same: ${enNa}`)
  // …and what replaced it: the disposition of non-path declarations.
  assert.match(zhNa, /形态判别/u, `kMitigatesNa must state the shape discriminant: ${zhNa}`)
  assert.match(enNa, /path-shaped/u, `en kMitigatesNa must state the shape discriminant: ${enNa}`)

  for (const file of ['src/domain/collab.ts', 'src/domain/gates.ts']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    assert.equal(/现读全库|两格全空|全是空数组/u.test(text), false, `${file} still carries the "whole ledger is empty" claim`)
    assert.match(text, /路径形态/u, `${file} must state the path-shape discriminant`)
  }
})
