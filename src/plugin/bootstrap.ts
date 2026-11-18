/**
 * M5-0 C16：插件 bootstrap（内部入口，不进工具清单）。
 *
 * 两个身份：
 * - agent `sdo:plugin-agent`（kind agent）：工具面固定通道，只拿最小写权；
 * - human 账号 actor `user:<uuid>`（kind human）：登录页面/签字用。
 *
 * create-once 只看 `scope` 行是否存在（**不看 revoked_at**）：撤权后不自动复活，
 * 重启也不会重新 grant。`bootstrapGrantRight` 只允许迁移/初始化代码调用（D-113）。
 */

import { bootstrapEnrollActor, bootstrapGrantRight } from '../db/auth-bootstrap.js';
import type { SdoDatabase } from '../db/driver.js';
import type { ActorKind } from '../core/auth/session.js';

export const PLUGIN_AGENT_ACTOR = 'sdo:plugin-agent';
export const PLUGIN_BOOTSTRAP_ACTOR = 'sdo:plugin-bootstrap';

export interface GrantSpec {
  readonly actor: string;
  readonly right: string;
  readonly scope: string;
}

// 卡 C16 写的是动作级授权 `create@domain:sdo` / `propose_plan@domain:core`；
// 授权格里动作 -> 右：create => plan@domain，propose_plan => plan@domain。
// 因 `hasRight` 要求同 scope 命中，agent 需要 plan@domain:sdo 与 plan@domain:core 两条。
export const AGENT_GRANTS: readonly GrantSpec[] = [
  { actor: PLUGIN_AGENT_ACTOR, right: 'read', scope: 'domain:core' },
  { actor: PLUGIN_AGENT_ACTOR, right: 'plan', scope: 'domain:sdo' },
  { actor: PLUGIN_AGENT_ACTOR, right: 'plan', scope: 'domain:core' },
];

export const HUMAN_GRANTS: readonly GrantSpec[] = [
  { actor: '', right: 'read', scope: 'domain:core' },
  { actor: '', right: 'read', scope: 'domain:sdo' },
  { actor: '', right: 'decide', scope: 'domain:sdo' },
  { actor: '', right: 'sign', scope: 'domain:core' },
  { actor: '', right: 'sign', scope: 'release:current' },
];

function hasScopeRow(db: SdoDatabase, grant: GrantSpec): boolean {
  return db.prepare('SELECT 1 AS one FROM scope WHERE actor = ? AND scope = ? AND right = ? LIMIT 1').get(
    grant.actor,
    grant.scope,
    grant.right,
  ) !== undefined;
}

function enroll(db: SdoDatabase, actor: string, kind: ActorKind, display?: string): void {
  const result = bootstrapEnrollActor(db, { actor, kind, ...(display === undefined ? {} : { display }) });
  if (!result.ok) throw new Error(`bootstrap enroll ${actor} 失败：${result.message ?? result.reason_code}`);
}

function grant(db: SdoDatabase, spec: GrantSpec): void {
  if (hasScopeRow(db, spec)) return;
  const result = bootstrapGrantRight(db, { ...spec, granted_by: PLUGIN_BOOTSTRAP_ACTOR });
  if (!result.ok) throw new Error(`bootstrap grant ${spec.actor} ${spec.right}@${spec.scope} 失败：${result.message ?? result.reason_code}`);
}

/** 首次启动即调用；幂等，只补缺失的 actor / grant。 */
export function ensurePluginBootstrap(db: SdoDatabase): void {
  enroll(db, PLUGIN_BOOTSTRAP_ACTOR, 'service', 'SDO plugin bootstrap');
  enroll(db, PLUGIN_AGENT_ACTOR, 'agent', 'SDO plugin agent');
  for (const spec of AGENT_GRANTS) grant(db, spec);
}

/** 首个账号（或任何新账号）创建后调用；只补 human 的 5 条右。 */
export function ensureHumanBootstrap(db: SdoDatabase, actorId: string): void {
  enroll(db, actorId, 'human', `human ${actorId}`);
  for (const spec of HUMAN_GRANTS) grant(db, { ...spec, actor: actorId });
}
