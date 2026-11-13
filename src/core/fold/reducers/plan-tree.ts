import { fail } from '../guards.js';
import { decisionPayload } from '../decisions.js';
import type { Event, Row } from '../types.js';

/**
 * docs/02:389：goal 行的字段必须与人签 plan 载荷里的同 id 节点逐字段相等；
 * 否则树是模型自己长出来的（M1 verify 必红）。
 */
/** 与 docs/02:389 的 verify 字段集对齐：父、类型、验收判据三样都要与 plan 树一致。 */
export function planNodeMismatch(
  planNode: Row,
  parentId: string | null,
  kind: unknown,
  acceptanceId: string | null,
): boolean {
  return (
    !sameValue(planNode['parent_id'], parentId) ||
    planNode['kind'] !== kind ||
    !sameValue(planNode['acceptance_criterion_id'] ?? null, acceptanceId)
  );
}

export function planPayload(
  event: Event,
  decisionId: string,
  decision: Row,
): { nodeIds: readonly string[]; tree: readonly Record<string, unknown>[] } {
  const body = decisionPayload(decision);
  if (body === undefined) {
    return fail(event, `decision ${decisionId} (kind plan) must carry payload`);
  }
  const nodeIds = body['node_ids'];
  if (!Array.isArray(nodeIds) || !nodeIds.every((value) => typeof value === 'string')) {
    return fail(event, `decision ${decisionId} payload.node_ids must be a string array`);
  }
  const tree = body['tree'];
  if (!Array.isArray(tree)) {
    return fail(event, `decision ${decisionId} payload.tree must be an array`);
  }
  return { nodeIds, tree: tree as readonly Record<string, unknown>[] };
}

export function requirePlanNode(
  event: Event,
  decisionId: string,
  plan: { nodeIds: readonly string[]; tree: readonly Record<string, unknown>[] },
  goalId: string,
): Record<string, unknown> {
  if (!plan.nodeIds.includes(goalId)) {
    return fail(event, `decision ${decisionId} payload.node_ids must include goal ${goalId}`);
  }
  const node = plan.tree.find((item) => item['id'] === goalId);
  if (node === undefined) {
    return fail(event, `decision ${decisionId} payload.tree must contain goal ${goalId}`);
  }
  return node;
}

function sameValue(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

