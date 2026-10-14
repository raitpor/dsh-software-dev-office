/**
 * **增量 154：门禁签字失效 ⇒ 不派（DEF-040 第一刀：判据逻辑 / §3E 族 6）**。
 *
 * 缺陷原文（三份 re-verify）：`readyTasks(tasks, limit)` / `classifyNonDispatchable(tasks)` 的签名里
 * 没有 store/journal（结构上读不到签字台账）；`signatureState` 的消费点只在 `gates.ts` / `office.ts` /
 * `index.ts` —— **派发与认领没读**。真机剧本（B-28）：G3 签字 03:41 生效 → 之后失效 → 06:40–07:04
 * 仍连派 4 张卡并在失效窗口内完成 ✗。
 *
 * **本卡（第一刀）只落"判据逻辑"**：两个纯函数接收**显式的**门禁状态（`StaleGate`），不自己读台账 ——
 * 这样判据可被穷举测试，接线（`office.ts` 三处 + `claim` 拒绝码 + 回执回显）是**下一步**。
 * ⚠️ 因此**现在还没有调用方传它** ⇒ 本用例证明的是"判据正确"，**不是**"门禁已生效"；
 * 不传时行为与以前**逐字节相同**（M154-01/03 就是这条的结构证据）。
 *
 * ⚠️ **只拦 `stale`，不拦 `missing`**（M154-05 钉住注释）：`missing` = 从来没签过，把它也当"不许派"
 * 会让所有还没走到该门禁签字的正常流程停摆（本仓 `construction` 阶段就是 `entry: [G3]`）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { classifyNonDispatchable, readyTasks } from '../src/domain/plan.js'
import type { StaleGate } from '../src/domain/plan.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const stale: StaleGate = { gate: 'G3', reason: '签字后被真源变更作废（夹具）' }

function card(id: string, status: TaskCard['status'] = 'planned', over: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['artifact'],
    blockedBy: [],
    writeScopes: [`src/${id.toLowerCase()}/`],
    role: 'developer',
    size: 'small',
    revision: 1,
    status,
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

test('M154-01 反例：不传门禁状态 ⇒ 可派集合与以前**逐字节相同**（零调用点破坏）', () => {
  const tasks = [card('TASK-001'), card('TASK-002'), card('TASK-003', 'blocked')]
  assert.deepEqual(readyTasks(tasks, 4).map((task) => task.id), ['TASK-001', 'TASK-002'], '未传门禁状态时照旧按规模秩与 id 派')
})

test('M154-02 传失效门禁 ⇒ 一张都不派（修前没有任何参数能表达这件事）', () => {
  const tasks = [card('TASK-001'), card('TASK-002')]
  assert.deepEqual(readyTasks(tasks, 4, stale), [], '当前阶段入口门禁失效 ⇒ 不派')
  // 反例：门禁恢复（不传 = 有效/未失效）⇒ 立刻恢复可派
  assert.deepEqual(readyTasks(tasks, 4).map((task) => task.id), ['TASK-001', 'TASK-002'], '门禁恢复后必须照常可派')
})

test('M154-03 classifyNonDispatchable 不传 ⇒ **没有** gateStale 键（形状不变，这是零破坏的结构证据）', () => {
  const plan = classifyNonDispatchable([card('TASK-001'), card('TASK-002', 'blocked')])
  assert.equal('gateStale' in plan, false, '不传时不能多出任何键')
  assert.deepEqual(Object.keys(plan).sort(), ['blocked', 'dependencies', 'scope'], '键集合与以前逐字相同')
})

test('M154-04 传失效门禁 ⇒ gateStale 与其余三类**并列**（其余三类照旧，各归各类不重复）', () => {
  const tasks = [card('TASK-001'), card('TASK-002', 'blocked'), card('TASK-003', 'done')]
  const plan = classifyNonDispatchable(tasks, stale)
  assert.deepEqual((plan.gateStale?.tasks ?? []).map((task) => task.id), ['TASK-001'], '只有未结束的 planned/ready 卡进这一类')
  // **DEF-040 第三刀**：这一类必须把"哪个门禁、为什么"一起带出去 —— 只给卡的话渲染侧只能回落成
  // "本轮没有可派发的任务卡"，而那句话与"活干完了"长得一模一样（本缺陷的成因）。
  assert.equal(plan.gateStale?.gate, stale.gate, '必须点名失效的门禁')
  assert.equal(plan.gateStale?.reason, stale.reason, '必须原样带上失效原因（渲染侧不重算）')
  assert.deepEqual(plan.blocked.map((task) => task.id), ['TASK-002'], 'blocked 仍归 ①（不混进第四类）')
  const withoutGate = classifyNonDispatchable(tasks)
  assert.deepEqual(plan.blocked, withoutGate.blocked, '其余三类与不传门禁时完全一致（并列，不是替代）')
  assert.deepEqual(plan.dependencies, withoutGate.dependencies, '依赖类不受影响')
})

test('M154-05 语义分辨钉住：源码必须写明**只拦 stale、不拦 missing**（防接到 missing 上造成停摆）', () => {
  const source = readFileSync(join(ROOT, 'src', 'domain', 'plan.ts'), 'utf8')
  assert.equal(source.includes("status === 'stale'"), true, '注释要实现时取 stale 这个判别位')
  assert.equal(source.includes('从来没签过'), true, '必须写明 missing 与 stale 的区别')
  // **接线已交付（第三刀）**：判据的装配收敛到唯一出口 —— plan.ts 只保留纯函数的入参形状
  assert.equal(source.includes('domain/entryGate.ts'), true, 'plan.ts 必须指向唯一出口（装配在 domain/entryGate.ts，本文件保持纯函数）')
  // **事实更正（2026-10-14 复算）**：旧注释写「本仓现状就是 `construction` 阶段 `entry: [G3]`」——
  // 与流程数据不符（`waterfall` 的 `construction` 入口是 **G4**，`G3` 是 `design-plan` 的）⇒ 不许写回来。
  assert.equal(source.includes('本仓现状就是'), false, '不得再留与流程数据不符的那句"construction 入口是 G3"')
  assert.equal(source.includes('G4'), true, '必须写明"各流程各阶段入口不同"（waterfall 的 construction 是 G4）')
})
