/**
 * M4-7/C1：`agent.spawned.new_reason` 的机器复算。规则逐字照 docs/12 §3（第 77–79 行），
 * 数据不足时按卡 M4-7「C1 复算表」fail-closed，不自行放宽。
 */
import { SPAWN_REASONS, type PoolSnapshot, type SpawnReason } from './types.js';
import { reusableCandidates } from './snapshot.js';

export interface SpawnReasonInput {
  readonly new_reason: unknown;
  readonly snapshot: unknown;
  readonly required_skills?: readonly string[];
  /** 卡的写域文件（task.scope_paths）；context_irrelevant 用它算交集。 */
  readonly card_scope_files: readonly string[];
  readonly actor_has_compaction: boolean;
}

export type SpawnReasonCheck =
  | { readonly ok: true; readonly reason: SpawnReason }
  | {
      readonly ok: false;
      readonly reason_code: 'invalid_field' | 'spawn_reason_mismatch';
      readonly message: string;
      readonly details?: readonly string[];
    };

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 快照必须完整；缺字段 ⇒ invalid_field（C1 表：数据不足 fail-closed）。 */
function parseSnapshot(value: unknown): { ok: true; snapshot: PoolSnapshot } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'agent.spawned snapshot must be an object' };
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['idle'])) return { ok: false, message: 'agent.spawned snapshot.idle must be an array' };
  if (typeof record['watermark_limit'] !== 'number' || !Number.isFinite(record['watermark_limit'])) {
    return { ok: false, message: 'agent.spawned snapshot.watermark_limit must be a finite number' };
  }
  let idle: PoolSnapshot['idle'];
  try {
    idle = record['idle'].map((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`snapshot.idle[${index}] must be an object`);
      }
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate['agent_id'] !== 'string' || candidate['agent_id'].length === 0) {
        throw new Error(`snapshot.idle[${index}].agent_id must be a non-empty string`);
      }
      if (typeof candidate['actor_id'] !== 'string' || candidate['actor_id'].length === 0) {
        throw new Error(`snapshot.idle[${index}].actor_id must be a non-empty string`);
      }
      if (!isStringArray(candidate['skills'])) throw new Error(`snapshot.idle[${index}].skills must be string[]`);
      if (!isStringArray(candidate['last_task_files'])) {
        throw new Error(`snapshot.idle[${index}].last_task_files must be string[]`);
      }
      if (typeof candidate['watermark'] !== 'number' || !Number.isFinite(candidate['watermark'])) {
        throw new Error(`snapshot.idle[${index}].watermark must be a finite number`);
      }
      return {
        agent_id: candidate['agent_id'],
        actor_id: candidate['actor_id'],
        skills: candidate['skills'],
        last_task_files: candidate['last_task_files'],
        watermark: candidate['watermark'],
      };
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'agent.spawned snapshot.idle is invalid' };
  }
  return { ok: true, snapshot: { idle, watermark_limit: record['watermark_limit'] } };
}

/** 路径段归一：`a//b/../c/` → ['a','c']；用于“目录前缀 vs 文件”的相交判定。 */
function segments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/** `a/b` 与 `a/bc` 不算；`src/agent/` 与 `src/agent/x.ts` 算（任一侧是另一侧的段前缀）。 */
function segmentPrefix(left: readonly string[], right: readonly string[]): boolean {
  if (left.length > right.length) return false;
  return left.every((part, index) => part === right[index]);
}

function intersects(files: readonly string[], scope: readonly string[]): boolean {
  return files.some((file) => {
    const fileSegments = segments(file);
    return scope.some((entry) => {
      const scopeSegments = segments(entry);
      return segmentPrefix(scopeSegments, fileSegments) || segmentPrefix(fileSegments, scopeSegments);
    });
  });
}

export function validateSpawnReason(input: SpawnReasonInput): SpawnReasonCheck {
  const reason = input.new_reason;
  if (typeof reason !== 'string' || !(SPAWN_REASONS as readonly string[]).includes(reason)) {
    return {
      ok: false,
      reason_code: 'invalid_field',
      message: `agent.spawned.new_reason must be one of ${SPAWN_REASONS.join(', ')}`,
    };
  }
  const parsed = parseSnapshot(input.snapshot);
  if (!parsed.ok) return { ok: false, reason_code: 'invalid_field', message: parsed.message };
  const snapshot = parsed.snapshot;
  const requiredSkills = input.required_skills ?? [];
  const candidates = reusableCandidates(snapshot, requiredSkills);
  const base = {
    reason: reason as SpawnReason,
    candidates: candidates.map((candidate) => candidate.agent_id),
  };
  const mismatch = (message: string, details: readonly string[] = []): SpawnReasonCheck => ({
    ok: false,
    reason_code: 'spawn_reason_mismatch',
    message,
    details,
  });

  if (base.reason === 'no_idle_capable') {
    if (candidates.length > 0) {
      return mismatch(
        `new_reason=no_idle_capable but ${candidates.length} reusable candidate(s) exist`,
        base.candidates,
      );
    }
    return { ok: true, reason: base.reason };
  }

  if (base.reason === 'context_irrelevant') {
    if (candidates.length === 0) {
      return mismatch('new_reason=context_irrelevant requires at least one reusable candidate');
    }
    const details: string[] = [];
    for (const candidate of candidates) {
      if (intersects(candidate.last_task_files, input.card_scope_files)) {
        details.push(
          `candidate ${candidate.agent_id} last_task files intersect card scope: ${candidate.last_task_files
            .filter((file) => input.card_scope_files.includes(file))
            .join(', ')}`,
        );
      }
    }
    if (details.length > 0) {
      return mismatch('new_reason=context_irrelevant but some candidate context intersects the card scope', details);
    }
    return { ok: true, reason: base.reason };
  }

  // watermark_exhausted
  if (candidates.length === 0) {
    return mismatch('new_reason=watermark_exhausted requires at least one reusable candidate');
  }
  const below = candidates.filter((candidate) => candidate.watermark < snapshot.watermark_limit);
  if (below.length > 0) {
    return mismatch(
      `new_reason=watermark_exhausted but candidate(s) ${below.map((c) => c.agent_id).join(', ')} are below the limit`,
    );
  }
  if (!input.actor_has_compaction) {
    return mismatch(
      'new_reason=watermark_exhausted requires an agent.compaction_attempted event for this actor',
    );
  }
  return { ok: true, reason: base.reason };
}
