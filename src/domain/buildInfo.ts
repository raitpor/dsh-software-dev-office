/**
 * **本会话实际加载的插件构建**（DEF-070，2026-10-14 机制缺陷批 §3C）。
 *
 * 缺陷现场：会话运行时加载的是**实例 profile 下的已安装副本**（`<profile>/node_modules/dsh-software-dev-office`），
 * 不是工作树。两处曾**同版本号而内容分叉**（`grep -c oneOf`：副本 0 / 本仓 4）⇒ 端到端验证会验到**旧构建**，
 * 而且**没有任何机械提示**。`pnpm` 的 `file:` 依赖是**硬链接**：改写已有文件会同步（同 inode），
 * **新增/删除/改名不会** —— 这正好是"看起来同步了、其实少了一整个新模块"的成因。
 *
 * 这里只做两件机械的事：**读出加载位置与内容指纹**、**与工作树比对**。
 * 拿不到就读成 `unavailable` —— **不编造**（真源纪律：宁可说"读不到"）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本插件的包名（与 `package.json` 比对用）。 */
export const PLUGIN_PACKAGE_NAME = 'dsh-software-dev-office'

export interface BuildInfo {
  /** 本会话**实际加载**的插件入口文件；读不到 ⇒ 空串 */
  entryPath: string
  /** 构建指纹：入口文件内容的 `sha256` 前 12 位；读不到 ⇒ 空串（**不编造**） */
  fingerprint: string
  /** 包根（含 `package.json` 的那一级） */
  packageRoot: string
  /** 版本号（`package.json` 读不到 ⇒ 空串） */
  version: string
  source: 'import-meta' | 'unavailable'
}

/** 从 `import.meta.url` 向上找到含 `package.json` 的包根。 */
function packageRootOf(startFile: string): string {
  let dir = dirname(startFile)
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(startFile)
}

/** 入口文件的内容指纹（读不到就返回空串）。 */
function fingerprintOf(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
}

function versionOf(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** **给定一个包根**，读出它的构建信息（工作树与安装副本用同一把尺子量）。 */
export function buildInfoOf(packageRoot: string): BuildInfo {
  // 运行时加载的是**编译产物**（`lib/src/index.js`）；工作树里可能只有源文件 ⇒ 两条都试，取先存在的。
  const candidates = [join(packageRoot, 'lib', 'src', 'index.js'), join(packageRoot, 'src', 'index.ts')]
  const entry = candidates.find((item) => existsSync(item)) ?? ''
  if (entry === '') {
    return { entryPath: '', fingerprint: '', packageRoot, version: versionOf(packageRoot), source: 'unavailable' }
  }
  const fingerprint = fingerprintOf(entry)
  if (fingerprint === '') {
    return { entryPath: entry, fingerprint: '', packageRoot, version: versionOf(packageRoot), source: 'unavailable' }
  }
  return { entryPath: entry, fingerprint, packageRoot, version: versionOf(packageRoot), source: 'import-meta' }
}

/** **本会话实际加载的**这份构建（入口取自本模块自身所在的包）。 */
export function loadedBuild(): BuildInfo {
  try {
    return buildInfoOf(packageRootOf(fileURLToPath(import.meta.url)))
  } catch {
    return { entryPath: '', fingerprint: '', packageRoot: '', version: '', source: 'unavailable' }
  }
}

/**
 * 给一个目录（通常是会话 cwd），若它看起来是**本插件的工作树**就返回它的构建信息，否则 `undefined`。
 *
 * 判据只有两条机械事实：目录里有 `package.json` 且 `name` 是本插件；或目录里有 `src/office.ts`。
 * 两条都不满足 ⇒ 明确返回 `undefined`（"这里不是本仓，比不了"，而不是硬凑一个）。
 */
export function worktreeBuildOf(dir: string): BuildInfo | undefined {
  if (dir === '') return undefined
  try {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown }
      if (pkg.name === PLUGIN_PACKAGE_NAME) return buildInfoOf(dir)
    }
    if (existsSync(join(dir, 'src', 'office.ts'))) return buildInfoOf(dir)
  } catch {
    return undefined
  }
  return undefined
}

/** 两份构建是不是**同一份**（两侧都拿不到指纹 ⇒ 判"不可比"，由调用方如实说明）。 */
export function sameBuild(a: BuildInfo, b: BuildInfo): boolean | undefined {
  if (a.fingerprint === '' || b.fingerprint === '') return undefined
  return a.fingerprint === b.fingerprint
}
