/**
 * **签字审核单夹具**：先把某门禁的审核单生成出来（走**真实**的 `office.signReview` 路径，
 * 顺带把 `.sdo/evidence/sign-reviews/<门禁>.{md,json}` 按生产口径落盘）。
 *
 * 为什么需要它（2026-10-12 起）：`channel=statement` 签字要求"该门禁**已有一份新鲜**的审核单"
 * —— 无审核单 ⇒ 拒签（不许盲签）；真源在生成之后变过 ⇒ 拒签（审核单已失效）。
 * 想把用例聚焦在**签字本身**（复读判定、原话核对、回执内容）的，必须先过这一关。
 *
 * 注意：夹具调的是生产函数，所以"夹具能生成"本身就证明了生成路径可用；
 * 它**不**替用例断言审核单内容（那是 `test/m90` 的事）。
 */
import { Config } from '../../src/config.js'
import { resolveSettings } from '../../src/config.js'
import { SoftwareDevOffice } from '../../src/office.js'
import type { SdoConfig } from '../../src/config.js'

/** 用**独立实例**给某工作区的某门禁生成一份审核单（实例无状态，只读该工作区的台账）。 */
export function seedSignReview(workspace: string, gate: string): void {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.signReview({ sessionId: 's1', cwd: workspace }, gate)
}
