/**
 * create 语义清单（P1-1 评审）：kind 的投影行“首写即定”——同 id 同内容重放幂等，
 * 同 id 异内容必须拒绝（`createOnce`）。清单完整性由
 * `test/core/fold.semantics.test.ts` 守着：每个列出的 kind 必须真的调用 `createOnce`，
 * 且行为上“同内容不变、异内容 FailError”。漏写一个 kind ⇒ 测试红。
 */
export const CREATE_SEMANTICS: readonly string[] = [
  'assumption.recorded',
  'attention.raised',
  'baseline.amended',
  'baseline.frozen',
  'baseline.loosened',
  'contract.defined',
  'criterion.registered',
  'decision.valid',
  'defect.recorded',
  'design.locked',
  'evidence.attached',
  'goal.declared',
  'goal.integrated',
  'intent.signed',
  'report.recorded',
  'redteam.recorded',
  'release.frozen',
  'restatement.diff_dispositioned',
  'restatement.recorded',
  'review.recorded',
  'review.round_closed',
  'scope.declared',
  'snapshot.taken',
  'spec.defined',
  'stage.entered',
  'task.created',
  'verify.failed',
  'verify.passed',
] as const;
