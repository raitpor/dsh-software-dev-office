/**
 * M2-4 C1/C2/C7 · 评审抽样的纯函数（尺子的一部分，不是开关）。
 *
 * 规则（`docs/04` §4 `review.required` 行）：按**单调卡序号**取模
 * `(seq - sample_seed) mod sample_every == 0`；`sample_every ∈ [2, 10]`；
 * 评审卡（`kind='review'`）不参与——否则“评审卡也要被评审”递归。
 *
 * 本模块不校验 baseline（那是 M1-3 P15 的活，`review_params_invalid`），
 * 只消费已经冻结的 `policy.review`；参数不合法时 fail-closed（不抽中）。
 * 抽样**不产判定行**：它在 `review.required` 判据里被现算（卡「判定」段）。
 */

import { TASK_KINDS } from '../fold/reducers/task.js';

/** baseline 的 `policy.review`。 */
export interface ReviewPolicy {
  readonly sample_every: number;
  readonly sample_seed: number;
}

export const SAMPLE_EVERY_MIN = 2;
export const SAMPLE_EVERY_MAX = 10;

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 从 baseline 的 `policy` 读 `review`。
 *
 * 越界/非整数 ⇒ `undefined`：冻结前的 P15 已经报 `review_params_invalid`，
 * 这里只消费，不重写第二套校验；未冻结/坏参数不得让判定“默认抽中”或“默认不抽中”变成隐蔽口径。
 */
export function reviewPolicyOf(policy: unknown): ReviewPolicy | undefined {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return undefined;
  const review = (policy as Record<string, unknown>)['review'];
  if (review === null || typeof review !== 'object' || Array.isArray(review)) return undefined;
  const source = review as Record<string, unknown>;
  const every = source['sample_every'];
  const seed = source['sample_seed'];
  if (!isInteger(every) || every < SAMPLE_EVERY_MIN || every > SAMPLE_EVERY_MAX) return undefined;
  if (!isInteger(seed)) return undefined;
  return { sample_every: every, sample_seed: seed };
}

/** 数学取模：JS `%` 对负数返回负数，这里统一到 `[0, every)`。 */
export function mathMod(value: number, modulus: number): number {
  const remainder = value % modulus;
  // 先加一轮再取模：既处理负数，也避免 `-0`（`assert.strictEqual(-0, 0)` 会红）。
  return ((remainder % modulus) + modulus) % modulus;
}

/**
 * C1：`seq` 是否被抽中。
 *
 * 纯函数、无 IO、无时钟——reviewer 可用同一份 baseline 独立重算。
 * **入样白名单** `implement`/`design`/`docs`（`review` 卡不参与，避免递归；未知 kind/大小写变体一律 `false`）；
 * 参数不合法/序号非整数 fail-closed `false`。
 */
export function isSampled(seq: number, kind: string, review: ReviewPolicy): boolean {
  if (!SAMPLED_KINDS.has(kind)) return false;
  if (!isInteger(seq) || !isInteger(review.sample_every) || !isInteger(review.sample_seed)) return false;
  if (review.sample_every < SAMPLE_EVERY_MIN || review.sample_every > SAMPLE_EVERY_MAX) return false;
  return mathMod(seq - review.sample_seed, review.sample_every) === 0;
}

/** 入样白名单：**由 fold reducer 的 `TASK_KINDS` 派生**（去掉 `review`，避免递归；未知 kind 不在集合里 ⇒ fail-closed）。
 * 守卫断言在 `test/core/review/sample.test.ts`：白名单必须恒等于 `TASK_KINDS \ {review}`，任一边漂移即红。 */
export const SAMPLED_KINDS: ReadonlySet<string> = new Set(TASK_KINDS.filter((kind) => kind !== 'review'));

/** 便于用例/审计展示的辅助函数（**仅供展示/测试**，不是产品入样路径）：`[from, to]` 闭区间内被抓中的卡序号。
 * 产品入样走 `isSampled(seq, text(task['kind']), review)`，`kind` 必须由调用方显式给出真实值。 */
export function sampledSeqs(review: ReviewPolicy, from: number, to: number, kind = 'implement'): number[] {
  const hits: number[] = [];
  for (let seq = from; seq <= to; seq += 1) {
    if (isSampled(seq, kind, review)) hits.push(seq);
  }
  return hits;
}
