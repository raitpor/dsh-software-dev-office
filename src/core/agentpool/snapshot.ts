/**
 * M4-7/C4：`idle` + 技能匹配的“可用”判定只写一份，派发侧（新起理由复核）
 * 与读数侧（C6）都引用它，避免两侧各算一遍。
 */
import type { IdleCandidate, PoolSnapshot } from './types.js';

export function matchesSkills(candidate: IdleCandidate, requiredSkills: readonly string[]): boolean {
  return requiredSkills.every((skill) => candidate.skills.includes(skill));
}

/** 池快照里的可复用候选（idle 且技能全覆盖），按 agent_id 稳定排序。 */
export function reusableCandidates(
  snapshot: PoolSnapshot,
  requiredSkills: readonly string[],
): readonly IdleCandidate[] {
  return snapshot.idle
    .filter((candidate) => matchesSkills(candidate, requiredSkills))
    .slice()
    .sort((left, right) => left.agent_id.localeCompare(right.agent_id));
}

/** C4 两侧共用：池里是否有可用 agent。 */
export function hasUsableAgent(snapshot: PoolSnapshot, requiredSkills: readonly string[]): boolean {
  return reusableCandidates(snapshot, requiredSkills).length > 0;
}
