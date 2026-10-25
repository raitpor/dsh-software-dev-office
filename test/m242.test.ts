/**
 * **增量 242（`TASK-228`）：池候选的一次性退役。**
 *
 * 病灶（本卡立案时的真账，两个时点都量过）：`dispatch/reuse-skipped` 里**同一个候选的同一句话**
 * 被**每一轮派发**重记一遍 —— 立卡时 191/79/1657，写本文件时已是 **249 次派发 / 119 次复用 /
 * 2379 条事件 / 3179 条候选行**，其中 **3149 条**是同一句「旧口径指纹没有版本号，且回溯判不了」。
 * 那些候选**不会**再变回可用（掩码指纹在会话创建时就定死了），却每轮都被重新判定、重新落账。
 *
 * 修法（本文件逐条钉住，每格都是**两态**）：
 *   · `M242-01` 判定表：**永久**（口径不可比 / 宿主不可达）与**临时**（有在飞卡 / 投递失败）分开，
 *     判错的代价不对称 ⇒ 判不准的一律不退役（同版本指纹不一致那一档单列成"可逆"）；
 *   · `M242-02` `foldPoolChildren` **先减退役集再折叠**：退役的候选不再进池，而**复活**规则
 *     （退役之后又出现 `dispatch/started`）保证误判一次不会把会话永久钉死在账外；
 *   · `M242-03` `reuseSkippedOf` **不再回放退役之前写下的死账**（只砍刀口之前那一段，
 *     刀口之后的行是新事实 —— 这条边界写在那格里，别当成漏）；
 *   · `M242-04` 池摘要**三分**的恒等式（`reusable + temp-unusable + retired = total`）+ **一次性**：
 *     第一轮落一条事件、第二轮 **0 条**（这就是"不再每次派发重评估重写 82 条"的机制面）。
 *   · `M242-05`（`REV-116` 必核一① 缺口的修法）**接线有断言**：走真装配链（`sdo_plan action=next`）
 *     断言回执里**真的印出** `pool-retire:` 那一行、且台账里**真的**落了 1 条 `pool/retired`；
 *     第二轮**不再印、不再写**。双态：把接线整块拿掉 ⇒ 这一格必红（变异读数见回报）。
 *   · `M242-06`（`REV-116` 必核三③）**逐轮时序**：走**真实写路径**（`retirePermanentCandidates`，
 *     `index.ts` 调的就是它）看一个候选「第 1 轮在飞不判 → 第 2 轮结算即判即落盘 → 第 3 轮 0 条」。
 *   · `M242-07`（`REV-116` 必核四②）**两份读数同源**：快照里的 `permanent` 与本轮退役清单重叠时，
 *     三分只数一次（不双计），且不会出现"同一候选两条退役事件"。
 *
 * 断言消息一律用英文（本文件不进 `m189` 的读散文棘轮；口径与 `m232` / `m243` 同）——
 * **注释**照旧用中文（抽取器只认断言行里的字面量）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import {
  EXECUTOR_DENIED_TOOLS,
  MASK_FINGERPRINT_VERSION,
  READ_ONLY_INSPECTION_TOOLS,
  isSdoTool,
  listRoleCards,
  maskFaceOf,
  maskFingerprint,
  maskHashVersion,
} from '../src/domain/roles.js'
import {
  POOL_RETIRED_EVENT,
  foldPoolChildren,
  permanentCandidatesFromEvents,
  permanentCandidatesOf,
  permanentUnreusableReason,
  poolTriage,
  poolTriageForRound,
  poolTriageLine,
  poolTriageRows,
  retiredCandidatesOf,
  retiredSetOf,
  rolePools,
} from '../src/domain/pool.js'
import {
  POOL_RETIRED_CHUNK,
  REUSE_SKIPPED_EVENT,
  recordPoolRetired,
  retirePermanentCandidates,
  reuseSkippedEventData,
  reuseSkippedOf,
} from '../src/domain/dispatchFace.js'
import type { PoolChild, PoolEvent } from '../src/domain/pool.js'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm242')
const WORKSPACE = join(BASE, 'proj')
/** 观察者（派发器）会话 id —— 与真机同形：`session-<uuid>`。 */
const VIEWER = 'session-0000m242-0000-4000-8000-00000000242a'
/** 角色**当前**的掩码指纹（v2，带版本前缀）。 */
const CURRENT = maskFingerprint('developer')
/** 旧口径指纹：12 位十六进制、**没有**版本前缀（真账里那 3149 条的形态）。 */
const LEGACY = createHash('sha1').update('legacy-mask-m242').digest('hex').slice(0, 12)
/** 同口径（v2）但**与当前不等**的指纹：角色面改过 ⇒ 可逆档（面改回去它就又能用了）。 */
const OLD_FACE_V2 = `2:${'0'.repeat(12)}`

beforeEach(() => { rmSync(BASE, { recursive: true, force: true }); mkdirSync(BASE, { recursive: true }) })
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

/** 一个**已结算的空闲**子代理（真源形状与真机一致：`mode: continuable` ⇒ 结算后仍可复用）。 */
function child(id: string, overrides: Partial<PoolChild> = {}): PoolChild {
  return {
    childSessionId: id,
    role: 'developer',
    task: 'TASK-24200',
    mode: 'continuable',
    state: 'idle',
    rounds: 1,
    cards: 1,
    startedAt: '2026-10-25T00:00:00.000Z',
    finishedAt: '2026-10-25T00:10:00.000Z',
    parentSessionId: VIEWER,
    maskHash: CURRENT,
    ...overrides,
  }
}

/** 一个角色的池（判据与生产路径同一份：`rolePools` + `maskHashOf`）。 */
function poolOf(children: PoolChild[]): ReturnType<typeof rolePools>[number] {
  const pools = rolePools({
    children,
    roles: ['developer'],
    caps: { developer: 4 },
    defaultCap: 4,
    viewerSessionId: VIEWER,
    maskHashOf: () => CURRENT,
  })
  const pool = pools.find((item) => item.role === 'developer')
  assert.ok(pool !== undefined, 'fixture: the developer pool must exist')
  return pool
}

/** 一笔 `pool/retired`（读侧口径与写侧同一形状：批量的 `retired[]`）。 */
function retireEvent(rows: { childSessionId: string; role: string; basis: string }[], at = '2026-10-25T01:00:00.000Z'): PoolEvent {
  return {
    type: POOL_RETIRED_EVENT,
    at,
    data: { retired: rows.map((row) => ({ ...row, reason: 'archived by m242 fixture' })), count: rows.length, decidedAt: at },
  }
}

/** 一条 `dispatch/started` + 一条 `dispatch/finished`（一个"派过、结算了"的孩子）。 */
function seedChildEvents(id: string, maskHash: string): PoolEvent[] {
  return [
    { type: 'dispatch/started', at: '2026-10-25T00:00:00.000Z', data: { childSessionId: id, role: 'developer', task: 'TASK-24200', parentSessionId: VIEWER, mode: 'continuable', maskHash } },
    { type: 'dispatch/finished', at: '2026-10-25T00:10:00.000Z', data: { childSessionId: id } },
  ]
}

/* —————————————————————————— M242-01 判定表（四类 × 两态） —————————————————————————— */

test('M242-01 the judgment table: permanent (mask not comparable / host unreachable) vs temporary (busy / delivery failed)', () => {
  // ① **永久**：旧口径指纹（没有版本号）+ 回溯证不成 ⇒ 与今天的现算值不可比
  const legacy = child('m242-legacy', { maskHash: LEGACY })
  assert.deepEqual(permanentUnreusableReason(legacy)?.basis, 'mask-not-comparable', 'a legacy mask without a version prefix must be classified as not comparable')
  // ①-b **永久**：压根没有指纹（SDO-52 之前的老事件）⇒ 同样不可比
  assert.deepEqual(permanentUnreusableReason(child('m242-nomask', { maskHash: '' }))?.basis, 'mask-not-comparable', 'a missing fingerprint is not comparable either')
  // ①-c **可逆档**（刻意**不**退役）：同版本但指纹不等 ⇒ 角色面改回去它就又能用了
  assert.equal(permanentUnreusableReason(child('m242-oldface', { maskHash: OLD_FACE_V2 })), undefined, 'a same-version but different fingerprint is reversible and must not be retired')
  // ② **永久**：跨父会话（宿主只允许父会话复用自己起的子代理）—— 只对**给了观察者**的那一侧成立
  const foreign = child('m242-foreign', { parentSessionId: 'another-parent' })
  assert.deepEqual(permanentUnreusableReason(foreign, { viewerSessionId: VIEWER })?.basis, 'host-unreachable', 'a cross-parent candidate is unreachable from this viewer')
  assert.equal(permanentUnreusableReason(foreign), undefined, 'without a viewer the cross-parent judgement must not be made (unknown is not "unusable")')
  // ③ **临时**：有在飞卡（连 idle 都不是）
  assert.equal(permanentUnreusableReason(child('m242-busy', { state: 'busy', maskHash: LEGACY })), undefined, 'a busy child is temporary (its card may settle)')
  // ④ **临时**：投递失败（宿主这次拒了不代表下次也拒）
  assert.equal(permanentUnreusableReason(child('m242-delivery', { maskHash: LEGACY, deliveryFailedReason: 'is unavailable' })), undefined, 'a delivery failure is temporary')
  // 反例的反面（证明判据不是"一律不退役"）：回溯**能证成**面没变过 ⇒ 可复用 ⇒ 不退役
  const developer = listRoleCards().find((card) => String(card.code) === 'developer')
  assert.ok(developer !== undefined, 'fixture: the developer role card must exist')
  const sdoFace = maskFaceOf(developer).filter((name) => isSdoTool(name) || (READ_ONLY_INSPECTION_TOOLS as readonly string[]).includes(name))
  const coveringDeny = [...EXECUTOR_DENIED_TOOLS, ...developer.deny]
  assert.equal(
    permanentUnreusableReason(child('m242-backtrack', { maskHash: LEGACY, sdoAllow: sdoFace, deny: coveringDeny })),
    undefined,
    'a legacy mask whose face can be proven unchanged stays reusable (do not redo the whole-pool wipeout that the version bump was meant to avoid)',
  )

  // **两态**：判成永久的那批在池里是 `permanent` 桶；退役之后它们**不在池里**，而 `retiredCandidatesOf` 补上
  const pool = poolOf([legacy, foreign, child('m242-temp', { deliveryFailedReason: 'is unavailable' }), child('m242-reusable')])
  assert.deepEqual(pool.permanent.map((row) => row.childSessionId).sort(), ['m242-legacy'], 'state 1 (before retirement): the not-comparable one lands in the permanent bucket')
  /**
   * **诚实边界（跨父会话那一档）**：`permanent` 是 `unusable` 的子集，而跨父会话的孩子**过得了闸门**
   * （`reuseBlockedReason` 不判父会话）⇒ 它在池视图里是 `idleForeign`（如实分栏、单列一行），
   * 因此**不进** `permanent` 桶 —— 本轮的退役路径以 `pool.permanent` 为输入，够不到它。
   * 判据本身（`permanentUnreusableReason`）已经把它判成永久（上面那条断言），缺口在**接线**：
   * 真账里这一档是 0 条（原因聚合里没有跨父会话那一类），所以本轮不改池视图语义，只如实登记在这里。
   */
  assert.deepEqual(pool.idleForeign.map((row) => row.childSessionId), ['m242-foreign'], 'the cross-parent candidate is reported separately (idleForeign), not as unusable')
  assert.equal(pool.idle.length, 2, 'state 1: the clean child and the cross-parent one are both "idle" (DELIVERABILITY is a separate column)')
  assert.equal(pool.unusable.length, 2, 'state 1: two candidates fail the gate (one permanent + one temporary)')
  const events = [...seedChildEvents('m242-legacy', LEGACY), ...seedChildEvents('m242-foreign', CURRENT), retireEvent([
    { childSessionId: 'm242-legacy', role: 'developer', basis: 'mask-not-comparable' },
    { childSessionId: 'm242-foreign', role: 'developer', basis: 'host-unreachable' },
  ])]
  const after = poolOf([...foldPoolChildren(events).values()])
  assert.deepEqual(after.permanent, [], 'state 2 (after retirement): the permanent bucket is empty because they are out of the pool')
  assert.deepEqual(retiredCandidatesOf(events).map((row) => row.childSessionId).sort(), ['m242-foreign', 'm242-legacy'], 'state 2: they show up as retired candidates instead')
})

/* ————————————————— M242-02 先减退役集再折叠（两态 + 复活 + 不误伤） ————————————————— */

test('M242-02 foldPoolChildren subtracts the retired set before folding, and a later dispatch/started revives the child', () => {
  const events: PoolEvent[] = [...seedChildEvents('m242-a', LEGACY), ...seedChildEvents('m242-b', CURRENT)]
  // 态 1：没有退役事件 ⇒ 两个孩子都在池里（一个不可复用、一个可复用），退役集为空
  const before = foldPoolChildren(events)
  assert.deepEqual([...before.keys()].sort(), ['m242-a', 'm242-b'], 'state 1: both children are folded')
  assert.equal(retiredSetOf(events).size, 0, 'state 1: no retirement yet')

  // 态 2：`m242-a` 退役之后**不再进折叠**（先减后折，而不是折完再筛），`m242-b` 一点不受影响
  const retired: PoolEvent[] = [...events, retireEvent([{ childSessionId: 'm242-a', role: 'developer', basis: 'mask-not-comparable' }])]
  const after = foldPoolChildren(retired)
  assert.deepEqual([...after.keys()], ['m242-b'], 'state 2: the retired child is gone and the sibling is untouched (no collateral)')
  assert.deepEqual([...retiredSetOf(retired)], ['m242-a'], 'state 2: the retired set names exactly that child')

  // 复活规则（唯一的例外）：退役之后**又出现** `dispatch/started` ⇒ 它重新算活 ——
  // 没有这条规则，一次误判就会把这个会话永久钉死在账外（不可逆动作不许这样）
  const revived: PoolEvent[] = [...retired, { type: 'dispatch/started', at: '2026-10-25T02:00:00.000Z', data: { childSessionId: 'm242-a', role: 'developer', task: 'TASK-24201', parentSessionId: VIEWER, mode: 'continuable', maskHash: LEGACY } }]
  assert.equal(retiredSetOf(revived).size, 0, 'a later dispatch/started clears the retirement (reversible by construction)')
  const back = foldPoolChildren(revived)
  assert.equal(back.get('m242-a')?.state, 'busy', 'the revived child is folded again (and it is busy, not idle)')
  // 反例：退役事件写在 started **之前** ⇒ 那一笔派发发生在退役之后被看见 ⇒ 同样算活（顺序以台账位置为准）
  const earlyRetire: PoolEvent[] = [retireEvent([{ childSessionId: 'm242-b', role: 'developer', basis: 'mask-not-comparable' }]), ...seedChildEvents('m242-b', CURRENT)]
  assert.equal(retiredSetOf(earlyRetire).has('m242-b'), false, 'a start recorded after a retirement revives the child (ledger order decides)')
})

/* ————————————————— M242-03 reuseSkippedOf 跳过已退役（两态 + 刀口边界） ————————————————— */

test('M242-03 reuseSkippedOf stops replaying the dead rows written before the retirement cut', () => {
  const store = new SdoStore(join(WORKSPACE, '.sdo'))
  store.ensureLayout()
  const journal = new Journal(store)
  const appendSkip = (id: string, why: string): void => {
    journal.append(
      REUSE_SKIPPED_EVENT as unknown as Parameters<typeof journal.append>[0],
      reuseSkippedEventData({ childSessionId: id, role: 'developer', reason: why }, { task: 'TASK-24202' }),
    )
  }
  journal.append('dispatch/started', { childSessionId: 'm242-dead', role: 'developer', task: 'TASK-24202', parentSessionId: VIEWER, mode: 'continuable', maskHash: LEGACY })
  journal.append('dispatch/finished', { childSessionId: 'm242-dead' })
  appendSkip('m242-dead', 'mask fingerprint changed (legacy hash had no version, and the trace is undecidable)')
  appendSkip('m242-live', 'no tool-face observation for this child')

  // 态 1：还没退役 ⇒ 两条都读得回来（历史读数照实回放，不去重）
  assert.deepEqual(reuseSkippedOf(journal).map((row) => row.childSessionId).sort(), ['m242-dead', 'm242-live'], 'state 1: both rows are readable')
  assert.equal(retiredSetOf(journal.read().events.map((event) => ({ type: event.type, data: event.data, at: event.at }))).size, 0, 'state 1: nothing is retired yet')

  // 态 2：退役 `m242-dead` ⇒ **它退役之前**写下的死账不再回放；`m242-live` 照旧
  const written = recordPoolRetired(journal, [{ childSessionId: 'm242-dead', role: 'developer', reason: 'legacy mask not comparable', basis: 'mask-not-comparable' }])
  assert.deepEqual(written, { events: 1, rows: 1 }, 'one retirement event for one candidate')
  assert.deepEqual(reuseSkippedOf(journal).map((row) => row.childSessionId), ['m242-live'], 'state 2: the dead rows written before the cut are no longer replayed')
  /**
   * **刀口边界（如实登记的取舍）**：只砍"退役之前"的行。退役**之后**写下的行照旧回放 ——
   * 那是新事实（运维补的一笔探查、或退役那一轮自己的账），不是死账。这条边界也是两类既有守卫
   * （`M206-06` / `M206-09`：手工补的那一笔必须读得回来）能继续绿的原因，写在这里免得被当成漏。
   */
  appendSkip('m242-dead', 'operator probe written after the retirement cut')
  assert.deepEqual(reuseSkippedOf(journal).map((row) => row.childSessionId).sort(), ['m242-dead', 'm242-live'], 'a row written AFTER the cut is a fresh fact and stays readable')
  // 反例的反面（防恒真）：退役一个**没有留痕**的孩子 ⇒ 不该顺手把别人的行也吞掉
  recordPoolRetired(journal, [{ childSessionId: 'm242-none', role: 'developer', reason: 'x', basis: 'mask-not-comparable' }])
  assert.deepEqual(reuseSkippedOf(journal).map((row) => row.childSessionId).sort(), ['m242-dead', 'm242-live'], 'retiring an unrelated candidate changes nothing')
})

/* ————————————— M242-04 三分恒等式 + 一次性（两态 + 分片上界） ————————————— */

test('M242-04 the three-way readout keeps its identity across retirement, and the second round writes zero events', () => {
  // 三分：1 个可复用 + 1 个永久不可复用 + 1 个临时不可复用（投递失败），台账里另有 3 个已退役
  const permanentChild = child('m242-p', { maskHash: LEGACY })
  const tempChild = child('m242-t', { deliveryFailedReason: 'is unavailable' })
  const pool = poolOf([child('m242-ok'), permanentChild, tempChild])
  const retired3 = [
    { childSessionId: 'm242-r1', role: 'developer', reason: 'x', basis: 'mask-not-comparable', at: '' },
    { childSessionId: 'm242-r2', role: 'developer', reason: 'x', basis: 'mask-not-comparable', at: '' },
    { childSessionId: 'm242-r3', role: 'developer', reason: 'x', basis: 'mask-not-comparable', at: '' },
  ]
  // 态 1（退役之前）：永久那个在 `permanent` 桶里，三分把 `permanent` 与已退役的 3 个一起算进 `retired`
  const before = poolTriage(pool, retired3.length)
  assert.deepEqual(before, { role: 'developer', reusable: 1, tempUnusable: 1, retired: 4, total: 6 }, 'state 1 triage: 1 reusable + 1 temporary + (1 permanent + 3 retired) = 6')
  assert.equal(before.total, before.reusable + before.tempUnusable + before.retired, 'the identity must hold: reusable + temp-unusable + retired = total')
  assert.equal(before.total, pool.idle.length + pool.unusable.length + retired3.length, 'and it equals idle + unusable + already-retired (the same identity, expanded)')
  // 态 2（退役之后）：永久那个移出池、已退役变成 4 个 ⇒ **`retired` 与 `total` 一个字都不变**（左边进右边出）
  const afterRetired = poolTriage({ ...pool, unusable: pool.unusable.filter((row) => row.childSessionId !== 'm242-p'), permanent: [] }, retired3.length + 1)
  assert.equal(afterRetired.retired, before.retired, 'retiring must not change the retired count (that is the whole point of the three-way split)')
  assert.equal(afterRetired.total, before.total, 'nor the total: one candidate leaves `permanent` and enters the retired list')
  assert.match(poolTriageLine(afterRetired), /reusable=1 temp-unusable=1 retired=4 total=6/u, 'the receipt line carries all four numbers')
  // 逐角色入口：只有退役候选、没有池条目的角色也要出现在清单里（否则那一批会凭空消失）
  const rows = poolTriageRows({ pools: [], retired: [{ childSessionId: 'm242-x', role: 'tester', reason: 'x', basis: 'mask-not-comparable', at: '' }] })
  assert.deepEqual(rows, [{ role: 'tester', reusable: 0, tempUnusable: 0, retired: 1, total: 1 }], 'a role with only retired candidates still shows up')

  // **一次性**（这就是"不再每次派发重评估重写 82 条"的机制面）：第一轮落一条事件，第二轮 **0 条**
  const store = new SdoStore(join(BASE, 'second', '.sdo'))
  store.ensureLayout()
  const journal = new Journal(store)
  journal.append('dispatch/started', { childSessionId: 'm242-once', role: 'developer', task: 'TASK-24203', parentSessionId: VIEWER, mode: 'continuable', maskHash: LEGACY })
  journal.append('dispatch/finished', { childSessionId: 'm242-once' })
  // **没有「出生满一轮」那道门**（`REV-116` 必核三②：判据只读创建时定死的字段 ⇒ 等一轮结论一字不变）：
  // 逐轮时序在 `M242-06` 用**真实写路径**（`retirePermanentCandidates`）看，这里只保留"一次性"这一面
  const round = (): ReturnType<typeof recordPoolRetired> => {
    const events = journal.read().events.map((event) => ({ type: event.type, data: event.data, at: event.at }))
    return retirePermanentCandidates(journal, events).written
  }
  assert.deepEqual(round(), { events: 1, rows: 1 }, 'round 1: the permanently unreusable candidate is recorded once')
  assert.deepEqual(round(), { events: 0, rows: 0 }, 'round 2: zero candidates left to judge, so zero events (the per-dispatch rewrite stops here)')
  assert.deepEqual(round(), { events: 0, rows: 0 }, 'round 3: still zero (idempotent by construction, not by a guard)')
  // 分片上界：一批候选不会写成一行巨物（`Journal.append` 每次都要逐行解析盘上文本算 seq）
  const many = Array.from({ length: POOL_RETIRED_CHUNK * 2 + 50 }, (_unused, index) => ({
    childSessionId: `m242-bulk-${String(index)}`,
    role: 'developer',
    reason: 'legacy mask not comparable',
    basis: 'mask-not-comparable',
  }))
  const bulk = recordPoolRetired(journal, many)
  assert.equal(bulk.rows, many.length, 'every candidate of the bulk batch is written')
  assert.equal(bulk.events, Math.ceil(many.length / POOL_RETIRED_CHUNK), 'the batch is chunked, so one huge journal line never appears')
  assert.equal(retiredCandidatesOf(journal.read().events.map((event) => ({ type: event.type, data: event.data, at: event.at }))).length, many.length + 1, 'the read side folds every chunk back into candidates (chunking is invisible to readers)')
  // 判据自证（防恒真）：把一个**有在飞卡**的孩子喂给判定 ⇒ 必须不退役（它是临时档）
  assert.deepEqual(permanentCandidatesOf([child('m242-busy2', { state: 'busy', maskHash: LEGACY })], VIEWER), [], 'the projection must drop the temporary ones (otherwise this grid would pass on any input)')
  assert.equal(maskHashVersion(CURRENT), MASK_FINGERPRINT_VERSION, 'fixture premise: the current fingerprint carries the version prefix (the legacy one does not)')
})

/* ———————————— M242-05 接线有断言：真装配链里回执**真的**印出那一行 ———————————— */

/**
 * **这一格守的是 `REV-116` 必核一① 的缺口**（"建好了没消费者"）：落点③（`src/index.ts` 的接线）
 * 此前零覆盖 —— `grep -rn "pool-retire:" test/` ⇒ 0 命中，把接线整块删掉全量仍绿（本卡返工现跑：
 * 变异 C 后 1816 条仍 1815 pass / 0 fail）。所以这里走**真装配链**（`sdo_plan action=next` 的真工具），
 * 断言三件事同时在：① 台账**真的**多一条 `pool/retired`；② 回执里**真的**印出 `pool-retire:` 那一行；
 * ③ 三分读数（含恒等式）也在回执里。第二轮断言"不再印、不再写"。
 */
const CHAIN_SESSION = 's-m242-chain'
const chainCall = (): OfficeCall => ({ sessionId: CHAIN_SESSION, cwd: WORKSPACE } as unknown as OfficeCall)

/** 一张 ready 卡（真源形状：`store/tasks/<id>.yml`）。 */
function chainCard(id: string): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/m242/${id}.ts`], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  } as unknown as TaskCard
}

/** 真装配链的宿主桩（`m206` 同形：`apply()` 注册真工具 + `subagents` 桩）。 */
function mountChain(): { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[] {
  const tools: { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[] = []
  const services: Record<string, unknown> = {}
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  services['tools'] = { register: (tool: unknown) => { tools.push(tool as (typeof tools)[number]); return () => {} } }
  services['subagents'] = {
    list: () => ['spawn'],
    start: async () => ({ id: 'child-oneshot-m242' }),
    startContinuable: async () => ({ childId: 'child-fresh-m242' }),
    sendMessage: async () => ({ messageId: 'msg-m242' }),
    getProvider: () => ({ capabilities: { toolFilter: true } }),
    listDescendants: async () => [],
  }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return tools
}

/** 调真工具（只保留 schema 里声明过的键，与真机一致）。 */
async function callChainTool(
  tools: { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[],
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((item) => item.name === 'sdo_plan')
  assert.ok(tool !== undefined, 'fixture: the real sdo_plan tool must be registered')
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: CHAIN_SESSION, session: { header: { id: CHAIN_SESSION, cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

test('M242-05 the real assembly chain really prints the pool-retire line and really writes the event (and stops after round 1)', async () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession(CHAIN_SESSION, WORKSPACE)
  office.init(chainCall(), { name: 'M242 真装配链', scale: 'normal', stakeholders: ['业务方'] })
  // 一个「派过、结算了、旧口径掩码」的候选（真账里那 101 个的形态）+ 两张 ready 卡（两轮各派一张）
  office.recordDispatchStarted(chainCall(), {
    taskId: 'TASK-24205', provider: 'spawn', childSessionId: 'm242-chain-legacy', parentSessionId: CHAIN_SESSION,
    tools: 3, role: 'developer', mode: 'continuable', maskHash: LEGACY,
  })
  office.journalFor(WORKSPACE).append('dispatch/finished', { task: 'TASK-24205', childSessionId: 'm242-chain-legacy' })
  for (const id of ['TASK-24250', 'TASK-24251']) {
    office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task: chainCard(id) })
  }
  const journal = office.journalFor(WORKSPACE)
  const retiredEvents = (): { seq: number; data: Record<string, unknown> }[] =>
    journal.read().events.filter((event) => String(event.type) === POOL_RETIRED_EVENT)
  assert.equal(retiredEvents().length, 0, 'state 0 (before any dispatch): nothing is retired yet')

  const tools = mountChain()
  // —— 第 1 轮（真装配链）——
  const receipt = await callChainTool(tools, { action: 'next', limit: 1 })
  const written = retiredEvents()
  assert.equal(written.length, 1, `the wiring must really write ONE pool/retired event (receipt: ${receipt.slice(0, 400)})`)
  const rows = (written[0]?.data['retired'] ?? []) as { childSessionId?: string; role?: string; basis?: string }[]
  assert.deepEqual(rows.map((row) => row.childSessionId), ['m242-chain-legacy'], 'the retired row is exactly the permanently unreusable candidate')
  assert.equal(rows[0]?.role, 'developer', 'the event carries the role (the readout groups by it)')
  assert.equal(rows[0]?.basis, 'mask-not-comparable', 'the event carries the machine-readable basis (same criterion, not a second judgement)')
  // ② 回执里**真的**印出那一行（这一句就是"接线有消费者"的机械面）
  assert.match(receipt, /pool-retire: 1 permanently-unreusable candidate\(s\)/u, `the receipt must print the retirement line: ${receipt.slice(0, 800)}`)
  assert.match(receipt, new RegExp(`recorded once as ${POOL_RETIRED_EVENT} \\(1 event\\(s\\)\\)`, 'u'), 'the line must name the event type and the event count')
  assert.match(receipt, /basis mask-not-comparable=1/u, 'the line must break the batch down by basis')
  assert.match(receipt, /developer:m242-cha\[mask-not-comparable\]/u, 'the line must name the first few candidates (role + first 8 chars + basis)')
  assert.doesNotMatch(receipt, /awaiting-first-round/u, 'the deleted "one full round" gate must leave no counter behind (a permanent 0 would suggest "next round will retire it")')
  // ③ 三分读数在回执里，且恒等式成立（现算那两个数，不比对写死的）
  const triage = receipt.match(/pool-triage: role=developer reusable=(\d+) temp-unusable=(\d+) retired=(\d+) total=(\d+)/u)
  assert.ok(triage !== null, `the triage line must be in the receipt: ${receipt.slice(0, 800)}`)
  const [, reusable, tempUnusable, retired, total] = triage
  assert.equal(Number(reusable) + Number(tempUnusable) + Number(retired), Number(total), `the three-way identity must hold in the receipt: ${triage[0]}`)
  assert.equal(Number(retired) >= 1, true, 'the retired candidate is reported as retired (it must not vanish from the readout)')

  // —— 第 2 轮：同一份台账再派一张 ⇒ **0 条新事件、回执不再印那一行**（"一次性"的接线面）——
  const second = await callChainTool(tools, { action: 'next', limit: 1 })
  assert.equal(retiredEvents().length, 1, 'round 2 must add no retirement event at all')
  assert.doesNotMatch(second, /pool-retire:/u, `round 2 must not print the retirement line: ${second.slice(0, 600)}`)
  // 反例（防"这一格恒真"）：判据仍能判出**别的**候选 ⇒ 下一轮还会印（不是被静默关掉了）
  office.recordDispatchStarted(chainCall(), {
    taskId: 'TASK-24251', provider: 'spawn', childSessionId: 'm242-chain-legacy2', parentSessionId: CHAIN_SESSION,
    tools: 3, role: 'developer', mode: 'continuable', maskHash: LEGACY,
  })
  office.journalFor(WORKSPACE).append('dispatch/finished', { task: 'TASK-24251', childSessionId: 'm242-chain-legacy2' })
  for (const id of ['TASK-24252', 'TASK-24253']) {
    office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task: chainCard(id) })
  }
  const third = await callChainTool(tools, { action: 'next', limit: 1 })
  assert.match(third, /pool-retire: 1 permanently-unreusable candidate\(s\)/u, `a NEW permanently unreusable candidate must still be retired and printed: ${third.slice(0, 800)}`)
  assert.equal(retiredEvents().length, 2, 'the new candidate is written too (the mechanism is alive, not switched off)')
})

/* ———————————— M242-06 逐轮时序（真实写路径） ———————————— */

/**
 * **`REV-116` 必核三③ 要的那份时序**，而且走**真实写路径** `retirePermanentCandidates`（`src/index.ts`
 * 调的就是它：一份读 → 判据 → 落盘）。修前 `round()` 绕过那道门、写路径上一格都没有。
 *
 * 逐轮：① 刚派发（busy）⇒ **不判**（内容门：有在飞卡 ⇒ 临时）；② 宿主结算（idle）⇒ **同一轮**判成
 * 永久并落盘（没有"等一轮"那道门了）；③ 之后每轮 **0 条**（结构幂等：先减退役集）；④ 新候选照样能判
 * （防"一律 0"的恒真）。
 */
test('M242-06 the per-round timeline through the real write path: not judged while busy, retired in the very round it settles, zero afterwards', () => {
  const store = new SdoStore(join(BASE, 'timeline', '.sdo'))
  store.ensureLayout()
  const journal = new Journal(store)
  const read = (): PoolEvent[] => journal.read().events.map((event) => ({ type: event.type, data: event.data, at: event.at }))
  const retiredCount = (): number => retiredCandidatesOf(read()).length

  // —— 轮 1：刚派发，未结算 ⇒ busy ⇒ 不进判据（不改台账）——
  journal.append('dispatch/started', {
    childSessionId: 'm242-timeline', role: 'developer', task: 'TASK-24260', parentSessionId: VIEWER,
    mode: 'continuable', maskHash: LEGACY,
  })
  const round1 = retirePermanentCandidates(journal, read())
  assert.deepEqual(round1.written, { events: 0, rows: 0 }, 'round 1: a busy child is TEMPORARY (content gate), so nothing is written')
  assert.deepEqual(round1.rows, [], 'round 1: the projection is empty (it is not merely "delayed by a guard")')
  assert.equal(retiredCount(), 0, 'round 1: the ledger has no retirement yet')

  // —— 轮 2：宿主结算 ⇒ idle ⇒ **同一轮**判成永久并落盘 ——
  journal.append('dispatch/finished', { childSessionId: 'm242-timeline' })
  const round2 = retirePermanentCandidates(journal, read())
  assert.deepEqual(round2.written, { events: 1, rows: 1 }, 'round 2: the candidate settles and is retired in the SAME round (no waiting round exists)')
  assert.deepEqual(round2.rows.map((row) => row.childSessionId), ['m242-timeline'], 'round 2: exactly that candidate, with the role attached (the receipt groups by role)')
  assert.deepEqual(round2.rows.map((row) => row.basis), ['mask-not-comparable'], 'round 2: the basis comes from the single judgement point')
  assert.equal(retiredCount(), 1, 'round 2: the read side folds it back (one event, one candidate)')
  // 时序的"位置"也要对：退役事件写在 finished **之后**（那就是"真被退役"的那一刻）
  const events = read()
  const finishedAt = events.findIndex((event) => event.type === 'dispatch/finished')
  const retiredAt = events.findIndex((event) => event.type === POOL_RETIRED_EVENT)
  assert.equal(retiredAt > finishedAt, true, `the retirement event must land AFTER the settling event (finished=${String(finishedAt)}, retired=${String(retiredAt)})`)

  // —— 轮 3 / 4：**0 条**（幂等由结构给出：折叠先减退役集）——
  assert.deepEqual(retirePermanentCandidates(journal, read()).written, { events: 0, rows: 0 }, 'round 3: nothing left to judge, so zero events')
  assert.deepEqual(retirePermanentCandidates(journal, read()).written, { events: 0, rows: 0 }, 'round 4: still zero (structurally, not by a counter)')

  // —— 反例的反面（防恒真）：一个**新的**永久候选照样会被判 ——
  journal.append('dispatch/started', {
    childSessionId: 'm242-timeline2', role: 'developer', task: 'TASK-24261', parentSessionId: VIEWER,
    mode: 'continuable', maskHash: LEGACY,
  })
  journal.append('dispatch/finished', { childSessionId: 'm242-timeline2' })
  const round5 = retirePermanentCandidates(journal, read())
  assert.deepEqual(round5.written, { events: 1, rows: 1 }, 'round 5: a new permanently unreusable candidate is still retired (the projection is not "always empty")')
  assert.deepEqual(retiredCandidatesOf(read()).map((row) => row.childSessionId).sort(), ['m242-timeline', 'm242-timeline2'], 'both candidates are in the retired list')
})

/* ———————————— M242-07 两份读数同源：只数一次、不退两次 ———————————— */

/**
 * **`REV-116` 必核四② 的机械面**：修前「快照里的 `permanent`」与「台账里的 `retiredOfRole`」来自**两次读**
 * ⇒ 两次之间若落了别的 `pool/retired`，同一候选会同时出现在两边：三分**双计**，且被**再退役一次**。
 *
 * 本格钉三件事：① 修前那个错法（直接相加）**确实**会双计（作为对照组断言，不是描述）；
 * ② `poolTriageForRound` 把它们同源化之后只数一次；③ 判据入口吃的是**折过退役集**的数组
 * ⇒ 同一候选不可能被退两次。
 */
test('M242-07 the snapshot bucket and the retired ledger are reconciled: counted once, and never retired twice', () => {
  const pool = poolOf([child('m242-same-ok'), child('m242-same-x', { maskHash: LEGACY })])
  assert.deepEqual(pool.permanent.map((row) => row.childSessionId), ['m242-same-x'], 'fixture premise: the legacy child sits in the snapshot permanent bucket')
  const retiredRow = { childSessionId: 'm242-same-x', role: 'developer', reason: 'legacy mask', basis: 'mask-not-comparable' }
  const retired = [{ ...retiredRow, at: '' }]

  // ① 修前的错法（对照组）：两份读数直接相加 ⇒ 同一候选被数两遍（retired 2，而实际只有 1 个）
  const naive = poolTriage(pool, retired.length)
  assert.equal(naive.retired, 2, 'the pre-fix shape double counts (control group: this is the defect, asserted on purpose)')

  // ② 正解：同源化之后只数一次
  const rows = poolTriageForRound({ pools: [pool], retired, retiring: [] })
  assert.deepEqual(rows, [{ role: 'developer', reusable: 1, tempUnusable: 0, retired: 1, total: 2 }], 'the retired candidate is counted exactly once')

  // ③ 本轮新退役按"已退役"算 ⇒ 退役前后读数一字不变（左边进右边出）
  const before = poolTriageForRound({ pools: [pool], retiring: [] })
  const after = poolTriageForRound({ pools: [{ ...pool, unusable: [], permanent: [] }], retiring: [retiredRow] })
  assert.deepEqual(after, before, 'retiring must not change the readout (a candidate leaves permanent and enters the retired list)')

  // ④ 判据入口折过退役集 ⇒ 同一候选不可能被写第二条（"一次"是结构，不是调用方的自律）
  const events = [...seedChildEvents('m242-same-x', LEGACY)]
  assert.deepEqual(permanentCandidatesFromEvents(events).map((row) => row.childSessionId), ['m242-same-x'], 'state 1: before retirement it is in the projection')
  const afterRetirement = [...events, retireEvent([{ childSessionId: 'm242-same-x', role: 'developer', basis: 'mask-not-comparable' }])]
  assert.deepEqual(permanentCandidatesFromEvents(afterRetirement), [], 'state 2: after retirement the projection is empty — the same array cannot produce a second retirement')
})
