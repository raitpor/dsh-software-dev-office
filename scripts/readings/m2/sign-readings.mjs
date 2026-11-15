/**
 * M2-G · R1/R2/R3/R4/R6：签字路径读数（量签字页服务 + signerd 真路径）。
 */
import { chainHead } from '../../../lib/src/db/write.js';
import { appendAs as append } from '../../../lib/test/db/append-auth.js';
import { computeEventHash } from '../../../lib/src/core/verify-events.js';
import {
  AT, TEST_ACTOR, TEST_PASSPHRASE, createAndConfirm, decisionCount, draft, eventCount,
  reason, seedClaim, withSignPage, count,
} from './helpers.mjs';

function bumpFrontier(db, taskId) {
  const prev = chainHead(db);
  const unsigned = {
    id: `ev-m2g-bump-${taskId}`, at: AT, actor: 'm2g-fixture', kind: 'task.created',
    subject: taskId, payload: { seq: 9, title: 'bump', kind: 'implement' },
    caused_by: [], request_id: `rq-${taskId}`, prev, hash: '',
  };
  const result = append(db, [{ ...unsigned, hash: computeEventHash(unsigned) }]);
  if (!result.ok) throw new Error(`bump failed: ${result.message ?? result.reason_code}`);
  return chainHead(db);
}

export async function measureR1() {
  return withSignPage({}, async ({ db, service }) => {
    const claimId = seedClaim(db, 'TASK-1', 'M2G-1');
    const eventsBefore = eventCount(db);
    const outcome = await createAndConfirm(service, [claimId]);
    return {
      id: 'R1',
      question: '未解锁时签字 ⇒ awaiting_unlock，且 0 条 decision 行（在非空库上）',
      command: "node scripts/m2-readings.mjs --only R1",
      measured: {
        reason_code: reason(outcome),
        decisions: decisionCount(db),
        events_before: eventsBefore,
        events_after: eventCount(db),
        non_empty_db: eventsBefore > 0,
      },
      verdict: reason(outcome) === 'awaiting_unlock' && decisionCount(db) === 0 && eventsBefore > 0 ? 'pass' : 'fail',
      caveat: '数据来源：SigningPageService.confirm → signDecision → SignerdClient.sign 真路径；事件数来自 event 表，decision 行数来自 decision 表（库先由 task.created 垫成非空，排除空库恒真）。',
    };
  });
}

export async function measureR2() {
  return withSignPage({ ttl: '5' }, async ({ db, service, rig }) => {
    seedClaim(db, 'TASK-1', 'M2G-2a');
    seedClaim(db, 'TASK-2', 'M2G-2b');
    await service.unlock({ actor: TEST_ACTOR, passphrase: TEST_PASSPHRASE });
    const first = await createAndConfirm(service, ['claim:M2G-2a']);
    const decisionsAfterFirst = decisionCount(db);
    bumpFrontier(db, 'TASK-9');
    const second = await createAndConfirm(service, ['claim:M2G-2b']);
    const status = await rig.client.status();
    return {
      id: 'R2',
      question: '免密窗口内 frontier 改变后再签 ⇒ 要求重新解锁（frontier_stale/awaiting_unlock），decision 行数不变',
      command: "node scripts/m2-readings.mjs --only R2",
      measured: {
        first_sign: reason(first),
        decisions_after_first: decisionsAfterFirst,
        second_sign: reason(second),
        decisions_after_second: decisionCount(db),
        window_locked_after: status.ok ? status.locked : null,
        frontier_changed: true,
      },
      verdict:
        reason(first) === 'ok' &&
        ['frontier_stale', 'awaiting_unlock'].includes(reason(second)) &&
        decisionCount(db) === decisionsAfterFirst
          ? 'pass'
          : 'fail',
      caveat: '数据来源：签字页 confirm 第二段 → signerd（窗口 frontier 失配）；decisions 由 decision 表计数，不静默续窗。',
    };
  });
}

export async function measureR3() {
  return withSignPage({}, async ({ db, service }) => {
    seedClaim(db, 'TASK-1', 'M2G-3');
    const caseA = await createAndConfirm(service, ['claim:M2G-3'], { forgedProposition: '' });
    const caseB = await createAndConfirm(service, ['claim:M2G-3'], { forgedProposition: '模型自己写的摘要：一切正常' });
    return {
      id: 'R3',
      question: 'decision 缺 proposition / proposition 与 renderer 不一致 ⇒ no_blind_sign，0 行',
      command: "node scripts/m2-readings.mjs --only R3",
      measured: {
        missing_or_empty_proposition: reason(caseA),
        forged_proposition: reason(caseB),
        decisions: decisionCount(db),
      },
      verdict:
        reason(caseA) === 'no_blind_sign' && reason(caseB) === 'no_blind_sign' && decisionCount(db) === 0
          ? 'pass'
          : 'fail',
      caveat: '数据来源：签字页 confirm 的命题复算闸门（服务端）；空命题与伪命题两例。',
    };
  });
}

export async function measureR4() {
  return withSignPage({}, async ({ db, service }) => {
    seedClaim(db, 'TASK-1', 'M2G-4');
    await service.unlock({ actor: TEST_ACTOR, passphrase: TEST_PASSPHRASE });
    const outcome = await createAndConfirm(service, ['claim:M2G-4'], { actorKind: 'agent' });
    const alerts = count(db, "SELECT count(*) AS n FROM event WHERE kind = 'security.alert'");
    return {
      id: 'R4',
      question: 'agent 凭据签字 ⇒ not_a_signer、0 decision 行，且 security.alert 真落库',
      command: "node scripts/m2-readings.mjs --only R4",
      measured: {
        reason_code: reason(outcome),
        decisions: decisionCount(db),
        security_alert_events: alerts,
      },
      verdict: reason(outcome) === 'not_a_signer' && decisionCount(db) === 0 && alerts >= 1 ? 'pass' : 'fail',
      caveat: '数据来源：签字页 confirm 传入 actorKind=agent → signDecision 拒并落 security.alert；告警数查 event 表，不拿返回码充数。',
    };
  });
}

export async function measureR6() {
  const defaultRun = await withSignPage({}, async ({ db, service }) => {
    seedClaim(db, 'TASK-1', 'M2G-6a');
    seedClaim(db, 'TASK-2', 'M2G-6b');
    await service.unlock({ actor: TEST_ACTOR, passphrase: TEST_PASSPHRASE });
    const first = await createAndConfirm(service, ['claim:M2G-6a']);
    const second = await createAndConfirm(service, ['claim:M2G-6b']);
    return {
      first: reason(first), second: reason(second), decisions: decisionCount(db),
    };
  });
  const windowRun = await withSignPage({ ttl: '5' }, async ({ db, service }) => {
    seedClaim(db, 'TASK-1', 'M2G-6c');
    seedClaim(db, 'TASK-2', 'M2G-6d');
    await service.unlock({ actor: TEST_ACTOR, passphrase: TEST_PASSPHRASE });
    const createdA = await service.createRequest(draft(['claim:M2G-6c']));
    const createdB = await service.createRequest(draft(['claim:M2G-6d']));
    if (!createdA.ok || !createdB.ok) throw new Error('R6 window: createRequest failed');
    const confirmedA = await service.confirm({ requestId: createdA.item.id, actor: TEST_ACTOR, proposition: createdA.item.proposition, payloadHash: createdA.item.payload_hash });
    const confirmedB = await service.confirm({ requestId: createdB.item.id, actor: TEST_ACTOR, proposition: createdB.item.proposition, payloadHash: createdB.item.payload_hash });
    const submitted = await service.submit();
    return {
      first: reason(confirmedA), second: reason(confirmedB), submit: reason(submitted),
      decisions: decisionCount(db),
      unlock_wait_second: service.costs()[1]?.signerd_unlock_wait_ms ?? null,
    };
  });
  const ok =
    defaultRun.first === 'ok' && defaultRun.decisions === 1 &&
    ['ttl_requires_window', 'awaiting_unlock'].includes(defaultRun.second) &&
    windowRun.submit === 'ok' && windowRun.decisions === 2 && windowRun.unlock_wait_second === 0;
  return {
    id: 'R6',
    question: '免密窗口默认关闭（TTL=0 第二次签需重新授权）；显式 TTL>0 才允许一次解锁连签',
    command: "node scripts/m2-readings.mjs --only R6",
    measured: { default_ttl0: defaultRun, window_ttl5: windowRun },
    verdict: ok ? 'pass' : 'fail',
    caveat: '数据来源：签字页 TTL=0/TTL=5 两条真路径；窗口连签用同一会话两待签项 + 一次 unlock，第二条第 signerd_unlock_wait_ms=0。',
  };
}
