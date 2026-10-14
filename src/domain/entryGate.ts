/**
 * **当前阶段入口门禁的签字状态**（DEF-040 / §3E 族 6）—— 这一条判据的**唯一出口**。
 *
 * 为什么要单独一个模块：同一条判据有**两个消费面** ——
 *   · 派发面（`office.ts` 的三处调用点）：门禁失效时**一张卡都不派**；
 *   · 认领面（`collab.ts` 的 `claim`）：门禁失效时**拒绝认领**（拒绝码 `gate-stale`）。
 * 两处各写一遍必然漂移（一边按 `stale` 判、一边按 `!== 'valid'` 判，就会出现"派发说
 * 不许开工、卡却照领"）。与 `signatureState` / `scopeOverlaps` 同一条口径（ADR-009）：
 * **收敛到唯一出口**，其余地方一律调它。
 *
 * 口径（DEF-040 的权威语义，勿按批内旧句理解）：
 *   · 只判 `status === 'stale'`（**签过字**、但按 §7.2 的口径失效了）—— 真机 B-28 要拦的正是它
 *     （G3 签字 03:41 生效 → 之后首个真源变更 → 06:40–07:04 仍连派 4 张卡并在失效窗口内完成）；
 *   · **`missing` 必须放行**：从没签过 ≠ 失效。把它也当"不许开工"会让**所有还没走到该门禁签字的
 *     正常流程**一律停摆（那不是修缺陷，是停摆）；
 *   · 门禁 id 取自**流程数据** `src/data/processes/*.yml` 的 `phases[].entry`，**不得硬编码 `G3`**
 *     —— 流程无关是长期约束，且各流程各阶段的入口本就不同：`waterfall` 的 `construction` 是 `G4`、
 *     `design-plan` 是 `G3`；`prototype` 的 `requirements` 是 `GP`（`G3` 在那里根本不是入口）。
 */
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { SdoProject } from '../types.js'
import type { StaleGate } from './plan.js'
import { entryGates, loadProcess } from './process.js'
import { signatureState } from './signature.js'

/**
 * 当前阶段的入口门禁**失效**时返回 `{ gate, reason }`，否则 `undefined`。
 *
 * `gate` = 该阶段的 `entry[0]`（一个阶段可能有多个入口门禁，**取第一个**：它与
 * `exitGates` / `pendingGate` 的"逐条按流程数据取"同口径，且真机 B-28 的剧本正是单入口）。
 * `reason` 直接透传 `SignatureState.reason`（已可人读，**不重算**、不自己比时间戳）。
 */
export function staleEntryGateOf(
  store: SdoStore,
  journal: Journal,
  project: SdoProject | undefined,
): StaleGate | undefined {
  if (project === undefined) return undefined
  // 流程数据缺失时回落 `waterfall`（与 `processOfProject` 同口径）—— 随包数据不该缺。
  const process = loadProcess(project.process) ?? loadProcess('waterfall')
  if (process === undefined) return undefined
  const gate = entryGates(process, project.phase)[0]
  if (gate === undefined) return undefined
  const state = signatureState(store, journal, gate)
  return state.status === 'stale' ? { gate, reason: state.reason } : undefined
}
