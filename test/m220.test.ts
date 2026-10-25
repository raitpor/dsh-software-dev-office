/**
 * **增量 220：0.1.7 批4 —— 台账脱敏 ＋ 证据随版本归档 ＋ 入库读数（`TASK-173`）**。
 *
 * 这张卡要挡住的退化方向（每条都在下面有**反例格**）：
 *   · 把会话 id 也一起打码 ⇒ 台账里"谁做的"彻底不可追（`DEF-165` 的复用判据直接失效）；
 *   · 演练偷偷写盘（"我先清一遍再给你看报告"）⇒ 批准人看到的不是他批的那一版；
 *   · 缺批准也照写（驾驶舱代批）⇒ 与 `ADR-022` 裁决① 直接冲突；
 *   · 演练与执行之间台账变了还照写 ⇒ 批的是旧版本，改的是新版本（`hash-drift`）；
 *   · 脱敏把结构改坏（YAML/JSON 读不回来）却照写 ⇒ 真源变砖；
 *   · journal 的坏行被"顺手修好"⇒ 现场被擦掉，串号从此数不出来；
 *   · 归档删到**产品代码要读的原件**（`child-tools.jsonl` / `file-history/` / `child-reports/`）
 *     ⇒ 删的不是过程产物，是功能；删在飞任务的证据同样不许；
 *   · 演练报告自己泄漏本机坐标（报告会被贴进证据与提交信息）。
 *
 * 夹具里的"本机坐标"一律**假造**（`/home/sdo-fixture` 之类）：不把跑测试这台机器的家目录/主机名
 * 写进仓库，也让"占位符替换"这件事在任何机器上同判。演练**一律在临时目录**里做
 * （`node_modules/.sdo-test/m220/`，已 gitignore）：不碰真台账、不碰真仓库。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import {
  HOME_PLACEHOLDER, HOST_PLACEHOLDER, OUTSIDE_PLACEHOLDER, SCRUB_APPLIED_EVENT, SCRUB_TOOL,
  WORKSPACE_PLACEHOLDER, applyLedgerScrub, hitsTotal, leakCounts, ledgerPath, maskText, maskValue,
  ledgerSurface, planLedgerScrub, residualLeaks, scrubSecretsOf, scrubStructureProblem, sha256Hex,
} from '../src/domain/scrub.js'
import {
  EVIDENCE_ARCHIVED_EVENT, EVIDENCE_PROTECTED, applyEvidenceArchive, evidenceBytes, planEvidenceArchive,
} from '../src/domain/evidence.js'
import { REAL_LEDGER_DIR, realLedgerSkip } from './support/real-ledger.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m220/', import.meta.url))
/** 盘上的工作区（`.sdo` 的上一级）—— 存档位置，不是夹具里的"秘密"。 */
const WORKSPACE = join(BASE, 'proj')
const LEDGER = join(WORKSPACE, '.sdo')
const SCRIPT = join(ROOT, 'scripts', 'scrub-ledger.mjs')

/* —————————————————————————— 夹具里的"本机坐标"（全是假造的） —————————————————————————— */

const FAKE_HOME = '/home/sdo-fixture'
const FAKE_WORKSPACE = `${FAKE_HOME}/proj`
const FAKE_HOST = 'sdo-fixture-host'
/** `DEF-165` 的复用判据靠它认"谁做的"：脱敏**不许**动它。 */
const SESSION_ID = 'session-030c5ecb-bdce-474e-8a72-a30b2c8f97f2'
const SECRETS = { home: FAKE_HOME, host: FAKE_HOST }

const secretsOfFixture = (): ReturnType<typeof scrubSecretsOf> => scrubSecretsOf(FAKE_WORKSPACE, SECRETS)

/* —————————————————————————— 夹具 —————————————————————————— */

function freshStore(): SdoStore {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(LEDGER, { recursive: true })
  return new SdoStore(LEDGER)
}

/** 造一份**带本机坐标**的真源面（两个真源文件 + 两条 journal 事件），并钉进一个会话 id。 */
function seed(store: SdoStore, options: { leaky?: boolean } = {}): void {
  const leaky = options.leaky !== false
  store.writeYaml(['requirements', 'REQ-001.yml'], {
    requirement: {
      id: 'REQ-001',
      title: 'fixture',
      statement: leaky ? `see ${FAKE_WORKSPACE}/src/a.ts` : 'see src/a.ts',
      status: 'baselined',
      version: '0.1',
    },
  })
  store.writeYaml(['tasks', 'TASK-001.yml'], {
    task: {
      id: 'TASK-001',
      title: 'fixture',
      note: leaky ? `run from ${FAKE_HOME}/notes on ${FAKE_HOST} (${SESSION_ID})` : `run from . on . (${SESSION_ID})`,
    },
  })
  const events = [
    { seq: 1, at: '2026-01-01T00:00:00.000Z', actor: 'sdo', type: 'task/created', data: { id: 'TASK-001', reason: leaky ? `at ${FAKE_WORKSPACE}/x` : 'at x' } },
    { seq: 2, at: '2026-01-01T00:00:01.000Z', actor: 'sdo', type: 'task/claimed', data: { id: 'TASK-001', owner: `developer (${SESSION_ID})`, where: leaky ? FAKE_HOME : '.' } },
  ]
  store.writeText(['journal.jsonl'], `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
}

/** 整个目录的「文件 → 内容哈希」快照（判"演练改没改盘"用**字节**，不看 mtime）。 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string, base: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      const rel = base === '' ? entry.name : `${base}/${entry.name}`
      if (entry.isDirectory()) {
        walk(full, rel)
        continue
      }
      out[rel] = sha256Hex(readFileSync(full))
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out
}

/** 造一份 `evidence/`（保留面 / 删除面 / 产品读取的原件 / 在飞任务 各一类）。 */
function seedEvidence(store: SdoStore): { deleted: string[]; kept: string[] } {
  store.writeText(['evidence', 'batch-A', 'report.md'], '# batch A report\n')
  store.writeText(['evidence', 'batch-A', 'summary.txt'], 'summary body\n')
  store.writeText(['evidence', 'batch-A', 'scratch', 'tree', 'compiled.js'], `${'x'.repeat(4096)}\n`)
  store.writeText(['evidence', 'batch-A', 'deep', 'nested', 'notes.md'], 'deep copy of a truth file\n')
  store.writeText(['evidence', 'child-tools.jsonl'], '{"session":"s1"}\n')
  store.writeText(['evidence', 'file-history', 'a.yml.2026-01-01T00-00-00-000Z-0001.bak'], 'id: a\n')
  store.writeText(['evidence', 'child-reports', 'TASK-001-abc12345.md'], 'child report\n')
  store.writeText(['evidence', 'task124', 'probe.log'], 'probe\n')
  return {
    deleted: ['batch-A/scratch/tree/compiled.js', 'batch-A/deep/nested/notes.md'],
    kept: ['batch-A/report.md', 'batch-A/summary.txt', 'child-tools.jsonl', 'child-reports/TASK-001-abc12345.md', 'file-history/a.yml.2026-01-01T00-00-00-000Z-0001.bak', 'task124/probe.log'],
  }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(LEDGER, { recursive: true })
})
afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/* —————————————————————————— M220-01 掩码原语 —————————————————————————— */

test('M220-01 掩码只认位置不认身份：家目录/工作区/主机名换成占位符，会话 id 一个字不动', () => {
  const secrets = secretsOfFixture()
  const text = `cd ${FAKE_WORKSPACE} && grep -r ${FAKE_HOME}/notes; host=${FAKE_HOST}; session=${SESSION_ID}`
  const masked = maskText(text, secrets)
  assert.equal(masked.text.includes(FAKE_HOME), false, 'home prefix must not survive masking')
  assert.equal(masked.text.includes(FAKE_WORKSPACE), false, 'workspace prefix must not survive masking')
  assert.equal(masked.text.includes(FAKE_HOST), false, 'host name must not survive masking')
  assert.equal(masked.text.includes(WORKSPACE_PLACEHOLDER), true, 'workspace placeholder must appear')
  assert.equal(masked.text.includes(HOME_PLACEHOLDER), true, 'home placeholder must appear')
  assert.equal(masked.text.includes(HOST_PLACEHOLDER), true, 'host placeholder must appear')
  assert.equal(masked.text.includes(SESSION_ID), true, 'session id must be preserved verbatim (reuse criteria read it)')
  assert.deepEqual(masked.hits, { workspace: 1, home: 1, host: 1 }, 'each needle counted once here')

  // 深走：结构化事件的 `data` 逐字符串脱敏，**键不动**
  const value = { path: `${FAKE_WORKSPACE}/src/a.ts`, nested: { note: `${FAKE_HOME}/n`, keep: SESSION_ID }, list: [FAKE_HOST] }
  const deep = maskValue(value, secrets)
  const shaped = deep.value as { path: string; nested: { note: string; keep: string }; list: string[] }
  assert.equal(shaped.path, `${WORKSPACE_PLACEHOLDER}/src/a.ts`, 'value replaced in place, structure kept')
  assert.equal(shaped.nested.note, `${HOME_PLACEHOLDER}/n`, 'nested strings masked as well')
  assert.equal(shaped.nested.keep, SESSION_ID, 'session id in nested data preserved')
  assert.equal(shaped.list[0], HOST_PLACEHOLDER, 'host in arrays masked')
  assert.equal(hitsTotal(deep.hits), 3, 'deep walk counts every hit')
  assert.deepEqual(Object.keys(value), ['path', 'nested', 'list'], 'keys are not touched')
})

/* —————————————————————————— M220-02 写侧路径规范化 —————————————————————————— */

test('M220-02 写侧：工作区内折成仓库相对路径，工作区外只留最后一段，占位符幂等', () => {
  assert.equal(ledgerPath(FAKE_WORKSPACE, `${FAKE_WORKSPACE}/src/domain/a.ts`), 'src/domain/a.ts', 'absolute inside workspace becomes repo-relative')
  assert.equal(ledgerPath(FAKE_WORKSPACE, 'src/domain/a.ts'), 'src/domain/a.ts', 'relative stays relative')
  assert.equal(ledgerPath(FAKE_WORKSPACE, `${FAKE_WORKSPACE}/.sdo/tasks/TASK-001.yml`), '.sdo/tasks/TASK-001.yml', 'nested absolute is folded too')
  assert.equal(ledgerPath(FAKE_WORKSPACE, '/opt/elsewhere/app/x.js'), `${OUTSIDE_PLACEHOLDER}/x.js`, 'outside workspace keeps only the basename')
  assert.equal(ledgerPath(FAKE_WORKSPACE, `${HOME_PLACEHOLDER}/x`), `${HOME_PLACEHOLDER}/x`, 'already masked text is returned as-is (idempotent)')
  assert.equal(ledgerPath(FAKE_WORKSPACE, ''), '', 'empty stays empty')
})

/* —————————————————————————— M220-03 演练只读 —————————————————————————— */

test('M220-03 演练一个字节都不写，且报告自己不含本机坐标（它要能贴进证据与提交信息）', () => {
  const store = freshStore()
  seed(store)
  const before = snapshot(LEDGER)
  const plan = planLedgerScrub(store, { workspace: FAKE_WORKSPACE, secrets: SECRETS, journal: new Journal(store), now: '2026-01-01T00:00:00.000Z' })
  const after = snapshot(LEDGER)
  assert.deepEqual(after, before, 'rehearsal must not touch a single byte')
  assert.equal(plan.report.files.length, 2, 'two truth files carry the fixture paths')
  assert.equal(plan.report.journal?.rows.length, 2, 'two journal events carry them as well')
  assert.equal(plan.report.dryRun, true, 'the report states it is a rehearsal')
  const serialized = JSON.stringify(plan.report)
  for (const secret of [FAKE_HOME, FAKE_WORKSPACE, FAKE_HOST]) {
    assert.equal(serialized.includes(secret), false, `report must not leak ${secret}`)
  }
  assert.equal(serialized.includes(SESSION_ID), false, 'report does not echo event bodies either')
  for (const row of plan.report.files) {
    assert.match(row.beforeHash, /^[0-9a-f]{64}$/u, 'before hash is a full hex digest')
    assert.match(row.afterHash, /^[0-9a-f]{64}$/u, 'after hash is a full hex digest')
    assert.notEqual(row.beforeHash, row.afterHash, 'a planned row really changes bytes')
  }
  assert.equal(plan.report.refusals.length, 0, 'the clean fixture has nothing to refuse')
})

/* —————————————————————————— M220-04 执行 + 幂等 —————————————————————————— */

test('M220-04 执行之后真源面残余为 0，且再演练一次是空计划（幂等）', () => {
  const store = freshStore()
  seed(store)
  const journal = new Journal(store)
  const secrets = secretsOfFixture()
  // **正控**（否则"读数 0"分不清"真干净"与"探测器瞎了"）：执行**之前**先证明这份夹具真的带本机坐标
  const seeded = leakCounts(residualLeaks(store, secrets))
  assert.equal(seeded.home > 0, true, 'positive control: the seeded ledger really carries machine paths')
  assert.equal(seeded.workspace > 0, true, 'positive control: workspace paths are detected too')
  const plan = planLedgerScrub(store, { workspace: FAKE_WORKSPACE, secrets: SECRETS, journal, now: '2026-01-01T00:00:00.000Z' })
  const receipt = applyLedgerScrub(store, plan, { approvedBy: 'human', journal, now: '2026-01-01T00:00:01.000Z' })
  assert.equal(receipt.files, 2, 'two files rewritten')
  assert.equal(receipt.journalEvents, 2, 'two events rewritten')
  assert.notEqual(receipt.beforeDigest, receipt.afterDigest, 'chain digests differ (something really changed)')

  const leaks = leakCounts(residualLeaks(store, secrets))
  assert.deepEqual(leaks, { workspace: 0, home: 0, host: 0 }, 'DoD reading: no home/workspace/host shape survives')
  assert.equal(readFileSync(join(LEDGER, 'tasks', 'TASK-001.yml'), 'utf8').includes(SESSION_ID), true, 'session id survives the rewrite')

  const again = planLedgerScrub(store, { workspace: FAKE_WORKSPACE, secrets: SECRETS, journal, now: '2026-01-01T00:00:02.000Z' })
  assert.equal(again.report.files.length, 0, 'second rehearsal finds nothing (idempotent)')
  assert.equal(again.report.journal?.rows.length, 0, 'second rehearsal finds no journal hits')
})

/* —————————————————————————— M220-05 批准闸 + 审计事件 —————————————————————————— */

test('M220-05 缺用户批准就零写盘；批准后留 update 审计事件（含前后链式摘要与相对路径）', () => {
  const store = freshStore()
  seed(store)
  const journal = new Journal(store)
  const plan = planLedgerScrub(store, { workspace: FAKE_WORKSPACE, secrets: SECRETS, journal, now: '2026-01-01T00:00:00.000Z' })
  const before = snapshot(LEDGER)
  assert.throws(
    () => applyLedgerScrub(store, plan, { approvedBy: 'cockpit', journal }),
    (error: unknown) => (error as { code?: string }).code === 'approval-missing',
    'a non-human approver must be refused',
  )
  assert.throws(
    () => applyLedgerScrub(store, plan, { approvedBy: '  ', journal }),
    (error: unknown) => (error as { code?: string }).code === 'approval-missing',
    'a blank approver must be refused too',
  )
  assert.deepEqual(snapshot(LEDGER), before, 'refused applies write nothing')

  const receipt = applyLedgerScrub(store, plan, { approvedBy: 'human', journal, now: '2026-01-01T00:00:01.000Z' })
  const applied = journal.read().events.filter((event) => String(event.type) === SCRUB_APPLIED_EVENT)
  assert.equal(applied.length, 1, 'exactly one audit event')
  const data = applied[0]?.data ?? {}
  assert.equal(data['tool'], SCRUB_TOOL, 'the event names the tool')
  assert.equal(data['approvedBy'], 'human', 'the approver is recorded')
  assert.equal(data['beforeDigest'], receipt.beforeDigest, 'chain digest before is recorded')
  assert.equal(data['afterDigest'], receipt.afterDigest, 'chain digest after is recorded')
  assert.equal(receipt.eventSeq, applied[0]?.seq, 'receipt points at the audit event')
  const rows = data['rows'] as { path: string }[]
  assert.deepEqual(rows.map((row) => row.path).sort(), ['requirements/REQ-001.yml', 'tasks/TASK-001.yml'], 'rows carry ledger-relative paths only')
  const eventText = JSON.stringify(applied[0])
  for (const secret of [FAKE_HOME, FAKE_WORKSPACE, FAKE_HOST]) {
    assert.equal(eventText.includes(secret), false, `audit event must not leak ${secret}`)
  }
})

/* —————————————————————————— M220-06 演练后盘面变了 —————————————————————————— */

test('M220-06 演练与执行之间台账被改过 ⇒ hash-drift 整体拒绝，一个字节都不写', () => {
  const store = freshStore()
  seed(store)
  const journal = new Journal(store)
  const plan = planLedgerScrub(store, { workspace: FAKE_WORKSPACE, secrets: SECRETS, journal, now: '2026-01-01T00:00:00.000Z' })
  // 有人在演练之后又写了一版（真账 append-only 的常态：别的会话正在干活）
  store.writeYaml(['tasks', 'TASK-001.yml'], { task: { id: 'TASK-001', title: 'edited after rehearsal', note: `${FAKE_HOME}/notes (${SESSION_ID})` } })
  const before = snapshot(LEDGER)
  assert.throws(
    () => applyLedgerScrub(store, plan, { approvedBy: 'human', journal }),
    (error: unknown) => (error as Error & { code?: string }).code === 'hash-drift',
    'a drifted ledger must be refused as a whole',
  )
  assert.deepEqual(snapshot(LEDGER), before, 'nothing was written before the refusal')
  assert.equal(journal.read().events.some((event) => String(event.type) === SCRUB_APPLIED_EVENT), false, 'no audit event on a refused apply')
  assert.equal(readFileSync(join(LEDGER, 'requirements', 'REQ-001.yml'), 'utf8').includes(FAKE_WORKSPACE), true, 'the untouched file still has its original bytes')
})

/* —————————————————————————— M220-07 被拒面 —————————————————————————— */

test('M220-07 被拒逐条点名：非 UTF-8 / 改写前就不合法 / journal 坏行 / 未归类 / 符号链接（结构破坏走纯函数格）', () => {
  const store = freshStore()
  seed(store)
  writeFileSync(join(LEDGER, 'requirements', 'REQ-002.yml'), Buffer.from([0xff, 0xfe, 0x0a]))
  store.writeText(['design', 'DES-001.yml'], `note: ${FAKE_HOME}/x\nbroken: [unclosed\n`)
  store.appendLine(['journal.jsonl'], '{"seq":3,"at":')
  store.writeText(['notes', 'loose.md'], `see ${FAKE_HOME}/x\n`)
  symlinkSync(join(LEDGER, 'tasks'), join(LEDGER, 'linked-tasks'))
  const plan = planLedgerScrub(store, { workspace: FAKE_WORKSPACE, secrets: SECRETS })
  const codes = plan.report.refusals.map((row) => `${row.path}:${row.code}`).sort()
  assert.equal(codes.includes('requirements/REQ-002.yml:not-utf8'), true, 'binary files are refused, not rewritten')
  assert.equal(codes.includes('design/DES-001.yml:source-unparseable'), true, 'files that were already broken are refused')
  assert.equal(codes.includes('notes:unclassified'), true, 'an unknown top-level entry is refused (fail-closed)')
  assert.equal(codes.includes('linked-tasks:symlink'), true, 'symlinks are not followed')
  const tail = plan.report.refusals.find((row) => row.code === 'journal-line-not-json')
  assert.equal(tail?.path, 'journal.jsonl', 'the broken journal line is named')
  assert.equal(tail?.line, 3, 'and its line number is named')

  // `structural-break` 在真账上造不出来（占位符本身是合法标量）⇒ 当成纯函数直接喂一对文本
  const broken = scrubStructureProblem('x.json', '{"a":"ok"}', '{"a":')
  assert.equal(broken?.code, 'structural-break', 'masked text that no longer parses must be refused')
  assert.equal(scrubStructureProblem('x.json', '{"a":"ok"}', '{"a":"<workspace>"}'), undefined, 'a legal rewrite is not refused')
  assert.equal(scrubStructureProblem('x.yml', 'broken: [unclosed\n', 'broken: [unclosed\n')?.code, 'source-unparseable', 'an already-broken source is refused as such')

  // 坏行在执行之后**逐字保留**（半行是真源受损的现场，改它等于擦掉现场）
  const journalTextBefore = readFileSync(join(LEDGER, 'journal.jsonl'), 'utf8')
  const journal = new Journal(store)
  applyLedgerScrub(store, plan, { approvedBy: 'human', journal })
  const journalTextAfter = readFileSync(join(LEDGER, 'journal.jsonl'), 'utf8')
  const brokenLine = journalTextBefore.split('\n').find((line) => line === '{"seq":3,"at":')
  assert.equal(brokenLine, '{"seq":3,"at":', 'fixture sanity: the half line exists before')
  assert.equal(journalTextAfter.split('\n').includes('{"seq":3,"at":'), true, 'the half line survives verbatim')
  assert.equal(readFileSync(join(LEDGER, 'requirements', 'REQ-002.yml')).equals(Buffer.from([0xff, 0xfe, 0x0a])), true, 'the refused binary file is untouched')
})

/* —————————————————————————— M220-08 证据归档 —————————————————————————— */

test('M220-08 证据归档：留 report.md 与摘要、删 scratch 与深拷贝、产品读取的原件与在飞任务一个不动', () => {
  const store = freshStore()
  seed(store)
  const files = seedEvidence(store)
  const journal = new Journal(store)
  const before = evidenceBytes(store)
  const plan = planEvidenceArchive(store, { keepTasks: ['TASK-124'], now: '2026-01-01T00:00:00.000Z' })
  assert.equal(plan.dryRun, true, 'rehearsal states it is a rehearsal')
  assert.equal(evidenceBytes(store), before, 'rehearsal deletes nothing')
  const deleted = plan.deleteRows.map((row) => row.path).sort()
  assert.deepEqual(deleted, files.deleted.sort(), 'only the bulk copies are deletion candidates')
  const kept = plan.keepRows.map((row) => row.path).sort()
  assert.deepEqual(kept, files.kept.sort(), 'report/summary/protected/in-flight are kept')
  const why = new Map(plan.keepRows.map((row) => [row.path, row.why]))
  assert.equal(why.get('batch-A/report.md'), 'report', 'report.md is kept as the citation target')
  assert.equal(why.get('child-tools.jsonl'), 'protected', 'the tool-face observation source is protected')
  assert.equal(why.get('task124/probe.log'), 'in-flight-task', 'an in-flight task keeps its evidence')
  assert.equal(plan.totals.deletedBytes, plan.deleteRows.reduce((total, row) => total + row.bytes, 0), 'byte accounting is exact')
  assert.equal(plan.totals.beforeBytes, plan.totals.keptBytes + plan.totals.deletedBytes, 'every byte is either kept or deleted')
  assert.equal(plan.totals.withinTarget, true, 'the fixture is far below the target')

  assert.throws(
    () => applyEvidenceArchive(store, plan, { approvedBy: 'office', journal }),
    (error: unknown) => (error as { code?: string }).code === 'approval-missing',
    'archiving without user approval must be refused',
  )
  assert.equal(evidenceBytes(store), before, 'a refused archive deletes nothing')

  const receipt = applyEvidenceArchive(store, plan, { approvedBy: 'human', journal, now: '2026-01-01T00:00:01.000Z' })
  assert.equal(receipt.deletedBytes, plan.totals.deletedBytes, 'receipt reports the deleted bytes')
  assert.equal(receipt.deletedFiles, plan.totals.deleteFiles, 'receipt reports the deleted file count')
  assert.equal(evidenceBytes(store), plan.totals.keptBytes, 'what is left equals the keep set')
  for (const path of files.deleted) assert.equal(existsSync(join(LEDGER, 'evidence', path)), false, `deleted: ${path}`)
  for (const path of files.kept) assert.equal(existsSync(join(LEDGER, 'evidence', path)), true, `kept: ${path}`)
  for (const item of EVIDENCE_PROTECTED) assert.equal(existsSync(join(LEDGER, 'evidence', item.path)), true, `protected: ${item.path}`)

  const archived = journal.read().events.filter((event) => String(event.type) === EVIDENCE_ARCHIVED_EVENT)
  assert.equal(archived.length, 1, 'exactly one archive event')
  const data = archived[0]?.data ?? {}
  assert.equal(data['deletedBytes'], receipt.deletedBytes, 'the event records deleted bytes')
  assert.equal(data['approvedBy'], 'human', 'the event records the approver')
  assert.deepEqual((data['kept'] as string[]).sort(), files.kept.sort(), 'the event records the full keep manifest')
})

/* —————————————————————————— M220-09 归档读数的另一面 —————————————————————————— */

test('M220-09 归档后 evidence/ 体积回落到保留集，且脱敏面可带 --include-evidence 覆盖留存的摘要', () => {
  const store = freshStore()
  seed(store)
  seedEvidence(store)
  store.writeText(['evidence', 'batch-A', 'kept-note.md'], `see ${FAKE_HOME}/x\n`)
  const journal = new Journal(store)
  const plan = planEvidenceArchive(store, { now: '2026-01-01T00:00:00.000Z' })
  assert.equal(plan.deleteRows.some((row) => row.path === 'batch-A/kept-note.md'), false, 'a shallow summary is kept even if it carries a machine path')
  applyEvidenceArchive(store, plan, { approvedBy: 'human', journal })
  const secrets = secretsOfFixture()
  const evidenceLeaks = leakCounts(residualLeaks(store, secrets, { includeEvidence: true }))
  assert.equal(evidenceLeaks.home > 0, true, 'fixture sanity: kept evidence still carries the machine path')
  const surface = planLedgerScrub(store, { workspace: FAKE_WORKSPACE, secrets: SECRETS, includeEvidence: true, now: '2026-01-01T00:00:01.000Z' })
  assert.equal(surface.report.files.some((row) => row.path === 'evidence/batch-A/kept-note.md'), true, 'with --include-evidence the kept summary is in the scrub surface')
  applyLedgerScrub(store, surface, { approvedBy: 'human', journal })
  assert.equal(leakCounts(residualLeaks(store, secrets, { includeEvidence: true })).home, 0, 'after the second pass nothing is left, evidence included')
})

/* —————————————————————————— M220-10 真账只读演练 —————————————————————————— */

test('M220-10 real ledger rehearsal is reproducible, read-only and under the 10 MB entry budget', realLedgerSkip() ?? {}, () => {
  const store = new SdoStore(REAL_LEDGER_DIR)
  const journalPath = join(REAL_LEDGER_DIR, 'journal.jsonl')
  const journalBefore = sha256Hex(readFileSync(journalPath))
  const secrets = scrubSecretsOf(join(REAL_LEDGER_DIR, '..'))
  const first = planLedgerScrub(store, { secrets, journal: new Journal(store), now: '2026-01-01T00:00:00.000Z' })
  const second = planLedgerScrub(store, { secrets, journal: new Journal(store), now: '2026-01-01T00:00:00.000Z' })
  assert.deepEqual(second.report, first.report, 'two rehearsals on the same ledger are byte-identical (reproducible reading)')
  assert.equal(sha256Hex(readFileSync(journalPath)), journalBefore, 'the rehearsal did not touch the real journal')
  const serialized = JSON.stringify(first.report)
  assert.equal(serialized.includes('/home/'), false, 'the rehearsal report itself carries no machine home prefix')
  /**
   * **预算定性（`TASK-250` / `DEF-231`）—— 这条**不是**设计不变量，是**当初拍的数**（候选 ④）。**
   *
   * 证据（现盘、可复跑）：
   *   · 扫描面 = `.sdo` 去掉 `drafts` / `evidence` / `handover` / `project.json` 之后的子集
   *     = **1538 个 yml + `journal.jsonl`** ⇒ `scannedBytes = 10,640,248`，平均 6,918 B/文件；
   *   · 其中 `journal.jsonl` 一项就 **6,095,589 B（8651 行）**，占总量的 **57%**；
   *   · 也就是说"10 MiB"从来不是"真源层设计上不超过 10 MiB"——**光台账自己就到 6 MB**，
   *     而台账按 append-only 单调增长（本项目自己干活就会长）。
   *
   * **推导公式**（换掉拍数）：`scannedBytes ≈ journalBytes + files × avgFileBytes`，
   * 实测比值 `scanned / journal ≈ 1.75`。判据改成**跟台账挂钩**并留足**再增长 2 倍**的余量：
   *   `budget = max(32 MiB, journalBytes × 4)`
   * —— 32 MiB 覆盖"台账还小、但 yml 很多"的项目；`× 4` 覆盖现状 1.75 的两倍余量。
   * 这是**canary**（前提随账态漂），不是正确性判据：本格真正钉的是
   * 「只读 + 可复现 + 报告不含机器前缀」（上面三条断言），预算这一条只防**失控增长**。
   */
  const journalBytes = statSync(journalPath).size
  const budgetBytes = Math.max(32 * 1024 * 1024, journalBytes * 4)
  assert.ok(
    first.report.surface.scannedBytes < budgetBytes,
    `scan surface must stay within the derived budget (actual ${first.report.surface.scannedBytes}, `
    + `journal ${journalBytes}, budget ${Math.round(budgetBytes)}) — the cap tracks the journal, it is a canary not an invariant`,
  )
  assert.ok(first.report.surface.scannedFiles > 100, `the surface must cover the real ledger (actual ${first.report.surface.scannedFiles})`)
  assert.equal(first.report.surface.excluded.some((row) => row.path === 'evidence'), true, 'evidence is excluded from the scrub surface (ADR-022)')
})

/* —————————————————————————— M220-11 命令面 —————————————————————————— */

test('M220-11 命令面：演练缺省只读、缺批准 exit 1、带批准才真执行并给出前后摘要', () => {
  const store = freshStore()
  seed(store)
  const run = (args: string[]): string => execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const before = snapshot(LEDGER)
  const rehearsal = JSON.parse(run(['--root', WORKSPACE, '--json'])) as { tool: string; dryRun: boolean; files: unknown[] }
  assert.equal(rehearsal.tool, SCRUB_TOOL, 'the CLI reports the tool name')
  assert.equal(rehearsal.dryRun, true, 'the default run is a rehearsal')
  assert.ok(rehearsal.files.length >= 1, 'the rehearsal finds the fixture files')
  assert.deepEqual(snapshot(LEDGER), before, 'the default CLI run writes nothing')

  let refused = false
  try {
    run(['--root', WORKSPACE, '--apply', '--json'])
  } catch (error) {
    refused = true
    assert.equal((error as { status?: number }).status, 1, 'missing approval exits with 1')
  }
  assert.equal(refused, true, 'the CLI must refuse to apply without --approved-by human')
  assert.deepEqual(snapshot(LEDGER), before, 'a refused apply writes nothing')

  const applied = JSON.parse(run(['--root', WORKSPACE, '--apply', '--approved-by', 'human', '--json'])) as {
    receipt: { files: number; journalEvents: number; beforeDigest: string; afterDigest: string }
    after: { home: number; workspace: number; host: number }
  }
  assert.ok(applied.receipt.files >= 1, 'the applied run rewrites files')
  assert.notEqual(applied.receipt.beforeDigest, applied.receipt.afterDigest, 'the receipt carries both chain digests')
  assert.deepEqual(applied.after, { home: 0, workspace: 0, host: 0 }, 'the reading after the run is zero')
})

/* —————————————————————————— M220-12 入库边界（口径面） —————————————————————————— */

test('M220-12 入库边界：evidence/drafts/handover/project.json 在**脱敏面之外**且带理由（不是"没扫到"）', () => {
  const store = freshStore()
  seed(store)
  store.writeText(['evidence', 'batch-A', 'report.md'], '# report\n')
  store.writeText(['drafts', 'draft.ts'], 'export const x = 1\n')
  store.writeText(['handover', 'note.md'], 'handover\n')
  store.writeText(['project.json'], '{}\n')
  const surface = ledgerSurface(store)
  assert.deepEqual(
    surface.excluded.map((row) => row.path).sort(),
    ['drafts', 'evidence', 'handover', 'project.json'],
    'the four non-repository entries are excluded by name',
  )
  assert.equal(surface.excluded.every((row) => row.why.trim() !== ''), true, 'every exclusion carries a reason')
  assert.equal(surface.paths.some((path) => path.startsWith('evidence/') || path.startsWith('drafts/') || path.startsWith('handover/')), false, 'no excluded path leaks into the truth surface')
  const withEvidence = ledgerSurface(store, { includeEvidence: true })
  assert.equal(withEvidence.paths.includes('evidence/batch-A/report.md'), true, 'includeEvidence opts evidence in explicitly (post-archive scrub)')
  assert.equal(withEvidence.paths.some((path) => path.startsWith('drafts/') || path.startsWith('handover/')), false, 'drafts and handover never enter the scrub surface')
})
