/**
 * M3-2 · 哪些事件必须声明 CAS（`field` + `base_hash`）。
 *
 * 清单漂移会被 `test/core/conflict/scope.test.ts` 与网关拒绝抓出来。
 */
/**
 * 强制声明的是内容编辑类 kind（当前 `spec.revised[clause]`、`criterion.revised[remedy]`）；豁免的是生命周期迁移与单写者产生的事件（`task.*` 的状态迁移、`config.changed`、`goal.reparented`、`restatement.diff_dispositioned` 等），它们不并发覆盖同一字段。
 *
 * 只收**共享文档的内容编辑**：并发改同一对象同一字段会静默丢内容（lost update），
 * 必须在写路径可见。生命周期迁移/状态机推进不在此列——它们由租约（lease）、
 * 权限与 signerd 单点写者保证“同一时刻只有一个合法写者”，并发请求本身会被
 * 状态守卫拒绝，不属于“两人都以为自己在改文档”的冲突。
 *
 * 入列理由（逐 kind）：
 * - spec.revised：改条款正文（clause）；两人同时编辑同一需求，后来者若无提示会
 *   覆盖别人的措辞——这是本卡唯一必须可见的内容丢失。
 * - criterion.revised：改验收判据的 remedy/判据正文；并发编辑同一判据会产生
 *   “谁的最后写入生效”的静默覆盖，直接影响门禁语义。
 *
 * 不入列的理由（逐类）：
 * - createOnce 类（spec.defined/contract.defined/criterion.registered/...）：只建
 *   不覆盖，同 id 不同内容由 reducer 直接拒，没有 lost update。
 * - 生命周期迁移（task.claimed/done/reopened/blocked/dropped/assigned/...）：
 *   由 M3-1 租约 + 权限保证单写者；非法迁移由状态守卫拒，不吞内容。
 * - decision.* / release.* / gate.judged / stage.exited / assumption.disposed /
 *   assumption.invalidated / restatement.invalidated：由 signerd 一次性能力或
 *   签名决策单点产生，payload schema 固定；伪造由能力/签名兜底。
 * - config.changed：配置是 operator 单写者路径（M1-5 审计 + 权限），且 DDL 以
 *   key 为主键、写入即覆盖；并发编辑的可见性留 M3-4 视图评估。
 */
export const CONFLICT_TRACKED_FIELDS: Readonly<Record<string, string>> = {
  'spec.revised': 'clause',
  'criterion.revised': 'remedy',
} as const;

export const CONFLICT_TRACKED_KINDS: readonly string[] = Object.keys(CONFLICT_TRACKED_FIELDS);

export function trackedField(kind: string): string | undefined {
  return Object.hasOwn(CONFLICT_TRACKED_FIELDS, kind) ? CONFLICT_TRACKED_FIELDS[kind] : undefined;
}
