/**
 * **`DEF-087`（第八批 §3.4）：同步面由 `package.json#files` 推导。**
 *
 * 为什么要有这个 helper：实例副本里残留着一棵**不属于这个包**的陈旧 `docs/` 树（`files` 里没有 `docs`），
 * 而"批次同步口径"是手抄的一份面清单 ⇒ 手抄清单**永远查不出'多出来的面'**（多出来的东西不在清单里）。
 * 这里把**唯一来源**钉成 `files`：
 *   · `expectedFaces(files)` —— 从 `files` 推导**顶层面**（`lib/src` ⇒ `lib`；`src/data` ⇒ `src`）；
 *   · `reportFaces(files, dir, sourceRoot?)` —— 报出 `missing`（少的面）与 `extra`（多出来的面），**只报告不删**。
 *
 * **`DEF-087`（第九批 §3.7）：判据从"顶层面"下沉到"按 `files` 声明的路径逐层对账"。**
 * 第八批只比顶层面 ⇒ **面内过度物化是盲区**：`files` 只声明 `src/data`，而副本的 `src/` 里塞了
 * 整棵树（真实例实测 **71 个未声明文件**）—— `src` 这个顶层面"在"，所以旧判据一个字都不报。
 * 现在（传了 `sourceRoot` 时）再给两列**只读**观测：
 *   · `paths`：逐条声明路径的 `missing`（源有副本没有）/ `extra`（副本有源没有，= 面内过度物化）/ `drifted`（两边都有但内容不同）；
 *   · `undeclared`：落在已声明**顶层面**内、却不属于任何声明路径的文件（相对副本根）。
 * 判定**路径参数化**（`sourceRoot` 是入参，不读环境、不碰真实实例）；不传 `sourceRoot` 时返回形状与第八批**逐字相同**。
 *
 * **`DEF-087`（第十一批 §3.1）：同族"只看副本"的第三、四处静默（两处都**纳入判据**，不是只在表里声明）。**
 *   · **第三处（`reconcilePath`）**：源侧缺、副本侧有的一条声明路径，此前走 `if (!existsSync(source))` 那一支 ⇒
 *     返回 `missing/extra/drifted` **全空**且 `absent: false` —— 与"齐备"那一格**逐字同形**（声明面陈旧在报告里不可见）。
 *     现在把**副本多出来的那一份**（单文件 = `['']`、目录 = 递归文件清单）列进 `extra` ⇒ 两格可区分；
 *     `absent: true` 只留给"源与副本**同时**缺"（那一格仍是三列空，因为它确实什么都没有）。
 *   · **第四处（`undeclaredUnder`）**：此前**只遍历副本** ⇒ 源面未声明物化**只有在副本里也物化了**才可见
 *     （源里有 `src/domain/adr.ts`、副本整棵 `src` 缺 ⇒ `undeclared: []`）。现在**两侧都遍历**再合并去重：
 *     源侧的未声明物化也报出来。**已知代价**：合并后不再区分"这一条来自哪一侧"（列仍是相对根的路径）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

/** 打包/安装流程自己就会产生的顶层条目（不算"多出来的面"）。 */
export const PACKAGING_STANDARD = ['package.json', 'node_modules', '.package-lock.json', 'npm-shrinkwrap.json', '.bin'] as const

/** 从 `files` 推导出的顶层面（去重、稳定排序）。**唯一来源就是传进来的那份 `files`。** */
export function expectedFaces(files: readonly string[]): string[] {
  const faces = new Set<string>()
  for (const entry of files) {
    const top = entry.split('/')[0]
    if (top !== undefined && top !== '') faces.add(top)
  }
  return [...faces].sort()
}

/** **一条声明路径**的逐层对账（路径都相对该条目）。 */
export interface PathReport {
  path: string
  /** 源有、副本没有 */
  missing: string[]
  /** 副本有、源没有（**面内过度物化**就是这一列） */
  extra: string[]
  /** 两边都有但内容不同 */
  drifted: string[]
  /**
   * **该声明路径在源与副本里都不存在**（`DEF-087` 第十批 §3.6）。
   *
   * 修前这里直接 `return undefined` ⇒ `files` 声明了、而源与副本**同时缺**的一条路径
   * **连一行都不报**（未登记的豁免面）。现在照样出列并点名（`path` 就是那一条），
   * 三列空 + `absent: true` 表示"不是面内多/少/内容问题，而是**这条声明面整体不在**"。
   *
   * **第十一批 §3.1 收窄了它的口径**：`absent` 只在"源与副本**同时**缺"时为 `true`。
   * "源缺、副本有"（声明面陈旧）**不再**落在这里 —— 那一格把副本那一份列进 `extra`
   * （见 `reconcilePath`），否则两格会**逐字同形**。⇒ 三列全空**当且仅当** `absent: true`。
   */
  absent: boolean
}

export interface FaceReport {
  /** 由 `files` 推导出的顶层面 */
  expected: string[]
  /** 缺的面（`files` 声明了，副本里没有） */
  missing: string[]
  /** **多出来的面**（副本里有，而 `files` 里没有任何条目落在它下面）—— 只报告，不删 */
  extra: string[]
  /** **按声明路径逐层对账**（只在传了 `sourceRoot` 时给） */
  paths?: PathReport[]
  /**
   * 落在已声明顶层面内、不属于任何声明路径的文件（相对**各自那棵树的根**；只在传了 `sourceRoot` 时给）。
   *
   * **第十一批 §3.1 起两侧都算**（副本 + 源，合并去重）—— 修前只遍历副本 ⇒ 源面未声明物化
   * 只有副本里也物化了才可见（见 `undeclaredUnder`）。
   */
  undeclared?: string[]
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** 目录下的全部文件（相对**顶层 root**，不是相对当前层 —— 递归里别把基准换掉），跳过隐藏项与 `node_modules`。 */
function walkFiles(root: string, base: string = root, out: string[] = []): string[] {
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(base, entry.name)
    if (entry.isDirectory()) walkFiles(root, full, out)
    else out.push(relative(root, full))
  }
  return out
}

const sorted = (list: readonly string[]): string[] => [...list].sort()

/** 单条声明路径的对账：目录递归比、单文件比存在性与内容。 */
function reconcilePath(entry: string, dir: string, sourceRoot: string): PathReport | undefined {
  const source = join(sourceRoot, entry)
  const target = join(dir, entry)
  if (!existsSync(source)) {
    // **源侧缺**（`DEF-087` 第十一批 §3.1，第三处"只看副本"的静默）：副本只剩旧路径（声明面陈旧）时，
    // 此前返回三列全空 ⇒ 与"齐备"逐字同形。现在把**副本那一份**列进 `extra`（与 88/99 两行同一列口径：
    // 单文件记 `['']`、目录记递归相对路径），于是"源缺副本有"可被报出并点名。
    // `absent: true` 只留给"**源与副本同时缺**"——那一格确实没有任何一份可列，才与"齐备"同为三列空。
    const extra = !existsSync(target)
      ? []
      : statSync(target).isFile()
        ? ['']
        : sorted(walkFiles(target))
    return { path: entry, missing: [], extra, drifted: [], absent: extra.length === 0 }
  }
  if (statSync(source).isFile()) {
    const missing = existsSync(target) ? [] : ['']
    const drifted = missing.length === 0 && sha256(source) !== sha256(target) ? [''] : []
    return { path: entry, missing, extra: [], drifted, absent: false }
  }
  if (!existsSync(target)) return { path: entry, missing: sorted(walkFiles(source)), extra: [], drifted: [], absent: false }
  const from = walkFiles(source)
  const to = walkFiles(target)
  const inTo = new Set(to)
  const inFrom = new Set(from)
  return {
    path: entry,
    missing: sorted(from.filter((rel) => !inTo.has(rel))),
    extra: sorted(to.filter((rel) => !inFrom.has(rel))),
    drifted: sorted(from.filter((rel) => inTo.has(rel) && sha256(join(source, rel)) !== sha256(join(target, rel)))),
    absent: false,
  }
}

/**
 * 落在已声明顶层面内、却不属于任何声明路径的文件（相对**各自那棵树的根**）。
 *
 * `DEF-087`（第十一批 §3.1，第四处"只看副本"的静默）：此前**只遍历副本** ⇒ 源面未声明物化
 * **只有在副本里也物化了**才可见（源里有 `src/domain/adr.ts`、副本整棵 `src` 缺 ⇒ `undeclared: []`）。
 * 现在**两侧都遍历**再合并去重 —— 源侧的未声明物化也报出来。
 *
 * **已知代价（进《豁免面清单》并配变异）**：合并后列里**不区分来源侧**（都写成相对根的路径），
 * 且两侧同名文件折叠成一条 —— 代价是"只在源侧未声明"与"两侧都未声明"在报告里同形；
 * 换来的是**源面未声明不再需要副本配合才可见**。
 */
function undeclaredUnder(files: readonly string[], dir: string, sourceRoot?: string): string[] {
  /** 单棵树上的"已声明顶层面内、不属于任何声明路径"的文件。 */
  const under = (root: string): string[] => {
    const out: string[] = []
    for (const face of expectedFaces(files)) {
      const base = join(root, face)
      if (!existsSync(base) || !statSync(base).isDirectory()) continue
      // 整面声明（`skills` 这种没有 `/` 的条目）⇒ 该面下的**一切**都算已声明
      const declared = files
        .filter((entry) => entry.split('/')[0] === face)
        .map((entry) => entry.split('/').slice(1).join('/'))
      for (const rel of walkFiles(base)) {
        if (declared.some((prefix) => prefix === '' || rel === prefix || rel.startsWith(`${prefix}/`))) continue
        out.push(`${face}/${rel}`)
      }
    }
    return out
  }
  // 两侧都算（副本 + 源），合并去重后稳定排序
  const fromCopy = under(dir)
  const fromSource = sourceRoot === undefined ? [] : under(sourceRoot)
  return sorted([...new Set([...fromCopy, ...fromSource])])
}

export function reportFaces(files: readonly string[], dir: string, sourceRoot?: string): FaceReport {
  const expected = expectedFaces(files)
  if (!existsSync(dir)) return { expected, missing: [...expected], extra: [] }
  const present = readdirSync(dir).filter((name) => !name.startsWith('.'))
  const standard = new Set<string>(PACKAGING_STANDARD)
  const base: FaceReport = {
    expected,
    missing: expected.filter((face) => !present.includes(face)),
    extra: present.filter((name) => !expected.includes(name) && !standard.has(name)).sort(),
  }
  if (sourceRoot === undefined) return base
  return {
    ...base,
    paths: files.map((entry) => reconcilePath(entry, dir, sourceRoot)).filter((row): row is PathReport => row !== undefined),
    undeclared: undeclaredUnder(files, dir, sourceRoot),
  }
}
