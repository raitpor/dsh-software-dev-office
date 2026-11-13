import { fail, upsert } from '../guards.js';
import type { Event, FoldWorking } from '../types.js';

const RELEASE_ITEM_KINDS = ['requirement', 'spec', 'defect', 'risk', 'deprecation'] as const;

/** docs/09:79：冻结载荷的 in/out 逐项落 release_item；出局必须写原因。 */
export function materializeReleaseItems(
  state: FoldWorking,
  event: Event,
  releaseId: string,
  payload: Record<string, unknown>,
): void {
  const raw = payload['items'];
  if (!Array.isArray(raw)) {
    return fail(event, 'release.frozen requires payload.items[] (in/out scope)');
  }
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return fail(event, 'release.frozen payload.items entries must be objects');
    }
    const entry = item as Record<string, unknown>;
    const kind = entry['kind'];
    if (typeof kind !== 'string' || !(RELEASE_ITEM_KINDS as readonly string[]).includes(kind)) {
      return fail(event, 'release item kind must be requirement/spec/defect/risk/deprecation');
    }
    const target = entry['target'];
    if (typeof target !== 'string' || target.length === 0) {
      return fail(event, 'release item target must be a non-empty string');
    }
    const requirementId = entry['requirement_id'];
    if (kind !== 'requirement' && typeof requirementId !== 'string') {
      return fail(event, 'release item: non-requirement rows need requirement_id (DDL CHECK)');
    }
    const disposition = entry['disposition'];
    if (disposition !== 'in' && disposition !== 'out') {
      return fail(event, 'release item disposition must be in/out');
    }
    const reason = entry['reason'];
    if (disposition === 'out' && (typeof reason !== 'string' || reason.length === 0)) {
      return fail(event, 'release item out requires reason');
    }
    const deferCount = entry['defer_count'] ?? 0;
    if (typeof deferCount !== 'number' || !Number.isInteger(deferCount) || deferCount < 0) {
      return fail(event, 'release item defer_count must be a non-negative integer');
    }
    const approvedBy = entry['approved_by'];
    if (approvedBy !== undefined && typeof approvedBy !== 'string') {
      return fail(event, 'release item approved_by must be a string');
    }
    upsert(state, 'release_item', `${releaseId}/${kind}/${target}`, {
      release_id: releaseId,
      kind,
      target,
      requirement_id: typeof requirementId === 'string' ? requirementId : null,
      disposition,
      reason: typeof reason === 'string' ? reason : null,
      defer_count: deferCount,
      approved_by: typeof approvedBy === 'string' ? approvedBy : null,
    });
  }
}
