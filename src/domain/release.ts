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
 *   注意这一条**只覆盖"从没规划过"**：「只在旧版 `nonScope` 里、且顺延目标已到账」是另一类，
 *   另给独立标记（见下文『`failClosed` 只表「没规划过」』）。
 *
 * ## 一个必须说清的派生细节：`deferredTo` 只在目标版本**在册**时才有值
 *
 * `nonScope` 条目的语义是「**明确不进本版**」，因此它顺延**到**的是**紧接着的下一版**：
 * 按包版本序取比登记它的那一版更新的**最近**一份 release。集合里**还没有**下一版时，
 * `deferredTo` **留空**，另给 `deferredTargetKnown: false`（`REV-076` findingIndex 第 2 条）。
 *
 * 旧实现把 `deferredTo` 落回**登记它的那一版**，靠 `deferredTo === deferredFrom` 暗示"目标还未在册" ——
 * 那是把**三态**压成两态：下游读到 `deferredTo: 0.1.7` 时分不清「顺延到 0.1.7」（＝顺延到**本版**，
 * 与 `nonScope` 的「明确不进本版」直接矛盾）与「目标版本尚未在册」。现在三态各自可读：
 * · `deferredTo` 有值 ⇒ 目标版本**在册**（值就是目标版）；
 * · `deferredTo` 留空 + `deferredTargetKnown: false` ⇒ **目标版本尚未在册**（`deferredFrom` 仍点名登记版）；
 * · 两个键都没有 ⇒ 这个实体不涉及顺延。
 *
 * 仍然**不凭空造出版本号**：派生件不写台账里不存在的版本（那等于把猜测固化成事实），只是改成
 * **显式说"不知道"**，让判据能据此 fail-closed。
 *
 * ## 另一个必须说清的：`failClosed` 只表「没规划过」，不兼表「顺延到账」
 *
 * `failClosed: true`（`REV-076` findingIndex 第 3 条）只表示「**当前** release 的集合没点名它」：
 * 既不在任何 scope、也不在当前版的 `nonScope`，且没有**已到账**的旧顺延。
 * 「只在**旧版** `nonScope` 里、且顺延目标已到账」是**另一类**：它**规划过**，顺延目标也到账了
 * ⇒ 同样归入当前版参与判定，但另给 `landedFrom`（登记那次顺延的那一版的包版本）。
 *
 * 两类**不许**共用一个标记：把"顺延到账"混进"未规划"，`C-71` 的点名就失去了意义
 * （规格 §3.1：作用域内＝当前版 scope ∪ 缺省归入者 ∪ 顺延到账者，回执里后两类要能**分开点名**）。
 *
 * ## 另一个必须说清的：谁是"当前 release"
 *
 * **最新已冻结的那一版**；一份都没冻结时退回版本最高的那一版。理由见 `currentRelease`：
 * 没签字的集合只是一份草稿（`AC-276`），让它改写"在飞那一版"的判定就等于取消了签字这道闸。
 * 于是 `r-0.1.7` 已冻、`r-0.1.8` 刚起草时：当前版仍是 `0.1.7`，而 `0.1.7` 的顺延目标可以是 `0.1.8`
 * （台账里已经排了下一版 ⇒ 顺延目标写得出来）。
 *
 * ## 顺延留痕 / 次数上限 / 冻结人签：**判定核心**在本模块（`TASK-176`）
 *
 * 形状关（`releaseShapeProblems`）只管"字段在不在、形态对不对"；**留痕与签字的判定**是另一层，
 * 也放在本模块：`deferTraceFindings`（顺延是否有留痕、次数有没有超上限）与 `freezeTraceFindings`
 * （集合有没有人签、冻结后有没有被绕过 `change` 改过）。理由只有一条 —— 这两层判定的输入
 * **恰好就是本模块的派生结果与真源事件**（`currentRelease` / `deriveFor` / `journal` 里的
 * `release/written`、`question/answered`、`change/decided`）。把它们塞进门禁模块，等于让门禁
 * 自己再抄一份"谁是当前版、谁在旧版 scope 里"的口径 —— 两份口径迟早分叉，而分叉时没有任何判据会报。
 *
 * **不在本模块的**：判据身份（`C-7x` 的 id、`check` 键、中文 desc 该写进流程数据）与门禁挂载 ——
 * 那属于流程数据与 `gates.ts`（另一张卡）。本模块只交出**读数**：`kind`（机器面）+ 点名（人读面）。
 *
 * 四条硬口径与各自的边界：
 * · **次数上限**（`AC-277`）：只判**当前版**的顺延登记 —— 历史版本里的次数是既成事实，重判它
 *   只会让台账永久红（历史不重写）；
 * · **静默顺延**（`AC-277` 反例）：某实体曾被**已冻结**的旧版 `scope` 点名，而当前版集合一个字都
 *   没提它 ⇒ 判红。三路豁免都必须显式给：已终结（做完了，不是顺延）、真源里有点名的顺延记录
 *   （`release/deferred` 一类事件）、或它其实还在当前版集合里；
 * · **冻结是人签**（`AC-276`）：当前版的集合必须带 `frozenBy: human` + `frozenAtSeq`；而
 *   `frozenAtSeq` 是一句**可核对**的声明 —— 那一刻在真源里必须是一次人签（带签字的落盘，
 *   或用户答的那道签字题）。手填一个签字过不了这一关；
 * · **冻结后改集合**（`AC-276` 后半）：现盘条数与"最后一次带签字的落盘"不一致、且冻结之后没有
 *   已决策的变更 ⇒ 判红。**已知边界**（写下来，免得下一个人以为它无所不包）：`release/written`
 *   事件只带**条数**不带 id 集合（事件字段面被 `test/m213.test.ts` 的 `M213-09` 钉死），所以
 *   "删一条、加一条、条数不变"这一种改法**核不到**。要收紧得先扩事件字段面，那会动到那份守卫。
 *
 * ## 三条纪律（与本仓同类模块同规）
 *
 * ① **读写两侧都过形状关**：写出前不过关 ⇒ **整次拒绝**（不落半成品让别人读到）；
 *   读进来不过关 ⇒ **可读报错并点名文件与字段**（`.sdo/**\/*.yml` 是手可编辑真源，静默跳过就是让它烂在盘上）。
 * ② **形状与判定分开写，但都在本模块**：`C-71`（作用域闭合）/ `C-72`（缺口对账）读这里的派生结果
 *   而**不在**这里判定（它们各有落点）；`C-73`（次数上限）/ `C-75`（冻结后改集合）的**判定核心**
 *   在下方两个 `*TraceFindings` 里，门禁只负责把读数挂上去。
 * ③ **不碰工作区之外**：所有路径都经 `SdoStore` 解析（NFR-007 的路径沙箱），本模块不自己拼绝对路径。
 */
import type { Journal } from '../infra/journal.js'
import { typeNameOf, textOf } from '../infra/scalar.js'
import type { SdoStore } from '../infra/store.js'
import type { DerivedVersionDetail, JournalEvent, Release, ReleaseNote, ReleaseScope } from '../types.js'

/** release 文件所在子目录（相对 `.sdo/`）。 */
export const RELEASE_DIR = 'releases'

/** 顺延批准人只认这个值（`ADR-022` 裁决①：驾驶舱不得代批）。 */
export const HUMAN_APPROVER = 'human'

/**
 * `deriveFor` 的返回形状＝`src/types.ts` 的 `DerivedVersionDetail`（基形状 `DerivedVersion` 加上两处
 * 显式区分标记 `deferredTargetKnown` / `landedFrom`；为什么必须分开写在那个接口上，这里不重述）。
 *
 * 为什么类型落在 `types.ts` 而不是本文件：只按基形状标注的消费方也要看见这两个字段 —— 类型留在实现模块里，
 * 消费方拿到派生结果时类型面就是残缺的（本卡把上一轮临时挂在这里的接口收进了通用面）。
 */

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

/**
 * 目录里的 release id，顺序＝**文件名序**（字典序），**不是版本语义序**（`r-0.1.10` 会排在 `r-0.1.9`
 * 前面）。名字把口径写进签名，因为下游拿到一个"看起来像按版本排好"的数组最容易踩的坑就是这个；
 * 要版本语义序请走 `currentRelease` / `deriveFor`（它们内部用 `compareVersion` 重排，不依赖入参顺序）。
 */
export function listReleaseIdsByName(store: SdoStore): string[] {
  return store
    .listNames(RELEASE_DIR)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => name.slice(0, -'.yml'.length))
    .sort()
}

/**
 * 目录里的全部 release，顺序同样＝**文件名序**（沿用 `listReleaseIdsByName`），**不表示版本先后**。
 *
 * 读不动的那份会**报错**（点名文件与字段），不会被静默跳过：`.sdo/**\/*.yml` 是手可编辑真源，
 * 静默跳过等于让它永远不参与判定。
 */
export function listReleases(store: SdoStore): Release[] {
  const out: Release[] = []
  for (const id of listReleaseIdsByName(store)) {
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
 * 不许凭空造版本号 ⇒ 调用方让 `deferredTo` **留空**并给 `deferredTargetKnown: false`
 * 说清"目标未在册"（见文件头的派生细节）。
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

/**
 * 「只在**旧版** `nonScope` 里、且顺延目标已到账」时，点名**登记那次顺延的是哪一版**（`REV-076` #3 的第②类）。
 *
 * 为什么"已到账"不需要再查一次台账：登记它的那一版**严格早于**当前版 ⇒ 它顺延到的"紧后下一版"必然
 * 已在册（当前版本身或更早的那一版就落在那个位置），目标版本不会落空。于是这一类的判据只有一条：
 * **登记版 < 当前版**。
 *
 * 两处边界（都不算"已到账"，落回未规划的 fail-closed）：
 * · 登记在**同版本的另一份 release** 里（`r-0.1.7-hotfix` 与当前版 `r-0.1.7`）—— 它既不是旧版、
 *   也不是当前版；只有当前版的那一份集合在说话（与"草案不算数"同一条理由）；
 * · 登记在**更新但未冻结的草案**里 —— 草稿的顺延还没到账（`AC-276`：没签字的集合不改写当前版判定）。
 */
function landedRegistration(ordered: readonly Release[], current: Release, entityId: string): string | undefined {
  const at = packageVersionOf(current)
  for (const candidate of ordered) {
    if (compareVersion(packageVersionOf(candidate), at) >= 0) continue
    if ((candidate.nonScope ?? []).some((item) => textOf(item.id).trim() === entityId)) {
      return packageVersionOf(candidate)
    }
  }
  return undefined
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
 *  ② **当前** release 的 `nonScope` 里有它 ⇒ 顺延：`deferredTo` = 紧接着的下一版，**没有下一版时留空**
 *    并给 `deferredTargetKnown: false`（`REV-076` #2），同时带 `deferredFrom` / 理由 / 批准人；
 *  ③ **只在旧版** `nonScope` 里（登记版严格早于当前版，其顺延目标必然已到账）⇒ `targetVersion` = **当前**
 *    release，并给 `landedFrom`＝登记那次顺延的包版本（`REV-076` #3 的第②类：规划过且到账）；
 *  ④ 其余 ⇒ `targetVersion` = **当前** release，标 `failClosed`（规格 R8/R9）——**这一支才是"从没规划过"**；
 *  ⑤ 一份 release 都没有 ⇒ `unknown`（**显式说不知道**，让判据 fail-closed，而不是当它属于本版）。
 *
 * ③ 与 ④ **不许**并成一个标记：前者"规划过且顺延已到账"，后者"从没规划过"，`C-71` 的点名要能分开
 * （规格 §3.1：作用域内＝scope ∪ 缺省归入者 ∪ 顺延到账者）。
 *
 * 为什么 `nonScope` 只认**当前**那一版：`nonScope` 的语义是「明确不进本版」，而 `C-72` 要求它与
 * **本版**的缺口清单恰好相等 ⇒ 判定"本版要不要管它"只能由本版的集合说话。若认所有历来的顺延，
 * 一条旧记录就能把实体永久挡在判定之外 —— 那正是 `C-73` 要判红的"静默顺延"。
 */
export function deriveFor(releases: readonly Release[], entityId: string): DerivedVersionDetail {
  const id = textOf(entityId).trim()
  const ordered = newestFirst(releases)
  const current = currentRelease(releases)
  if (current === undefined) return { unknown: true }

  for (const release of ordered) {
    if (inScope(release, id)) return { targetVersion: packageVersionOf(release) }
  }

  const currentVersion = packageVersionOf(current)
  const currentNotes = current.nonScope ?? []
  const note = currentNotes.find((item) => textOf(item.id).trim() === id)
  if (note !== undefined) {
    const next = nextVersionAfter(ordered, current)
    return {
      // 还没有下一版 ⇒ **留空**：不许把"目标未在册"写成"顺延到本版"（`REV-076` #2 的双义）
      ...(next === undefined ? {} : { deferredTo: packageVersionOf(next) }),
      deferredTargetKnown: next !== undefined,
      deferredFrom: currentVersion,
      deferReason: textOf(note.reason).trim(),
      deferApprovedBy: textOf(note.approvedBy).trim(),
    }
  }

  const landedFrom = landedRegistration(ordered, current, id)
  if (landedFrom !== undefined) return { targetVersion: currentVersion, landedFrom }

  return { targetVersion: currentVersion, failClosed: true }
}

/** 当前 release 的顺延集合（`C-72` 的对账面：`nonScope` 的 id 集合）。 */
export function deferredIdsOf(release: Release): string[] {
  return [...new Set((release.nonScope ?? []).map((note) => textOf(note.id).trim()).filter((item) => item !== ''))]
}

/* ————————————————————————————————————————————————————————————————————————————————
 * 顺延留痕与次数上限（`AC-277`）、冻结人签与冻结后改集合（`AC-276`）：**判定核心**。
 *
 * 两个函数都只**读**（不改台账、不写盘、不改入参），输出是`读数`而不是"抛错"：
 * 判红要一次把**所有**红的项点名出来（一次只报第一条，用户就得来回跑 N 遍）。
 * 抛错那条路留给**形状**（`releaseShapeProblems` / `readRelease`）：形状坏掉的集合连判都不该判。
 * ———————————————————————————————————————————————————————————————————————————————— */

/**
 * 顺延次数上限的**缺省值**（`AC-277`：次数有上限，超过即判红并要求用户裁决）。
 *
 * 为什么缺省是 2 而不是"不限"：没有上限的顺延等于"无限期拖"，而拖期自己不会报警；第 3 次顺延
 * 已经不是"再等一版"的容忍范围 —— 那时该由人重新决定它到底进不进本版（进本版 / 明确放弃 /
 * 改上限本身），模型不得自行放宽。项目可在 `.sdo/config.yml` 的 `release.deferLimit` 里声明自己的上限。
 */
export const DEFAULT_DEFER_LIMIT = 2

/**
 * 一条判红读数。
 *
 * `kind` 是**机器面**（判据只读它 ⇒ 语言无关），`detail` 是**人读面**（点名到实体 id 与条数）。
 * 为什么不是一个布尔：判红要能回答"红在哪、该找谁"，把六种截然不同的红压成一个 `false`
 * 会让回执失去可操作性（`C-63` / `C-64` 的点名口径同此）。
 */
export interface ReleaseTraceFinding {
  kind:
    /** 顺延次数超上限（`AC-277`）：必须由用户裁决，不是模型能自己放宽的事。 */
    | 'defer-count-over-limit'
    /** 静默顺延（`AC-277` 反例）：只从范围里消失，没有任何顺延记录。 */
    | 'defer-silent'
    /** 当前版的集合没有任何人签（`AC-276`）：模型自己写的集合不算权威。 */
    | 'collections-unsigned'
    /** 有人签字，但签字人不是 human（`AC-276`）：驾驶舱/模型不得代批。 */
    | 'signature-not-human'
    /** 冻结序号在真源里核不到那一次人签（`AC-276`）：`frozenAtSeq` 是声明，不是装饰。 */
    | 'freeze-unwitnessed'
    /** 冻结之后集合被改过，且没有走已决策的变更（`AC-276` 后半）。 */
    | 'collections-rewritten-after-freeze'
  /** 点名对象：顺延面是**实体 id**，冻结面是 **release id**。 */
  subjectId: string
  /** 人读的一句话（点名到 id 与条数；**不含**判据 id —— 判据身份属于流程数据）。 */
  detail: string
  /** 超上限的那次顺延 ⇒ **必须由用户裁决**。 */
  needsUserDecision?: boolean | undefined
  /** 已顺延次数（只在次数面上给）。 */
  deferCount?: number | undefined
  /** 判定时用的上限（只在次数面上给：回执要说清"按哪个上限判的"）。 */
  limit?: number | undefined
  /** 登记那次顺延的包版本（只在静默顺延面上给：它是从哪一版消失的）。 */
  fromVersion?: string | undefined
}

/** 事件负载（`journal` 的 `data` 是 `Record<string, unknown>`；直接点取会到处是 `unknown`）。 */
function eventData(event: JournalEvent): Record<string, unknown> {
  const data = event.data
  return data === null || typeof data !== 'object' || Array.isArray(data) ? {} : data
}

/** 事件里记的条数（缺字段给 -1：与"记了 0 条"区分开，别让漏写冒充成空集）。 */
function recordedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : -1
}

/** 上限规范化：非整数/负数/未给 ⇒ 退回 `DEFAULT_DEFER_LIMIT`（坏值一律往**严格**那一侧退）。 */
function normalizeLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_DEFER_LIMIT
}

/**
 * `.sdo/config.yml` 里的 `release.deferLimit`（**项目声明**，`AC-241` 口径：判据与项目无关，
 * 阈值由项目声明）。没声明、不是整数、或写了负数 ⇒ 退回 `DEFAULT_DEFER_LIMIT`。
 *
 * 为什么不读插件设置：`.sdo/config.yml` 是**项目**真源，同一插件在不同项目里的容忍度本来就该不同；
 * 而且它随台账入库，回执里"按哪个上限判的"能对得上历史。
 */
export function deferLimitOf(store: SdoStore): number {
  const config = store.readYaml<{ release?: { deferLimit?: unknown } }>('config.yml')
  const declared = config?.release?.deferLimit
  return normalizeLimit(typeof declared === 'number' ? declared : undefined)
}

/** `deferTraceFindings` 的输入。 */
export interface DeferTraceInput {
  /** 台账里的全部 release（顺序随意：内部按版本语义序重排）。 */
  releases: readonly Release[]
  /**
   * **已终结**的实体 id（缺陷 `fixed`/`closed`、卡 `done`/`dropped` 之类）。
   *
   * 为什么要调用方给：终结状态在缺陷/卡台账里，不在 release 文件里 —— 派生层不 import 那些模块
   * （依赖方向是「判据 → 派生层」，反向那条被 `test/m213.test.ts` 的静态守卫钉死）。
   * **不给**等于"全都还在飞"（保守：漏了豁免只会多报，不会少报）。
   */
  settled?: readonly string[] | undefined
  /**
   * 真源里点名了的那几次顺延（`release/deferred` 一类事件，按实体 id）。
   *
   * 为什么不自己扫事件：本模块不定义事件类型面（`SdoEventType` 在 `src/types.ts`）；调用方把
   * "哪几次顺延在真源里留过痕"整理成 id 集合交进来即可。文件可手改，真源在 journal。
   */
  deferredRecords?: readonly string[] | undefined
  /** 次数上限；缺省 `DEFAULT_DEFER_LIMIT`。 */
  limit?: number | undefined
}

/**
 * **顺延留痕与次数上限**（`AC-277`）的读数：空数组＝绿。
 *
 * 两条红面：
 * ① `defer-count-over-limit` —— 当前版 `nonScope` 里某条的 `deferCount` **超过上限**：
 *    带 `needsUserDecision: true`（这次顺延该由人裁决）。只判**当前版**：历史版本里的次数是既成
 *    事实，重判它只会让台账永久红（历史不重写，规格 §5.1）；
 * ② `defer-silent` —— 某实体曾在**已冻结**的旧版 `scope` 里，而当前版集合一个字都没提它
 *    （既不在 `scope` 也不在 `nonScope`），且没有顺延留痕 ⇒ **静默顺延**。三路豁免：`settled`
 *    （做完了，不算顺延）、`deferredRecords`（真源里有那一次顺延的留痕）、它其实还在当前版集合里。
 *
 * 为什么"只在旧版 `scope` 里"才是静默顺延：签字冻结过的集合是一次**承诺**（`AC-276`），
 * 当前版对它闭口不谈，等于用"没写在任何地方"把承诺悄悄作废 —— 这正是 `AC-277` 要判红的形态。
 */
export function deferTraceFindings(input: DeferTraceInput): ReleaseTraceFinding[] {
  const releases = [...input.releases]
  const out: ReleaseTraceFinding[] = []
  const current = currentRelease(releases)
  if (current === undefined) return out // 一份 release 都没有：发布层还没被采纳，这里不判（别把缺账当绿）
  const limit = normalizeLimit(input.limit)

  // ① 次数上限（只看当前版：本版登记的 `deferCount` 才是"已经顺延了几次"的权威读数）
  for (const note of current.nonScope ?? []) {
    const entityId = textOf(note.id).trim()
    if (entityId === '') continue
    const count = Number(note.deferCount)
    if (!Number.isInteger(count) || count <= limit) continue
    out.push({
      kind: 'defer-count-over-limit',
      subjectId: entityId,
      deferCount: count,
      limit,
      needsUserDecision: true,
      detail:
        `${current.id} 的 nonScope 里 ${entityId} 已顺延 ${count} 次，超过上限 ${limit} 次：`
        + `再往下拖已经不是"再等一版"，必须由用户裁决（进本版 / 明确放弃 / 改上限本身），模型不得自行放宽`,
    })
  }

  // ② 静默顺延：旧版（已冻结）承诺过、当前版一个字都没提
  const settled = new Set((input.settled ?? []).map((item) => textOf(item).trim()))
  const recorded = new Set((input.deferredRecords ?? []).map((item) => textOf(item).trim()))
  const committed = new Set<string>()
  for (const release of releases) {
    if (!isFrozen(release) || release.id === current.id) continue
    for (const entityId of [...release.scope.requirements, ...release.scope.acceptance]) {
      const id = textOf(entityId).trim()
      if (id !== '') committed.add(id)
    }
  }
  for (const entityId of [...committed].sort()) {
    if (settled.has(entityId) || recorded.has(entityId)) continue
    if (inScope(current, entityId)) continue
    if ((current.nonScope ?? []).some((note) => textOf(note.id).trim() === entityId)) continue
    // 派生结果把它钉在**旧版**（历史声明）才算"从当前版消失"：被更新一版显式带进 scope 的实体，
    // `deriveFor` 会给出那一版，那是**写在台账里**的顺延，不是静默。
    const detail = deriveFor(releases, entityId)
    const version = textOf(detail.targetVersion).trim()
    const home = releases.find((release) => packageVersionOf(release) === version && isFrozen(release))
    if (home === undefined || home.id === current.id) continue
    out.push({
      kind: 'defer-silent',
      subjectId: entityId,
      fromVersion: packageVersionOf(home),
      detail:
        `${entityId} 在已冻结的 ${home.id} 里是 scope 的一部分，而当前版 ${current.id} 的 scope / nonScope `
        + `都没有它 —— 这不是顺延，是"没写在任何地方"：请显式登记进 ${current.id} 的 nonScope`
        + `（reason / deferCount / approvedBy: ${HUMAN_APPROVER}），或把它放回 scope`,
    })
  }
  return out
}

/**
 * 冻结序号指向的那一刻在真源里是不是一次**人签**（`AC-276`：冻结走问答通道，`channel=question`）。
 *
 * 两种合法形态（都在本仓既有真源里）：
 * · `release/written` 且那一刻 `frozen === true` 且事件点名的是**这一份** release —— 用
 *   `writeRelease` 落盘（工具在写的同时留痕）；
 * · `question/answered` 且 `by === human` —— 用户答了那道签字题。
 * 找不到那一刻、或那一刻不是人签 ⇒ `undefined`（判红：`frozenAtSeq` 是一句**可核对**的声明）。
 */
function signatureFaceAt(events: readonly JournalEvent[], seq: number, releaseId: string): 'write' | 'answer' | undefined {
  const event = events.find((item) => item.seq === seq)
  if (event === undefined) return undefined
  const data = eventData(event)
  if (String(event.type) === 'release/written' && data.frozen === true && textOf(data.id).trim() === releaseId) return 'write'
  if (event.type === 'question/answered' && textOf(data.by).trim() === HUMAN_APPROVER) return 'answer'
  return undefined
}

/** `freezeTraceFindings` 的输入。 */
export interface FreezeTraceInput {
  /** 台账里的全部 release（顺序随意）。 */
  releases: readonly Release[]
  /**
   * 真源事件（`journal.read().events`）。
   *
   * 为什么要它：`frozenAtSeq` 与"冻结之后有没有被改过"都是**对真源的断言**，光看文件核不了 ——
   * 文件是手可编辑的（`.sdo/**\/*.yml`），真源才是不可篡改的那一份。
   * 不给 ⇒ 只做得了"当前版有没有人签"这一半（另一半核不到，**不许**当成通过）。
   */
  events?: readonly JournalEvent[] | undefined
}

/**
 * **冻结人签与冻结后改集合**（`AC-276`）的读数：空数组＝绿。
 *
 * 四条红面：
 * ① `collections-unsigned` —— **当前版**没冻（`frozenBy` 不是 `human` 或缺 `frozenAtSeq`）：
 *    模型自己写进文件的集合不算权威（反例 R12）。一份 release 都没有 ⇒ **不判**（这套机制还没被采纳）；
 *    而"旧版已冻、新版刚起草"⇒ **不判红**（草稿不是当前版，`AC-275` 的场景）；
 * ② `signature-not-human` —— 有人签字，但签字人不是 `human`（驾驶舱不得代批，`ADR-022` 裁决①）；
 * ③ `freeze-unwitnessed` —— 冻结过，但真源里核不到那一次人签：要么从来没有"带签字的落盘"，
 *    要么 `frozenAtSeq` 指着的那一刻什么都不是 ⇒ `frozenBy` 很可能是**手填**的；
 * ④ `collections-rewritten-after-freeze` —— 现盘条数与**最后一次带签字的落盘**不一致，且冻结之后
 *    没有任何已决策的变更 ⇒ 冻结后绕过 `change` 直接改了集合（反例 R13）。
 *
 * **已知边界**（与文件头同一处口径）：`release/written` 事件只带条数不带 id 集合 ⇒ "删一条、
 * 加一条、条数不变"这一种改法**核不到**；手改文件时若把条数也改回冻结时的数字，同样核不到。
 * 这两处要收紧必须先扩事件字段面（那会动 `test/m213.test.ts` 的 `M213-09`）。
 */
export function freezeTraceFindings(input: FreezeTraceInput): ReleaseTraceFinding[] {
  const releases = [...input.releases]
  const events = [...(input.events ?? [])].sort((left, right) => left.seq - right.seq)
  const out: ReleaseTraceFinding[] = []
  const current = currentRelease(releases)
  if (current === undefined) return out // 没有 release 文件：发布层未采纳，不在这里判

  const signature = textOf(current.frozenBy).trim()
  if (signature !== '' && signature !== HUMAN_APPROVER) {
    out.push({
      kind: 'signature-not-human',
      subjectId: current.id,
      detail:
        `当前版 ${current.id} 的 frozenBy 是「${signature}」：冻结只认 ${HUMAN_APPROVER} —— `
        + `允许本版范围遗留/冻结的决定权在用户，驾驶舱与模型都不得代签`,
    })
  }
  if (!isFrozen(current)) {
    const counts = `${current.scope.requirements.length} 条需求 / ${current.scope.acceptance.length} 条 AC`
    out.push({
      kind: 'collections-unsigned',
      subjectId: current.id,
      detail:
        `当前版 ${current.id} 的集合（scope ${counts}、nonScope ${(current.nonScope ?? []).length} 条）`
        + `没有任何人签：frozenBy 只认 ${HUMAN_APPROVER}，并要落 frozenAtSeq。集合的权威来自冻结那次人签，`
        + `模型自己写进文件的范围不算数 —— 请走问答通道让用户签，或别让这份草稿充当"当前版"`,
    })
  }

  for (const release of releases) {
    if (!isFrozen(release)) continue
    const writes = events.filter(
      (event) => String(event.type) === 'release/written' && textOf(eventData(event).id).trim() === release.id,
    )
    const signedWrites = writes.filter((event) => eventData(event).frozen === true)
    const seq = typeof release.frozenAtSeq === 'number' ? release.frozenAtSeq : 0
    const face = signatureFaceAt(events, seq, release.id)
    // **基线＝冻结那一刻的那次落盘**：`frozenAtSeq` 指向它就用它，否则退到**最早**那次带签字的落盘
    // （"之后落的每一盘都是冻结之后"—— 取最后一次会把"冻结后自己再落一盘"当成基线，漂移就被洗掉了）
    const baseline = signedWrites.find((event) => event.seq === seq) ?? signedWrites[0]
    if (baseline === undefined) {
      // 没有带签字的落盘：只有"问答通道签字"能当凭据（`AC-276` 的人签形态之一）；
      // 两种凭据都没有 ⇒ `frozenBy` 只能是手填的。没有落盘基线时也就没有条数基线 ⇒ 漂移这一面核不到。
      if (face !== 'answer') {
        out.push({
          kind: 'freeze-unwitnessed',
          subjectId: release.id,
          detail:
            `${release.id} 写着 frozenBy: ${HUMAN_APPROVER}，但真源里既没有一次"带签字的落盘"`
            + `（release/written 且 frozen=true）、也没有 by: ${HUMAN_APPROVER} 的问答答复 `
            + `⇒ 那行签字很可能是手填的。用 writeRelease 落盘会把这一刻记进真源`,
        })
      }
      continue
    }
    if (face === undefined) {
      out.push({
        kind: 'freeze-unwitnessed',
        subjectId: release.id,
        detail:
          `${release.id} 的 frozenAtSeq=${seq} 在真源里不是一次人签（既不是带签字的落盘，也不是 by: ${HUMAN_APPROVER} `
          + `的问答答复）⇒ 冻结序号必须指向真实发生过的那一次签字；落盘时把它回执里的 seq 填进 frozenAtSeq`,
      })
    }
    const recorded = eventData(baseline)
    const frozenRequirements = recordedCount(recorded.requirements)
    const frozenAcceptance = recordedCount(recorded.acceptance)
    const diskRequirements = release.scope.requirements.length
    const diskAcceptance = release.scope.acceptance.length
    if (frozenRequirements !== diskRequirements || frozenAcceptance !== diskAcceptance) {
      const changed = events.some((event) => event.type === 'change/decided' && event.seq > baseline.seq)
      if (!changed) {
        out.push({
          kind: 'collections-rewritten-after-freeze',
          subjectId: release.id,
          detail:
            `${release.id} 冻结时 scope 是 ${frozenRequirements} 条需求 / ${frozenAcceptance} 条 AC，现盘是 `
            + `${diskRequirements} 条需求 / ${diskAcceptance} 条 AC，而冻结之后没有任何已决策的变更 ⇒ 冻结后直接改了集合。`
            + `要往已冻的 scope 加东西，先走变更控制（带影响分析与决策），再重新落盘`,
        })
      }
    }
  }
  return out
}
