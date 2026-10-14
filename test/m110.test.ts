/**
 * M110 守卫（TASK-108 / DEF-065 拆出项）：`sdo_review action=append` —— 向**既有**评审追加 findings。
 *
 * 病因（DEF-065 拆出项，真机台账）：一条评审的发现项写入被宿主 schema 拒之后，只能**另起一条同 verdict
 * 的记录**来补录 ⇒ 一条评审在台账里碎成 9 条（`REV-044` 与 `REV-047…REV-054`），可读性与可追溯性双损。
 * 本动作让补录回到**同一条评审**上：只追加、不改写。
 *
 * 本文件钉四件事，且**至少一条走真实注册的工具面**（`apply()` 注册后宿主拿到的那个 `tool.execute`，
 * 不是另起一份手写的归一）：
 *   ① 追加后**条目数增加**、**verdict 不变**、**追加次数可回读**（落点三）
 *   ② 追加到**不存在的评审** ⇒ 可读拒绝，且与 ③ 的文案不同（落点二①）
 *   ③ 该评审**已有内容指纹且正文被改过** ⇒ 拒绝（落点二②）—— 追加不许把这次改动洗白
 *   ④ `findings` **为空 / 形状不对** ⇒ 拒绝，且文案与**宿主类型错**可区分（落点二③ + M109-03 口径）
 *
 * 红绿绑同一份被检文件：`src/domain/collab.ts`（`appendReviewFindings` 的落点）。
 * 本文件**不 import 任何新符号**：红侧靠真实工具面（旧实现里 `action=append` 落进 `list` 分支 ⇒ 逐条断言失败，
 * 而不是编译失败），绿侧同一份文件、同一个 harness 指纹。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { Journal } from '../src/infra/journal.js'
import { loadPackagedYaml } from '../src/infra/data.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { listReviews } from '../src/domain/records.js'
import { reviewAdoption } from '../src/domain/reviewVerification.js'
import { REVIEW_ACTIONS } from '../src/types.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SdoConfig } from '../src/config.js'
import type { Review } from '../src/domain/records.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm110')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}

/** 真实装配 + 按 schema 过滤入参（与 m48 同一口径：宿主拿到的就是它）。 */
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

const sdoDir = (): string => join(BASE, '.sdo')
const storeOf = (): SdoStore => new SdoStore(sdoDir())
const journalOf = (): Journal => new Journal(storeOf())
/** 回读一条评审**文件**（台账真源在 `.sdo/reviews/REV-*.yml`）。 */
const reviewOf = (id: string): Review | undefined => listReviews(storeOf()).find((item) => item.id === id)
/** 回读追加留痕（append-only 事件流）。`String()` 是为了红侧也编译得过：事件词表里还没有这个类型时不该编译失败。 */
const appendEvents = (id: string): { data: Record<string, unknown> }[] =>
  journalOf().read().events.filter((event) => String(event.type) === 'review/appended' && String(event.data['id'] ?? '') === id)
  .map((event) => ({ data: event.data as Record<string, unknown> }))

/** 记一条评审并回读它的 id（走真实工具面）。 */
async function recordReview(
  callTool: (name: string, args: Record<string, unknown>, sessionId: string) => Promise<string>,
  sessionId: string,
  findings: string,
): Promise<string> {
  const receipt = await callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'subagent:reviewer:2', verdict: 'changes-requested', findings,
  }, sessionId)
  const id = /REV-\d+/u.exec(receipt)?.[0]
  assert.ok(id !== undefined, `前置：评审要真的记下来：${receipt}`)
  return id
}

let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-dev', BASE)
  office.noteSession('s-other', BASE)
  writeCard('TASK-001', 'developer')
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M110-01 ①（真实工具面）追加后条目数增加、verdict 不变、追加次数可回读', async () => {
  const { callTool } = toolHarness(BASE)
  await callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'dev-a', expectedRevision: 1 }, 's-dev')
  const id = await recordReview(callTool, 's-other', '["f1","f2"]')

  const recorded = reviewOf(id)
  assert.deepEqual(recorded?.findings, ['f1', 'f2'], '前置：原评审两条发现')

  // 第一次追加：JSON 文本形态（真机就是这条形态被拒后被迫另起记录的）
  const first = await callTool('sdo_review', { action: 'append', id, findings: '["f3","f4"]' }, 's-other')
  assert.match(first, new RegExp(id, 'u'), `追加回执要点名评审 id：${first}`)
  assert.match(first, /追加/u, `回执要写明这是追加：${first}`)
  assert.doesNotMatch(first, /❌|⛔/u, `合法追加不得给拒绝文案：${first}`)

  const afterFirst = reviewOf(id)
  assert.equal(afterFirst?.findings.length, 4, `① 条目数必须增加（2 → 4）：${JSON.stringify(afterFirst?.findings)}`)
  assert.deepEqual(afterFirst?.findings.slice(0, 2), ['f1', 'f2'], '① 已有正文必须**原样**保留（只追加不改写）')
  assert.equal(afterFirst?.verdict, 'changes-requested', '① verdict 是原评审的结论，追加不得改它')

  // 追加留痕：第几次、追加了哪些 —— 都能从 append-only 的事件里读回来
  const events1 = appendEvents(id)
  assert.equal(events1.length, 1, '一次追加 = 一条 `review/appended` 事件')
  assert.equal(events1[0]?.data['appendCount'], 1, '留痕要能看出**第几次**追加')
  assert.deepEqual(events1[0]?.data['appendedFindings'], ['f3', 'f4'], '留痕要能看出**追加了哪些**')
  assert.equal(events1[0]?.data['fromIndex'], 2, '留痕要能看出追加从第几条（台账 0 起）开始')
  assert.equal(events1[0]?.data['verdict'], 'changes-requested', '留痕里的 verdict 只回显原结论')

  // 第二次追加：次数递增、可回读
  const second = await callTool('sdo_review', { action: 'append', id, findings: ['f5'] }, 's-other')
  assert.match(second, /2/u, `第二次追加的回执要点名次数：${second}`)
  assert.equal(reviewOf(id)?.findings.length, 5, '第二次追加后条目数继续增加')
  const events2 = appendEvents(id)
  assert.equal(events2.length, 2)
  assert.equal(events2[1]?.data['appendCount'], 2, '① 追加次数可回读（第 2 次）')
  assert.equal(events2[1]?.data['fromIndex'], 4)
  assert.equal(reviewOf(id)?.verdict, 'changes-requested', '① 多次追加后 verdict 仍不变')
})

test('M110-02 ②（真实工具面）追加到**不存在**的评审 ⇒ 可读拒绝，且与其它拒绝文案不同', async () => {
  const { callTool } = toolHarness(BASE)
  const missing = await callTool('sdo_review', { action: 'append', id: 'REV-999', findings: '["f1"]' }, 's-dev')
  assert.match(missing, /REV-999/u, `拒绝要点名那条不存在的评审：${missing}`)
  assert.match(missing, /❌|⛔/u, `拒绝要是可读的失败文案：${missing}`)
  assert.equal(appendEvents('REV-999').length, 0, '被拒的追加不许留事件（不许"半写"）')
  assert.equal(reviewOf('REV-999'), undefined, '被拒的追加不许建出评审文件')
})

test('M110-03 ③（真实工具面）已有指纹且正文被改过 ⇒ 拒绝，不许把这次改动洗白', async () => {
  const { callTool } = toolHarness(BASE)
  await callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'dev-a', expectedRevision: 1 }, 's-dev')
  const id = await recordReview(callTool, 's-other', '["f1","f2"]')

  // 手改 verdict（真机手法：把 `changes-requested` 改成 `pass`，再补一套核实就想凭空造出通过评审）
  const store = storeOf()
  const wrap = store.readYaml<{ review: Review }>('reviews', `${id}.yml`)
  assert.ok(wrap !== undefined, `前置：评审文件存在（${id}.yml）`)
  store.writeYaml(['reviews', `${id}.yml`], { review: { ...wrap.review, verdict: 'pass' } })
  assert.equal(reviewAdoption(store, journalOf(), { ...wrap.review, verdict: 'pass' }).state, 'tampered',
    '前置：手改 verdict 之后，采纳判定要判 `tampered`（否则本用例的拒绝路径不可达）')

  const tampered = await callTool('sdo_review', { action: 'append', id, findings: '["f3"]' }, 's-other')
  assert.match(tampered, /⛔|❌/u, `被改过的评审必须拒绝追加：${tampered}`)
  assert.equal(appendEvents(id).length, 0, '③ 被拒的追加不许留事件')
  const after = reviewOf(id)
  assert.deepEqual(after?.findings, ['f1', 'f2'], '③ 被拒后正文不得被追加（不许"先写后拒"）')
  assert.equal(after?.verdict, 'pass', '③ 被拒后连那次手改也不许被抹掉（留证，不洗白）')
})

test('M110-04 ④ findings 为空 / 形状不对的拒绝文案与宿主类型错可区分（M109-03 口径）', async () => {
  const { callTool } = toolHarness(BASE)
  await callTool('sdo_task', { action: 'claim', id: 'TASK-001', owner: 'dev-a', expectedRevision: 1 }, 's-dev')
  const id = await recordReview(callTool, 's-other', '["f1"]')

  const missing = await callTool('sdo_review', { action: 'append', id: 'REV-404', findings: '["f1"]' }, 's-other')
  const empty = await callTool('sdo_review', { action: 'append', id, findings: '[]' }, 's-other')
  const blank = await callTool('sdo_review', { action: 'append', id, findings: '["   "]' }, 's-other')
  const shape = await callTool('sdo_review', { action: 'append', id, findings: '{"a":1}' }, 's-other')

  for (const [label, text] of [['空数组', empty], ['全空白', blank], ['形状', shape]] as const) {
    assert.match(text, /❌|⛔/u, `${label} 必须被拒：${text}`)
    assert.equal(appendEvents(id).length, 0, `${label} 被拒后不许留事件`)
    assert.deepEqual(reviewOf(id)?.findings, ['f1'], `${label} 被拒后正文不得变`)
  }
  // 三条拒绝（不存在 / 为空 / 形状）文案必须**互不相同** —— 混成一句就等于没有分辨能力
  assert.notEqual(empty, missing, '「为空」与「不存在」必须是两条不同的话')
  assert.notEqual(shape, missing, '「形状不对」与「不存在」必须是两条不同的话')
  assert.notEqual(shape, empty, '「形状不对」与「为空」必须是两条不同的话')

  // 宿主侧类型错的原文（DEF-065 落点一的对照样本，逐字留档）：插件侧文案不得混入这套判据词
  const hostText = 'invalid arguments: "findings" must be a string'
  for (const [label, text] of [['为空', empty], ['形状', shape]] as const) {
    assert.doesNotMatch(text, /invalid arguments/u, `插件侧 ${label} 文案不得出现宿主的 invalid arguments：${text}`)
    assert.doesNotMatch(text, /must be a string/u, `插件侧 ${label} 文案不得出现宿主的类型错判据：${text}`)
  }
  assert.doesNotMatch(hostText, /形状不对|为空/u, '宿主文案不应出现插件侧的分流词')
})

test('M110-05 ⑤ 词表单一来源 + 语言包中英对齐（新增文案两边都在）', async () => {
  // 动作词表只有 `src/types.ts` 一处（不许在 collab.ts 另造第二份）
  assert.ok(REVIEW_ACTIONS.includes('append'), 'REVIEW_ACTIONS 必须含 append')
  const collab = readFileSync(join(ROOT, 'src', 'domain', 'collab.ts'), 'utf8')
  assert.doesNotMatch(collab, /REVIEW_ACTIONS\s*=/u, 'collab.ts 不得另造动作词表（唯一来源是 types.ts）')

  // 工具 schema 的动作描述由词表生成 ⇒ 描述里必须出现 append（登记即同步）
  const tools = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  assert.match(tools, /actionList\(REVIEW_ACTIONS\)/u, 'sdo_review 的 action 描述必须由 REVIEW_ACTIONS 生成（不手抄）')

  // 语言包：新增的四条拒绝文案 + 两条回执文案，中英都必须有
  const zh = loadPackagedYaml<Record<string, Record<string, string>>>('src/data/lang/zh-CN.yml')
  const en = loadPackagedYaml<Record<string, Record<string, string>>>('src/data/lang/en.yml')
  const keys: [string, string][] = [
    ['uiReview', 'appendNoReview'],
    ['uiReview', 'appendTampered'],
    ['uiReview', 'appendEmpty'],
    ['uiReview', 'appendBadShape'],
    ['uiIndex', 'kReviewAppendNoId'],
    ['uiIndex', 'kReviewAppended'],
  ]
  for (const [section, key] of keys) {
    const zhText = (zh[section] ?? {})[key]
    const enText = (en[section] ?? {})[key]
    assert.ok(typeof zhText === 'string' && zhText.trim() !== '', `zh-CN.yml 缺 ${section}.${key}`)
    assert.ok(typeof enText === 'string' && enText.trim() !== '', `en.yml 缺 ${section}.${key}`)
  }
})
