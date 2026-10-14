/**
 * **TASK-001 验收复核器**（独立入口，只读：不改任何产品文件）。
 *
 * 为什么单独一个文件：卡上的证据要求是 `artifact`，而"跑一遍用例全绿"只说"用例是绿的"，
 * 说不清**卡上四条 DoD 各自成立**。这里把四条 DoD 逐条**现算**，并额外**证伪两件容易混过去的事**：
 *
 *   · 断言不是恒真的：关键判据各配一个"故意做错"的反例，反例必须**判不过**（§D 段）；
 *   · 可独立复跑：只依赖已构建的 `lib/`，不 import 别的测试文件、不共享沙箱。
 *
 * 用法：
 *   node --test lib/test/task001-acceptance.test.js      # 作为用例跑（全绿 = 四条 DoD 成立）
 *   node lib/test/task001-acceptance.test.js             # 也可直接跑（打印逐条结论）
 *
 * **它不覆盖什么**（写明免得被误当成整条需求的验收）：门禁判据接线、工具面回执，以及
 * REQ-046/048/049/050/051/052/055/056/057 的门禁行为 —— 那些属于后续卡（TASK-012…TASK-023），
 * 本条（TASK-001）只交付 `.sdo/testing/**` 真源读写与渲染的底座。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { parseRenderSeq } from '../src/domain/design.js'
import {
  TESTING_CLASSES,
  TESTING_SOURCE_FILES,
  currentJournalSeq,
  docSourceFingerprint,
  docSourceLocation,
  lastDocRecord,
  renderStale,
  sourceFingerprintOf,
  writeTestingSource,
} from '../src/domain/testingStore.js'
import { renderTestPlan, writeTestingDoc } from '../src/domain/testingRender.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/task001-acceptance/', import.meta.url))

let store: SdoStore
let journal: Journal

/** 一份最小但**有内容**的计划真源（`levels` 是必产项、`exitCriteria` 是准出准则）。 */
const PLAN = {
  levels: [{ id: 'TL-001', level: '单元', entry: '构建通过', exit: '用例全绿' }],
  exitCriteria: [{ id: 'XC-001', criterion: '语句覆盖', metric: 'statement', threshold: '80%', scope: 'src/domain/testing*' }],
}

function writePlan(): void {
  writeTestingSource(store, 'plan', 'plan', PLAN, journal)
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('A 七类真源：一类一函数，design 一类含黑盒 + 白盒两个文件', () => {
  assert.equal(TESTING_CLASSES.length, 7, 'REQ-017 的测试域是七类')
  assert.equal(TESTING_CLASSES.flatMap((cls) => TESTING_SOURCE_FILES[cls]).length, 8, 'design 一类两文件')
})

test('B DoD① 读写幂等：同一真源两次写入逐字节一致、第二次不改盘也不留事件', () => {
  writePlan()
  const path = join(BASE, '.sdo', 'testing', 'plan.yml')
  const bytes1 = readFileSync(path, 'utf8')
  const events1 = journal.read().events.length
  const second = writeTestingSource(store, 'plan', 'plan', PLAN, journal)
  assert.equal(second.changed, false, '同样的内容再写 ⇒ 判"未变"')
  assert.equal(readFileSync(path, 'utf8'), bytes1, '两次写入逐字节一致')
  assert.equal(journal.read().events.length, events1, '重复写不留第二条事件（否则重放会推进序号）')
  assert.equal(second.fingerprint, sourceFingerprintOf(store, 'plan'), '同内容 ⇒ 同指纹')
})

test('B DoD① 渲染幂等：同一真源 + 同一 seq 两次渲染逐字节一致（落盘 sha256 相同）', () => {
  writePlan()
  const seq = currentJournalSeq(store, journal)
  const input = { store, seq, projectName: 'PRJ-001', process: 'waterfall', phase: 'verification' }
  assert.equal(renderTestPlan(input), renderTestPlan(input), '纯函数：同输入 ⇒ 同输出')
  const first = writeTestingDoc(store, 'plan', input, journal)
  const second = writeTestingDoc(store, 'plan', input, journal)
  assert.equal(second.sha256, first.sha256, '同一真源 + 同一 seq ⇒ 同一 sha256')
})

test('C DoD② 渲染头带真源位置与 journal 序号，且序号能被既有解析器读回', () => {
  writePlan()
  const seq = currentJournalSeq(store, journal)
  const text = renderTestPlan({ store, seq })
  assert.match(text, /<!-- source: \.sdo\/testing\/plan\.yml @ journal seq \d+ -->/u)
  assert.equal(parseRenderSeq(text), seq, '判据按头里的序号重渲染，因此必须写得出来、读得回来')
  assert.equal(docSourceLocation('plan'), '.sdo/testing/plan.yml')
  assert.equal(docSourceLocation('report'), '.sdo/testing/report.yml')
})

test('C DoD③④ 改真源 ⇒ 旧渲染判过期；重新渲染后序号前进，之后不再过期', () => {
  writePlan()
  const first = writeTestingDoc(store, 'plan', { store, seq: currentJournalSeq(store, journal) }, journal)
  assert.equal(renderStale(store, 'plan', journal).stale, false, '刚渲染 + 已登记 ⇒ 不过期')
  assert.equal(lastDocRecord(store, 'plan')?.fingerprint, docSourceFingerprint(store, 'plan'))

  const path = join(BASE, '.sdo', 'testing', 'plan.yml')
  writeFileSync(path, `${readFileSync(path, 'utf8')}  # 改真源\n`, 'utf8')
  const stale = renderStale(store, 'plan', journal)
  assert.equal(stale.stale, true, '改真源 ⇒ 旧渲染判过期')
  assert.equal(stale.sourceChanged, true, '过期的理由是真源内容指纹不符')
  assert.notEqual(stale.currentFingerprint, stale.recordedFingerprint)

  const again = writeTestingDoc(store, 'plan', { store, seq: currentJournalSeq(store, journal) }, journal)
  assert.ok(again.seq > first.seq, `重新渲染后序号必须前进：${first.seq} → ${again.seq}`)
  assert.equal(parseRenderSeq(readFileSync(join(BASE, 'docs', 'TESTPLAN.md'), 'utf8')), again.seq)
  assert.equal(renderStale(store, 'plan', journal).stale, false, '重渲染并登记后不再过期')
})

test('C 无关事件不让渲染过期（指纹定红绿，序号只作说明）—— 这条是设计取舍，不是碰巧', () => {
  writePlan()
  writeTestingDoc(store, 'plan', { store, seq: currentJournalSeq(store, journal) }, journal)
  journal.append('evidence/recorded', { note: '与测试真源无关' }, 'sdo')
  const drifted = renderStale(store, 'plan', journal)
  assert.equal(drifted.sourceChanged, false)
  assert.equal(drifted.seqAdvanced, true, '序号确实前进了（说明性字段）')
  assert.equal(drifted.stale, false, '拿全局序号定红绿 ⇒ 渲染完三份文档前两份立刻假红')
})

test('D 反例（断言不是恒真的）：三条"故意做错"的判据必须各自判不过', () => {
  writePlan()
  writeTestingDoc(store, 'plan', { store, seq: currentJournalSeq(store, journal) }, journal)

  // 反例 1：把"没改真源"当成"改了"
  assert.throws(() => assert.equal(renderStale(store, 'plan', journal).stale, true), '起始状态不该判过期')

  // 反例 2：把"改了真源"当成"没改"
  const path = join(BASE, '.sdo', 'testing', 'plan.yml')
  writeFileSync(path, `${readFileSync(path, 'utf8')}  # 改真源\n`, 'utf8')
  assert.throws(() => assert.equal(renderStale(store, 'plan', journal).stale, false), '改真源必须判过期')

  // 反例 3：渲染头序号与实际 journal 不符
  const seq = currentJournalSeq(store, journal)
  assert.throws(() => assert.equal(parseRenderSeq(renderTestPlan({ store, seq })), seq + 1), '头里的序号不能是随便一个数')
})
