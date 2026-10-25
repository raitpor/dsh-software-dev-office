/**
 * **增量 224：`DEF-179` —— `scripts/refresh-prose-gap.mjs` 的 `--write` 产物必须可编译、
 * 且重排整表不许吃掉表内历史注释。**
 *
 * 病根（`DEF-179`，`major`、`escaped`）：`TASK-184` 用脚本重生成 `test/m189.test.ts` 的
 * `KNOWN_PROSE_GAP`，拿到手的产物
 *   ① **多写一个闭合括号** —— `formatTable` 自带表尾 `  }`，调用方又接上 `source.slice(end + 1)`
 *      （该切片**以 `  }` 开头**）⇒ 产物里出现 `  }  }`，整份文件 `tsc` 直接 `TS1005`，
 *      当时只能由实现会话**手工补救**，脚本本身没修；
 *   ② **表内历史注释被静默丢弃** —— 重排只输出它认识的数据行，作者写在表里的登记说明
 *      （`TASK-163` 那条「登记同步」注释）至今不在表里。
 *
 * 两条都不是"谁忘了"，而是**缺守卫**：产物坏了只能等人撞到编译错，注释丢了根本不会报错。
 * 本文件把它们钉成**双态**守卫：
 *   M224-01 **坏产物必须判红** —— 修前的渲染模板原样留在这里当反例，真跑 `tsc`，必须 TS1005；
 *   M224-02 **修后产物必须能被 `tsc` 解析**（真调 `node_modules/typescript/bin/tsc`，不是"看起来像"）；
 *   M224-03 现盘真实表体（逐字节取自 `test/m189.test.ts`）与脚本对它重渲染后的表体都能被 `tsc` 解析；
 *   M224-04 **重排前后表内历史注释逐字相等**（以 `TASK-163` 的登记说明为样例）；
 *   M224-05 脚本对现盘登记表是**不动点**（用现盘自己的数字重渲染必须逐字节相等 ⇒ `--write` 不掀无意义 diff）。
 *
 * 全局"登记与现算恰好相等"那一条**不在这里重复断言**：`M199-07` 已经守着它（同一份读数，重复断言只会
 * 让"别的卡新增了带读散文断言的用例、还没重生成表"这件事把两条守卫一起顶红）。
 *
 * 断言消息一律用英文、中文只写在断言**之外**：本文件不进 `KNOWN_PROSE_GAP`
 * （本卡写范围不含 `test/m189.test.ts`），一写内联中文判据就会把散文棘轮顶红。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { setLocale } from '../src/domain/i18n.js'
import { createTask, listTasks, readyTasks } from '../src/domain/plan.js'
import { ORDER_BASIS_LABEL, SNAPSHOT_CHAR_BUDGET, isVolatileSnapshotLine, renderQueueTable, renderStatusSnapshot } from '../src/domain/snapshot.js'
import type { StatusSnapshot } from '../src/domain/snapshot.js'
import { SoftwareDevOffice } from '../src/office.js'
import { JOURNAL_FILE } from '../src/infra/journal.js'
import type { SdoConfig } from '../src/config.js'
import type { Journal } from '../src/infra/journal.js'
import type { SdoStore } from '../src/infra/store.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

/** 编译后本文件落在 `lib/test/`，仓库根是上两级。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const M189 = join(ROOT, 'test', 'm189.test.ts')

/** `scripts/refresh-prose-gap.mjs` 的**受守卫面**（脚本本身不是 TS，这里给出最小契约）。 */
interface GapScript {
  formatTable(gap: Record<string, number>, comments?: readonly string[]): string
  readRegistered(source?: string): { registered: Record<string, number>; start: number; end: number; body: string; source: string }
  rewriteSource(source: string, gap: Record<string, number>): string
  tableComments(body: string): string[]
}

const script = (await import(new URL('../../scripts/refresh-prose-gap.mjs', import.meta.url).href)) as unknown as GapScript

/** 脚本认的表头（与 `scripts/refresh-prose-gap.mjs` 的 `HEAD` 同形；M224-01 里会机械核对）。 */
const HEAD = 'const KNOWN_PROSE_GAP: Record<string, number> = {'

/**
 * 修前（`DEF-179` 之前的 `main()`）的**原样**渲染：表尾 `  }` 由模板自带，再接 `source.slice(end + 1)`
 * —— 这一行就是"多写一个闭合括号"的病根。反例留在**被测脚本之外**，才不会被自己顺手一起修掉。
 */
function buggyRewrite(source: string, gap: Record<string, number>): string {
  const { start, end } = script.readRegistered(source)
  const keys = Object.keys(gap).sort()
  const lines: string[] = []
  for (let index = 0; index < keys.length; index += 4) {
    lines.push('  ' + keys.slice(index, index + 4).map((key) => `'${key}': ${gap[key]}`).join(', ') + ',')
  }
  return `${source.slice(0, start)}${HEAD}\n${lines.join('\n')}\n  }${source.slice(end + 1)}`
}

/**
 * 夹具：`test/m189.test.ts` 里那段表的**同形**缩样 —— 表装在**调用实参里的回调**中（真表就装在
 * `test('…', () => { … })` 里），因为多写的那个 `}` 会先关掉回调、让后面的代码落进实参表 ⇒ 才是 `TS1005`
 * （`',' expected`），与现场一致；表内历史注释**逐字**取自 `TASK-163` 的登记说明。
 */
const FIXTURE = `declare function run(name: string, body: () => void): void
run('fixture', () => {
  const KNOWN_PROSE_GAP: Record<string, number> = {
  // **\`TASK-163\` 登记同步**：m206 新增四条派发面守卫（① 复用 ② 桶计数 ③ 三条字段 ④ 逐字节复现），
  // 新增站点 9-2=7 个（现算 2447 站点 / 215 文件那一行可复算）。只改登记值，未动抽取器。
  'test/a.test.ts': 1, 'test/b.test.ts': 2,
  }
  const total = Object.values(KNOWN_PROSE_GAP).reduce((sum, count) => sum + count, 0)
  if (total < 0) throw new Error('unreachable')
})
`

/** 重排后的"现算"：键换了位置、数量变了（数据行必须重排，历史注释必须活着）。 */
const NEW_GAP: Record<string, number> = { 'test/b.test.ts': 7, 'test/a.test.ts': 1, 'test/c.test.ts': 3 }

/** 表尾闭合括号在原文里的形态（`readRegistered` 的 `end` 指向它的前导换行）。 */
const CLOSE = '\n  }'

interface TscRun { status: number; output: string }

/** 真跑 `tsc`：临时目录里只有这一个 `.ts`（没有 tsconfig），`status !== 0` 即"解析不了"。 */
function typecheck(source: string): TscRun {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m224-'))
  try {
    writeFileSync(join(dir, 'fixture.ts'), source, 'utf8')
    const run = spawnSync(
      process.execPath,
      [TSC, '--noEmit', '--strict', '--target', 'es2023', '--module', 'nodenext', 'fixture.ts'],
      { cwd: dir, encoding: 'utf8' },
    )
    return { status: run.status ?? 1, output: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 从一份 `m189.test.ts` 里**逐字节**切出表体（表头到表尾 `  }`），供"单独编译表体"用。 */
function tableRegion(source: string): string {
  const { start, end } = script.readRegistered(source)
  return source.slice(start, end + CLOSE.length)
}

test('M224-01 修前模板的产物必须判红：多写一个闭合括号 ⇒ tsc TS1005（DEF-179 ①）', () => {
  assert.ok(TSC.endsWith(join('typescript', 'bin', 'tsc')), 'the guard must run the repo own tsc binary')
  // 反例模板必须和脚本同头，否则"红"可能只是拼错了表头
  assert.ok(script.formatTable({ 'test/x.test.ts': 1 }).startsWith(HEAD), 'fixture head must match the script head')
  const broken = buggyRewrite(FIXTURE, NEW_GAP)
  // 病根的确切形状：同一行里两个闭合括号（表尾一个 + 切片带回来的一个）
  assert.equal((broken.match(/\}  \}/gu) ?? []).length, 1, 'the pre-fix renderer must emit the doubled brace exactly once')
  const run = typecheck(broken)
  assert.notEqual(run.status, 0, 'the broken product must NOT compile')
  assert.match(run.output, /TS1005/u, `the broken product must fail with TS1005, got: ${run.output}`)
})

test('M224-02 修后产物必须能被 tsc 解析（双态的另一半）', () => {
  const good = script.rewriteSource(FIXTURE, NEW_GAP)
  assert.equal((good.match(/\}  \}/gu) ?? []).length, 0, 'the fixed renderer must not emit a doubled brace')
  const run = typecheck(good)
  assert.equal(run.status, 0, `the fixed product must compile, got: ${run.output}`)
  assert.equal(run.output, '', `tsc must stay silent on the fixed product, got: ${run.output}`)
})

test('M224-03 现盘真实表体与脚本重渲染后的表体都能被 tsc 解析', () => {
  const live = readFileSync(M189, 'utf8')
  const wrap = (table: string): string => `function table(): Record<string, number> {\n${table}\n  return KNOWN_PROSE_GAP\n}\n`
  const before = typecheck(wrap(tableRegion(live)))
  assert.equal(before.status, 0, `the live table region must compile, got: ${before.output}`)
  // 真表 + 一条被扰动后的现算 ⇒ 走脚本真正的重渲染路径（不是夹具）
  const parsed = script.readRegistered(live)
  const rerendered = script.rewriteSource(live, { ...parsed.registered, 'test/m189.test.ts': 99 })
  assert.equal((rerendered.match(/\}  \}/gu) ?? []).length, 0, 're-rendering the live table must not add a brace')
  const after = typecheck(wrap(tableRegion(rerendered)))
  assert.equal(after.status, 0, `the re-rendered live table region must compile, got: ${after.output}`)
  assert.equal(script.readRegistered(rerendered).registered['test/m189.test.ts'], 99, 'the re-rendered table must carry the new number')
})

test('M224-04 重排前后表内历史注释逐字相等（TASK-163 的登记说明为例，DEF-179 ②）', () => {
  const before = script.tableComments(script.readRegistered(FIXTURE).body)
  assert.equal(before.length, 2, 'the fixture must carry two historical comment lines')
  const product = script.rewriteSource(FIXTURE, NEW_GAP)
  const after = script.tableComments(script.readRegistered(product).body)
  // 逐字相等（不是"包含"、不是"条数相同"）：文字、缩进、顺序都不许变
  assert.deepEqual(after, before, 'historical comments inside the table must survive the rewrite byte for byte')
  for (const line of before) {
    assert.ok(product.includes(line), `the product must contain the note verbatim: ${line}`)
  }
  // 数据行确实被重排了（否则"注释还在"可能只是整表没写盘）
  assert.deepEqual(Object.keys(script.readRegistered(product).registered).sort(), Object.keys(NEW_GAP).sort())
  // 反例：修前模板把这些注释整段吃掉 —— 守卫必须能指出这一点
  const broken = script.tableComments(script.readRegistered(buggyRewrite(FIXTURE, NEW_GAP)).body)
  assert.deepEqual(broken, [], 'the pre-fix renderer must be shown to drop every in-table comment')
})

test('M224-05 脚本对现盘登记表是不动点（重排不洗表、不加括号）', () => {
  const live = readFileSync(M189, 'utf8')
  const parsed = script.readRegistered(live)
  // 用现盘自己的数字重渲染 ⇒ 必须**逐字节**等于现盘（否则 `--write` 每次都会掀起无意义的大 diff）
  assert.equal(script.rewriteSource(live, parsed.registered), live, 're-rendering the live table with its own numbers must be a fixed point (run --write to canonicalise the table)')
  // 现盘里不许留 DEF-179 ① 的伤疤（表尾同一行两个闭合括号）
  assert.equal((live.match(/\}  \}/gu) ?? []).length, 0, 'the live file must not carry a doubled closing brace')
  // 现盘表体必须能被解析出登记（表尾/表头的形态没跑偏）
  assert.ok(Object.keys(parsed.registered).length > 100, 'the live table must still parse into a full registration map')
})

/* ————————————————————————————————————————————————————————————————————————————————
 * **`TASK-185` 追加：驾驶舱状态快照 + 派发队列有序全表（可观测性① / `DEF-174` / `DEF-175`）**
 *
 * 为什么追加在本文件：卡上的写范围点名了 `test/m224.test.ts`（拆卡时它还是空号）。
 * 断言消息一律用英文、中文只写在断言**之外**（本文件不进 `KNOWN_PROSE_GAP`）——
 * 连"中文证据串"也不许进断言：把中文串塞进断言实参，会被散文棘轮记成一个**未登记站点**。
 * 于是所有"文案里有没有那句话"的判据都改判**结构化读数**（`verdict` 码 / `refs` / ASCII 投影）。
 * ———————————————————————————————————————————————————————————————————————————————— */

interface SnapFixture {
  office: SoftwareDevOffice
  call: OfficeCall
  workspace: string
  journal: Journal
  store: SdoStore
}

const SNAP_BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m224-snapshot/', import.meta.url))

/**
 * 心跳行按 `｜` 切**段**（渲染顺序：台账｜最近派发观测｜在飞子会话）。
 *
 * 为什么要切段：`REV-094#4` 指出裸子串断言是**恒真**的 —— 段外的任务号、seq、别的段里出现
 * 同一个数字就能让它过（当时判的就是「这一行里出现过 20」这种无锚点写法）。相对量断言必须
 * 锚在**带分钟语义的那一段**上。
 */
const beatSegments = (line: string): string[] => line.split('｜')

/**
 * 段内的分钟读数（**只有**带分钟语义的段才有值）：
 *   · 「N 分钟前」—— 台账最近落笔 / 最近派发观测；
 *   · 「已静 N 分钟」—— 在飞子会话那一行。
 * 段里没有这类读数 ⇒ `undefined`（**不返回 0** —— 0 在渲染里是"刚刚"）。
 */
const minuteReading = (segment: string): number | undefined => {
  const ago = /(\d+) 分钟前/u.exec(segment)
  if (ago !== null) return Number(ago[1])
  const quiet = /已静 (\d+) 分钟/u.exec(segment)
  return quiet === null ? undefined : Number(quiet[1])
}

/** 一台真实的办公室（真 `SdoStore` + 真 `Journal`）—— 快照的读数必须是**现算**，不是摆件。 */
function snapFixture(name: string, overrides: Partial<SdoConfig> = {}): SnapFixture {
  const workspace = join(SNAP_BASE, name)
  // **每条用例用自己的干净台账**：不清理就会继承上一轮留下的卡（id 会顺延、排序断言随之漂移）。
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({ ...overrides } as unknown as SdoConfig)))
  const sessionId = `s-${name}`
  office.noteSession(sessionId, workspace)
  const call = { sessionId, cwd: workspace } as unknown as OfficeCall
  office.init(call, { name: `M224 ${name}`, scale: 'normal', stakeholders: ['业务方'] })
  return { office, call, workspace, journal: office.journalFor(workspace), store: office.storeFor(workspace) }
}

/** 造一张计划中的卡（写范围按序号错开：本条测的是**排序**，不是写范围相交）。 */
function snapCard(f: SnapFixture, size: 'small' | 'medium' | 'large', scope: string): TaskCard {
  return createTask(f.store, f.journal, {
    title: `card ${scope}`,
    goal: 'g',
    dod: ['d'],
    role: 'developer',
    size,
    writeScopes: [scope],
  } as never)
}

const CJK = /[\u4e00-\u9fff]/u

test('M224-S1 (guard 1, two-state) mixed small+medium queue: ordered list puts small first and carries its rank', () => {
  const f = snapFixture('rank')
  // **缺陷形状**：先建的 `medium` 拿到更小的 id（`createTask` 自增）——
  // 这正是 `DEF-174` 的真机形状（`183 medium` 的 id 小于 `184 small`）。
  const medium = snapCard(f, 'medium', 'src/rank/a.ts')
  const small = snapCard(f, 'small', 'src/rank/b.ts')
  assert.equal(medium.id.localeCompare(small.id) < 0, true, 'fixture premise: the medium card holds the smaller id')

  const plan = f.office.poolPlan(f.call, { reuseIdle: false })
  const snapshot = f.office.statusSnapshot(f.call, plan)
  const text = renderStatusSnapshot(snapshot)

  // ① 有序列表：small 在前，且**带秩值**（`TASK-x small(1)`）
  const atSmall = text.indexOf(`${small.id} small(1)`)
  const atMedium = text.indexOf(`${medium.id} medium(2)`)
  assert.ok(atSmall >= 0, `the ordered list must carry the small card with its rank: ${text}`)
  assert.ok(atMedium >= 0, `the ordered list must carry the medium card with its rank: ${text}`)
  assert.ok(atSmall < atMedium, `small must precede medium in the ordered list: ${text}`)

  // ② 两态：修前那把键（只有 id 升序，规模秩被覆盖）在**同一台台账**上会把 medium 排到前面 ——
  //    守卫若只会"恒绿"，这一格就抓不住原缺陷。
  //
  //    ⚠️ **红的是哪一格要说清**（`REV-091` 重点②）：上面三格文本断言读的是候选全表的排序源
  //    （`candidateQueue` ⇒ `plan.ts` 的唯一比较器），而变异（把 `office.ts` 的 `fairReady` 改回旧键）
  //    **打不到它** —— 那张表仍会印 `small(1)` 在前。真正咬住"决策面那把键被覆盖"的是下面第 ③ 组
  //    同源断言（`plan.dispatch` / `snapshot.next` / 准入与全表的顺序一致性）。两态证明的写法是：
  //    **② 用重算的旧键证明"旧键会把顺序翻过来"，③ 证明"实现用的键与全表同序"**。
  const preFixKey = [...readyTasks(listTasks(f.store), 999)].sort((a, b) => a.id.localeCompare(b.id))
  assert.equal(preFixKey[0]?.id, medium.id, 'the pre-fix key (id ascending) must reproduce the inversion')

  // ③ 读数与决策同源：快照里的"下一张"必须就是准入首位
  assert.equal(plan.dispatch[0]?.task.id, small.id, 'the admittance head must be the small card')
  assert.equal(snapshot.next, small.id, 'the snapshot next-card must equal the admittance head')
  assert.equal(plan.queue[0]?.id, small.id, 'the ordered table head must equal the admittance head')
})

test('M224-S2 (guard 2, two-state) a card blocked by capacity is named in the snapshot with its reason', () => {
  const f = snapFixture('capacity', { maxParallelDispatch: 1 })
  const first = snapCard(f, 'small', 'src/cap/a.ts')
  const second = snapCard(f, 'small', 'src/cap/b.ts')
  assert.notEqual(first.id, second.id, 'fixture premise: two distinct cards')
  const plan = f.office.poolPlan(f.call, { reuseIdle: false })
  assert.equal(plan.queue.length, 2, `fixture premise: both cards are candidates: ${JSON.stringify(plan.queue)}`)
  const blockedRow = plan.queue.find((entry) => entry.verdict === 'capacity')
  assert.ok(blockedRow !== undefined, `the ordered table must classify the budget-blocked card: ${JSON.stringify(plan.queue)}`)
  assert.equal(blockedRow.position > 0, true, 'the blocked row must keep its position in the ordered table')
  // 反向一格：**被挡的那张**不许同时在派发名单里
  assert.equal(plan.dispatch.some((entry) => entry.task.id === blockedRow.id), false, 'a capacity-blocked card must not be dispatched')

  const text = renderStatusSnapshot(f.office.statusSnapshot(f.call, plan))
  assert.ok(text.includes(blockedRow.id), `the blocked line must name the blocked card: ${text}`)
  assert.ok(text.includes('budget='), `the blocked line must carry the structured budget reading: ${text}`)
})

test('M224-S3 (guard 3) snapshot volume stays under the pinned budget on a non-trivial ledger', () => {
  const f = snapFixture('volume')
  for (let index = 0; index < 12; index += 1) snapCard(f, index % 3 === 0 ? 'medium' : 'small', `src/vol/${String(index)}.ts`)
  const plan = f.office.poolPlan(f.call, { reuseIdle: false })
  const text = renderStatusSnapshot(f.office.statusSnapshot(f.call, plan))
  assert.ok(text.length < SNAPSHOT_CHAR_BUDGET, `snapshot must stay under ${String(SNAPSHOT_CHAR_BUDGET)} chars, got ${String(text.length)}`)
  assert.ok(text.includes(`/${String(SNAPSHOT_CHAR_BUDGET)}`), `the size line must state the pinned budget: ${text}`)
  // 有界不等于"截得看不见"：队列行数与阻塞名必须真的在里面（否则守卫只证明"短"）
  assert.ok(text.includes('small(1)'), `the ordered list must be present: ${text}`)
})

test('M224-S4 (guard 4) two snapshots of one ledger are byte-identical except the timestamp', () => {
  const f = snapFixture('stable')
  const medium = snapCard(f, 'medium', 'src/stable/a.ts')
  snapCard(f, 'small', 'src/stable/b.ts')
  f.office.recordDispatchStarted(f.call, {
    taskId: medium.id,
    provider: 'spawn',
    childSessionId: 'cafebabe',
    parentSessionId: f.call.sessionId ?? '',
    tools: 3,
    role: 'developer',
  })
  const first = renderStatusSnapshot(f.office.statusSnapshot(f.call, f.office.poolPlan(f.call, { reuseIdle: false }), new Date('2026-10-24T01:00:00.000Z')))
  const second = renderStatusSnapshot(f.office.statusSnapshot(f.call, f.office.poolPlan(f.call, { reuseIdle: false }), new Date('2026-10-24T02:30:00.000Z')))
  // **易变行由字形判定，不由位置判定**（`TASK-210` 加了 ⑥ 心跳行；`slice(1)` 那种位置约定会在
  // 任何人插一行时静默失效 —— 判据必须与渲染读同一个函数）。
  const volatile = (text: string): string[] => text.split('\n').filter((line) => isVolatileSnapshotLine(line))
  const body = (text: string): string => text.split('\n').filter((line) => !isVolatileSnapshotLine(line)).join('\n')
  assert.equal(volatile(first).length, 2, `exactly two volatile lines (timestamp + heartbeat): ${volatile(first).join(' / ')}`)
  assert.notEqual(first.split('\n')[0], second.split('\n')[0], 'the timestamp line must really differ (otherwise this guard is vacuous)')
  assert.equal(body(first), body(second), 'everything except the volatile lines must be byte-identical')
  assert.equal(first.includes('cafebabe'), true, 'the in-flight line must show the child session prefix')
  // 体积行必须**只算正文**：两次读数的体积读数必须相同（心跳不得把预算读数拖下水）
  const sizeLine = (text: string): string => text.split('\n').at(-1) ?? ''
  assert.equal(sizeLine(first), sizeLine(second), `the size line must be stable across two readings: ${sizeLine(first)} / ${sizeLine(second)}`)
  // **`REV-093#8` 的返工说明**：本格的"反空转"以前靠「心跳行必须不同」—— 而当时心跳行自带 `at=`，
  // 那条断言只证明"读数时刻换了"，是恒真的。`at=` 已删掉，心跳行的**活力证明**搬进 `M224-S8`
  // （同台账同刻逐字节相同 / 时刻 +90 分钟则分钟数恰好 +90 / 有更新的观测则更短）。
  // ⚠️ 反过来这里**必须**承认一件事（评审 `REV-093#6`，本卡不修，另开跟卡）：
  // ① 行的「已 N 分钟」不是易变行，所以本格的命题在"有卡在飞且派发时刻早于读数时刻"时是**假**的；
  // 本格夹具不 claim 卡，① 行恒为「在飞 0」，所以它一直是绿的 —— 那是**既有洞**，不是本卡引入的。
})

test('M224-S8 (landing 2) the heartbeat line carries "last ledger write" + "last observed" as relative readings', () => {
  const f = snapFixture('heartbeat')
  const card = snapCard(f, 'small', 'src/beat/a.ts')
  // 先真认领（在飞 = 卡状态 `in-progress`，心跳按它与 ① 同一份读数取在飞子会话）
  const claimed = f.office.claimTask(f.call, { taskId: card.id, owner: 'dev-beat', expectedRevision: 1 })
  assert.equal(claimed.ok, true, `fixture premise: the claim must succeed: ${JSON.stringify(claimed).slice(0, 200)}`)
  // 台账里放三条**时刻可钉**的事件：派发（占位）、观测（心跳）、最后一条普通落笔。
  f.office.recordDispatchStarted(f.call, {
    taskId: card.id,
    provider: 'spawn',
    childSessionId: 'beef1234-0000-4000-8000-000000000001',
    parentSessionId: f.call.sessionId ?? '',
    tools: 3,
    role: 'developer',
  })
  f.journal.append('dispatch/observed', {
    childSessionId: 'beef1234-0000-4000-8000-000000000001',
    toolCount: 3,
    deniedOutsideCount: 0,
    observedAt: '2026-10-24T00:40:00.000Z',
  })
  const snapshot = f.office.statusSnapshot(f.call, f.office.poolPlan(f.call, { reuseIdle: false }), new Date('2026-10-24T01:00:00.000Z'))
  assert.ok(snapshot.heartbeat !== undefined, 'the snapshot must carry the heartbeat reading (DEF-177)')
  const beat = snapshot.heartbeat
  assert.ok(beat.ledger !== undefined, 'the ledger must have a last-write reading')
  assert.equal(beat.observed?.child, 'beef1234-0000-4000-8000-000000000001', 'the last observation must name its child session')
  assert.equal(beat.children.length, 1, `the in-flight child must be listed: ${JSON.stringify(beat.children)}`)
  assert.equal(beat.children[0]?.at, '2026-10-24T00:40:00.000Z', 'the child heartbeat must be the observedAt of its last observation')
  const text = renderStatusSnapshot(snapshot)
  const lines = text.split('\n')
  const beatLine = lines.find((line) => isVolatileSnapshotLine(line) && line !== lines[0]) ?? ''
  // 相对量：观测时刻 00:40 距读数 01:00 = 20 分钟（写绝对时刻就没人能一眼判断"还活着没"）
  // **`REV-094#4`**：这里以前是裸子串 `includes('20')` —— 任务号 / seq / 别的段里出现 20 就能让它过。
  // 现在锚到**段**上：20 分钟这个读数必须成段地出现**两次**，且其中只有一次带子会话号
  // （不带号的那段 = 全局「最近派发观测」，带号的那段 = 该在飞子会话自己的心跳）。
  const segments = beatSegments(beatLine)
  const twenty = segments.filter((segment) => minuteReading(segment) === 20)
  assert.equal(twenty.length, 2, `the 20-minute reading must own a segment twice (global + per-child), not just appear anywhere: ${beatLine}`)
  assert.equal(twenty.filter((segment) => segment.includes('beef1234')).length, 1, `exactly one of those two is the per-child row: ${beatLine}`)
  assert.ok(beatLine.includes('beef1234'), `the heartbeat line must name the in-flight child: ${beatLine}`)
  assert.equal(beatLine.includes('2026-10-24T00:40:00.000Z'), false, 'the heartbeat reads relative ages, not the raw observation timestamp')

  // 反向一格：空台账 ⇒ "读不出"必须与"刚刚"分开（把读不出印成 0 分钟就是一次假读数）
  const empty = snapFixture('heartbeat-empty')
  const emptySnapshot = empty.office.statusSnapshot(empty.call, empty.office.poolPlan(empty.call, { reuseIdle: false }), new Date('2026-10-24T01:00:00.000Z'))
  const emptyText = renderStatusSnapshot(emptySnapshot)
  const emptyLines = emptyText.split('\n')
  const emptyBeat = emptyLines.find((line) => isVolatileSnapshotLine(line) && line !== emptyLines[0]) ?? ''
  assert.ok(emptyBeat !== '', `even a ledger without observations must render the heartbeat line: ${emptyText}`)
  assert.equal(emptySnapshot.heartbeat?.observed, undefined, 'a ledger without observations must report none (not a fabricated heartbeat)')
  assert.equal(emptySnapshot.heartbeat?.children.length, 0, 'no in-flight child => no child heartbeat rows')

  // **两态的另一半**：一张**超了孤儿 TTL** 的在飞卡（子会话早就不在 `heldByDispatch` 里了）——
  // 它恰恰是最需要看心跳的那一张，心跳必须照样给它一行（只报"活着的派发"等于不报）。
  const staleCard = snapCard(f, 'small', 'src/beat/b.ts')
  const staleClaim = f.office.claimTask(f.call, { taskId: staleCard.id, owner: 'dev-stale', expectedRevision: 1 })
  assert.equal(staleClaim.ok, true, 'fixture premise: the second claim must succeed')
  // 直接写一行**20 小时前**的派发事件（`journal.append` 只会盖当前时刻，这里要的是真·陈旧时刻）
  f.store.appendLine([JOURNAL_FILE], JSON.stringify({
    seq: f.journal.read().events.length + 1,
    at: '2026-10-23T05:00:00.000Z',
    actor: 'sdo',
    type: 'dispatch/started',
    data: {
      task: staleCard.id,
      provider: 'spawn',
      childSessionId: 'dead0000-0000-4000-8000-000000000002',
      tools: 3,
      role: 'developer',
    },
  }) + '\n')
  const stalePlan = f.office.poolPlan(f.call, { reuseIdle: false })
  assert.equal(
    (stalePlan.heldByDispatch ?? []).some((row) => row.taskId === staleCard.id),
    false,
    'fixture premise: a dispatch older than the orphan TTL is NOT a "live" dispatch',
  )
  const staleSnapshot = f.office.statusSnapshot(f.call, stalePlan, new Date('2026-10-24T01:00:00.000Z'))
  const staleChildren = staleSnapshot.heartbeat?.children ?? []
  assert.equal(staleChildren.length, 2, `both in-progress cards must get a heartbeat row: ${JSON.stringify(staleChildren)}`)
  assert.ok(staleChildren.some((row) => row.child === 'dead0000'), `the stale card's child must be listed too: ${JSON.stringify(staleChildren)}`)
  const staleLines = renderStatusSnapshot(staleSnapshot).split('\n')
  const staleBeat = staleLines.find((line) => isVolatileSnapshotLine(line) && line !== staleLines[0]) ?? ''
  assert.ok(staleBeat.includes('dead0000'), `the rendered heartbeat must name the stale card's child: ${staleBeat}`)
  assert.ok(staleBeat.includes(card.id), `the heartbeat row must carry the task id too (a child id can be unreadable): ${staleBeat}`)
})

/**
 * **心跳行的活力证明**（`REV-093#8` 的返工）：删掉行内绝对时刻之后，「这条读数真的在动吗」
 * 必须由**读数本身**证明，而不是靠"读数时刻换了"。三格都用同一台办公室（同一台账）：
 *   ① 同台账 + 同刻 ⇒ 心跳行**逐字节相同**（证明行里没有易变的时间戳残留）；
 *   ② 同台账 + 时刻前进 90 分钟 ⇒ 台账那条的分钟数**恰好 +90**（证明它是现算的相对量，不是摆件）；
 *   ③ 台账里出现**更新的观测** ⇒ 最近派发观测那条的分钟数**变小**（证明它跟台账走，不跟 now 走）；
 *   ④ 「读不出」与「没有」分开：`at` 解析不了时说的是「时刻读不出」，不是「无 / 台账为空」。
 */
test('M224-S9 (REV-093#8 rewrite) the heartbeat reading is provably live and never leaks an absolute timestamp', () => {
  const f = snapFixture('beat-live')
  const card = snapCard(f, 'small', 'src/beat/live.ts')
  assert.equal(f.office.claimTask(f.call, { taskId: card.id, owner: 'dev-live', expectedRevision: 1 }).ok, true, 'fixture premise: claim succeeds')
  f.journal.append('dispatch/observed', {
    childSessionId: 'cafe0000-0000-4000-8000-00000000000a',
    toolCount: 3,
    deniedOutsideCount: 0,
    observedAt: '2026-10-24T00:00:00.000Z',
  })
  const beatOf = (at: string): { line: string; snapshot: ReturnType<SoftwareDevOffice['statusSnapshot']> } => {
    const snapshot = f.office.statusSnapshot(f.call, f.office.poolPlan(f.call, { reuseIdle: false }), new Date(at))
    const lines = renderStatusSnapshot(snapshot).split('\n')
    return { line: lines.find((row) => isVolatileSnapshotLine(row) && row !== lines[0]) ?? '', snapshot }
  }
  // ① 同台账 + 同刻 ⇒ 逐字节相同（行里**没有**任何绝对时刻）
  const a = beatOf('2026-10-24T01:00:00.000Z')
  const again = beatOf('2026-10-24T01:00:00.000Z')
  assert.ok(a.line !== '', 'the heartbeat line must be present')
  assert.equal(a.line, again.line, `the same ledger read at the same moment must render the same heartbeat line: ${a.line} / ${again.line}`)
  assert.equal(/\d{4}-\d{2}-\d{2}T/u.test(a.line), false, `the heartbeat line must not carry an absolute timestamp: ${a.line}`)
  // ② 时刻前进 90 分钟 ⇒ 台账那条 +90（现算的相对量）
  const later = beatOf('2026-10-24T02:30:00.000Z')
  const minutesIn = (line: string): number => {
    const hit = /(\d+) 分钟前/u.exec(line)
    assert.ok(hit !== null, `the heartbeat line must carry an "N min ago" reading: ${line}`)
    return Number(hit[1])
  }
  assert.equal(minutesIn(later.line) - minutesIn(a.line), 90, `advancing the reading moment by 90 minutes must add exactly 90 to the relative reading: ${a.line} / ${later.line}`)
  // ③ 台账里出现更新的观测 ⇒ 「最近派发观测」那条的分钟数变小
  // **`REV-094#4`**：以前这一格只断言 `includes('10')` —— 裸子串、无锚点（任务号 / seq / 别的段里出现
  // 10 就恒真）。现在用**同刻两次读数互证**：同一个读数时刻（01:30）下，台账里多一条更新的观测 ⇒
  // 只有「最近派发观测」那**一段**变化，且它的新值正好是 10 分钟前。
  const beforeNewObservation = beatOf('2026-10-24T01:30:00.000Z').line
  f.journal.append('dispatch/observed', {
    childSessionId: 'cafe0000-0000-4000-8000-00000000000a',
    toolCount: 3,
    deniedOutsideCount: 0,
    observedAt: '2026-10-24T01:20:00.000Z',
  })
  const afterNewObservation = beatOf('2026-10-24T01:30:00.000Z').line
  const beforeSegments = beatSegments(beforeNewObservation)
  const afterSegments = beatSegments(afterNewObservation)
  assert.equal(afterSegments.length, beforeSegments.length, `one more observation must not change the segment layout: ${beforeNewObservation} / ${afterNewObservation}`)
  const moved = afterSegments.filter((segment, index) => segment !== beforeSegments[index])
  // 会动的段**恰好两条**：台账那段（多了一条事件 ⇒ seq 加一）与观测那段（分钟数变小）。
  assert.equal(moved.length, 2, `a newer observation may move exactly two segments (ledger seq + observed reading): ${moved.join(' / ')}`)
  // 其中**只有一条**带分钟读数，且它必须是新的 10 分钟 —— 这才是"观测读数变小"的锚点（不是裸子串 `10`）。
  const minuteMoves = moved.filter((segment) => minuteReading(segment) !== undefined)
  assert.equal(minuteMoves.length, 1, `exactly one moved segment carries a minute reading: ${moved.join(' / ')}`)
  assert.equal(minuteReading(minuteMoves[0] ?? ''), 10, `that segment must carry the new relative reading (10 min): ${minuteMoves[0] ?? ''}`)
  // ④ 「读不出」≠「没有」：`at` 解析不了时说的必须是「时刻读不出」
  const broken: StatusSnapshot = {
    ...a.snapshot,
    at: '2026-10-24T01:00:00.000Z',
    heartbeat: {
      ledger: { at: 'not-a-timestamp', seq: 42 },
      observed: { at: 'also-not-a-timestamp', child: 'cafe0000' },
      children: [{ task: 'TASK-999', child: '', at: 'garbage' }],
    },
  }
  const beatLineOf = (snapshot: StatusSnapshot): string => {
    const rows = renderStatusSnapshot(snapshot).split('\n')
    return rows.find((row) => isVolatileSnapshotLine(row) && row !== rows[0]) ?? ''
  }
  const brokenLine = beatLineOf(broken)
  assert.ok(brokenLine.includes('42'), `the unreadable ledger reading must still name its seq: ${brokenLine}`)
  assert.ok(brokenLine.includes('TASK-999'), `a child without a session id must still be named by its task id: ${brokenLine}`)
  // 「读不出」与「没有」必须是**两种**读数 —— 用两份快照相互对照来判，而不是比某个中文字面量
  // （本文件的纪律：中文只写在断言之外，塞进断言实参会被散文棘轮记成未登记站点）。
  const emptyLedger = beatLineOf({ ...broken, heartbeat: { ledger: undefined, observed: undefined, children: [] } })
  assert.notEqual(brokenLine, emptyLedger, `"has readings but unreadable" must render differently from "no readings at all": ${brokenLine} / ${emptyLedger}`)
  const unreadableOnly = beatLineOf({ ...broken, heartbeat: { ledger: { at: 'garbage', seq: 42 }, observed: undefined, children: [] } })
  const noneOnly = beatLineOf({ ...broken, heartbeat: { ledger: undefined, observed: { at: 'garbage', child: 'cafe0000' }, children: [] } })
  assert.notEqual(unreadableOnly, noneOnly, 'an unreadable ledger reading and an unreadable observation must not render the same line')
})

test('M224-S5 (landing 2) the ordered table is complete, rank-carrying and language-neutral (CJK-free in en)', () => {
  const f = snapFixture('table')
  const medium = snapCard(f, 'medium', 'src/tab/a.ts')
  const small = snapCard(f, 'small', 'src/tab/b.ts')
  const plan = f.office.poolPlan(f.call, { reuseIdle: false })
  const table = renderQueueTable(plan.queue)
  // 完整：每张候选都在表里（不是"只报数量"）
  for (const entry of plan.queue) {
    assert.ok(table.includes(entry.id), `every candidate must appear in the table (${entry.id}): ${table}`)
    assert.ok(table.includes(`${entry.id} ${entry.size}(${String(entry.rank)})`), `every row must carry its size rank (${entry.id}): ${table}`)
  }
  assert.ok(table.indexOf(`${small.id} small(1)`) < table.indexOf(`${medium.id} medium(2)`), `small must come first in the table: ${table}`)
  // 语言中立：`en` 语言下的回执必须零中文（既有守卫 `test/m105.test.ts` 的同一条口径）
  assert.equal(CJK.test(table), false, `the ordered table must stay CJK-free: ${table}`)
  setLocale('en')
  try {
    const en = renderQueueTable(f.office.poolPlan(f.call, { reuseIdle: false }).queue)
    assert.equal(CJK.test(en), false, `the ordered table must stay CJK-free under en too: ${en}`)
    assert.ok(en.includes('dispatch queue'), `the table header must be present under en: ${en}`)
  } finally {
    setLocale('zh-CN')
  }
})

test('M224-S6 (landing 3) the decision trace lands in dispatch/decided (candidates + key + why); absent when not given', () => {
  const f = snapFixture('trace')
  const card = snapCard(f, 'small', 'src/trace/a.ts')
  f.office.recordDispatch(f.call, {
    taskId: card.id,
    backend: 'subagent',
    owner: 'developer',
    trace: {
      orderBasis: ORDER_BASIS_LABEL,
      candidates: [`${card.id} small(1)`],
      selectedWhy: 'candidate#1 of 1 admitted',
    },
  })
  const withTrace = f.journal.read().events.filter((event) => event.type === 'dispatch/decided').at(-1)
  assert.equal(String(withTrace?.data['orderBasis'] ?? ''), ORDER_BASIS_LABEL, 'the ordering key name must be recorded')
  assert.deepEqual(withTrace?.data['candidates'], [`${card.id} small(1)`], 'the ordered candidate list must be recorded')
  assert.equal(typeof withTrace?.data['selectedWhy'], 'string', 'why-this-card must be recorded')

  // 两态：不传 trace ⇒ 三个键**根本不落**（老调用点形状不变，读侧能区分"没记"与"记了空")
  f.office.recordDispatch(f.call, { taskId: card.id, backend: 'subagent', owner: 'developer' })
  const bare = f.journal.read().events.filter((event) => event.type === 'dispatch/decided').at(-1)
  for (const key of ['orderBasis', 'candidates', 'selectedWhy']) {
    assert.equal(Object.hasOwn(bare?.data ?? {}, key), false, `without a trace the key must be absent: ${key}`)
  }
})

test('M224-S7 (REV-091 finding 2/3) the key is a total order: the decision order equals the table order at FULL length', () => {
  const f = snapFixture('total-order')
  // 四种规模与四个 id 交叉错位：**任何"只比首位"的断言都不足以证明两把顺序同源**
  const cards = [
    snapCard(f, 'medium', 'src/ord/a.ts'),
    snapCard(f, 'small', 'src/ord/b.ts'),
    snapCard(f, 'large', 'src/ord/c.ts'),
    snapCard(f, 'small', 'src/ord/d.ts'),
  ]
  assert.equal(cards.length, 4, 'fixture premise: four candidates')
  const plan = f.office.poolPlan(f.call, { reuseIdle: false })

  // ① **全序对拍**：准入名单（决策面）与有序表里 `verdict==='dispatch'` 的序列**逐项相等**
  //    —— 比"首位相等"强：任何长度上的换序都会被抓到。
  const tableOrder = plan.queue.filter((entry) => entry.verdict === 'dispatch').map((entry) => entry.id)
  const decisionOrder = plan.dispatch.map((entry) => entry.task.id)
  assert.deepEqual(tableOrder, decisionOrder, `the table order must equal the decision order at full length`)

  // ② 规模秩优先：`small` 的两张都必须排在那张 `medium` 与 `large` 之前（同档内按 id 升序）
  const ranks = plan.queue.map((entry) => entry.rank)
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, `the table must be sorted by size rank ascending`)
  assert.deepEqual(
    plan.queue.filter((entry) => entry.rank === 1).map((entry) => entry.id),
    [cards[1]?.id, cards[3]?.id],
    'same-rank cards must stay in id ascending order',
  )

  // ③ **全序前提**（评审点名的那个隐含假设）：末位 `id` 唯一兜底 ⇒ 排序结果与输入顺序无关。
  //    两次不同输入顺序必须得到同一个序列；否则"两次独立排序同序"这条推理就站不住。
  const forward = plan.queue.map((entry) => entry.id)
  const again = f.office.poolPlan(f.call, { reuseIdle: false }).queue.map((entry) => entry.id)
  assert.deepEqual(again, forward, 'the same ledger must always yield the same order')
})
