/**
 * **增量 268：计划判据回到 `ADR-025` 口径（`DEF-239` / `TASK-268`）—— 双态守卫。**
 *
 * 被钉的那条口径（`ADR-025`，已随 G3 签字）：两张卡的写范围相交**默认 `merge`**（照派、各写各的
 * 副本、完成时三路合并）；只有两档**真需要串行** ——
 *   · `exclusive-window`：任一方 `exclusive` 非空（典型是跑全量测试，两边同跑会互删夹具）；
 *   · `unknown-scope`：任一方写范围**缺失/为空** ⇒ 判不了 ⇒ fail-closed 按整仓处理。
 *
 * 修前的病灶：判据 `write-scope-disjoint` 仍按旧语义把**一切**相交报成冲突
 * （现盘读数：未终结 23 张卡里 79 条 issue、C-31 的字面读数 7335 字符，**全部**是 `merge` 档）。
 * 于是"守据比机制严"：`src/domain/plan.ts` 自己的注释就写着**反向守卫** ——
 * 「把 `merge` 的卡拦住不派同样是错的」。本文件两个方向都钉：
 *   ① `merge` **不得**出 issue（反向格：拦住它是错的）；
 *   ② `exclusive-window` / `unknown-scope` **必须**出，且 `unknown-scope` 的文案**不许拼路径**。
 *
 * **两处判据同口径是行为读数，不是"两段长得像的代码"**：`validatePlan` 与 `classifyNonDispatchable`
 * 的 scope 维必须逐档同结论（`M268-05`），并且两处的调用点是**同一个函数** `scopeSerialKindOf`
 * （`M268-06` 按**文本**锚定，不按行号 —— `DEF-233` 已三次逼实现去迁就布局）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  classifyNonDispatchable, scopeHeldTasks, scopeIntersections, scopeSerialKindOf, validatePlan,
} from '../src/domain/plan.js'
import { fmt } from '../src/domain/i18n.js'
import { scopeOverlaps } from '../src/domain/scopePaths.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 一张最小卡（字段齐、其余留默认）—— 与 `test/m160.test.ts` 的夹具同形，便于两处读数对读。 */
function card(
  id: string,
  status: TaskCard['status'],
  writeScopes: string[],
  blockedBy: string[] = [],
  exclusive?: string,
): TaskCard {
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
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
  } as unknown as TaskCard
}

/** 判据一的读数：`validatePlan` 里那一条判据。 */
function disjoint(tasks: TaskCard[]): { taskId: string; detail: string; remedy: string }[] {
  return validatePlan(tasks).filter((issue) => String(issue.code) === 'write-scope-disjoint')
}

/** 判据二的读数：`classifyNonDispatchable` 的 scope 维。 */
function nonDispatchableScope(tasks: TaskCard[]): ReturnType<typeof classifyNonDispatchable>['scope'] {
  return classifyNonDispatchable(tasks).scope
}

// ————————————————————————— ① 反向守卫：`merge` 不得出 issue —————————————————————————

test('M268-01 两卡只在普通文件（src/a.ts）上相交 ⇒ 不得出 write-scope-disjoint（拦住 merge 同样是错的）', () => {
  const tasks = [card('TASK-A', 'ready', ['src/a.ts']), card('TASK-B', 'planned', ['src/a.ts'])]
  // 前提读数：这两支都**不是**"真需要串行"的那两档 —— 不先钉住这个，下面那条 0 就证明不了任何事
  assert.equal(scopeSerialKindOf(tasks[0] as TaskCard, tasks[1] as TaskCard), 'merge', '前提：写范围都非空、都没声明独占窗口 ⇒ 默认 merge')
  assert.deepEqual(scopeOverlaps(['src/a.ts'], ['src/a.ts']), ['src/a.ts'], '前提读数：交集**非空**（不是"恰好不相交"混过去的）')

  assert.deepEqual(disjoint(tasks), [], '相交属 merge ⇒ 判据一**不出** issue（修前这里是 1 条）')
  // 判据二同一档：修前它把这一对推到 `scope` 维（2 行），现在不许再当"挡住"
  assert.deepEqual(nonDispatchableScope(tasks), [], '相交属 merge ⇒ 判据二也不许把它列成"不可派"（修前 2 行）')
})

test('M268-02 merge **不出** issue，但派发回执里仍须**看得见**（可见即约束；不是"约束不存在"）', () => {
  const tasks = [card('TASK-H', 'in-progress', ['src/a.ts']), card('TASK-N', 'ready', ['src/a.ts'])]
  const named = scopeIntersections(tasks)
  assert.equal(named.length, 1, '两卡写范围相交 ⇒ 派发面**必须**点名一行（不点名就是退化成"谁也不知道有相交"）')
  assert.equal(named[0]?.kind, 'merge', '点名的那一行 kind 是 merge —— 可见，但不拦')
  assert.deepEqual(named[0]?.overlap, ['src/a.ts'], '要点名**具体路径**，不是只说"有相交"')
  assert.deepEqual(scopeHeldTasks(tasks), [], 'merge 档**不挡**派发（这是本卡的反向守卫：拦住它是错的）')
})

// ————————————————————— ② 独占窗口：必须出，且点名相交的路径 —————————————————————

test('M268-03 任一方 `exclusive` 非空 ⇒ 必须出 write-scope-disjoint 并点名路径；去掉声明就转绿', () => {
  const withWindow = [
    card('TASK-A', 'ready', ['src/a.ts'], [], 'full-suite'),
    card('TASK-B', 'planned', ['src/a.ts']),
  ]
  assert.equal(scopeSerialKindOf(withWindow[0] as TaskCard, withWindow[1] as TaskCard), 'exclusive-window', '前提：任一方声明独占窗口')
  const issues = disjoint(withWindow)
  assert.equal(issues.length, 1, '独占窗口档**必须**出 issue（修前的错不是"报了"，而是"什么都报"）')
  assert.equal(issues[0]?.taskId, 'TASK-A', 'issue 点名的是出问题的那张卡')
  assert.match(issues[0]?.detail ?? '', /TASK-A/u, '点名这一张')
  assert.match(issues[0]?.detail ?? '', /TASK-B/u, '点名相交的那一张')
  assert.match(issues[0]?.detail ?? '', /src\/a\.ts/u, '**必须点名相交的那条路径**（读者要知道争的是哪块地）')
  assert.match(issues[0]?.remedy ?? '', /action=release|drop|addWriteScopes/u, '要给可执行的解除动作')

  // 双态：同一对卡**去掉**独占窗口声明 ⇒ 立刻转绿（证明红是 `exclusive` 那一支给的，不是残留的旧语义）
  const without = [
    card('TASK-A', 'ready', ['src/a.ts']),
    card('TASK-B', 'planned', ['src/a.ts']),
  ]
  assert.deepEqual(disjoint(without), [], '撤掉 exclusive ⇒ 回到 merge ⇒ 转绿')

  // 派发面同口径：独占窗口**才挡**，且挡路的那张卡与路径都点得出来
  const held = scopeHeldTasks([card('TASK-H', 'in-progress', ['src/a.ts'], [], 'full-suite'), card('TASK-N', 'ready', ['src/a.ts'])])
  assert.equal(held.length, 1, '独占窗口 ⇒ 派发面**一定要挡住**（同跑会互删夹具）')
  assert.equal(held[0]?.kind, 'exclusive-window')
})

// ————————————————— ③ 无法判定（反例格）：不许被"空集不相交"吃掉 —————————————————

test('M268-04 一方写范围为空 ⇒ unknown-scope 必须出；且文案里**不许出现任何路径**（拼了就是编造）', () => {
  const tasks = [card('TASK-A', 'ready', []), card('TASK-B', 'planned', ['src/a.ts'])]
  assert.equal(scopeSerialKindOf(tasks[0] as TaskCard, tasks[1] as TaskCard), 'unknown-scope', '前提：一方写范围为**空** ⇒ 无法判定')
  // **反例格的前提读数**：旧口径只拿 `scopeOverlaps` 判，而"空集 × 有范围"恒为空集 ⇒ 这一档被**静默吃掉**。
  // 没有这条读数，下面那条 1 就可能只是"旧实现碰巧也报"。
  assert.deepEqual(scopeOverlaps([], ['src/a.ts']), [], '前提读数：空范围 × 有范围 = 空集（正是会被当成"不相交"的那一档）')

  const issues = disjoint(tasks)
  assert.equal(issues.length, 1, 'unknown-scope **必须**出 issue（fail-closed）：不许被"空集不相交"吃掉')
  // 断言与**文案键**逐字对齐（`uiPlan.t15UnknownScope`，按当前语言渲染），不拿中文片段去 `match` ——
  // 判据读的是**结构**（哪个键、哪些占位符），换个措辞不该让守卫红。
  assert.equal(
    issues[0]?.detail,
    fmt('uiPlan.t15UnknownScope', { p1: 'TASK-A', p2: 'TASK-B' }),
    '文案必须就是那一支的键与占位符（p1/p2 = 两张卡；此档**没有** p3 = 路径）',
  )
  assert.doesNotMatch(
    issues[0]?.detail ?? '',
    /\bsrc\/[\w./-]+/u,
    '这一档没有路径可比 ⇒ 文案里**不许**出现路径（`scopeOverlaps` 此档给空数组，拼路径就是编造）',
  )

  // 双态：把写范围补上 ⇒ 变成 merge ⇒ 转绿（证明那条红是"无法判定"给的，不是"空范围"本身给的）
  assert.deepEqual(disjoint([card('TASK-A', 'ready', ['src/a.ts']), card('TASK-B', 'planned', ['src/a.ts'])]), [], '补上写范围 ⇒ merge ⇒ 转绿')

  // 判据二同一档：它也得看得见（修前这一面把它整个排除在外：`writeScopes.length !== 1` 连 0 一起跳过）
  const rows = nonDispatchableScope(tasks)
  assert.equal(rows.length > 0, true, '判据二**也要**把 unknown-scope 列出来，否则两面不同口径')
  assert.deepEqual(rows.map((row) => row.kind), rows.map(() => 'unknown-scope'), '行上的 kind 一律是 unknown-scope')
  assert.deepEqual(rows.map((row) => row.overlap), rows.map(() => []), '这一档的 overlap 是空数组（不是"补出来的路径"）')
})

// ————————————————————— ④ 既有依赖序判定不回归（`'*'` 与传递依赖） —————————————————————

test("M268-05 依赖序（`'*'` / 传递 / 直接）仍不算冲突；**连独占窗口档**也照样不算（并行是安全的才谈窗口）", () => {
  const shapes: { name: string; tasks: TaskCard[] }[] = [
    {
      name: "①'*'（B 排在所有其它卡之后）",
      tasks: [card('TASK-B', 'ready', ['src/x.ts'], ['*'], 'full-suite'), card('TASK-A', 'planned', ['src/x.ts'])],
    },
    {
      name: '②传递依赖（A→B→C，A 与 C 范围重叠）',
      tasks: [
        card('TASK-A', 'ready', ['src/y.ts'], ['TASK-B']),
        card('TASK-B', 'ready', ['src/z.ts'], ['TASK-C']),
        card('TASK-C', 'planned', ['src/y.ts']),
      ],
    },
    {
      name: '③直接依赖（A 依赖 B）',
      tasks: [card('TASK-A', 'ready', ['src/d.ts'], ['TASK-B'], 'full-suite'), card('TASK-B', 'planned', ['src/d.ts'])],
    },
  ]
  for (const shape of shapes) {
    assert.deepEqual(disjoint(shape.tasks), [], `${shape.name}：有依赖序 ⇒ 不可能并行 ⇒ 不得报冲突（也不得因为独占窗口而报）`)
  }
  // 判别力：同形状**去掉依赖序**立刻该红（否则上面三条 0 可能是"判据根本没跑"）
  const parallel = [card('TASK-A', 'ready', ['src/x.ts'], [], 'full-suite'), card('TASK-B', 'planned', ['src/x.ts'])]
  assert.equal(disjoint(parallel).length, 1, '无依赖 + 独占窗口 ⇒ 必须报（对照组，证明三条 0 有判别力）')
})

// ————————————————————— ⑤ 两处判据同口径（逐档同结论，不是"两段长得像"） —————————————————————

test('M268-06 两面逐档同结论：`merge` 两面都 0；`exclusive-window` / `unknown-scope` 两面都看见且 kind 一致', () => {
  const shapes: { name: string; tasks: TaskCard[]; expected: string; planCount: number }[] = [
    {
      name: 'merge',
      tasks: [card('TASK-A', 'ready', ['src/a.ts']), card('TASK-B', 'planned', ['src/a.ts'])],
      expected: 'merge',
      planCount: 0,
    },
    {
      name: 'exclusive-window',
      tasks: [card('TASK-A', 'ready', ['src/a.ts'], [], 'full-suite'), card('TASK-B', 'planned', ['src/a.ts'])],
      expected: 'exclusive-window',
      planCount: 1,
    },
    {
      name: 'unknown-scope',
      tasks: [card('TASK-A', 'ready', []), card('TASK-B', 'planned', ['src/a.ts'])],
      expected: 'unknown-scope',
      planCount: 1,
    },
  ]
  for (const shape of shapes) {
    const [a, b] = shape.tasks as [TaskCard, TaskCard]
    // 唯一那支给出的结论就是本格的**期望值来源**，不是另写一份判定
    const kind = scopeSerialKindOf(a, b)
    assert.equal(kind, shape.expected, `${shape.name}：前提读数`)
    assert.equal(disjoint(shape.tasks).length, shape.planCount, `${shape.name}：判据一的读数`)

    const rows = nonDispatchableScope(shape.tasks)
    // 判据二把**两个方向**都列（A↔B 各一行），所以"看得见"= 行数 > 0；"看不见" = 恰好 0 行
    assert.equal(rows.length > 0, kind !== 'merge', `${shape.name}：判据二与判据一同结论（merge 档 0 行，其余档看得见）`)
    for (const row of rows) {
      const other = shape.tasks.find((task) => task.id === row.other) as TaskCard
      assert.equal(row.kind, scopeSerialKindOf(row.task, other), `${shape.name}：行上的 kind 就是同一支函数给的值（逐字相等）`)
      assert.notEqual(row.kind, 'merge', `${shape.name}：merge 永远不许进"不可派"这一维`)
    }
  }
})

test('M268-07 两处调的是**同一个函数**（文本锚定，不按行号）：`scopeSerialKindOf` 的三处调用点逐字可见', () => {
  const plan = readFileSync(join(ROOT, 'src', 'domain', 'plan.ts'), 'utf8')
  // 一处声明 + 三处调用（判据一 / 判据二 / 派发面）。用**文本**而不是行号：`DEF-233` 的教训是
  // 行号锚点会逼实现去迁就布局（`TASK-228` / `M191-01` / `TASK-261` 三次发作）。
  assert.equal(plan.split('export function scopeSerialKindOf(').length - 1, 1, '这一支只许有**一处**声明（别复制第二份判定）')
  for (const call of [
    'const kind = scopeSerialKindOf(a, b)',
    'const kind = scopeSerialKindOf(task, other)',
    'kind: scopeSerialKindOf(task, holder)',
  ]) {
    assert.equal(plan.split(call).length - 1, 1, `调用点必须逐字存在且只出现一次：${call}`)
  }
})
