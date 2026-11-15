/**
 * baseline 冻结事务（M2-1）：preview → confirm → 人签 → 新行（`docs/05` `baseline_freeze`）。
 *
 * 两段式是服务端两段（P1-1）：`previewFreeze` 把 preview 放进进程内 registry，只返回
 * `preview_id`；`confirmFreeze` 只认 `preview_id`，并在签名前**重跑 P15、重算全部字段**。
 * 不过 P15 ⇒ 落 `baseline.rejected`（ACK，不投影）；过了且签成功 ⇒ 紧邻 append 冻结事件。
 */
import type { SdoDatabase } from './driver.js';
import { appendAsTool, chainHead } from './write.js';
import { failure } from './freeze-store.js';
import { signDecision, type DecisionRequest } from '../sign/decision.js';
import type { SignerdClient } from '../sign/client.js';
import {
  baselineEventPayload,
  confirmBaseline,
  freezeEventKind,
  previewBaseline,
  type BaselinePreview,
} from '../core/baseline/freeze.js';
import { validateBaseline } from '../core/baseline/index.js';
import { canonicalJson } from '../core/fold/canonical.js';
import { willChangeLines } from './freeze-lines.js';
import { consumePreview, lookupPreview, peekPreview } from './freeze-preview.js';
import {
  baselineById,
  buildEvent,
  currentBaseline,
  rejectEvent,
  rows,
  toRow,
} from './freeze-store.js';
import type { FreezeDbResult, FreezeSession } from './freeze-types.js';

export type { FreezeDbResult, FreezeSession } from './freeze-types.js';
export type { FreezePreviewView } from './freeze-preview.js';
export { previewFreeze } from './freeze-start.js';

/** P2-2：可疑篡改/重放落审计事件（`security.alert` 是 ACK kind，不投影业务表）。 */
function securityAlert(
  db: SdoDatabase,
  session: FreezeSession,
  at: string,
  payload: Record<string, unknown>,
): void {
  const kind = String(payload['kind']);
  const id = `ev-security-${kind}-${at}-${Math.random().toString(16).slice(2, 10)}`;
  appendAsTool(db, [
    buildEvent(
      {
        id,
        at,
        actor: session.actor,
        kind: 'security.alert',
        subject: kind,
        payload,
        caused_by: [],
        request_id: id,
      },
      chainHead(db),
    ),
  ], session.actor, session.actor_kind);
}

export interface FreezeConfirmRequest {
  /** 只认 preview 阶段服务端发的 id；不接受调用方自带 preview 对象（P1-1）。 */
  readonly preview_id: string;
  readonly payload_hash: string;
  readonly declared_direction?: string;
}

export async function confirmFreeze(
  db: SdoDatabase,
  client: SignerdClient,
  confirm: FreezeConfirmRequest,
  session: FreezeSession,
  options: { readonly now?: Date } = {},
): Promise<FreezeDbResult> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const found = lookupPreview(confirm.preview_id, now.getTime());
  if (found === 'expired') return failure('preview_expired', 'preview 不存在或已过期；请重新 preview');
  if (found === 'consumed') {
    const record = peekPreview(confirm.preview_id, now.getTime());
    if (record !== undefined) {
      const frozen = rows(db, 'SELECT * FROM baseline WHERE hash = ?', record.preview.hash);
      if (frozen.length > 0) {
        return { ok: true, baseline: toRow(frozen[0]!), message: 'baseline unchanged (already frozen)' };
      }
    }
    securityAlert(db, session, at, { kind: 'preview_replay', preview_id: confirm.preview_id, at });
    return failure('preview_consumed', 'preview 已被使用；请重新 preview');
  }

  // P1-1：confirm 时服务端重跑 P15，不信任 preview 期的结论。
  const p15 = validateBaseline(found.raw);
  if (!p15.ok) {
    consumePreview(confirm.preview_id);
    const first = p15.reason_codes[0] ?? 'invalid_baseline';
    const rejected_event_id = rejectEvent(
      db,
      session,
      found.raw,
      { reason_code: first, message: `P15 校验未通过：${p15.reason_codes.join(', ')}`, reason_codes: p15.reason_codes },
      at,
    );
    return failure(first, `P15 校验未通过：${p15.reason_codes.join(', ')}`, {
      reason_codes: p15.reason_codes,
      rejected_event_id,
    });
  }

  const current = currentBaseline(db);
  if ((current?.id ?? null) !== found.preview.prev) {
    return failure('preview_expired', '链头已变化；请重新 preview');
  }
  const recomputed = previewBaseline(found.raw, {
    current,
    id: found.id,
    frozen_by: session.actor,
    frontier: found.frontier,
  });
  if (!recomputed.ok) {
    consumePreview(confirm.preview_id);
    securityAlert(db, session, at, {
      kind: 'preview_mismatch',
      preview_id: confirm.preview_id,
      expected_hash: found.preview.hash,
      actual_hash: null,
      at,
    });
    return failure('preview_mismatch', `confirm 重算失败：${recomputed.reason_code}`);
  }
  if (
    recomputed.hash !== found.preview.hash ||
    recomputed.payload_hash !== found.preview.payload_hash ||
    canonicalJson(recomputed.decision_baseline) !== canonicalJson(found.preview.decision_baseline)
  ) {
    consumePreview(confirm.preview_id);
    securityAlert(db, session, at, {
      kind: 'preview_mismatch',
      preview_id: confirm.preview_id,
      expected_hash: found.preview.hash,
      actual_hash: recomputed.hash,
      at,
    });
    return failure('preview_mismatch', 'confirm 重算结果与 preview 不一致');
  }

  const checked = confirmBaseline(recomputed, confirm.payload_hash, confirm.declared_direction);
  if (!checked.ok) return failure(checked.reason_code, checked.message);

  const existing = rows(db, 'SELECT * FROM baseline WHERE hash = ?', recomputed.hash);
  if (existing.length > 0) {
    consumePreview(confirm.preview_id);
    return { ok: true, baseline: toRow(existing[0]!), message: 'baseline unchanged (already frozen)' };
  }
  if (chainHead(db) !== found.frontier) {
    return failure('payload_changed', 'preview 已过期：链头在 preview 后变化');
  }

  const eventId = `ev-baseline-${recomputed.id}-${at}`;
  if (rows(db, 'SELECT 1 AS n FROM event WHERE id = ?', eventId).length > 0) {
    return failure('baseline_append_failed', `事件 id ${eventId} 已被占用；请重新 preview`);
  }
  consumePreview(confirm.preview_id);

  const preview: BaselinePreview = recomputed;
  const delta = preview.guarantee_delta;
  const request: DecisionRequest & { now?: Date } = {
    decision_kind: 'baseline',
    subject: `baseline:${preview.id}`,
    value: preview.direction,
    evidence: [preview.hash, preview.will_change_hash],
    difference: `will_change ${preview.will_change_hash}`,
    consequence: `保证 1=${delta[1]} / 2=${delta[2]} / 3=${delta[3]}`,
    extra: {
      baseline: preview.decision_baseline,
      will_change: willChangeLines(preview.will_change),
      guarantee_delta: { 1: delta[1], 2: delta[2], 3: delta[3] },
    },
    actor: session.actor,
    actor_kind: session.actor_kind,
    producer: session.producer,
    channel: session.channel,
    frontier: preview.frontier,
    now,
  };
  const signed = await signDecision(db, client, request);
  if (!signed.ok) {
    return failure(signed.reason_code ?? 'sign_failed', signed.message ?? 'signerd 拒绝签发');
  }
  // 签名后、写 baseline 前：preview 链头之后只允许多出本次 decision.valid + decision.signed 两条。
  const since = rows(
    db,
    'SELECT kind, subject FROM event WHERE rowid > COALESCE((SELECT rowid FROM event WHERE hash = ?), 0) ORDER BY rowid',
    preview.frontier,
  );
  const expectedKinds = ['decision.valid', 'decision.signed'];
  const clean = since.length === expectedKinds.length &&
    since.every((row, index) => row['kind'] === expectedKinds[index] && row['subject'] === signed.decision_id);
  if (!clean) {
    return failure('frontier_stale', '签名期间链被其他写入推进；baseline 行未落，已签 decision 留作审计', {
      decision_id: signed.decision_id,
    });
  }

  const result = appendAsTool(db, [
    buildEvent(
      {
        id: eventId,
        at,
        actor: session.actor,
        kind: freezeEventKind(preview.direction),
        subject: preview.id,
        payload: baselineEventPayload(preview, preview.raw as Record<string, unknown>, signed.decision_id, session.actor),
        caused_by: [],
        request_id: `baseline:${preview.id}:${at}`,
      },
      chainHead(db),
    ),
  ], session.actor, session.actor_kind);
  if (!result.ok) {
    return failure(
      'baseline_append_failed',
      `decision ${signed.decision_id} 已签但 baseline 行未落：${result.message ?? 'append rejected'}；需重新 preview，已签 decision 留作审计`,
      { decision_id: signed.decision_id },
    );
  }
  return {
    ok: true,
    baseline: baselineById(db, preview.id) ?? undefined,
    decision_id: signed.decision_id,
    event_id: eventId,
  };
}
