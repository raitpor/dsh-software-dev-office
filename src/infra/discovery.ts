/**
 * 项目发现：**真源在 `.sdo/`**，因此"当前项目是哪一个"应当**从文件系统读出来**，
 * 而不是靠内存里记着"哪个会话对应哪个目录"。
 *
 * 与 `loadPackagedYaml` 同思路：从起始目录向上找，直到某个目录下存在 `.sdo/`（或配置的项目目录名）。
 * 找不到就返回 undefined —— 由调用方决定"视为未初始化"，**绝不猜别的项目**。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 从 `startDir` 起向上查找包含 `projectDirName` 的目录（最多上溯 `maxDepth` 层）。 */
export function findProjectRoot(startDir: string, projectDirName: string, maxDepth = 8): string | undefined {
  let dir = resolve(startDir)
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (existsSync(join(dir, projectDirName))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}
