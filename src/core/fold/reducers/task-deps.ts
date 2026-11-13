import { fail, payloadOf, reqStringArray, rowOf, subjectId, patchRow } from '../guards.js';
import type { Event, FoldWorking } from '../types.js';

function requireTask(state: FoldWorking, event: Event): void {
  if (rowOf(state, 'task', subjectId(event)) === undefined) {
    fail(event, `task ${subjectId(event)} does not exist`);
  }
}

function reachesTask(state: FoldWorking, startId: string, targetId: string): boolean {
  const stack = [startId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === targetId) {
      return true;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const row = state.tables.task[id];
    if (row === undefined) {
      continue;
    }
    for (const dep of row['blocked_by'] as readonly string[]) {
      if (dep.startsWith('TASK-') || state.tables.task[dep] !== undefined) {
        stack.push(dep);
      }
    }
  }
  return false;
}
export function taskDependenciesChanged(state: FoldWorking, event: Event): void {
  requireTask(state, event);
  const payload = payloadOf(event);
  const deps = reqStringArray(event, payload, 'blocked_by');
  const id = subjectId(event);
  for (const dep of deps) {
    if (dep === id) {
      return fail(event, `dependency cycle: ${id} depends on itself`);
    }
    if (state.tables.task[dep] !== undefined && reachesTask(state, dep, id)) {
      return fail(event, `dependency cycle: ${dep} already depends on ${id}`);
    }
  }
  patchRow(state, 'task', id, event, { blocked_by: deps });
}

export const TASK_DEP_REDUCERS = {
  'task.dependencies_changed': taskDependenciesChanged,
} as const;
