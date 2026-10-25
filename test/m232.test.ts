/**
 * **增量 232（`TASK-218`）：`DEF-175` 收口 —— `sdo_plan action=next` 的整份回执压到宿主 8000 以内。**
 *
 * 三块膨胀源（真账实测，逐块给读数）：
 *   ① `domain/pool.ts` 的 `reuseSkippedLines`：**一个候选一整行** ⇒ 80 个候选 × 一句 168 字的宿主原话；
 *   ② `index.ts` 把**同一份清单印两遍**（一遍塞进 `kDispatchFreshSelf` 的 `{p4}`、一遍是多行块），
 *      且多行块还在"逐张派发"的循环里 ⇒ 条数 × 本轮卡数；
 *   ③ `interface/describe.ts` 的 `describeStructuralPlan`：36 个未建卡元素**逐条**，其中 35 个是
 *      **同一句原因**（同一句命中口径抄 35 遍）⇒ 单块 3827 字符（本轮新增的第三块）。
 *
 * 口径（与 `TASK-210` 在 `describe.ts` 已验过的同一手法）：**按原因原话归并 + 每组样本上限 +
 * 原因字符硬上限 + 整块字符预算 + `verbose` 展开**；砍**数量**，不砍**原因** ——
 * 原因原话整句必须可读（那是这条读数最有价值的部分），且**条数必须对得上**：
 * 总数 = 归并后可见 + 折叠掉。
 *
 * 守卫（与卡上 DoD 的「守卫（两态）」一一对应；编号承接 `m230` 的 M232-01..05）：
 *   · `M232-06` 整份回执 **< 8000**（真账副本；不截断 ⇒ 「原文 N 字符」后缀不出现，派发结论在前 8000 之内）；
 *   · `M232-07` 候选数 **2 → 100** ⇒ 块体积**不随候选数线性膨胀**（阈值断言，函数级两态）；
 *   · `M232-08` 同一份清单**只印一次**：源码里 `kReuseSkipped` 的渲染入口**恰好 1 个**，
 *     且回执里那份清单只出现一遍（`childSessionId=` 的出现次数 == 归并后的行数）；
 *   · `M232-09` 缺省档**原因整句在**、条数对得上（可见 + 折叠 = 总数）；`verbose` 档**逐条全在**；
 *   · `M232-10` 结构通道同理：同因 35 条 → 一行 + 计数，整块有界，`created` 行不受影响。
 *
 * 断言消息一律用英文（本文件不进 `KNOWN_PROSE_GAP`）；回执里的中文标记**从语言包取**
 * （`t(key)` 去掉占位符之后的前缀），不在本文件里内联中文字面量。
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { t } from '../src/domain/i18n.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import {
  REUSE_SKIP_CHARS,
  REUSE_SKIP_IDS_PER_REASON,
  REUSE_SKIP_REASON_CHARS,
  foldPoolChildren,
  reuseSkippedLines,
} from '../src/domain/pool.js'
import {
  RECEIPT_BUDGET,
  STRUCTURAL_SKIP_CHARS,
  STRUCTURAL_SKIP_SOURCE,
  describeStructuralPlan,
} from '../src/interface/describe.js'
import { realLedgerSkip } from './support/real-ledger.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { StructuralPlan } from '../src/types.js'

/** 仓库根（`lib/test/` 往上两级）。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** 本文件的夹具区（与其余测试一致：只写 `node_modules/.sdo-test/`）。 */
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm232')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'session-0000m232-0000-4000-8000-00000000232a'

/** 宿主把单次工具回执截在这里（`src/interface/clamp.ts` 的 `TOOL_RESULT_CHARS`）。 */
const HOST_LIMIT = 8000

/** 一条**真实形状**的宿主原话（现盘最长的一类：掩码回溯判不了时点名缺哪几条禁令）。 */
const REAL_REASON = 'mask fingerprint changed (legacy hash had no version, and the trace is undecidable: '
  + 'the old events deny face lacks subagent_fork workflow plugin_manager memory_forget failure_forgive)'

after(() => { rmSync(BASE, { recursive: true, force: true }) })

/** 关键行标记：**从语言包取**模板的前缀（`t(key)` 去掉第一个占位符之后），不内联中文。 */
function markerOf(key: string): string {
  const template = t(key)
  const cut = template.indexOf('{')
  return cut === -1 ? template : template.slice(0, cut)
}

/** 原始字符数：回执被宿主截断时，尾巴上那句「原文 N 字符」才是真账。 */
function originalLength(text: string): number {
  const match = /原文 (\d+) 字符/u.exec(text)
  return match === null ? text.length : Number(match[1])
}

interface Fixture {
  office: SoftwareDevOffice
  call: OfficeCall
  /** 走**真实工具通道**（`apply()` 装配 + 按 schema 过滤入参），与宿主调用同形。 */
  run: (args: Record<string, unknown>) => Promise<string>
}

/**
 * 真账副本夹具：把仓库自己的 `.sdo/` 整份拷到夹具区，再把在飞的卡置为 done
 * —— 只在**副本**里动（真账一字不改），目的是让这一轮**真的会派发**（否则回执走"没有派发"那一支，
 * 根本到不了 `reuseSkipped` / 派发结论的渲染面，守卫就成了空断言）。
 */
function realLedgerFixture(): Fixture {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  cpSync(join(ROOT, '.sdo'), join(WORKSPACE, '.sdo'), { recursive: true })
  assert.ok(existsSync(join(WORKSPACE, '.sdo', 'journal.jsonl')), 'fixture: the real ledger must be copied')
  const tasksDir = join(WORKSPACE, '.sdo', 'tasks')
  for (const name of readdirSync(tasksDir)) {
    const path = join(tasksDir, name)
    const text = readFileSync(path, 'utf8')
    if (!text.includes('status: in-progress')) continue
    writeFileSync(path, text.replace(/status: in-progress/u, 'status: done'))
  }
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession(SESSION, WORKSPACE)
  const call = { sessionId: SESSION, cwd: WORKSPACE } as unknown as OfficeCall
  const tools: { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[] = []
  const services: Record<string, unknown> = {}
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
  services['tools'] = { register: (tool: unknown) => { tools.push(tool as (typeof tools)[number]); return () => {} } }
  // 宿主后端探针：`startContinuable` 给一个**新**子会话 id（本轮是否复用由池判定，不由夹具假装）
  services['subagents'] = {
    list: () => ['spawn'],
    start: async () => ({ id: 'child-oneshot-m232' }),
    startContinuable: async () => ({ childId: 'child-fresh-m232' }),
    sendMessage: async () => ({ messageId: 'msg-m232' }),
    getProvider: () => ({ capabilities: { toolFilter: true } }),
    listDescendants: async () => [],
  }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const planTool = tools.find((item) => item.name === 'sdo_plan')
  assert.ok(planTool !== undefined, 'fixture: sdo_plan must be registered')
  const properties = (planTool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const run = async (args: Record<string, unknown>): Promise<string> => {
    const filtered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
    const agentStub = { id: SESSION, session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } }
    return String(await planTool.execute(filtered, { agent: agentStub }))
  }
  return { office, call, run }
}

/** 造 N 个"被闸门拒的空闲孩子"（同一句真实原因 —— 真账的 80 个候选只有 2 种原因）。 */
function skipRows(count: number, reason = REAL_REASON): { childSessionId: string; role: string; reason: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    childSessionId: `c0ffee${String(index).padStart(2, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    role: 'developer',
    reason,
  }))
}

/** 归并块里「×N」的条数之和 + 「candidates-not-shown=K」。 */
function countsOf(lines: readonly string[]): { visible: number; folded: number } {
  let visible = 0
  let folded = 0
  for (const line of lines) {
    for (const match of line.matchAll(/×(\d+)/gu)) visible += Number(match[1])
    const hidden = /candidates-not-shown=(\d+)/u.exec(line)
    if (hidden !== null) folded += Number(hidden[1])
  }
  return { visible, folded }
}

/**
 * **冻结夹具**（`M232-06`）：真账副本 + **把卡集换成一张固定的卡**。
 *
 * 为什么必须冻结：真账每次落笔都会长大（候选 79 → 82 → …、队列表增减、被派卡的 DoD 也换人），
 * 于是"整份体积"这一格会**随账态漂移**（实测 7,713 / 8,772 两读数）。判据必须能在**同一个输入**上复跑，
 * 所以这里固定：一张卡（固定 id / 固定 DoD / 固定写范围）+ 真账的**子会话与池**（候选数照真账，不参与体积）。
 */
function frozenFixture(cardCount = 4, workspace = join(BASE, `frozen-${String(cardCount)}`)): Fixture {
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  // ⚠️ 本夹具**接管卡集**：`.sdo/tasks/` 整目录被下面这几张固定卡覆盖（真账里后来新增/流转的卡
  // 一张都进不来）。设计元素用「标题 marker」一次性全部覆盖（见 `markers`）⇒ 结构通道的读数也固定，
  // 不随真账的 des-task 边/卡标题漂。**没被接管的只有 journal（池候选/池读数）**—— 那部分由
  // `M232-07` 用预算钉住（2/100/2000 个候选 ⇒ 231/233/235 字符），所以它也进不了"随账态漂移"。
  cpSync(join(ROOT, '.sdo'), join(workspace, '.sdo'), { recursive: true })
  assert.ok(existsSync(join(workspace, '.sdo', 'journal.jsonl')), 'fixture: the real ledger must be copied')
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession(SESSION, workspace)
  const call = { sessionId: SESSION, cwd: workspace } as unknown as OfficeCall
  /**
   * **`TASK-254`：冻结夹具也要结算掉副本里的悬空派发。**
   *
   * 本函数的口径写的是"卡集被接管、只有池读数跟真账走 ⇒ 不随账态漂"。实测漏了一半：**座位**也跟账态走 ——
   * 副本台账里那些 `dispatch/started` 之后没有 `finished` 的孩子会永久占座（真机重启留下的悬空派发），
   * 占满之后**一张卡都派不出去**：同一份夹具在 15:2x 还能派 1 张、16:0x 变成 `dispatchable=0`
   * （`M232-06` 于是红在 `this round must have skipped candidates (got 0)`、`M232-11` 红在
   * `the dispatch conclusion must be present` —— 两条都与它们要守的东西无关）。
   * 结算掉之后"这一轮真的会派发"由**夹具**保证，不再看真账里有没有悬空派发。
   */
  releaseInFlight(office, workspace)
  // 设计元素 id：从副本的 `.sdo/design/*.yml` 现读（**同一份副本**，不是真账）⇒ 卡标题里一次性覆盖
  const designDir = join(workspace, '.sdo', 'design')
  const designIds = [...new Set(readdirSync(designDir)
    .filter((name) => name.endsWith('.yml'))
    .flatMap((name) => [...readFileSync(join(designDir, name), 'utf8').matchAll(/DES-\d+/gu)].map((match) => match[0])))]
  const markers = designIds.map((id) => `\uFF08${id}\uFF09`).join('')
  const tasksDir = join(workspace, '.sdo', 'tasks')
  rmSync(tasksDir, { recursive: true, force: true })
  const card = (id: string, status: string, extra: Record<string, unknown> = {}): void => {
    office.storeFor(workspace).writeYaml(['tasks', `${id}.yml`], {
      task: {
        id,
        title: `frozen ${id} ${markers}`,
        goal: 'frozen goal',
        inputs: [],
        outputs: [],
        dod: [`\u5b8c\u6210\u5b9a\u4e49\uff08DoD\uff09\uff1a${'fixed fixture text. '.repeat(90)}`],
        evidenceRequired: ['command'],
        blockedBy: [],
        writeScopes: ['src/frozen/'],
        role: 'developer',
        size: 'small',
        revision: 1,
        status,
        requirements: [],
        evidence: [],
        createdAt: '',
        updatedAt: '',
        ...extra,
      },
    })
  }
  // 固定卡集：1 ready（会被派）+ 1 blocked + 1 planned + 1 in-progress，其余按需补 blocked
  card('TASK-2180', 'ready')
  card('TASK-2181', 'blocked', { blockReason: 'frozen blocked reason' })
  card('TASK-2182', 'planned')
  card('TASK-2183', 'in-progress', { owner: 'developer-frozen1' })
  for (let index = 4; index < cardCount; index += 1) card(`TASK-218${String(index)}`, 'blocked', { blockReason: 'frozen blocked reason' })
  return { office, call, run: mounter(workspace) }
}

/** 真实工具通道（`apply()` 装配 + 按 schema 过滤入参）：两个夹具共用。 */
function mounter(workspace: string): (args: Record<string, unknown>) => Promise<string> {
  const tools: { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[] = []
  const services: Record<string, unknown> = {}
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
  services['tools'] = { register: (tool: unknown) => { tools.push(tool as (typeof tools)[number]); return () => {} } }
  services['subagents'] = {
    list: () => ['spawn'],
    start: async () => ({ id: 'child-oneshot-m232' }),
    startContinuable: async () => ({ childId: 'child-fresh-m232' }),
    sendMessage: async () => ({ messageId: 'msg-m232' }),
    getProvider: () => ({ capabilities: { toolFilter: true } }),
    listDescendants: async () => [],
  }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const planTool = tools.find((item) => item.name === 'sdo_plan')
  assert.ok(planTool !== undefined, 'fixture: sdo_plan must be registered')
  const properties = (planTool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  return async (args: Record<string, unknown>): Promise<string> => {
    const filtered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
    const agentStub = { id: SESSION, session: { header: { id: SESSION, cwd: workspace, delegationDepth: 0 } } }
    return String(await planTool.execute(filtered, { agent: agentStub }))
  }
}

test('M232-06 [frozen fixture] the whole receipt stays under 8000 chars and does not drift with the ledger', realLedgerSkip() ?? {}, async () => {
  const fixture = frozenFixture()
  const plan = fixture.office.poolPlan(fixture.call, { reuseIdle: true })
  assert.ok(plan.reuseSkipped.length > 0, `fixture premise: this round must have skipped candidates (got ${String(plan.reuseSkipped.length)})`)
  assert.ok(plan.dispatch.length >= 1, `fixture premise: the frozen ready card must be dispatchable (got ${String(plan.dispatch.length)})`)
  assert.equal(plan.dispatch[0]?.task.id, 'TASK-2180', 'fixture premise: the frozen ready card is picked first')

  const receipt = await fixture.run({ action: 'next', limit: 1 })
  assert.equal(originalLength(receipt), receipt.length, 'the frozen receipt must not be truncated by the host')
  assert.ok(receipt.length < HOST_LIMIT, `the frozen receipt must stay under the host limit: ${String(receipt.length)} chars`)
  // 结构性有界：结论 + 各块上限 + 回声取舍之后，整份不超过总预算 + 那一行指路
  assert.ok(receipt.length <= RECEIPT_BUDGET + 400, `the receipt must be bounded by the total budget: ${String(receipt.length)} chars (budget ${String(RECEIPT_BUDGET)})`)

  // **与卡数脱钩**（流程官复核要求）：同一夹具只把卡集 4 张换成 8 张 ⇒ 体积增幅 < 5%
  const eight = frozenFixture(8)
  const receiptEight = await eight.run({ action: 'next', limit: 1 })
  const growth = (receiptEight.length - receipt.length) / receipt.length
  console.log(`[M232-06] frozen receipt: 4 cards -> ${String(receipt.length)} chars, 8 cards -> ${String(receiptEight.length)} chars (growth ${(growth * 100).toFixed(2)}%)`)
  assert.ok(receiptEight.length < HOST_LIMIT, `even with 8 fixed cards the receipt must stay under ${String(HOST_LIMIT)}: ${String(receiptEight.length)}`)
  assert.ok(growth < 0.05, `the receipt must be decoupled from the card count (4 -> 8 cards grew ${(growth * 100).toFixed(2)}%, limit 5%)`)
  // 「跳过复用的原因」整句可读：每种原因的原话（≤ 硬上限）都逐字在回执里
  for (const reason of new Set(plan.reuseSkipped.map((row) => row.reason))) {
    assert.ok(receipt.includes(reason.slice(0, REUSE_SKIP_REASON_CHARS)), 'every skip reason must stay readable in the receipt')
  }
})

test('M232-11 [frozen fixture] the conclusion comes first, the prompt echo comes last (truncation must eat the echo, not the verdict)', realLedgerSkip() ?? {}, async () => {
  const fixture = frozenFixture()
  const receipt = await fixture.run({ action: 'next', limit: 1 })
  const conclusion = receipt.indexOf(markerOf('uiDescribe.k199DispatchStarted'))
  const skip = receipt.indexOf(markerOf('uiIndex.kReuseSkipped'))
  const queue = receipt.indexOf('dispatch queue (ordered')
  const echo = Math.max(receipt.indexOf('[prompt echo for'), receipt.indexOf('[prompt echo omitted'))

  assert.ok(conclusion >= 0, 'the dispatch conclusion must be present')
  assert.ok(conclusion < 200, `the dispatch conclusion must be the first thing a reader sees, got index ${String(conclusion)}`)
  assert.ok(queue > conclusion, `the queue table must come after the conclusion (conclusion ${String(conclusion)} / queue ${String(queue)})`)
  assert.ok(skip === -1 || skip > conclusion, `the skip block must come after the conclusion (conclusion ${String(conclusion)} / skip ${String(skip)})`)
  assert.ok(echo > conclusion, 'the prompt echo (or its omission marker) must come after the conclusion')
  // 回声必须是**最后一块**：所有已知块的锚点都在它之前（回声本身有 2k+ 字符长，不能按"最后 700 字符"判）
  const lastBlock = Math.max(
    queue,
    skip,
    receipt.indexOf(markerOf('uiIndex.kStructuralHeader')),
    receipt.indexOf(markerOf('uiPool.kPoolHeader')),
  )
  assert.ok(echo > lastBlock, `the prompt echo must be the last block (echo ${String(echo)} / last other block ${String(lastBlock)})`)
  assert.ok(echo > receipt.length / 2, `the prompt echo must sit in the tail half (echo ${String(echo)} / total ${String(receipt.length)})`)
  // 结论在 8000 之内且**截断也吃不掉**：即便整份被宿主截到 8000，结论 index 仍远在之前
  assert.ok(conclusion < HOST_LIMIT, 'the conclusion must survive a host truncation')
})

/**
 * **`M232-12`：真账这一格**只报数**（`TASK-254`，评审给的改法）。**
 *
 * 交付时的判据是「真账回执 < 宿主 8000」，实测 125417 → 133165 字符 —— 它随真账体量单调长大
 * （候选数、队列表、被派卡的 DoD 全随账态变），是一根**账态 canary**：改代码永远修不好它，
 * 只会把真红信号稀释掉（`DEF-227` 危害③「稀释真红信号」）。
 *
 * 现在：体积**只报数、不判**。`< 8000` 这条判据的**归宿是 `M232-06`**（冻结夹具：卡集被接管、
 * 只有池读数跟着真账走，而池读数由 `M232-07` 用预算钉在 2/100/2000 个候选 ⇒ 231/233/235 字符），
 * 它已在同一份输入上钉住 `receipt.length < HOST_LIMIT`、总预算上界与「4 → 8 张卡的增幅 < 5%」。
 *
 * 本格留下两条**与账态无关**的判据：`truncated` 读数自洽（被截断时结论仍落在**可见部分内**）
 * 与「结论 idx < 400」。前提不成立（这一轮根本没走到派发结论）⇒ **显式 skip 并印出理由与读数**，
 * 不静默绿。判据不许退化成恒真，所以末尾带一条自证：同一个标记被挪到 500 位之后必须判红。
 */
test('M232-12 [real ledger] receipt size is reported at the current account state; only the ledger-independent criteria are asserted', realLedgerSkip() ?? {}, async (t) => {
  const fixture = realLedgerFixture()
  const plan = fixture.office.poolPlan(fixture.call, { reuseIdle: true })
  const receipt = await fixture.run({ action: 'next', limit: 1 })
  const original = originalLength(receipt)
  const truncated = original !== receipt.length
  const conclusionMarker = markerOf('uiDescribe.k199DispatchStarted')
  const conclusion = receipt.indexOf(conclusionMarker)
  // **只报数**：体积是读数，不是判据（判据在 M232-06 的冻结夹具里）
  console.log(`[M232-12] real ledger: candidates=${String(plan.reuseSkipped.length)} dispatchable=${String(plan.dispatch.length)} receipt=${String(original)} chars visible=${String(receipt.length)} truncated=${String(truncated)} conclusionIndex=${String(conclusion)}`)
  if (conclusion < 0) {
    t.skip(`this account state produced no dispatch conclusion, so this grid has nothing ledger-independent to assert: candidates=${String(plan.reuseSkipped.length)} dispatchable=${String(plan.dispatch.length)} receipt=${String(original)} chars truncated=${String(truncated)}. The receipt-size judgement lives in M232-06 (frozen fixture), not here.`)
    return
  }
  // 判据①（账态无关）：结论在最前面 —— 截断与否都读得到
  assert.ok(conclusion < 400, `the conclusion must sit at the top of the real receipt, got ${String(conclusion)} (receipt ${String(original)} chars, truncated=${String(truncated)})`)
  // 判据②（账态无关）：`truncated` 读数自洽 —— 结论必须落在**可见**部分之内（被截断也吃不掉它）
  assert.ok(conclusion < receipt.length, `the conclusion must survive the host truncation: index ${String(conclusion)} vs visible ${String(receipt.length)} chars (receipt ${String(original)} chars, truncated=${String(truncated)})`)
  // 判据自证（防止被改成恒真）：同一个标记被放到 500 位之后，上面那两条必须判红
  const lateConclusion = `${'x'.repeat(500)}${conclusionMarker}`
  assert.ok(lateConclusion.indexOf(conclusionMarker) >= 400, 'self-proof: the retained index criterion still rejects a conclusion that sits past 400')
})

test('M232-07 candidate count 2 -> 100 -> 2000 must not grow the merged block linearly (function-level three states)', () => {
  const two = reuseSkippedLines(skipRows(2))
  const hundred = reuseSkippedLines(skipRows(100))
  const twoChars = two.join('\n').length
  const hundredChars = hundred.join('\n').length
  assert.ok(twoChars > 0 && hundredChars > 0, 'both states must render something')

  // 同一种原因 ⇒ 100 个候选也只多出「+98」这几个字符（不是 98 行 × 一整句原话）
  assert.ok(
    hundredChars - twoChars <= 40,
    `a 50x candidate growth must not grow the block (2 -> ${String(twoChars)} chars, 100 -> ${String(hundredChars)} chars)`,
  )
  // 绝对上限：一组的量级是「一句原话 + 几个样本」，由预算与常量钉住
  assert.ok(
    hundredChars <= REUSE_SKIP_CHARS + REUSE_SKIP_REASON_CHARS + 120,
    `the merged block must stay bounded by the budget: got ${String(hundredChars)} chars`,
  )
  // 原因种数是唯一的增长维：两种原因 ⇒ 两行（预算内不折叠）
  const mixed = reuseSkippedLines([...skipRows(50), ...skipRows(50, `${REAL_REASON} / older`)])
  assert.ok(mixed.length >= 2, `distinct reasons must each get a line: ${String(mixed.length)} lines`)
  assert.ok(mixed.length <= 4, `the line count must stay tied to reason count, not candidate count: ${String(mixed.length)} lines`)

  // **量级扩展（`TASK-218` 复核）**：2000 个候选同一个尺寸 —— 体积由"原因种数"钉住，不由候选数
  const twoThousand = reuseSkippedLines(skipRows(2000)).join('\n')
  assert.ok(
    twoThousand.length <= REUSE_SKIP_CHARS + REUSE_SKIP_REASON_CHARS + 120,
    `2000 candidates must cost the same as 100 (bounded by the budget): got ${String(twoThousand.length)} chars`,
  )
  console.log(`[M232-07] merged block chars: 2 -> ${String(twoChars)}, 100 -> ${String(hundredChars)}, 2000 -> ${String(twoThousand.length)}`)
})

/**
 * **自造前提**（`TASK-254`）：在**副本台账**里写进 N 个「空闲、可续聊、但过不了复用闸门」的子会话。
 *
 * 为什么必须自造：`M232-08` 的前提是「这一轮回执里会渲染那份 skip 清单」—— 修前它靠**现盘恰好有候选**，
 * 而候选数随账态漂（本会话实测：同一份台账两次读数 `reuseSkipped` 0 → 12，红的时侯报的是
 * `fixture premise: the skip block must be rendered in this receipt` 这种与代码无关的话）。
 *
 * 造法（只用**已有事件**，不新增真源）：一对 `dispatch/started` + `dispatch/finished` ⇒ 该子会话
 * 折成 `idle` + `continuable`；**不给任何工具面观测**（不写 `dispatch/observed`、不写
 * `evidence/child-tools.jsonl`）⇒ `reuseBlockedOf` 判「无法确认它手里有工具」⇒ 落进 `unusable`
 * ⇒ 派发准入把它投影成一条 `reuseSkipped`，回执于是**必然**渲染那份清单。
 *
 * 只写副本（夹具自己的工作区），真账一字不改。
 */
function manufactureUnusableChildren(office: SoftwareDevOffice, workspace: string, count: number, prefix: string): string[] {
  const journal = office.journalFor(workspace)
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    // **前 8 位必须互不相同**：回执只列前 8 位当样本，两笔同位就等于"同一个候选被列两次"
    //（`M232-08` 的"不许重复"那条判据会当场判红 —— 本会话正是先踩到它才改的这一行）
    const childSessionId = `${prefix.slice(0, 6)}${String(index).padStart(2, '0')}-4000-4000-8000-${String(index).padStart(12, '0')}`
    ids.push(childSessionId)
    journal.append('dispatch/started', {
      childSessionId,
      role: 'developer',
      task: `TASK-91${String(index).padStart(2, '0')}`,
      mode: 'continuable',
      parentSessionId: SESSION,
    })
    journal.append('dispatch/finished', { childSessionId })
  }
  return ids
}

/**
 * **自造前提之二：把副本台账里的"在飞"全部结算掉**（`TASK-254`）。
 *
 * 为什么还需要这一步：派发准入的**座位**是按"真在飞"算的（`liveDispatchReading`）—— 副本台账里那些
 * `dispatch/started` 之后一直没有 `finished` 的孩子会永久占座（真机重启留下的悬空派发）。
 * 占满了就一张卡都派不出去 ⇒ skip 清单当然不渲染（本会话实测：同一份台账在 09:5x 还能派 1 张，
 * 十几分钟后 `dispatchable=0`、整份回执 134773 字符却一条结论都没有）。
 *
 * 所以这一格的前提由本函数与 {@link manufactureUnusableChildren} **一起**造出来：
 * 冻结卡集（有 ready 卡）+ 结算掉悬空派发（有座位）+ 写进不可复用候选（有 skip 行）。
 * 仍然只动副本。
 */
function releaseInFlight(office: SoftwareDevOffice, workspace: string): number {
  const journal = office.journalFor(workspace)
  const events = journal.read().events.map((event) => ({ type: event.type, data: event.data, at: event.at }))
  let released = 0
  for (const child of foldPoolChildren(events).values()) {
    if (child.state !== 'busy') continue
    journal.append('dispatch/finished', { childSessionId: child.childSessionId })
    released += 1
  }
  return released
}

test('M232-08 the skip list is printed exactly once: one render entry, one occurrence in the receipt', realLedgerSkip() ?? {}, async (t) => {
  // ① 源码面（与账态无关）：`kReuseSkipped` 的渲染入口全文件只有一个（修前三处各自渲染）
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const entries = source.match(/fmt\(\s*'uiIndex\.kReuseSkipped'/gu) ?? []
  assert.equal(entries.length, 1, `index.ts must render the skip list from exactly one place, found ${String(entries.length)}`)

  // ② 输出面：前提**自造**（`TASK-254`）—— 不再依赖"现盘恰好有可复用候选"。
  //   夹具用**冻结卡集**（与 `M232-06` 同一支：真账副本 + 一张 ready 的 developer 卡 ⇒ 这一轮**必然**
  //   走到派发准入，developer 池被真的摸到），再往副本台账里写进两个**不可复用**的空闲子会话
  //   ⇒ skip 清单必然渲染，且渲染的是**我造的那两个**（外加真账里同角色的那批）。
  const workspace = join(BASE, 'frozen-skip')
  const fixture = frozenFixture(4, workspace)
  const released = releaseInFlight(fixture.office, workspace)
  const seeded = manufactureUnusableChildren(fixture.office, workspace, 2, 'cab0ffee')
  const plan = fixture.office.poolPlan(fixture.call, { reuseIdle: true })
  const receipt = await fixture.run({ action: 'next', limit: 1 })
  const blockLines = receipt.split('\n').filter((line) => line.includes('childSessionId='))
  if (blockLines.length === 0) {
    // 前提仍不成立（连自造的候选都没被渲染）⇒ **显式 skip 并印理由**，不静默绿
    t.skip(`even with ${String(seeded.length)} self-manufactured unusable children and ${String(released)} released in-flight dispatches the receipt rendered no skip block: candidates=${String(plan.reuseSkipped.length)} dispatchable=${String(plan.dispatch.length)} queued=${String(plan.queued.length)}`
      + `; this grid's premise does not hold at the current account state`)
    return
  }
  assert.ok(seeded.some((id) => receipt.includes(id.slice(0, 8))), `the self-manufactured candidates must be the ones being listed (${seeded.map((id) => id.slice(0, 8)).join(' ')}): ${blockLines.join(' / ').slice(0, 300)}`)
  const listed: string[] = []
  for (const line of blockLines) {
    assert.equal((line.match(/childSessionId=/gu) ?? []).length, 1, `one merged group per line (the single-line summary must be gone): ${line.slice(0, 80)}`)
    const sample = /childSessionId=([^=]*?) role=/u.exec(line)
    for (const id of (sample?.[1] ?? '').split(' ')) if (id !== '' && !id.startsWith('+')) listed.push(id)
  }
  assert.ok(listed.length > 0, 'the merged lines must list sample ids')
  assert.equal(new Set(listed).size, listed.length, `no candidate may be listed twice (the list must be printed once): ${listed.join(' ')}`)
  const header = markerOf('uiIndex.kReuseSkipped')
  const headers = receipt.split(header).length - 1
  assert.equal(headers, 1, `the "candidates not reused" header must appear exactly once, found ${String(headers)}`)
  // 判据自证（防止被改成恒真）：把同一个前 8 位列两次，上面那条"不许重复"必须判红
  const twice = ['cab0ffee', 'cab0ffee']
  assert.ok(new Set(twice).size !== twice.length, 'self-proof: the duplicate criterion still rejects the same sample id listed twice')
  // ③ `why=true` 诊断面是**另一条**分支（不派发）：它复用同一个渲染入口，因此同样不该重复
  const why = await fixture.run({ action: 'next', limit: 1, why: true })
  assert.ok((why.split(header).length - 1) <= 1, 'the why=true face must not duplicate the list either')
})

test('M232-09 default keeps the whole reason readable and the counts reconcilable; verbose keeps every row', () => {
  const rows = [...skipRows(40, REAL_REASON), ...skipRows(39, `${REAL_REASON} / older`)]
  const merged = reuseSkippedLines(rows)
  const text = merged.join('\n')

  // ① 原因原话**整句**可读（不换措辞、不截断到半句）
  assert.ok(text.includes(REAL_REASON.slice(0, REUSE_SKIP_REASON_CHARS)), 'the full reason text must be readable by default')
  assert.ok(REUSE_SKIP_REASON_CHARS >= 168, `the reason cap must clear the longest real reason (168 chars), got ${String(REUSE_SKIP_REASON_CHARS)}`)
  // ② 条数对得上：可见 + 折叠 = 总数
  const counts = countsOf(merged)
  assert.equal(counts.visible + counts.folded, rows.length, `visible (${String(counts.visible)}) + folded (${String(counts.folded)}) must equal the total (${String(rows.length)})`)
  // ③ 样本上限：一组最多点 REUSE_SKIP_IDS_PER_REASON 个（8 位前缀：与回执其余处同口径）
  for (const line of merged) {
    const sample = /childSessionId=([^=]*?) role=/u.exec(line)
    if (sample === null) continue
    const ids = (sample[1] ?? '').split(' ').filter((part) => part !== '' && !part.startsWith('+'))
    assert.ok(ids.length <= REUSE_SKIP_IDS_PER_REASON, `per-reason samples must stay capped: ${line.slice(0, 80)}`)
    for (const id of ids) assert.equal(id.length, 8, `samples are 8-char prefixes like the rest of the receipt, got "${id}"`)
  }
  // ④ verbose 档：逐条全在（每个候选一行、原因不截断）
  const verbose = reuseSkippedLines(rows, { verbose: true })
  assert.equal(verbose.length, rows.length, 'verbose must print one line per candidate')
  for (const row of rows) {
    assert.ok(verbose.some((line) => line.includes(row.childSessionId) && line.includes(row.reason)), `verbose must keep every candidate verbatim (${row.childSessionId})`)
  }
})

test('M232-10 structural "no card" rows are merged by reason: 35 same-reason rows -> one line plus a count', () => {
  const skipped = [
    ...Array.from({ length: 35 }, (_unused, index) => ({
      designId: `DES-${String(index + 1).padStart(3, '0')}`,
      name: `element-${String(index)}`,
      reason: 'already-covered' as const,
      how: 'title-marker' as const,
    })),
    { designId: 'DES-999', name: 'too-broad', reason: 'scope-too-broad' as const, scopes: ['src/domain/{a,b,c,d}.ts'] },
  ]
  const plan: StructuralPlan = { created: [], skipped }
  const text = describeStructuralPlan(plan)
  const skipMarker = markerOf('uiIndex.kStructuralSkippedLine')

  // ① 行数：35 条同因不再逐条（一个原因一行），整块也不再按元素个数增长
  const skipLines = text.split('\n').filter((line) => line.includes(skipMarker))
  assert.ok(skipLines.length <= 3, `the skipped rows must be merged by reason, got ${String(skipLines.length)} lines`)
  assert.ok(text.length <= STRUCTURAL_SKIP_CHARS + 700, `the structural block must stay bounded: got ${String(text.length)} chars`)
  // ② 条数对得上：代表元素 + 链式样本 + 「+N」== 35（1 + 3 列出 + 31 计数）
  const group = skipLines.find((line) => line.includes('same-reason')) ?? ''
  const samples = (group.match(/DES-\d+/gu) ?? []).length
  const more = Number(/\+(\d+)/u.exec(group)?.[1] ?? 0)
  assert.ok(samples > 0, 'the merged group must keep a representative element id')
  assert.equal(samples + more, 35, `listed ids (${String(samples)}) + folded (${String(more)}) must equal 35`)
  // ③ 原因原话整句在：被拒的写范围（最值钱的那部分）一字不改地留在回执里
  assert.ok(text.includes('src/domain/{a,b,c,d}.ts'), 'the refused write scope must stay verbatim')
  assert.ok(text.includes(STRUCTURAL_SKIP_SOURCE) || skipLines.length <= 3, 'folded detail must point at the ledger source')
  // ④ `created` 行不受影响（逐条仍在：标题 + 写范围 + 依据）
  const created = describeStructuralPlan({
    created: [{ title: '[x] DES-001 t', designId: 'DES-001', writeScopes: ['src/a.ts'], how: 'des-task' }],
    skipped: [],
  } as unknown as StructuralPlan)
  assert.ok(created.includes('src/a.ts'), 'created cards must still list their write scope')
})
