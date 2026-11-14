/** M2-1 第一段：preview 计算 + 服务端 registry 登记（confirm 只认 preview_id）。 */
import type { SdoDatabase } from './driver.js';
import { chainHead } from './write.js';
import { previewBaseline } from '../core/baseline/freeze.js';
import { registerPreview, type FreezePreviewView } from './freeze-preview.js';
import { baselineById, currentBaseline, failure, rejectEvent } from './freeze-store.js';
import type { FreezeDbResult, FreezeSession } from './freeze-types.js';

export function previewFreeze(
  db: SdoDatabase,
  input: unknown,
  session: FreezeSession,
  options: { readonly now?: Date } = {},
): FreezePreviewView | FreezeDbResult {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const id = typeof (input as Record<string, unknown> | null)?.['id'] === 'string'
    ? String((input as Record<string, unknown>)['id'])
    : '';
  if (id.length === 0) {
    return failure('invalid_baseline', 'baseline 缺少非空 id');
  }
  const current = currentBaseline(db);
  const preview = previewBaseline(input, { current, id, frozen_by: session.actor, frontier: chainHead(db) });
  if (!preview.ok) {
    // P2-1：只有结构/P15 校验失败才落 `baseline.rejected`。
    // `baseline_unchanged` 是“同内容重复冻结”的幂等拒绝，不算一次被拒的冻结尝试。
    if (preview.reason_code === 'baseline_unchanged') return preview;
    const rejected_event_id = rejectEvent(db, session, input, preview, at);
    return { ...preview, rejected_event_id };
  }
  const existing = baselineById(db, preview.id);
  if (existing !== null && existing.hash !== preview.hash) {
    return failure('payload_changed', `baseline id ${preview.id} 已被另一版占用`);
  }
  return registerPreview(
    { raw: input, id: preview.id, frozen_by: session.actor, frontier: preview.frontier, preview },
    now.getTime(),
  );
}
