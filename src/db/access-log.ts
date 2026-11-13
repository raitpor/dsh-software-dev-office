/**
 * 读留痕（M0-6，判据 C3）。
 *
 * 真源：docs/09 §16.1（读只留探针线索；不承诺归因）、D-012 口径（sidecar 文本，不进事件）。
 *
 * 形态：库文件同目录 `access.log`，一行一条 JSON：
 *   `{ at, view, args_hash, right }`
 * 其中 `args_hash = sha256:<sha256(canonicalJson(args))>`，只记“读了什么形状”，不记明文参数。
 *
 * 失败策略（lead 裁定）：best-effort。留痕失败不能让读本身失败；只记失败计数，
 * 并在**每个进程**第一次失败时向 stderr 打一条 warning（避免刷屏）。
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';

/** 一行 access.log；字段顺序固定，便于 diff 与人工排查。 */
export interface AccessRecord {
  readonly at: string;
  readonly view: string;
  readonly args_hash: string;
  readonly right: string;
}

export interface RecordAccessInput {
  readonly at: string;
  readonly view: string;
  readonly args: unknown;
  readonly right: string;
}

export function accessLogPath(dbPath: string): string {
  return join(dirname(resolve(dbPath)), 'access.log');
}

/** 追加一行；调用方自己保证库目录存在（通常已由 `ensureDbDirectory` 建好）。 */
export function recordAccess(dbPath: string, input: RecordAccessInput): AccessRecord {
  const entry: AccessRecord = {
    at: input.at,
    view: input.view,
    args_hash: `sha256:${sha256Hex(canonicalJson(input.args))}`,
    right: input.right,
  };
  appendFileSync(accessLogPath(dbPath), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  return entry;
}

export function readAccessLog(dbPath: string): AccessRecord[] {
  const file = accessLogPath(dbPath);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AccessRecord);
}

let warnedOnce = false;
let failures = 0;

/** 本进程留痕失败次数（诊断用；不参与 QueryResult 形状）。 */
export function accessLogFailureCount(): number {
  return failures;
}

/** 仅测试用：重置“每进程一条 warning”与计数。 */
export function resetAccessLogWarningForTests(): void {
  warnedOnce = false;
  failures = 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * best-effort 追加：成功返回 true；失败返回 false 且不抛。
 * 第一次失败时向 stderr 写一条 warning。
 */
export function recordAccessSafe(dbPath: string, input: RecordAccessInput): boolean {
  try {
    recordAccess(dbPath, input);
    return true;
  } catch (error) {
    failures += 1;
    if (!warnedOnce) {
      warnedOnce = true;
      process.stderr.write(
        `sdo: access log unavailable at ${accessLogPath(dbPath)} (${errorMessage(error)}); reads continue\n`,
      );
    }
    return false;
  }
}
