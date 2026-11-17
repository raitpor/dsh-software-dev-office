/**
 * M3-1 P2-4：查询必须有会话；测试用最小“会话 + 真实 grant”夹具。
 *
 * 不走生产 auth API，只直接播种 actor/scope 两行（DR-057 的“只补 grant”方式），
 * 让 `query()` 走真实的 `hasRight` 覆盖判定（撤销/前缀/scope 都由生产代码判）。
 */
import { seedViewerRights } from '../db/append-auth.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import type { Session } from '../../src/core/auth/session.js';

export function asViewer(
  db: SdoDatabase,
  actor = 'viewer',
  right: 'read' | 'review' | 'decide' | 'sign' = 'read',
): Session {
  seedViewerRights(db, [{ actor, scope: 'domain:core', right }]);
  return { actor, actor_kind: 'human', session_id: `sess-${actor}`, credential: 'test-credential' };
}
