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
 *     `{"file_path":"<工作区根>/lib/parse.js"}`）⇒ 前缀比对恒 false。
 *
 * 本模块就是那条"按路径"的纪律，两重限制：
 *   **3b 卡级**：调用方有**活着的认领卡** ⇒ 目标路径必须落在卡的 `writeScopes` 内；
 *   **3a 公共面**：`disciplineAllowPaths`（默认 `.sdo/`、`docs/`、`test/`）**不受卡范围约束** ——
 *      台账由 SDO 工具自己落（SDO-34）、派生文档与测试是跨卡共用的面。
 *
 * 纪律：**只对认得出的角色生效**（驾驶舱/未知 ⇒ 放行，认不出人不该让人干不了活）；读不出路径 ⇒ 不判；
 * 命令类调用由调用方先做**静态形态扫描**（`detectCommandWrites`）再把写目标并进 `paths` 一起判 ——
 * 该扫描**非穷举**，如实披露剩余风险，由 `done` 的 A2 写范围对账兜底。
 *
 * **DEF-047 落点一（两个基准，2026-10-13）**：`workspace`（会话 cwd）与 `workspaceRoot`（工作区根）
 * 是**两个不同的基准** —— 前者管"相对路径往哪解析"，后者管"写范围/公共面的前缀拿谁比"。
 * 会话工作目录是子目录时二者不相等，旧实现挤在一个字段上 ⇒ 在范围内的路径被误拒。
 */
import { resolve } from 'node:path'

import { auditWriteScopes } from '../integration/orchestrator.js'
import { classifyTarget, isDeviceNode, scopePathWithin } from './scopePaths.js'

export interface WriteScopeInput {
  /** 调用方角色（`cockpit` / 空 / 认不出 ⇒ 不拦） */
  role: string
  tool: string
  /** 目标路径（宿主的 `file_path` / `path` / `file` / `paths`，可能是绝对路径） */
  paths: readonly string[]
  /** **会话工作目录**（`call.cwd`）—— 相对路径按它解析（拿不到 ⇒ 无法归一 ⇒ 不判） */
  workspace?: string | undefined
  /**
   * **工作区根**（`findProjectRoot` 的既有发现口径）—— 写范围与公共面是**声明形态**（相对工作区根），
   * 前缀比对必须按它。
   *
   * **DEF-047 落点一**：`workspace` 与 `workspaceRoot` 是**两个不同的基准**，会话工作目录是子目录时
   * 二者不相等 —— 旧实现只有一个 `workspace` 字段同时承担两者：相对路径确实按会话 cwd 解析（对 ✓），
   * 但拿会话 cwd 归一出 `domain/writeScope.ts` 去比卡上的 `src/domain/writeScope.ts` 恒不命中 ⇒
   * **在范围内的路径被误拒**（真机现象：绝对路径被拒、相对路径通过）。
   * 缺省退回 `workspace` ⇒ 单基准调用方**行为与修前逐字一致**（不改变任何既有判定语义）。
   */
  workspaceRoot?: string | undefined
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

export type WriteScopeDenyCode =
  | 'write-scope-violation'
  | 'write-scope-no-claim'
  | 'write-scope-empty-scope'
  // **DEF-074**：工作区外的绝对路径（卡写范围是工作区内的声明形态 ⇒ 判不了归属 ⇒ 拒绝并**点名原始路径**）
  | 'write-scope-outside-workspace'

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

/**
 * **设备节点不是工作区文件**（TASK-090 假阳性修复①，方向是**误拒**）。
 *
 * 现场（实现会话一手）：`cat .sdo/tasks/TASK-090.yml 2>/dev/null` 被判成"要写 `dev/null`"而整条命令被拒；
 * `echo x > /dev/null`、`echo x > /dev/fd/3` 同理。根因是**前缀剥离**：`/dev/null` 不以工作区根开头，
 * 于是原样落进"相对路径"的坐标系，变成 `dev/null` —— 一个工作区里**并不存在**的相对路径，
 * 与卡的写范围当然比不上。
 *
 * `/dev` 下的一切都是设备节点（`/dev/null`、`/dev/fd/N`、`/dev/stdout`、`/dev/stderr`…），
 * 既不是卡的写范围、也不是公共面 ⇒ **一律不参与判定**（判不了就不判：与"认不出人"同一方向）。
 */
export function isDevicePath(raw: string): boolean {
  // 设备节点的判定只有一处实现（`scopePaths.isDeviceNode`），这里只是对外保留的名字
  return isDeviceNode(raw)
}

/** 该路径是否落在某个放行面/写范围里（**与 `done` 对账同一套语义**，只有一处实现）。 */
export function pathWithinScopes(path: string, scopes: readonly string[]): boolean {
  return auditWriteScopes([path], [...scopes]).ok
}

/**
 * **命令里的"目录基准"写法**（`git -C <dir> …`，TASK-109 / REV-039 发现三②）——
 * 把**相对 `<dir>`** 的目标合成为"从**会话 cwd** 起可解析"的路径。
 *
 * 为什么必须合成（不合成就是 DEF-074 同族的**幽灵路径**）：`-C <dir>` 改变的是**命令自己的**
 * 工作目录，于是命令文本里的相对路径（`git -C src restore index.ts` 的 `index.ts`）实际指的是
 * `<dir>/index.ts`。若把 `index.ts` 原样交给判定，它会被按**会话 cwd** 解析，落到工作区根上的
 * `index.ts` —— 一个工作区里**并不存在**的路径：越界时点名的是错的文件，而在范围内的窄写入
 * （卡声明 `src/index.ts`）会被**误拒**（"拦错了路径"的另一面）。
 *
 * 边界（方向一律保守：判不了就不猜，与 `resolveAgainst` 同一方向）：
 *   · `<target>` 是绝对路径 ⇒ **原样返回**（它自足，不需要基准）；
 *   · `<base>` 拿不到 ⇒ 原样返回（没有基准就无从合成）；
 *   · 只做**文本拼接**，`..` 与分隔符归一留给判定层（`resolveAgainst` 的既有口径）——
 *     在这里折叠会让"`../wt` 这类往上跳的基准"被二次解析，两处各算一遍就会打架。
 */
export function composeUnderBase(base: string | undefined, target: string): string {
  const raw = String(target ?? '').trim()
  if (raw === '') return ''
  const dir = String(base ?? '').trim().replace(/\\/gu, '/')
  if (dir === '') return raw
  const normalized = raw.replace(/\\/gu, '/')
  // 绝对路径自足（POSIX `/…` 与 Windows 盘符 `C:/…` 同理由）；归属交给判定层
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) return normalized
  return `${dir.replace(/\/+$/u, '')}/${normalized}`
}

/**
 * **绝对化后再相对化**：把目标路径解析成绝对路径，再表达为"相对 `base` 的路径"。
 *
 * 为什么必须**先绝对化**（DEF-047 落点一的真缺陷，实测踩过）：
 * `normalizeWorkspacePath(raw, root)` 只做**前缀剥离**（`raw.startsWith(root + '/')` 才剥）。于是
 * 目标路径**已经是相对的**（真机上 `edit` 的 `file_path` 常是 `src/x.ts`）时，它**原样返回** ——
 * `normalizeWorkspacePath('domain/x.ts', <工作区根>)` 得到的仍是 `domain/x.ts`，**根本没拿根去解析**。
 * 基准不同（会话 cwd 是子目录）时，"相对解析"与"前缀比对"要的是同一文件的**两种相对写法**，
 * 只有在"先绝对化"这一步之后才谈得上分别相对化；否则第二份基准是**空转**的。
 *
 * `base` 拿不到 ⇒ 不做（fail-open 的同一方向：判不了就不判，绝不猜）。
 */
function resolveAgainst(raw: string, base: string | undefined): string {
  const text = String(raw ?? '').trim()
  if (text === '' || base === undefined || String(base).trim() === '') return ''
  return normalizeWorkspacePath(resolve(base, text), resolve(base))
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
  // **TASK-090 假阳性修复①**：设备节点（`/dev/…`）先摘掉再判 —— 它们不是工作区文件，
  // 归一后长成 `dev/null` 这种"不存在的相对路径"，只会把命令误判成越界写。
  // 全被摘掉 = 本次没有可判写的目标（与"该工具没有路径参数"同一个出口，如实 `checked: false`）。
  // **DEF-074**：归属分类是**一等判定**（设备节点 / 工作区外 / 工作区内 / 判不了），
  // 不再靠"按家族过滤 + 前缀剥离"两套旁路 —— 旧实现把 `/tmp/x` 剥成 `tmp/x`（工作区里并不存在
  // 的**幽灵相对路径**），拒绝时点名的是幽灵而不是真实目标。
  const workspaceRaw = input.workspace === undefined ? '' : String(input.workspace).trim()
  const rootForClassify = input.workspaceRoot === undefined ? input.workspace : input.workspaceRoot
  const classified = (input.paths ?? []).map((path) => classifyTarget(path, input.workspace, rootForClassify))
  const outsiders = classified.filter((item) => item.kind === 'outside')
  if (outsiders.length > 0 && workspaceRaw !== '') {
    // 工作区外的写入：判不了归属（卡写范围是**工作区内**的声明形态），因此**拒绝并点名原始绝对路径**。
    const absolute = outsiders.map((item) => (item.kind === 'outside' ? item.absolute : ''))
    return {
      kind: 'deny',
      code: 'write-scope-outside-workspace',
      detail: absolute.join('、'),
      violations: absolute,
      scope: [],
    }
  }
  // **`DEF-148`（`TASK-167` A3，2026-10-21 裁定 a）**：这里是**单列特例过滤**，已删 ——
  // 设备节点的判定只有一处（`scopePaths.classifyTarget` 的 `{ kind: 'device' }` 分支）。
  // **`DEF-150`**：按 `classified` 的**下标**对位排除，不按字符串相等 —— `raw` 是**trim 过**的，
  // 拿它当身份键会让带前后空白的 `/dev/null` 漏回判定面（并被剥成 `dev/null` 这个幽灵相对路径，
  // 正是 `DEF-074` 那一族假阳性）。`classified` 与 `input.paths` 同长同序，下标是唯一不会错位的身份。
  const candidates = (input.paths ?? []).filter((_path, index) => classified[index]?.kind !== 'device')
  if (candidates.length === 0) return allow()
  // 工作区拿不到 ⇒ 绝对路径无法归一 ⇒ 不判（fail-open，与"认不出人"同一方向）
  if (workspaceRaw === '') return allow()

  // **DEF-047 落点一**：两个基准分工 —— `workspace`（会话 cwd）负责"相对路径往哪解析"，
  // `workspaceRoot`（工作区根）负责"写范围与公共面的前缀拿谁比"。缺省回退 ⇒ 单基准调用方行为不变。
  const rootRaw = input.workspaceRoot === undefined ? '' : String(input.workspaceRoot).trim()
  const root = rootRaw === '' ? input.workspace : input.workspaceRoot
  const shared = input.sharedPaths.map((item) => normalizeWorkspacePath(item, undefined)).filter((item) => item !== '')
  const relative = candidates
    .map((path) => resolveAgainst(path, input.workspace))
    .filter((path) => path !== '')
  if (relative.length === 0) return allow()

  // 声明形态（**相对工作区根**，即卡的 `writeScopes` 与 `disciplineAllowPaths` 的写法）：前缀比对拿它比。
  // 两个基准各解析一次同一批 `input.paths`；缺省（`workspaceRoot` 未给）时 `root === workspace`，
  // 两个数组逐字相同 ⇒ **与修前行为完全一致**（这是"不改既有判定语义"的机械保证）。
  const declared = candidates
    .map((path) => resolveAgainst(path, root))
    .filter((path) => path !== '')

  // **3a 公共面**：台账（`.sdo/`）、派生文档（`docs/`）、测试（`test/`）不受卡写范围约束
  // **ADR-009**：公共面命中同样走唯一出口（目录边界前缀），与写范围判定同一套语义
  const outsideShared = declared.filter((path) => !shared.some((prefix) => scopePathWithin(path, prefix)))
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
