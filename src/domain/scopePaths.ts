/**
 * **路径代数：写范围的归一与相交判定**（ADR-009 / DEF-057 / DEF-074，2026-10-14）。
 *
 * 为什么单独一个模块：相交判定此前**散在四处**各自实现，口径还不一致 ——
 *   · `src/domain/collab.ts`（认领期互斥）与 `src/domain/plan.ts`（计划期重叠，两处）用
 *     **双向 `startsWith` 前缀匹配**；
 *   · `src/integration/orchestrator.ts` 的 `auditWriteScopes`（`done` 对账）用**单向** `file.startsWith(scope)`。
 *
 * 前缀匹配带来两类错判（DEF-057 现算确认的三条事实）：
 *   ① **文件名前缀假阳性**：`src/a.ts` × `src/a.tsx` 被判相交（`a.tsx` 以 `a.ts` 开头）——**实际不相交**；
 *   ② **假放行**（对账方向）：改动 `src/a.tsx` 对卡范围 `src/a.ts` 判"在范围内"——**实际越界**；
 *   ③ 而 `src/domain/` × `src/domain/plan.ts` **本来就该相交**（目录范围覆盖其下），不得放宽。
 *
 * 本模块把口径收敛成一条**语言无关**的规则（硬约束 REQ-060：不得引入任何文件格式知识，
 * 所以**不靠扩展名**判断谁是目录）：
 *
 *   归一到比较形态后 —— **同一路径**，或**目录边界前缀**相交（`a` 是 `b` 的第一段前缀且后随 `/`），
 *   其余一律不相交。
 *
 * 这条规则与"范围写法带不带尾斜杠"无关：`src/domain/` 与 `src/domain` 归一后同为 `src/domain`，
 * 于是"目录 × 其下文件"仍然相交（③ 不被放宽），而"同名互为前缀的两个文件"不再相交（① 被修）。
 * 代价诚实披露：**无扩展名的文件范围**会与其同名目录下的路径相交（`src/a` × `src/a/b.ts`）——
 * 这在无格式知识的前提下无法区分，且方向偏**保守**（宁可多报冲突，不可漏报）。
 */
import { resolve } from 'node:path'

/**
 * **归一到比较形态**：统一分隔符、去 `./`、折叠 `//` 与 `..`、去尾斜杠。
 *
 * 与 `normalizeWorkspacePath` 的分工：那个函数多一层"按工作区根剥离前缀"的语义（受判路径用），
 * 本函数只做**纯字形归一**（范围声明与路径**两边**都用它），因此两者比较时处在同一坐标系。
 * 工作区外部的绝对路径在这里会被剥成"幽灵相对路径"（`/tmp/x` → `tmp/x`）—— 那是**判定层**的事
 * （见 `classifyTarget`），本函数只负责字形，不猜归属。
 */
export function normalizeScopePath(raw: string): string {
  let path = String(raw ?? '').trim().replace(/\\/gu, '/')
  if (path === '') return ''
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

/**
 * **唯一的相交判定出口**（ADR-009）：同一路径，或目录边界前缀相交；其余一律不相交。
 *
 * 所有调用点（认领期互斥 / 计划期重叠 / `done` 对账 / 守卫判定）**必须**走这里 ——
 * 四处各写一份正是 DEF-057 的成因。
 */
export function scopePathsIntersect(a: string, b: string): boolean {
  const left = normalizeScopePath(a)
  const right = normalizeScopePath(b)
  if (left === '' || right === '') return false
  if (left === right) return true
  // **F5（第八批 §3.1）**：glob 形态在这里展开 —— 且**只在这里**（本函数是路径代数的唯一出口；
  // `git.ts` 不许另写一份匹配）。**关键零破坏**：两边都没有 glob 时，走的就是原来那两行前缀判定，
  // 逐字节不变（既有调用点与既有用例的行为不受影响）。
  const leftGlob = hasGlob(left)
  const rightGlob = hasGlob(right)
  // 无 glob：与**上批逐字节相同**（`scopeMatchesPath` 在无 glob 时就是那条前缀判定）
  if (!leftGlob && !rightGlob) return scopeMatchesPath(right, left) || scopeMatchesPath(left, right)
  // 有 glob：两出口共用同一个原语（这里不再直接调 `globCovers`，避免出现"第二个入口"）
  if (scopeMatchesPath(right, left) || scopeMatchesPath(left, right)) return true
  // 两边都是 glob：走**字面前缀**的保守判定（`src/a/**` vs `src/**` ⇒ 相交；`src/**` vs `test/**` ⇒ 不相交）
  if (leftGlob && rightGlob) {
    const lp = globLiteralPrefix(left)
    const rp = globLiteralPrefix(right)
    if (lp === '' || rp === '') return true   // 有一边是"全匹配" ⇒ 保守算相交
    return lp === rp || lp.startsWith(`${rp}/`) || rp.startsWith(`${lp}/`)
  }
  return false
}

/** 该范围是否含 glob 元字符（`*` `?` `[`）。 */
export function hasGlob(scope: string): boolean {
  return /[*?[]/u.test(scope)
}

/** glob 的**字面前缀**（第一个含元字符的段之前的部分）。`src/integration/**` ⇒ `src/integration`。 */
export function globLiteralPrefix(scope: string): string {
  const parts = normalizeScopePath(scope).split('/')
  const literal: string[] = []
  for (const part of parts) {
    if (/[*?[]/u.test(part)) break
    literal.push(part)
  }
  return literal.join('/')
}

/** 字面前缀的**段数**（0 = 一开始就是 glob）。用于分级：≥2 段才拦，更宽只提示。 */
export function globLiteralDepth(scope: string): number {
  const prefix = globLiteralPrefix(scope)
  return prefix === '' ? 0 : prefix.split('/').length
}

/**
 * glob 是否覆盖某个**具体路径**（文件或目录）。
 *
 * 语义（与目录前缀判定同族，只是把 `*` / `**` 放开）：
 *   · `**` = 跨段任意（`src/integration/**` 覆盖 `src/integration/a.ts` 与 `.../sub/b.ts`）；
 *   · `*` / `?` = **段内**任意（不跨 `/`）；
 *   · 覆盖"整条路径"**或它的任一段边界前缀**（`src/*` 覆盖 `src/a/b.ts`，因为 `src/a` 落在域内）。
 */
function globCovers(scope: string, target: string): boolean {
  const pattern = scope
    .split('/')
    .map((part) => {
      if (part === '**') return '(?:[^/]+/)*[^/]*'
      let out = ''
      for (const char of part) {
        if (char === '*') out += '[^/]*'
        else if (char === '?') out += '[^/]'
        else out += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      }
      return out
    })
    .join('/')
  const anchored = new RegExp(`^${pattern}$`, 'u')
  const segments = target.split('/')
  for (let take = segments.length; take >= 1; take -= 1) {
    if (anchored.test(segments.slice(0, take).join('/'))) return true
  }
  return false
}

/**
 * 与另一组范围的**重叠明细**（回执要**点名重叠的那个路径**，不是倒出对方全量写范围 —— DEF-067 落点二）。
 *
 * 返回的是**本组**里参与重叠的路径（归一后），去重且保持声明顺序，便于读者直接照做。
 */
export function scopeOverlaps(scopes: readonly string[], others: readonly string[]): string[] {
  const out: string[] = []
  for (const scope of scopes) {
    if (others.some((other) => scopePathsIntersect(scope, other))) {
      const normalized = normalizeScopePath(scope)
      if (normalized !== '') out.push(normalized)
    }
  }
  return [...new Set(out)]
}

/** 该路径是否落在某个范围里（`==` 或目录边界前缀）—— 与 `scopePathsIntersect` **同一套语义**。 */
export function scopePathWithin(path: string, scope: string): boolean {
  // **DEF-089（第九批 §3.1）**：这里**必须**与 `scopePathsIntersect` 共用同一套语义 ——
  // 上一批只给 `scopePathsIntersect` 加了 glob 支持，本函数（注释还自称"同一套语义"）没有 ⇒
  // **同一输入两出口答案相反**：写范围 `src/integration/**` 的卡改域内文件 ⇒ 派发面说"相交"，
  // 而 `done` 对账（`auditWriteScopes` → 本函数）说"越界"（**反向假阳性**，真台账 `TASK-006.yml` 就是它）。
  // ⇒ 下沉成一个原语 `scopeMatchesPath`，两出口都调它（谁再各写一份，对偶守卫会红）。
  return scopeMatchesPath(scope, path)
}

/**
 * **两出口共用原语**：这个 scope 是否**覆盖**这条具体路径。
 *
 * 语义（与目录前缀判定同族，只是把 glob 放开）：
 *   · 无 glob ⇒ 相等，或差一个目录边界前缀（`src/` 覆盖 `src/a.ts`）；
 *   · 有 glob ⇒ 交给 {@link globCovers}（`**` 跨段 / `*` `?` 段内 / 覆盖任一段边界前缀）。
 */
export function scopeMatchesPath(scope: string, path: string): boolean {
  const root = normalizeScopePath(scope)
  const file = normalizeScopePath(path)
  if (root === '' || file === '') return false
  if (root === file) return true
  if (!hasGlob(root)) return file.startsWith(`${root}/`)
  return globCovers(root, file)
}

/**
 * **设备节点不是工作区文件**（TASK-090 的来源，此处作为分类的一等结果而不是旁路过滤器）。
 *
 * `/dev` 下的一切都是设备节点（`/dev/null`、`/dev/fd/N`、`/dev/stdout`…）：既不是卡的写范围、
 * 也不是公共面 ⇒ **一律不参与判定**（判不了就不判，与"认不出人"同一方向）。
 */
export function isDeviceNode(raw: string): boolean {
  const text = String(raw ?? '').trim().replace(/\\/gu, '/')
  return text === '/dev' || text.startsWith('/dev/')
}

/** 目标路径的归属（DEF-074：工作区外绝对路径必须**按原始路径点名**，不许剥成幽灵相对路径）。 */
export type TargetClass =
  | { kind: 'inside'; relative: string }
  /** 工作区外的绝对路径：判不了归属，但**拒绝时要点名原始路径**。 */
  | { kind: 'outside'; absolute: string }
  /** 设备节点 ⇒ 不参与判定。 */
  | { kind: 'device'; raw: string }
  /** 拿不到基准 ⇒ 判不了（fail-open 的同一方向：判不了就不判）。 */
  | { kind: 'unresolved'; raw: string }

/**
 * 把宿主给的路径归到"工作区内 / 工作区外 / 判不了"三类。
 *
 * `base`（会话工作目录）负责"相对路径往哪解析"，`root`（工作区根）负责"算不算在工作区内"——
 * 两个基准的分工与 `evaluateWriteScope` 一致（DEF-047 落点一）。
 */
/** 跨平台比较的**唯一基准**：一切路径先折成正斜杠。 */
function toPosixPath(path: string): string {
  return String(path ?? '').replace(/\\/gu, '/')
}

export interface WorkspaceRelation {
  kind: 'same' | 'inside' | 'outside'
  /** `inside` 时是相对根的路径（正斜杠） */
  relative: string
}

/**
 * **绝对路径 ⇄ 工作区根**的归属关系（`DEF-154`，Windows 实测：CI 红 39 格）。
 *
 * 病：`resolve()` 在 win32 返回**反斜杠**，而旧实现拼前缀用的是硬编码 `/`
 * （`` `${root.replace(/\/+$/u, '')}/` ``）⇒ `'D:\\a\\p\\src\\x.ts'.startsWith('D:\\a\\p/')` **恒 false**
 * ⇒ Windows 上**工作区内的一切写入都被判「工作区之外」**（误拒，直接让人没法干活）。
 * POSIX 上 `resolve()` 本来就返回 `/`，所以 Linux 全绿、只有 Windows 红 —— 这正是它长期没被发现的原因。
 *
 * 口径三条（都写进 `test/m212`）：
 *   ① **分隔符归一**：比较前两边都折成正斜杠（与 `normalizeWorkspacePath` 的既有口径一致）；
 *   ② **大小写**：只有显式 `caseInsensitive`（win32 的调用方默认传 true）才忽略 ——
 *      **不许**泄漏到 POSIX（Linux 上 `src/A.ts` 与 `src/a.ts` 是两个文件）；
 *   ③ **目录边界**：判 `inside` 必须差一个 `/`（`/a/p2` 不算 `/a/p` 的子路径）。
 */
export function workspaceRelation(
  absolute: string,
  root: string,
  options: { caseInsensitive?: boolean } = {},
): WorkspaceRelation {
  const slashedTarget = toPosixPath(absolute).trim().replace(/\/+$/u, '')
  const slashedRoot = toPosixPath(root).trim().replace(/\/+$/u, '')
  if (slashedRoot === '') return { kind: 'outside', relative: '' }
  const fold = (value: string): string => (options.caseInsensitive === true ? value.toLowerCase() : value)
  const target = fold(slashedTarget)
  const base = fold(slashedRoot)
  if (target === base) return { kind: 'same', relative: '' }
  if (!target.startsWith(`${base}/`)) return { kind: 'outside', relative: '' }
  const relative = normalizeScopePath(slashedTarget.slice(slashedRoot.length + 1))
  return { kind: 'inside', relative }
}

export function classifyTarget(raw: string, base: string | undefined, root: string | undefined): TargetClass {
  const text = String(raw ?? '').trim()
  // 设备节点先归类：它们永远不是工作区文件（不参与判定，而不是"当成越界写"）
  if (isDeviceNode(text)) return { kind: 'device', raw: text }
  const anchor = String(base ?? '').trim()
  if (text === '') return { kind: 'unresolved', raw: text }
  if (anchor === '') return { kind: 'unresolved', raw: text }
  const absolute = resolve(anchor, text)
  const boundary = String(root ?? '').trim() === '' ? anchor : String(root).trim()
  const normalizedRoot = resolve(boundary)
  // **DEF-154**：比较走 `workspaceRelation`（分隔符归一 + 目录边界；win32 才忽略大小写），
  // 不再在这里拼 `${root}/` —— 那个硬编码的 `/` 在 Windows 上让前缀判定恒 false。
  const relation = workspaceRelation(absolute, normalizedRoot, { caseInsensitive: process.platform === 'win32' })
  if (relation.kind === 'same') return { kind: 'inside', relative: '.' }
  if (relation.kind === 'inside') {
    return relation.relative === '' ? { kind: 'unresolved', raw: text } : { kind: 'inside', relative: relation.relative }
  }
  return { kind: 'outside', absolute: toPosixPath(absolute) }
}
