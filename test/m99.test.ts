/**
 * M99：**挑卡排序按规模显式秩**（TASK-071 / DEF-008 / REQ-024）。
 *
 * ## 病根（DEF-008，用户 2026-10-13 裁定「属实则改」）
 * `plan.ts` 的 `readyTasks` 注释写着「按规模小→大」，实现却是 `a.size.localeCompare(b.size)` ——
 * **字母序**的真实次序是 `'large' < 'medium' < 'small'`（l < m < s）⇒ **与注释相反**：
 * `large` 先派、`small` 垫底。真机症状是本插件自己的调度意图失效：评审卡是 `small`，
 * 排在 4 张 `medium` 之后，`limit=4` 时**根本取不到** ⇒ 评审被系统性推迟，"小步快跑"落空。
 *
 * ## 修法（落点一）
 * 显式秩表 `trivial`=0 / `small`=1 / `medium`=2 / `large`=3（**不依赖字符串序**），
 * id 升序作次级键；未知 / 缺失规模**排最后**（理由：判据是"小步快跑"——把认不出的档位
 * 塞进队首正好是 DEF-008 的病灶重演；排最后是"未知"最保守的落位）。
 *
 * ## 本文件的四条断言面（卡上落点二的 ①②③④）
 *   ① **DEF-008 的可观察形式**：同批 `1 small + 3 medium + 1 large`，`readyTasks(tasks, 4)`
 *      必须取到 `small`、取不到 `large`（只断言 `length === 4` 是空转：字母序也满足它）。
 *   ② 四档**全序**：trivial < small < medium < large 逐对比较（逐对，不靠"整体 deepEqual 恰好对"）。
 *   ③ 同规模时按 **id 升序**。
 *   ④ `blockedBy` 语义**不变**：未满足 ⇒ 不 ready；`['*']` ⇒ 等到其它卡全完成才 ready（SDO-30b）。
 *
 * 红绿自证在**盘外夹具**（`node_modules/.sdo-test/m99-mutation/`）：把排序回滚成
 * `localeCompare` 的编译产物留档一份，本文件的 ① 即对着它转红（逐条 killed）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readyTasks } from '../src/domain/plan.js'
import type { TaskCard } from '../src/types.js'

/** 最小可用卡：只钉排序关心的字段，其余给合法缺省（`status: 'ready'` 即"可派"）。 */
function card(id: string, size: TaskCard['size'], overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes: [`src/${id}/`],
    role: 'developer',
    size,
    revision: 1,
    status: 'ready',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

const ids = (tasks: TaskCard[], limit = 4): string[] => readyTasks(tasks, limit).map((task) => task.id)

test('M99-01 DEF-008 真机症状：1 small + 3 medium + 1 large，limit=4 必须取到 small、取不到 large', () => {
  // 真实症状的排布：评审卡是 small，同一批里还有 3 张 medium（先派）+ 1 张 large。
  // 字母序（'large' < 'medium' < 'small'）下前 4 张恰好是 large + 3 medium ⇒ small 被切掉。
  const small = card('TASK-205', 'small', { role: 'reviewer', title: '评审卡（small）' })
  const mediums = ['TASK-201', 'TASK-202', 'TASK-203'].map((id) => card(id, 'medium'))
  const large = card('TASK-204', 'large')
  const batch = [large, small, ...mediums] // 故意把 large / small 放在数组前头：排序必须与输入顺序无关

  const picked = ids(batch, 4)
  // ①-a **本缺陷的可观察形式**（卡上落点二①的原话）：small 必须在、large 必须不在 —— 这两条单独成立
  assert.ok(picked.includes('TASK-205'), `DEF-008：small 评审卡在 limit=4 时被挤掉了 ⇒ 取到的是 ${picked.join(' ')}`)
  assert.ok(!picked.includes('TASK-204'), `DEF-008：large 不该先派 ⇒ 取到的是 ${picked.join(' ')}`)
  // ①-b 把整批顺序逐字钉死：small 排在最前（规模秩），三条 medium 随后按 id 升序
  assert.deepEqual(picked, ['TASK-205', 'TASK-201', 'TASK-202', 'TASK-203'])
})

test('M99-02 四档全序：trivial < small < medium < large（逐对比较）', () => {
  // 逐对比较的检验方式：同批放**参考卡**（`TASK-420`，small）与**对照卡**（`TASK-421`，档位由参数给），
  // 且输入顺序**刻意与字母序相反** —— 于是"对照卡是否在参考卡之后"只可能由规模秩决定
  // （同档时退化为 id 升序：TASK-421 > TASK-420 ⇒ 仍在后；故探针先自证它分辨得出"更小"）。
  // `trivial` 不是 `TaskSize` 的成员（`TaskSize = small|medium|large`），但卡上落点一要求它的秩 = 0：
  // 按"运行期真值"钉住它（口径与 03 的未知档位同一手法：类型面 + 运行期面各如实一件）。
  const after = (size: string | undefined): boolean => {
    const reference = card('TASK-420', 'small')
    const other = card('TASK-421', size as unknown as TaskCard['size'])
    return ids([reference, other], 2).indexOf('TASK-421') === 1
  }
  // 探针对照（否则下面全是空转）：small 对 small 是同档 ⇒ 由 id 升序决定 ⇒ 对照卡在后
  assert.ok(after('small'), '探针对照：同档时由 id 升序决定（TASK-421 > TASK-420）')
  // 逐对：trivial < small < medium < large（对照卡与参考卡 small 比，谁在后）
  assert.ok(!after('trivial'), '逐对：trivial 必须排在 small 之前')
  assert.ok(after('medium'), '逐对：small 必须排在 medium 之前')
  assert.ok(after('large'), '逐对：small 必须排在 large 之前')
  // 再补一对不经过参考卡的：medium 必须在 large 之前（对照卡 large 与参考 medium 比）
  assert.ok(
    ids([card('TASK-430', 'medium'), card('TASK-431', 'large')], 2).indexOf('TASK-431') === 1,
    '逐对：medium 必须排在 large 之前',
  )
  // 逐对比完之后再钉一次整批次序（四档同批；id 故意与字母序同向，让"字母序"必然给出另一种次序）
  const all = [
    card('TASK-504', 'large'),
    card('TASK-503', 'medium'),
    card('TASK-502', 'small'),
    card('TASK-501', 'trivial' as unknown as TaskCard['size']),
  ]
  assert.deepEqual(ids(all, 4), ['TASK-501', 'TASK-502', 'TASK-503', 'TASK-504'])
})

test('M99-03 未知 / 缺失规模排最后，不许插队到 small 之前（兜底口径）', () => {
  // 认不出的档位（既不是 small 也不是 medium）走兜底：排最后。
  const unknown = card('TASK-601', 'huge' as unknown as TaskCard['size'])
  const batch = [unknown, card('TASK-603', 'medium'), card('TASK-602', 'small')]
  assert.deepEqual(
    ids(batch, 3),
    ['TASK-602', 'TASK-603', 'TASK-601'],
    '未知规模必须排最后：塞进队首正是 DEF-008 的病灶（unknown 不许插队到 small 之前）',
  )
  // 缺失（undefined）：同样不许插队到 small 之前
  const missing = { ...card('TASK-604', 'small'), size: undefined } as unknown as TaskCard
  assert.deepEqual(
    ids([missing, card('TASK-605', 'small')], 2),
    ['TASK-605', 'TASK-604'],
    '缺失规模也走兜底排最后；同批的两张 small 里它是"未知"那张',
  )
})

test('M99-04 同规模按 id 升序（次级键没被规模秩挤掉）', () => {
  const same = [card('TASK-703', 'small'), card('TASK-701', 'small'), card('TASK-702', 'small')]
  assert.deepEqual(ids(same, 3), ['TASK-701', 'TASK-702', 'TASK-703'])
  // 跨档 + 同档混排：先看档，再看 id
  const mixed = [card('TASK-712', 'medium'), card('TASK-711', 'medium'), card('TASK-701', 'small')]
  assert.deepEqual(ids(mixed, 3), ['TASK-701', 'TASK-711', 'TASK-712'])
})

test('M99-05 blockedBy 语义不变：未满足不 ready；`[\'*\']` 等到其它卡全完成（SDO-30b）', () => {
  // ① 直接依赖没做完 ⇒ 不 ready（哪怕它是 small，也不许提前派）
  const waitingSmall = card('TASK-801', 'small', { blockedBy: ['TASK-899'] })
  const dep = card('TASK-899', 'large')
  assert.deepEqual(ids([waitingSmall, dep], 4), ['TASK-899'], '依赖未满足的卡不许 ready（SDO-30b 之前的既有语义）')
  assert.deepEqual(ids([waitingSmall, { ...dep, status: 'done' }], 4), ['TASK-801'], '依赖满足后按规模秩正常参与')

  // ② `['*']` = "排在所有其它卡之后"：别的卡没做完 ⇒ 它压根不 ready
  const finale = card('TASK-802', 'small', { blockedBy: ['*'] })
  const writer = card('TASK-803', 'medium')
  assert.deepEqual(
    ids([finale, writer], 4),
    ['TASK-803'],
    '`[\'*\']` 的卡在所有其它卡完成前不许派（既有行为）',
  )
  assert.deepEqual(
    ids([finale, { ...writer, status: 'done' }], 4),
    ['TASK-802'],
    '其它卡全部完成后，`[\'*\']` 的卡才 ready（既有行为）',
  )

  // ③ 已经满足的直接依赖不改变规模秩（id 升序 / 小→大都照旧）
  const satisfied = card('TASK-806', 'small', { blockedBy: ['TASK-805'] })
  const finished = card('TASK-805', 'medium', { status: 'done' })
  const another = card('TASK-804', 'medium')
  assert.deepEqual(ids([satisfied, another, finished], 4), ['TASK-806', 'TASK-804'], '依赖已满足时按规模秩（small 在前）')
})

test('M99-06 非 ready 状态与 limit 仍按原口径（本卡不动这两处）', () => {
  const done = card('TASK-901', 'small', { status: 'done' })
  const verified = card('TASK-902', 'small', { status: 'verified' })
  const dropped = card('TASK-903', 'small', { status: 'dropped' })
  const planned = card('TASK-904', 'medium', { status: 'planned' })
  assert.deepEqual(ids([done, verified, dropped, planned], 4), ['TASK-904'])
  assert.equal(ids([card('TASK-905', 'small'), card('TASK-906', 'medium')], 1).length, 1, 'limit 仍生效')
})
