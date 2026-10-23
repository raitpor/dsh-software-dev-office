/**
 * **台账脱敏**（`TASK-173`，0.1.7 批4）：把「本机绝对位置」从**写下去的东西**与**已经写下的东西**里清掉。
 *
 * ## 这个模块为什么存在（两条互不相干的压力）
 *
 * ① **入库**：`.sdo/` 要随主仓库进 git（`ADR-024` 的对象改为工作区），而真源层的正文里到处是
 *    「本机家目录 + 工作区绝对路径」—— 那既是**隐私**（用户名/主机名/目录结构），也是**噪声**
 *    （换一台机器，同一句话里的路径就不作数了，判据读起来全是假红）。
 * ② **一致性**：`NFR-009` / `DEF-155` 早就规定「台账只记相对路径」，但那是**写侧的自律** +
 *    零散的折斜杠修补；一旦某条历史事件把绝对路径写进去了，读侧的任何判据都只能照着这个
 *    本机坐标去比。**写侧的规范化**（{@link ledgerPath}）与**历史的一次性清洗**（{@link planLedgerScrub}
 *    + {@link applyLedgerScrub}）必须成对存在，否则"以后不写了"和"以前写下的还在"两件事各自都不成立。
 *
 * ## 为什么「清洗」要与「演练」分成两步（这是本模块最重要的形状）
 *
 * 脱敏是**对历史的改写**，而本仓的底线是「历史不重写」（`journal` append-only）。允许它作为
 * **唯一例外**的前提是三样东西缺一不可（`ADR-028`）：
 *   · **先出演练报告**（改多少条、被拒哪些）—— 给批准人一个可核的对象，而不是一句"我清干净了"；
 *   · **批准人是人类**（`approvedBy` 只认 `human`，与 `release` 的 `frozenBy`/`deferredTo` 同一档：
 *     驾驶舱不得代批）；
 *   · **留前后哈希** —— 逐文件 + 整批链式摘要（`beforeDigest` / `afterDigest`），事后可复核
 *     "被改写的那一版长什么样"。
 * 所以 {@link planLedgerScrub} 是**纯读**（一个字节都不写盘，演练报告的生成不改状态），
 * {@link applyLedgerScrub} 是唯一写盘口，且它在写之前要把演练时的**前哈希**在盘上重算一遍
 * （`hash-drift` 即整体拒绝、零写盘）—— 演练与执行之间有人动过台账，就说明那份批准针对的不是这一版。
 *
 * ## 会话 id 保留、主机名与用户目录不写
 *
 * 掩码只认**位置**（工作区 / 家目录 / 主机名），不认**身份**：`session-…` 这类会话 id 是台账里
 * 唯一的"谁做的"线索（`DEF-165` 的复用判据就读它），**一个字都不许动**。测试里有一条
 * 专门钉住这件事（`M220-01`），因为把会话 id 一起打码会让整本台账失去可追责性。
 *
 * ## 事件类型：登记不在本卡写范围
 *
 * {@link SCRUB_APPLIED_EVENT} 这样的新事件类型要登记进 `src/types.ts` 的 `SdoEventType`
 * （闭合联合类型），而 `src/types.ts` 不在 `TASK-173` 的写范围里。因此：**写侧**走
 * {@link EventSink}（结构化的最小接口，`Journal` 天然满足），**读侧**按**字形**比字符串
 * （与 `dispatchFace` 里 `dispatch/reuse-skipped` 的处置同一套 —— 台账是跨版本 append-only 的，
 * 别的构建写过的事件本构建照样要读得回来）。登记这一步留给后续卡。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { JOURNAL_FILE } from '../infra/journal.js'
import { parseYaml } from '../infra/yaml.js'
import type { SdoStore } from '../infra/store.js'
import { reviewContentHash } from './records.js'
import type { Review } from './records.js'

/* ———————————————————————————— 占位符与工具名 ———————————————————————————— */

/** 家目录占位符：连**用户名**一起拿掉（只留"这是用户目录"这件事，不留是谁的）。 */
export const HOME_PLACEHOLDER = '<home>'
/** 主机名占位符。 */
export const HOST_PLACEHOLDER = '<host>'
/** 工作区占位符（**结构化路径字段**不走它，走 {@link ledgerPath} 折成仓库相对路径）。 */
export const WORKSPACE_PLACEHOLDER = '<workspace>'
/** 工作区之外的绝对路径占位符（没有相对形态可折时用，只保留最后一段名字）。 */
export const OUTSIDE_PLACEHOLDER = '<outside-workspace>'

/** 审计事件名（登记进 `SdoEventType` 的那半不在本卡写范围，见模块注释）。 */
export const SCRUB_APPLIED_EVENT = 'scrub/applied'
/** 工具名：CLI 与审计事件里都报它（`scripts/scrub-ledger.mjs` 就是这个工具的面）。 */
export const SCRUB_TOOL = 'sdo_scrub'
/** 唯一合法的批准人形态（`ADR-022` 裁决①同档：批准权只认人类）。 */
export const SCRUB_APPROVER = 'human'

/* ———————————————————————————— 秘密与掩码 ———————————————————————————— */

/** 脱敏要认的三类"秘密"：本机工作区、家目录、主机名。 */
export interface ScrubSecrets {
  /** 工作区根（绝对路径；`.sdo` 的上一级）。 */
  workspace: string
  /** 家目录（缺省取本机 `homedir()`；测试里显式给）。 */
  home: string
  /** 主机名（缺省取本机 `hostname()`；测试里显式给）。 */
  host: string
}

/** 取一份秘密（缺省值来自本机，但**允许显式覆盖** —— 单测不许依赖跑测试的这台机器）。 */
export function scrubSecretsOf(workspace: string, overrides: Partial<ScrubSecrets> = {}): ScrubSecrets {
  return {
    workspace: (overrides.workspace ?? workspace).trim(),
    home: (overrides.home ?? homedir()).trim(),
    host: (overrides.host ?? hostname()).trim(),
  }
}

/** 三类命中数（演练报告与审计事件都按它计数）。 */
export interface MaskHits {
  workspace: number
  home: number
  host: number
}

/** 空计数（**新对象**：计数在脱敏过程中被累加，别让调用方共享一个可变字面量）。 */
export function zeroHits(): MaskHits {
  return { workspace: 0, home: 0, host: 0 }
}

/** 命中总数。 */
export function hitsTotal(hits: MaskHits): number {
  return hits.workspace + hits.home + hits.host
}

function addHits(into: MaskHits, from: MaskHits): void {
  into.workspace += from.workspace
  into.home += from.home
  into.host += from.host
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 同一路径的三种书写（`/`、`\`、以及混合形态由前两者覆盖）：Windows 上的台账里两种都见过。 */
function separatorVariants(path: string): string[] {
  return [...new Set([path, path.replace(/\//gu, '\\'), path.replace(/\\/gu, '/')])].sort((a, b) => b.length - a.length)
}

/** 把某个**绝对位置**的全部出现换掉（长的书写优先，避免前缀互相截断）。 */
function replaceNeedle(text: string, needle: string, placeholder: string): { text: string; count: number } {
  const trimmed = needle.trim()
  if (trimmed === '') return { text, count: 0 }
  const pattern = new RegExp(separatorVariants(trimmed).map(escapeRegExp).join('|'), 'gu')
  let count = 0
  const masked = text.replace(pattern, () => {
    count += 1
    return placeholder
  })
  return { text: masked, count }
}

/** 主机名按**整词**换（它是短串，按裸子串换会把同前缀的普通单词一起吃掉）。 */
function replaceHost(text: string, host: string): { text: string; count: number } {
  const trimmed = host.trim()
  if (trimmed === '') return { text, count: 0 }
  const pattern = new RegExp(`(?<![\\w.-])${escapeRegExp(trimmed)}(?![\\w.-])`, 'gu')
  let count = 0
  const masked = text.replace(pattern, () => {
    count += 1
    return HOST_PLACEHOLDER
  })
  return { text: masked, count }
}

/**
 * **任意机器**的用户目录形态（不依赖本机 `homedir()`）：`/home/<x>`、`/Users/<x>`、`C:\Users\<x>`。
 *
 * 为什么要这一层：一次性的历史清洗之后，台账里可能还留着**别的机器**写下的绝对路径
 * （换机、CI、容器都会留下），而"只认本机那一条"的掩码对它们视而不见 —— 那会让
 * 「家目录前缀出现次数为 0」这个读数在换一台机器重跑时又变成非 0。
 */
const GENERIC_HOME_DIR = /(?<![\w.:-])(?:[A-Za-z]:)?[\\/]{1,2}(?:home|Users)[\\/][^\\/\s"'`<>()（）,;，；]+/gu
/** 只剩 `/home/` 这种**没有用户名段**的残形（文档里常见）。 */
const BARE_HOME_DIR = /(?<![\w.:-])[\\/]{1,2}(?:home|Users)[\\/]/gu
/** 泄漏扫描用的同一族字形（`residualLeaks` 与掩码共用一处口径）。 */
const LEAK_HOME_FORMS = [GENERIC_HOME_DIR, BARE_HOME_DIR] as const

/** 文本脱敏：工作区 → `<workspace>`、家目录 → `<home>`、主机名 → `<host>`；**会话 id 原样保留**。 */
export function maskText(text: string, secrets: ScrubSecrets): { text: string; hits: MaskHits } {
  const hits = zeroHits()
  let out = text
  // ① 工作区（它是家目录的子路径：先换更长的那个，否则家目录一换，工作区就再也对不上了）
  const workspace = replaceNeedle(out, secrets.workspace, WORKSPACE_PLACEHOLDER)
  out = workspace.text
  hits.workspace += workspace.count
  // ② 本机家目录
  const home = replaceNeedle(out, secrets.home, HOME_PLACEHOLDER)
  out = home.text
  hits.home += home.count
  // ③ 任意机器的用户目录形态（本机那一条已经被 ①② 吃掉了，这里处理"别人机器写下的"）
  let generic = 0
  out = out.replace(GENERIC_HOME_DIR, () => {
    generic += 1
    return HOME_PLACEHOLDER
  })
  let bare = 0
  out = out.replace(BARE_HOME_DIR, () => {
    bare += 1
    return `${HOME_PLACEHOLDER}/`
  })
  hits.home += generic + bare
  // ④ 主机名（整词）
  const host = replaceHost(out, secrets.host)
  out = host.text
  hits.host += host.count
  return { text: out, hits }
}

/**
 * **深走脱敏**：对结构化数据（journal 事件的 `data`）逐字符串脱敏，**键不动**。
 *
 * 键是 schema（`path`/`reason`/`seq`…），换掉键等于换掉事件的形状 —— 读侧会认不出来。
 * 值是人的书写，才可能带本机坐标。
 */
export function maskValue(value: unknown, secrets: ScrubSecrets): { value: unknown; hits: MaskHits } {
  const hits = zeroHits()
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      const masked = maskText(item, secrets)
      addHits(hits, masked.hits)
      return masked.text
    }
    if (Array.isArray(item)) return item.map((child) => walk(child))
    if (item !== null && typeof item === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) out[key] = walk(child)
      return out
    }
    return item
  }
  return { value: walk(value), hits }
}

/* ———————————————————————————— 写侧：路径规范化 ———————————————————————————— */

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u

/**
 * **写侧治理**：一个要落进台账的路径，只允许两种形态 ——
 *   · 工作区内 ⇒ **仓库相对路径**（`/` 折行，与 `SdoStore.relativeTo` 同口径；`DEF-155`）；
 *   · 工作区外 ⇒ `<outside-workspace>/<最后一段>`（没有相对形态可折，但也不留本机坐标）。
 *
 * 已经带占位符的串原样返回（幂等：同一份内容脱敏两次结果相同，`M220-04` 钉住）。
 */
export function ledgerPath(workspace: string, rawPath: string): string {
  const raw = rawPath.trim()
  if (raw === '') return ''
  if (raw.includes('<')) return raw
  const absolute = isAbsolute(raw) || WINDOWS_DRIVE.test(raw) ? raw : resolve(workspace, raw)
  const root = workspace.trim() === '' ? '' : resolve(workspace)
  if (root !== '') {
    const rel = relative(root, absolute)
    if (rel === '') return '.'
    if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  }
  const flat = absolute.split(/[\\/]+/u).filter((part) => part !== '')
  const last = flat[flat.length - 1] ?? ''
  return last === '' ? OUTSIDE_PLACEHOLDER : `${OUTSIDE_PLACEHOLDER}/${last}`
}

/* ———————————————————————————— 真源面 ———————————————————————————— */

/** **真源层**（随主仓库进 git 的那一半）：台账里属于"事实"的目录。 */
export const LEDGER_TRUTH_DIRS: readonly string[] = [
  'changes', 'construction', 'contracts', 'decisions', 'defects', 'design', 'gates', 'issues',
  'quality', 'questions', 'releases', 'requirements', 'reviews', 'risks', 'tasks', 'testing', 'tests', 'trace',
]

/** 真源层的**根文件**（`journal.jsonl` 是唯一真源，逐行处理）。 */
export const LEDGER_TRUTH_FILES: readonly string[] = ['config.yml', 'feasibility.yml', 'HANDOFF.md', JOURNAL_FILE]

/**
 * **不入库**的四项（`ADR-022` / 0.1.7 批4 的入库边界）：脱敏面**不碰**它们，但要在报告里点名。
 *
 * `evidence` 是任务的过程产物（随版本归档删除）、`drafts` 与 `handover` 是草稿区、
 * `project.json` 是派生视图（可从 journal 重建）。它们**不是**真源 —— 对它们做"历史改写"
 * 既没有审计价值，也会把"派生件"洗成"第二份真源"。
 */
export const LEDGER_EXCLUDED: readonly { path: string; why: string }[] = [
  { path: 'evidence', why: 'process artifact, archived per version (ADR-022)' },
  { path: 'drafts', why: 'draft area, not in the repository' },
  { path: 'handover', why: 'handover notes, not in the repository' },
  { path: 'project.json', why: 'derived view, rebuildable from journal' },
]

/** 一次扫描看到的**面**：真源文件、被排除项、落不到任何一类的项（fail-closed）。 */
export interface ScrubSurface {
  /** 真源文件（相对 `.sdo` 根，`/` 形态，排序） */
  paths: string[]
  /** 明确排除、且**有意不碰**的项（带理由） */
  excluded: { path: string; why: string }[]
  /** 既不在真源、也不在排除表里的顶层项 —— 不猜，逐条报出来 */
  unclassified: string[]
  /** 符号链接（不跟随：改它可能改到台账之外） */
  symlinks: string[]
}

function walkFiles(dir: string, base: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) walkFiles(resolve(dir, entry.name), rel, out)
    else out.push(rel)
  }
}

/** 现算脱敏面（`includeEvidence` 时才把 `evidence` 也纳入 —— 归档后留存的摘要同样要脱敏）。 */
export function ledgerSurface(store: SdoStore, options: { includeEvidence?: boolean } = {}): ScrubSurface {
  const out: ScrubSurface = { paths: [], excluded: [], unclassified: [], symlinks: [] }
  if (!existsSync(store.root)) return out
  const includeEvidence = options.includeEvidence === true
  const entries = readdirSync(store.root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const name = entry.name
    const excluded = LEDGER_EXCLUDED.find((item) => item.path === name)
    if (excluded !== undefined && !(includeEvidence && name === 'evidence')) {
      out.excluded.push({ path: name, why: excluded.why })
      continue
    }
    if (entry.isSymbolicLink()) {
      out.symlinks.push(name)
      continue
    }
    if (entry.isDirectory() && (LEDGER_TRUTH_DIRS.includes(name) || (includeEvidence && name === 'evidence'))) {
      walkFiles(resolve(store.root, name), name, out.paths)
      continue
    }
    if (entry.isFile() && LEDGER_TRUTH_FILES.includes(name)) {
      out.paths.push(name)
      continue
    }
    out.unclassified.push(name)
  }
  out.paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return out
}

/* ———————————————————————————— 演练（只读） ———————————————————————————— */

/** 被拒的原因码（演练报告的核心内容之一：**被拒哪些、为什么**）。 */
export type ScrubRefusalCode =
  | 'not-utf8'
  | 'unreadable'
  | 'source-unparseable'
  | 'structural-break'
  | 'journal-line-not-json'
  | 'unclassified'
  | 'symlink'

/** 一条被拒项（`detail` 里**不许**出现秘密本身：报告可能被贴进证据与提交信息）。 */
export interface ScrubRefusal {
  path: string
  line?: number
  code: ScrubRefusalCode
  detail?: string
}

/** 一个文件的改前/改后（哈希是**字节**的 sha256，与产物证据同一形态）。 */
export interface ScrubFileRow {
  path: string
  bytes: number
  beforeHash: string
  afterHash: string
  hits: MaskHits
}

/** journal 里**一条事件**的改前/改后（逐行改，坏行不动）。 */
export interface JournalScrubRow {
  seq: number
  line: number
  beforeHash: string
  afterHash: string
  hits: MaskHits
}

/** 一处会因脱敏而**失效的已记录指纹**（评审的内容指纹族）。 */
export interface FingerprintImpact {
  kind: 'review-content-hash'
  path: string
  id: string
  recorded: string
  after: string
}

/** 演练报告（**这就是批准人看的那份东西**；序列化后不许含本机绝对前缀）。 */
export interface ScrubReport {
  tool: string
  kind: 'ledger'
  generatedAt: string
  /** 掩码用的三个占位符（**不是**秘密本身） */
  placeholders: { workspace: string; home: string; host: string }
  surface: { scannedFiles: number; scannedBytes: number; excluded: { path: string; why: string }[]; unclassified: string[]; symlinks: string[] }
  files: ScrubFileRow[]
  journal: { path: string; rows: JournalScrubRow[]; beforeHash: string; afterHash: string; events: number } | undefined
  refusals: ScrubRefusal[]
  impacts: FingerprintImpact[]
  totals: { files: number; journalEvents: number; bytes: number; hits: MaskHits }
  /** 演练语义：**没有写盘**（`apply` 回执另算） */
  dryRun: true
}

/** 一份待写入的完整文本（**不随报告序列化**：演练报告只给人看读数，不带正文）。 */
export interface ScrubWrite {
  path: string
  before: string
  after: string
}

/** 演练结果 = 报告 + 待写入正文（`apply` 才用后者）。 */
export interface ScrubPlan {
  report: ScrubReport
  writes: ScrubWrite[]
}

/** journal 的最小读面（`Journal` 天然满足；测试里可以给一个纯夹具）。 */
export interface JournalLike {
  read(): { events: readonly { seq: number; type: string; data: Record<string, unknown> }[] }
}

/** 最小**写**面（`Journal` 天然满足；测试里给假 sink 就能只验事件形状）。 */
export interface EventSink {
  append(type: string, data: Record<string, unknown>, actor?: string): unknown
}

/**
 * 审计面用到的错误（**文案一律 ASCII 码**：产品文案走语言包，而 `src/data/lang/*.yml` 不在本卡写范围）。
 * 界面层（`scripts/scrub-ledger.mjs`）按 `code` 渲染人话。
 */
export type ScrubErrorCode = 'approval-missing' | 'hash-drift' | 'write-failed' | 'path-outside' | 'audit-unavailable'

export class ScrubError extends Error {
  readonly code: ScrubErrorCode
  readonly detail: Record<string, unknown>

  constructor(code: ScrubErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ScrubError'
    this.code = code
    this.detail = detail
  }
}

/** 字节/文本的 sha256（台账的产物证据一直是**裸十六进制**，这里不另造前缀）。 */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

function short(text: string, limit = 120): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** UTF-8 严格解码：不是文本的文件**不猜**（二进制里替换字节等于毁掉它）。 */
function decodeUtf8(raw: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return undefined
  }
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path
  const at = name.lastIndexOf('.')
  return at < 0 ? '' : name.slice(at + 1).toLowerCase()
}

/**
 * 脱敏**之后**结构还读得回来吗（YAML/JSON/JSONL 逐行）。读不回来 ⇒ 整份拒，不写半成品。
 *
 * 单独导出是为了让守卫能**直接**喂一对"改前合法、改后读不回来"的文本 —— 在真账上造不出这种
 * 形态（占位符本身是合法标量），只能当成一个纯函数来钉（`M220-07` 的 `structural-break` 格）。
 */
export function scrubStructureProblem(path: string, before: string, after: string): ScrubRefusal | undefined {
  const ext = extensionOf(path)
  if (ext === 'yml' || ext === 'yaml') {
    try {
      parseYaml(before)
    } catch (error) {
      return { path, code: 'source-unparseable', detail: short(error instanceof Error ? error.message : String(error)) }
    }
    try {
      parseYaml(after)
    } catch (error) {
      return { path, code: 'structural-break', detail: short(error instanceof Error ? error.message : String(error)) }
    }
    return undefined
  }
  if (ext === 'json') {
    try {
      JSON.parse(before)
    } catch (error) {
      return { path, code: 'source-unparseable', detail: short(error instanceof Error ? error.message : String(error)) }
    }
    try {
      JSON.parse(after)
    } catch (error) {
      return { path, code: 'structural-break', detail: short(error instanceof Error ? error.message : String(error)) }
    }
    return undefined
  }
  if (ext === 'jsonl') {
    const beforeLines = before.split('\n')
    const afterLines = after.split('\n')
    for (const [index, line] of beforeLines.entries()) {
      if (line.trim() === '') continue
      try {
        JSON.parse(line)
      } catch (error) {
        return { path, line: index + 1, code: 'source-unparseable', detail: short(error instanceof Error ? error.message : String(error)) }
      }
      const masked = afterLines[index]
      if (masked === undefined) return { path, line: index + 1, code: 'structural-break', detail: 'line count changed' }
      try {
        JSON.parse(masked)
      } catch (error) {
        return { path, line: index + 1, code: 'structural-break', detail: short(error instanceof Error ? error.message : String(error)) }
      }
    }
    return undefined
  }
  return undefined
}

/** 演练参数。 */
export interface ScrubPlanOptions {
  /** 工作区根（`.sdo` 的上一级）；缺省取 `store.root` 的父目录 */
  workspace?: string | undefined
  secrets?: Partial<ScrubSecrets> | undefined
  includeEvidence?: boolean | undefined
  /** 给了就读它、算出「哪些已记录指纹会失效」；不给则 `impacts` 为空 */
  journal?: JournalLike | undefined
  now?: string | undefined
}

/**
 * **演练**：读 `store` 的真源面，算出"要改哪些、每处改几个命中、被拒哪些"，**一个字节都不写**。
 *
 * 被拒的五类（每类都有守卫格）：非 UTF-8、读不出来、改写前就不合法、脱敏后结构读不回来、
 * journal 坏行/半行。另有 `unclassified`（顶层出现不认识的项）与 `symlink`（不跟随）。
 */
export function planLedgerScrub(store: SdoStore, options: ScrubPlanOptions = {}): ScrubPlan {
  const workspace = (options.workspace ?? dirname(store.root)).trim()
  const secrets = scrubSecretsOf(workspace, options.secrets ?? {})
  const surface = ledgerSurface(store, { includeEvidence: options.includeEvidence === true })
  const files: ScrubFileRow[] = []
  const writes: ScrubWrite[] = []
  const refusals: ScrubRefusal[] = []
  let scannedFiles = 0
  let scannedBytes = 0

  for (const item of surface.unclassified) refusals.push({ path: item, code: 'unclassified' })
  for (const item of surface.symlinks) refusals.push({ path: item, code: 'symlink' })

  for (const path of surface.paths) {
    if (path === JOURNAL_FILE) continue // journal 逐行处理，见下
    const absolute = resolve(store.root, path)
    let raw: Buffer
    try {
      raw = readFileSync(absolute)
    } catch {
      refusals.push({ path, code: 'unreadable' })
      continue
    }
    scannedFiles += 1
    scannedBytes += raw.length
    const text = decodeUtf8(raw)
    if (text === undefined) {
      refusals.push({ path, code: 'not-utf8' })
      continue
    }
    const masked = maskText(text, secrets)
    if (hitsTotal(masked.hits) === 0) continue
    const after = ensureTrailingNewline(masked.text)
    const problem = scrubStructureProblem(path, text, after)
    if (problem !== undefined) {
      refusals.push(problem)
      continue
    }
    files.push({ path, bytes: raw.length, beforeHash: sha256Hex(raw), afterHash: sha256Hex(Buffer.from(after, 'utf8')), hits: masked.hits })
    writes.push({ path, before: text, after })
  }

  const journal = planJournalScrub(store, secrets, { scannedBytes: (bytes) => { scannedFiles += 1; scannedBytes += bytes } }, refusals, writes)

  const hits = zeroHits()
  for (const row of files) addHits(hits, row.hits)
  if (journal !== undefined) for (const row of journal.rows) addHits(hits, row.hits)
  const bytes = files.reduce((total, row) => total + row.bytes, 0)
    + (journal === undefined || journal.rows.length === 0 ? 0 : journal.beforeBytes)

  const impacts = options.journal === undefined ? [] : fingerprintImpacts(writes, options.journal)
  const report: ScrubReport = {
    tool: SCRUB_TOOL,
    kind: 'ledger',
    generatedAt: (options.now ?? new Date().toISOString()),
    placeholders: { workspace: WORKSPACE_PLACEHOLDER, home: HOME_PLACEHOLDER, host: HOST_PLACEHOLDER },
    surface: {
      scannedFiles,
      scannedBytes,
      excluded: surface.excluded,
      unclassified: surface.unclassified,
      symlinks: surface.symlinks,
    },
    files,
    journal: journal === undefined
      ? undefined
      : { path: JOURNAL_FILE, rows: journal.rows, beforeHash: journal.beforeHash, afterHash: journal.afterHash, events: journal.rows.length },
    refusals,
    impacts,
    totals: { files: files.length, journalEvents: journal?.rows.length ?? 0, bytes, hits },
    dryRun: true,
  }
  return { report, writes }
}

interface JournalScrub {
  rows: JournalScrubRow[]
  beforeHash: string
  afterHash: string
  beforeBytes: number
}

/** journal 逐行脱敏：**坏行保持原样**（半行是真源受损的现场，改它等于把现场擦掉）。 */
function planJournalScrub(
  store: SdoStore,
  secrets: ScrubSecrets,
  counter: { scannedBytes: (bytes: number) => void },
  refusals: ScrubRefusal[],
  writes: ScrubWrite[],
): JournalScrub | undefined {
  const text = store.readText(JOURNAL_FILE)
  if (text === undefined) return undefined
  counter.scannedBytes(Buffer.byteLength(text, 'utf8'))
  const lines = text.split('\n')
  const rows: JournalScrubRow[] = []
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      refusals.push({ path: JOURNAL_FILE, line: index + 1, code: 'journal-line-not-json', detail: short(error instanceof Error ? error.message : String(error)) })
      continue
    }
    const event = parsed as Partial<{ seq: unknown; at: unknown; actor: unknown; type: unknown; data: unknown }>
    if (typeof event.seq !== 'number' || typeof event.type !== 'string' || typeof event.data !== 'object' || event.data === null) {
      refusals.push({ path: JOURNAL_FILE, line: index + 1, code: 'source-unparseable', detail: 'event shape' })
      continue
    }
    const data = maskValue(event.data, secrets)
    const actor = typeof event.actor === 'string' ? maskText(event.actor, secrets) : { text: event.actor, hits: zeroHits() }
    const hits = { ...data.hits }
    addHits(hits, actor.hits)
    if (hitsTotal(hits) === 0) continue
    const rebuilt = JSON.stringify({ seq: event.seq, at: event.at, actor: typeof actor.text === 'string' ? actor.text : 'sdo', type: event.type, data: data.value })
    lines[index] = rebuilt
    rows.push({ seq: event.seq, line: index + 1, beforeHash: sha256Hex(line), afterHash: sha256Hex(rebuilt), hits })
  }
  const after = ensureTrailingNewline(lines.join('\n'))
  const beforeHash = sha256Hex(Buffer.from(text, 'utf8'))
  const afterHash = sha256Hex(Buffer.from(after, 'utf8'))
  if (rows.length > 0) writes.push({ path: JOURNAL_FILE, before: text, after })
  return { rows, beforeHash, afterHash, beforeBytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * **哪些已记录指纹会因这次脱敏失效**（评审内容指纹族）。
 *
 * 为什么必须报出来：`review/recorded.contentHash` 是"这条评审当时是什么样"的封印，脱敏改了评审正文
 * 就等于动了封印下的内容 —— 判定会变成 `tampered`。这不一定是坏事（历史改写本来就要用户批），
 * 但**必须在批准前就看得见**：否则签完字才发现"三条评审集体失效"。
 */
export function fingerprintImpacts(writes: readonly ScrubWrite[], journal: JournalLike): FingerprintImpact[] {
  const recorded = new Map<string, string>()
  for (const event of journal.read().events) {
    if (event.type !== 'review/recorded') continue
    const id = typeof event.data['id'] === 'string' ? event.data['id'] : ''
    const hash = typeof event.data['contentHash'] === 'string' ? event.data['contentHash'] : ''
    if (id !== '' && hash !== '') recorded.set(id, hash)
  }
  const out: FingerprintImpact[] = []
  for (const write of writes) {
    if (!/^reviews\/[^/]+\.yml$/u.test(write.path)) continue
    const after = reviewOfYaml(write.after)
    if (after === undefined) continue
    const sealed = recorded.get(after.id)
    if (sealed === undefined) continue
    const current = reviewContentHash(after)
    if (current !== sealed) out.push({ kind: 'review-content-hash', path: write.path, id: after.id, recorded: sealed, after: current })
  }
  return out
}

function reviewOfYaml(text: string): Review | undefined {
  try {
    const parsed = parseYaml(text) as { review?: unknown }
    const review = parsed.review
    if (review === null || typeof review !== 'object') return undefined
    const shaped = review as Review
    return typeof shaped.id === 'string' ? shaped : undefined
  } catch {
    return undefined
  }
}

/* ———————————————————————————— 执行（唯一写盘口） ———————————————————————————— */

/** 执行参数：**批准人是必需的**（缺了就不执行，不是警告）。 */
export interface ScrubInput {
  approvedBy: string
  actor?: string | undefined
  journal: EventSink
  now?: string | undefined
}

/** 执行回执（`done` 证据里贴它：条数、字节、前后链式摘要、审计事件序号）。 */
export interface ScrubReceipt {
  tool: string
  appliedAt: string
  approvedBy: string
  files: number
  journalEvents: number
  bytes: number
  beforeDigest: string
  afterDigest: string
  rows: { path: string; beforeHash: string; afterHash: string }[]
  eventSeq?: number
}

function digestOf(rows: readonly { path: string; hash: string }[]): string {
  return sha256Hex(rows.map((row) => `${row.path}:${row.hash}`).sort().join('\n'))
}

/**
 * **执行**：把演练结果落到盘上，并留一条 `scrub/applied` 审计事件。
 *
 * 三道闸（任一条不过就**整体拒绝、零写盘**）：
 *   ① 批准人必须是 `human`（`approval-missing`）；
 *   ② 演练时的**前哈希**必须与盘上现状逐字相等（`hash-drift`）—— 批准的是那一版，不是"大概那一版"；
 *   ③ 写完**从盘上读回**再算哈希，必须等于演练算出的后哈希（`write-failed`；`D1` 第 13 条：
 *      "哈希变了"≠"文件被写了"，必须回读）。
 */
export function applyLedgerScrub(store: SdoStore, plan: ScrubPlan, input: ScrubInput): ScrubReceipt {
  const approvedBy = input.approvedBy.trim()
  if (approvedBy !== SCRUB_APPROVER) {
    throw new ScrubError('approval-missing', `user approval is required (approvedBy must be ${SCRUB_APPROVER})`, { approvedBy })
  }
  const expected = new Map<string, string>()
  for (const row of plan.report.files) expected.set(row.path, row.beforeHash)
  if (plan.report.journal !== undefined && plan.report.journal.rows.length > 0) {
    expected.set(plan.report.journal.path, plan.report.journal.beforeHash)
  }
  const drifted: string[] = []
  for (const write of plan.writes) {
    let disk: Buffer
    try {
      disk = readFileSync(resolve(store.root, write.path))
    } catch {
      drifted.push(write.path)
      continue
    }
    const want = expected.get(write.path)
    if (want === undefined || sha256Hex(disk) !== want) drifted.push(write.path)
  }
  if (drifted.length > 0) {
    throw new ScrubError('hash-drift', 'ledger changed since rehearsal; re-run the rehearsal', { paths: drifted })
  }
  for (const write of plan.writes) store.writeText([write.path], write.after)
  const unverified: string[] = []
  const afterHashes = new Map<string, string>()
  for (const write of plan.writes) {
    const back = readFileSync(resolve(store.root, write.path))
    const hash = sha256Hex(back)
    afterHashes.set(write.path, hash)
    const want = write.path === JOURNAL_FILE && plan.report.journal !== undefined && plan.report.journal.rows.length > 0
      ? plan.report.journal.afterHash
      : plan.report.files.find((row) => row.path === write.path)?.afterHash
    if (want === undefined || want !== hash) unverified.push(write.path)
  }
  if (unverified.length > 0) {
    throw new ScrubError('write-failed', 'written bytes do not match the rehearsal hashes', { paths: unverified })
  }
  const rows = plan.report.files.map((row) => ({ path: row.path, beforeHash: row.beforeHash, afterHash: afterHashes.get(row.path) ?? row.afterHash }))
  const beforeDigest = digestOf(plan.report.files.map((row) => ({ path: row.path, hash: row.beforeHash })))
  const afterDigest = digestOf(rows.map((row) => ({ path: row.path, hash: row.afterHash })))
  const event = input.journal.append(
    SCRUB_APPLIED_EVENT,
    {
      tool: SCRUB_TOOL,
      approvedBy,
      files: plan.report.files.length,
      journalEvents: plan.report.journal?.rows.length ?? 0,
      bytes: plan.report.totals.bytes,
      beforeDigest,
      afterDigest,
      placeholders: plan.report.placeholders,
      refusals: plan.report.refusals.map((row) => ({ path: row.path, code: row.code, ...(row.line === undefined ? {} : { line: row.line }) })),
      rows: plan.report.files.map((row) => ({ path: row.path, beforeHash: row.beforeHash, afterHash: row.afterHash, hits: row.hits })),
      journalRows: (plan.report.journal?.rows ?? []).map((row) => ({ seq: row.seq, beforeHash: row.beforeHash, afterHash: row.afterHash })),
      impacts: plan.report.impacts.map((row) => ({ kind: row.kind, path: row.path, id: row.id, recorded: row.recorded, after: row.after })),
    },
    input.actor ?? SCRUB_TOOL,
  )
  const seq = event !== null && typeof event === 'object' && 'seq' in event ? (event as { seq: unknown }).seq : undefined
  const appliedAt = input.now ?? new Date().toISOString()
  return {
    tool: SCRUB_TOOL,
    appliedAt,
    approvedBy,
    files: plan.report.files.length,
    journalEvents: plan.report.journal?.rows.length ?? 0,
    bytes: plan.report.totals.bytes,
    beforeDigest,
    afterDigest,
    rows,
    ...(typeof seq === 'number' ? { eventSeq: seq } : {}),
  }
}

/* ———————————————————————————— 残余泄漏读数 ———————————————————————————— */

export type LeakNeedle = 'home' | 'workspace' | 'host'

/** 一处残余泄漏（**只报位置，不回显正文**：读数本身也不许二次泄漏）。 */
export interface LeakRow {
  path: string
  line: number
  needle: LeakNeedle
}

/**
 * **DoD 读数**：真源层里还有多少处"家目录/工作区/主机名"的字形（`grep -r` 的机械等价物）。
 *
 * 与掩码共用同一族正则（`LEAK_HOME_FORMS`）—— 两处各写一份必然分叉：掩码认得的形态，
 * 读数也认；读数认不得的形态，掩码也就不用管。
 */
export function residualLeaks(store: SdoStore, secrets: ScrubSecrets, options: { includeEvidence?: boolean; limit?: number } = {}): LeakRow[] {
  const surface = ledgerSurface(store, { includeEvidence: options.includeEvidence === true })
  const out: LeakRow[] = []
  const limit = options.limit ?? 0
  const homeNeedles = separatorVariants(secrets.home.trim()).filter((item) => item !== '')
  const workspaceNeedles = separatorVariants(secrets.workspace.trim()).filter((item) => item !== '')
  const hostPattern = secrets.host.trim() === '' ? undefined : new RegExp(`(?<![\\w.-])${escapeRegExp(secrets.host.trim())}(?![\\w.-])`, 'u')
  for (const path of surface.paths) {
    let raw: Buffer
    try {
      raw = readFileSync(resolve(store.root, path))
    } catch {
      continue
    }
    const text = decodeUtf8(raw)
    if (text === undefined) continue
    for (const [index, line] of text.split('\n').entries()) {
      if (workspaceNeedles.some((needle) => line.includes(needle))) out.push({ path, line: index + 1, needle: 'workspace' })
      const homeHit = homeNeedles.some((needle) => line.includes(needle)) || LEAK_HOME_FORMS.some((pattern) => pattern.test(line))
      if (homeHit) out.push({ path, line: index + 1, needle: 'home' })
      if (hostPattern !== undefined && hostPattern.test(line)) out.push({ path, line: index + 1, needle: 'host' })
      if (limit > 0 && out.length >= limit) return out
    }
  }
  return out
}

/** 按类计数（落进报告与 `done` 证据时只要这三个数）。 */
export function leakCounts(rows: readonly LeakRow[]): MaskHits {
  const hits = zeroHits()
  for (const row of rows) {
    if (row.needle === 'home') hits.home += 1
    else if (row.needle === 'workspace') hits.workspace += 1
    else hits.host += 1
  }
  return hits
}

/** 台账里"有没有这个文件"（`sdo_scrub` 的 CLI 用它判"这台机器上有没有台账"）。 */
export function ledgerPresent(store: SdoStore): boolean {
  try {
    return statSync(resolve(store.root, JOURNAL_FILE)).isFile()
  } catch {
    return false
  }
}
