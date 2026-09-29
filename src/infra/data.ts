/**
 * 随包数据加载：把 `src/data/**` 下的 YAML 读进内存。
 *
 * 为什么需要它：数据文件在**源码目录**（设计 §11.1 的 `src/data/`），而运行的是编译产物
 * （`lib/src/**`）。这里从 `import.meta.url` 向上找到含 `package.json` 的包根，再拼相对路径，
 * 因此 `src/` 与 `lib/` 两种布局都能命中同一份数据。
 *
 * 失败策略：数据是我们随包交付的，缺了就是包装错了——**抛出**而不是静默降级，
 * 否则门禁刻度会被悄悄替换成"默认值"。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseYaml } from './yaml.js'

const cache = new Map<string, unknown>()

/** 从当前模块向上找到包根（含 package.json 的目录）。 */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(dir, 'package.json'), 'utf8')
      return dir
    } catch {
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new Error('sdo: 无法定位包根（未找到 package.json）')
}

/** 读取并解析一个随包 YAML 数据文件（相对包根；带缓存）。 */
export function loadPackagedYaml<T>(relativePath: string): T {
  const cached = cache.get(relativePath)
  if (cached !== undefined) return cached as T
  const target = join(packageRoot(), relativePath)
  const text = readFileSync(target, 'utf8')
  const parsed = parseYaml(text) as T
  cache.set(relativePath, parsed)
  return parsed
}

/** 列出随包数据目录下的条目名（不含 `node_modules` 之类噪声；目录不存在返回空数组）。 */
export function listPackagedNames(relativeDir: string): string[] {
  try {
    return readdirSync(join(packageRoot(), relativeDir)).sort()
  } catch {
    return []
  }
}

/** 清空缓存（测试用）。 */
export function clearPackagedDataCache(): void {
  cache.clear()
}
