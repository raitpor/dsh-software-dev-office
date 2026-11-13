import assert from 'node:assert/strict';
import { fold, FoldError, type Event, type FoldState } from '../../src/core/fold/index.js';
import { eventFactory } from './helpers.js';

/** 顺序堆事件再一次性 fold 的测试夹具。 */
/** 判据注册的默认夹具（只用于与注册门槛无关的规则测试；门槛本身另有专项用例）。 */
export const DEFAULT_FIXTURES = [
  { polarity: 'positive', input: 'default-pos', expected_status: 'pass' },
  { polarity: 'negative', input: 'default-neg', expected_status: 'fail' },
] as const;

export class TestFolder {
  private readonly factory = eventFactory('rules');
  private readonly events: Event[] = [];
  push(
    kind: string,
    subject: string,
    payload: unknown,
    overrides?: Parameters<ReturnType<typeof eventFactory>['ev']>[3],
    options?: { readonly raw?: boolean },
  ): string {
    let shaped = payload;
    if (options?.raw !== true && payload !== null && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      if (kind === 'criterion.registered' && record['fixtures'] === undefined && record['legacy'] !== true) {
        shaped = { fixtures: DEFAULT_FIXTURES, ...record };
      }
      if (kind === 'release.frozen' && record['frozen_by'] === undefined) {
        shaped = { frozen_by: ['alice', 'bob'], ...record };
      }
    }
    const event = this.factory.ev(kind, subject, shaped, overrides);
    this.events.push(event);
    return event.id;
  }
  fold(): FoldState {
    return fold(undefined, this.events);
  }
}

export function expectFoldFail(run: () => FoldState, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof FoldError, `expected FoldError, got ${String(error)}`);
    assert.match(error.message, pattern);
    assert.match(error.message, /fold failed at event e-rules-\d+ \(kind [\w.]+\)/);
    return true;
  });
}

/** 签字意图：intent 行只由 intent.signed 产生，必须带有效 decision(kind='intent') 与 content_hash。 */
export function signedIntent(
  folder: TestFolder,
  id = 'INT-1',
  decisionId = 'd-intent',
  overrides: Record<string, unknown> = {},
): void {
  validDecision(folder, decisionId, 'intent');
  folder.push('intent.signed', id, {
    decision_id: decisionId,
    statement: 's',
    owner: 'alice',
    strength: 'explicit',
    content_hash: `ch:${id}`,
    ...overrides,
  });
}

export function validDecision(
  folder: TestFolder,
  id = 'd-1',
  kind = 'intent',
  payload?: unknown,
): void {
  folder.push('decision.valid', id, {
    decision_kind: kind,
    payload_hash: `ph-${id}`,
    ...(payload === undefined ? {} : { payload }),
  });
  folder.push('decision.signed', id, {
    payload_hash: `ph-${id}`,
    signature: `sig-${id}`,
    key_id: 'key-1',
    signer: 'alice',
  });
}
