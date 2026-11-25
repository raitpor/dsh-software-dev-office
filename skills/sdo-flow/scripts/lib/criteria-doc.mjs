// 判据说明的唯一来源：gate init 的「说明」列与 references/04 §1 的说明表都从这里生成。
// 池本身仍由 lib/criteria-pool.mjs 维护（快照 15 门 / 3 core / 41 启发式，见 milestone declare --list），
// 本文件只负责「每条判据一句说明」与生成表格；禁止在 gate.mjs / references/04 §1 手抄第二份。
import fs from "node:fs";
import path from "node:path";
import { loadCriteriaPool, CORE_CRITERIA } from "./criteria-pool.mjs";
import { resolvePaths } from "./paths.mjs";

export const CRITERIA_DESCRIPTIONS = {
  "spec_set.signed": "规格集合已由指定签字人签署。",
  "assumption_set.signed": "假设集合已由指定签字人签署并覆盖。",
  "provenance.present": "实现/证据的可追溯来源已记录。",
  "gate.signed": "本阶段门已由门签接受。",
  "readings.recorded": "该里程碑读数已记录且 overall 有结论。",
  "review.independent": "评审者独立于作者，未自查自签。",
  "review.required": "抽样：本卡评审覆盖了要求的抽样范围。",
  "review.round_bound": "轮次：评审轮次受控，不以无限返工代替收敛。",
  "agent.reviewer_not_author": "身份：agent 评审者不得是作者本人。",
  "agent.cards_have_negative_cases": "每张卡的判据都有可失败的反例。",
  "agent.checker_green": "项目检查器在改动后保持全绿。",
  "agent.evidence_runnable": "证据是可复跑命令，不是散文结论。",
  "agent.findings_disposed": "评审发现已逐条处置或明确记录。",
  "agent.human_signed": "关键决定已由人类签字。",
  "agent.known_limits": "已知边界已写出，未被静默忽略。",
  "agent.mutation_red": "关键规则有变异红证。",
  "agent.no_self_sign": "执行者不代签自己的产物。",
  "agent.plan_reviewed": "计划经过独立评审后才开工。",
  "agent.readings_frozen": "里程碑读数在冻结树上取得。",
  "agent.unverified_listed": "未验证项被如实列出。",
  "agent.write_scope_disjoint": "并行卡写域不相交或已串行化。",
  "alignment.examples_present": "对齐说明含可执行例子。",
  "assumption.disposed": "假设被证据验证或显式处置。",
  "design.alternatives_declared": "设计写明了备选及取舍。",
  "design.artifacts_present": "设计产物（ADR/接口/数据）已落盘。",
  "design.code_matches": "实现代码与设计产物一致。",
  "design.covers_spec": "设计覆盖规格要求。",
  "design.no_spec_creep": "实现未越出规格范围。",
  "intent.explicit_for_risk": "高风险意图被显式写出。",
  "intent.restated_consistent": "复述的意图与原意一致。",
  "mandate.revalidated": "授权/任务书在变更后重新确认。",
  "node.acceptance_bound": "每个节点有可判的验收边界。",
  "node.integration_listed": "集成点与依赖已列出。",
  "redteam.disposed": "红队发现已处置或留痕。",
  "requirement.baseline_present": "需求基线段存在且可引用。",
  "requirement.claimed_or_na": "需求已被认领或写明合理不适用。",
  "scope.present": "写域/范围已声明。",
  "stage.design_traceable": "设计可追溯到需求。",
  "stage.requirement_complete": "本阶段需求已闭合。",
  "task.complete": "任务已完成并有收口证据。",
  "test.design_present": "测试设计产物存在。",
  "trace.card_coverage": "需求被卡覆盖且无孤儿卡。",
  "trace.requirement_covered": "每条需求至少被一张卡引用。",
  "trace.test_linked": "测试引用可定位到需求/判据。",
};

export function criteriaDocRows(skillRoot) {
  const { criteria } = loadCriteriaPool(skillRoot);
  const core = CORE_CRITERIA.slice();
  const rest = criteria.filter((c) => !core.includes(c));
  const rows = [...core, ...rest].map((id) => {
    const description = CRITERIA_DESCRIPTIONS[id];
    if (!description) throw new Error(`criterion_description_missing：${id} 没有说明（先补 lib/criteria-doc.mjs）`);
    return { id, description };
  });
  return rows;
}

export function describeCriterion(skillRoot, id) {
  const row = criteriaDocRows(skillRoot).find((r) => r.id === id);
  if (!row) throw new Error(`criterion_description_missing：${id} 不在权威判据池（先同步 lib/criteria-pool.mjs 与本文件）`);
  return row.description;
}

export function emitCriteriaTable(skillRoot) {
  const lines = ["| 判据 id | 一句话说明 |", "|---|---|"];
  for (const r of criteriaDocRows(skillRoot)) lines.push(`| \`${r.id}\` | ${r.description} |`);
  return lines.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith(`${path.sep}criteria-doc.mjs`) && process.argv.includes("--emit")) {
  const { skillRoot } = resolvePaths(process.cwd());
  console.log(emitCriteriaTable(skillRoot));
}
