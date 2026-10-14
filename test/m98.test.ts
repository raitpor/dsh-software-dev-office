/**
 * M98：**阻塞级缺陷禁止用 wontfix 绕过验证门禁**（TASK-063 / DEF-038 / REQ-055 / 判据 `C-51`）。
 *
 * ## 病根（DEF-038，用户 2026-10-13 裁定「不该放过」）
 * `records.ts` 的 `blockersOpen` 把 `wontfix` 与 `closed` **一起**排除在"阻塞"之外
 * （`severity === 'blocker' && status !== 'closed' && status !== 'wontfix'`）⇒ 阻塞级缺陷标一个
 * `wontfix` 就让计数归零，而 `gates.ts` 的 C-51 **消费的正是它** ⇒ 一处过滤错、两处一起假绿。
 * 语义改为「**放弃必须有人署名**」：给 `Defect` 增两个可选字段 `waiveReason?`（**为什么不修**，
 * 与 `rootCause`（**怎么进来的**）语义区分）与 `waiveApprovedBy?`（批准人）。
 *
 * ## 四态（本文件的断言面，卡上落点三）
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | 阻塞级 + `wontfix` + 缺理由或批准人 | C-51 **判红并点名该 `DEF-id`** + 说明缺哪个字段 |
 * | ② | 阻塞级 + `wontfix` + **理由与批准人齐备** | 放行，且回执**单列**「以 wontfix 放行的阻塞级缺陷」 |
 * | ③ | **非**阻塞级 + `wontfix` | 放行，且**不读**这两个字段（不误伤） |
 * | ④ | 阻塞级 + `open` / `fixed` | 仍判红（原行为不变） |
 *
 * ## 三条纪律（照 M94 的同源口径）
 *   ① **一切样本经真实注册的工具构造**（`apply()` → 工具注册表 → `execute`），绝不直接调 `office.*`：
 *      本卡一半的修复量长在**工具边界**上 —— 参数只在 `execute` 里解构、没进 `parameters` schema
 *      （或反之），或 `src/index.ts` 的 defect 分支没搬进域层，值都会**静默丢弃**：不报错、回执还说成功。
 *      ② 的样本（齐备）正是这件事的可观察形式：参数被丢掉 ⇒ 盘上永远没有这两字段 ⇒ ② 必红
 *      （知识库 `tq_ff348198` 的真机教训：只调 `office.*` 的用例照不出这类缺陷）。
 *   ② **参数真的被接收**只看 append-only 真源（`defect/recorded` 事件载荷），不看回执怎么说。
 *   ③ **反例不得空转**：每条红线断言都点到**具体名字**（`DEF-00x`、`waiveReason`、`waiveApprovedBy`、
 *      单列小标题…），只断言 `ok === false` 会把"判据没跑"与"判据判红"混为一谈。
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
import { countCjkLiterals } from '../src/domain/langScan.js'
import { listDefects, verificationStats } from '../src/domain/records.js'
import type { Defect } from '../src/domain/records.js'
import { Journal } from '../src/infra/journal.js'
import { loadPackagedYaml } from '../src/infra/data.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import type { JournalEvent } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm98')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'm98-session'
const CHECK = 'defects.closed'

/** `t()` 取到键名时会返回键的后半段 —— 用它判"文案到底有没有落进语言包"。 */
const keyTail = (key: string): string => key.split('.').slice(1).join('.')

interface RegisteredTool {
  name: string
  /** 真实注册表里的形状是 JSON Schema：`{ type: 'object', properties: {...} }`。 */
  parameters?: { type?: string; properties?: Record<string, { type?: string; description?: string }> }
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

interface Harness {
  tool: (name: string) => RegisteredTool
  exec: () => unknown
  fire: (event: string, payload: unknown) => void
}

let harness: Harness

/** 一次**真实装配**：`apply()` 注册进宿主工具表的那一份定义，不是手工拼的假工具。 */
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
    if (found === undefined) throw new Error(`真实装配没有注册 ${name}（注册表里只有：${[...registered.keys()].join(', ')}）`)
    return found
  }
  return {
    tool,
    // **取会话工作目录只能读 `agent.session.header.cwd`**（dsh-agent 0.2.0-rc.1 上没有顶层 cwd）
    exec: () => ({ name: 'sdo_test', arguments: {}, agent: { session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } } }),
    fire: (event, payload) => listeners.get(event)?.(payload as never),
  }
}

/** 走**真实注册的工具**：`sdo_test`（本卡的全部样本都从这里进）。 */
async function sdoTest(args: Record<string, unknown>): Promise<string> {
  return String(await harness.tool('sdo_test').execute(args, harness.exec()))
}

function store(): SdoStore {
  return new SdoStore(join(WORKSPACE, '.sdo'))
}

function journal(): Journal {
  return new Journal(store())
}

/** **真源回读**：只要事件（append-only），不看回执怎么说。 */
function events(type: string): JournalEvent[] {
  return journal().read().events.filter((event) => event.type === type)
}

function lastEvent(type: string): Record<string, unknown> {
  const hit = events(type).at(-1)
  assert.ok(hit !== undefined, `真源里必须有 ${type} 事件（没有就是工具面把值丢了）`)
  return (hit as { data: Record<string, unknown> }).data
}

/** **C-51 的真实接线**（判据集里注册的那一个，不是本文件另写一份口径）。 */
function c51(): { ok: boolean; detail: string; remedy?: string } {
  const checker = CHECKERS[CHECK]
  assert.equal(typeof checker, 'function', `${CHECK} 必须在 CHECKERS 里注册`)
  if (checker === undefined) throw new Error(`${CHECK} 未注册`)
  const ctx = { workspace: WORKSPACE, store: store(), journal: journal(), requirements: [] } as unknown as GateContext
  const verdict = checker(ctx)
  return {
    ok: verdict.ok === true,
    detail: verdict.detail ?? '',
    ...(verdict.remedy === undefined ? {} : { remedy: verdict.remedy }),
  }
}

/** 语言包里的文案（有的判据文案不经过 `t()`，直接在这里取同一把键，避免把中文写死在断言里）。 */
function lang(): { zh: Record<string, Record<string, string>>; en: Record<string, Record<string, string>> } {
  return {
    zh: loadPackagedYaml<Record<string, Record<string, string>>>('src/data/lang/zh-CN.yml'),
    en: loadPackagedYaml<Record<string, Record<string, string>>>('src/data/lang/en.yml'),
  }
}

/** 判据与回执都按这两处口径判"齐备"：**去空白后非空**。 */
const WAIVE_FIELDS = ['waiveReason', 'waiveApprovedBy'] as const

beforeEach(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  harness = makeHarness()
  // 会话 → 工作目录：真实装配靠 `session/created` 记住它（这里发同一条事件，不走后门）
  harness.fire('session/created', { id: SESSION, header: { cwd: WORKSPACE } })
  // 项目也用**真实工具**建（手写 `.sdo/` 在本仓是"不算证据"的形态）
  const receipt = await harness.tool('sdo_init').execute(
    { name: 'M98 夹具', process: 'waterfall', scale: 'normal', stakeholders: '批准人,执行者' },
    harness.exec(),
  )
  assert.match(String(receipt), /PRJ-001/u, `夹具立项失败：${String(receipt)}`)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 经真实工具登记一条缺陷，返回回执（并断言它确实入账了）。 */
async function record(viaTool: Record<string, unknown>): Promise<string> {
  const before = events('defect/recorded').length
  const receipt = await sdoTest({ action: 'defect', ...viaTool })
  assert.equal(events('defect/recorded').length, before + 1, `样本必须真的入账（否则后面对 C-51 的断言无意义）：${receipt}`)
  return receipt
}

// ———————————————— 落点零：参数面必须**存在**（否则下面 ② 的样本根本造不出来） ————————————————

test('M98-00 sdo_test 的 parameters schema 里必须有 waiveReason / waiveApprovedBy（缺一个 ⇒ 边界静默丢弃）', async () => {
  // **注意形状**：注册表里的是完整 JSON Schema（`{ type:'object', properties:{…} }`），
  // 参数键在 `properties` 底下 —— 直接在 schema 顶层找字段名会永远找不到（这条守卫自己先踩过一次）。
  const schema = harness.tool('sdo_test').parameters
  assert.ok(schema !== undefined, '真实注册的 sdo_test 必须带 parameters')
  assert.equal(schema.type, 'object', 'sdo_test 的参数面必须是 object schema')
  const properties = schema.properties
  assert.ok(properties !== undefined, 'sdo_test 的参数面必须有 properties')
  for (const field of WAIVE_FIELDS) {
    const fieldSchema: { type?: string; description?: string } | undefined = properties[field]
    assert.ok(fieldSchema !== undefined, `工具边界上没有 \`${field}\`：模型照卡写也写不进去（值会被静默丢掉、回执还说成功）`)
    assert.equal(fieldSchema.type, 'string', `${field} 必须是 string（免责依据是自由文本）`)
    assert.ok((fieldSchema.description ?? '').length > 0, `${field} 必须写明语义（它只在 wontfix 时有意义，最容易被误用）`)
  }
  // 反例自证：这条守卫必须能照出"字段不在 schema 里"——拿一个不存在的名字试一次
  assert.equal(properties.noSuchWaiveField, undefined, '不存在的参数名理应取不到（守卫不是因为恒真才通过）')
})

// —————————————————————— ① 阻塞级 + wontfix + 依据不齐 ⇒ 判红并点名 ——————————————————————

test('M98-01 阻塞级 + wontfix + 只给理由（缺批准人）⇒ C-51 判红并点名该 DEF-id 与缺失字段', async () => {
  const receipt = await record({
    title: '阻塞级缺陷想用 wontfix 溜过验证门禁',
    severity: 'blocker',
    status: 'wontfix',
    waiveReason: '排期外，本轮不修',
  })
  assert.match(receipt, /DEF-001/u, `回执要点名缺陷 id：${receipt}`)
  assert.match(receipt, /waiveApprovedBy/u, `回执要点名**缺哪个**字段（否则"补依据"无从下手）：${receipt}`)

  // 判据侧：**判红 + 点名**，不是只回一句 ok=false
  const verdict = c51()
  assert.equal(verdict.ok, false, '阻塞级 + wontfix + 依据不齐备 ⇒ 必须判红（这正是 DEF-038 的漏洞：旧实现放行）')
  assert.match(verdict.detail, /DEF-001/u, `detail 必须点名该缺陷：${verdict.detail}`)
  assert.match(verdict.detail, /waiveApprovedBy/u, `detail 必须点名缺的那个字段：${verdict.detail}`)
  // 修法必须是**可执行**的（假修法比现状更糟：回执叫人去补，而工具面上没有出口）
  assert.match(verdict.remedy ?? '', /sdo_test action=defect/u, `修法要给出命令：${verdict.remedy ?? '(无)'}`)
  assert.match(verdict.remedy ?? '', /status=closed/u, `修法要给出"修掉并关闭"这条出口：${verdict.remedy ?? '(无)'}`)

  // 读数与判据同源：这条缺陷在**盘上**仍是"未关闭的阻塞级缺陷"
  const stats = verificationStats(store(), journal())
  assert.equal(stats.blockersOpen, 1, '依据不齐备的阻塞级 wontfix 必须**仍然**计入 blockersOpen（否则读数还在替它遮掩）')
})

test('M98-02 阻塞级 + wontfix + 只给批准人（缺理由）⇒ 同样判红（单边不算齐备）', async () => {
  await record({ title: '只写了批准人，没写为什么不修', severity: 'blocker', status: 'wontfix', waiveApprovedBy: '李四' })
  const verdict = c51()
  assert.equal(verdict.ok, false, '只写人不写理由 = 无从复核 ⇒ 不得放行')
  assert.match(verdict.detail, /DEF-001/u, `要点名缺陷：${verdict.detail}`)
  assert.match(verdict.detail, /waiveReason/u, `要点名缺的字段：${verdict.detail}`)
})

test('M98-03 阻塞级 + wontfix + 两个字段都**没给** ⇒ 仍判红（"标一个 wontfix 就归零"必须消失）', async () => {
  await record({ title: '裸 wontfix', severity: 'blocker', status: 'wontfix' })
  const verdict = c51()
  assert.equal(verdict.ok, false, '裸 wontfix 是 DEF-038 的原始形态：用户裁定不改放过')
  assert.match(verdict.detail, /DEF-001/u, `要点名缺陷：${verdict.detail}`)
  for (const field of WAIVE_FIELDS) {
    assert.ok(verdict.detail.includes(field), `两个字段都要在点名里出现（缺哪个都算不齐备）：${verdict.detail}`)
  }
  assert.equal(verificationStats(store(), journal()).blockersOpen, 1, '读数不得再被 wontfix 抹平')
})

test('M98-04 空白串不算"填了"⇒ 可读拒绝且**不入账**；给真值才入账（两态）', async () => {
  const before = events('defect/recorded').length
  const blank = await sdoTest({
    action: 'defect',
    title: '拿空白串冒充免责依据',
    severity: 'blocker',
    status: 'wontfix',
    waiveReason: '   ',
    waiveApprovedBy: '李四',
  })
  assert.match(blank, /❌/u, `空白串必须**可读拒绝**：${blank}`)
  assert.match(blank, /waiveReason/u, `要点名是哪个字段给了空白：${blank}`)
  assert.equal(events('defect/recorded').length, before, '判红时**不许**入账（判红却落盘 = 假拒绝）')
  assert.equal(listDefects(store()).length, 0, '被拒的缺陷不许留在台账里')

  // 换成真值 ⇒ 入账（证明上一步拒的是"空白"，不是"这个参数不被支持"）
  const ok = await record({ title: '拿真值补上', severity: 'blocker', status: 'wontfix', waiveReason: '排期外', waiveApprovedBy: '李四' })
  assert.match(ok, /DEF-001/u, `给了真值就应当入账：${ok}`)
  assert.equal(listDefects(store()).length, 1)
})

// ————————————————— ② 齐备 ⇒ 放行 + 单列（★ 裁定 A 的可观察形式） —————————————————

test('M98-05 阻塞级 + wontfix + 理由与批准人齐备（经工具面构造）⇒ 放行且回执单列该缺陷', async () => {
  const receipt = await record({
    title: '已知偏差，用户裁定本轮不修',
    severity: 'blocker',
    status: 'wontfix',
    waiveReason: '用户 2026-10-13 裁定：影响面可控，随下一版一起修',
    waiveApprovedBy: '张三',
  })
  // ① **参数真的被接收**：只看 append-only 真源（工具面静默丢弃的话这里读不出来）
  const data = lastEvent('defect/recorded')
  assert.equal(data.waiveReason, '用户 2026-10-13 裁定：影响面可控，随下一版一起修', '免责理由必须从真源事件读得回')
  assert.equal(data.waiveApprovedBy, '张三', '批准人必须从真源事件读得回')
  // 人读视图同样落盘（`defects/*.yml` 可手改，但它是"人看的那一份"）
  const defect = store().readYaml<{ defect: Defect }>('defects', 'DEF-001.yml')?.defect
  assert.equal(defect?.waiveReason, '用户 2026-10-13 裁定：影响面可控，随下一版一起修')
  assert.equal(defect?.waiveApprovedBy, '张三')
  // 回执回显被接收的字段名（不回显就等于让调用方猜）
  assert.match(receipt, /waiveReason/u, `回执要回显被接收的字段名：${receipt}`)
  assert.match(receipt, /waiveApprovedBy/u, `回执要回显被接收的字段名：${receipt}`)

  // ② **放行**，且回执**单列**这一条（可见即约束）
  const verdict = c51()
  assert.equal(verdict.ok, true, `依据齐备就应当放行：${verdict.detail}`)
  assert.match(verdict.detail, /DEF-001/u, `放行时也必须**单列**该缺陷（可见即约束）：${verdict.detail}`)
  assert.match(verdict.detail, /张三/u, `单列要带**批准人**：${verdict.detail}`)
  assert.match(verdict.detail, /影响面可控/u, `单列要带**不修的理由**：${verdict.detail}`)
  // 单列小标题来自语言包（读同一把键，不把中文抄进断言）
  const heading = lang().zh.uiGates?.kDefectWaivedHeading ?? ''
  assert.ok(heading.length > 0 && heading !== keyTail('uiGates.kDefectWaivedHeading'), 'uiGates.kDefectWaivedHeading 必须在中文语言包里')
  assert.ok(verdict.detail.includes(heading), `回执必须带上单列的小标题（否则"放行"与"没看见"分不开）：${verdict.detail}`)

  // ③ 读数：这条**不再**拦住门禁
  assert.equal(verificationStats(store(), journal()).blockersOpen, 0, '齐备的免责应当让 blockersOpen 归零（这就是"放行"的机械含义）')
})

test('M98-06 更新路径也受理这两个字段（先裸 wontfix 判红 ⇒ 补齐依据后放行，逐条留痕）', async () => {
  await record({ title: '先标 wontfix，依据后补', severity: 'blocker', status: 'wontfix' })
  assert.equal(c51().ok, false, '依据不齐备时先判红（本用例的起点）')

  const receipt = await sdoTest({
    action: 'defect',
    defectId: 'DEF-001',
    waiveReason: '用户在评审会上口头批准不修',
    waiveApprovedBy: '张三',
  })
  assert.match(receipt, /DEF-001/u, `更新回执要点名缺陷：${receipt}`)
  // 更正必须落 **append-only 事件**：字段与前后值都读得回（回执说"已更新"不算数）
  const updated = lastEvent('defect/updated')
  const changes = updated.changes as { field: string; from: string; to: string }[]
  const fields = changes.map((change) => change.field)
  assert.ok(fields.includes('waiveReason'), `waiveReason 的更正必须进 changes：${JSON.stringify(changes)}`)
  assert.ok(fields.includes('waiveApprovedBy'), `waiveApprovedBy 的更正必须进 changes：${JSON.stringify(changes)}`)
  assert.equal(changes.find((change) => change.field === 'waiveApprovedBy')?.to, '张三', '事件里要带上更正后的值')
  assert.equal(changes.find((change) => change.field === 'waiveReason')?.from, '', '从"没有"到"有"要如实记 from（空串 = 原先没有这个键）')

  assert.equal(c51().ok, true, '补齐依据后应当放行（"判红 → 补齐 → 放行"这条修法链必须是通的）')
})

// —————————————————————— ③ 非阻塞级 wontfix ⇒ 不误伤 ——————————————————————

test('M98-07 非阻塞级 + wontfix 但两个免责字段一个字都没给 ⇒ 仍放行（语义不变、不读这两字段）', async () => {
  await record({ title: 'major 的小瑕疵，决定不修', severity: 'major', status: 'wontfix' })
  await record({ title: 'minor 的措辞问题，决定不修', severity: 'minor', status: 'wontfix' })

  const verdict = c51()
  assert.equal(verdict.ok, true, `非阻塞级的 wontfix 语义不变（DEF-038 只针对阻塞级）：${verdict.detail}`)
  assert.equal(verificationStats(store(), journal()).blockersOpen, 0, '非阻塞级本来就不计入阻塞读数')
  // **不读这两字段**：没给就不该出现在"以 wontfix 放行"的清单里（那清单只列**阻塞级**）
  const heading = lang().zh.uiGates?.kDefectWaivedHeading ?? ''
  assert.equal(verdict.detail.includes(heading), false, `非阻塞级不得被列进"以 wontfix 放行的阻塞级缺陷"：${verdict.detail}`)
  assert.equal(verdict.detail.includes('DEF-001'), false, '非阻塞级缺陷不该出现在这条判据的详单里')
})

// —————————————————————— ④ 阻塞级 + open / fixed ⇒ 原行为不变 ——————————————————————

test('M98-08 阻塞级 + open ⇒ 仍判红（原行为不变）', async () => {
  await record({ title: '真·没修的阻塞级缺陷', severity: 'blocker', status: 'open' })
  const verdict = c51()
  assert.equal(verdict.ok, false, '阻塞级 open 必须判红（这是既有行为，本轮不许改松）')
  assert.match(verdict.detail, /DEF-001/u, `要点名缺陷：${verdict.detail}`)
})

test('M98-09 阻塞级 + fixed ⇒ 仍判红；改成 closed 才放行（闭合才是出口）', async () => {
  await record({ title: '修了但没关闭', severity: 'blocker', status: 'fixed' })
  const verdict = c51()
  assert.equal(verdict.ok, false, 'fixed（已修未关闭）仍算未闭合 ⇒ 判红')
  assert.match(verdict.detail, /DEF-001/u, `要点名缺陷：${verdict.detail}`)

  await sdoTest({ action: 'defect', defectId: 'DEF-001', status: 'closed' })
  const after = c51()
  assert.equal(after.ok, true, `关闭之后应当放行：${after.detail}`)
  assert.equal(verificationStats(store(), journal()).blockersOpen, 0, '已关闭的不计入阻塞读数')
})

// —————————————————————— 落点二：文案必须在语言包里、en 侧零中文 ——————————————————————

test('M98-10 新增判据文案落语言包（两层 section.key），en 侧无中文，且 gates.ts 棘轮不超基线', async () => {
  const packs = lang()
  const keys = [
    'kDefectWaiveIncomplete',
    'kDefectWaiveFieldReason',
    'kDefectWaiveFieldApprover',
    'kDefectWaivedHeading',
    'kDefectWaivedLine',
  ]
  for (const key of keys) {
    for (const locale of ['zh', 'en'] as const) {
      const value = packs[locale].uiGates?.[key]
      assert.ok(value !== undefined && value.trim() !== '', `${locale} 的 uiGates.${key} 必须存在且非空（否则回执漏出键名）`)
    }
    // 占位符口径：判红/单列用到的 {p1}… 两包必须一致（错位会让回执印错东西）
    const placeholders = (text: string | undefined): string => [...(text ?? '').matchAll(/\{p\d+\}/gu)].map((match) => match[0]).sort().join(',')
    assert.equal(
      placeholders(packs.zh.uiGates?.[key]),
      placeholders(packs.en.uiGates?.[key]),
      `uiGates.${key} 的占位符两包不一致（会印错值）`,
    )
    assert.equal(/[\u4e00-\u9fff]/u.test(packs.en.uiGates?.[key] ?? ''), false, `en 侧 uiGates.${key} 不得残留中文`)
  }
  // **棘轮**：`gates.ts` 被钉在硬编码中文 0（新增文案只能来自语言包，不许就地写中文）
  const gatesSource = readFileSync(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8')
  assert.equal(countCjkLiterals(gatesSource), 0, 'gates.ts 的硬编码中文字面量必须保持 0（本轮不得放宽棘轮）')
})
