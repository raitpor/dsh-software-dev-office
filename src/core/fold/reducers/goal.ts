import {
  createOnce,
  fail,
  optString,
  optStringArray,
  patchRow,
  payloadOf,
  reqEnum,
  reqString,
  rowOf,
  subjectId,
} from '../guards.js';
import { requireSignedDecision } from '../decisions.js';
import type { Event, FoldWorking, Row } from '../types.js';
import { planNodeMismatch, planPayload, requirePlanNode } from './plan-tree.js';


const GOAL_KINDS = ['intent', 'part'] as const;
const INTEGRATION_STATES = ['connected', 'pending', 'dropped'] as const;

/** goal.declared：根唯一 + 根必指 intent + decision 必须有效（design/02 不变量）。 */
export function goalDeclared(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const kind = reqEnum(event, payload, 'kind', GOAL_KINDS);
  const decisionId = reqString(event, payload, 'decision_id');
  const decision = requireSignedDecision(state, event, decisionId, 'plan');
  const parentId = optString(event, payload, 'parent_id') ?? null;
  const intentId = optString(event, payload, 'intent_id') ?? null;
  if (kind === 'intent' && parentId !== null) {
    return fail(event, 'goal.declared kind=intent must not carry payload.parent_id');
  }
  if (kind === 'intent' && intentId === null) {
    return fail(event, 'goal.declared kind=intent requires payload.intent_id');
  }
  if (kind === 'part' && parentId === null) {
    return fail(event, 'goal.declared kind=part requires payload.parent_id');
  }
  if (rowOf(state, 'intent', intentId ?? '') === undefined && kind === 'intent') {
    return fail(event, `intent ${intentId} does not exist`);
  }
  if (kind === 'intent') {
    for (const [otherId, row] of Object.entries(state.tables.goal_node)) {
      if (row['kind'] === 'intent' && row['intent_id'] === intentId && otherId !== id) {
        return fail(event, `intent ${intentId} already has root goal ${otherId}`);
      }
    }
  }
  if (parentId !== null) {
    const parent = rowOf(state, 'goal_node', parentId);
    if (parent === undefined) {
      return fail(event, `parent goal ${parentId} does not exist`);
    }
    if (parent['kind'] !== 'intent' && parent['kind'] !== 'part') {
      return fail(event, `parent goal ${parentId} has unknown kind`);
    }
  }
  const planNode = requirePlanNode(event, decisionId, planPayload(event, decisionId, decision), id);
  const acceptance = optString(event, payload, 'acceptance_criterion_id') ?? null;
  if (planNodeMismatch(planNode, parentId, kind, acceptance)) {
    return fail(event, `goal ${id} does not match the signed plan node (parent_id/kind/acceptance_criterion_id)`);
  }
  if (planNode['goal'] !== reqString(event, payload, 'goal')) {
    return fail(event, `goal ${id} does not match the signed plan node (goal)`);
  }
  createOnce(state, event, 'goal_node', id, {
    id,
    parent_id: parentId,
    intent_id: intentId,
    decision_id: decisionId,
    goal: reqString(event, payload, 'goal'),
    kind,
    acceptance_criterion_id: optString(event, payload, 'acceptance_criterion_id') ?? null,
    scope_paths: optStringArray(event, payload, 'scope_paths') ?? [],
    at: event.at,
  });
}

/** 沿 parent 链上溯，防止把节点挂成自己或后代的子节点。 */
function isDescendant(state: FoldWorking, ancestorId: string, candidateId: string): boolean {
  let cursor: string | null = candidateId;
  const guard = new Set<string>();
  while (cursor !== null) {
    if (cursor === ancestorId) {
      return true;
    }
    if (guard.has(cursor)) {
      return false;
    }
    guard.add(cursor);
    const row: Row | undefined = state.tables.goal_node[cursor];
    cursor = row === undefined ? null : (row['parent_id'] as string | null);
  }
  return false;
}

export function goalReparented(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const row: Row | undefined = rowOf(state, 'goal_node', id);
  if (row === undefined) {
    return fail(event, `goal ${id} does not exist`);
  }
  const decisionId = reqString(event, payload, 'decision_id');
  const decision = requireSignedDecision(state, event, decisionId, 'plan');
  const parentId = optString(event, payload, 'parent_id') ?? null;
  if (row['kind'] === 'part' && parentId === null) {
    return fail(event, `part goal ${id} must keep a parent on reparent`);
  }
  const planNode = requirePlanNode(event, decisionId, planPayload(event, decisionId, decision), id);
  const acceptance = optString(event, payload, 'acceptance_criterion_id') ?? (row['acceptance_criterion_id'] as string | null);
  if (planNodeMismatch(planNode, parentId, row['kind'], acceptance)) {
    return fail(event, `goal ${id} does not match the signed plan node (parent_id/kind/acceptance_criterion_id)`);
  }
  if (parentId !== null) {
    if (rowOf(state, 'goal_node', parentId) === undefined) {
      return fail(event, `parent goal ${parentId} does not exist`);
    }
    if (isDescendant(state, id, parentId)) {
      return fail(event, `cycle: goal ${parentId} is a descendant of ${id}`);
    }
    if (row['kind'] === 'intent') {
      return fail(event, `root goal ${id} must not have a parent`);
    }
  }
  patchRow(state, 'goal_node', id, event, { parent_id: parentId, decision_id: decisionId, reparented_at: event.at });
}

export function goalIntegrated(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const parentGoalId = reqString(event, payload, 'parent_goal_id');
  const childGoalId = reqString(event, payload, 'child_goal_id');
  if (rowOf(state, 'goal_node', parentGoalId) === undefined) {
    return fail(event, `parent goal ${parentGoalId} does not exist`);
  }
  if (rowOf(state, 'goal_node', childGoalId) === undefined) {
    return fail(event, `child goal ${childGoalId} does not exist`);
  }
  createOnce(state, event, 'integration', id, {
    id,
    parent_goal_id: parentGoalId,
    child_goal_id: childGoalId,
    state: reqEnum(event, payload, 'state', INTEGRATION_STATES),
    evidence_id: optString(event, payload, 'evidence_id') ?? null,
    note: optString(event, payload, 'note') ?? null,
    at: event.at,
  });
}

export const GOAL_REDUCERS = {
  'goal.declared': goalDeclared,
  'goal.reparented': goalReparented,
  'goal.integrated': goalIntegrated,
} as const;
