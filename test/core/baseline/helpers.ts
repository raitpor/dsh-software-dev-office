import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { P15Result } from '../../../src/core/baseline/index.js';
import { validateBaseline } from '../../../src/core/baseline/index.js';

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/baseline', `${name}.json`), 'utf8'));
}

export function validateFixture(name: string): P15Result {
  return validateBaseline(loadFixture(name));
}

/** 精确码集合比较用：`reason_codes` 的顺序不属于契约，集合才是。 */
export function sortedCodes(result: P15Result): string[] {
  return [...result.reason_codes].sort();
}

export const STRUCTURAL_DELTA = { 1: 'degraded', 2: 'degraded', 3: 'degraded' } as const;

/** 深拷贝夹具再做局部篡改（内联结构错用例）。 */
export function mutatedFixture(name: string, mutate: (doc: Record<string, unknown>) => void): unknown {
  const doc = structuredClone(loadFixture(name)) as Record<string, unknown>;
  mutate(doc);
  return doc;
}
