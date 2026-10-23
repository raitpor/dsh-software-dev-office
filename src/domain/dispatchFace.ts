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

import type { Journal } from '../infra/journal.js'
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
/**
 * **声明的工具面 vs 宿主实际给的面**（SDO-53：公告清单 ≠ 实际可调）。
 *
 * 真机上两个方向都出现过：**公告多于实际**（子代理自报 10 个，同一派发公告 12 个）与
 * **掩码外仍可调**（靠 B6 钩子兜底拦下）。这里不做猜测，只把差集摆出来：
 * `missing` = 我们声明了、子代理却没拿到（能力静默缺失，`read_image` 那次就是）；`extra` = 子代理拿到了
 * 我们没声明的（收窄没生效，安全面）。
 */
export function faceDiff(declared: readonly string[], observed: readonly string[]): { missing: string[]; extra: string[] } {
  const want = new Set(declared)
  const have = new Set(observed)
  return {
    missing: [...want].filter((name) => !have.has(name)).sort(),
    extra: [...have].filter((name) => !want.has(name)).sort(),
  }
}

export function recordChildFace(store: SdoStore, entry: Omit<ChildFaceEntry, 'at'> & { at?: string | undefined }): ChildFaceEntry {
  const full: ChildFaceEntry = { ...entry, at: entry.at ?? new Date().toISOString() }
  store.appendLine([...CHILD_FACE_SEGMENTS], JSON.stringify(full) + '\n')
  return full
}

/* —————————————————————— 观测**落事件**（DEF-165 ① / TASK-172） —————————————————————— */

/**
 * **一次观测在台账里的形状**（`dispatch/observed` 的读侧投影）。
 *
 * 为什么除了文件还要一条事件：R-1「该子会话被**观测到**手里有工具才允许复用」的证据如果只活在
 * `evidence/child-tools.jsonl` 里，那它就是**台账外的一份文件** —— 数不出"哪一次派发被观测到什么面"，
 * 也无法在回执里**引用**（`DEF-165` ① 的真机读数：journal 里含 `observ` 的事件类型计数＝0，
 * 于是复用判据对每个新子会话都只能说"没有证据"，每张卡都新起）。
 *
 * **字段面（先定窄、留扩展位）**：`childSessionId` / `toolCount` / `deniedOutsideCount` / `observedAt`
 * 四件是判定与回执共用的最小集；扩展只许**新增可选字段**，不许改这四个的语义（`M213-09` 的教训）。
 */
export interface ChildObservation {
  childSessionId: string
  /** **被公告的工具数**（`request/header` 里那份清单的长度；`tool/call` 观测记 0） */
  toolCount: number
  /** **掩码外的调用次数**（`tool/call` 判成越界时累加；观测面事件记 0） */
  deniedOutsideCount: number
  observedAt: string
  /** 该子会话**最近一条**观测事件的序号 —— 回执引用"依据哪条观测"就用它 */
  seq: number
}

/**
 * 记一条观测**事件**（append-only）。与 {@link recordChildFace} 是同一件事的两个落点：
 * 文件那份是**证据原件**（`evidence/child-tools.jsonl`，历史读数与 `faceMismatches` 还读它），
 * 事件这份是**可引用、可统计**的台账记录。两者都由 `office.noteChildFace` 一处触发（口径唯一）。
 */
export function recordChildObserved(
  journal: Journal,
  entry: { childSessionId: string; toolCount: number; deniedOutsideCount: number; observedAt?: string | undefined },
): ChildObservation {
  const observedAt = entry.observedAt ?? new Date().toISOString()
  const event = journal.append('dispatch/observed', {
    childSessionId: entry.childSessionId,
    toolCount: entry.toolCount,
    deniedOutsideCount: entry.deniedOutsideCount,
    observedAt,
  })
  return {
    childSessionId: entry.childSessionId,
    toolCount: entry.toolCount,
    deniedOutsideCount: entry.deniedOutsideCount,
    observedAt,
    seq: event.seq,
  }
}

/**
 * 读回**全部**观测事件（按子会话折叠：`toolCount` 取**最近一条带公告面**的，
 * `deniedOutsideCount` **累加** —— 与 `readChildFaces` 的合并口径逐字相同，读侧不会两套口径）。
 */
export function readChildObservations(journal: Journal): ChildObservation[] {
  const folded = new Map<string, ChildObservation>()
  for (const event of journal.read().events) {
    if (event.type !== 'dispatch/observed') continue
    const childSessionId = textOfValue(event.data.childSessionId)
    if (childSessionId === '') continue
    const toolCount = Number(event.data.toolCount ?? 0)
    const deniedOutsideCount = Number(event.data.deniedOutsideCount ?? 0)
    const observedAt = textOfValue(event.data.observedAt) || event.at
    const previous = folded.get(childSessionId)
    folded.set(childSessionId, {
      childSessionId,
      toolCount: Number.isFinite(toolCount) && toolCount > 0 ? toolCount : (previous?.toolCount ?? 0),
      deniedOutsideCount: (previous?.deniedOutsideCount ?? 0) + (Number.isFinite(deniedOutsideCount) ? Math.max(0, deniedOutsideCount) : 0),
      observedAt,
      seq: event.seq,
    })
  }
  return [...folded.values()]
}

/** 某个子会话的观测（没有 ⇒ `undefined` —— **没有证据**与"零工具"是两件事，别合并）。 */
export function observationOf(journal: Journal, childSessionId: string): ChildObservation | undefined {
  return readChildObservations(journal).find((row) => row.childSessionId === childSessionId)
}

/** 事件字段的字符串投影（结构容错：非字符串/空串一律当没有）。 */
function textOfValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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
