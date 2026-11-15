/**
 * M3-2 · 字段值 hash（P2-1：CAS 的粒度是 `(对象 id, 字段名)`，不是整行）。
 */
import { canonicalJson, sha256Hex } from '../fold/canonical.js';

export function valueHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value ?? null))}`;
}
