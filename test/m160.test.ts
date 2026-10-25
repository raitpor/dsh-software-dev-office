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
 *
 * **0.1.7 批3 改口径（`REQ-066` / `ADR-025` / `TASK-172`）**：派发面把"相交"拆成**两种处置** ——
 *   · `merge`（默认）⇒ **照派**、只**点名**（git 对同一文件的不同区域本来就能干净合并）；
 *   · `exclusive-window` / `unknown-scope` ⇒ 真**串行**（`scopeHeldTasks` 才返回它）。
 * 于是"不许放宽"这条守据在派发面换了读数：真并行**必须仍被看见**（`scopeIntersections` 一条，
 * 点名两张卡与路径）；一旦任一方声明独占窗口 ⇒ **必须仍被挡住**（`scopeHeldTasks` 一条）。
 *
 * **`DEF-239`（`TASK-268`）再收一格**：两个**静态面**（`validatePlan` 的 `write-scope-disjoint`、
 * `classifyNonDispatchable` 的 `scope` 维）也改成同一支 `scopeSerialKindOf` 定支 ——
 * `merge` 在静态面同样**不出** issue，只有 `exclusive-window` / `unknown-scope` 出。
 * 因此本文件"不许放宽"的读数从"`merge` 也要报"换成"同一形状加一份独占窗口**必须**报"
 * （`M160-01` ④' / `M160-02` / `M160-05` 三格逐条钉住，反向格仍在：`merge` 一律 0 条）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { classifyNonDispatchable, orderedPair, scopeHeldTasks, scopeIntersections, validatePlan } from '../src/domain/plan.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function card(id: string, status: TaskCard['status'], writeScopes: string[], blockedBy: string[] = [], exclusive?: string): TaskCard {
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
    ...(exclusive === undefined ? {} : { exclusive }),
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

/** 派发面的**点名**读数（`ADR-025`：相交默认照派 ⇒ 它必须仍然看得见）。 */
function named(tasks: TaskCard[]): { task: string; holder: string; kind: string; overlap: string[] }[] {
  return scopeIntersections(tasks).map((row) => ({ task: row.task.id, holder: row.holder.id, kind: row.kind, overlap: row.overlap }))
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
  // ④ **真并行**：无依赖 + 写范围重叠 ⇒ 必须继续**看得见**；要它继续**报冲突**得落在串行那一档
  const parallel = [card('TASK-A', 'ready', ['src/p/']), card('TASK-B', 'ready', ['src/p/'])]
  // ④' 同形 + 任一方声明**独占窗口** ⇒ 两个静态面都必须重新出 issue（`DEF-239` 的"不许放宽"读数落在这里）
  const parallelWindow = [card('TASK-A', 'ready', ['src/p/'], [], 'full-suite'), card('TASK-B', 'ready', ['src/p/'])]

  assert.deepEqual(readings(star), { validatePlan: 0, classify: 0, scopeHeld: 0 }, "①'*'：三处都不得报冲突")
  assert.deepEqual(readings(chain), { validatePlan: 0, classify: 0, scopeHeld: 0 }, '②传递依赖：三处都不得报冲突')
  assert.deepEqual(readings(direct), { validatePlan: 0, classify: 0, scopeHeld: 0 }, '③直接依赖：三处一致（回归基线）')
  // **`DEF-239`（`ADR-025`）**：普通相交属 `merge` ⇒ 两个静态面也**不再**为它出 issue。
  // "修缺陷不等于放宽判据"这条守据因此换到下一个读数上：同一形状加一份独占窗口，两个面都必须重新出。
  assert.deepEqual(
    readings(parallel),
    { validatePlan: 0, classify: 0, scopeHeld: 0 },
    '④真并行 + merge：两个静态面都不出 issue（ADR-025）；它的可见性读数在下面 `named` 那条',
  )
  assert.deepEqual(
    readings(parallelWindow),
    { validatePlan: 1, classify: 2, scopeHeld: 0 },
    "④'真并行 + 独占窗口：validatePlan / classify **必须**继续报冲突（不许借改口径放宽判据）",
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
  // 三种有序形状在**派发面**也不许出现"相交"（显式声明过先后不是争用）
  assert.deepEqual(named(heldStar), [], "scopeIntersections × '*'：不算意外相交")
  assert.deepEqual(named(heldChain), [], 'scopeIntersections × 传递依赖：不算意外相交')
  assert.deepEqual(named(heldDirect), [], 'scopeIntersections × 直接依赖：不算意外相交')

  // 反例（这一面也不许放宽）①：在飞持有者与就绪卡**真并行** ⇒ 派发面必须**点名**（照派但可见）
  const parallelHeld = [card('TASK-H', 'in-progress', ['src/h5/']), card('TASK-N', 'ready', ['src/h5/'])]
  assert.deepEqual(
    named(parallelHeld),
    [{ task: 'TASK-N', holder: 'TASK-H', kind: 'merge', overlap: ['src/h5'] }],
    'scopeHeld × 真并行：`merge` 照派，但**必须**在读数里点名两张卡与相交路径（可见即约束）',
  )
  assert.equal(scopeHeldTasks(parallelHeld).length, 0, '`merge` 不挡（挡住 = 过度保守，反向守卫会红）')
  // 反例（这一面也不许放宽）②：真并行 + 任一方声明**独占窗口** ⇒ 必须继续**挡**
  assert.equal(
    scopeHeldTasks([card('TASK-H', 'in-progress', ['src/h5/'], [], 'full-suite'), card('TASK-N', 'ready', ['src/h5/'])]).length,
    1,
    'scopeHeld × 真并行 + 独占窗口：必须继续报（否则等于把写锁静默拆了）',
  )
})

test('M160-02 反例：把写范围改成不相交 ⇒ 冲突消失（证明不是"全都不报"）', () => {
  // **`DEF-239`（`ADR-025`）**：这一格原来拿 `merge` 当"会报"的正例，那正例本身已经不成立
  // —— 现在正例落在**独占窗口**那一档，反例（不相交）仍然必须 0 条。
  const overlapping = [card('TASK-A', 'ready', ['src/p/'], [], 'full-suite'), card('TASK-B', 'ready', ['src/p/'])]
  const disjoint = [card('TASK-A', 'ready', ['src/p/'], [], 'full-suite'), card('TASK-B', 'ready', ['src/q/'])]
  assert.deepEqual(readings(overlapping), { validatePlan: 1, classify: 2, scopeHeld: 0 }, '前置：重叠 + 独占窗口时确实报')
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

test('M160-05 TC-127：**反事实模拟** —— 谓词改回旧式，三种有序形状各 1→0，对照组不动（证明修复承重）', () => {
  // 旧实现（修前逐字抄在三处的那一行）：只认**直接**的 `blockedBy` 相互引用。
  // 这里把它**内联**成反事实谓词 —— 不改 src，只证明"如果退回旧式，读数会怎么翻"。
  const oldConflicts = (tasks: TaskCard[]): number => {
    let count = 0
    for (let i = 0; i < tasks.length; i += 1) {
      for (let j = i + 1; j < tasks.length; j += 1) {
        const a = tasks[i] as TaskCard
        const b = tasks[j] as TaskCard
        if (!a.writeScopes.some((scope) => b.writeScopes.includes(scope))) continue
        if (a.blockedBy.includes(b.id) || b.blockedBy.includes(a.id)) continue
        count += 1
      }
    }
    return count
  }
  const shapes: { name: string; tasks: TaskCard[] }[] = [
    // ① `'*'`（排在所有其它卡之后）—— 旧谓词看不到 `'*'`
    { name: "'*' 排后标记", tasks: [card('TASK-A', 'ready', ['src/x/']), card('TASK-B', 'ready', ['src/x/'], ['*'])] },
    // ② 传递依赖 A→B→C —— 旧谓词只看一对直接边，A 与 C 之间没有边
    {
      name: '传递依赖',
      tasks: [
        card('TASK-A', 'ready', ['src/y/'], ['TASK-B']),
        card('TASK-B', 'ready', ['src/z/'], ['TASK-C']),
        card('TASK-C', 'ready', ['src/y/']),
      ],
    },
    // ③ 链尾的 `'*'`（C 排后，B 与 C 写范围重叠）—— 旧谓词同样看不到
    {
      name: "链尾 '*'",
      tasks: [
        card('TASK-A', 'ready', ['src/k/'], ['TASK-B']),
        card('TASK-B', 'ready', ['src/m/']),
        card('TASK-C', 'ready', ['src/m/'], ['*']),
      ],
    },
  ]

  for (const shape of shapes) {
    // 反事实：旧谓词下**每种形状各有 1 条假冲突**
    assert.equal(oldConflicts(shape.tasks), 1, `${shape.name}：旧谓词必须给出 1 条假冲突（否则这条反事实没咬住）`)
    // 现实：唯一出口 `orderedPair` 判为有序 ⇒ 三处判据都不报（1 → 0）
    const live = readings(shape.tasks)
    assert.deepEqual(live, { validatePlan: 0, classify: 0, scopeHeld: 0 }, `${shape.name}：现实现三处都必须 0 条`)
  }
  // 对照组：真并行（无任何依赖）—— 旧谓词报 1 条；现口径下 `merge` 两个静态面都不出 issue，
  // 所以"不许借反事实放宽"的读数落在**独占窗口**那一支：同一形状 + 一份独占窗口 ⇒ 必须重新报。
  const control = [card('TASK-A', 'ready', ['src/p/']), card('TASK-B', 'ready', ['src/p/'])]
  const controlWindow = [card('TASK-A', 'ready', ['src/p/'], [], 'full-suite'), card('TASK-B', 'ready', ['src/p/'])]

  for (const shape of shapes) {
    // 反事实：旧谓词下**每种形状各有 1 条假冲突**
    assert.equal(oldConflicts(shape.tasks), 1, `${shape.name}：旧谓词必须给出 1 条假冲突（否则这条反事实没咬住）`)
    // 现实：唯一出口 `orderedPair` 判为有序 ⇒ 三处判据都不报（1 → 0）
    const live = readings(shape.tasks)
    assert.deepEqual(live, { validatePlan: 0, classify: 0, scopeHeld: 0 }, `${shape.name}：现实现三处都必须 0 条`)
  }
  assert.equal(oldConflicts(control), 1, '对照组：旧谓词 1 条')
  // `DEF-239`：`merge` 档两个静态面都不出（这是新口径，不是放宽 —— 旧谓词在这里本来就报）
  assert.deepEqual(readings(control), { validatePlan: 0, classify: 0, scopeHeld: 0 }, '对照组 × merge：ADR-025 下不出 issue')
  // 承重读数：同一形状加一份独占窗口 ⇒ 新口径下**仍然**要报（validatePlan 1 / classify 双向 2）
  assert.deepEqual(
    readings(controlWindow),
    { validatePlan: 1, classify: 2, scopeHeld: 0 },
    '对照组 × 独占窗口：新口径下仍然要报（不许借反事实放宽）',
  )
})
