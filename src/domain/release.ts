/**
 * 发布计划层（`.sdo/releases/<id>.yml`，`REQ-063` / `TASK-170`）：**版本＝对需求基线的一次范围声明**。
 *
 * ## 为什么字段不是权威（`AC-287`）
 *
 * 给每个实体贴一个版本标签，等于把同一件事写在**两处真源**（实体上一份、发布物上一份）：两者迟早对不上，
 * 而对不上时没有任何判据会报 —— 0.1.6 手写的「已知缺口」清单就是这么活下来的（`ADR-021` 说"必须一致"，
 * 但当时台账里没有集合可对，只能靠人保证）。所以本模块把权威收敛成**一份集合**（release 文件里的
 * `scope` / `nonScope`），实体上的 `targetVersion` / `deferredTo` 一律由集合**派生**：派生件错了能重算，
 * 权威错了只能吵。
 *
 * ## 三条硬口径
 *
 * · **标识（`AC-278`）**：发布计划一律用 `r-x.y.z`（如 `r-0.1.7`），**不得**把包版本号当主键；
 *   两者同形时必须显式写 `packageVersion` 建立映射（反例 R10：`id: 0.1.7` 且没有映射 ⇒ 判红）。
 *   允许一个包版本含多个 release：`r-0.1.7` 与 `r-0.1.7-hotfix` 都映射到 `0.1.7`。
 * · **顺延留痕（`AC-277`）**：`nonScope` 的每条都要 id + 理由 + 次数 + 批准人，批准人只认 human
 *   （`ADR-022` 裁决①：允许本版遗留的决定权全在用户，驾驶舱不得代批）。本模块只判**形状**；
 *   次数上限与"静默顺延"是 `C-73` 的活（后续卡），这里不抢。
 * · **fail-closed（规格 R8/R9）**：既不在 scope、也不在**当前** release 的 `nonScope` ⇒ 缺省归入**当前**
 *   release。缺省归入不是"没规划过所以不用管"，而是"没规划过 ⇒ 本版就得管"。
 *
 * ## 一个必须说清的派生细节：`deferredTo` 到底指向哪一版
 *
 * `nonScope` 条目的语义是「**明确不进本版**」，因此它顺延**到**的是**紧接着的下一版**：
 * 按包版本序取比登记它的那一版更新的**最近**一份 release。集合里**还没有**下一版时，
 * 只能落到**登记这次顺延的那一版**（同时给出 `deferredFrom`，两者相等即表示目标版本尚未在册）——
 * 理由是**不凭空造出版本号**：派生件写一个台账里不存在的版本，等于把猜测固化成事实。
 *
 * ## 另一个必须说清的：谁是"当前 release"
 *
 * **最新已冻结的那一版**；一份都没冻结时退回版本最高的那一版。理由见 `currentRelease`：
 * 没签字的集合只是一份草稿（`AC-276`），让它改写"在飞那一版"的判定就等于取消了签字这道闸。
 * 于是 `r-0.1.7` 已冻、`r-0.1.8` 刚起草时：当前版仍是 `0.1.7`，而 `0.1.7` 的顺延目标可以是 `0.1.8`
 * （台账里已经排了下一版 ⇒ 顺延目标写得出来）。
 *
 * ## 三条纪律（与本仓同类模块同规）
 *
 * ① **读写两侧都过形状关**：写出前不过关 ⇒ **整次拒绝**（不落半成品让别人读到）；
 *   读进来不过关 ⇒ **可读报错并点名文件与字段**（`.sdo/**\/*.yml` 是手可编辑真源，静默跳过就是让它烂在盘上）。
 * ② **只做形状，不做判据**：`C-71`（作用域闭合）/ `C-72`（缺口对账）/ `C-73`（次数上限）/ `C-75`（冻结后改集合）
 *   都不是本模块的事 —— 它们读这里的派生结果，而不是把判定塞在这里。
 * ③ **不碰工作区之外**：所有路径都经 `SdoStore` 解析（NFR-007 的路径沙箱），本模块不自己拼绝对路径。
 */
import type { Journal } from '../infra/journal.js'
import { typeNameOf, textOf } from '../infra/scalar.js'
import type { SdoStore } from '../infra/store.js'
import type { DerivedVersion, Release, ReleaseNote, ReleaseScope } from '../types.js'

/** release 文件所在子目录（相对 `.sdo/`）。 */
export const RELEASE_DIR = 'releases'

/** 顺延批准人只认这个值（`ADR-022` 裁决①：驾驶舱不得代批）。 */
export const HUMAN_APPROVER = 'human'

/**
 * `r-x.y.z` 形态（`AC-278`）。允许一个**可选**后缀（`r-0.1.7-hotfix`）—— 那是"一个包版本含多个 release"
 * 的唯一落法：文件名就是主键，同一份 id 不可能写两次，没有后缀就永远只能一对一。
 */
const RELEASE_ID = /^r-(\d+\.\d+\.\d+)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u
/** 裸包版本号形态（`0.1.7`）—— 它当主键时必须显式写 `packageVersion`（反例 R10）。 */
const BARE_VERSION = /^\d+\.\d+\.\d+$/u
/** `packageVersion` 的取值形态：版本号（允许预发布后缀）。 */
const VERSION_TEXT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
/** `scope` 的两个集合键（顺序即报错顺序，便于对账）。 */
const SCOPE_KEYS = ['requirements', 'acceptance'] as const

/** 读一串"实体 id"：非空字符串（YAML 里的数字/布尔按口径字符串化）；不是数组则返回 undefined。 */
function readIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => textOf(item).trim()).filter((item) => item !== '')
}

/** 这份 release 对应的包版本：显式映射优先，否则从 `r-x.y.z` 里取（两种都合法，`AC-278`）。 */
export function packageVersionOf(release: Release): string {
  const mapped = textOf(release.packageVersion).trim()
  if (mapped !== '') return mapped
  const matched = RELEASE_ID.exec(textOf(release.id).trim())
  return matched?.[1] ?? ''
}

/**
 * 形状问题清单：空数组＝合法。
 *
 * 入参是 **unknown**（不是 `Release`）：这些文件是**人写的 YAML**，读出来的东西在判过之前什么都不是 ——
 * 让签名接受 `Release` 会诱使调用方先 `as Release` 一把，于是"缺字段"永远走不到这里。
 */
export function releaseShapeProblems(input: unknown): string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [`release 必须是映射（形如 { id, scope, ... }），读到的是 ${typeNameOf(input)}`]
  }
  const record = input as Record<string, unknown>
  const problems: string[] = []

  // ① id（`AC-278`）
  const id = textOf(record.id).trim()
  if (id === '') {
    problems.push('id 必填（形态：r-x.y.z，如 r-0.1.7）')
  } else if (!RELEASE_ID.test(id) && !BARE_VERSION.test(id)) {
    problems.push(`id「${id}」形态不对：应为 r-x.y.z（如 r-0.1.7）；裸包版本号（如 0.1.7）也认，但那时必须写 packageVersion 映射`)
  }

  // ② packageVersion 映射（`AC-278`；反例 R10）
  const mapped = textOf(record.packageVersion).trim()
  const mappedWritten = record.packageVersion !== undefined && record.packageVersion !== null
  if (mappedWritten && mapped === '') problems.push('packageVersion 写了就必须是非空版本号（如 0.1.7）')
  else if (mapped !== '' && !VERSION_TEXT.test(mapped)) problems.push(`packageVersion「${mapped}」不是版本号形态（如 0.1.7）`)
  if (BARE_VERSION.test(id) && mapped === '') {
    problems.push('id 取了包版本号形态，必须显式写 packageVersion 建立映射（AC-278 / 反例 R10）')
  }

  // ③ scope（本版范围的集合）＋ 与 nonScope 的自相矛盾
  const scopeIds = new Set<string>()
  const scope = record.scope
  if (scope === null || scope === undefined || typeof scope !== 'object' || Array.isArray(scope)) {
    problems.push('scope 必填，且必须是 { requirements: [...], acceptance: [...] } 两个集合')
  } else {
    const scopeRecord = scope as Record<string, unknown>
    for (const key of SCOPE_KEYS) {
      const raw = scopeRecord[key]
      if (!Array.isArray(raw)) {
        problems.push(`scope.${key} 必须是数组（本版范围的集合），读到的是 ${typeNameOf(raw)}`)
        continue
      }
      raw.forEach((item, index) => {
        if (textOf(item).trim() === '') problems.push(`scope.${key}[${index}] 必须是非空字符串（实体 id）`)
      })
      const ids = readIdList(raw) ?? []
      const duplicated = [...new Set(ids.filter((item, index) => ids.indexOf(item) !== index))]
      if (duplicated.length > 0) problems.push(`scope.${key} 有重复项：${duplicated.join('、')}（一个实体在一份 release 里只算一次）`)
      for (const item of ids) scopeIds.add(item)
    }
  }

  // ④ nonScope（顺延登记：`AC-277` 的留痕面，`C-72` 的对账面）
  const notes = record.nonScope
  const notedIds: string[] = []
  if (notes !== undefined && notes !== null) {
    if (!Array.isArray(notes)) {
      problems.push(`nonScope 必须是数组（每条＝一次顺延登记），读到的是 ${typeNameOf(notes)}`)
    } else {
      notes.forEach((note, index) => {
        const where = `nonScope[${index}]`
        if (note === null || typeof note !== 'object' || Array.isArray(note)) {
          problems.push(`${where} 必须是映射 { id, reason, deferCount, approvedBy }，读到的是 ${typeNameOf(note)}`)
          return
        }
        const entry = note as Record<string, unknown>
        const entryId = textOf(entry.id).trim()
        if (entryId === '') problems.push(`${where}.id 必填（被顺延的实体 id）`)
        else notedIds.push(entryId)
        if (textOf(entry.reason).trim() === '') problems.push(`${where}.reason 必填（顺延必须留理由，不许静默顺延）`)
        const count = entry.deferCount
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
          problems.push(`${where}.deferCount 必须是 ≥0 的整数（已顺延次数；是次数就一定是整数）`)
        }
        if (textOf(entry.approvedBy).trim() !== HUMAN_APPROVER) {
          problems.push(`${where}.approvedBy 只能是 ${HUMAN_APPROVER}（允许本版遗留的决定权在用户，驾驶舱不得代批）`)
        }
      })
      const duplicated = [...new Set(notedIds.filter((item, index) => notedIds.indexOf(item) !== index))]
      if (duplicated.length > 0) problems.push(`nonScope 有重复项：${duplicated.join('、')}（同一实体在一份 release 里只能有一条顺延登记）`)
      const conflicted = notedIds.filter((item) => scopeIds.has(item))
      if (conflicted.length > 0) {
        problems.push(`同一实体既在 scope 又在 nonScope：${[...new Set(conflicted)].join('、')}（一份 release 里「进本版」和「不进本版」不能同时成立）`)
      }
    }
  }

  // ⑤ 冻结：人签 + 那一刻的 journal 序号（`AC-276`）。两个字段要么都在、要么都不在
  const hasSeq = record.frozenAtSeq !== undefined && record.frozenAtSeq !== null
  const hasBy = record.frozenBy !== undefined && record.frozenBy !== null
  if (hasSeq !== hasBy) {
    if (!hasSeq) problems.push('frozenAtSeq 必填：冻结要记「那一刻的 journal 序号」（冻结后两个字段同时存在）')
    if (!hasBy) problems.push('frozenBy 必填：冻结是一次人签（只认 human），冻结后两个字段同时存在')
  }
  if (hasSeq) {
    const seq = record.frozenAtSeq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
      problems.push('frozenAtSeq 必须是 ≥1 的整数（journal 序号从 1 开始）')
    }
  }
  if (hasBy && textOf(record.frozenBy).trim() !== HUMAN_APPROVER) {
    problems.push(`frozenBy 只能是 ${HUMAN_APPROVER}（冻结是一次人签动作，AC-276）`)
  }

  return problems
}

/** 把**已过形状关**的映射收成 `Release`（可选字段没写就不带出来，别留 `undefined` 键）。 */
function normalizeRelease(record: Record<string, unknown>): Release {
  const id = textOf(record.id).trim()
  const mapped = textOf(record.packageVersion).trim()
  const scopeRecord = (record.scope ?? {}) as Record<string, unknown>
  const scope: ReleaseScope = {
    requirements: readIdList(scopeRecord.requirements) ?? [],
    acceptance: readIdList(scopeRecord.acceptance) ?? [],
  }
  const rawNotes = Array.isArray(record.nonScope) ? record.nonScope : []
  const nonScope: ReleaseNote[] = rawNotes
    .filter((note): note is Record<string, unknown> => note !== null && typeof note === 'object' && !Array.isArray(note))
    .map((note) => ({
      id: textOf(note.id).trim(),
      reason: textOf(note.reason).trim(),
      deferCount: Number(note.deferCount),
      approvedBy: textOf(note.approvedBy).trim(),
    }))
  const seq = typeof record.frozenAtSeq === 'number' ? record.frozenAtSeq : undefined
  const by = textOf(record.frozenBy).trim()
  return {
    id,
    ...(mapped === '' ? {} : { packageVersion: mapped }),
    scope,
    nonScope,
    ...(seq === undefined ? {} : { frozenAtSeq: seq }),
    ...(by === '' ? {} : { frozenBy: by }),
  }
}

/**
 * 写一份 release：形状不合法**整次拒绝**（不许落半成品让别处读到）。
 *
 * 写盘只走 `SdoStore`（原子写 + 权限收紧），并在 `journal` 留一条 `release/written` ——
 * 冻结与否要能从真源里数出来（"这份集合是谁在什么时候落下的"）。
 */
export function writeRelease(store: SdoStore, journal: Journal, release: Release): Release {
  const problems = releaseShapeProblems(release)
  const id = textOf(release?.id).trim()
  const where = `${RELEASE_DIR}/${id === '' ? '?' : id}.yml`
  if (problems.length > 0) throw new Error(`release 形状不合法：${problems.join('；')}（文件：${where}）`)
  const normalized = normalizeRelease(release as unknown as Record<string, unknown>)
  store.ensureLayout([RELEASE_DIR])
  store.writeYaml([RELEASE_DIR, `${normalized.id}.yml`], { release: normalized })
  journal.append('release/written', {
    id: normalized.id,
    packageVersion: packageVersionOf(normalized),
    requirements: normalized.scope.requirements.length,
    acceptance: normalized.scope.acceptance.length,
    nonScope: (normalized.nonScope ?? []).length,
    frozen: normalized.frozenBy === HUMAN_APPROVER,
  })
  return normalized
}

/**
 * 读一份 release：文件不在 ⇒ `undefined`；在盘上但形状不合法 ⇒ **可读报错**（点名文件与每个字段）。
 *
 * 为什么读侧也要报错而不是"跳过这份"：`.sdo/**\/*.yml` 是**手可编辑真源**，静默跳过等于让写错的那份
 * 永远不参与判定 —— 门禁照样绿，用户还以为它算过了（`DEF-003` / `R-14` 族的同一个病）。
 */
export function readRelease(store: SdoStore, id: string): Release | undefined {
  const key = textOf(id).trim()
  const where = `${RELEASE_DIR}/${key}.yml`
  const raw = store.readYaml<{ release?: unknown }>(RELEASE_DIR, `${key}.yml`)
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`release 文件读不出映射（文件：${where}）`)
  }
  const value = (raw as Record<string, unknown>).release
  if (value === undefined || value === null) {
    throw new Error(`release 文件缺少顶层 release 键（文件：${where}）`)
  }
  const problems = releaseShapeProblems(value)
  if (problems.length > 0) throw new Error(`release 形状不合法：${problems.join('；')}（文件：${where}）`)
  const release = normalizeRelease(value as Record<string, unknown>)
  if (release.id !== key) {
    throw new Error(`release 的 id 与文件名不一致：文件里写的是「${release.id}」（文件：${where}；文件名就是主键）`)
  }
  return release
}

/** 目录里的 release id（按文件名，字典序）。 */
export function listReleaseIds(store: SdoStore): string[] {
  return store
    .listNames(RELEASE_DIR)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => name.slice(0, -'.yml'.length))
    .sort()
}

/** 目录里的全部 release（按 id 字典序；读不动的那份会**报错**，不会被静默跳过）。 */
export function listReleases(store: SdoStore): Release[] {
  const out: Release[] = []
  for (const id of listReleaseIds(store)) {
    const release = readRelease(store, id)
    if (release !== undefined) out.push(release)
  }
  return out
}

/** 版本号语义序（逐段数字比较）—— 字典序会把 0.1.10 排在 0.1.9 前面。 */
function compareVersion(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 新的在前（同包版本时按 id 逆序，保证"当前 release"是确定的，不靠入参顺序）。 */
function newestFirst(releases: readonly Release[]): Release[] {
  return [...releases].sort((left, right) => {
    const byVersion = compareVersion(packageVersionOf(right), packageVersionOf(left))
    if (byVersion !== 0) return byVersion
    if (left.id === right.id) return 0
    return left.id < right.id ? 1 : -1
  })
}

/** 冻结过没有：签字人 + 那一刻的序号都在（`AC-276`：冻结是一次**人签**动作）。 */
function isFrozen(release: Release): boolean {
  return textOf(release.frozenBy).trim() === HUMAN_APPROVER && typeof release.frozenAtSeq === 'number'
}

/**
 * 当前 release＝**最新已冻结**的那一版；一份都没冻结时退回版本最高的那一版。
 *
 * 为什么不是"版本最高的那一版"：`AC-276` 说得很清楚 —— 集合的权威来自**冻结那次人签**，
 * 没签字的集合只是一份草稿（反例 R12 就是拿它判红的）。若把"刚起草、还没签"的下一版当成当前版，
 * 那么上一版的 `nonScope` 立刻失效、顺延记录立刻"到账"，等于**用一份草稿改写了在飞版本的判定**。
 * `AC-275` 的场景（旧版已冻结、新版待开工）正是要靠这条区分：**签字的那一版才是当前版**，
 * 它的 `nonScope` 才是本版缺口清单的对账面（`C-72`）。
 */
export function currentRelease(releases: readonly Release[]): Release | undefined {
  const ordered = newestFirst(releases)
  return ordered.find((release) => isFrozen(release)) ?? ordered[0]
}

/**
 * 比 `release` **更新的最近一版**（没有则 `undefined`）。
 *
 * 用途：`nonScope` 说的是「明确不进本版」⇒ 顺延**到**的是紧接着的下一版。集合里还没有下一版时
 * 不许凭空造版本号，由调用方落到"登记它那一版"并说清（见文件头的派生细节）。
 */
function nextVersionAfter(ordered: readonly Release[], release: Release): Release | undefined {
  const at = packageVersionOf(release)
  let found: Release | undefined
  for (const candidate of ordered) {
    if (compareVersion(packageVersionOf(candidate), at) > 0) found = candidate
    else break
  }
  return found
}

function inScope(release: Release, entityId: string): boolean {
  const scope = release.scope
  if (scope === null || scope === undefined) return false
  return scope.requirements.includes(entityId) || scope.acceptance.includes(entityId)
}

/**
 * 求某个实体的版本归属（**派生**，`AC-287`）。权威是 release 的集合，实体上的字段只能被算出来。
 *
 * 顺序即优先级：
 *  ① 任一 release 的 `scope` 里有它 ⇒ `targetVersion` = 那一版的包版本（**新的优先**：同一实体被带进
 *    更晚那一版的 scope，说明它还欠着那一版；旧的 scope 是历史声明，历史不重写、也不该覆盖新的）；
 *  ② **当前** release 的 `nonScope` 里有它 ⇒ 顺延：`deferredTo` = 顺延到的那一版（紧接着的下一版；
 *    集合里还没有下一版时落到登记它的那一版），并带 `deferredFrom` / 理由 / 批准人；
 *  ③ 其余（含"只在**旧** release 的 nonScope 里"）⇒ `targetVersion` = **当前** release，标 `failClosed`
 *    （规格 R8/R9）。旧顺延**不许**长期把实体挡在判定之外：它的目标版本就是当前版，到账了就该进判定。
 *  ④ 一份 release 都没有 ⇒ `unknown`（**显式说不知道**，让判据 fail-closed，而不是当它属于本版）。
 *
 * 为什么 `nonScope` 只认**当前**那一版：`nonScope` 的语义是「明确不进本版」，而 `C-72` 要求它与
 * **本版**的缺口清单恰好相等 ⇒ 判定"本版要不要管它"只能由本版的集合说话。若认所有历来的顺延，
 * 一条旧记录就能把实体永久挡在判定之外 —— 那正是 `C-73` 要判红的"静默顺延"。
 */
export function deriveFor(releases: readonly Release[], entityId: string): DerivedVersion {
  const id = textOf(entityId).trim()
  const ordered = newestFirst(releases)
  const current = currentRelease(releases)
  if (current === undefined) return { unknown: true }

  for (const release of ordered) {
    if (inScope(release, id)) return { targetVersion: packageVersionOf(release) }
  }

  const currentNotes = current.nonScope ?? []
  const note = currentNotes.find((item) => textOf(item.id).trim() === id)
  if (note !== undefined) {
    const next = nextVersionAfter(ordered, current)
    return {
      deferredTo: packageVersionOf(next ?? current),
      deferredFrom: packageVersionOf(current),
      deferReason: textOf(note.reason).trim(),
      deferApprovedBy: textOf(note.approvedBy).trim(),
    }
  }

  return { targetVersion: packageVersionOf(current), failClosed: true }
}

/** 当前 release 的顺延集合（`C-72` 的对账面：`nonScope` 的 id 集合）。 */
export function deferredIdsOf(release: Release): string[] {
  return [...new Set((release.nonScope ?? []).map((note) => textOf(note.id).trim()).filter((item) => item !== ''))]
}
