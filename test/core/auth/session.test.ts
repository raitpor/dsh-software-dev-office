import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  identityFromSession,
  isActorKind,
  rejectPayloadActor,
  writeIdentity,
  type Session,
} from '../../../src/core/auth/session.js';

const SESSION: Session = {
  actor: 'alice',
  actor_kind: 'human',
  session_id: 'sess-1',
  credential: 'passkey',
};

test('C3：身份从会话取（human/agent/service）', () => {
  assert.deepEqual(identityFromSession(SESSION), { ok: true, actor: 'alice', actor_kind: 'human' });
  const agent = identityFromSession({ ...SESSION, actor_kind: 'agent' });
  assert.equal(agent.ok, true);
  if (agent.ok) assert.equal(agent.actor_kind, 'agent');
  assert.equal(isActorKind('service'), true);
  assert.equal(isActorKind('robot'), false);
});

test('C3：写路径不接受 payload 的 actor（actor_not_from_session）', () => {
  const rejected = rejectPayloadActor({ actor: 'mallory', action: 'claim' });
  assert.deepEqual(rejected, {
    ok: false,
    reason_code: 'actor_not_from_session',
    message: '写路径不接受 payload 的 actor；actor 必须来自会话凭据',
  });
  assert.equal(rejectPayloadActor({ action: 'claim' }), undefined, '没有 actor 键则放行到会话身份');
  assert.equal(rejectPayloadActor(null), undefined);
  assert.equal(rejectPayloadActor('actor'), undefined);

  const write = writeIdentity(SESSION, { actor: 'mallory' });
  assert.equal(write.ok, false);
  if (!write.ok) assert.equal(write.reason_code, 'actor_not_from_session');
});

test('C3：坏会话 fail-closed（缺 actor / 非法 kind / 缺 session_id）', () => {
  for (const broken of [
    { ...SESSION, actor: '' },
    { ...SESSION, actor_kind: 'robot' as never },
    { ...SESSION, session_id: '' },
  ]) {
    const identity = identityFromSession(broken);
    assert.equal(identity.ok, false);
    if (!identity.ok) assert.equal(identity.reason_code, 'invalid_field');
  }
});
