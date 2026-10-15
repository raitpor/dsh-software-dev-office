/**
 * **「未冻结完成 ⇒ 交付前必须有一次全量绿」**（DEF-033 第三面 / 第四批 §3.5）—— 判据的**唯一出口**。
 *
 * 背景：`DEF-033` 把 `done` 的语义落成"**本卡范围**绿"（兄弟卡在飞时可以局部收工）；`unfrozen` 让这件事
 * **留痕**（逐条点名哪些在飞卡的工作没并进来）。第三批的**门禁面**缺口是：`grep -rn unfrozen src/domain/gates.ts`
 * **无命中** ⇒「卡 done ≠ 全局冻结」在回执上可见、在门禁上**不存在** —— 交付/验证门禁不会因"有一批卡
 * 声明了未冻结"说一句话。
 *
 * 用户裁决（`ADR-015`）：判据＝「**有 `unfrozen` 非空的卡 ⇒ 交付前必须有一次全量绿**」，挂 **G7 交付门禁**
 * （按"交付前"的字面期限；**不在 G6 重复声明** —— 同一概念两处判据是 `DEF-044` 的教训）。
 *
 * 口径（全部机械可核）：
 *   · **要求成立**：台账里存在 `unfrozen` 非空的卡（= 某次完成是**局部**的）；
 *   · **依据**：一条 `status === 'pass'` 且**声明了自己覆盖全量**（`TestResult.fullSuite === true`）的测试结论，
 *     其 `at` **晚于**这些"未冻结完成"里**最后一次** `done` 的时刻 —— 早于它的全量绿不作数（那之后的局部改动
 *     没有被任何全量跑覆盖过）；
 *   · **"全量"由项目/调用方声明，插件不硬编码任何跑法**：插件不认识 `npm test` 也不认识某个路径，
 *     只认"这条结论自称覆盖全量"这个**结构化声明**（口径与 `env`/`harness` 一致：声明是调用方的事，
 *     核对自洽是插件的事）；
 *   · **必须存在能满足它的动作**（反例要求）：跑一次全量、记一条 `status=pass` + `fullSuite=true` 的结论即可转绿。
 *
 * 没有 `unfrozen` 非空的卡 ⇒ 这条要求**不适用**（判 N/A，不是判红也不是判绿）。
 */

import { listTestResults } from './records.js'
import { listTasks } from './plan.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'

/** 一条"未冻结完成"的卡：谁把「未冻结」引出来的（判红时要逐条点名）。 */
export interface UnfrozenCard {
  id: string
  /** 这次"未冻结完成"的 `done` 时刻（ISO；从 `task/done` 事件取，取不到退回卡的 `updatedAt`）。 */
  doneAt: string
}

export interface UnfrozenFullGreenState {
  /** `unfrozen` 非空的卡（按 id 序）。空数组 ⇒ 本条不适用。 */
  cards: UnfrozenCard[]
  /** 这些卡里**最后一次** `done` 的时刻（ISO；全都取不到时为空串）。 */
  lastDoneAt: string
  /** 满足要求的那条**全量 pass 结论**的 id（不满足则 undefined）。 */
  satisfiedBy?: string | undefined
}

/**
 * 读出这条要求的现状（**唯一出口**：判据、回执、测试都读它，不各写一份）。
 *
 * 时间口径：`task/done` 的 `at` 是**真源事件**里的时刻（`tests/results/*.yml` 与 `tasks/*.yml` 都可手改，
 * 只有 append-only 的 journal 挡得住事后改时刻）。事件缺失时退回卡的 `updatedAt`（老台账/手工建的卡），
 * 再取不到就按"未知"处理（**不因此判红**：拿不到时刻时只要求"存在一次全量绿"，不锁死）。
 */
export function unfrozenFullGreenState(store: SdoStore, journal: Journal): UnfrozenFullGreenState {
  const declared = listTasks(store).filter((task) => (task.unfrozen ?? []).length > 0)
  if (declared.length === 0) return { cards: [], lastDoneAt: '' }
  const doneAtById = new Map<string, string>()
  for (const event of journal.read().events) {
    if (event.type !== 'task/done') continue
    const id = typeof event.data['id'] === 'string' ? event.data['id'] : ''
    if (id === '') continue
    const at = typeof event.at === 'string' ? event.at : ''
    if (at === '') continue
    const previous = doneAtById.get(id)
    if (previous === undefined || at > previous) doneAtById.set(id, at)
  }
  const cards: UnfrozenCard[] = declared
    .map((task) => ({ id: task.id, doneAt: doneAtById.get(task.id) ?? task.updatedAt ?? '' }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const lastDoneAt = cards.map((card) => card.doneAt).filter((at) => at !== '').sort().at(-1) ?? ''
  // **依据**：自称覆盖全量的 pass 结论里，**最新**的那条；它必须晚于最后一次未冻结完成。
  const fullGreen = listTestResults(store)
    .filter((result) => result.status === 'pass' && result.fullSuite === true)
    .map((result) => ({ id: result.id, at: result.at }))
    .sort((a, b) => a.at.localeCompare(b.at))
  const latest = fullGreen.at(-1)
  const satisfiedBy = latest !== undefined && (lastDoneAt === '' || latest.at > lastDoneAt) ? latest.id : undefined
  return { cards, lastDoneAt, ...(satisfiedBy === undefined ? {} : { satisfiedBy }) }
}
