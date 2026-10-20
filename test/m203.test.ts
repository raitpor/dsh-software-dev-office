/**
 * **增量 203：签名侧补齐 —— 被签内容指纹 + 三档作答 + 拒收不可信作答**（TASK-161 / REQ-061）。
 *
 * 三条验收标准各有一个机械面（本文件逐条打）：
 *   · **AC-249**：一份待批内容已呈现（绑定其 sha256）⇒ 用户「批准」时台账**同时**记下
 *     `payloadSha256` 与 `answeredAt`。判据不是"字段名出现了"，而是**事后能从盘上重算**：
 *     拿`.sdo/evidence/sign-reviews/<门禁>.md`（当时给用户看的那一份）与 `<门禁>.json` 的 `seq`
 *     重算 `signPayloadSha256`，必须与台账**逐字相同**。
 *   · **AC-248 / AC-250 / AC-252**：**不可信作答拒收**。四条互不重叠的不可信形态：
 *     来源不是问答通道（`channel=command`）、缺引用依据（`label` 空）、缺来源凭据
 *     （`provenance` 不是 `user-question`：预填默认 / 自动作答 / 未知）、自由文本作答（`source=custom`）。
 *     每一条都必须**拒收且一个字节都不写**（台账文件连创建都不许有）。
 *
 * ⚠️ 读散文棘轮（`M189-08` / `DEF-093`）：本文件的断言**第一、二个实参里不许出现中文**
 * （中文只进第三个"消息位"，那是断言消息，不算取值）。凡要断言回执文案的地方，
 * 一律用 `t()` / `fmt()` 里**同一个语言包键**取值，或断言 ASCII 记号（`payloadSha256`、`approve`…）。
 *
 * ⚠️ 新符号走**动态 import**（`signatureApi()`）：本卡是"先钉红再改"，实现前 `src/domain/signature.ts`
 * 里并没有这三个导出 —— 静态 import 会让**整棵树编译不过**，那就拿不到"现盘红"的读数了。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { fmt, gateLabel, t } from '../src/domain/i18n.js'
import { latestSignature } from '../src/domain/signature.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm203')
const WORKSPACE = join(BASE, 'proj')

/** 工具面的**最小形状**（与 m90 同款）：只用到 `parameters` 与 `execute(args, { agent })`。 */
interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

/** 一条作答记录在本文件里用到的字段（只读观测面）。 */
interface AnswerRow {
  gate?: string
  decision?: string
  label?: string
  payloadSha256?: string
  answeredAt?: string
  provenance?: string
}

interface SignatureApi {
  signPayloadSha256: (payload: { seq: number; body: string }) => string
  recordSignAnswer: (store: SdoStore, input: Record<string, unknown>) => AnswerRow
  listSignAnswers: (store: SdoStore) => AnswerRow[]
}

/**
 * 取 `src/domain/signature.ts` 的 REQ-061 新增面。
 *
 * 用动态 import 是为了**先钉红**：实现未落地时这三个符号不存在，静态 import 会让整棵树编译失败
 * （那样连"现盘红"都读不出来）。断言的措辞因此必须点名**缺的是哪个导出**。
 */
async function signatureApi(): Promise<SignatureApi> {
  const mod = (await import('../src/domain/signature.js')) as unknown as Record<string, unknown>
  for (const name of ['signPayloadSha256', 'recordSignAnswer', 'listSignAnswers']) {
    assert.equal(typeof mod[name], 'function', `signature.ts must export ${name} (REQ-061 TASK-161)`)
  }
  return mod as unknown as SignatureApi
}

// ————————————————————— 工具面（真实装配 + schema 过滤） —————————————————————

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>

const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `tool face is missing ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

/** 把问答通道的下一次作答固定成某一个选项标签（`selected`）或自由文本（`custom`）。 */
function answerWith(option: { label?: string; custom?: string }): void {
  services['userQuestions'] = {
    ask: async (): Promise<unknown> => ({
      answers: [{
        id: 'sdo-gate-sign',
        selected: option.label === undefined ? [] : [option.label],
        ...(option.custom === undefined ? {} : { custom: option.custom }),
      }],
    }),
  }
}

const signedEvents = (): number =>
  office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'gate/signed').length

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M203 sign answers', scale: 'normal', stakeholders: ['product'] })
  office.updateProject(call, {
    scopeIn: ['gate signature answers'],
    scopeOut: ['automatic signing'],
    metricsSuccess: ['every approval carries a payload hash'],
    glossary: { payloadSha256: 'sha256 of the content that was presented for approval' },
  })
  office.capture(call, {
    title: 'approval must bind the presented content',
    statement: 'the ledger records the sha256 of the presented review plus the answer time',
    rationale: 'otherwise nobody can tell which revision was approved',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.logRisk(call, {
    title: 'answers without a provenance credential',
    level: 'medium',
    probability: 'medium',
    impact: 'a prefilled default looks like a user click',
    mitigation: 'record provenance and reject anything but the question channel',
    owner: 'product',
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
  services['tools'] = { register: (tool: ToolDefinition): (() => void) => { tools.push(tool); return () => {} } }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// ————————————————————— AC-249：批准 ⇒ 台账落 sha256 + 作答时刻 —————————————————————

test('M203-01 (AC-249) approval lands payloadSha256 + answeredAt, and the hash can be recomputed from disk', async () => {
  answerWith({ label: t('uiSign.signOption') })
  await callTool('sdo_gate', { action: 'sign', gate: 'G2', channel: 'question' })

  const store = office.storeFor(WORKSPACE)
  const found = latestSignature(store, 'G2')
  assert.ok(found !== undefined, 'a question-channel approval must land a signature record')
  // 用**松散视图**读台账：四个字段在实现落地前根本不存在于类型面上 —— 让红读数落在**运行期**
  // （"字段不存在"），而不是落在编译期（那样连红读数都读不出来）。
  const signature = found as unknown as {
    channel?: string
    decision?: string
    provenance?: string
    payloadSha256?: string
    answeredAt?: string
  }

  // ① 四字段：三档=approve · 凭据=user-question · 通道=question · 指纹与作答时刻都在
  assert.equal(signature.decision, 'approve', 'the recorded decision must be the approve tier')
  assert.equal(signature.provenance, 'user-question', 'the recorded provenance must be the trusted one')
  assert.equal(signature.channel, 'question', 'the approval must come from the question channel')
  assert.match(String(signature.payloadSha256), /^[0-9a-f]{64}$/u, 'payloadSha256 must be a sha256 hex digest')
  assert.match(String(signature.answeredAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u, 'answeredAt must be an ISO timestamp')

  // ② **可事后重算**（否则这个哈希只是装饰）：当时呈现的那一份审核单全文 + 呈现时刻的序号
  const doc = readFileSync(join(WORKSPACE, '.sdo', 'evidence', 'sign-reviews', 'G2.md'), 'utf8')
  const record = JSON.parse(
    readFileSync(join(WORKSPACE, '.sdo', 'evidence', 'sign-reviews', 'G2.json'), 'utf8'),
  ) as { seq?: number }
  assert.equal(typeof record.seq, 'number', 'the review record must carry the journal seq it was rendered at')
  const api = await signatureApi()
  assert.equal(
    signature.payloadSha256,
    api.signPayloadSha256({ seq: record.seq ?? 0, body: doc }),
    'auditing must recompute the very same hash from the persisted review (body + seq)',
  )

  // ③ 作答台账：批准这一档也要落（三档各自可落账）
  const answers = api.listSignAnswers(store)
  assert.equal(answers.length, 1, 'the approve tier must land in the answer ledger too')
  assert.equal(answers[0]?.decision, 'approve')
  assert.equal(answers[0]?.provenance, 'user-question')
  assert.equal(answers[0]?.label, t('uiSign.signOption'), 'the recorded label is the option the host returned')
  assert.equal(answers[0]?.payloadSha256, signature.payloadSha256, 'both records must bind the same content hash')
  assert.equal(answers[0]?.answeredAt, signature.answeredAt, 'both records must carry the same answer time')
  assert.equal(signedEvents(), 1, 'an approval is exactly one gate/signed event')
})

// ————————————————————— AC-249：指纹本身含 seq 与 body —————————————————————

test('M203-02 (AC-249) signPayloadSha256 is deterministic and covers both seq and body', async () => {
  const { signPayloadSha256 } = await signatureApi()
  const base = signPayloadSha256({ seq: 7, body: 'review body' })
  assert.match(base, /^[0-9a-f]{64}$/u, 'signPayloadSha256 must return a sha256 hex digest')
  assert.equal(signPayloadSha256({ seq: 7, body: 'review body' }), base, 'same input must hash identically')
  assert.notEqual(signPayloadSha256({ seq: 8, body: 'review body' }), base, 'the journal seq must be part of the hash')
  assert.notEqual(signPayloadSha256({ seq: 7, body: 'review body!' }), base, 'the body must be part of the hash')
  // 从盘上读回的正文尾部多一个换行（`writeText` 会补），必须仍算出同一个指纹
  assert.equal(signPayloadSha256({ seq: 7, body: 'review body\n' }), base, 'trailing whitespace must be normalised')
  // 反例：归一化**只动尾部** —— 正文中间的空格变了，指纹就必须变（否则归一化会吃掉真改动）
  assert.notEqual(signPayloadSha256({ seq: 7, body: 'review  body' }), base, 'internal whitespace must stay significant')
})

// ————————————————————— 三档：拒绝 / 要求修改 各自可落账，且都不成签字 —————————————————————

test('M203-03 (AC-249) the decline and request-changes tiers land in the ledger without becoming signatures', async () => {
  const api = await signatureApi()
  const store = office.storeFor(WORKSPACE)
  const before = signedEvents()

  answerWith({ label: t('uiSign.declineOption') })
  await callTool('sdo_gate', { action: 'sign', gate: 'G2', channel: 'question' })
  const afterDecline = api.listSignAnswers(store)
  assert.equal(afterDecline.length, 1, 'the decline tier must land in the answer ledger')
  assert.equal(afterDecline[0]?.decision, 'reject', 'declining must be recorded as the reject tier')
  assert.equal(latestSignature(store, 'G2'), undefined, 'a decline must not create a signature record')

  answerWith({ label: t('uiSign.reviseOption') })
  await callTool('sdo_gate', { action: 'sign', gate: 'G2', channel: 'question' })
  const afterRevise = api.listSignAnswers(store)
  assert.equal(afterRevise.length, 2, 'all three tiers share one answer ledger')
  assert.equal(afterRevise[1]?.decision, 'revise', 'asking for changes must be recorded as the revise tier')
  assert.equal(latestSignature(store, 'G2'), undefined, 'a request for changes must not create a signature record')
  assert.equal(signedEvents(), before, 'neither tier may write a gate/signed event')
})

// ————————————————————— AC-248 / AC-250 / AC-252：拒收不可信作答（域层） —————————————————————

let scratch = ''
let scratchStore: SdoStore

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'sdo-m203-'))
  scratchStore = new SdoStore(join(scratch, '.sdo'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** 一条**可信**作答的基准入参（各用例只改可疑的那一项）。 */
const TRUSTED_ANSWER: Record<string, unknown> = {
  gate: 'G3',
  decision: 'approve',
  label: 'Sign and approve',
  payloadSha256: 'a'.repeat(64),
  answeredAt: '2026-10-20T00:00:00.000Z',
  provenance: 'user-question',
  channel: 'question',
  source: 'option',
}

/**
 * 跑一个"必须被拒"的作答：**必须抛错**、且错误文案来自指定的语言键。
 * 返回错误文案，供调用方继续断言"回执点名了什么"。
 */
function expectRefused(run: () => unknown, key: string): string {
  let message = ''
  try {
    run()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.ok(message !== '', `this answer must be refused (lang key ${key})`)
  const head = t(key).split('{p1}')[0] ?? ''
  assert.ok(message.includes(head), `the refusal must come from lang key ${key}: ${message}`)
  return message
}

/** 拒收之后台账必须**连文件都不存在**（"无写盘"的机械读数）。 */
function assertNoLedgerWrite(store: SdoStore): void {
  assert.equal(store.readText('gates', 'signatures.yml'), undefined, 'a refused answer must not create the ledger file')
}

test('M203-04 (AC-248) an answer that does not come from the question channel is refused and writes nothing', async () => {
  const api = await signatureApi()
  const message = expectRefused(
    () => api.recordSignAnswer(scratchStore, { ...TRUSTED_ANSWER, channel: 'command' }),
    'uiSignature.answerChannelRequired',
  )
  // 回执必须点名"来源不是问答通道"，并给出三条可执行出路（重试 / 先呈现再签 / 人工核）
  assert.ok(message.includes('channel=question'), 'the refusal must name the only accepted channel')
  assert.ok(message.includes(t('uiSignature.answerRemedies')), 'the refusal must carry the three ways out')
  assertNoLedgerWrite(scratchStore)
  assert.deepEqual(api.listSignAnswers(scratchStore), [], 'nothing may be readable back as an answer')
  // 反向对照（同一入口、只改通道）：问答通道的同一份作答**必须落账**
  const landed = api.recordSignAnswer(scratchStore, TRUSTED_ANSWER)
  assert.equal(landed.decision, 'approve', 'the same answer must be accepted once the channel is question')
  assert.equal(api.listSignAnswers(scratchStore).length, 1, 'the accepted answer must be readable back')
})

test('M203-05 (AC-248) an answer without a quoted basis is refused and writes nothing', async () => {
  const api = await signatureApi()
  expectRefused(() => api.recordSignAnswer(scratchStore, { ...TRUSTED_ANSWER, label: '   ' }), 'uiSignature.answerLabelRequired')
  assertNoLedgerWrite(scratchStore)
  // 认不出的档位同样是拒收（不许瞎记成某一档），且回执点名三个合法值
  const message = expectRefused(
    () => api.recordSignAnswer(scratchStore, { ...TRUSTED_ANSWER, decision: 'maybe' }),
    'uiSignature.answerDecisionUnknown',
  )
  for (const legal of ['approve', 'reject', 'revise']) {
    assert.ok(message.includes(legal), `the refusal must name the legal decision ${legal}`)
  }
  assertNoLedgerWrite(scratchStore)
})

test('M203-06 (AC-250) an answer without a click credential is refused and writes nothing', async () => {
  const api = await signatureApi()
  for (const provenance of ['prefilled-default', 'auto-answer', 'reused-answer', 'unknown', '']) {
    const message = expectRefused(
      () => api.recordSignAnswer(scratchStore, { ...TRUSTED_ANSWER, provenance }),
      'uiSignature.answerProvenanceRequired',
    )
    assert.ok(message.includes('user-question'), `the refusal must name the only trusted credential (${provenance})`)
    assert.ok(message.includes(t('uiSignature.answerRemedies')), `the refusal must carry the three ways out (${provenance})`)
  }
  assertNoLedgerWrite(scratchStore)
  // 正解对照（AC-253）：凭据齐备 ⇒ 落账，且四项可核字段都在
  const landed = api.recordSignAnswer(scratchStore, TRUSTED_ANSWER)
  assert.deepEqual(
    [landed.decision, landed.provenance, landed.payloadSha256, landed.answeredAt],
    ['approve', 'user-question', 'a'.repeat(64), '2026-10-20T00:00:00.000Z'],
    'the accepted answer must carry all four auditable fields',
  )
})

test('M203-07 (AC-252) a free-text answer is refused and writes nothing', async () => {
  const api = await signatureApi()
  expectRefused(
    () => api.recordSignAnswer(scratchStore, { ...TRUSTED_ANSWER, source: 'custom' }),
    'uiSignature.answerFreeText',
  )
  assertNoLedgerWrite(scratchStore)
  // 工具面同一条口径：自由文本作答不得变成签字，也不得进作答台账
  answerWith({ custom: 'looks fine to me' })
  const receipt = await callTool('sdo_gate', { action: 'sign', gate: 'G2', channel: 'question' })
  assert.equal(
    receipt,
    fmt('uiIndex.kSignCustomNoForce', { p1: gateLabel('G2'), p2: 'looks fine to me' }),
    'the receipt must say free text has no signing force',
  )
  assert.equal(signedEvents(), 0, 'a free-text answer must never sign anything')
  assert.equal(latestSignature(office.storeFor(WORKSPACE), 'G2'), undefined, 'a free-text answer must not land a signature')
  assert.deepEqual(api.listSignAnswers(office.storeFor(WORKSPACE)), [], 'free text is not one of the three tiers')
})

// ————————————————————— 接线：工具面与语言包两侧都对得上 —————————————————————

test('M203-08 (AC-248) wiring: the tool face passes the credentials and the question card offers three tiers', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  // ① 指纹取自**呈现给用户的那一份**（审核单全文 + 呈现时刻的 journal 序号），不是随手一个常量
  assert.ok(
    index.includes('signPayloadSha256({ seq: review.record.seq, body: review.full })'),
    'the payload hash must bind the presented review body and its journal seq',
  )
  // ② 四个凭据随签字一起进台账，且作答台账用的是**同一份**凭据
  for (const needle of ['decision,', 'payloadSha256,', 'answeredAt,', "provenance: 'user-question'"]) {
    assert.ok(index.includes(needle), `the tool face must pass ${needle} to the signature record`)
  }
  assert.ok(
    index.includes('recordSignAnswer(office.storeFor(office.requireWorkspace(call))'),
    'the answer ledger must be written through recordSignAnswer (the single trust gate)',
  )
  // ③ 作答时刻取自答案回来的那一刻
  assert.ok(index.includes('const answeredAt = new Date().toISOString()'), 'the answer time must be stamped by the tool')
  // ④ 第三档真的挂在问答卡上（否则 revise 永远不可能被选出来）
  assert.ok(index.includes("const reviseLabel = t('uiSign.reviseOption')"), 'the card must offer the request-changes tier')
  assert.ok(index.includes("description: t('uiSign.reviseCost')"), 'the third option must explain its consequence')
  // ⑤ 两份语言包都得有这些键（缺一侧就是半翻译）
  for (const pack of ['zh-CN.yml', 'en.yml']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'lang', pack), 'utf8')
    for (const key of [
      'reviseOption:',
      'reviseCost:',
      'answerChannelRequired:',
      'answerDecisionUnknown:',
      'answerLabelRequired:',
      'answerPayloadRequired:',
      'answerProvenanceRequired:',
      'answerFreeText:',
      'answerRemedies:',
      'answerBound:',
      'kSignRevise:',
      'kSignCustomNoForce:',
      'kSignAnswerBound:',
    ]) {
      assert.ok(text.includes(key), `${pack} is missing ${key}`)
    }
  }
})
