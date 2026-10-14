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
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
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
  const file = normalizeScopePath(path)
  const root = normalizeScopePath(scope)
  if (file === '' || root === '') return false
  return file === root || file.startsWith(`${root}/`)
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
  const withSlash = `${normalizedRoot.replace(/\/+$/u, '')}/`
  if (absolute === normalizedRoot) return { kind: 'inside', relative: '.' }
  if (absolute.startsWith(withSlash)) {
    const relative = normalizeScopePath(absolute.slice(withSlash.length))
    return relative === '' ? { kind: 'unresolved', raw: text } : { kind: 'inside', relative }
  }
  return { kind: 'outside', absolute: absolute.replace(/\\/gu, '/') }
}
