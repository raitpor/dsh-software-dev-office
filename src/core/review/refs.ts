/**
 * M2-4 · 任务 → 条款引用（准入/变更闭包共用的**唯一**解析口径）。
 *
 * 契约（写进 `README` 与卡面）：
 * - `task.subject_kind='spec'` ⇒ `subject_id` 是该卡直接实现的条款；
 * - `task.inputs[]` 里 `spec:<id>` / `requirement:<id>` / `design:<id>` 表示消费的条款；
 * - `task.inputs[]` 里 `criterion:<id>` 经 `criterion.spec_id` 反查条款；
 * - 裸的 spec id（`S-…`）若在 fold 里有行，也计入（兼容手写夹具/旧数据）。
 *
 * 只读 fold 记忆态：不做 SQL、不依赖物化表（M1-5 的 D-037 同口径）。
 */
import type { FoldState, Row } from '../fold/types.js';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function specRow(state: FoldState, id: string): Row | undefined {
  return state.tables.spec[id];
}

const PREFIXES = ['spec:', 'requirement:', 'design:', 'contract:'] as const;

/** 解析 inputs 字符串中的条款 id（去重、按出现顺序）。 */
function specIdsFromInputs(state: FoldState, inputs: unknown): string[] {
  if (!Array.isArray(inputs)) return [];
  const ids: string[] = [];
  for (const raw of inputs) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const criterion = raw.startsWith('criterion:') ? state.tables.criterion[raw.slice('criterion:'.length)] : undefined;
    if (criterion !== undefined) {
      const specId = text(criterion['spec_id']);
      if (specId.length > 0) ids.push(specId);
      continue;
    }
    let pushed = false;
    for (const prefix of PREFIXES) {
      if (raw.startsWith(prefix)) {
        ids.push(raw.slice(prefix.length));
        pushed = true;
        break;
      }
    }
    if (pushed) continue;
    if (specRow(state, raw) !== undefined) ids.push(raw);
  }
  return ids;
}

/** C4/C6 的唯一引用口径：某张卡关联的全部条款 id（只返回 fold 里存在的 spec 行）。 */
export function referencedSpecIds(state: FoldState, taskId: string): string[] {
  const task = state.tables.task[taskId];
  if (task === undefined) return [];
  const collected = new Set<string>();
  if (task['subject_kind'] === 'spec') {
    const subject = text(task['subject_id']);
    if (subject.length > 0) collected.add(subject);
  }
  for (const id of specIdsFromInputs(state, task['inputs'])) collected.add(id);
  return [...collected].filter((id) => specRow(state, id) !== undefined).sort();
}

/** input 里是否引用 release（`review.required` 的“与 release 相关”触发条件）。 */
export function referencesRelease(state: FoldState, taskId: string): boolean {
  const task = state.tables.task[taskId];
  if (task === undefined) return false;
  const inputs = task['inputs'];
  if (!Array.isArray(inputs)) return false;
  return inputs.some((raw) => typeof raw === 'string' && raw.startsWith('release:'));
}
