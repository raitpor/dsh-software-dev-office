/**
 * M1-3 唯一入口：`validateBaseline(input: unknown): P15Result`。
 * 纯函数：不读写文件、不读 env/时钟、不碰 DB（`docs/09` §16.2）。
 */

import { validateBaselineFile } from './validate.js';
import type { P15Result } from './types.js';

/** 结构错（非对象输入）与 `validate.ts` 的 structuralFailure 同口径：fail-closed。 */
const EMPTY: P15Result = {
  ok: false,
  guarantee_delta: { 1: 'degraded', 2: 'degraded', 3: 'degraded' },
  reason_codes: ['invalid_baseline'],
};

export function validateBaseline(input: unknown): P15Result {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return EMPTY;
  return validateBaselineFile(input as Record<string, unknown>);
}

export * from './types.js';
export { PRESETS, type Preset } from './presets.js';
export { checkGraph, type GraphCheck } from './graph.js';
