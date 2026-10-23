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
 * ## 本卡**没有**交付的部分（如实登记，不假装绿）
 * DoD ③「超限时尾部给一行『另有 N 张未显示，用 status/owner 过滤或 id=<卡> 看详情』」+
 * 落点二的两档入口（`list` 的 `status`/`owner`/`role`/`limit` 参数，`list id=<卡>` 走详情档）
 * **不在本卡写范围内可达**：参数声明在 `src/interface/tools.ts`、`case 'list'` 在 `src/index.ts`、
 * 新文案要进 `src/data/lang/{zh-CN,en}.yml` —— 这三处当时**都被在飞卡 `TASK-183` 的写范围占着**
 * （`addWriteScopes` 会按"两个写者"可读拒绝）。所以 `M223-07` 是**显式 skip**（带理由），
 * 让缺口在运行读数里可见，而不是消失。
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
import { describePlan, describeTask, describeTaskBoard } from '../src/interface/describe.js'
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
    card(3),
  ]
  const board = describePlan(tasks, [])
  // ① 不含 DoD（标志子串一次都不许出现 —— 这是本卡的核心红线）
  assert.equal(board.includes(DOD_MARK), false, `摘要档里出现了 DoD 正文：${board.slice(0, 600)}`)
  // ② 含摘要档的六个字段（逐字段点名，不靠"至少有一个"凑绿）
  for (const task of tasks) {
    assert.ok(board.includes(task.id), `摘要档要点名卡号：${task.id} 不在 ${board.slice(0, 400)}`)
    assert.ok(board.includes(`[${task.role}/${task.size}]`), `摘要档要给 role/size：${task.id}`)
    assert.ok(board.includes(task.title), `摘要档要给标题：${task.id}`)
  }
  assert.ok(board.includes('in-progress') && board.includes('blocked'), '摘要档要给 status')
  assert.ok(board.includes('developer-abc12345') && board.includes('tester-def67890'), '摘要档要给 owner')
})

test('M223-02 守卫② 详情档（detail:true）：含 DoD，且 k245/k89/k90 三行与语言包逐字一致（既有形状不动）', () => {
  const task = card(1, { owner: 'developer-abc12345', writeScopes: ['src/a.ts', 'src/b.ts'], requirements: ['REQ-001'] })
  const text = describePlan([task], [], [], undefined, { detail: true })
  assert.ok(text.includes(DOD_MARK), `详情档必须含 DoD 正文：${text.slice(0, 400)}`)
  // 「不许破坏既有消费方」：三行的**键与占位**逐字复用，本卡只新增摘要档、没改详情档
  assert.ok(text.includes(fmt('uiDescribe.k245', { p1: task.dod.join('；') })), 'k245 的既有形状必须逐字保留')
  assert.ok(text.includes(fmt('uiDescribe.k89', { p1: 'src/a.ts、src/b.ts', p2: '' })), 'k89 的既有形状必须逐字保留（写范围）')
  assert.ok(text.includes(fmt('uiDescribe.k90', { p1: 'command/artifact', p2: 'REQ-001' })), 'k90 的既有形状必须逐字保留（证据要求 / 追溯）')
})

test('M223-03 守卫④（本卡验收现象）183 张卡：摘要档 < 20000 字符，同一批卡的详情档 > 100000 字符', () => {
  const tasks = cards(183)
  const summary = describePlan(tasks, [])
  const detail = describePlan(tasks, [], [], undefined, { detail: true })
  console.log(`[m223] 183 张卡：摘要档 ${summary.length} 字符 / 详情档 ${detail.length} 字符`)
  assert.ok(summary.length < 20000, `摘要档必须 < 20000 字符（实测 ${summary.length}）；阈值就是 DEF-169 的验收现象`)
  assert.ok(detail.length > 100000, `详情档仍应是全文（实测 ${detail.length}）—— 否则"两档"没差别，本断言同时是反恒真对照`)
  assert.equal(summary.includes(DOD_MARK), false, '183 张卡的摘要档里同样一个字 DoD 都不许有')
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
  const tasks = [card(1, { status: 'ready', owner: 'developer-abc12345' }), card(2, { status: 'done' })]
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

test('M223-08 未交付缺口（显式 skip，不假装绿）：limit + status/owner/role 过滤 + 尾部「另有 N 张」', { skip: '被在飞卡 TASK-183 的写范围挡住：sdo_task 的参数声明在 src/interface/tools.ts、case \'list\' 在 src/index.ts、尾部文案要进 src/data/lang/{zh-CN,en}.yml —— 三处都在 TASK-183 的 writeScopes 里，addWriteScopes 会按两个写者可读拒绝。等 TASK-183 收工后由后续卡补齐这三条守卫。' }, () => {
  // 缺口本身要**可判定**：等能改那三处时，这里按 DEF-169 的落点一/二写成真守卫
  const board = describeTaskBoard({ tasks: cards(183), ready: [], stale: [], issues: [] })
  assert.ok(board.includes(t('uiDescribe.k196').split('{')[0] ?? ''), '看板计数行在位（这条不依赖被挡的文件）')
})
