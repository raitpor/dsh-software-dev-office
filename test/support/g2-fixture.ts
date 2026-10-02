/**
 * **G2 夹具的两条硬前置**（D1 / D4）——把"想验别的规则"的用例从这两条规则里解放出来。
 *
 * 为什么要单独抽一份：
 *   · **D1**：`baseline` 的放行依据从 `approvedBy` 字符串改成**签字台账**（带用户原话引用的
 *     G2 签字），于是每个"基线应当通过"的夹具都必须先真签一次；
 *   · **D4**：G2 的 C2 现在要求**每条未决 P1 都有风险处置**，而夹具里通常刻意留着
 *     `design:method`（P1，设计阶段才回答）不答 —— 不补风险处置，基线会被 C2 判红。
 *
 * 顺序**不可颠倒**：`risk/logged` 属于 G2 的失效事件集合，先签字再补风险会让刚签的字失效。
 */
import type { SoftwareDevOffice, OfficeCall } from '../../src/office.js'
import { isEffectivelyOpen } from '../../src/domain/dor.js'

/** D4：给每条未决 P1 登记一条 `origin` 指向该问题 id 的风险；返回被处置的问题 id。 */
export function disposeOpenP1(office: SoftwareDevOffice, call: OfficeCall): string[] {
  const open = office
    .questions(call)
    .filter((question) => isEffectivelyOpen(question) && question.severity === 'P1')
  const disposed: string[] = []
  for (const question of open) {
    office.logRisk(call, {
      title: `未决 P1 的风险处置：${question.id}`,
      level: 'medium',
      probability: 'medium',
      impact: question.consequenceIfUnasked,
      mitigation: '按计划的阶段回答该问题；回答前保持基线冻结',
      owner: '业务方',
      origin: question.id,
    })
    disposed.push(question.id)
  }
  return disposed
}

/** D1：记录一条带用户原话引用的 G2 签字（这是 C7 的唯一放行依据）。 */
export function signG2(office: SoftwareDevOffice, call: OfficeCall, basis = '我确认需求基线可以冻结'): void {
  office.signGate(call, { gate: 'G2', by: '张三', basis, channel: 'command' })
}

/** D4 + D1：补风险处置 → 签 G2 字。想在"基线应当通过"的夹具里一行搞定时用这个。 */
export function prepareG2(office: SoftwareDevOffice, call: OfficeCall): string[] {
  const disposed = disposeOpenP1(office, call)
  signG2(office, call)
  return disposed
}
