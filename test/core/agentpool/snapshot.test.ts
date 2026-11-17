import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reusableCandidates, hasUsableAgent } from '../../../src/core/agentpool/snapshot.js';
import type { PoolSnapshot } from '../../../src/core/agentpool/types.js';

const snapshot: PoolSnapshot = {
  watermark_limit: 0.7,
  idle: [
    { agent_id: 'b-agent', actor_id: 'b', skills: ['implement', 'review'], last_task_files: [], watermark: 0.2 },
    { agent_id: 'a-agent', actor_id: 'a', skills: ['implement'], last_task_files: [], watermark: 0.5 },
    { agent_id: 'c-agent', actor_id: 'c', skills: ['review'], last_task_files: [], watermark: 0.1 },
  ],
};

test('C4: reusableCandidates filters by skill and is stably sorted by agent id', () => {
  assert.deepEqual(
    reusableCandidates(snapshot, ['implement']).map((candidate) => candidate.agent_id),
    ['a-agent', 'b-agent'],
  );
  assert.deepEqual(
    reusableCandidates(snapshot, ['review']).map((candidate) => candidate.agent_id),
    ['b-agent', 'c-agent'],
  );
  assert.equal(hasUsableAgent(snapshot, ['implement', 'review']), true);
  assert.equal(hasUsableAgent(snapshot, ['missing-skill']), false);
});
