/**
 * **完成证据的对账**（A1）：`sdo_task action=done` 时，把"执行者交上来的证据"与"卡上声明的证据要求"
 * 以及"工作区里真实存在的东西"对上。
 *
 * 为什么需要它：`done` 此前只校验「证据数组非空」——卡上写 `evidenceRequired: [command, artifact]`，
 * 交一条 `artifact` 也能过；`artifact` 指向一个根本不存在的路径也能过；`command` 是一条退出码 1 的
 * 输出也能过。于是"完成"退化成自述。这里做三条**机械**检查（都不看模型怎么说）：
 *
 *   ① **种类覆盖**：`task.evidenceRequired` ⊆（已挂证据 ∪ 本次证据）的 kind 集合；
 *   ② **产物落地**：`artifact` 的 `detail` 取路径（可带 `sha256=<hex>` 后缀），路径必须存在；
 *      带哈希时按文件内容复算比对（不符即判红）；
 *   ③ **命令成立**：`command` 若给了 `exitCode`，必须为 0（非 0 不算完成证据）。
 *
 * 不做的事（有意为之）：不去猜证据"够不够好"（那是评审员的活）；不校验 `command` 的输出格式
 * （没有可机械判定的约定，硬编会变成逼人编造）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { SdoStore } from '../infra/store.js'
import { textOf } from '../infra/scalar.js'
import { readContract } from './contracts.js'
// **TASK-173**：证据随版本归档（`ADR-022` 裁决③）—— 批准人/事件面/错误面与台账脱敏**共用一套**
// （`scrub.ts` 的 `ScrubError` 与 `EventSink`），不另造第二份"批准"，也不写第二个审计事件形状。
import { SCRUB_TOOL, ScrubError } from './scrub.js'
import type { EventSink } from './scrub.js'
// **TASK-056 落点二**：证据面改读方法产物台账 —— 台账读法只此一处（`construction.ts`），
// 这里直接复用，不另造第二份读法（`evidence.ts` 不反向被 `construction.ts` 依赖，无环）。
import {
  CONSTRUCTION_CONTRACT_FILE,
  CONSTRUCTION_DIR,
  CONSTRUCTION_TDD_FILE,
  readContractTests,
  readMutations,
} from './construction.js'
import { hashArtifact } from './records.js'
import { readRequirement } from './requirements.js'
import type { EvidenceItem } from '../types.js'

/**
 * **判定基准来源（oracle）**（REQ-054 / TASK-020）。
 *
 * 四类取值，逐类**都能机械核对**（这就是选这四类的原因：专家判断只要写得出人名，也能追责）：
 *   · `acceptance`：指到某需求的验收标准 ⇒ 核对 `ref` 需求存在、且 `criterion` 是**它自己**的 AC 编号；
 *   · `contract`：指到契约的成功/失败语义 ⇒ 核对契约存在、未作废、且**写了失败语义**；
 *   · `baseline`：冻结的旧实现基线 ⇒ 核对绑了 64 位 sha256，且给了工作区时**现算比对**；
 *   · `expert`：专家判断 ⇒ 核对写了**判断人**。
 */
export interface OracleRef {
  kind: string
  /** 需求 id / 契约 id / 基线产物相对路径（按 `kind` 解释） */
  ref?: string | undefined
  /** `acceptance` 类的验收标准编号 */
  criterion?: string | undefined
  /** `baseline` 类的基线产物哈希 */
  baselineSha256?: string | undefined
  /** `expert` 类的**判断人**（必须有名字，可追责） */
  expert?: string | undefined
}

/** 判定基准核对需要的上下文（给了工作区才能**现算**基线哈希）。 */
export interface OracleContext {
  workspace?: string | undefined
  /** 缺判定基准时要**点名**的用例 id（"说了等于没说"的缺口文案不算点名） */
  caseId?: string | undefined
  /** 该用例覆盖的需求 id（点名用） */
  requirement?: string | undefined
}

export const ORACLE_KINDS = ['acceptance', 'contract', 'baseline', 'expert'] as const

/** 判定基准的**人读名字**（回执与理由里用同一份词表，不许各写一套）。 */
const ORACLE_KIND_LABELS: Record<string, string> = {
  acceptance: '需求验收标准',
  contract: '契约（成功/失败语义）',
  baseline: '冻结的旧实现基线',
  expert: '专家判断',
}

function oracleKindLabel(kind: string): string {
  return ORACLE_KIND_LABELS[kind] ?? kind
}

const SHA256_RE = /^[0-9a-f]{64}$/u

/**
 * **判定基准逐类机械核对**（REQ-054 / TASK-020）——**唯一**实现。
 *
 * 返回的是**缺口清单**（空数组 = 判定基准成立）：把人读的理由攒起来一次报全，而不是遇到第一条就返回
 * ——「缺判定基准」这种话说了等于没说，必须点名**缺哪一类、指到了什么、为什么不成立**。
 *
 * 降级口径与 REQ-054 一致：引用的验收标准 / 契约 / 基线**不存在**时判红并点名；
 * 而 `store` 缺省（或在无工作区上下文里核对 `baseline` 类）时**只做形状核对、不假报"不存在"**
 * —— 与 `evidenceFreshness` 对"算不出来"的处理同一纪律（不因为拿不到环境就把人判红）。
 */
export function oracleGaps(store: unknown, oracle: OracleRef | undefined, context?: OracleContext | undefined): string[] {
  // **点名**是判据的一部分：缺口文案必须能指到"哪条用例缺哪一种判定基准"，
  // 否则门禁只说了一句"有东西不对"，读的人还得自己去翻台账（本项目反复警惕的那种"说了等于没说"）。
  const who = [
    textOf(context?.caseId).trim() === '' ? '' : `用例 ${textOf(context?.caseId).trim()}`,
    textOf(context?.requirement).trim() === '' ? '' : `（覆盖 ${textOf(context?.requirement).trim()}）`,
  ].join('')
  const at = who === '' ? '' : `${who}：`
  const ref = oracle as OracleRef | undefined
  if (ref === null || typeof ref !== 'object') {
    return [`${at}没有登记判定基准（oracle）：四类取值 —— 需求验收标准 / 契约 / 冻结基线 / 专家判断，缺判定基准的用例不计入通过覆盖`]
  }
  const kind = textOf(ref.kind).trim()
  if (!(ORACLE_KINDS as readonly string[]).includes(kind)) {
    return [
      kind === ''
        ? `${at}判定基准没有给类别（kind）：四类取值 —— ${ORACLE_KINDS.map((item) => oracleKindLabel(item)).join(' / ')}`
        : `${at}判定基准的类别取值域外：「${kind}」—— 只认 ${ORACLE_KINDS.join(' / ')}`,
    ]
  }
  const gaps: string[] = []
  const target = textOf(ref.ref).trim()
  const workspace = textOf(context?.workspace).trim()
  // 只有真的拿到了一个 store 才去查台账；否则老调用点（没有 store）会被**假报**成"引用的东西不存在"
  const db = store === null || store === undefined ? undefined : (store as SdoStore)
  if (kind === 'acceptance') {
    if (target === '') {
      gaps.push('判定基准（需求验收标准）没有给出需求 id（`ref`）')
    } else if (db === undefined) {
      gaps.push(`判定基准（需求验收标准）指到 ${target}，但没有可读的需求台账可供核对`)
    } else {
      const requirement = readRequirement(db, target)
      if (requirement === undefined) {
        gaps.push(`判定基准引用的需求不存在：${target}（验收标准类必须指到真实存在的需求）`)
      } else {
        const criterion = textOf(ref.criterion).trim()
        if (criterion === '') {
          gaps.push(`判定基准（需求验收标准）没有给出验收标准编号（\`criterion\`）：${target} 上有 ${requirement.acceptance.length} 条可用`)
        } else if (!requirement.acceptance.some((item) => item.id === criterion)) {
          gaps.push(`判定基准引用的验收标准不属于 ${target}：${criterion}（它自己的 AC 是 ${requirement.acceptance.map((item) => item.id).join(' / ') || '（无）'}）`)
        }
      }
    }
  }
  if (kind === 'contract') {
    if (target === '') {
      gaps.push('判定基准（契约）没有给出契约 id（`ref`）')
    } else if (db === undefined) {
      gaps.push(`判定基准（契约）指到 ${target}，但没有可读的契约台账可供核对`)
    } else {
      const contract = readContract(db, target)
      if (contract === undefined) {
        gaps.push(`判定基准引用的契约不存在：${target}`)
      } else if (contract.dropped === true) {
        gaps.push(`判定基准引用的契约已作废：${target}（作废契约不参与判定）`)
      } else {
        // 「契约的成功与失败语义」是 REQ-054 的原文要求：没有失败语义的契约接不出失败路径的判定基准
        const semantics = contract.failureSemantics
        const empty = (['timeout', 'retry', 'idempotency'] as const).filter((field) => textOf(semantics?.[field]).trim() === '')
        if (semantics === undefined || empty.length > 0) {
          gaps.push(`判定基准引用的契约没有（完整的）失败语义：${target}（缺 ${empty.join(' / ') || 'failureSemantics'}）`)
        }
      }
    }
  }
  if (kind === 'baseline') {
    const hash = textOf(ref.baselineSha256).trim().toLowerCase()
    if (target === '') gaps.push('判定基准（冻结基线）没有给出基线产物路径（`ref`）')
    if (hash === '') {
      gaps.push(`判定基准（冻结基线）没有绑定基线产物哈希（\`baselineSha256\`）：${target || '（未给路径）'}`)
    } else if (!SHA256_RE.test(hash)) {
      gaps.push(`判定基准（冻结基线）的哈希不是 64 位十六进制：${ref.baselineSha256 ?? ''}（基线类必须能复算比对）`)
    } else if (workspace !== '') {
      const actual = hashArtifact(workspace, target)
      if (actual !== hash) {
        gaps.push(`判定基准（冻结基线）的哈希与现算不符：${target} 记录时 ${hash.slice(0, 12)}…，现在 ${actual.slice(0, 12)}…（基线产物已变 ⇒ 判定基准过期）`)
      }
    }
  }
  if (kind === 'expert') {
    if (textOf(ref.expert).trim() === '') {
      gaps.push('判定基准（专家判断）没有写明判断人（`expert`）—— 专家判断必须能追责')
    }
  }
  return gaps
}

/** 结果里被“独立采纳”这条判据读到的字段（REQ-053 / TASK-020）。 */
export interface AdoptableResult {
  executedBy?: string | undefined
  adoptedBy?: string | undefined
  adoptedAt?: string | undefined
  oracle?: OracleRef | undefined
}

/**
 * **一条结果是否已被独立采纳**（REQ-053 / TASK-020 的**唯一**判定入口 —— 门禁、统计、回执都读它）。
 *
 * 逐条机械核对，任何一条不过都返回 `ok:false` **并给出理由**：
 *   ① 没有**执行者** ⇒ 无从判断独立性（宁可不计入，也不把"没登记"读成"独立"）；
 *   ② 没有**采纳者 / 采纳时刻** ⇒ 还没有采纳动作（缺依据不予计入）；
 *   ③ **执行者 = 采纳者** ⇒ 自己给自己盖章（守卫用例钉的就是这条）；
 *   ④ **判定基准缺或不成立** ⇒ 走过场的用例不算通过（REQ-054）。
 *
 * 「采纳是终点」也落在本函数：它只看**这一条结果**的执行者/采纳者/判定基准，
 * 不认识"谁采纳了采纳者"这种第二层 —— 采纳不产生新的待采纳物，不形成递归。
 */
export function supportedOracle(
  store: SdoStore | undefined,
  result: AdoptableResult,
  testCase?: { oracle?: OracleRef | undefined } | undefined,
): { ok: true } | { ok: false; code: 'executor-missing' | 'not-adopted' | 'self-adoption' | 'oracle-unsupported'; detail: string } {
  const executedBy = textOf(result.executedBy).trim()
  const adoptedBy = textOf(result.adoptedBy).trim()
  if (executedBy === '') {
    return { ok: false, code: 'executor-missing', detail: '这条结果没有登记执行者（`executedBy`）—— 无从判断独立性，不予计入' }
  }
  if (adoptedBy === '' || textOf(result.adoptedAt).trim() === '') {
    return { ok: false, code: 'not-adopted', detail: `这条结果还没有被独立采纳（缺采纳者/采纳时刻）—— 执行者 ${executedBy} 的自跑结果不算通过` }
  }
  // ④ **执行者与采纳者必须不同**：机械可查的一条比较（守卫用例的两态都钉在这里）
  if (executedBy === adoptedBy) {
    return {
      ok: false,
      code: 'self-adoption',
      detail: `执行者与采纳者是同一个（${executedBy}）—— 自己执行、自己采纳不算独立采纳，不予计入`,
    }
  }
  const gaps = oracleGaps(store, result.oracle ?? testCase?.oracle)
  if (gaps.length > 0) {
    return { ok: false, code: 'oracle-unsupported', detail: `判定基准不成立：${gaps.join('；')}` }
  }
  return { ok: true }
}

export type EvidenceAuditCode =
  | 'evidence-kind-missing'
  | 'evidence-artifact-missing'
  | 'evidence-artifact-outside'
  | 'evidence-artifact-hash'
  /** detail 写法不合法（路径后面跟了说明文字）—— 产物可能确实存在，别报成「不存在」 */
  | 'evidence-artifact-detail'
  | 'evidence-command-failed'
  /** 方法产物台账（tdd.yml / contract-first.yml）里**本卡名下没有条目**（TASK-056 落点二：改读台账后仍判红，且点名） */
  | 'evidence-method-artifact-missing'

export type EvidenceAudit = { ok: true } | { ok: false; code: EvidenceAuditCode; detail: string }

/**
 * **卡上声明的"方法产物证据"**（TASK-056 落点二 / DEF-023）。
 *
 * DEF-023 的根因是**文档与实现矛盾**：工具文档把 `mutation` / `contractTest` 列为证据种类，
 * 而 `EvidenceItem.kind` 只有 `command | artifact | workspace-changes`（`src/index.ts` 还会把
 * 未知 kind 归一成 `artifact`）⇒ 卡上一写就必然被 `evidence-kind-missing` 拒收，每张 critical 卡
 * 都要白付一轮「block → 改卡 → 重新认领」。修法取 DEF-023 的**推荐项①**：这两类**不再要求
 * incoming evidence 里有该 kind**，改读**方法产物台账**（`.sdo/construction/tdd.yml` /
 * `contract-first.yml`）里**本卡名下**的条目 —— 单一真源，且台账本来就是 `sdo_test` 的正规通道。
 *
 * 为什么**不**同时给 `EvidenceItem.kind` 加这两类（方案②，报告里已说明取舍）：
 *   ① 台账才是真源，证据条目只是"回执里挂一条"；再开一类 kind 等于把同一事实记两处，
 *      两处一旦不一致（记了台账没挂证据 / 挂了证据台账没记）就要发明新的优先级规则；
 *   ② `src/index.ts` 的证据归一化分支是既有行为（未知 kind ⇒ `artifact`），动它要连带评估
 *      历史卡里所有写错的 kind，超出「只改该不该判的门槛与证据来源」的边界。
 */
function methodArtifactKinds(task: { evidenceRequired: EvidenceItem['kind'][] }): string[] {
  return (task.evidenceRequired as readonly string[]).filter((kind) => kind === 'mutation' || kind === 'contractTest')
}

/**
 * 逐类核对"方法产物证据"：命中的即为**已由台账满足**的种类。
 *
 * `store` 缺省时**报缺口**（fail-closed）并在理由里说清"拿不到台账句柄" —— 与「不因为拿不到
 * 环境就把人判红」的老纪律不冲突：这里判红的是**接线缺失**（本插件自己的调用点没传句柄），
 * 不是执行者没干活，文案里也不点执行者的名。
 */
function methodArtifactGaps(
  store: SdoStore | undefined,
  task: { id: string; evidenceRequired: EvidenceItem['kind'][] },
): string[] {
  const wanted = methodArtifactKinds(task)
  if (wanted.length === 0) return []
  const tddPath = `.sdo/${CONSTRUCTION_DIR}/${CONSTRUCTION_TDD_FILE}`
  const ctPath = `.sdo/${CONSTRUCTION_DIR}/${CONSTRUCTION_CONTRACT_FILE}`
  const missing: string[] = []
  for (const kind of wanted) {
    if (kind === 'mutation') {
      // 与 `doneGaps` 的 `tdd-mutation-missing` **同一个口径**：`killed ≥ 1` **且 `tool` 非空**
      // （空 tool 的记录证不了"用什么杀的" —— N3 评审结论）
      const killed = store === undefined
        ? 0
        : readMutations(store).filter((item) => item.task === task.id && item.tool.trim() !== '')
          .reduce((total, item) => total + item.killed, 0)
      if (killed === 0) {
        missing.push(store === undefined
          ? `mutation：没有可读的方法产物台账（${tddPath}）可供核对`
          : `mutation：${tddPath} 里没有 ${task.id} 名下 killed ≥ 1（且 tool 非空）的变异记录`)
      }
      continue
    }
    const hasTest = store === undefined ? false : readContractTests(store).some((item) => item.task === task.id)
    if (!hasTest) {
      missing.push(store === undefined
        ? `contractTest：没有可读的方法产物台账（${ctPath}）可供核对`
        : `contractTest：${ctPath} 里没有 ${task.id} 名下的契约测试记录`)
    }
  }
  return missing
}

/**
 * 证据条目里取出路径与可选哈希：`path`、`path sha256=<hex>`、`path sha256:<hex>`、`path #<hex>` 都认。
 *
 * 三种返回形态要分清：**没给哈希**（`sha256`/`invalidHash` 都空）、**给了合法哈希**（`sha256`）、
 * **写了哈希但不是 64 位十六进制**（`invalidHash`，报错时要说清是写法不对，而不是"产物不存在"）。
 */
export function parseArtifactDetail(detail: string): { path: string; sha256?: string; invalidHash?: string; annotation?: string } {
  const text = detail.trim()
  // **非锚定**：先在整串里找合法哈希。锚定（末尾 $）会让「合法哈希后面紧跟无空格说明」
  // （`… sha256=<64hex>（已通过）`）落到「非法哈希」分支 —— 那时 \S+ 一路吃到结尾，
  // 于是明明合法的哈希被报成「不是 64 位十六进制」（评审 T-3 残留变体）。
  for (const pattern of [/sha256[=:]([0-9a-fA-F]{64})/u, /#([0-9a-fA-F]{64})/u]) {
    const hit = pattern.exec(text)
    if (hit !== null) {
      const annotation = text.slice(hit.index + hit[0].length).trim()
      return {
        path: text.slice(0, hit.index).trim(),
        sha256: (hit[1] as string).toLowerCase(),
        ...(annotation === '' ? {} : { annotation }),
      }
    }
  }
  // 没有合法哈希：再看是不是「写了哈希但位数/字符不对」（同样不锚定）
  const broken = /(?:^|\s)(?:sha256[=:]|#)(\S+)/u.exec(text)
  if (broken !== null) return { path: text.slice(0, broken.index).trim(), invalidHash: broken[1] as string }
  return { path: text }
}

/** 两个哈希**首个不同的位**（1 起数）；完全相同返回 undefined。 */
function firstDifferingPosition(actual: string, said: string): number | undefined {
  const limit = Math.min(actual.length, said.length)
  for (let index = 0; index < limit; index += 1) if (actual[index] !== said[index]) return index + 1
  return actual === said ? undefined : limit + 1
}

/** 能区分的指纹：前 12 … 后 4（只打印前 12 会让「前 12 位对、尾巴错」看起来像插件坏了 —— 评审 T-2）。 */
function fingerprint(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 12)}…${hash.slice(-4)}`
}

/** 首个能对应到**真实存在文件**的前缀（把「路径后跟说明文字」讲清楚，而不是只说产物不存在）。 */
function existingPrefix(detail: string, workspace: string): string | undefined {
  const candidates: string[] = []
  for (const match of detail.matchAll(/[\s（(,;，；#]/gu)) candidates.push(detail.slice(0, match.index).trim())
  candidates.push(detail.trim())
  for (const candidate of candidates.reverse()) {
    if (candidate === '') continue
    const absolute = isAbsolute(candidate) ? candidate : resolve(workspace, candidate)
    if (existsSync(absolute) && statSync(absolute).isFile()) return candidate
  }
  return undefined
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * **`done` 回执的产物证据回显行**（DEF-013 / §3E 族 3，minor）。
 *
 * 缺陷本体（三份 re-verify 的现盘读数）：真实工具面 done（note 自述「6 处核实 + 3 条变异」）的回执
 * 只有「卡面 + 证据 2 条 + 未对账告警」，**既没有完整 64 位 sha256、也没有任何条数比对句**；
 * 唯一会绑指纹的动作（{@link auditDoneEvidence} 的现算对账）**只活在拒绝路径上** —— 一旦通过就什么都不印，
 * 于是"读者/评审者能不能自己核对这份产物"只能靠重新跑一遍工具。
 *
 * 口径（**只加回显、不动判据**）：
 *   · 这里**只算与印**：现算每条 `artifact` 证据的**完整** sha256（路径解析走 `parseArtifactDetail`
 *     这唯一出口）与**文件 mtime**；读不到就**如实标原因**，绝不因此拦下 done（fail-open，与 A2 补记同款）。
 *   · 「调用方自己写错哈希」依旧由 `evidence-artifact-hash` 拒收（批前 `fb81ff9` 已有）—— 那不是本条的成果，
 *     也不因为这里多印一行而放宽。
 */
export interface ArtifactEchoRow {
  /** 证据原文（原样回显，便于人对照） */
  detail: string
  /** 解析出的产物路径（解析不出来 = 空串） */
  path: string
  /** **现算**的完整 64 位 sha256（读不到则缺省） */
  sha256?: string | undefined
  /** 文件 mtime（ISO；读不到则缺省） */
  mtime?: string | undefined
  /** 调用方在证据里写的哈希（写了才有；成功路径上它与 `sha256` 必然相等 —— 那是 `evidence-artifact-hash` 保的） */
  declared?: string | undefined
  /** 没算出指纹的原因（缺省 = 算出来了）：`no-path` / `outside` / `missing` / `unreadable` */
  unreadable?: string | undefined
}

/**
 * **只读窄入口：现算一个工作区内的产物的指纹**（DEF-017 / §3E 族 3）。
 *
 * 缺陷本体：评审者的掩码 `deny` 里有 `bash`（跑不了 `sha256sum`），而**唯一**产出产物 sha256 的
 * `sdo_test` 也在 deny 里 ⇒ 评审者只能看 done 回执里的**截断**指纹（`e1cb2250387e…4053`），
 * "我核的是不是这份产物"无法自证。修法**不是开 `bash`**（那是把只读评审员变成能执行任意命令的角色），
 * 而是一个**只读、纯查询**的窄出口：只现算，不写台账、不落事件、不接受通配。
 *
 * 边界与既有口径一致：越出工作区 / 不存在 / 不是文件 / 读不到 ⇒ 各自一个**原因码**（文案由界面层渲染）。
 * 现算复用 {@link sha256Of}，路径代数复用与 `auditDoneEvidence` 同一套（`isAbsolute`/`resolve`/`relative`）。
 */
export type ArtifactDigest =
  | { ok: true; path: string; sha256: string; mtime: string; bytes: number }
  | { ok: false; code: 'no-path' | 'no-workspace' | 'outside' | 'missing' | 'not-file' | 'unreadable' }

export function digestArtifact(workspace: string, rawPath: string): ArtifactDigest {
  if (workspace.trim() === '') return { ok: false, code: 'no-workspace' }
  const path = rawPath.trim()
  if (path === '') return { ok: false, code: 'no-path' }
  const absolute = isAbsolute(path) ? path : resolve(workspace, path)
  if (relative(workspace, absolute).startsWith('..')) return { ok: false, code: 'outside' }
  if (!existsSync(absolute)) return { ok: false, code: 'missing' }
  if (!statSync(absolute).isFile()) return { ok: false, code: 'not-file' }
  try {
    const stat = statSync(absolute)
    return { ok: true, path, sha256: sha256Of(absolute), mtime: stat.mtime.toISOString(), bytes: stat.size }
  } catch {
    return { ok: false, code: 'unreadable' }
  }
}

export function artifactEchoRows(workspace: string, incoming: EvidenceItem[]): ArtifactEchoRow[] {
  const rows: ArtifactEchoRow[] = []
  for (const item of incoming) {
    if (item.kind !== 'artifact') continue
    const { path, sha256 } = parseArtifactDetail(item.detail)
    const row: ArtifactEchoRow = { detail: item.detail, path, ...(sha256 === undefined ? {} : { declared: sha256 }) }
    if (path === '') {
      rows.push({ ...row, unreadable: 'no-path' })
      continue
    }
    const absolute = isAbsolute(path) ? path : resolve(workspace, path)
    // 工作区之外的路径也不去读（判据 `evidence-artifact-outside` 会拒收它 —— 回显不越权）
    if (relative(workspace, absolute).startsWith('..')) {
      rows.push({ ...row, unreadable: 'outside' })
      continue
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      rows.push({ ...row, unreadable: 'missing' })
      continue
    }
    try {
      rows.push({ ...row, sha256: sha256Of(absolute), mtime: statSync(absolute).mtime.toISOString() })
    } catch {
      rows.push({ ...row, unreadable: 'unreadable' })
    }
  }
  return rows
}

/**
 * **「自述 vs 台账」的机械条数**（DEF-013 落点二）。
 *
 * 为什么只能给数字、不能替人判：自述往往写在 `note` 的**自然语言**里（真机那句是「6 处核实 + 3 条变异」）
 * ⇒ 解析散文等于把判据绑在某种写法上（判据必须语言无关、格式无关 — 长期约束）。所以这里**只数结构化条目**，
 * 把「本次自述几条」与「台账累计几条」**并列**印出来，让差额当场可辨；**判红留给别的判据**。
 */
export interface EvidenceTally {
  /** 本次 done **自述**交上来的条数 */
  selfTotal: number
  selfArtifact: number
  selfCommand: number
  selfOther: number
  /** 落盘后卡上**台账**累计条数（含更早那些回报 —— `collab.report` 是 `[...task.evidence, ...evidence]`） */
  ledgerTotal: number
  ledgerArtifact: number
}

export function evidenceTally(incoming: EvidenceItem[], ledger: EvidenceItem[]): EvidenceTally {
  const count = (items: EvidenceItem[], kind: EvidenceItem['kind']): number => items.filter((item) => item.kind === kind).length
  const selfArtifact = count(incoming, 'artifact')
  const selfCommand = count(incoming, 'command')
  return {
    selfTotal: incoming.length,
    selfArtifact,
    selfCommand,
    selfOther: incoming.length - selfArtifact - selfCommand,
    ledgerTotal: ledger.length,
    ledgerArtifact: count(ledger, 'artifact'),
  }
}

/**
 * 对账一份 `done` 证据。
 *
 * @param task 任务卡（读 `evidenceRequired` 与已挂证据）
 * @param incoming 本次交上来的证据
 * @param workspace 工作区根（`artifact` 路径相对它解析；越出工作区的路径判红）
 * @param store 台账句柄（**TASK-056 落点二**：`mutation` / `contractTest` 这两类证据要求改读
 *   `.sdo/construction/` 的方法产物台账；不给 ⇒ 这两类判红并说明"没有可读台账"，不静默放过）
 */
export function auditDoneEvidence(
  task: { id: string; evidenceRequired: EvidenceItem['kind'][]; evidence: EvidenceItem[] },
  incoming: EvidenceItem[],
  workspace: string,
  store?: SdoStore | undefined,
): EvidenceAudit {
  const all = [...task.evidence, ...incoming]
  // **TASK-056 落点二**：`mutation` / `contractTest` 不是 `EvidenceItem` 能表达的种类，
  // 因此**不参与**下面的"种类覆盖"（否则每张按文档写卡的卡都必然被拒 —— DEF-023）；
  // 它们改由 ④ 查方法产物台账判定。
  const viaLedger = new Set(methodArtifactKinds(task))
  const requiredViaEvidence = task.evidenceRequired.filter((kind) => !viaLedger.has(kind))

  // ① 种类覆盖（只覆盖 `EvidenceItem` 真能交出来的种类）
  const provided = new Set(all.map((item) => item.kind))
  const missing = requiredViaEvidence.filter((kind) => !provided.has(kind))
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'evidence-kind-missing',
      detail: `${task.id} 要求证据种类 ${requiredViaEvidence.join(' / ')}，缺 ${missing.join(' / ')}（现有：${[...provided].join(' / ') || '（空）'}）`,
    }
  }

  // ② 产物落地（只看本次交上来的；历史证据在它自己那次 done/block 时已过账）
  for (const item of incoming) {
    if (item.kind !== 'artifact') continue
    const { path, sha256, invalidHash, annotation } = parseArtifactDetail(item.detail)
    if (path === '') return { ok: false, code: 'evidence-artifact-missing', detail: 'artifact 证据没有给出产物路径（写 `相对路径` 或 `相对路径 sha256=<64 位十六进制>`）' }
    // 合法哈希之后还有文字（有没有空格都算）→ 是写法问题，讲清楚，别让人以为哈希错了
    if (annotation !== undefined) {
      return {
        ok: false,
        code: 'evidence-artifact-detail',
        detail: `artifact 的 detail 只能是「路径」或「路径 sha256=<64 位十六进制>」：${path} 与哈希都合法，但哈希之后还有「${annotation}」，会被当成路径的一部分。请把说明放进另一条 evidence（kind=command 或 workspace-changes）`,
      }
    }
    if (invalidHash !== undefined) {
      return { ok: false, code: 'evidence-artifact-hash', detail: `artifact 的哈希不是 64 位十六进制：${invalidHash}（写 sha256=<hex> 或 #<hex>；不打算给哈希就干脆不写）` }
    }
    const absolute = isAbsolute(path) ? path : resolve(workspace, path)
    const rel = relative(workspace, absolute).replace(/\\/gu, '/')
    if (rel.startsWith('..')) {
      return { ok: false, code: 'evidence-artifact-outside', detail: `artifact 路径 ${path} 在工作区之外（证据必须指向本工作区里的产物）` }
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      // T-3：最常见的原因是"路径后面又跟了说明文字"，整串被当成路径。先认出来，讲清楚怎么改。
      const lead = existingPrefix(item.detail, workspace)
      if (lead !== undefined && lead !== path) {
        const remainder = item.detail.slice(item.detail.indexOf(lead) + lead.length).trim()
        // 子情形：`路径 sha256=<合法 64 位>` **之后**再跟说明 —— 哈希本身没问题，别让文案误导用户去删它
        const hashThenProse = /^sha256[=:]([0-9a-fA-F]{64})\s*(.+)$/u.exec(remainder)
        if (hashThenProse !== null) {
          return {
            ok: false,
            code: 'evidence-artifact-missing',
            detail: `artifact 的 detail 只能是「路径」或「路径 sha256=<64 位十六进制>」：${lead} 与哈希都合法，但哈希之后还有「${(hashThenProse[2] as string).trim()}」，会被当成路径的一部分。请把说明放进另一条 evidence（kind=command 或 workspace-changes）`,
          }
        }
        return {
          ok: false,
          code: 'evidence-artifact-detail',
          detail: `artifact 的 detail 只能是「路径」或「路径 sha256=<64 位十六进制>」：${lead} 之后还有「${remainder}」，会被当成路径的一部分。请把说明放进另一条 evidence（kind=command 或 workspace-changes）`,
        }
      }
      return { ok: false, code: 'evidence-artifact-missing', detail: `artifact 证据指向的产物不存在：${path}（补真实路径，或改用 command / workspace-changes）` }
    }
    if (sha256 !== undefined) {
      const actual = sha256Of(absolute)
      if (actual !== sha256) {
        const position = firstDifferingPosition(actual, sha256)
        const where = position === undefined ? '' : `（第 ${position} 位起不同）`
        return {
          ok: false,
          code: 'evidence-artifact-hash',
          detail: `artifact 哈希不符：${path} 现算 ${fingerprint(actual)}，证据写的是 ${fingerprint(sha256)}${where}。产物改过就重算哈希（别改证据）；哈希是别处抄来的，就核对来源`,
        }
      }
    }
  }

  // ③ 命令成立
  for (const item of incoming) {
    if (item.kind !== 'command') continue
    if (item.exitCode !== undefined && item.exitCode !== 0) {
      return { ok: false, code: 'evidence-command-failed', detail: `command 证据的退出码是 ${item.exitCode}（非 0 的命令不能作为完成证据；修好重跑，或改用 block 说明卡在哪）` }
    }
  }

  // ④ **方法产物台账**（TASK-056 落点二 / DEF-023）：`mutation` / `contractTest` 只认台账，
  // 不认 evidence 条目。缺条目**照样判红**（fail-closed），并且**点名**到底缺哪一类、查的是哪个文件。
  const ledgerMissing = methodArtifactGaps(store, task)
  if (ledgerMissing.length > 0) {
    return {
      ok: false,
      code: 'evidence-method-artifact-missing',
      detail: `${task.id} 要求的方法产物证据在台账里查不到 —— ${ledgerMissing.join('；')}。`
        + '这两类由 `sdo_test action=record mutation=…` / `contract=…` 落盘（单一真源），'
        + '改用 evidence 条目交不出来（`EvidenceItem.kind` 没有这两类）',
    }
  }

  return { ok: true }
}

/* ——————————————————————— 证据随版本归档（`ADR-022` 裁决③ / `TASK-173`） ——————————————————————— */

/** 证据目录（相对 `.sdo` 根）。 */
export const EVIDENCE_DIR = 'evidence'

/**
 * 归档事件名。
 *
 * 登记进 `src/types.ts` 的 `SdoEventType`（闭合联合）的那半**不在本卡写范围** —— 与 `scrub.ts`
 * 同一处置：写侧走 `EventSink`（结构化最小接口，`Journal` 天然满足），读侧按**字形**比字符串。
 */
export const EVIDENCE_ARCHIVED_EVENT = 'evidence/archived'

/**
 * 归档的**保留口径**（数据即口径：测试、CLI、回执读同一份，不许各写一套）。
 *
 * `ADR-022` 的语义是「归档即删除大体积部分，保留 `report.md` 与必要摘要」：
 * 台账对证据的引用指向 `report.md`（所以它**任意深度**都留），摘要按"包根 + 体积上限"认
 * —— 上限不是拍出来的：超过它的多半是整棵编译产物副本，不是摘要。
 */
export interface EvidenceArchiveRules {
  /** 任意深度都保留的文件名（`report.md` 是台账引用的落点） */
  keepNames: readonly string[]
  /** 包根（深度 ≤ 2）按扩展名保留的摘要 */
  summaryExtensions: readonly string[]
  /** 摘要的体积上限（超过它就不是"摘要"） */
  summaryMaxBytes: number
  /** 归档后的目标体积（超出就在报告里标 `withinTarget: false`，不静默放过） */
  targetBytes: number
}

export const EVIDENCE_ARCHIVE_RULES: EvidenceArchiveRules = {
  keepNames: ['report.md'],
  summaryExtensions: ['md', 'txt', 'json', 'jsonl', 'yml', 'log', 'tap', 'png', 'out'],
  summaryMaxBytes: 512 * 1024,
  targetBytes: 50 * 1024 * 1024,
}

/**
 * **产品代码要读的证据原件 —— 永不被归档删除。**
 *
 * 这一条是本模块的"别删功能"：
 *   · `child-tools.jsonl` 是派发工具面的观测原件（`CHILD_FACE_SEGMENTS` 读它）；
 *   · `file-history/` 是手可编辑真源的快照史（保留策略在 `office` 层，不归归档管）；
 *   · `child-reports/` 是子代理回报原件（`CHILD_REPORT_SUBDIR` 读它）。
 * 它们也是"证据"，但**不是**任务的过程产物副本 —— 删掉等于删掉功能，不是减重。
 */
export const EVIDENCE_PROTECTED: readonly { path: string; why: string }[] = [
  { path: 'child-tools.jsonl', why: 'dispatch tool-face observation source (product reads it)' },
  { path: 'file-history', why: 'snapshot history of hand-editable truth files (product retention policy owns it)' },
  { path: 'child-reports', why: 'child agent report source (product reads it)' },
]

/** 一条保留/删除项（`why` 是**机器码**：界面层按码渲染人话，产品层不写死文案）。 */
export interface ArchiveRow {
  path: string
  bytes: number
  /** `protected` / `report` / `summary` / `in-flight-task` / `bulk` */
  why: string
}

/** 归档演练报告（批准人看这一份）。 */
export interface EvidenceArchivePlan {
  tool: string
  kind: 'evidence'
  generatedAt: string
  rules: EvidenceArchiveRules
  deleteRows: ArchiveRow[]
  keepRows: ArchiveRow[]
  refusals: { path: string; code: 'symlink' | 'unreadable' }[]
  totals: {
    beforeBytes: number
    keptBytes: number
    deletedBytes: number
    keepFiles: number
    deleteFiles: number
    targetBytes: number
    withinTarget: boolean
  }
  /** 演练语义：**没有删任何东西** */
  dryRun: true
}

/** 归档执行回执。 */
export interface EvidenceArchiveReceipt {
  tool: string
  appliedAt: string
  approvedBy: string
  deletedBytes: number
  deletedFiles: number
  keptBytes: number
  keptFiles: number
  eventSeq?: number
}

function evidenceWalk(
  dir: string,
  base: string,
  out: { path: string; bytes: number }[],
  refusals: { path: string; code: 'symlink' | 'unreadable' }[],
): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    refusals.push({ path: base === '' ? EVIDENCE_DIR : base, code: 'unreadable' })
    return
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`
    if (entry.isSymbolicLink()) {
      refusals.push({ path: rel, code: 'symlink' })
      continue
    }
    if (entry.isDirectory()) {
      evidenceWalk(resolve(dir, entry.name), rel, out, refusals)
      continue
    }
    try {
      out.push({ path: rel, bytes: statSync(resolve(dir, entry.name)).size })
    } catch {
      refusals.push({ path: rel, code: 'unreadable' })
    }
  }
}

/** 顶层 `task<N>` 目录对应的卡（**在飞**的那些不许归档 —— 它这一版还要用）。 */
function inFlightTaskOf(path: string, keepTasks: readonly string[]): string | undefined {
  const top = path.split('/')[0] ?? ''
  const hit = /^task-?(\d+)$/iu.exec(top)
  if (hit === null) return undefined
  const id = `TASK-${hit[1]}`
  return keepTasks.some((item) => item.trim().toUpperCase() === id.toUpperCase()) ? id : undefined
}

/**
 * **归档演练**：算出"哪些留、为什么留；哪些删、删多少字节"，**一个文件都不删**。
 *
 * 分类顺序（先判后不改，顺序即优先级）：
 *   ① **产品读取的原件**（{@link EVIDENCE_PROTECTED}）⇒ 留（`protected`）；
 *   ② **在飞任务**的证据目录（`keepTasks` 点名）⇒ 留（`in-flight-task`）；
 *   ③ `report.md`（任意深度）⇒ 留（`report`）；
 *   ④ 包根（深度 ≤ 2）里体积不超上限的摘要扩展名 ⇒ 留（`summary`）；
 *   ⑤ 其余 ⇒ 删（`bulk`）：`scratch/`、编译产物副本（`.ts`/`.js`/`.map`）与深拷贝整棵树的现场。
 */
export function planEvidenceArchive(
  store: SdoStore,
  options: { keepTasks?: readonly string[]; targetBytes?: number; now?: string } = {},
): EvidenceArchivePlan {
  const rules: EvidenceArchiveRules = {
    ...EVIDENCE_ARCHIVE_RULES,
    ...(options.targetBytes === undefined ? {} : { targetBytes: options.targetBytes }),
  }
  const keepTasks = options.keepTasks ?? []
  const files: { path: string; bytes: number }[] = []
  const refusals: { path: string; code: 'symlink' | 'unreadable' }[] = []
  const root = resolve(store.root, EVIDENCE_DIR)
  if (existsSync(root)) evidenceWalk(root, '', files, refusals)
  const keepRows: ArchiveRow[] = []
  const deleteRows: ArchiveRow[] = []
  for (const file of files) {
    const protectedHit = EVIDENCE_PROTECTED.find((item) => file.path === item.path || file.path.startsWith(`${item.path}/`))
    if (protectedHit !== undefined) {
      keepRows.push({ ...file, why: 'protected' })
      continue
    }
    if (inFlightTaskOf(file.path, keepTasks) !== undefined) {
      keepRows.push({ ...file, why: 'in-flight-task' })
      continue
    }
    const name = file.path.split('/').pop() ?? file.path
    if (rules.keepNames.includes(name)) {
      keepRows.push({ ...file, why: 'report' })
      continue
    }
    const depth = file.path.split('/').length
    const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
    if (depth <= 2 && file.bytes <= rules.summaryMaxBytes && rules.summaryExtensions.includes(ext)) {
      keepRows.push({ ...file, why: 'summary' })
      continue
    }
    deleteRows.push({ ...file, why: 'bulk' })
  }
  const keptBytes = keepRows.reduce((total, row) => total + row.bytes, 0)
  const deletedBytes = deleteRows.reduce((total, row) => total + row.bytes, 0)
  return {
    tool: SCRUB_TOOL,
    kind: 'evidence',
    generatedAt: options.now ?? new Date().toISOString(),
    rules,
    deleteRows,
    keepRows,
    refusals,
    totals: {
      beforeBytes: keptBytes + deletedBytes,
      keptBytes,
      deletedBytes,
      keepFiles: keepRows.length,
      deleteFiles: deleteRows.length,
      targetBytes: rules.targetBytes,
      withinTarget: keptBytes <= rules.targetBytes,
    },
    dryRun: true,
  }
}

function assertInsideEvidence(store: SdoStore, path: string): string {
  const root = resolve(store.root, EVIDENCE_DIR)
  const target = resolve(store.root, path)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ScrubError('path-outside', `archive target is outside ${EVIDENCE_DIR}/`, { path })
  }
  return target
}

function pruneEmptyDir(dir: string): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) if (entry.isDirectory()) pruneEmptyDir(resolve(dir, entry.name))
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  } catch {
    // 空目录清不掉不影响归档结果（不算失败，也不改判定）
  }
}

/**
 * **执行归档**：删掉演练里点名的 `bulk` 部分，并留一条 `evidence/archived` 审计事件。
 *
 * 三道闸与脱敏同档（缺一条就整体拒绝、一个文件都不删）：
 *   ① 批准人必须是 `human`（`approval-missing`）；
 *   ② 每个待删文件的**体积**必须与演练时一致（`hash-drift`：演练之后有人往里写，批准的不是这一版）；
 *   ③ 路径必须落在 `evidence/` 之内（`path-outside`：不跟随、也不越界删东西）。
 *
 * 事件里记**删除字节数**与**保留清单**（`ADR-022` 裁决③ 的字面要求）—— 保留清单是完整的，
 * 因为"当时留了什么"是事后审计唯一可核的对象（删掉的那些只剩这条事件能证明它存在过）。
 */
export function applyEvidenceArchive(
  store: SdoStore,
  plan: EvidenceArchivePlan,
  input: { approvedBy: string; actor?: string | undefined; journal: EventSink; now?: string | undefined },
): EvidenceArchiveReceipt {
  const approvedBy = input.approvedBy.trim()
  if (approvedBy !== 'human') {
    throw new ScrubError('approval-missing', 'user approval is required (approvedBy must be human)', { approvedBy })
  }
  const drifted: string[] = []
  for (const row of plan.deleteRows) {
    const target = assertInsideEvidence(store, `${EVIDENCE_DIR}/${row.path}`)
    if (!existsSync(target)) {
      drifted.push(row.path)
      continue
    }
    try {
      if (statSync(target).size !== row.bytes) drifted.push(row.path)
    } catch {
      drifted.push(row.path)
    }
  }
  if (drifted.length > 0) {
    throw new ScrubError('hash-drift', 'evidence changed since rehearsal; re-run the rehearsal', { paths: drifted })
  }
  let deletedBytes = 0
  const deleted: string[] = []
  for (const row of plan.deleteRows) {
    const target = assertInsideEvidence(store, `${EVIDENCE_DIR}/${row.path}`)
    rmSync(target, { force: true })
    deletedBytes += row.bytes
    deleted.push(row.path)
  }
  const root = resolve(store.root, EVIDENCE_DIR)
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) pruneEmptyDir(resolve(root, entry.name))
    }
  }
  const kept = plan.keepRows.map((row) => row.path)
  const keptBytes = plan.keepRows.reduce((total, row) => total + row.bytes, 0)
  const event = input.journal.append(
    EVIDENCE_ARCHIVED_EVENT,
    {
      tool: SCRUB_TOOL,
      approvedBy,
      deletedBytes,
      deletedFiles: deleted.length,
      keptBytes,
      keptFiles: kept.length,
      beforeBytes: plan.totals.beforeBytes,
      targetBytes: plan.totals.targetBytes,
      withinTarget: plan.totals.beforeBytes - deletedBytes <= plan.totals.targetBytes,
      rules: plan.rules,
      kept,
    },
    input.actor ?? SCRUB_TOOL,
  )
  const seq = event !== null && typeof event === 'object' && 'seq' in event ? (event as { seq: unknown }).seq : undefined
  return {
    tool: SCRUB_TOOL,
    appliedAt: input.now ?? new Date().toISOString(),
    approvedBy,
    deletedBytes,
    deletedFiles: deleted.length,
    keptBytes,
    keptFiles: kept.length,
    ...(typeof seq === 'number' ? { eventSeq: seq } : {}),
  }
}

/** 证据目录的现算体积（字节；`sdo_scrub` 的读数与 DoD 证据都用它，不许各数一遍）。 */
export function evidenceBytes(store: SdoStore): number {
  const files: { path: string; bytes: number }[] = []
  const refusals: { path: string; code: 'symlink' | 'unreadable' }[] = []
  const root = resolve(store.root, EVIDENCE_DIR)
  if (existsSync(root)) evidenceWalk(root, '', files, refusals)
  return files.reduce((total, row) => total + row.bytes, 0)
}

/** 路径分隔符归一（`evidence/` 之内的相对路径一律 `\` → `/`，与台账口径一致）。 */
export function evidencePathOf(path: string): string {
  return path.split(sep).join('/')
}
