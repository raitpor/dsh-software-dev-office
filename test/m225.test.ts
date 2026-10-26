/**
 * **`TASK-186` 变更增量推送的守卫**（可观测性②）—— 「自上次读到以来，变了什么？」
 *
 * 病灶（卡上的问题陈述）：子代理交付后，**没有任何工具主动说「变了什么」**。它的报告是自由文本，
 * 驾驶舱只能信或不信；想知道「自上次我读到以来变了什么」，只能把整本台账重扫一遍再复算。
 *
 * 本文件钉四件事，每一件都是**双态**（正例 + 反例），免得守卫本身恒绿：
 *
 *   M225-01 **守卫①**：构造 3 条卡状态变化 ⇒ 增量里**逐条出现**，且顺序是 **seq 升序**
 *            （反例：同一本台账把指针推到头部，`changed=0`）；顺序断言用"追加序 ≠ id 序"的夹具，
 *            否则"按 id 排序"也能骗过这条。
 *   M225-02 **守卫②**：给一个**未来**的 seq ⇒ 返回**空**并**明说无变化**，不报错、不编造
 *            （反例：同一个函数给一个过去/零指针 ⇒ 非空）。中英两种语言各断一次（空读数那句话是本地标签表）。
 *   M225-03 **守卫③**：只改一张卡的 DoD（非状态）⇒ 增量里**不出现**它（状态变化与内容修改分栏）
 *            （反例：同一张卡再认领一次 ⇒ 它必须出现在状态变化栏里）。
 *   M225-04 **口径①②**：增量只认 **journal 事件**（把 `project.json` 与卡文件改成谎，读数逐字节不变）；
 *            起点**必须**由调用方给（缺/认不出 ⇒ 可读拒绝，工具不猜）。
 *   M225-05 **两类提示**：本轮未结算的派发 / 证据缺失的 done —— 各有一条正例与一条反例。
 *   M225-06 `since` 收 **ISO 时间**：折成"该时刻之前（含）的最后一个 seq"，未来时刻 ⇒ 空增量。
 *
 * 纪律：断言消息一律英文、中文只写在断言**之外**（本文件不进 `KNOWN_PROSE_GAP`）——
 * 连"中文证据串"也不许进断言实参，否则散文棘轮会把它记成一个未登记站点。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { updateTask } from '../src/domain/collab.js'
import { renderChangeFeed } from '../src/domain/changeFeed.js'
import type { ChangeFeed } from '../src/domain/changeFeed.js'
import { setLocale } from '../src/domain/i18n.js'
import { candidateQueue, classifyNonDispatchable, createTask, listTasks, readyTasks, writeTask } from '../src/domain/plan.js'
import { attributeRole, listRoleCards, officeAllowFace, publicWritePathsFor, toolAllowList } from '../src/domain/roles.js'
import { evaluateWriteScope } from '../src/domain/writeScope.js'
import { renderStatusBlock } from '../src/interface/inject.js'
import * as orchestrator from '../src/integration/orchestrator.js'
import { roleToolFilter } from '../src/integration/orchestrator.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { Journal } from '../src/infra/journal.js'
import type { SdoStore } from '../src/infra/store.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m225/', import.meta.url))

/** 汉字字形判定（语言中立性用；与既有守卫同一口径）。 */
const CJK = /[\u4e00-\u9fff]/u

interface Fixture {
  office: SoftwareDevOffice
  call: OfficeCall
  workspace: string
  journal: Journal
  store: SdoStore
}

/** 一台真实的办公室（真 `SdoStore` + 真 `Journal`）—— 读数必须是**现算**的。 */
function fixture(name: string): Fixture {
  const workspace = join(BASE, name)
  // 每条用例用自己的干净台账：不清就会继承上一轮的卡（id 顺延、seq 漂移，断言随之失真）
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const sessionId = `s225-${name}`
  office.noteSession(sessionId, workspace)
  const call = { sessionId, cwd: workspace } as unknown as OfficeCall
  office.init(call, { name: `M225 ${name}`, scale: 'normal', stakeholders: ['stakeholder'] })
  return { office, call, workspace, journal: office.journalFor(workspace), store: office.storeFor(workspace) }
}

/** 造一张计划中的卡（真 `createTask` ⇒ 真 `task/created` 事件）。 */
function card(f: Fixture, name: string): TaskCard {
  return createTask(f.store, f.journal, {
    title: `card ${name}`,
    goal: 'g',
    dod: ['d'],
    role: 'developer',
    size: 'small',
    writeScopes: [`src/${name}.ts`],
  } as never)
}

/** 台账头部 seq（夹具里算"未来指针"用）。 */
function head(f: Fixture): number {
  let max = 0
  for (const event of f.journal.read().events) if (event.seq > max) max = event.seq
  return max
}

/**
 * 追加一条**带指定时刻**的事件（`at` 由夹具给）。
 *
 * 为什么需要它：`since` 的 ISO 形态要折算成 seq，而 `journal.append` 的时刻由系统时钟给 ——
 * 同一毫秒里连着写几条，ISO 指针就分不开它们。夹具自己给时刻，才能断言"折到哪一条"。
 */
function appendAt(f: Fixture, at: string, type: string, data: Record<string, unknown>): number {
  const seq = head(f) + 1
  f.store.appendLine(['journal.jsonl'], JSON.stringify({ seq, at, actor: 'test', type, data }))
  return seq
}

/** 取增量（夹具断言"必须是成功形态"，失败就把可读拒绝原样抛出来）。 */
function feedOf(f: Fixture, since: string | undefined): ChangeFeed {
  const result = f.office.changeFeed(f.call, since)
  if (!result.ok) assert.fail(`changeFeed refused: ${result.detail}`)
  return result.feed
}

/* ———————————————————————————————— 守卫① 逐条 + seq 升序 ———————————————————————————————— */

test('M225-01 (guard 1, two-state) three status changes appear one by one in seq ascending order', () => {
  const f = fixture('order')
  const a = card(f, 'a')
  const b = card(f, 'b')
  const c = card(f, 'c')
  const since = head(f)
  // 追加序故意**不等于** id 序：b → c → a（否则"按 id 排序"也能骗过下面的顺序断言）
  const seqB = f.journal.append('task/claimed', { id: b.id, owner: 'dev-b', revision: 2, sessionId: 'dev-b' }).seq
  const seqC = f.journal.append('task/claimed', { id: c.id, owner: 'dev-c', revision: 2, sessionId: 'dev-c' }).seq
  const seqA = f.journal.append('task/done', { id: a.id, owner: 'dev-a', evidence: 2, note: '' }).seq
  assert.ok(seqB < seqC && seqC < seqA, 'fixture premise: the append order is b < c < a in journal seq')

  const feed = feedOf(f, String(since))
  // ① 逐条出现（三条都在），且**顺序 = seq 升序**（不是 id 升序）
  assert.deepEqual(feed.changes.map((row) => row.id), [b.id, c.id, a.id], 'every change must appear, ordered by seq')
  assert.deepEqual(feed.changes.map((row) => row.seq), [seqB, seqC, seqA], 'the increment must be seq ascending')
  assert.deepEqual(feed.changes.map((row) => `${row.from}->${row.to}`), ['planned->in-progress', 'planned->in-progress', 'planned->done'])
  assert.deepEqual(feed.changes.map((row) => row.owner), ['dev-b', 'dev-c', 'dev-a'], 'the owner after the change must be reported')
  assert.deepEqual(feed.changes.map((row) => row.event), ['task/claimed', 'task/claimed', 'task/done'], 'the event type must be reported')
  for (const row of feed.changes) assert.equal(row.at.length > 0, true, 'the event timestamp must be reported')

  // ② 渲染里也逐条一行（同一份读数，不是另算一遍），且先后顺序与结构一致
  const text = renderChangeFeed(feed)
  const atB = text.indexOf(`- ${b.id} planned->in-progress`)
  const atC = text.indexOf(`- ${c.id} planned->in-progress`)
  const atA = text.indexOf(`- ${a.id} planned->done`)
  assert.ok(atB >= 0 && atC >= 0 && atA >= 0, `every change must render as one line: ${text}`)
  assert.ok(atB < atC && atC < atA, `the rendered lines must keep seq ascending order: ${text}`)
  assert.ok(text.startsWith(`changes since=seq:${String(since)} `), `the header must echo the pointer verbatim: ${text}`)

  // ③ **两态的另一半**：同一本台账把指针推到头部 ⇒ changed=0（三条不是"恒在"）
  const headFeed = feedOf(f, String(head(f)))
  assert.equal(headFeed.changes.length, 0, 'the same ledger with the pointer at the head must report zero changes')
  assert.ok(renderChangeFeed(headFeed).includes('changed=0'), 'the empty reading must say changed=0')
})

/* ———————————————————————————————— 守卫② 未来指针 ⇒ 空 + 明说 ———————————————————————————————— */

test('M225-02 (guard 2, two-state) a future seq yields an empty increment that says no changes (not an error)', () => {
  const f = fixture('future')
  const a = card(f, 'a')
  f.journal.append('task/claimed', { id: a.id, owner: 'dev-a', revision: 2, sessionId: 'dev-a' })
  const real = head(f)
  const future = real + 50

  const result = f.office.changeFeed(f.call, String(future))
  // 不许报错：未来指针只是"没有增量"
  assert.equal(result.ok, true, 'a future seq must NOT be an error')
  if (!result.ok) return
  const feed = result.feed
  assert.equal(feed.changes.length, 0, 'a future seq must yield zero status changes')
  assert.equal(feed.unsettled.length, 0, 'a future seq must yield zero unsettled dispatches')
  assert.equal(feed.unevidenced.length, 0, 'a future seq must yield zero done-without-evidence')
  assert.equal(feed.contentEdits.length, 0, 'a future seq must yield zero content edits')
  // **不编造**：头部 seq 是台账的事实（不是被指针顶上去的）
  assert.equal(feed.headSeq, real, 'the head seq must stay the ledger fact, never the caller pointer')
  assert.equal(feed.query.seq, future, 'the folded pointer must be echoed as given')

  // 明说"无变化"：首行是 ASCII 读数，第二行是那句话（中英各一份本地标签表）
  const zhText = renderChangeFeed(feed)
  const zhLines = zhText.split('\n')
  assert.ok(zhLines[0]?.includes(`changed=0`), `the header must carry the ASCII reading: ${zhText}`)
  assert.ok(zhLines[1]?.startsWith(`seq ${String(future)} `), `the second line must name the pointer and say no changes: ${zhText}`)
  setLocale('en')
  try {
    const enLines = renderChangeFeed(feed).split('\n')
    assert.ok(enLines[1]?.startsWith('no changes'), `under en the second line must say no changes: ${enLines.join(' | ')}`)
    assert.equal(CJK.test(renderChangeFeed(feed)), false, 'the en reading must stay CJK-free')
  } finally {
    setLocale('zh-CN')
  }

  // **两态的另一半**：同一个函数给零指针 ⇒ 非空（"空"不是因为它永远空）
  const fromZero = feedOf(f, '0')
  assert.ok(fromZero.changes.length > 0, 'a zero pointer must report the ledger history (otherwise emptiness proves nothing)')
})

/* ———————————————————————————————— 守卫③ 内容修改不进状态变化 ———————————————————————————————— */

test('M225-03 (guard 3, two-state) a DoD-only edit never shows up in the status increment', () => {
  const f = fixture('dod')
  const a = card(f, 'a')
  const b = card(f, 'b')
  const since = head(f)
  // 窗口里**确实有一条状态变化**（另一张卡）：否则"增量里没有它"只是因为增量整份是空的
  const claimedSeq = f.journal.append('task/claimed', { id: b.id, owner: 'dev-b', revision: 2, sessionId: 'dev-b' }).seq
  const edited = updateTask(f.store, f.journal, { taskId: a.id, by: 'cockpit', dod: ['d', 'd2'] })
  assert.equal(edited.ok, true, 'fixture premise: the DoD edit must succeed')
  const updated = f.journal.read().events.filter((event) => event.type === 'task/updated').at(-1)
  assert.deepEqual(updated?.data['fields'], ['dod'], 'fixture premise: the edit only touches dod')

  const feed = feedOf(f, String(since))
  // ① 状态变化栏里**不出现**它（内容修改不是状态迁移），但另一张卡的状态变化照常在
  assert.deepEqual(feed.changes.map((row) => `${row.id}@${String(row.seq)}`), [`${b.id}@${String(claimedSeq)}`], 'only the real status change may appear')
  assert.equal(feed.changes.filter((row) => row.id === a.id).length, 0, 'a dod-only edit must not appear as a status change')
  const text = renderChangeFeed(feed)
  // 状态变化行的形状是 `- <id> <from>-><to> …`；只判这一形态（内容行没有 `->`）
  assert.equal(text.split('\n').some((line) => line.includes(a.id) && line.includes('->')), false, `no status-change line may mention the edited card: ${text}`)

  // ② 但它是"内容修改"：**单独一栏**报出来（两栏分开，这才是口径③要的"不淹没"）
  assert.deepEqual(feed.contentEdits.map((row) => ({ id: row.id, fields: row.fields })), [{ id: a.id, fields: ['dod'] }], 'the content edit must be reported in its own section')
  const lines = text.split('\n')
  const contentRow = lines.findIndex((line) => line.startsWith(`- ${a.id} edits=1`))
  assert.equal(contentRow >= 0, true, `the content edit must render in its own row: ${text}`)
  // 那一行必须在**状态变化栏之后**（两栏分开：先状态、后内容），且栏名在 en 下明说"不是状态变化"
  const lastChangeRow = lines.map((line) => line.startsWith('- ') && line.includes('->')).lastIndexOf(true)
  assert.ok(lastChangeRow < contentRow, `the content row must come after the status rows: ${text}`)
  setLocale('en')
  try {
    const en = renderChangeFeed(feed)
    assert.ok(en.includes('NOT status changes'), `under en the content section must say it is not a status change: ${en}`)
    assert.equal(CJK.test(en), false, 'the en reading must stay CJK-free')
  } finally {
    setLocale('zh-CN')
  }

  // ③ **两态的另一半**：同一张卡真的改状态 ⇒ 它必须出现在状态变化栏里（"缺席"不是这张卡的宿命）
  const seq = f.journal.append('task/claimed', { id: a.id, owner: 'dev-a', revision: 3, sessionId: 'dev-a' }).seq
  const after = feedOf(f, String(since))
  assert.deepEqual(after.changes.map((row) => row.id), [b.id, a.id], 'a real status change must appear after the content edit')
  assert.equal(after.changes[1]?.seq, seq, 'the new change must carry its own seq')
  assert.equal(after.changes[1]?.from, 'planned', 'the pre-status must come from the events before the pointer window')
})

/* ———————————————————————————————— 口径① 只认真源事件 ———————————————————————————————— */

test('M225-04 (caliber 1) the increment reads journal events, not the projection or the card file', () => {
  const f = fixture('truth')
  const a = card(f, 'a')
  const b = card(f, 'b')
  const since = head(f)
  f.journal.append('task/claimed', { id: a.id, owner: 'dev-a', revision: 2, sessionId: 'dev-a' })
  f.journal.append('task/done', { id: b.id, owner: 'dev-b', evidence: 1, note: '' })

  const truth = feedOf(f, String(since))
  assert.equal(truth.changes.length, 2, 'fixture premise: two status changes in the window')

  // 把**派生投影**改成谎：说两张卡都 dropped（真源里它们分别是 in-progress / done）
  f.store.writeJson(['project.json'], { name: 'lie', phase: 'delivery', tasks: [] })
  const afterLie = feedOf(f, String(since))
  assert.deepEqual(afterLie.changes, truth.changes, 'the projection must not influence the increment')
  assert.equal(renderChangeFeed(afterLie), renderChangeFeed(truth), 'the rendered reading must be byte-identical')

  // 再把**卡文件**改成谎（手可编辑面）：读数仍只跟事件走
  for (const task of listTasks(f.store)) writeTask(f.store, { ...task, status: 'dropped' })
  const afterCardLie = feedOf(f, String(since))
  assert.deepEqual(afterCardLie.changes, truth.changes, 'the card yaml must not influence the increment either')

  // 投影**整个删掉**也不影响（AC-006：投影可重建，不是真源）
  rmSync(join(f.workspace, '.sdo', 'project.json'), { force: true })
  assert.deepEqual(feedOf(f, String(since)).changes, truth.changes, 'deleting the projection must not change the increment')
})

test('M225-05 (caliber 2) the start pointer is required; the tool never guesses it', () => {
  const f = fixture('pointer')
  card(f, 'a')
  f.journal.append('task/claimed', { id: 'TASK-1', owner: 'dev-a', revision: 2, sessionId: 'dev-a' })

  for (const [label, value] of [['undefined', undefined], ['blank', '   '], ['garbage', 'long-ago']] as const) {
    const result = f.office.changeFeed(f.call, value)
    assert.equal(result.ok, false, `a ${label} pointer must be refused (never guessed)`)
    if (result.ok) continue
    assert.ok(result.detail.length > 0, `the refusal must be readable (${label})`)
    assert.ok(result.detail.includes('since'), `the refusal must name the missing parameter (${label}): ${result.detail}`)
  }
  const garbage = f.office.changeFeed(f.call, 'long-ago')
  assert.equal(garbage.ok === false && garbage.detail.includes('long-ago'), true, 'the refusal must echo the unreadable pointer')

  // 两态：给了合法指针就**不是**拒绝
  const legal = f.office.changeFeed(f.call, '0')
  assert.equal(legal.ok, true, 'a legal pointer must be accepted')
  // 拒绝形态**只**是 `{ok:false, detail}`：成功形态里没有 detail，失败形态里没有 feed
  assert.equal(legal.ok === true && legal.feed.changes.length > 0, true, 'a legal pointer must really report the history')
  const refused = f.office.changeFeed(f.call, undefined)
  assert.equal(refused.ok === false && Object.hasOwn(refused, 'feed'), false, 'a refusal must not carry a feed')
})

/* ———————————————————————————————— 两类提示 ———————————————————————————————— */

test('M225-06 (hint A) unsettled dispatches are named; settled ones are not', () => {
  const f = fixture('unsettled')
  const a = card(f, 'a')
  const b = card(f, 'b')
  const since = head(f)
  const startedAt = '2026-10-24T01:00:00.000Z'
  const openSeq = f.journal.append('dispatch/started', {
    task: a.id, provider: 'spawn', childSessionId: 'aa11bb22', tools: 3,
  }).seq
  f.journal.append('dispatch/started', { task: b.id, provider: 'spawn', childSessionId: 'cc33dd44', tools: 3 })
  f.journal.append('dispatch/finished', {
    childSessionId: 'cc33dd44', task: b.id, role: 'developer', turn: 1, reason: 'completed',
    startedAt, finishedAt: '2026-10-24T01:10:00.000Z', durationMs: 600000, report: 'r.md',
  })

  const feed = feedOf(f, String(since))
  assert.deepEqual(feed.unsettled.map((row) => row.childSessionId), ['aa11bb22'], 'only the unsettled dispatch may be named')
  assert.equal(feed.unsettled[0]?.taskId, a.id, 'the unsettled dispatch must name its card')
  assert.equal(feed.unsettled[0]?.seq, openSeq, 'the unsettled dispatch must carry the started seq')
  assert.ok(renderChangeFeed(feed).includes('child=aa11bb22'), 'the rendered reading must name the child session')

  // 两态：把指针推到头部 ⇒ 这笔派发不在窗口里，不再重复报
  assert.equal(feedOf(f, String(head(f))).unsettled.length, 0, 'a pointer at the head must not re-report old dispatches')
})

test('M225-07 (hint B) a done without evidence is named; an evidenced one is not', () => {
  const f = fixture('evidence')
  const a = card(f, 'a')
  const b = card(f, 'b')
  const since = head(f)
  const bareSeq = f.journal.append('task/done', { id: a.id, owner: 'dev-a', evidence: 0, note: '' }).seq
  f.journal.append('task/done', { id: b.id, owner: 'dev-b', evidence: 2, note: '' })

  const feed = feedOf(f, String(since))
  assert.deepEqual(feed.unevidenced.map((row) => row.taskId), [a.id], 'only the done without evidence may be named')
  assert.equal(feed.unevidenced[0]?.seq, bareSeq, 'the hint must carry the done seq for re-checking')
  assert.ok(renderChangeFeed(feed).includes('evidence=0'), 'the rendered hint must state the evidence count')

  // 两态：**没有这个键**的老事件不算"缺证据"（读不出 ≠ 是 0）
  const legacy = fixture('evidence-legacy')
  const c = card(legacy, 'c')
  legacy.journal.append('task/done', { id: c.id, owner: 'dev-c', note: '' })
  assert.equal(feedOf(legacy, '0').unevidenced.length, 0, 'a done event without the evidence key must not be reported as missing evidence')
})

/* ———————————————————————————————— ISO 指针 ———————————————————————————————— */

test('M225-08 (pointer form) an ISO pointer folds to the last seq at or before that instant', () => {
  const f = fixture('iso')
  const a = card(f, 'a')
  const since = head(f)
  const at1 = '2026-01-01T00:00:01.000Z'
  const at2 = '2026-01-01T00:00:02.000Z'
  const at3 = '2026-01-01T00:00:03.000Z'
  appendAt(f, at1, 'task/claimed', { id: a.id, owner: 'dev-a', revision: 2, sessionId: 'dev-a' })
  const seq2 = appendAt(f, at2, 'task/blocked', { id: a.id, owner: 'dev-a', reason: 'r' })
  const seq3 = appendAt(f, at3, 'task/unblocked', { id: a.id, by: 'cockpit', reason: 'ok', blockedReason: 'r', previousOwner: 'dev-a' })

  // 折到第二条事件（含）⇒ 只报第三条
  const mid = feedOf(f, at2)
  assert.equal(mid.query.kind, 'at', 'an ISO pointer must be recognised as such')
  assert.equal(mid.query.seq, seq2, 'the ISO pointer must fold to the last event at or before that instant')
  assert.deepEqual(mid.changes.map((row) => row.seq), [seq3], 'only events strictly after the folded seq are reported')

  // 两态：早于一切的时刻 ⇒ 折成 0 ⇒ 全部；未来时刻 ⇒ 空 + 明说
  const all = feedOf(f, '1970-01-01T00:00:00.000Z')
  assert.equal(all.query.seq, 0, 'an instant before the ledger must fold to zero')
  // 从零读：`task/created` 也是一次迁移（`none -> planned`），加上构造的三条 = 4
  assert.equal(all.changes.length, 4, 'from zero the whole history is the increment (creation counts as none->planned)')
  const future = feedOf(f, '2999-01-01T00:00:00.000Z')
  assert.equal(future.changes.length, 0, 'a future instant must yield an empty increment')
  assert.ok(renderChangeFeed(future).includes('changed=0'), 'the empty ISO reading must say changed=0')
  // 头部 seq 始终是台账事实
  assert.equal(future.headSeq, seq3, 'the head seq must stay the ledger fact for ISO pointers too')
  assert.ok(since < seq2, 'fixture premise: the pointer window starts before the crafted events')
})

/* ———————————————————————————————— 工具面接线（走真实注册面） ———————————————————————————————— */

/**
 * **真实注册面**（与 `test/m105.test.ts` 同款）：`apply()` 之后取 `sdo_status`，用 agent 桩把工作区
 * 指到夹具目录再调它。这一层必须走注册面 —— 真机教训是"导出函数绿了但工具面拿不到"。
 */
interface ToolDefinition {
  name: string
  parameters: { properties?: Record<string, unknown> }
  execute(args: unknown, exec: unknown): unknown
}

/** 装配一套假 ctx，拿回注册进宿主的工具表。 */
function registeredTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>()
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition): (() => void) => { tools.set(tool.name, tool); return () => {} } },
    commands: { register: (): (() => void) => () => {} },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  return tools
}

/** 按**声明面**过滤实参（宿主在 schema 阶段就是这么做的；未声明的键不会到达 execute）。 */
function callTool(tool: ToolDefinition, workspace: string, args: Record<string, unknown>): string | Promise<string> {
  const properties = tool.parameters.properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agent = { id: 's225-tool', session: { header: { id: 's225-tool', cwd: workspace, delegationDepth: 0 } } }
  return Promise.resolve(tool.execute(filtered, { agent } as never) as string | Promise<string>)
}

test('M225-09 (tool face) sdo_status declares `since`, and the increment comes out of the registered tool', async () => {
  const f = fixture('tool-face')
  const a = card(f, 'a')
  const since = head(f)
  const seq = f.journal.append('task/claimed', { id: a.id, owner: 'dev-a', revision: 2, sessionId: 'dev-a' }).seq
  const tools = registeredTools()
  const status = tools.get('sdo_status')
  assert.ok(status !== undefined, 'sdo_status must be registered')
  if (status === undefined) return
  // ① 参数面**声明**了 `since`（否则模型看不见这条入口 —— 声明面就是可发现性）
  assert.equal(Object.hasOwn(status.parameters.properties ?? {}, 'since'), true, 'sdo_status must declare the since parameter')

  // ② 带 since ⇒ 增量读数（走 deps.changes）
  const increment = await callTool(status, f.workspace, { since: String(since) })
  assert.ok(increment.startsWith(`changes since=seq:${String(since)} `), `the tool must return the increment header: ${increment}`)
  assert.ok(increment.includes(`- ${a.id} planned->in-progress`), `the increment must carry the change line: ${increment}`)
  assert.ok(increment.includes(`seq=${String(seq)}`), `the increment must carry the seq anchor: ${increment}`)

  // ③ 不带 since ⇒ 原来的整份状态（逐字不变的行为：没有增量首行）
  const full = await callTool(status, f.workspace, {})
  assert.equal(full.startsWith('changes since='), false, `without since the tool must keep returning the full status: ${full.slice(0, 120)}`)
  // 两态：两条路径的产物确实不同（不是同一个函数的两种说法）
  assert.notEqual(full, increment, 'the incremental reading and the full status must differ')
})

test('M225-10 (tool face) an unreadable `since` is refused through the tool, never silently downgraded', async () => {
  const f = fixture('tool-refuse')
  card(f, 'a')
  const tools = registeredTools()
  const status = tools.get('sdo_status')
  assert.ok(status !== undefined, 'sdo_status must be registered')
  if (status === undefined) return
  const refused = await callTool(status, f.workspace, { since: 'not-a-pointer' })
  assert.ok(refused.includes('since'), `the refusal must name the parameter: ${refused}`)
  assert.ok(refused.includes('not-a-pointer'), `the refusal must echo the unreadable pointer: ${refused}`)
  // **不静默降级**：拒绝时不能顺手返回整份状态（那会让"起点写错"看起来像"没有增量"）
  assert.equal(refused.startsWith('changes since='), false, `a refusal must not look like an increment: ${refused.slice(0, 120)}`)
})

/* ————————————————————————————————————————————————————————————————————————————————
 * **`TASK-189` 追加：office 身份层**（`DEF-181` / `ADR-031` / `ADR-033`）
 *
 * 六件事逐条钉住：① 根会话身份＝office ② `role:office` 的卡不派发且**点名** ③ 状态块有身份行
 * ④ `roles.yml` 的 office 段＝ADR-031 六组（代码侧权威声明逐项对账）⑤ 死配置已删 ⑥ 写范围只留 `.sdo/`+`docs/`。
 *
 * 纪律：断言消息一律英文（本文件不进 `KNOWN_PROSE_GAP`）——所以**中文回执一律用 `en` 侧断言**，
 * 基准语言那一侧只断结构化读数（`roleLine` 非空且含 `office`）。
 * ———————————————————————————————————————————————————————————————————————————————— */

test('M225-R1 (identity) the root session is attributed role=office while kind stays cockpit', () => {
  const attribution = attributeRole({ sessionId: 's-root', delegationDepth: 0, claims: [] })
  assert.equal(attribution.role, 'office', 'a root session must be the process officer (office)')
  assert.equal(attribution.kind, 'cockpit', 'kind must stay cockpit: existing consumers judge lineage by kind')
  // 没有父会话但深度缺省（=0）也要判成根会话（两个信号各自成立）
  assert.equal(attributeRole({ sessionId: 's-root2', claims: [] }).role, 'office', 'a missing delegationDepth is depth 0')
  // 两态：**有父会话**的会话不许被当成流程官（它是被派发的子会话）
  const child = attributeRole({ sessionId: 's-child', delegationDepth: 1, parentSessionId: 's-root', claims: [] })
  assert.notEqual(child.role, 'office', 'a child session must never be attributed office')
  assert.equal(child.kind === 'cockpit', false, 'a child session must not be kind=cockpit')
})

test('M225-R2 (dispatch face, two-state) a role:office card never enters the ready queue and is named, not skipped', () => {
  const f = fixture('office-dispatch')
  const officeCard = createTask(f.store, f.journal, {
    title: 'process officer card', goal: 'g', dod: ['d'], role: 'office', size: 'small', writeScopes: ['docs/'],
  } as never)
  const workCard = createTask(f.store, f.journal, {
    title: 'work card', goal: 'g', dod: ['d'], role: 'developer', size: 'small', writeScopes: ['src/x.ts'],
  } as never)
  const tasks = listTasks(f.store)

  // ① 不进就绪队列
  const ready = readyTasks(tasks, 99).map((task) => task.id)
  assert.equal(ready.includes(officeCard.id), false, 'a role:office card must never be handed to the dispatch face')
  // ② 两态：同一份台账里的普通卡**照样**在队列里（不是"队列空了"）
  assert.equal(ready.includes(workCard.id), true, 'an ordinary card must stay dispatchable')

  // ③ 点名（不静默跳过）：结构化读数 + 渲染行
  const plan = classifyNonDispatchable(tasks)
  assert.deepEqual((plan.roleOffice ?? []).map((task) => `${task.id}:${task.role}`), [`${officeCard.id}:office`], 'the office card must be classified, not dropped')
  const line = f.office.roleBlockedLine(f.call)
  assert.equal(line.includes(officeCard.id), true, `the receipt line must name the office card: ${line}`)
  assert.equal(line.includes(workCard.id), false, `the receipt line must not name dispatchable cards: ${line}`)
  // 两态：台账里没有 role:office 卡时那一行**不占位**
  const clean = fixture('office-dispatch-clean')
  createTask(clean.store, clean.journal, { title: 'w', goal: 'g', dod: ['d'], role: 'developer', size: 'small', writeScopes: ['src/x.ts'] } as never)
  assert.equal(clean.office.roleBlockedLine(clean.call), '', 'without such a card the line must be empty')
})

/**
 * **`M225-R2b`（`DEF-273`，`REV-142` 必修一）：直打 `candidateQueue`，不绕 `sdo_plan` 回执。**
 *
 * 为什么单独要这一格：`M225-R2` 断言的是 `readyTasks` + `classifyNonDispatchable` + `roleBlockedLine`
 * 三条 —— 都是**别处**的判据；而 `plan.ts` 里 `candidateQueue` 的 office 过滤（有序候选表的最后一道）
 * 此前**全仓没有任何测试直接打过**（`grep -rn candidateQueue test/` 只命中 `m224` 的一句注释）⇒
 * 把那行过滤删掉，全量照样全绿，而派发回执的 `queued` 表会重新把 office 卡印成"下一轮会派它"
 * （卡面把这个点写成"关键：不回执误印 queued"）。间接断言**定位不到是哪一行在挡**，所以这里直接调它。
 *
 * 双态 + 反向自证：office 卡**不在**结果里；普通 developer 卡**在**；把同一张卡的角色改成 developer
 * 之后它**必须出现**（否则这一格就是恒真）。
 */
test('M225-R2b (candidateQueue, direct) a role:office card never enters the ordered candidate table', () => {
  const f = fixture('office-candidate-queue')
  const officeCard = createTask(f.store, f.journal, {
    title: 'process officer card', goal: 'g', dod: ['d'], role: 'office', size: 'small', writeScopes: ['docs/'],
  } as never)
  const workCard = createTask(f.store, f.journal, {
    title: 'work card', goal: 'g', dod: ['d'], role: 'developer', size: 'small', writeScopes: ['src/x.ts'],
  } as never)
  const tasks = listTasks(f.store)

  const queued = candidateQueue(tasks).map((task) => task.id)
  assert.equal(queued.includes(officeCard.id), false, 'the ordered candidate table must not list a role:office card as queued')
  assert.equal(queued.includes(workCard.id), true, 'an ordinary card must stay in the ordered candidate table')

  // 反向自证：同一张卡换成 developer 角色 ⇒ 必须出现（把过滤删掉这格就红）
  const flipped = tasks.map((task) => (task.id === officeCard.id ? ({ ...task, role: 'developer' } as unknown as (typeof tasks)[number]) : task))
  assert.equal(
    candidateQueue(flipped).map((task) => task.id).includes(officeCard.id),
    true,
    'self-proof: flipping the same card to role=developer must put it back into the table (otherwise this grid is vacuous)',
  )
})

test('M225-R3 (status block) the role line says office, in both languages', () => {
  const f = fixture('role-line')
  const status = f.office.status(f.call)
  assert.equal(typeof status.roleLine, 'string', 'the snapshot must carry a rendered role line')
  assert.equal((status.roleLine ?? '').includes('office'), true, `the role line must name office: ${status.roleLine ?? ''}`)
  const zhBlock = renderStatusBlock(status, '.sdo', 4000)
  assert.equal(zhBlock.includes(status.roleLine ?? '<missing>'), true, 'the injected block must contain the role line')
  setLocale('en')
  try {
    const enLine = f.office.roleLine(f.call)
    assert.equal(CJK.test(enLine), false, `the en role line must stay CJK-free: ${enLine}`)
    assert.equal(enLine.includes('office'), true, `the en role line must name office: ${enLine}`)
  } finally {
    setLocale('zh-CN')
  }
})

test('M225-R4 (write scope, two-state) office may write .sdo/ and docs/ but not src/ or test/', () => {
  const configured = ['.sdo/', 'docs/', 'test/']
  const officePaths = publicWritePathsFor('office', configured)
  assert.deepEqual(officePaths, ['.sdo/', 'docs/'], 'office faces only the ledger and the derived docs')
  // 两态：别的角色**原样**拿到配置（developer/tester 的卡要把用例写进 test/）
  assert.deepEqual(publicWritePathsFor('developer', configured), configured, 'other roles keep the configured public face')
  assert.deepEqual(publicWritePathsFor('cockpit', configured), configured, 'the unknown-session fallback stays untouched (fail-open)')

  const workspace = join(BASE, 'write-scope')
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  const decide = (path: string): string => evaluateWriteScope({
    role: 'office',
    tool: 'write',
    paths: [path],
    workspace,
    workspaceRoot: workspace,
    guardedTools: ['write', 'edit'],
    sharedPaths: officePaths,
  }).kind
  assert.equal(decide('src/office.ts'), 'deny', 'office must not write src/')
  assert.equal(decide('test/m225.test.ts'), 'deny', 'office must not write test/ (removed from the public face)')
  assert.equal(decide('.sdo/tasks/TASK-001.yml'), 'allow', 'office maintains the ledger, so .sdo/ must pass')
  assert.equal(decide('docs/DESIGN.md'), 'allow', 'office maintains derived docs, so docs/ must pass')
  // 两态：同一条闸门在 cockpit（认不出人）态下放行 —— 说明上面那三条拒绝来自"office 这条身份"，不是闸门坏了
  assert.equal(evaluateWriteScope({
    role: 'cockpit', tool: 'write', paths: ['src/office.ts'], workspace, workspaceRoot: workspace,
    guardedTools: ['write', 'edit'], sharedPaths: configured,
  }).kind, 'allow', 'the cockpit fallback still fails open (unchanged)')
})

test('M225-R5 (roles.yml = ADR-031) the office section matches the code-side declaration item by item', () => {
  const card = listRoleCards().find((item) => item.code === 'office')
  assert.ok(card !== undefined, 'roles.yml must declare the office role')
  if (card === undefined) return
  const declared = [...card.allow].sort()
  const expected = officeAllowFace().sort()
  assert.deepEqual(declared, expected, 'roles.yml office allow must equal the ADR-031 six-group declaration')
  // ① ask_user_question 已移出 deny；⑤ bash 暂留（TASK-190 收回，本卡不许提前收）
  assert.equal(card.deny.includes('ask_user_question'), false, 'ask_user_question must no longer be denied for office')
  assert.equal(card.allow.includes('ask_user_question'), true, 'office must be able to ask the user (ADR-031 group 1)')
  assert.equal(card.allow.includes('exit_plan_mode'), true, 'office must be able to drive the plan review (ADR-031 group 1)')
  // ⑤ `ADR-031`：office **不给 bash**（本卡不动它 —— 公告面/presets 的连带由 TASK-190 收口）
  assert.equal(card.allow.includes('bash'), false, 'office must not get bash (ADR-031 group 5); TASK-190 finishes the rest')
  assert.equal(card.deny.includes('bash'), true, 'bash must stay denied for office')
  // ③ 记录面给、但要靠工具内置独立性校验
  for (const tool of ['sdo_test', 'sdo_review']) assert.equal(card.allow.includes(tool), true, `office must keep ${tool} (ADR-031 group 3)`)
  // ⑥ 派发族一个都不给
  for (const tool of ['subagent', 'subagent_fork', 'workflow', 'send_message']) {
    assert.equal(card.allow.includes(tool), false, `office must not get the dispatch family: ${tool}`)
  }
  // 死配置：`TOOL_FILTER_FALLBACK` 已删（不再有第二份会过期的工具面）
  const orchestratorModule = orchestrator as unknown as Record<string, unknown>
  assert.equal(Object.hasOwn(orchestratorModule, 'TOOL_FILTER_FALLBACK'), false, 'the dead fallback table must be gone')
  // 唯一真源：每一族的 `roleToolFilter` 都必须等于掩码表现算
  for (const item of listRoleCards()) {
    assert.deepEqual(roleToolFilter(item.code), toolAllowList(item.code), `${item.code}: roleToolFilter must equal the pack-derived face`)
  }
})
