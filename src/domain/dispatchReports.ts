/**
 * **派发汇报**（子 agent 取汇报：① 状态可见 ② 结算与报告落盘 ③ 摘要回注驾驶舱）。
 *
 * 背景（真机发现）：插件用宿主 `subagents.start` 派发是 **fire-and-forget** —— 只记 `dispatch/started`，
 * 子代理的收尾报告只写在**它自己的会话**里（宿主不会投递给父会话，只有模型侧 `subagent` 工具才有回调）。
 * 于是"卡在台账里 done 了、但没人看到报告"。
 *
 * 探测结论（2026-10-04，真机 + 事件形状实测）：
 *   · 插件**确实能收到子会话的 `session/event`**（`request/header`/`tool/call` 已被观测台账证实）；
 *   · 子会话**没有** `session/end`，结算信号是 **`turn/end`**（`{turn, reason:{kind:'completed'}}`）；
 *   · `assistant/message` 事件**带全文**（`message.content[].text`），所以"最后一条助手消息"可拿。
 *
 * 本模块只做落盘与展示；事件订阅在 `src/index.ts` 的 `session/event` 监听器里（与 A2 采集同一个入口）。
 */
import { existsSync } from 'node:fs'

import type { SdoStore } from '../infra/store.js'

export const CHILD_REPORT_DIR = 'evidence'
export const CHILD_REPORT_SUBDIR = 'child-reports'

/**
 * 报告"异常短"的下限（**SDO-58**）：真机上出现过 **235 字节**的残片报告（同批其他轮次 KB 级），
 * 而报告是审计链的一环 —— 低于这个量级就显式告警（不是拦下结算，而是不让人事后才发现）。
 */
export const CHILD_REPORT_MIN_BYTES = 400

export interface DispatchFinished {
  childSessionId: string
  task: string
  role: string
  turn: number
  /** `turn/end` 的 reason.kind（`completed` / `error` / …）。 */
  reason: string
  startedAt: string
  finishedAt: string
  durationMs: number
  /** 报告落点（相对 `.sdo/` 的路径）。 */
  report: string
  /**
   * **这笔结算的身份**（`dispatch/finished` 事件自身的 journal `seq`）。
   *
   * 为什么不能只用 `(childSessionId, report)` 当身份（第二轮整体评审 §2.3）：同一子会话为**同一张卡**
   * 可以结算多次（多轮子代理、或复用同一会话再跑一轮），这时 `task` 与报告落点**逐字相同** ——
   * 用键去重会把第二笔当成第一笔的重复 ⇒ 送达登记一标，后面的结算永远不再推送。
   */
  seq: number
}

function safePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/gu, '_')
  return safe === '' ? 'unknown' : safe
}

/**
 * 报告文件名：**按卡切**（`<task>-<childSessionId 前 8 位>.md`）。
 *
 * 为什么不只按 `childSessionId`（评审 N2，前瞻）：方案 3 是"同角色常驻、一个子代理服务多张卡"，
 * 那时同一个子会话会产生**多次结算**，只按 child 命名会让报告被逐卡覆盖（丢正文）。
 * 用「卡 + 子会话」两段：复用不覆盖、同一张卡重派到新子会话也不覆盖。
 * 卡 id 取不到时退回只按子会话。
 */
export function reportFileName(childSessionId: string, task = ''): string {
  const child = safePart(childSessionId).slice(0, 8)
  return task.trim() === '' ? `${child}.md` : `${safePart(task)}-${child}.md`
}

export function childReportPath(childSessionId: string, task = ''): string[] {
  return [CHILD_REPORT_DIR, CHILD_REPORT_SUBDIR, reportFileName(childSessionId, task)]
}

/** 写子代理报告（内容 = 它最后一条助手消息的全文；调用方负责给"这是最后一条"）。返回**相对 `.sdo/` 的落点**。 */
export function writeChildReport(store: SdoStore, childSessionId: string, text: string, task = ''): string {
  store.writeText(childReportPath(childSessionId, task), text.trimEnd() + '\n')
  return `${CHILD_REPORT_DIR}/${CHILD_REPORT_SUBDIR}/${reportFileName(childSessionId, task)}`
}

/** 按**记录的落点**读回报告（`dispatch/finished.report` 就是权威路径，读者不要自己拼文件名）。 */
export function readChildReportAt(store: SdoStore, report: string): string | undefined {
  if (report.trim() === '') return undefined
  const segments = report.split('/').filter((part) => part !== '' && part !== '.')
  if (segments.length === 0 || segments.includes('..')) return undefined
  if (!existsSync(store.path(...segments))) return undefined
  return store.readText(...segments) ?? undefined
}

/** 报告摘要（③ 的"回注"用：状态块/回执里给一段，模型不必自己去翻文件）。 */
export function excerpt(text: string, maxChars = 600): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…（完整报告见报告落点）`
}
