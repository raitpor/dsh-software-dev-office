/**
 * stage DAG 校验（C2）：`after` 是唯一的先后表达，数组顺序不承载语义。
 * 每条边必须指向存在的 stage、图无环、所有 stage 都能从入口（`after` 为空的多根）到达。
 */

import type { BaselineStage } from './types.js';

export interface GraphCheck {
  readonly ok: boolean;
  readonly duplicateIds: readonly string[];
  readonly missingEdges: readonly string[];
  readonly cycles: readonly string[];
  readonly unreachable: readonly string[];
}

/** 返回入口可达集合；环上的节点不会被计入。 */
function reachableFromRoots(stages: readonly BaselineStage[], ids: ReadonlySet<string>): Set<string> {
  const roots = stages.filter((stage) => stage.after.length === 0).map((stage) => stage.id);
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const stage of stages) {
      if (stage.after.includes(current) && !seen.has(stage.id) && ids.has(stage.id)) stack.push(stage.id);
    }
  }
  return seen;
}

/** 找环（返回参与环的节点集合）：DFS 路径上回边指向的节点到栈顶都算环。 */
function nodesInCycles(stages: readonly BaselineStage[], ids: ReadonlySet<string>): Set<string> {
  const color = new Map<string, 'visiting' | 'done'>();
  const inCycle = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    const state = color.get(id);
    if (state === 'visiting') {
      const start = path.lastIndexOf(id);
      for (let index = start; index < path.length; index += 1) inCycle.add(path[index] as string);
      return;
    }
    if (state === 'done') return;
    color.set(id, 'visiting');
    path.push(id);
    const stage = stages.find((candidate) => candidate.id === id);
    for (const edge of stage?.after ?? []) {
      if (ids.has(edge)) visit(edge);
    }
    path.pop();
    color.set(id, 'done');
  };
  for (const id of ids) visit(id);
  return inCycle;
}

export function checkGraph(stages: readonly BaselineStage[]): GraphCheck {
  const counts = new Map<string, number>();
  for (const stage of stages) counts.set(stage.id, (counts.get(stage.id) ?? 0) + 1);
  const duplicateIds = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const ids = new Set(counts.keys());
  const missingEdges: string[] = [];
  for (const stage of stages) {
    for (const edge of stage.after) {
      if (!ids.has(edge)) missingEdges.push(`${stage.id}->${edge}`);
    }
  }
  const cycles = [...nodesInCycles(stages, ids)];
  const reachable = reachableFromRoots(stages, ids);
  // 环上的节点同样到不了入口；两者都算「不可达」，`cycles` 只用于定位原因。
  const unreachable = [...ids].filter((id) => !reachable.has(id));
  return {
    ok: duplicateIds.length === 0 && missingEdges.length === 0 && cycles.length === 0 && unreachable.length === 0,
    duplicateIds,
    missingEdges,
    cycles,
    unreachable,
  };
}
