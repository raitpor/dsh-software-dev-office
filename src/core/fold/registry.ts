import type { Event, FoldWorking } from './types.js';
import { ACK_KINDS } from './ack.js';
import { INTENT_REDUCERS } from './reducers/intent.js';
import { SPEC_REDUCERS } from './reducers/spec.js';
import { ASSUMPTION_REDUCERS } from './reducers/assumption.js';
import { GOAL_REDUCERS } from './reducers/goal.js';
import { TASK_REDUCERS } from './reducers/task.js';
import { TASK_DEP_REDUCERS } from './reducers/task-deps.js';
import { FLOW_REDUCERS } from './reducers/flow.js';
import { VERIFY_REDUCERS } from './reducers/verify.js';
import { REVIEW_REDUCERS } from './reducers/review.js';
import { DECISION_REDUCERS } from './reducers/decision.js';
import { RELEASE_REDUCERS } from './reducers/release.js';
import { BASELINE_REDUCERS } from './reducers/baseline.js';
import { OPS_REDUCERS } from './reducers/ops.js';
import { CONTENT_REDUCERS } from './reducers/content.js';

export type Reducer = (state: FoldWorking, event: Event) => void;

const maps: ReadonlyArray<Readonly<Record<string, Reducer>>> = [
  INTENT_REDUCERS,
  SPEC_REDUCERS,
  ASSUMPTION_REDUCERS,
  GOAL_REDUCERS,
  TASK_REDUCERS,
  TASK_DEP_REDUCERS,
  FLOW_REDUCERS,
  VERIFY_REDUCERS,
  REVIEW_REDUCERS,
  DECISION_REDUCERS,
  RELEASE_REDUCERS,
  BASELINE_REDUCERS,
  OPS_REDUCERS,
  CONTENT_REDUCERS,
];

function buildLookup(): Readonly<Record<string, Reducer>> {
  const lookup: Record<string, Reducer> = {};
  for (const map of maps) {
    for (const [kind, reducer] of Object.entries(map)) {
      if (lookup[kind] !== undefined) {
        throw new Error(`duplicate fold reducer for event kind ${kind}`);
      }
      if (ACK_KINDS[kind] !== undefined) {
        throw new Error(`event kind ${kind} is both reduced and acked`);
      }
      lookup[kind] = reducer;
    }
  }
  return lookup;
}

export const REDUCERS: Readonly<Record<string, Reducer>> = buildLookup();
