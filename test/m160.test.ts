/**
 * **增量 160：DEF-044（"可能并行"判据不认 `'*'` 与传递依赖）**。
 *
 * 缺陷现场（现盘钉红，见报告）：`a.blockedBy.includes(b.id) || b.blockedBy.includes(a.id)` 这一行
 * 被**逐字抄在三处** —— `validatePlan` 的 `write-scope-disjoint`、`classifyNonDispatchable` 的 `scope`、
 * `scopeHeldTasks`；三处**都不认 `'*'`**（"排在所有其它卡之后"）、**都不算传递依赖**，
 * 而同一文件的 `readyTasks.satisfied` 与 `validatePlan` 的 `acyclic` **都认 `'*'`** ⇒ 口径内自相矛盾：
 * 判据说"可能并行但写范围重叠"，派发面却永远不会把它们同时派出（合法的排队卡被当成冲突）。
 *
 * 修法：抽成**唯一出口** `orderedPair(a, b, tasks)`（与 ADR-009 的 `scopeOverlaps` 同款做法），
 * 三处调用点全部改走它。**验收是行为**：三种有序形状（`'*'` / 传递 / 直接）在**三处**结论一致（无冲突），
 * 且**真并行**（无依赖 + 写范围重叠）**仍然**报冲突（不许借修缺陷之名放宽）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { classifyNonDispatchable, orderedPair, scopeHeldTasks, validatePlan } from '../src/domain/plan.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function card(id: string, status: TaskCard['status'], writeScopes: string[], blockedBy: string[] = []): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['artifact'],
    blockedBy,
    writeScopes,
    role: 'developer',
    size: 'small',
    revision: 1,
    status,
    requirements: [],
    fixes: [],
    mitigates: [],
    mitigatesWaiver: [],
    impact: [],
    landing: [],
    evidence: [],
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  } as unknown as TaskCard
}

/** 三处判据的读数（同一条形状要在三处**一致**）。 */
function readings(tasks: TaskCard[], holder?: TaskCard): { validatePlan: number; classify: number; scopeHeld: number } {
  return {
    validatePlan: validatePlan(tasks).filter((issue) => String(issue.code) === 'write-scope-disjoint').length,
    classify: (classifyNonDispatchable(tasks).scope ?? []).length,
    scopeHeld: holder === undefined ? 0 : scopeHeldTasks([...tasks, holder]).length,
  }
}

test('M160-01 三种**有序**形状在三处判据里都不算冲突；真并行对照组三处**仍然**报冲突（不许放宽）', () => {
  // ① `'*'`：B 排在所有其它卡之后 ⇒ 与 A 不可能并行
  const star = [card('TASK-A', 'ready', ['src/x/']), card('TASK-B', 'ready', ['src/x/'], ['*'])]
  // ② 传递依赖：A → B → C（A 依赖 B、B 依赖 C），A 与 C 写范围重叠 ⇒ 不可能并行
  const chain = [
    card('TASK-A', 'ready', ['src/y/'], ['TASK-B']),
    card('TASK-B', 'ready', ['src/z/'], ['TASK-C']),
    card('TASK-C', 'ready', ['src/y/']),
  ]
  // ③ 直接依赖（修前就对：抑制机制本身是好的）
  const direct = [card('TASK-A', 'ready', ['src/d/'], ['TASK-B']), card('TASK-B', 'ready', ['src/d/'])]
  // ④ **真并行**：无依赖 + 写范围重叠 ⇒ 必须继续报冲突
  const parallel = [card('TASK-A', 'ready', ['src/p/']), card('TASK-B', 'ready', ['src/p/'])]

  assert.deepEqual(readings(star), { validatePlan: 0, classify: 0, scopeHeld: 0 }, "①'*'：三处都不得报冲突")
  assert.deepEqual(readings(chain), { validatePlan: 0, classify: 0, scopeHeld: 0 }, '②传递依赖：三处都不得报冲突')
  assert.deepEqual(readings(direct), { validatePlan: 0, classify: 0, scopeHeld: 0 }, '③直接依赖：三处一致（回归基线）')
  assert.deepEqual(
    readings(parallel),
    { validatePlan: 1, classify: 2, scopeHeld: 0 },
    '④真并行：validatePlan / classify **必须**继续报冲突（修缺陷不等于放宽判据）',
  )

  // `scopeHeldTasks` 那一面用"在飞持有者"造同一形状（三条都要 0）
  const heldStar = [card('TASK-H', 'in-progress', ['src/h/'], ['*']), card('TASK-N', 'ready', ['src/h/'])]
  const heldChain = [
    card('TASK-H', 'in-progress', ['src/h2/']),
    card('TASK-X', 'ready', ['src/h3/'], ['TASK-H']),
    card('TASK-N', 'ready', ['src/h2/'], ['TASK-X']),
  ]
  const heldDirect = [card('TASK-H', 'in-progress', ['src/h4/']), card('TASK-N', 'ready', ['src/h4/'], ['TASK-H'])]
  assert.deepEqual(readings(heldStar), { validatePlan: 0, classify: 0, scopeHeld: 0 }, "scopeHeld × '*'：不得报写锁挡住")
  assert.deepEqual(readings(heldChain), { validatePlan: 0, classify: 0, scopeHeld: 0 }, 'scopeHeld × 传递依赖：不得报写锁挡住')
  assert.deepEqual(readings(heldDirect), { validatePlan: 0, classify: 0, scopeHeld: 0 }, 'scopeHeld × 直接依赖：回归基线')
  // 反例（这一面也不许放宽）：在飞持有者与就绪卡**真并行**时照样要报
  assert.equal(
    scopeHeldTasks([card('TASK-H', 'in-progress', ['src/h5/']), card('TASK-N', 'ready', ['src/h5/'])]).length,
    1,
    'scopeHeld × 真并行：必须继续报（否则等于把写锁静默拆了）',
  )
})

test('M160-02 反例：把写范围改成不相交 ⇒ 冲突消失（证明不是"全都不报"）', () => {
  const overlapping = [card('TASK-A', 'ready', ['src/p/']), card('TASK-B', 'ready', ['src/p/'])]
  const disjoint = [card('TASK-A', 'ready', ['src/p/']), card('TASK-B', 'ready', ['src/q/'])]
  assert.deepEqual(readings(overlapping), { validatePlan: 1, classify: 2, scopeHeld: 0 }, '前置：重叠时确实报')
  assert.deepEqual(readings(disjoint), { validatePlan: 0, classify: 0, scopeHeld: 0 }, '反例：不相交时不报')
})

test('M160-03 边界：`orderedPair` 自身（自反、环路、链中间出现 `\'*\'`）', () => {
  const a = card('TASK-A', 'ready', ['src/a/'])
  const b = card('TASK-B', 'ready', ['src/b/'], ['TASK-A'])
  assert.equal(orderedPair(a, a, [a]), true, '自反：同一张卡视为有序（调用点用它跳过自己）')
  assert.equal(orderedPair(a, b, [a, b]), true, '直接依赖')
  assert.equal(orderedPair(b, a, [a, b]), true, '反向也算（任一方向有序即不并行）')

  // 环路（B↔C）不得死循环，且**与环无关**的卡仍按事实判
  const c1 = card('TASK-B', 'ready', ['src/b/'], ['TASK-C'])
  const c2 = card('TASK-C', 'ready', ['src/c/'], ['TASK-B'])
  const far = card('TASK-Z', 'ready', ['src/z/'])
  assert.equal(orderedPair(c1, c2, [c1, c2]), true, '环上互为依赖 ⇒ 有序（且不许死循环）')
  assert.equal(orderedPair(c1, far, [c1, c2, far]), false, '与环无关的卡之间不得被牵连')

  // 链中间出现 `'*'` ⇒ 下游也在所有卡之后（与 ① 同一语义往下传）
  const mid = card('TASK-M', 'ready', ['src/m/'], ['*'])
  const down = card('TASK-D', 'ready', ['src/d/'], ['TASK-M'])
  assert.equal(orderedPair(down, far, [mid, down, far]), true, "依赖链中间有 '*' ⇒ 判有序")
})

test('M160-04 结构：判据收敛到**唯一出口** `orderedPair`，三处调用点逐点钉住（不许各写一遍）', () => {
  const source = readFileSync(join(ROOT, 'src', 'domain', 'plan.ts'), 'utf8')
  assert.equal(source.includes('export function orderedPair('), true, '唯一出口必须是导出的具名函数（可被单测直接钉）')
  // 三处调用点**逐点**断言（不用"出现次数"这种松断言：数得对不等于接对地方）
  assert.equal(source.includes('if (orderedPair(a, b, tasks)) continue'), true, 'validatePlan 那一处')
  assert.equal(source.includes('if (orderedPair(task, holder, tasks)) continue'), true, 'scopeHeldTasks 那一处')
  assert.equal(source.includes('if (orderedPair(task, other, tasks)) continue'), true, 'classifyNonDispatchable 那一处')
  // 反向：旧谓词在**代码行**里必须绝迹（注释里引用旧行是正当的 ⇒ 只扫代码行）
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
    .join('\n')
  assert.equal(
    /blockedBy\.includes\((b|holder|other)\.id\)/u.test(codeOnly),
    false,
    '三处旧谓词必须绝迹（否则就是第四份实现，下一个洞还会被继承）',
  )
})
