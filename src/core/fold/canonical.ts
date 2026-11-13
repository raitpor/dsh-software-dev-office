import { createHash } from 'node:crypto';
import type { Row } from './types.js';

/**
 * 规范化序列化（docs/03:77“与 fold 输出同一套规范化序列化”）。
 * 对象键排序、数组保序；同一份数据在任何进程里得到同一字符串。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = normalize(source[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 行内容哈希：inputs 边的 hash 与失效检测共用这一把尺子。 */
export function rowHash(row: Row): string {
  return sha256Hex(canonicalJson(row));
}
