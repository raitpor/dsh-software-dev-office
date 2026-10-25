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
 *     第一轮落一条事件、第二轮 **0 条**（这就是"不再每次派发重评估重写 82 条"的机制面），
 *     外加"**刚诞生的候选本轮不退役**"那道门（`establishedChildrenOf`）的两态。
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
  establishedChildrenOf,
  foldPoolChildren,
  permanentCandidatesOf,
  permanentUnreusableReason,
  poolTriage,
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
  reuseSkippedEventData,
  reuseSkippedOf,
} from '../src/domain/dispatchFace.js'
import type { PoolChild, PoolEvent } from '../src/domain/pool.js'

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
  // **出生满一轮那道门**：`m242-once` 的 started 是**最新那一笔** ⇒ 它刚刚诞生 ⇒ 本轮不退役（预告）
  const newestOnly = establishedChildrenOf(journal.read().events.map((event) => ({ type: event.type, data: event.data, at: event.at })))
  assert.equal(newestOnly.has('m242-once'), false, 'a child created in the newest round must not be retired yet (it has not lived through one full round)')
  // 另起一笔 `dispatch/started`（另一个孩子）⇒ `m242-once` 不再是最新 ⇒ 它算"出生满一轮"
  journal.append('dispatch/started', { childSessionId: 'm242-newer', role: 'developer', task: 'TASK-24204', parentSessionId: VIEWER, mode: 'continuable', maskHash: CURRENT })
  const afterNewer = establishedChildrenOf(journal.read().events.map((event) => ({ type: event.type, data: event.data, at: event.at })))
  assert.equal(afterNewer.has('m242-once'), true, 'once a newer dispatch exists the candidate counts as established and becomes eligible for retirement')
  assert.equal(afterNewer.has('m242-newer'), false, 'the newest child itself stays protected (the rule is order-based, not time-based)')
  const round = (): ReturnType<typeof recordPoolRetired> => {
    const events = journal.read().events.map((event) => ({ type: event.type, data: event.data, at: event.at }))
    const now = poolOf([...foldPoolChildren(events).values()])
    return recordPoolRetired(journal, now.permanent.map((row) => ({ ...row, role: now.role })))
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
