/**
 * **增量 223：`DEF-169` —— 列举面两档化（`TASK-184`）**。
 *
 * ## 病根（现算的读数，不是抄卡面）
 * `src/interface/describe.ts` 里的**看板**函数曾经对**每一张卡**渲染 DoD 全文
 * （`k245` = `    · DoD：{p1}`，`task.dod.join('；')`）+ 写范围 + 证据要求 ⇒ 逐卡线性成本。
 * 本仓 187 张卡时实测：
 *   · `describePlan`（= `sdo_plan` 的看板）**188715 字符**（详情档）；
 *   · `sdo_task action=list` 的看板（`describeTaskBoard`）**18349 字符** + `index.ts` 的
 *     `fixes` 段落 ⇒ 真回执约 **19057 字符**。
 * 两者都远超宿主 `clampToolResult` 的 **8000** 上限 ⇒ 回执被截断成前 8000，后半张卡**看不见**，
 * 子代理只能进 `.sdo/tasks/` 自己翻。
 *
 * ## 本文件钉住的两档（DoD 守卫 ①②④ + 两条防退化）
 * | # | 断言面 | 期望 |
 * |---|---|---|
 * | ① | 摘要档（`describePlan` 缺省） | **不含**任何卡的 DoD 标志子串；**含** `id` / `role` / `size` / `status` / `owner` / 标题 |
 * | ② | 详情档（`options.detail: true`） | **含** DoD，且 `k245` / `k89` / `k90` 三行与语言包**逐字**一致（既有形状不动） |
 * | ④ | 183 张卡 | 摘要档 **< 20000 字符**（可测阈值），同一批卡的详情档 **> 100000 字符**（差的就是 DoD） |
 * | ⑤ | 摘要档不丢关键信息 | 「受阻原因」「依赖未满足」仍在（它们决定这一轮派不派得到） |
 * | ⑥ | 行格式单源 | `describeTaskBoard` 与 `describePlan` 的摘要行**逐字相同**（同一个渲染函数） |
 * | ⑦ | 真回执 | 走**真实注册**的 `sdo_task`：`action=list` 是一行一张、不含 DoD、含 id/标题 |
 *
 * ## 落点二/三 的接线（**本卡已交付**，守卫见 M223-08…M223-13）
 * 摘要行现在只差"能收窄、能按 id 取全文"这两件事，而它们不在 `describe.ts` 一个文件里能完成：
 * 参数声明在 `src/interface/tools.ts`（缺了宿主会在校验阶段**拒掉**参数，插件根本收不到）、
 * `case 'list'` 在 `src/index.ts`、文案在 `src/data/lang/{zh-CN,en}.yml`。前一棒（`6f21f1c`）把这三处
 * **如实挂起**（在飞卡 `TASK-183` 占着写范围、`addWriteScopes` 会按"两个写者"可读拒绝），
 * 本棒在 `TASK-183` 收工后把它们接上：
 *   · `list` 带 `id` ⇒ 详情档（{@link describeTask}）；不带 ⇒ 摘要档；
 *   · `status` / `owner` / `role` / `limit` 四个收窄参数（缺省 `limit` = `TASK_BOARD_DEFAULT_LIMIT`＝50）；
 *   · 截断**不许静默**：最后一行印「另有 N 张未显示」，N 是现算的差；生效条件单独一行（`uiDescribe.k250`）。
 *
 * 夹具一律在 `node_modules/.sdo-test/m223/`（已 gitignore）：不碰真仓库、不碰真台账。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import { fmt, t } from '../src/domain/i18n.js'
import { writeTask } from '../src/domain/plan.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { describePlan, describeTask, describeTaskBoard, TASK_BOARD_DEFAULT_LIMIT } from '../src/interface/describe.js'
import type { SdoConfig } from '../src/config.js'
import type { SdoStore as Store } from '../src/infra/store.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m223/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

/** DoD 的**标志性子串**：摘要档里出现它 = DoD 漏进了列举面。 */
const DOD_MARK = 'DODMARK'
/** 标题的标志性子串：摘要档里必须能见到它（摘要档 = 一行一张，标题是它的主信息）。 */
const TITLE_MARK = '标题标记'

/** 一张形状与真机接近的卡：标题 ~90 字符、DoD ~730 字符（真机 187 张卡的 DoD 合计 146485 字符 ⇒ 均值 ~783）。 */
function card(index: number, overrides: Partial<TaskCard> = {}): TaskCard {
  const id = `TASK-${String(index).padStart(3, '0')}`
  return {
    id,
    title: `${TITLE_MARK} ${id}：列举面两档化回归夹具（标题长度贴近真机，正文不进摘要档）`,
    goal: `${id} 的目标`,
    inputs: [],
    outputs: [],
    dod: [`${DOD_MARK}-${id}：` + '这一段完成定义只应出现在详情档，绝不许进摘要档；'.repeat(30)],
    evidenceRequired: ['command', 'artifact'],
    writeScopes: ['src/domain/describe-fixture.ts'],
    blockedBy: [],
    evidence: [],
    role: 'developer',
    size: 'medium',
    revision: 1,
    status: 'done',
    requirements: [],
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    ...overrides,
  }
}

/** 183 张卡（DoD 守卫 ④ 的基数；算式：183 = 本仓真机卡数的量级，`DEF-169` 的验收阈值就在这档上）。 */
function cards(count = 183): TaskCard[] {
  return Array.from({ length: count }, (_, index) => card(index + 1))
}

let officeStore: Store
let registered: Map<string, { name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }>

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  registered = new Map()
  const services: Record<string, unknown> = { tools: { register: (tool: { name: string }) => registered.set(tool.name, tool as never) } }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  officeStore = new SdoStore(join(WORKSPACE, '.sdo'))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 走**真实注册**的 `sdo_task`（装配层注册的那一份，不是手工拼的假工具）。 */
async function sdoTask(args: Record<string, unknown>): Promise<string> {
  const tool = registered.get('sdo_task')
  assert.ok(tool !== undefined, `真实装配必须注册 sdo_task（注册表里只有：${[...registered.keys()].join(', ')}）`)
  const exec = { name: 'sdo_task', arguments: {}, agent: { session: { header: { id: 'm223-session', cwd: WORKSPACE, delegationDepth: 0 } } } }
  return String(await tool.execute(args, exec))
}

test('M223-01 守卫① 摘要档（describePlan 缺省）：一行一张，不含 DoD，含 id/role/size/status/owner/标题', () => {
  const tasks = [
    card(1, { status: 'in-progress', owner: 'developer-abc12345', role: 'developer', size: 'small' }),
    card(2, { status: 'blocked', owner: 'tester-def67890', role: 'tester', size: 'large', blockedReason: '等 TASK-999 收工', blockedBy: ['TASK-999'] }),
    card(3, { status: 'planned' }),
    card(4, { status: 'done' }),
  ]
  const board = describePlan(tasks, [])
  // ① 不含 DoD（标志子串一次都不许出现 —— 这是本卡的核心红线）
  assert.equal(board.includes(DOD_MARK), false, `摘要档里出现了 DoD 正文：${board.slice(0, 600)}`)
  // ② 含摘要档的六个字段（逐字段点名，不靠"至少有一个"凑绿）—— 只看**这一轮还要管**的三张
  for (const task of tasks.filter((item) => item.status !== 'done')) {
    assert.ok(board.includes(task.id), `摘要档要点名卡号：${task.id} 不在 ${board.slice(0, 400)}`)
    assert.ok(board.includes(`[${task.role}/${task.size}]`), `摘要档要给 role/size：${task.id}`)
    assert.ok(board.includes(task.title), `摘要档要给标题：${task.id}`)
  }
  assert.ok(board.includes('in-progress') && board.includes('blocked'), '摘要档要给 status')
  assert.ok(board.includes('developer-abc12345') && board.includes('tester-def67890'), '摘要档要给 owner')
  // ③ 终态卡不上板，但必须**现算着说出来**（藏起来 ≠ 静默）：p1 = 206… 本用例只放 1 张 done
  assert.equal(board.includes(`- ${card(4).id}　`), false, 'done 卡不该占摘要行')
  assert.ok(board.includes(fmt('uiDescribe.k253', { p1: '1', p2: '1', p3: '0' })), `被略过的终态卡要现算成一行（另有 1 张…）：${board}`)
})

test('M223-02 守卫② 详情档（detail:true）：含 DoD，且 k245/k89/k90 三行与语言包逐字一致（既有形状不动）', () => {
  const task = card(1, { owner: 'developer-abc12345', writeScopes: ['src/a.ts', 'src/b.ts'], requirements: ['REQ-001'] })
  const text = describePlan([task], [], [], undefined, { detail: true })
  assert.ok(text.includes(DOD_MARK), `详情档必须含 DoD 正文：${text.slice(0, 400)}`)
  // 「不许破坏既有消费方」：三行的**键与占位**逐字复用，本卡只新增摘要档、没改详情档
  assert.ok(text.includes(fmt('uiDescribe.k245', { p1: task.dod.join('；') })), 'k245 的既有形状必须逐字保留')
  assert.ok(text.includes(fmt('uiDescribe.k89', { p1: 'src/a.ts、src/b.ts', p2: '' })), 'k89 的既有形状必须逐字保留（写范围）')
  assert.ok(text.includes(fmt('uiDescribe.k90', { p1: 'command/artifact', p2: 'REQ-001' })), 'k90 的既有形状必须逐字保留（证据要求 / 追溯）')
  // 详情档**不**摘卡：终态卡照样展开（既有消费方要按 id 看全文的那条路不能变窄）
  assert.ok(text.includes(task.id), '详情档仍逐卡展开')
  assert.equal(describePlan([card(9, { status: 'done' })], [], [], undefined, { detail: true }).includes(DOD_MARK), true, '详情档连 done 卡也给全文')
})

/**
 * **真账分布**（2026-10-23 现算，`.sdo/tasks/` 逐张数出来的）：
 * `206 = done 128 + dropped 68 + in-progress 1 + planned 9`。
 *
 * 为什么用它而不是"183 张全 done"：摘要档的**成本**只由"还要管的卡"决定，全 done 的夹具会让
 * 阈值一格**恒真**（一行都不用印）。基数会随时间变（本卡过程中就从 205 长到 206）⇒ 这里写死的是
 * **当日现算的快照 + 算式**，不是"永远等于真账"。
 */
const REAL = { done: 128, dropped: 68, inProgress: 1, planned: 9 } as const
const REAL_TOTAL = REAL.done + REAL.dropped + REAL.inProgress + REAL.planned

function realShapeCards(): TaskCard[] {
  const out: TaskCard[] = []
  let index = 0
  for (let n = 0; n < REAL.done; n += 1) out.push(card((index += 1), { status: 'done' }))
  for (let n = 0; n < REAL.dropped; n += 1) out.push(card((index += 1), { status: 'dropped' }))
  for (let n = 0; n < REAL.inProgress; n += 1) out.push(card((index += 1), { status: 'in-progress', owner: 'developer-abc12345' }))
  for (let n = 0; n < REAL.planned; n += 1) out.push(card((index += 1), { status: 'planned' }))
  return out
}

test('M223-03 守卫④（本卡验收现象）真账分布的 206 张卡：摘要档 < 20000 字符，详情档 > 100000 字符', () => {
  const tasks = realShapeCards()
  assert.equal(tasks.length, REAL_TOTAL, `夹具基数必须等于算式 ${REAL_TOTAL}`)
  const summary = describePlan(tasks, [])
  const detail = describePlan(tasks, [], [], undefined, { detail: true })
  console.log(`[m223] ${REAL_TOTAL} 张卡（真账分布）：摘要档 ${summary.length} 字符 / 详情档 ${detail.length} 字符`)
  assert.ok(summary.length < 20000, `摘要档必须 < 20000 字符（实测 ${summary.length}）；阈值就是 DEF-169 的验收现象`)
  assert.ok(detail.length > 100000, `详情档仍应是全文（实测 ${detail.length}）—— 否则"两档"没差别，本断言同时是反恒真对照`)
  assert.equal(summary.includes(DOD_MARK), false, `${REAL_TOTAL} 张卡的摘要档里同样一个字 DoD 都不许有`)
  // 摘要行数 = **还要管的卡**（1 in-progress + 9 planned = 10），不是全量 —— 否则阈值是靠"卡少"而不是靠两档
  const rows = summary.split('\n').filter((line) => line.startsWith('- TASK-'))
  assert.equal(rows.length, REAL.inProgress + REAL.planned, `摘要行数必须等于还要管的卡数（实测 ${rows.length}）`)
  // 被略过的终态卡现算成一行：206 − 10 = 196（其中完成 128 / 已作废 68）
  assert.ok(summary.includes(fmt('uiDescribe.k253', { p1: String(REAL_TOTAL - REAL.inProgress - REAL.planned), p2: String(REAL.done), p3: String(REAL.dropped) })), `略过的张数必须现算（另有 196 张：完成 128 ／ 已作废 68）：${summary}`)
})

test('M223-04 守卫⑤ 摘要档不丢「受阻 / 依赖未满足」：它们留在看板上，DoD 不在', () => {
  const blocked = card(7, { status: 'blocked', blockedReason: '被 TASK-183 的写范围挡住', blockedBy: ['TASK-183', 'TASK-172'] })
  const board = describePlan([blocked], [])
  assert.ok(board.includes('被 TASK-183 的写范围挡住'), `受阻原因决定"为什么派不到"，摘要档必须留着：${board}`)
  assert.ok(board.includes(fmt('uiDescribe.k165', { p1: 'TASK-183 TASK-172' })), `依赖未满足同样决定派发，必须留着：${board}`)
  assert.equal(board.includes(DOD_MARK), false, '留关键信息 ≠ 把 DoD 加回来')
  // 反例格：既不 keying 也留不住 —— 没阻塞的卡不该出现这两段（否则是"每张卡都印一句固定话"的假绿）
  const healthy = describePlan([card(8)], [])
  assert.equal(healthy.includes(fmt('uiDescribe.k96', { p1: '' }).trim()), false, '没有阻塞原因的卡不许印"阻塞原因："')
  assert.equal(healthy.includes('依赖：'), false, '没有 blockedBy 的卡不许印"依赖："')
})

test('M223-05 行格式单源：describeTaskBoard 与 describePlan 的摘要行逐字相同（两份摘要漂移即红）', () => {
  // 两张都必须是"还要管"的卡（`done` / `dropped` 不上摘要档，见 M223-01 ③）
  const tasks = [card(1, { status: 'ready', owner: 'developer-abc12345' }), card(2, { status: 'in-progress' })]
  const planLines = describePlan(tasks, []).split('\n')
  const boardLines = describeTaskBoard({ tasks, ready: [tasks[0] as TaskCard], stale: [], issues: [] }).split('\n')
  const expected = tasks.map((task) => `- ${task.id}　[${task.role}/${task.size}]　${task.status}${task.owner === undefined ? '' : `（${task.owner}）`}　${task.title}`)
  for (const line of expected) {
    assert.ok(planLines.includes(line), `sdo_plan 看板的摘要行与约定不符：${line}`)
    assert.ok(boardLines.includes(line), `sdo_task list 看板的摘要行与约定不符：${line}`)
  }
})

test('M223-06 真回执（守卫①+⑦）：sdo_task action=list 是一行一张的摘要档', async () => {
  for (const task of cards(20)) writeTask(officeStore, task)
  const receipt = await sdoTask({ action: 'list' })
  console.log(`[m223] sdo_task list（20 张卡夹具）${receipt.length} 字符`)
  assert.equal(receipt.includes(DOD_MARK), false, `list 回执里出现了 DoD 正文（列举面必须只给摘要档）：${receipt.slice(0, 800)}`)
  assert.ok(receipt.includes('TASK-001'), 'list 必须点名卡号')
  assert.ok(receipt.includes(`${TITLE_MARK} TASK-001`), 'list 必须给标题')
  assert.ok(receipt.includes('[developer/medium]'), 'list 必须给 role/size')
  assert.ok(receipt.length < 20000, `20 张卡的 list 回执不该超 20000 字符（实测 ${receipt.length}）`)
})

test('M223-07 守卫②（单卡详情档）：describeTask 仍给 DoD 全文（k247），且带 owner / status / 目标', () => {
  const task = card(1, { status: 'in-progress', owner: 'developer-abc12345' })
  const text = describeTask(task)
  assert.ok(text.includes(fmt('uiDescribe.k247', { p1: task.dod.join('；') })), 'k247 的既有形状必须逐字保留（按 id 单取的详情档）')
  assert.ok(text.includes('developer-abc12345') && text.includes('in-progress'), '详情档要有 owner 与 status')
  assert.ok(text.includes(fmt('uiDescribe.k93', { p1: task.goal })), '详情档要有目标（k93）')
  assert.ok(text.length > 600, `详情档就是全文，长度应远超一行摘要（实测 ${text.length}）`)
})

test('M223-08 落点二：status / owner / role **精确**收窄，收窄条件在回执里可见（uiDescribe.k250）', () => {
  const tasks = [
    card(1, { status: 'done', owner: 'developer-aaaa1111', role: 'developer' }),
    card(2, { status: 'done', owner: 'tester-bbbb2222', role: 'tester' }),
    card(3, { status: 'in-progress', owner: 'developer-aaaa1111', role: 'developer' }),
  ]
  const board = describeTaskBoard({ tasks, ready: [], stale: [], issues: [], filter: { status: 'done' } })
  assert.ok(board.includes('TASK-001') && board.includes('TASK-002'), `收窄后应同时点名两张 done 卡：${board}`)
  // 反例格（**精确**匹配，不是前缀/模糊）：`developer-aaaa1111` 只应命中 TASK-001/TASK-003 那两张同 owner 的卡
  assert.equal(board.includes('TASK-003'), false, 'status=done 不该带出 in-progress 的卡')
  assert.ok(
    board.includes(fmt('uiDescribe.k250', { p1: 'status=done', p2: '3', p3: '2', p4: '2' })),
    `收窄条件必须原样印出来（全库 3 / 命中 2 / 显示 2）：${board}`,
  )
  // 三个条件串在一条里（顺序固定为 status → owner → role → limit），并各自只认全等
  const three = describeTaskBoard({ tasks, ready: [], stale: [], issues: [], filter: { status: 'in-progress', owner: 'developer-aaaa1111', role: 'developer' } })
  assert.ok(three.includes(fmt('uiDescribe.k250', { p1: 'status=in-progress、owner=developer-aaaa1111、role=developer', p2: '3', p3: '1', p4: '1' })), `三个条件要串在同一行：${three}`)
  // 一个字都没筛时**不许**印这一行（否则每份回执都多一行固定噪音）
  const plain = describeTaskBoard({ tasks, ready: [], stale: [], issues: [] })
  assert.equal(plain.includes(t('uiDescribe.k250').split('{')[0] ?? ''), false, '不缺省筛选就不许印收窄条件行')
})

test('M223-09 落点二尾部：截断时**最后一行**印「另有 N 张」，N = 命中数 − 显示数（现算，不许写死）', () => {
  const tasks = cards(183)
  const board = describeTaskBoard({ tasks, ready: [], stale: [], issues: [] })
  const lines = board.split('\n')
  // 缺省 50 张 ⇒ 另有 183 − 50 = 133 张
  const hidden = 183 - TASK_BOARD_DEFAULT_LIMIT
  assert.equal(hidden, 133, '算式的基数必须现算成 133（183 张卡 − 缺省 50）')
  assert.equal(lines[lines.length - 1], fmt('uiDescribe.k251', { p1: String(hidden) }), `尾部提示必须是**最后一行**且 N 现算：实际末行「${lines[lines.length - 1] ?? ''}」`)
  const rows = lines.filter((line) => line.startsWith('- TASK-'))
  assert.equal(rows.length, TASK_BOARD_DEFAULT_LIMIT, `摘要行数必须等于 limit（实测 ${rows.length}）`)
  // `limit=0` = **显式**要全量：不截断，所以既没有尾部提示，行数也回到全量
  const full = describeTaskBoard({ tasks, ready: [], stale: [], issues: [], filter: { limit: 0 } })
  assert.equal(full.split('\n').filter((line) => line.startsWith('- TASK-')).length, 183, 'limit=0 就是不截断')
  assert.equal(full.includes(t('uiDescribe.k251').split('{')[0] ?? ''), false, 'limit=0 是调用方显式要的，不印"另有 N 张"')
  // 小 `limit`：N 跟着现算一起变（反恒真：写死 133 的实现会在这里红）
  const five = describeTaskBoard({ tasks, ready: [], stale: [], issues: [], filter: { limit: 5 } })
  assert.equal(five.split('\n').at(-1), fmt('uiDescribe.k251', { p1: String(178) }), 'limit=5 ⇒ 另有 183 − 5 = 178 张')
})

test('M223-10 筛选后为空 ≠ 库里没有卡：两种回执必须读得不一样（uiDescribe.k252 vs k99）', () => {
  const empty = describeTaskBoard({ tasks: cards(5), ready: [], stale: [], issues: [], filter: { status: 'blocked' } })
  assert.ok(empty.includes(fmt('uiDescribe.k252', { p1: '0', p2: '5', p3: 'status=blocked' })), `筛空要点名"命中 0 张、全库 5 张、生效条件"：${empty}`)
  assert.equal(empty.includes(t('uiDescribe.k99')), false, '筛空不是"还没有任务卡" —— 那句话会让读者去建卡')
  // 真·空库仍走 k99（旧口径不动）
  assert.ok(describeTaskBoard({ tasks: [], ready: [], stale: [], issues: [] }).includes(t('uiDescribe.k99')), '真空库仍要说"还没有任务卡"')
})

test('M223-11 落点一（真入口）：`list id=<卡>` 走详情档（含 DoD 全文），`id` 不存在时可读拒绝', async () => {
  const tasks = cards(20)
  for (const task of tasks) writeTask(officeStore, task)
  const target = tasks[2] as TaskCard
  const detail = await sdoTask({ action: 'list', id: target.id })
  console.log(`[m223] list id=${target.id}：详情档 ${detail.length} 字符`)
  assert.ok(detail.includes(DOD_MARK), `详情档必须把 DoD 拿回来（摘要档里它一个字都没有）：${detail.slice(0, 600)}`)
  assert.ok(detail.includes(fmt('uiDescribe.k247', { p1: target.dod.join('；') })), 'k247 的既有形状必须逐字保留')
  assert.ok(detail.includes(fmt('uiDescribe.k94', { p1: target.writeScopes.join('、') })), '详情档还要给写范围（k94）')
  // 详情档只渲染**这一张**：别的卡号不许出现（否则"按 id 取详情"退回成列举面）
  const others = tasks.filter((task) => task.id !== target.id).map((task) => task.id)
  assert.deepEqual(others.filter((id) => detail.includes(id)), [], '详情档不许夹带别的卡')
  assert.equal(await sdoTask({ action: 'list', id: 'TASK-999' }), fmt('uiIndex.k49', { p1: 'TASK-999' }), 'id 不存在要给可读拒绝，而不是一张空看板')
})

test('M223-12 守卫④（可测阈值钉住）：183 张卡的 `list` 真回执 < 20000 字符，且收窄参数在真回执里生效', async () => {
  const tasks = cards(183)
  for (const task of tasks) writeTask(officeStore, task)
  const receipt = await sdoTask({ action: 'list' })
  console.log(`[m223] 183 张卡：list 真回执 ${receipt.length} 字符（缺省 limit=${TASK_BOARD_DEFAULT_LIMIT}）`)
  assert.ok(receipt.length < 20000, `缺省 limit 下 list 回执必须 < 20000 字符（实测 ${receipt.length}）`)
  assert.equal(receipt.split('\n').at(-1), fmt('uiDescribe.k251', { p1: String(183 - TASK_BOARD_DEFAULT_LIMIT) }), '真回执的最后一行同样是尾部提示，N = 133')
  // 收窄走**真实注册**的工具面（schema 少声明一个键，宿主就会在插件收到之前拒掉它 —— 这一格是那条路的守卫）
  const narrowed = await sdoTask({ action: 'list', status: 'done', limit: 3 })
  console.log(`[m223] 183 张卡 + status=done&limit=3：${narrowed.length} 字符`)
  assert.ok(narrowed.includes(fmt('uiDescribe.k250', { p1: 'status=done、limit=3', p2: '183', p3: '183', p4: '3' })), `收窄参数必须真的到达渲染面（宿主丢参会在这里红）：${narrowed.slice(0, 600)}`)
  assert.equal(narrowed.split('\n').at(-1), fmt('uiDescribe.k251', { p1: String(180) }), 'limit=3 ⇒ 另有 183 − 3 = 180 张')
  assert.equal(narrowed.includes('TASK-004'), false, 'limit=3 不该列出第 4 张以后的行（尾部提示里也不许出现卡号）')
  const byRole = await sdoTask({ action: 'list', role: 'tester', limit: 0 })
  console.log(`[m223] 183 张卡 + role=tester：${byRole.length} 字符`)
  assert.ok(byRole.includes(fmt('uiDescribe.k252', { p1: '0', p2: '183', p3: 'role=tester、limit=0' })), `role 收窄必须到达渲染面（命中 0 张时走 k252，条件原样回显）：${byRole.slice(0, 400)}`)
})

test('M223-13 schema 一处（宿主丢参的源头）：`sdo_task` 的 parameters 必须声明 status / role / limit', () => {
  const tool = registered.get('sdo_task') as unknown as { parameters?: { properties?: Record<string, unknown> } } | undefined
  assert.ok(tool !== undefined, '真实装配必须注册 sdo_task')
  const properties = tool.parameters?.properties ?? {}
  for (const key of ['status', 'role', 'limit']) {
    assert.ok(key in properties, `schema 缺 ${key} ⇒ 宿主会在校验阶段拒掉这个参数，插件根本收不到（三处同改的第一处）`)
  }
  // 反例格：id/owner 早就在（拿它们证明"这条断言的读法没错"，不是恒真）
  for (const key of ['id', 'owner']) assert.ok(key in properties, `${key} 早该在 schema 里`)
})

test('M223-14 `fixes` 段跟着筛选走：本次没筛出来的卡，它的缺陷声明不许印（否则读者以为筛没生效）', async () => {
  writeTask(officeStore, card(1, { status: 'done', owner: 'developer-aaaa1111', fixes: ['DEF-169'] }))
  writeTask(officeStore, card(2, { status: 'done', owner: 'tester-bbbb2222', fixes: ['DEF-050'] }))
  const narrowed = await sdoTask({ action: 'list', owner: 'developer-aaaa1111' })
  assert.ok(narrowed.includes('DEF-169'), `筛出来的那张卡的声明必须在：${narrowed}`)
  assert.equal(narrowed.includes('DEF-050'), false, `没筛出来的卡（tester-bbbb2222）的声明不该出现：${narrowed}`)
  // 反例对照：不筛时两条都在（证明上行不是"两条都没印"的假绿）
  const plain = await sdoTask({ action: 'list' })
  assert.ok(plain.includes('DEF-169') && plain.includes('DEF-050'), `不筛时两条声明都要在：${plain}`)
})
