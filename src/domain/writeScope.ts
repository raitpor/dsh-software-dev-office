/**
 * **写入范围纪律（3a + 3b 两重限制，2026-10-08 用户裁定）**。
 *
 * 背景（真机 + 代码核实）：
 *   · tester 角色此前**没有 `edit`**，理由是"不得修改被测实现"。但掩码是**工具级**的：
 *     `write` 一样能覆盖实现、`bash` 更能（`sed -i`）——"没有 edit"既不是能力边界也不是路径边界；
 *     而 `write` 的代价是"读全文 → 整篇写回"，真机上 architect 正是这么把登记簿覆盖掉、23 条 DEV 正文永久丢失
 *     （SDO-23）⇒ 已给 architect 开 `edit`。所以口径改为：**`write` 与 `edit` 同权（谁能写谁就能改），
 *     独立性由"写在哪里"机械控制**。
 *   · 原来唯一"按路径"的纪律有两处**都是空转的**：`disciplineAllowPaths` / `disciplineTools` 两个配置
 *     **从来没人读**（死配置）；而 L3 阶段纪律里的 `path.startsWith('src/')` 也判不到真机——宿主传给
 *     `write`/`edit` 的 `file_path` 是**绝对路径**（真机子会话实录：
 *     `{"file_path":"/home/raiptor/gitrepo/…/sdo-test-new/lib/parse.js"}`）⇒ 前缀比对恒 false。
 *
 * 本模块就是那条"按路径"的纪律，两重限制：
 *   **3b 卡级**：调用方有**活着的认领卡** ⇒ 目标路径必须落在卡的 `writeScopes` 内；
 *   **3a 公共面**：`disciplineAllowPaths`（默认 `.sdo/`、`docs/`、`test/`）**不受卡范围约束** ——
 *      台账由 SDO 工具自己落（SDO-34）、派生文档与测试是跨卡共用的面。
 *
 * 纪律：**只对认得出的角色生效**（驾驶舱/未知 ⇒ 放行，认不出人不该让人干不了活）；读不出路径 ⇒ 不判；
 * `bash` 没有路径参数 ⇒ 本模块判不了（如实标 `checked: false`，靠 `done` 的 A2 写范围对账兜底）。
 */
import { auditWriteScopes } from '../integration/orchestrator.js'

export interface WriteScopeInput {
  /** 调用方角色（`cockpit` / 空 / 认不出 ⇒ 不拦） */
  role: string
  tool: string
  /** 目标路径（宿主的 `file_path` / `path` / `file` / `paths`，可能是绝对路径） */
  paths: readonly string[]
  /** 本次调用的工作区（拿不到 ⇒ 无法把绝对路径归一到相对 ⇒ 不判） */
  workspace?: string | undefined
  /** 受本纪律管辖的工具（`settings.disciplineTools`） */
  guardedTools: readonly string[]
  /** 公共放行面（`settings.disciplineAllowPaths`） */
  sharedPaths: readonly string[]
  /**
   * **活着的认领卡**的写范围。
   * `undefined` = 没有活卡（还没认领 / 已收工 / 认不出卡）⇒ 只能写公共面。
   * `[]` = 有卡但卡上没写范围（计划缺陷）⇒ 拒，并让流程官补上。
   */
  cardScopes?: readonly string[] | undefined
}

export type WriteScopeDenyCode = 'write-scope-violation' | 'write-scope-no-claim' | 'write-scope-empty-scope'

export type WriteScopeDecision =
  | { kind: 'allow'; checked: boolean; violations: string[] }
  | { kind: 'deny'; code: WriteScopeDenyCode; detail: string; violations: string[]; scope: string[] }

/**
 * 把宿主给的路径归一到**工作区相对路径**（POSIX 分隔符、无 `./`、折叠 `..`）。
 *
 * 为什么必须做：真机上宿主传的是绝对路径，而卡写范围是相对的（`lib/parse.js`）——
 * 不归一就永远比不上（原 L3 纪律就是这么空转的）。
 */
export function normalizeWorkspacePath(raw: string, workspace?: string | undefined): string {
  let path = String(raw ?? '').trim().replace(/\\/gu, '/')
  if (path === '') return ''
  let root = String(workspace ?? '').trim().replace(/\\/gu, '/')
  if (root !== '') {
    root = root.replace(/\/+$/u, '')
    if (path === root) return ''
    if (path.startsWith(`${root}/`)) path = path.slice(root.length + 1)
  }
  // 目录前缀的**尾斜杠必须保留**：卡写范围常写成 `lib/`，而 `auditWriteScopes` 用
  // `file === scope || file.startsWith(scope)` 判命中 —— 把 `lib/` 归一成 `lib` 会让 `libx/a.js`
  // 也算命中（**假放行**，比拒写更危险）。
  const directory = path.endsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  if (parts.length === 0) return ''
  return `${parts.join('/')}${directory ? '/' : ''}`
}

/** 该路径是否落在某个放行面/写范围里（**与 `done` 对账同一套语义**，只有一处实现）。 */
export function pathWithinScopes(path: string, scopes: readonly string[]): boolean {
  return auditWriteScopes([path], [...scopes]).ok
}

export function evaluateWriteScope(input: WriteScopeInput): WriteScopeDecision {
  const allow = (checked = false): WriteScopeDecision => ({ kind: 'allow', checked, violations: [] })
  // **认不出人的一律放行**（fail-open：纪律不能变成"插件认不出人就干不了活"）。
  // 调用方在 `attributed.kind === 'unknown'` 时**根本不会调到这里**；`cockpit` 是流程官
  // （它要维护 `.sdo/` 手可编辑真源与台账），`'dispatched'` 是"子会话但还没认领"（仍受卡级约束）。
  if (input.role === '' || input.role === 'cockpit') return allow()
  if (!(input.guardedTools as readonly string[]).includes(input.tool)) return allow()
  // 该工具没有路径参数（bash）⇒ 本模块判不了；如实 `checked: false`，由 `done` 的 A2 对账兜底
  if ((input.paths ?? []).length === 0) return allow(false)
  // 工作区拿不到 ⇒ 绝对路径无法归一 ⇒ 不判（fail-open，与"认不出人"同一方向）
  if (input.workspace === undefined || String(input.workspace).trim() === '') return allow()

  const shared = input.sharedPaths.map((item) => normalizeWorkspacePath(item, undefined)).filter((item) => item !== '')
  const relative = input.paths
    .map((path) => normalizeWorkspacePath(path, input.workspace))
    .filter((path) => path !== '')
  if (relative.length === 0) return allow()

  // **3a 公共面**：台账（`.sdo/`）、派生文档（`docs/`）、测试（`test/`）不受卡写范围约束
  const outsideShared = relative.filter((path) => !shared.some((prefix) => path === prefix || path.startsWith(prefix)))
  if (outsideShared.length === 0) return allow(true)

  // **3b 卡级**：没有活卡 ⇒ 只能写公共面（先把卡认领了，写范围以卡为准）
  if (input.cardScopes === undefined) {
    return {
      kind: 'deny',
      code: 'write-scope-no-claim',
      detail: outsideShared.join('、'),
      violations: outsideShared,
      scope: [],
    }
  }
  // 有卡但卡上没写范围 = 计划缺陷（C-31 会判红）⇒ 拒，并给出可执行的补救
  const scopes = input.cardScopes.map((item) => normalizeWorkspacePath(item, undefined)).filter((item) => item !== '')
  if (scopes.length === 0) {
    return {
      kind: 'deny',
      code: 'write-scope-empty-scope',
      detail: outsideShared.join('、'),
      violations: outsideShared,
      scope: [],
    }
  }
  const audit = auditWriteScopes(outsideShared, scopes)
  return audit.ok
    ? allow(true)
    : {
        kind: 'deny',
        code: 'write-scope-violation',
        detail: audit.violations.join('、'),
        violations: audit.violations,
        scope: scopes,
      }
}
