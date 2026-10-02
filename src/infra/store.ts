/**
 * 文件存储层：**路径沙箱** + **原子写** + 权限收紧。
 *
 * 设计对应：§4.4/§4.5（.sdo/ 布局与命名）、NFR-003（原子写、0600）、
 * NFR-007（所有写入必须落在项目目录内，拒绝路径逃逸）、E2E-07。
 *
 * 约定：
 *   · 一切路径都相对 `.sdo/` 根解析，解析结果必须仍在根内；
 *   · 任何写入走"临时文件 → 同目录 rename"，避免半截文件；
 *   · 文件 0600、目录 0700；JSON/YAML 文本一律以 `\n` 结尾。
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { parseYaml, stringifyYaml } from './yaml.js'

/** 路径越界或非法路径。 */
export class SdoPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SdoPathError'
  }
}

export interface WriteOptions {
  /** 文件权限，默认 0o600 */
  mode?: number
}

/** 绑定到某个 `.sdo/` 根的文件存储。 */
export class SdoStore {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  /** 把若干相对片段解析成根内的绝对路径；越界即抛错（E2E-07 的正解）。 */
  path(...segments: string[]): string {
    for (const segment of segments) {
      if (segment.includes('\0')) throw new SdoPathError('路径里不允许出现空字符')
      if (isAbsolute(segment)) throw new SdoPathError(`不允许绝对路径：${segment}`)
    }
    const target = resolve(this.root, ...segments)
    const rel = relative(this.root, target)
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new SdoPathError(`路径逃出项目目录：${segments.join('/')} → ${target}`)
    }
    // 归一化成正斜杠：路径在账本里**当 key 用**（与 relativeTo 一致）。Windows 的 join 会给反斜杠，
    // 不归一化的话同一逻辑路径会有两种写法（实测 Windows CI 上 `endsWith('a/b.yml')` 断言因此失败）；
    // Node 的 fs 接受正斜杠，故对文件操作没有副作用。
    return target.split(sep).join('/')
  }

  /** 确保 `.sdo/` 及其常用子目录存在（设计 §4.5 布局的 M0 子集）。 */
  ensureLayout(subdirs: string[] = ['requirements', 'questions', 'gates', 'evidence', 'design', 'tasks', 'risks']): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    for (const dir of subdirs) {
      mkdirSync(this.path(dir), { recursive: true, mode: 0o700 })
    }
  }

  exists(...segments: string[]): boolean {
    return existsSync(this.path(...segments))
  }

  /** 读取文本；不存在返回 undefined。 */
  readText(...segments: string[]): string | undefined {
    const target = this.path(...segments)
    if (!existsSync(target)) return undefined
    return readFileSync(target, 'utf8')
  }

  /** 原子写文本（临时文件 + rename），并收紧权限。 */
  writeText(segments: string[], text: string, options: WriteOptions = {}): string {
    const target = segments.length === 1 ? this.path(segments[0] ?? '') : this.path(...segments)
    const mode = options.mode ?? 0o600
    const dir = dirname(target)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = join(dir, `.tmp-${process.pid}-${randomUUID()}`)
    const body = text.endsWith('\n') ? text : `${text}\n`
    writeFileSync(tmp, body, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, target)
    return target
  }

  /** 追加一行（日志类文件）。 */
  appendLine(segments: string[], line: string, options: WriteOptions = {}): void {
    const target = this.path(...segments)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    if (!existsSync(target)) {
      writeFileSync(target, '', { mode: options.mode ?? 0o600 })
      chmodSync(target, options.mode ?? 0o600)
    }
    appendFileSync(target, line.endsWith('\n') ? line : `${line}\n`)
  }

  readYaml<T = unknown>(...segments: string[]): T | undefined {
    const text = this.readText(...segments)
    if (text === undefined) return undefined
    try {
      return parseYaml(text) as T
    } catch (error) {
      // **R-14**：YAML 子集的报错只说"YAML 第 N 行：…"，**不带文件名** —— 而 `.sdo/**/*.yml`
      // 是给人手改的真源，用户根本不知道该去修哪个文件。这里补上**相对路径**（NFR-009：不泄漏绝对路径）。
      const where = relative(this.root, this.path(...segments)).split(sep).join('/')
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}（文件：${where}）`)
    }
  }

  writeYaml(segments: string[], value: unknown, options: WriteOptions = {}): string {
    return this.writeText(segments, stringifyYaml(value), options)
  }

  readJson<T = unknown>(...segments: string[]): T | undefined {
    const text = this.readText(...segments)
    if (text === undefined) return undefined
    try {
      return JSON.parse(text) as T
    } catch (error) {
      // **R-14 同口径**：JSON 的报错同样只有位置、没有文件名，而 `.sdo/**/*.json`
      // （`project.json`、`gates/*.json`、成本快照…）也都是可手改的真源/派生投影。
      // 补上**相对路径**（NFR-009：不泄漏绝对路径）——这条由"投影坏掉"的矩阵用例逼出来。
      const where = relative(this.root, this.path(...segments)).split(sep).join('/')
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}（文件：${where}）`)
    }
  }

  writeJson(segments: string[], value: unknown, options: WriteOptions = {}): string {
    return this.writeText(segments, `${JSON.stringify(value, null, 2)}\n`, options)
  }

  /** 列出目录下的文件名（不含目录），按字典序；目录不存在返回空数组。 */
  listNames(...segments: string[]): string[] {
    const target = this.path(...segments)
    if (!existsSync(target)) return []
    return readdirSync(target)
      .filter((name) => {
        try {
          return statSync(join(target, name)).isFile()
        } catch {
          return false
        }
      })
      .sort()
  }

  /** 删除文件（不存在则忽略）。 */
  remove(...segments: string[]): void {
    const target = this.path(...segments)
    if (existsSync(target)) rmSync(target)
  }

  /** 权限自检：返回文件的 mode（用于测试 0600）。 */
  modeOf(...segments: string[]): number {
    return statSync(this.path(...segments)).mode & 0o777
  }

  /** 项目内的相对路径（用于展示与证据，设计 NFR-009：只记相对路径）。 */
  relativeTo(target: string): string {
    const rel = relative(this.root, target)
    return rel.split(sep).join('/')
  }
}
