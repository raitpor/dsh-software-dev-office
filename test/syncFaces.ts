/**
 * **`DEF-087`（第八批 §3.4）：同步面由 `package.json#files` 推导。**
 *
 * 为什么要有这个 helper：实例副本里残留着一棵**不属于这个包**的陈旧 `docs/` 树（`files` 里没有 `docs`），
 * 而"批次同步口径"是手抄的一份面清单 ⇒ 手抄清单**永远查不出'多出来的面'**（多出来的东西不在清单里）。
 * 这里把**唯一来源**钉成 `files`：
 *   · `expectedFaces(files)` —— 从 `files` 推导**顶层面**（`lib/src` ⇒ `lib`；`src/data` ⇒ `src`）；
 *   · `reportFaces(files, dir)` —— 报出 `missing`（少的面）与 `extra`（多出来的面），**只报告不删**。
 *
 * ⚠️ **覆盖面的洞（如实记）**：本 helper 判的是**顶层面**。`files` 只声明了 `src/data`，所以
 * `src/` 底下多出来的兄弟目录（例如 `src/domain`）**不会**被报出来 —— 那要按声明路径逐层比，
 * 而 `files` 的语义本来就是"顶层条目 + 声明目录"，本判据不越权（要更严就改 `files`）。
 */
import { existsSync, readdirSync } from 'node:fs'

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

export interface FaceReport {
  /** 由 `files` 推导出的顶层面 */
  expected: string[]
  /** 缺的面（`files` 声明了，副本里没有） */
  missing: string[]
  /** **多出来的面**（副本里有，而 `files` 里没有任何条目落在它下面）—— 只报告，不删 */
  extra: string[]
}

export function reportFaces(files: readonly string[], dir: string): FaceReport {
  const expected = expectedFaces(files)
  if (!existsSync(dir)) return { expected, missing: [...expected], extra: [] }
  const present = readdirSync(dir).filter((name) => !name.startsWith('.'))
  const standard = new Set<string>(PACKAGING_STANDARD)
  return {
    expected,
    missing: expected.filter((face) => !present.includes(face)),
    extra: present.filter((name) => !expected.includes(name) && !standard.has(name)).sort(),
  }
}
