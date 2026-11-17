import { appendAs as append } from '../db/append-auth.js';
import assert from 'node:assert/strict';
import { dispatchLease, revokeLease } from '../../src/db/lease.js';
import type { ExportClaim } from '../../src/importer/parse.js';
/**
 * M3-4 夹具：把渲染器登记到 `renderer_catalog`。
 *
 * 两条路径：
 *   · `seedRenderer()`：直接 append 一条 `renderer.registered` 事件再重建目录——给
 *     claim 网关/对账测试当“已登记”前提，不经过权限层（权限在
 *     `test/db/renderer.test.ts` 的 `registerRenderer` 用例里单独验）。
 *   · `registerRenderer()`（产品入口）：`src/db/renderer.ts`，需要 `admin@domain`。
 */
import { chainHead } from '../../src/db/write.js';
import { mintRendererRegistrationAuthority, rendererRegistrationPayloadHash } from '../../src/db/renderer-authority.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { chain, seed } from '../db/append-helpers.js';

export interface SeedRendererDef {
  readonly id: string;
  readonly module_path: string;
  readonly views: readonly string[];
}

/** v1 结论回执的渲染器：门禁结果视图 `board` 从 `task` 读，`views[]` 覆盖 task。 */
export const GATE_RENDERER: SeedRendererDef = {
  id: 'renderer:gate-result',
  module_path: 'src/claim/render.ts',
  views: ['board'],
};

/**
 * append 一条登记事件并重建目录，返回事件 id。
 * `chain()` 从当前链头接链，所以可以在任意时刻调用（空库/已有事件都行）。
 */
export function seedRenderer(db: SdoDatabase, def: SeedRendererDef = GATE_RENDERER, n = 900): string {
  const payload = { id: def.id, module_path: def.module_path, views: [...def.views] };
  const [event] = chain([seed(n, 'renderer.registered', def.id, payload)], chainHead(db));
  // 测试夹具需要与产品入口同样的一次性能力（P1-2 之后直 append 登记事件会被写网关拒）；
  // 这里直接 mint 测试能力，产品路径 mint 只在 registerRenderer() 内部。
  const payloadHash = rendererRegistrationPayloadHash(payload);
  if (payloadHash !== undefined) mintRendererRegistrationAuthority(payloadHash);
  const result = append(db, [event!]);
  if (!result.ok) {
    throw new Error(`seedRenderer append failed: ${result.reason_code} ${result.message ?? ''}`);
  }
  return event!.id;
}


/** M4-2/C2：claim 必须持租约；导入前按夹具 claim 的 (task, actor) 预派发。 */
export function dispatchLeasesForClaims(db: SdoDatabase, claims: readonly ExportClaim[]): void {
  for (const claim of claims) {
    const active = db
      .prepare("SELECT id, actor FROM lease WHERE card_id = ? AND status = 'active' ORDER BY issued_at DESC LIMIT 1")
      .get(claim.task_id) as { id: string; actor: string } | undefined;
    if (active !== undefined && active.actor === claim.actor) continue;
    if (active !== undefined) {
      const revoked = revokeLease(db, { actor: 'fixture-root', actor_kind: 'service' }, active.id, claim.at);
      assert.equal(revoked.ok, true, JSON.stringify(revoked));
    }
    const dispatched = dispatchLease(
      db,
      { actor: 'fixture-root', actor_kind: 'service' },
      { card: claim.task_id, actor: claim.actor, scope: 'domain:core', at: claim.at, ttl_s: 315_360_000 },
    );
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
  }
}
