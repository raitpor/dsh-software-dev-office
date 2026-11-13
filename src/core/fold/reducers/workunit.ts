import { rowOf, upsert } from '../guards.js';
import type { Event, FoldWorking } from '../types.js';

/**
 * docs/03:35：work_unit = 一卡一判据一证据一行，由 task.claimed + evidence.attached 折叠。
 * 两边都齐（task 存在、criterion/evidence 存在）才落行；id 按 task 派生，配合 UNIQUE(task_id)。
 */
export function materializeWorkUnit(
  state: FoldWorking,
  event: Event,
  taskId: string,
  criterionId: string,
  evidenceId: string,
): void {
  if (rowOf(state, 'task', taskId) === undefined) {
    return;
  }
  const criterion = rowOf(state, 'criterion', criterionId);
  const evidence = rowOf(state, 'evidence', evidenceId);
  if (criterion === undefined || evidence === undefined) {
    return;
  }
  upsert(state, 'work_unit', `wu:${taskId}`, {
    id: `wu:${taskId}`,
    task_id: taskId,
    criterion_id: criterionId,
    spec_id: String(criterion['spec_id']),
    evidence_id: evidenceId,
    at: event.at,
  });
}
