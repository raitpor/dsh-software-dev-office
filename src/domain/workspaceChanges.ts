/**
 * **workspace/changes 采集**（A2）：把宿主记录的"本会话改了哪些文件"落进 SDO 自己的台账，
 * 供 `sdo_task action=done` 做**写范围对账**（越界即判红）。
 *
 * 数据从哪来：宿主有 `session/event` 事件（post-commit 追加流）；其中 `workspace/changes` 事件
 * 带一个 `seq`，用 `workspaceChanges.summary(sessionId, seq)` 就能拿到该事件的**文件清单**。
 * SDO 在 `apply` 里监听该事件，只对**已经存在 `.sdo/` 的工作区**记账（不给无关会话造垃圾）。
 *
 * 为什么落成自己的台账而不是临时查：`claim` 时的基线 seq 与 `done` 时的清单要能对上，
 * 且证据条目本来就允许引用 `(sessionId, seq)`（见 `EvidenceItem` 的注释）。
 */
import { existsSync } from 'node:fs'

import type { SdoStore } from '../infra/store.js'

/** 台账位置（相对 `.sdo/`）。 */
export const WORKSPACE_CHANGES_SEGMENTS = ['evidence', 'workspace-changes.jsonl'] as const

export interface WorkspaceChangesEntry {
  sessionId: string
  /** 该 `workspace/changes` 事件的 seq（**宿主会话的**计数器；回调 `summary(sessionId, seq)` 要用它）。 */
  seq: number
  /**
   * 采集这一刻的 **SDO journal 序号**（同量纲于 `task/claimed` 的 seq）。
   *
   * **SDO-15（2026-10-05 真机，阻塞）**：宿主事件 seq 与 journal seq 是**两个不同计数器**
   * （真机实测：记录里 seq 是 883/994/1488/1838，而 journal 只有 444 条），拿 journal 的认领序号
   * 去比宿主 seq 恒为"更新" ⇒ 写范围对账退化成"整会话的改动都算本卡越界" ⇒ **任何卡都无法收工**。
   * 旧记录没有这个字段 ⇒ 对账时**不参与比较**，并如实退回「未对账」（不再拿它判越界）。
   */
  journalSeq?: number | undefined
  /** 宿主给的轮次（可缺失）。 */
  turn?: number | undefined
  /** 采集时间。 */
  at: string
  /** 该事件覆盖的变更文件（工作区相对路径）。 */
  files: string[]
  /** 补记时间（`done` 时才取到清单的那种记录；`undefined` = 采集当时就拿到了）。 */
  resolvedAt?: string | undefined
  /**
   * 宿主到底**给没给**这份摘要（`workspaceChanges.summary()` 是否可用）。
   *
   * 为什么必须记：采集监听里宿主服务是**可选**取用的 —— 没有该服务、或 `summary()` 返回 `undefined` 时，
   * 条目会是「有条目、无文件信息」。这种条目**不能**被当成"已对账"（评审 2026-10-03 的 A2 缺陷）。
   * 旧条目没有这个字段 ⇒ 视为 `false`（保守：未知就不算核对过）。
   */
  summaryAvailable?: boolean | undefined
}

export interface WorkspaceChangesSummaryLike {
  readonly turn?: number | undefined
  readonly files?: readonly { readonly path?: string | undefined; readonly display?: string | undefined }[] | undefined
}

/**
 * 采集一条（**纯决策 + 落盘**，便于用例覆盖"开关关掉就不采"这个方向）。
 *
 * @param enabled `captureWorkspaceChanges` 配置（false 时**什么都不写**）
 * @returns 落盘的条目；未采集时 `undefined`
 */
export function recordWorkspaceChanges(input: {
  store: SdoStore
  sessionId: string
  seq: number
  /** 采集这一刻的 journal 序号（对账同量纲的键；拿不到就不写，退回"未对账"） */
  journalSeq?: number | undefined
  summary: WorkspaceChangesSummaryLike | undefined
  enabled: boolean
  now?: string | undefined
  hasProject?: boolean | undefined
}): WorkspaceChangesEntry | undefined {
  if (!input.enabled) return undefined
  // 只记**已存在 `.sdo/`** 的工作区（调用方可用 hasProject 覆盖，便于用例注入）
  const hasProject = input.hasProject ?? existsSync(input.store.path())
  if (!hasProject) return undefined
  const files = (input.summary?.files ?? [])
    .map((file) => (typeof file.path === 'string' && file.path !== '' ? file.path : typeof file.display === 'string' ? file.display : ''))
    .filter((path) => path !== '')
  const entry: WorkspaceChangesEntry = {
    sessionId: input.sessionId,
    seq: input.seq,
    ...(input.journalSeq === undefined ? {} : { journalSeq: input.journalSeq }),
    ...(typeof input.summary?.turn === 'number' ? { turn: input.summary.turn } : {}),
    at: input.now ?? new Date().toISOString(),
    files,
    summaryAvailable: input.summary !== undefined,
  }
  input.store.appendLine([...WORKSPACE_CHANGES_SEGMENTS], JSON.stringify(entry) + '\n')
  return entry
}

/** 读回采集台账（坏行**跳过并计数**，不让一条坏行毁掉整个对账）。 */
export function readWorkspaceChanges(store: SdoStore): { entries: WorkspaceChangesEntry[]; badLines: number } {
  if (!existsSync(store.path(...WORKSPACE_CHANGES_SEGMENTS))) return { entries: [], badLines: 0 }
  const text = store.readText(...WORKSPACE_CHANGES_SEGMENTS) ?? ''
  const entries: WorkspaceChangesEntry[] = []
  let badLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as WorkspaceChangesEntry
      if (typeof parsed.sessionId === 'string' && typeof parsed.seq === 'number' && Array.isArray(parsed.files)) entries.push(parsed)
      else badLines += 1
    } catch {
      badLines += 1
    }
  }
  return { entries, badLines }
}

/**
 * 取"某会话在 `sinceSeq` 之后"的变更文件（去重，按出现顺序）。
 *
 * 语义要点：**采不到 ≠ 没越界** —— 返回 `entries: 0` 时调用方必须如实说明"未对账"，而不是判红或判绿。
 */
export function changedFilesSince(
  store: SdoStore,
  sessionId: string | undefined,
  sinceSeq: number | undefined,
): { files: string[]; entries: number; audited: boolean } {
  if (sessionId === undefined || sinceSeq === undefined) return { files: [], entries: 0, audited: false }
  const { entries } = readWorkspaceChanges(store)
  // **只在 journal 量纲里比较**（SDO-15）：`sinceSeq` 是 `task/claimed` 的 journal 序号，
  // 而 `entry.seq` 是宿主会话的计数器 —— 直接比会"全部命中"。旧记录（没有 `journalSeq`）
  // **不参与比较**：宁可如实报「未对账」，也不拿两个计数器硬拼出一个假的越界结论。
  const hit = entries.filter((entry) => entry.sessionId === sessionId && entry.journalSeq !== undefined && entry.journalSeq > sinceSeq)
  const files: string[] = []
  for (const entry of hit) for (const file of entry.files) if (!files.includes(file)) files.push(file)
  // `audited` = "窗口里**每个 seq** 都至少有一条带摘要的记录"。
  // 按 seq 归并而不是"每条记录都要有摘要"：同一 seq 可以先是"采到但拿不到摘要"（宿主先 append 事件、
  // 后写记录 —— 竞态），随后 `done` 时再取一次并**补记**一条带摘要的 ✓ 那样才算真对过账。
  const seqs = [...new Set(hit.map((entry) => entry.seq))]
  const audited = seqs.length > 0 && seqs.every((seq) => hit.some((entry) => entry.seq === seq && entry.summaryAvailable === true))
  return { files, entries: hit.length, audited }
}

/**
 * **还缺文件清单的 seq**（采集时拿不到摘要的那些 —— 宿主是"先 append 事件、后写记录"，必然为空）。
 * `done` 时拿它去宿主的 `workspaceChanges.summary(sessionId, seq)` 再取一次，取到就补记一条带摘要的。
 */
export function unresolvedSeqs(store: SdoStore, sessionId: string, sinceSeq: number): number[] {
  const { entries } = readWorkspaceChanges(store)
  // 同 SDO-15：窗口按 **journal 量纲** 划（`sinceSeq` 来自 `task/claimed`）；旧记录不参与
  const hit = entries.filter((entry) => entry.sessionId === sessionId && entry.journalSeq !== undefined && entry.journalSeq > sinceSeq)
  const seqs = [...new Set(hit.map((entry) => entry.seq))]
  return seqs.filter((seq) => !hit.some((entry) => entry.seq === seq && entry.summaryAvailable === true))
}
