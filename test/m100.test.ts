/**
 * M100：**已声明修复的缺陷必须闭合或署名放弃**（TASK-072 / DEF-050 / 判据 `C-63`）。
 *
 * ## 病根（DEF-050，用户 2026-10-13 裁定「若是插件缺陷，登记，修」）
 * 缺陷（`.sdo/defects/*.yml`）与卡（`.sdo/tasks/*.yml`）是**两本独立真源**，插件此前
 * **没有任何地方**把"卡做完了"与"它要修的那条缺陷该闭合了"连起来：
 *   · 卡完成 ⇄ 评审有 `C-42`/`C-52`；缺陷 ⇄ 需求有 `C-58`；**唯独这条边缺失**；
 *   · 后果①：修复已落地的缺陷长期停在 `open`（DEF-004/005/006/009/022）；
 *   · 后果②（更危险）：文档写"已修"而代码一字未动（DEF-008）——**任何判据都没逮住**；
 *   · 后果③：`C-51` 只覆盖 blocker，已修未闭合的 major/minor 无限期沉在 open，
 *     而缺陷追溯覆盖率照样显示 100%（覆盖率与闭合状态是**两个维度**）。
 *
 * ## 修法形状
 * `TaskCard.fixes?: string[]`（声明通道）+ 判据 `C-63`（`details.fixes-closed`，挂在
 * waterfall/prototype/spiral 的 **G5**、agile 的 **G6**）+ `done` 回执逐条回显。
 *
 * ## 本文件的断言面（卡上落点四的六态 + 两条边界）
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | `done` 卡 + `fixes` 里那条缺陷仍 `open` | **判红**，且**点名卡 id + 缺陷 id + 缺什么** |
 * | ② | 同一条缺陷已 `fixed` | 绿 |
 * | ③ | `wontfix` + 免责两字段齐备 | 绿（且单列署名放弃项） |
 * | ④ | `wontfix` 缺字段 | 红 |
 * | ⑤ | 卡**未** `done`（缺陷仍 open） | **不参与**（不误伤） |
 * | ⑥ | `fixes` 塞不存在的缺陷 id | **可读拒绝**（工具边界，不静默丢弃） |
 * | ⑦ | 没有任何完成卡声明 `fixes`（**存量全库的形态**） | `na`（不适用、不阻止放行） |
 * | ⑧ | 挂点 = 四个流程的 `C-63` 各在本流程的验证侧门禁上 | waterfall/prototype/spiral → G5；agile → G6 |
 *
 * ## 三条纪律
 *   ① **判据走真实接线**：断言的是 `CHECKERS['details.fixes-closed']`（判据集里注册的那一个），
 *      不是本文件另写一份口径 —— 否则判据改了、用例照绿。
 *   ② **红线断言必须点名**：只断言 `ok === false` 会把"判据没跑"与"判据判红"混为一谈；
 *      每条红线都钉住**具体名字**（`TASK-…` / `DEF-…` / `open` / 语言包里那句文案）。
 *   ③ **文案取自语言包**：`gates.ts` 被 i18n 棘轮钉在硬编码中文 0，回执里的话一律
 *      `uiGates.kFix*`；本文件按**同一把键**取样渲染后再比对，不把中文写死在断言里。
 *
 * 红绿自证（变异）在盘外夹具 `node_modules/.sdo-test/m100-mutation/`：把判定改成"`open` 也放过"
 * 的编译产物留档一份，本文件的 ① 与 ④ 即对着它转红（逐条 killed），复原后逐字节自证。
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
import { listTasks, writeTask } from '../src/domain/plan.js'
import { Journal } from '../src/infra/journal.js'
import { loadPackagedYaml } from '../src/infra/data.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm100')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'm100-session'
const CHECK = 'details.fixes-closed'

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
    exec: () => ({ name: 'sdo_task', arguments: {}, agent: { session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } } }),
    fire: (event, payload) => listeners.get(event)?.(payload as never),
  }
}

/** 走**真实注册的工具**：`sdo_task`（声明通道的样本都从这里进）。 */
async function sdoTask(args: Record<string, unknown>): Promise<string> {
  return String(await harness.tool('sdo_task').execute(args, harness.exec()))
}

function store(): SdoStore {
  return new SdoStore(join(WORKSPACE, '.sdo'))
}

function journal(): Journal {
  return new Journal(store())
}

/** **判据的真实接线**（判据集里注册的那一个，不是本文件另写一份口径）。 */
function c63(): { ok: boolean; na: boolean; detail: string; remedy: string } {
  const checker = CHECKERS[CHECK]
  assert.equal(typeof checker, 'function', `${CHECK} 必须在 CHECKERS 里注册（C-63 的挂点是它）`)
  if (checker === undefined) throw new Error(`${CHECK} 未注册`)
  const ctx = { workspace: WORKSPACE, store: store(), journal: journal(), requirements: [] } as unknown as GateContext
  const verdict = checker(ctx)
  return {
    ok: verdict.ok === true,
    na: verdict.na === true,
    detail: verdict.detail ?? '',
    remedy: verdict.remedy ?? '',
  }
}

/** 语言包里的文案（判据文案一律走语言包，断言里不写死中文）。 */
function packs(): { zh: Pack; en: Pack } {
  return {
    zh: loadPackagedYaml<Pack>('src/data/lang/zh-CN.yml'),
    en: loadPackagedYaml<Pack>('src/data/lang/en.yml'),
  }
}

/** 取 `section.key` 的**中文原文**（键名回退时返回空串 —— 用它判"文案到底有没有落进语言包"）。 */
function zhText(key: string): string {
  const [section, ...rest] = key.split('.')
  const value = (packs().zh[section ?? ''] ?? {})[rest.join('.')]
  return value === undefined || value === rest.join('.') ? '' : value
}

/** 模板的**静态前缀**（第一个占位符之前那段）—— 用来断言"回执里那句话确实来自语言包"。 */
function head(key: string): string {
  return zhText(key).split('{p1}')[0] ?? ''
}

/** 模板里 `{pN}` **之后**那段：有的模板以 `{p1}` 打头（`head()` 对它们是空串），
 *  有的把结论放在 `{p2}` 之后 —— 取哪一段由调用方指定，避免"前半截对不上"的假红。 */
function tailAfter(key: string, index: number): string {
  const parts = zhText(key).split(/\{p\d+\}/u)
  return parts.slice(index).join('').trim()
}

/** 夹具卡：只钉本判据关心的字段，其余给合法缺省。 */
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
    writeScopes: [],
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'done',
    requirements: [],
    fixes: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

/** 夹具缺陷（**只用于"卡 → 缺陷"这条边的样本**；缺陷本身的登记通道是 TASK-063 的判据面）。 */
function defect(id: string, status: string, extra: Record<string, unknown> = {}): void {
  store().writeYaml(['defects', `${id}.yml`], {
    defect: { id, title: `样本 ${id}`, severity: 'major', status, at: '2026-10-13T00:00:00.000Z', ...extra },
  })
}

beforeEach(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  harness = makeHarness()
  harness.fire('session/created', { id: SESSION, header: { cwd: WORKSPACE } })
  const receipt = await harness.tool('sdo_init').execute(
    { name: 'M100 夹具', process: 'waterfall', scale: 'normal', stakeholders: '批准人,执行者' },
    harness.exec(),
  )
  assert.match(String(receipt), /PRJ-001/u, `夹具立项失败：${String(receipt)}`)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// ——————————— 落点零：声明通道必须**存在**（缺一处就会被静默丢弃） ———————————————————

test('M100-00 sdo_task 的 parameters schema 里有 fixes（缺它 ⇒ 模型照卡写也写不进去，值被静默丢掉）', () => {
  // **注意形状**：注册表里是完整 JSON Schema（`{ type:'object', properties:{…} }`），
  // 参数键在 `properties` 底下 —— 在 schema 顶层找字段名会永远找不到（M98-00 踩过同一个坑）。
  const schema = harness.tool('sdo_task').parameters
  assert.ok(schema !== undefined, '真实注册的 sdo_task 必须带 parameters')
  assert.equal(schema.type, 'object', 'sdo_task 的参数面必须是 object schema')
  const properties = schema.properties
  assert.ok(properties !== undefined, 'sdo_task 的参数面必须有 properties')
  const field = properties.fixes
  assert.ok(field !== undefined, '工具边界上没有 `fixes`：卡上的声明通道从模型侧就进不来（知识库 tq_ff348198 的真机教训）')
  // **DEF-073（2026-10-14 机制缺陷批）**：口径已从「只认 JSON 文本」改为**两形态都收**
  //（`oneOf:[string,array]` + `compositeArg` 归一）。旧断言「不是数组」本身就是那条缺陷的措辞：
  // 模型按自然形态传数组时，宿主在 schema 校验阶段就拒签、插件收不到调用。
  // JSON 文本形态**仍然照旧可用**（下面两条断言守住这一点）。
  // 类型上用**宽松读法**：这份文件也会被 `test/task001-red-baseline` 拿**冻结的旧类型**编译一遍，
  // 直接写 `field.oneOf` 会在那边编译不过（探针跑不动就测不了红）。
  const fieldShape = field as { oneOf?: { type?: string }[] }
  assert.ok(fieldShape.oneOf !== undefined, 'fixes 必须是联合形态（string | array），否则传数组会被宿主拒签')
  const shapes = (fieldShape.oneOf ?? []).map((item) => item.type).sort()
  assert.deepEqual(shapes, ['array', 'string'], '两形态都要在（JSON 文本 + 真数组）')
  assert.ok((field.description ?? '').length > 0, 'fixes 必须写明语义与三条拒绝（重复 / 空串 / 不存在的 id）')
  assert.ok((field.description ?? '').includes('DEF-'), `描述里要给出 id 形态，否则模型会塞需求号：${field.description ?? ''}`)
  // 反例自证（防恒真）：不存在的参数名理应取不到
  assert.equal(properties.noSuchFixesField, undefined, '不存在的参数名理应取不到（守卫不是因为恒真才通过）')
})

// ————————————————— ① done 卡 + 缺陷仍 open ⇒ 判红并**逐条点名** —————————————————

test('M100-01 done 卡声明修的缺陷仍是 open ⇒ C-63 判红，点名卡 id + 缺陷 id + 缺什么，并给可执行修法', () => {
  defect('DEF-901', 'open')
  writeTask(store(), card('TASK-901', { fixes: ['DEF-901'] }))

  const verdict = c63()
  assert.equal(verdict.ok, false, '卡说修完了、台账说还开着 ⇒ 必须判红（这正是 DEF-050 的第①种后果）')
  // **点名三件套**：卡 id、缺陷 id、缺什么 —— 缺任何一件，"该补什么"就无从下手
  assert.match(verdict.detail, /TASK-901/u, `判红必须点名是哪张卡：${verdict.detail}`)
  assert.match(verdict.detail, /DEF-901/u, `判红必须点名是哪条缺陷：${verdict.detail}`)
  assert.match(verdict.detail, /open/u, `判红必须给出**现状态**（"仍 open"与"找不到"是两回事）：${verdict.detail}`)
  assert.match(verdict.detail, /kFixStatusOpen|仍|still/iu, `要点名缺什么：${verdict.detail}`)
  assert.ok(verdict.detail.includes(head('uiGates.kFixRowOpen')), `判红文案应当由语言包渲染：${verdict.detail}`)
  // **可执行修法**：得能照抄一条命令，否则判红只是"报了个错"
  assert.match(verdict.remedy, /sdo_test action=defect/u, `修法必须给出登记通道：${verdict.remedy}`)
  assert.match(verdict.remedy, /DEF-/u, `修法要点名 id 形态：${verdict.remedy}`)
})

test('M100-01b 判红细节逐条对照语言包（不是本文件另写的一句话）', () => {
  defect('DEF-902', 'open')
  writeTask(store(), card('TASK-902', { fixes: ['DEF-902'] }))
  const verdict = c63()
  const zh = packs().zh
  assert.ok(zhText('uiGates.kFixUnclosed').includes('{p1}'), 'kFixUnclosed 必须是带占位符的模板')
  assert.ok(zhText('uiGates.kFixRemedy').length > 40, '修法文案必须在语言包里（gates.ts 是硬编码中文 0 的棘轮文件）')
  assert.ok(verdict.detail.startsWith(head('uiGates.kFixUnclosed')), `判红详情要以 kFixUnclosed 开头：${verdict.detail}`)
  assert.equal(verdict.remedy, zhText('uiGates.kFixRemedy'), '修法必须**逐字**取自语言包')
  for (const key of ['kFixUnclosed', 'kFixRowOpen', 'kFixStatusOpen', 'kFixWaiveIncomplete', 'kFixRemedy', 'kFixOk', 'kFixNa', 'kFixDuplicate', 'kFixBlank', 'kFixUnknown', 'kFixEchoHeading', 'kFixEchoClosed', 'kFixEchoOpen']) {
    assert.notEqual((zh.uiGates ?? {})[key], undefined, `语言包缺 uiGates.${key}（代码引用它，缺了会回退成键名）`)
    assert.notEqual((packs().en.uiGates ?? {})[key], undefined, `en 语言包缺 uiGates.${key}（半翻译会被 M7 判红）`)
  }
})

// ———————————————————————— ② 已 fixed ⇒ 绿 ————————————————————————

test('M100-02 同一条缺陷已 fixed ⇒ 绿（修复落地且闭合口径成立）', () => {
  defect('DEF-903', 'fixed')
  writeTask(store(), card('TASK-903', { fixes: ['DEF-903'] }))
  const verdict = c63()
  assert.equal(verdict.ok, true, `fixed 必须放行：${verdict.detail}`)
  assert.equal(verdict.na, false, '有声明就不是 N/A')
  assert.match(verdict.detail, /1/u, `回执要给出核对了多少条：${verdict.detail}`)
  // `closed` 是同一条出口的另一种写法（doD ①写的是 `∈ {fixed, closed}`）
  defect('DEF-904', 'closed')
  writeTask(store(), card('TASK-904', { fixes: ['DEF-904'] }))
  assert.equal(c63().ok, true, 'closed 与 fixed 同等放行')
})

// ————————————————— ③ wontfix + 免责两字段齐备 ⇒ 绿（且单列） —————————————————

test('M100-03 wontfix + waiveReason/waiveApprovedBy 去空白后都非空 ⇒ 绿，且回执**单列**署名放弃项', () => {
  defect('DEF-905', 'wontfix', { waiveReason: '  成本大于收益，且已有替代路径  ', waiveApprovedBy: '  张三  ' })
  writeTask(store(), card('TASK-905', { fixes: ['DEF-905'] }))
  const verdict = c63()
  assert.equal(verdict.ok, true, `署名放弃必须放行（口径同 DEF-038）：${verdict.detail}`)
  assert.match(verdict.detail, /DEF-905/u, `放行不等于看不见：署名放弃项要单列出来：${verdict.detail}`)
  assert.match(verdict.detail, /成本大于收益/u, '单列要带理由，否则"放行"与"没判"读不出区别')
  assert.match(verdict.detail, /张三/u, '单列要带批准人')
  assert.ok(verdict.detail.includes(head('uiGates.kDefectWaivedHeading')), `单列要有小标题（复用 C-51 那套口径）：${verdict.detail}`)
})

// ——————————————————— ④ wontfix 缺字段 ⇒ 红 ———————————————————

test('M100-04 wontfix 缺免责字段 ⇒ 判红并点名缺哪一个（单边不算齐备）', () => {
  defect('DEF-906', 'wontfix', { waiveReason: '只写了理由' })
  writeTask(store(), card('TASK-906', { fixes: ['DEF-906'] }))
  const verdict = c63()
  assert.equal(verdict.ok, false, '只给理由 ⇒ 没人负责，不算署名放弃')
  assert.match(verdict.detail, /DEF-906/u, `要点名缺陷：${verdict.detail}`)
  assert.match(verdict.detail, /waiveApprovedBy/u, `要点名缺的字段：${verdict.detail}`)
  // 反向：只写批准人同样不算
  defect('DEF-907', 'wontfix', { waiveApprovedBy: '李四' })
  writeTask(store(), card('TASK-907', { fixes: ['DEF-907'] }))
  const other = c63()
  assert.equal(other.ok, false, '只给批准人 ⇒ 无从复核，不算署名放弃')
  assert.match(other.detail, /waiveReason/u, `要点名缺的字段：${other.detail}`)
  // 空白串不算"填了"（与 DEF-038 同口径：去空白后非空才算齐备）
  defect('DEF-908', 'wontfix', { waiveReason: '   ', waiveApprovedBy: '李四' })
  writeTask(store(), card('TASK-908', { fixes: ['DEF-908'] }))
  const blank = c63()
  assert.equal(blank.ok, false, '空白串不算齐备（否则等于给自己发了一张空头免责单）')
  assert.match(blank.detail, /waiveReason/u, `空白串也要点名：${blank.detail}`)
})

// ——————————————————— ⑤ 未 done 的卡不参与（不误伤） ———————————————————

test('M100-05 卡**未** done（缺陷仍 open）⇒ 判 N/A，不误伤（"缺陷还没修"在施工中本来就正常）', () => {
  defect('DEF-909', 'open')
  writeTask(store(), card('TASK-909', { status: 'in-progress', fixes: ['DEF-909'] }))
  const verdict = c63()
  // 三态语义（gates.ts 的 `na`）：`ok:false` + `na:true` —— N/A **既不算失败也不算通过**，
  // 由 `evaluateGate` 的 `criterion.ok || criterion.na === true` 兜住（这里断言的是判据自己的形状）。
  assert.equal(verdict.na, true, '这一态必须是 **na**（自成一态）：既不阻止放行，也不冒充"已核对通过"')
  assert.equal(verdict.ok, false, 'na 的形状是 ok:false + na:true（"没判"不许读成"判过了"）')
  assert.match(verdict.detail, /TASK-909|fixes/u, `N/A 也要说清为什么（差别在"没声明"还是"没完成"）：${verdict.detail}`)

  // 卡一 done，同一条缺陷立刻被逮住 —— 证明 ⑤ 的"不参与"只针对状态，不是把判据关掉了
  writeTask(store(), card('TASK-909', { status: 'done', fixes: ['DEF-909'] }))
  const after = c63()
  assert.equal(after.ok, false, '同一张卡置 done 后必须立刻判红（否则 ⑤ 就成了绕过判据的后门）')
  assert.match(after.detail, /DEF-909/u, `要点名缺陷：${after.detail}`)
})

test('M100-05b 没有任何完成卡声明 fixes（**存量全库的形态**）⇒ na，不阻止放行', () => {
  defect('DEF-910', 'open')
  writeTask(store(), card('TASK-910', { status: 'done' }))          // done 但没声明
  writeTask(store(), card('TASK-911', { status: 'in-progress', fixes: ['DEF-910'] })) // 声明了但没 done
  const verdict = c63()
  assert.equal(verdict.na, true, '一条声明都不成立 ⇒ N/A：新字段生效前建的卡读回来是空集，**不追溯**')
  assert.equal(verdict.ok, false, 'na 的形状是 ok:false + na:true')
  // `kFixNa` 是**不带占位符**的整句（head() 对它没意义）—— 直接比对语言包原文
  assert.ok(zhText('uiGates.kFixNa').length > 20, 'kFixNa 必须真的在语言包里')
  assert.ok(verdict.detail.includes(zhText('uiGates.kFixNa')), `N/A 要说清口径（逐字取自语言包）：${verdict.detail}`)
})

// ————————————— ⑥ fixes 塞不存在的缺陷 id ⇒ 可读拒绝 —————————————

test('M100-06 fixes 塞不存在的缺陷 id ⇒ 走真实工具**可读拒绝**，且不落盘（不静默丢弃）', async () => {
  writeTask(store(), card('TASK-912', { status: 'ready' }))
  const before = listTasks(store()).find((task) => task.id === 'TASK-912')?.fixes ?? []
  const receipt = await sdoTask({ action: 'update', id: 'TASK-912', fixes: '["DEF-999"]' })
  // 这三个模板都以 `{p1}` **打头** ⇒ head() 是空串，比对「{p1} 之后那段」才有效
  assert.ok(zhText('uiGates.kFixUnknown').includes('{p2}'), 'kFixUnknown 必须点名写错的号（{p2}）')
  assert.ok(receipt.includes(tailAfter('uiGates.kFixUnknown', 3)), `不存在的 id 必须**可读拒绝**（要点名是哪个号写错了）：${receipt}`)
  assert.match(receipt, /DEF-999/u, `回执要点名那个写错的号：${receipt}`)
  assert.match(receipt, /TASK-912/u, `回执要点名是哪张卡：${receipt}`)
  // **不许静默落盘**：被拒之后卡上的 fixes 必须与之前**逐字**相同
  const after = listTasks(store()).find((task) => task.id === 'TASK-912')?.fixes ?? []
  assert.deepEqual(after, before, '可读拒绝却把值写进去了 = 假拒绝')
})

test('M100-06b 重复 id 与空白串同样**可读拒绝**（三种非法形态各点名）', async () => {
  writeTask(store(), card('TASK-913', { status: 'ready' }))
  defect('DEF-911', 'open')

  const dup = await sdoTask({ action: 'update', id: 'TASK-913', fixes: '["DEF-911","DEF-911"]' })
  assert.ok(dup.includes(tailAfter('uiGates.kFixDuplicate', 2)), `重复 id 必须拒绝：${dup}`)
  assert.match(dup, /DEF-911/u, `要点名重复的是哪个号：${dup}`)

  const blank = await sdoTask({ action: 'update', id: 'TASK-913', fixes: '["DEF-911","  "]' })
  assert.ok(blank.includes(tailAfter('uiGates.kFixBlank', 1)), `空白串必须拒绝：${blank}`)

  // 形状错误（不是 JSON 数组）走既有的形状通道，不是这三条
  const shape = await sdoTask({ action: 'update', id: 'TASK-913', fixes: 'not-json' })
  assert.ok(shape.includes('fixes'), `形状错误应当报到 fixes 这个入参上：${shape}`)

  // 合法值必须真的**落盘**（否则上面三条"拒绝"可能只是因为这条通道整体没接上）
  const ok = await sdoTask({ action: 'update', id: 'TASK-913', fixes: '["DEF-911"]' })
  assert.ok(!ok.includes(tailAfter('uiGates.kFixUnknown', 3)), `合法声明不该被拒：${ok}`)
  assert.deepEqual(listTasks(store()).find((task) => task.id === 'TASK-913')?.fixes, ['DEF-911'], '合法声明必须落进真源')
})

// ——————————— 落点三：done 回执逐条回显（域层出口，工具层拼装） ———————————

test('M100-07 done 回执的逐条回显：open / fixed / wontfix 三态各给现状态（域层出口与判据同源）', async () => {
  const { report } = await import('../src/domain/collab.js')
  defect('DEF-912', 'open')
  defect('DEF-913', 'fixed')
  defect('DEF-914', 'wontfix', { waiveReason: '不修的理由', waiveApprovedBy: '王五' })
  writeTask(store(), card('TASK-914', { status: 'in-progress', owner: 'm100-owner', fixes: ['DEF-912', 'DEF-913', 'DEF-914'], evidenceRequired: [] }))

  const result = report(store(), journal(), {
    taskId: 'TASK-914',
    owner: 'm100-owner',
    status: 'done',
    evidence: [{ kind: 'workspace-changes', detail: 'm100', at: '2026-10-13T00:00:00.000Z' }],
  })
  // done 可能被别的门（写范围对账 / 测试先行…）拦下 —— 那不是本用例的断言面，据实跳过而非假绿
  if (!result.ok) {
    assert.ok(['tdd-result-untraceable', 'test-result-missing', 'test-case-missing', 'no-evidence', 'review-open-findings'].includes(result.code), `意外拒绝，需要看：${result.code} ${result.detail}`)
    return
  }
  const echo = result.fixEcho ?? []
  assert.equal(echo.length, 3, `三条声明要逐条回显：${echo.join(' | ')}`)
  const joined = echo.join('\n')
  assert.match(joined, /DEF-912/u, 'open 那条要点名')
  assert.match(joined, /open/u, 'open 那条要给现状态')
  assert.match(joined, /DEF-913/u, 'fixed 那条要点名')
  assert.match(joined, /fixed/u, 'fixed 那条要给现状态')
  assert.match(joined, /DEF-914/u, 'wontfix 那条要点名')
  assert.match(joined, /不修的理由/u, 'wontfix 那条要回显理由（署名放弃也是放弃，理由必须当场可见）')
  assert.match(joined, /王五/u, 'wontfix 那条要回显批准人')
  // 文案取自语言包（两把键各管一种结局）
  assert.ok(joined.includes(head('uiGates.kFixEchoClosed')), `闭合项走 kFixEchoClosed：${joined}`)
  assert.ok(joined.includes(head('uiGates.kFixEchoWaived')), `署名放弃项走 kFixEchoWaived（不许与 fixed 混成同一句话）：${joined}`)
  assert.ok(joined.includes(head('uiGates.kFixEchoOpen')), `未闭合项走 kFixEchoOpen：${joined}`)
  // 回显**不是**拦截：判据仍然判红（两处口径一致，不会互相打脸）
  assert.equal(c63().ok, false, '回显不改变判据结论：这一批里 DEF-912 仍 open')
})

// ——————————— 落点二：四个流程的挂点（3 有 G5 + 1 挂 G6） ———————————

test('M100-08 挂点：waterfall/prototype/spiral 的 C-63 在 **G5**，agile 在 **G6**（三有 G5、一挂 G6）', () => {
  const hit = (file: string): { gate: string; check: string; desc: string } => {
    const process = loadProcess(file)
    if (process === undefined) throw new Error(`${file} 流程定义读不出来`)
    for (const gate of process.gates ?? []) {
      for (const criterion of gate.criteria ?? []) {
        if (criterion.id === 'C-63') return { gate: gate.id, check: criterion.check, desc: criterion.desc ?? '' }
      }
    }
    throw new Error(`${file} 里没有 C-63 判据（挂点缺失 = 判据写了没人挂，门禁永远不会跑它）`)
  }
  const expected: [string, string][] = [['waterfall', 'G5'], ['prototype', 'G5'], ['spiral', 'G5'], ['agile', 'G6']]
  for (const [file, gate] of expected) {
    const found = hit(file)
    assert.equal(found.gate, gate, `${file} 的 C-63 必须挂 ${gate}`)
    assert.equal(found.check, CHECK, `${file} 的 C-63 必须指向注册的检查器 ${CHECK}`)
    assert.ok(found.desc.includes('wontfix'), `${file} 的 desc 要写清 wontfix 的免责出口：${found.desc.slice(0, 80)}`)
    assert.ok(found.desc.includes('存量'), `${file} 的 desc 要写明**存量不追溯**（否则读者以为它替全库核对过）：${found.desc.slice(0, 80)}`)
  }
  // 反面自证：agile **没有** G5（所以它只能挂 G6）—— 这条不是"三个流程都要另找门"
  const agile = loadProcess('agile')
  if (agile === undefined) throw new Error('agile 流程定义读不出来')
  assert.equal((agile.gates ?? []).some((gate) => gate.id === 'G5'), false, 'agile 确实没有 G5（挂 G6 是唯一正确落点）')
  for (const file of ['waterfall', 'prototype', 'spiral']) {
    const process = loadProcess(file)
    if (process === undefined) throw new Error(`${file} 流程定义读不出来`)
    assert.equal((process.gates ?? []).some((gate) => gate.id === 'G5'), true, `${file} 有 G5（就地挂，不另造门）`)
  }
})

test('M100-09 C-63 的判据 id 没有被别的判据占用（零占用才可以用）', () => {
  const seen: [string, string, string][] = []
  for (const file of ['waterfall', 'prototype', 'spiral', 'agile']) {
    const process = loadProcess(file)
    if (process === undefined) throw new Error(`${file} 流程定义读不出来`)
    for (const gate of process.gates ?? []) {
      for (const criterion of gate.criteria ?? []) {
        if (criterion.id === 'C-63') seen.push([file, gate.id, criterion.check])
      }
    }
  }
  assert.deepEqual(seen, [
    ['waterfall', 'G5', CHECK],
    ['prototype', 'G5', CHECK],
    ['spiral', 'G5', CHECK],
    ['agile', 'G6', CHECK],
  ], 'C-63 只能有这四个挂点：多出来的说明 id 被复用了（同一编号两条判据 = 读者无从对账）')
  // 语言包里 `C-63` 这把键也没被占用过（C-60 已被 delivery.manifest 占用 —— 本卡换号的原因）
  // 判据编号表在语言包的 `criterion` 段（小写）；C-60 已被 delivery.manifest 占用正是本卡换号的原因
  const en = packs().en as Record<string, Record<string, string>>
  assert.equal(en.criterion?.['C-63'], undefined, 'C-63 此前不该在语言包的判据表里（本轮才新增；占用说明选了已被用掉的号）')
  assert.notEqual(en.criterion?.['C-60'], undefined, 'C-60 已被占用（对照证据：本卡因此改用 C-63）')
})

test('M100-10 sdo_task action=list 的回执**带上 fixes**（可见即约束：只躺在 YAML 里的声明等于没有）', async () => {
  defect('DEF-915', 'open')
  writeTask(store(), card('TASK-915', { status: 'in-progress', fixes: ['DEF-915'] }))
  const board = await sdoTask({ action: 'list' })
  assert.ok(board.includes('TASK-915'), `看板必须列出这张卡：${board.slice(0, 200)}`)
  assert.match(board, /DEF-915/u, `声明必须在看板回执里看得见（否则读回执的人根本不知道这张卡声称修了什么）：${board}`)
  assert.ok(board.includes(head('uiIndex.kFixCards')) || board.includes(zhText('uiIndex.kFixCards')), `那一段要有标题（取自语言包）：${board}`)

  // 反面自证（防恒真）：没有声明的卡不进那一段
  writeTask(store(), card('TASK-916', { status: 'in-progress' }))
  const board2 = await sdoTask({ action: 'list' })
  const section = board2.split(zhText('uiIndex.kFixCards'))[1] ?? ''
  assert.ok(section.includes('TASK-915'), `声明过的卡要在段内：${section.slice(0, 200)}`)
  assert.ok(!section.includes('TASK-916'), `没声明过的卡不许出现（否则这一段是"全部卡"而不是"声明过的卡"）：${section.slice(0, 200)}`)
})
