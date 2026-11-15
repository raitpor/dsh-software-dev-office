/**
 * M3-0 · 决策权矩阵机器化（docs/07 §2 是唯一真源）。
 *
 * 硬口径（卡 C2/C6）：
 * 1. **矩阵是数据不是代码**：本模块把 `docs/07` §2 的表格解析成目录，代码只查目录；
 *    文档表格的行数/行标签与 `MATRIX_ACTIONS` 不一致、或出现目录里没有的动作 ⇒ 抛错
 *    （`make check` / 测试红），逼迫「文档加一行 ⇒ 登记动作 + 迁移 008 补行」。
 * 2. **无通配**：动作、权名、scope 都不接受 `*`；目录里出现通配直接抛错。
 * 3. 动作 id 是唯一需要人工桥接的东西（文档写中文动作名），桥接表就是 `MATRIX_ACTIONS`；
 *    其余字段（所需权、可自签、可双人）全部从表格文本解析。
 *
 * 本模块是纯函数：不读 fs、不碰 db。调用方把 markdown 文本传进来（测试读真实文件，
 * 迁移 008 的种子行由构建期用同一解析器生成）。
 */

export const RIGHT_NAMES = ['read', 'write', 'review', 'decide', 'sign', 'admin', 'plan', 'assign', 'escalate'] as const;
export type RightName = (typeof RIGHT_NAMES)[number];

export const SCOPE_PREFIXES = ['module', 'domain', 'release'] as const;
export type ScopePrefix = (typeof SCOPE_PREFIXES)[number];

/** 文档里的 `@scope` 是通用占位（assign@scope / escalate@scope），匹配任意前缀。 */
export type RequiredScope = ScopePrefix | 'scope';

export const DUAL_HUMAN_MODES = ['no', 'configurable', 'independence', 'yes'] as const;
export type DualHuman = (typeof DUAL_HUMAN_MODES)[number];

export interface RequiredRight {
  readonly right: RightName;
  readonly scope: RequiredScope;
}

export interface MatrixEntry {
  readonly action: string;
  readonly required: readonly RequiredRight[];
  readonly self_sign: boolean | null;
  readonly dual_human: DualHuman;
  readonly boot_only: boolean;
  readonly doc_row: number;
  readonly doc_label: string;
}

export interface ParsedDocsRow {
  /** 表格数据行序号（0 基，表头与分隔行不计）。 */
  readonly index: number;
  readonly label: string;
  readonly raw: string;
  readonly required: readonly RequiredRight[];
  readonly self_sign: boolean | null;
  readonly dual_human: DualHuman;
}

interface ActionSpec {
  readonly index: number;
  readonly label: string;
  readonly actions: readonly string[];
  readonly boot_only?: boolean;
}

/**
 * 文档行 → 动作 id 的桥接表（唯一人工维护的映射）。
 * 行序号 = 去掉表头/分隔行后的 0 基序号；文档表格改动（增/删/改行）必须同步这里。
 * 第 0 行的「建卡」由第 2 行 `create` 精化（`write@module` 与 `plan@domain` 冲突），
 * 因此第 0 行只登记 `claim`/`block`，冲突已在 M3-0 卡的离线记录里说明。
 */
export const MATRIX_ACTIONS: readonly ActionSpec[] = [
  { index: 0, label: '建卡/认领/阻塞', actions: ['claim', 'block'] },
  { index: 1, label: '提议目标/拆解', actions: ['propose_plan'] },
  { index: 2, label: '建卡', actions: ['create'] },
  { index: 3, label: '派发/预占/再平衡', actions: ['dispatch', 'assign', 'unassign'] },
  { index: 4, label: '解阻塞', actions: ['unblock'] },
  { index: 5, label: '复述', actions: ['restate'] },
  { index: 6, label: '建返工卡', actions: ['rework'] },
  { index: 7, label: '改依赖', actions: ['dependencies'] },
  { index: 8, label: '升级给人', actions: ['escalate'] },
  { index: 9, label: '撤回自己的提问', actions: ['withdraw_attention'] },
  { index: 10, label: '改部署配置', actions: ['config'] },
  { index: 11, label: '初始化部署配置', actions: ['config.bootstrap'], boot_only: true },
  { index: 12, label: '记缺陷', actions: ['defect.record'] },
  { index: 13, label: '关缺陷', actions: ['defect.close'] },
  { index: 14, label: '评审', actions: ['review'] },
  { index: 15, label: '核实发现', actions: ['verify_finding'] },
  { index: 16, label: '采纳评审', actions: ['adopt_review'] },
  { index: 17, label: '冻结版本/豁免', actions: ['freeze', 'waive'] },
  { index: 18, label: '回滚/作废冻结版', actions: ['rollback'] },
  { index: 19, label: '改意图/改条款', actions: ['amend_intent', 'amend_clause'] },
  { index: 20, label: '撤签/撤销决策', actions: ['revoke_decision'] },
];

const RIGHT_SET = new Set<string>(RIGHT_NAMES);

function text(value: string): string {
  return value.trim();
}

/** 去掉 markdown 强调与括号补充，得到用于比对的短标签。 */
export function normalizeLabel(raw: string): string {
  return text(raw)
    .replace(/\*\*/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, '')
    .replace(/\//g, '/');
}

function splitCells(line: string): string[] {
  const inner = text(line).replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map(text);
}

function parseRequired(cell: string): RequiredRight[] {
  // 括号只当注释：`docs/07` 的否定句/补充说明都在括号里（如 dependencies 的
  // 「（不是 `write@module`——依赖是计划，不是代码）」），括号内一律不参与授权解析。
  // 括号外再截到第一个「不是/而非」之前，防止将来把否定写进正文时被静默收成授权。
  const withoutNotes = cell.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');
  const negation = withoutNotes.search(/不是|而非/);
  const scoped = negation < 0 ? withoutNotes : withoutNotes.slice(0, negation);

  const required: RequiredRight[] = [];
  let lastScope: RequiredScope | undefined;
  const pattern = /`([a-z_]+)(?:@(module|domain|release|scope))?`/g;
  for (const match of scoped.matchAll(pattern)) {
    const name = match[1] ?? '';
    const scope = match[2] as RequiredScope | undefined;
    if (scope !== undefined) {
      // fail-closed：带 @scope 的 token 必须是已登记权名，不许 continue 静默丢权
      // （否则 required 变空 = 任何人放行）。
      if (!RIGHT_SET.has(name)) {
        throw new Error(
          `unknown_right_in_matrix：docs/07 §2 出现未登记权名「${name}@${scope}」。` +
            '先更新 RIGHT_NAMES，再重新生成迁移 008。',
        );
      }
      lastScope = scope;
      required.push({ right: name as RightName, scope });
      continue;
    }
    // 裸 `sign`：继承同一格里前一个 `x@scope` 的作用域（`decide@release + sign`）。
    if (name === 'sign' && lastScope !== undefined) {
      required.push({ right: 'sign', scope: lastScope });
      continue;
    }
    // 裸权名（RIGHT_NAMES 之一）却漏了 @scope ⇒ 解析失败，不许静默丢。
    if (RIGHT_SET.has(name)) {
      throw new Error(`unknown_right_in_matrix：权名「${name}」缺少 @scope（docs/07 §2 授权格）`);
    }
    // 其余反引号 token 是正文引用（`verify_run`/`config`/`task.assigned` 等），不是授权。
  }
  return required;
}

function parseSelfSign(cell: string): boolean | null {
  const plain = text(cell).replace(/\*\*/g, '');
  if (plain.startsWith('—') || plain.length === 0) return null;
  if (plain.includes('不能')) return false;
  if (plain.startsWith('是')) return true;
  return null;
}

function parseDualHuman(cell: string): DualHuman {
  const plain = text(cell).replace(/\*\*/g, '');
  if (plain.includes('独立性')) return 'independence';
  if (plain.startsWith('是')) return 'yes';
  if (plain.includes('可配置')) return 'configurable';
  return 'no';
}

/** 把 `docs/07` §2 的 markdown 表格解析成行（不含表头/分隔行）。 */
export function parseMatrixTable(markdown: string): ParsedDocsRow[] {
  const section = markdown.indexOf('## 2. 决策权矩阵');
  if (section < 0) throw new Error('docs/07 缺少「## 2. 决策权矩阵」段，无法机器解析矩阵');
  const after = markdown.slice(section);
  const rows: ParsedDocsRow[] = [];
  let started = false;
  for (const line of after.split('\n')) {
    if (!line.startsWith('|')) {
      if (started) break; // 表格结束
      continue;
    }
    const cells = splitCells(line);
    if (!started) {
      started = true; // 表头
      continue;
    }
    if (cells.every((cell) => /^-+$/.test(cell.replace(/:/g, '')) || cell.length === 0)) continue; // 分隔行
    if (cells.length < 4) throw new Error(`docs/07 §2 表格行列数不足（需要 4 列）：${line}`);
    const raw = cells[0] ?? '';
    const rightsCell = cells[1] ?? '';
    rows.push({
      index: rows.length,
      raw,
      label: normalizeLabel(raw),
      required: parseRequired(rightsCell),
      self_sign: parseSelfSign(cells[2] ?? ''),
      dual_human: parseDualHuman(cells[3] ?? ''),
    });
  }
  if (rows.length === 0) throw new Error('docs/07 §2 决策权矩阵表格为空');
  return rows;
}

/** 解析后的表格 → 目录（动作粒度的数据行）。文档与桥接表不一致时抛错。 */
/**
 * 显式“不需要额外权”白名单（空 required 只允许这些动作）。
 * 依据（docs/07 §2 行号）：
 * - defect.close    : docs/07:50「不需要额外权：复验 verify_run 通过后由工具写」
 * - verify_finding  : docs/07:52「不需要额外权：只认是该对象的 producer」
 * - config.bootstrap: docs/07:48「boot 系统 actor（只此一处豁免 admin）」
 * 其余动作的授权格解析为空 ⇒ 视为解析失败（fail-closed），不许静默变成“谁都能做”。
 */
export const EMPTY_REQUIRED_ACTIONS: ReadonlySet<string> = new Set(['defect.close', 'verify_finding', 'config.bootstrap']);

export function buildMatrixCatalog(markdown: string): MatrixEntry[] {
  const rows = parseMatrixTable(markdown);
  if (rows.length !== MATRIX_ACTIONS.length) {
    throw new Error(
      `docs/07 §2 表格行数变化：文档 ${rows.length} 行，登记 ${MATRIX_ACTIONS.length} 行。` +
        '新增/删除动作必须同时更新 src/core/auth/matrix.ts 的 MATRIX_ACTIONS 与迁移 008。',
    );
  }
  const entries: MatrixEntry[] = [];
  const seen = new Set<string>();
  for (const spec of MATRIX_ACTIONS) {
    const row = rows[spec.index];
    if (row === undefined) throw new Error(`docs/07 §2 表格缺少第 ${spec.index} 行（${spec.label}）`);
    if (row.label !== spec.label) {
      throw new Error(
        `docs/07 §2 表格第 ${spec.index} 行标签变化：文档「${row.label}」，登记「${spec.label}」。` +
          '改文档动作名必须同步 MATRIX_ACTIONS 与迁移 008。',
      );
    }
    for (const action of spec.actions) {
      if (action.includes('*')) throw new Error(`动作 id 不得含通配：${action}`);
      if (seen.has(action)) throw new Error(`动作 id 重复登记：${action}`);
      seen.add(action);
      for (const required of row.required) {
        if ((required.right as string) === '*' || String(required.scope) === '*') {
          throw new Error(`docs/07 §2 出现通配授权：${action}`);
        }
      }
      if (row.required.length === 0 && !EMPTY_REQUIRED_ACTIONS.has(action)) {
        throw new Error(
          `unknown_right_in_matrix：动作 ${action} 的授权格解析为空（docs/07 第 ${row.index} 行）。` +
            '空授权只允许显式白名单（defect.close/verify_finding/config.bootstrap）；' +
            '否则说明授权格写法被改成否定句/破折号或解析规则失效，必须修文档或 MATRIX_ACTIONS。',
        );
      }
      entries.push({
        action,
        required: row.required,
        self_sign: row.self_sign,
        dual_human: row.dual_human,
        boot_only: spec.boot_only === true,
        doc_row: row.index,
        doc_label: row.label,
      });
    }
  }
  return entries;
}
