/**
 * 2026-10-07 测试报告（SDO-51…SDO-58）里**插件侧**四条的回归：
 *
 * · **SDO-55** defect 更新不回显有效差异、no-op 报「已更新」⇒ 现落 append-only 差异事件 + 回显 from→to + no-op 报错；
 * · **SDO-56** 标题里的 `[open]` 前缀与 status 打架 ⇒ 写入时剥掉（状态由字段派生）并作为一次真实更正入账；
 * · **SDO-52** 工具面变更对**复用会话**不生效 ⇒ 池里记掩码指纹，复用前比对，不符/未知 ⇒ 强制新起并如实回报；
 * · **SDO-54** 派发器静默不派发（诊断被看板淹没）⇒ 诊断**紧跟裁决**，`why=true` 只输出诊断。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { listDefects, recordDefect, stripStatusPrefix, updateDefect } from '../src/domain/records.js'
import { admitDispatch, rolePools } from '../src/domain/pool.js'
import { maskFingerprint } from '../src/domain/roles.js'
import type { PoolChild } from '../src/domain/pool.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm47')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('SDO-55 / SDO-56：缺陷更正落**差异事件**、回显 from→to，no-op 必须报错，状态前缀由 status 派生', () => {
  const defect = recordDefect(store, journal, { title: '[open] 注册表条目 12 类（应为 12）', severity: 'minor', status: 'open' })
  assert.equal(defect.status, 'open')

  // ① 真更正：title 变了 ⇒ 落 `defect/updated` 且带 before/after（旧实现只发 {id,status}，title 静默丢失）
  const updated = updateDefect(store, journal, defect.id, { title: '注册表条目 13 类（原写 12 是错的）' }, 'office')
  assert.equal(updated.ok, true)
  if (updated.ok) {
    assert.equal(updated.defect.title, '注册表条目 13 类（原写 12 是错的）', '标题要被真的改掉')
    const titleChange = updated.changes.find((change) => change.field === 'title')
    assert.ok(titleChange !== undefined, '要回显 title 的 from→to')
    assert.match(titleChange.from, /\[open\]/u, 'from 是原值（含写死的前缀）')
    assert.equal(titleChange.to, '注册表条目 13 类（原写 12 是错的）', 'to 是**剥掉状态前缀后**的值（SDO-56）')
    assert.equal(updated.changes.some((change) => change.field === 'titleStatusPrefix'), true, '剥前缀也要作为一次更正入账')
  }
  const events = journal.read().events.filter((event) => event.type === 'defect/updated')
  assert.equal(events.length, 1, '更正必须进真源（append-only）')
  assert.equal((events[0]?.data.by), 'office')
  assert.ok(Array.isArray(events[0]?.data.changes), '事件要带 changes 明细，而不是只有 {id,status}')

  // ② no-op：提交与现值完全相同的标题 ⇒ **必须报错**（不得回「已更新」）
  const noop = updateDefect(store, journal, defect.id, { title: '注册表条目 13 类（原写 12 是错的）' }, 'office')
  assert.equal(noop.ok, false)
  assert.equal(noop.ok ? '' : noop.code, 'no-op-update')
  assert.equal(listDefects(store).length, 1)
  assert.equal(journal.read().events.filter((event) => event.type === 'defect/updated').length, 1, 'no-op 不得产生事件')

  // ③ 纯状态更正仍然可用（G6 的 C-51 依赖它）
  const closed = updateDefect(store, journal, defect.id, { status: 'closed' }, 'office')
  assert.equal(closed.ok, true)
  assert.equal(listDefects(store)[0]?.status, 'closed')

  // ④ 前缀工具：只剥开头的状态标记，不碰正文里的方括号
  assert.deepEqual(stripStatusPrefix('[closed] 时延超标'), { title: '时延超标', stripped: 'closed' })
  assert.deepEqual(stripStatusPrefix('[T1] 维度不符'), { title: '[T1] 维度不符', stripped: '' })
})

test('SDO-52：掩码指纹 —— 空闲子代理的工具面指纹不符/未知时**不复用**（如实回报），一致才复用', () => {
  const chatty: PoolChild = {
    childSessionId: 'c-old', role: 'developer', task: 'T0', mode: 'continuable',
    state: 'idle', rounds: 3, startedAt: '', finishedAt: '', maskHash: 'old-mask',
  }
  const legacy: PoolChild = {
    childSessionId: 'c-legacy', role: 'developer', task: 'T0b', mode: 'continuable',
    state: 'idle', rounds: 1, startedAt: '', finishedAt: '', // 老事件没有指纹
  }
  const card = (id: string): never => ({ id, role: 'developer', size: 'small', status: 'ready', blockedBy: [], writeScopes: [`src/${id}/`], evidenceRequired: ['command'] } as never)

  // ① 指纹不符 ⇒ 拒绝复用 + 如实回报（真机：补了 read_image 却投进旧会话）
  // **R-6**：池视图本身就判指纹（与准入同一判据）⇒ "跳过了谁、为什么"在 `unusable` 里如实露面，
  // 不再靠准入端的 `reuseSkipped`（那会与池视图分叉：一边说空闲可复用、一边拒绝）
  const stalePools = rolePools({ children: [chatty], roles: ['developer'], caps: { developer: 2 }, defaultCap: 4, maskHashOf: () => 'new-mask' })
  assert.equal(stalePools[0]?.idle.length, 0, '指纹不符 ⇒ 不算空闲可复用')
  assert.match(stalePools[0]?.unusable[0]?.reason ?? '', /掩码已变更/u, '要如实记账"跳过了谁、为什么"')
  const mismatch = admitDispatch({
    ready: [card('TASK-001')], pools: stalePools,
    globalRoom: 4, reuseIdle: true, maskHashOf: () => 'new-mask',
  })
  assert.equal(mismatch.dispatch[0]?.reuseChildId, undefined, '指纹不符不得复用')

  // ② 老子代理没有指纹 ⇒ 同样不复用（无法确认其工具面）
  const legacyPools = rolePools({ children: [legacy], roles: ['developer'], caps: { developer: 2 }, defaultCap: 4, maskHashOf: () => 'new-mask' })
  assert.match(legacyPools[0]?.unusable[0]?.reason ?? '', /没有掩码指纹/u)
  const unknown = admitDispatch({
    ready: [card('TASK-002')], pools: legacyPools,
    globalRoom: 4, reuseIdle: true, maskHashOf: () => 'new-mask',
  })
  assert.equal(unknown.dispatch[0]?.reuseChildId, undefined, '未知指纹不得复用')

  // ③ 指纹一致 ⇒ 复用（且不报 skip）
  const freshPools = rolePools({ children: [{ ...chatty, maskHash: 'new-mask' }], roles: ['developer'], caps: { developer: 2 }, defaultCap: 4, maskHashOf: () => 'new-mask' })
  assert.equal(freshPools[0]?.idle.length, 1, '指纹一致 ⇒ 算空闲可复用')
  assert.deepEqual(freshPools[0]?.unusable, [])
  const same = admitDispatch({
    ready: [card('TASK-003')], pools: freshPools,
    globalRoom: 4, reuseIdle: true, maskHashOf: () => 'new-mask',
  })
  assert.equal(same.dispatch[0]?.reuseChildId, 'c-old', '指纹一致就该复用')
  assert.deepEqual(same.reuseSkipped, [])

  // ④ 指纹本身：不同角色不同、同角色稳定
  assert.notEqual(maskFingerprint('developer'), maskFingerprint('reviewer'))
  assert.equal(maskFingerprint('developer'), maskFingerprint('developer'))
})

test('SDO-54：诊断**紧跟裁决**输出，并提供 `why=true` 只看诊断（真机：10 条诊断被看板淹没）', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  // 结构断言（不碰转义）：诊断块存在、`why` 开关在位、看板在诊断**之后**
  assert.match(index, /const diagnostics = issues/u, '诊断块在位')
  assert.match(index, /args\.why === true/u, 'why 开关在位（只输出裁决 + 诊断）')
  const diagnosticsAt = index.indexOf('const diagnostics = issues')
  const boardAt = index.indexOf('describePlan(office.tasks(call), [], office.shapeNotes(call))')
  assert.ok(boardAt > diagnosticsAt && diagnosticsAt > 0, '看板必须排在诊断**之后**（诊断置顶，不再被淹没）')
  assert.match(index, /kPlanIssueLine/u, '每条诊断单独成行（code / taskId / detail / remedy）')
  const tools = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  assert.match(tools, /why: args\.why === true/u, '`why` 要进 execute 映射（否则工具边界静默丢弃）')
})

test('SDO-55 追加实测（2026-10-07）：`evidence`/`reason` 载荷必须**写进事件**（曾被静默丢弃，journal 零命中）', () => {
  const defect = recordDefect(store, journal, { title: '载荷测试', severity: 'minor', status: 'closed' })
  // ① 只有载荷、没有字段变化 ⇒ 仍是一次**有内容的更正**（否则调用方无法把更正说明补进事件日志，
  //    真机上就只能活在 defects/*.yml 里 —— 审计链看不到）
  const updated = updateDefect(store, journal, defect.id, {
    status: 'closed',
    evidence: '〔更正事件：from 12 → to 13，理由：基线重算〕',
    reason: '手工兜底',
  }, 'office')
  assert.equal(updated.ok, true, `带载荷的更正不得被判 no-op：${updated.ok ? '' : updated.detail}`)
  const event = journal.read().events.filter((item) => item.type === 'defect/updated').pop()
  assert.equal(event?.data.evidence, '〔更正事件：from 12 → to 13，理由：基线重算〕', '载荷要**原样**入账')
  assert.equal(event?.data.reason, '手工兜底')
  assert.equal(updated.ok && updated.changes.some((change) => change.field === 'evidence'), true, '载荷也要出现在 from→to 回显里')

  // ② 既没有字段变化、也没有载荷 ⇒ 仍然报 no-op（不许回「已更新」）
  const noop = updateDefect(store, journal, defect.id, { status: 'closed' }, 'office')
  assert.equal(noop.ok, false)
  assert.equal(noop.ok ? '' : noop.code, 'no-op-update')
  assert.equal(journal.read().events.filter((item) => item.type === 'defect/updated').length, 1, 'no-op 不得产生事件')
})
