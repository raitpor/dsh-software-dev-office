/**
 * M2-1 服务端两段式 registry（P1-1）：preview 只在进程内暂存，confirm 只认 preview_id。
 *
 * 不导出 registry 本身；条目不可枚举。进程重启/换进程 ⇒ 旧 preview 视作过期
 * （`preview_expired`）——冻结动作本来就在同一进程内完成，跨进程续用不在承诺内。
 */
import { randomUUID } from 'node:crypto';

import type { BaselinePreview } from '../core/baseline/freeze.js';

export interface FreezePreviewView {
  readonly ok: true;
  readonly preview_id: string;
  readonly id: string;
  readonly hash: string;
  readonly direction: BaselinePreview['direction'];
  readonly row_direction: BaselinePreview['row_direction'];
  readonly prev: string | null;
  readonly will_change: BaselinePreview['will_change'];
  readonly will_change_hash: string;
  readonly guarantee_delta: BaselinePreview['guarantee_delta'];
  readonly missing: BaselinePreview['missing'];
  readonly payload_hash: string;
  readonly frontier: string;
}

export interface PreviewRecord {
  readonly preview_id: string;
  readonly raw: unknown;
  readonly id: string;
  readonly frozen_by: string;
  readonly frontier: string;
  readonly preview: BaselinePreview;
  readonly created_at: number;
  consumed: boolean;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 64;
const REGISTRY = new Map<string, PreviewRecord>();

function purge(now: number): void {
  for (const [key, record] of REGISTRY) {
    if (now - record.created_at > TTL_MS) REGISTRY.delete(key);
  }
  while (REGISTRY.size >= MAX_ENTRIES) {
    const oldest = REGISTRY.keys().next();
    if (oldest.done === true) break;
    REGISTRY.delete(oldest.value);
  }
}

export function registerPreview(record: Omit<PreviewRecord, 'preview_id' | 'consumed' | 'created_at'>, now: number): FreezePreviewView {
  purge(now);
  const preview_id = `pv-${randomUUID()}`;
  REGISTRY.set(preview_id, { ...record, preview_id, consumed: false, created_at: now });
  const preview = record.preview;
  return {
    ok: true,
    preview_id,
    id: preview.id,
    hash: preview.hash,
    direction: preview.direction,
    row_direction: preview.row_direction,
    prev: preview.prev,
    will_change: preview.will_change,
    will_change_hash: preview.will_change_hash,
    guarantee_delta: preview.guarantee_delta,
    missing: preview.missing,
    payload_hash: preview.payload_hash,
    frontier: preview.frontier,
  };
}

export function lookupPreview(previewId: string, now: number): PreviewRecord | 'expired' | 'consumed' {
  const record = REGISTRY.get(previewId);
  if (record === undefined) return 'expired';
  if (now - record.created_at > TTL_MS) {
    REGISTRY.delete(previewId);
    return 'expired';
  }
  if (record.consumed) return 'consumed';
  return record;
}

export function peekPreview(previewId: string, now: number): PreviewRecord | undefined {
  const record = REGISTRY.get(previewId);
  if (record === undefined) return undefined;
  if (now - record.created_at > TTL_MS) return undefined;
  return record;
}

export function consumePreview(previewId: string): void {
  const record = REGISTRY.get(previewId);
  if (record !== undefined) record.consumed = true;
}

/** 仅供测试：绕过 preview 直接注入一条 registry 记录（用于验证 confirm 会重跑 P15 等）。 */
export function __seedPreviewForTest(record: Omit<PreviewRecord, 'preview_id' | 'consumed' | 'created_at'>, now: number): string {
  const view = registerPreview(record, now);
  return view.preview_id;
}

export function __clearPreviewsForTest(): void {
  REGISTRY.clear();
}
