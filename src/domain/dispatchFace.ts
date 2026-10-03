/**
 * **派发子代理工具面的观测**（评审 2026-10-03 §4.2）：把"宿主有没有真的收窄工具面"从**断言**变成**观察**。
 *
 * 背景：真机实测里我们带着 `toolFilter` 派发出的子代理**仍然看得见并调用**掩码外的工具（B6 钩子兜底拦下）。
 * 插件的回执因此**不能**替宿主保证"它看不到"；但子代理自己每次开新请求都会公告 `request/header`，
 * 里面带**它实际拿到的工具清单** —— SDO 监听该事件、只对**自己派发出去的子会话**记账，
 * 于是"是否收窄"变成可核对的事实（而不是谁说一句）。
 *
 * 记账只写文件（append-only），不改任何真源判定。
 */
import { existsSync } from 'node:fs'

import type { SdoStore } from '../infra/store.js'

export const CHILD_FACE_SEGMENTS = ['evidence', 'child-tools.jsonl'] as const

export interface ChildFaceEntry {
  /** 子会话 id（== `dispatch/started` 里的 childSessionId）。 */
  childSessionId: string
  at: string
  /**
   * **公告面**：它这次请求拿到（被公告）的工具名（去重、排序）。
   * 只记 `request/header` 那种"完整清单"的条目；`tool/call` 条目这里留空。
   */
  tools: string[]
  /** 公告面里**不在**该角色掩码内的工具（真机那例子是 `[]` —— 公告清单确实被收窄了）。 */
  violations: string[]
  /**
   * **执行面**：本会话里**实际发起**过的、落在掩码之外的调用（工具名，可含重复累积）。
   *
   * 为什么必须分开记（评审 2026-10-03 第二轮 Finding 1）：真机子会话的公告面**只有掩码内 9 个**，
   * 但它仍然**调用**了 `sdo_plan`/`sdo_review`/`sdo_gate`（宿主把未公告工具的调用也路由进了工具层，
   * 只有钩子拦得住）。只看公告面会给这种会话判"全部在掩码内"—— 正是我们一直在防的假绿。
   */
  calls?: string[] | undefined
  /**
   * **执行面的次数**：本会话里落在掩码外的**调用次数**（`calls` 是去重后的工具名，两者口径不同）。
   * 文案必须与口径一致：写「N 次」就得是次数（评审第三轮 B）。
   */
  callCount?: number | undefined
}

/** 记一条观测（append-only）。 */
export function recordChildFace(store: SdoStore, entry: Omit<ChildFaceEntry, 'at'> & { at?: string | undefined }): ChildFaceEntry {
  const full: ChildFaceEntry = { ...entry, at: entry.at ?? new Date().toISOString() }
  store.appendLine([...CHILD_FACE_SEGMENTS], JSON.stringify(full) + '\n')
  return full
}

/** 读回观测（坏行跳过并计数；同一子会话保留**最后**一条）。 */
export function readChildFaces(store: SdoStore): { faces: ChildFaceEntry[]; badLines: number } {
  if (!existsSync(store.path(...CHILD_FACE_SEGMENTS))) return { faces: [], badLines: 0 }
  const text = store.readText(...CHILD_FACE_SEGMENTS) ?? ''
  const latest = new Map<string, ChildFaceEntry>()
  let badLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as ChildFaceEntry
      if (typeof parsed.childSessionId !== 'string' || !Array.isArray(parsed.tools)) {
        badLines += 1
        continue
      }
      // 合并：公告面取**最近一条带清单**的，执行面把历次越界调用并起来（append-only，读时归一）
      const previous = latest.get(parsed.childSessionId)
      const calls = [...new Set([...(previous?.calls ?? []), ...(parsed.calls ?? [])])]
      const callCount = (previous?.callCount ?? 0) + (parsed.callCount ?? 0)
      const announced = parsed.tools.length > 0 ? parsed : previous?.tools.length ? previous : parsed
      latest.set(parsed.childSessionId, {
        childSessionId: parsed.childSessionId,
        at: parsed.at,
        tools: announced.tools,
        violations: announced.violations,
        ...(calls.length === 0 ? {} : { calls }),
        ...(callCount === 0 ? {} : { callCount }),
      })
    } catch {
      badLines += 1
    }
  }
  return { faces: [...latest.values()], badLines }
}

/** 从宿主 `tool/call` 事件里取工具名（结构容错）。 */
export function toolCallNameOf(event: unknown): string | undefined {
  const name = (event as { data?: { name?: unknown } } | undefined)?.data?.name
  return typeof name === 'string' && name !== '' ? name : undefined
}

/** 从宿主 `request/header` 事件里取工具名（结构容错：只认字符串 `name`）。 */
export function toolNamesOfHeader(header: unknown): string[] {
  const tools = (header as { tools?: unknown } | undefined)?.tools
  if (!Array.isArray(tools)) return []
  const names: string[] = []
  for (const item of tools) {
    const name = (item as { name?: unknown } | undefined)?.name
    if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name)
  }
  return names.sort()
}
