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
  /** 落在已声明顶层面内、不属于任何声明路径的文件（相对副本根；只在传了 `sourceRoot` 时给） */
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
  if (!existsSync(source)) return undefined
  const target = join(dir, entry)
  if (statSync(source).isFile()) {
    const missing = existsSync(target) ? [] : ['']
    const drifted = missing.length === 0 && sha256(source) !== sha256(target) ? [''] : []
    return { path: entry, missing, extra: [], drifted }
  }
  if (!existsSync(target)) return { path: entry, missing: sorted(walkFiles(source)), extra: [], drifted: [] }
  const from = walkFiles(source)
  const to = walkFiles(target)
  const inTo = new Set(to)
  const inFrom = new Set(from)
  return {
    path: entry,
    missing: sorted(from.filter((rel) => !inTo.has(rel))),
    extra: sorted(to.filter((rel) => !inFrom.has(rel))),
    drifted: sorted(from.filter((rel) => inTo.has(rel) && sha256(join(source, rel)) !== sha256(join(target, rel)))),
  }
}

/** 落在已声明顶层面内、却不属于任何声明路径的文件（相对副本根）。 */
function undeclaredUnder(files: readonly string[], dir: string): string[] {
  const out: string[] = []
  for (const face of expectedFaces(files)) {
    const target = join(dir, face)
    if (!existsSync(target) || !statSync(target).isDirectory()) continue
    // 整面声明（`skills` 这种没有 `/` 的条目）⇒ 该面下的**一切**都算已声明
    const declared = files
      .filter((entry) => entry.split('/')[0] === face)
      .map((entry) => entry.split('/').slice(1).join('/'))
    for (const rel of walkFiles(target)) {
      if (declared.some((prefix) => prefix === '' || rel === prefix || rel.startsWith(`${prefix}/`))) continue
      out.push(`${face}/${rel}`)
    }
  }
  return sorted(out)
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
    undeclared: undeclaredUnder(files, dir),
  }
}
