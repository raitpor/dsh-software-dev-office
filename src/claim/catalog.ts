/**
 * M3-4 · claim 侧的目录查询面（只读）。
 *
 * 真源在 `src/db/renderer.ts`（`renderer_catalog` 表 + 事件投影）；本文件不是第二套
 * 登记表，只把 claim 网关/对账要用的三个问题收敛成一处：
 *   · 这个 `derived_by` 在目录里吗？（C2）
 *   · 它声明了哪些视图？（C1）
 *   · 这些视图覆盖 claim 前沿事件声称的来源表吗？（C4）
 */
import type { SdoDatabase } from '../db/driver.js';
import {
  isRendererRegistered,
  readRendererCatalog,
  rendererById,
  rendererViewCoverage,
  type RendererCatalogRow,
  type RendererCoverage,
} from '../db/renderer.js';

/** C2：`claim.derived_by` 只认 `renderer_catalog` 里的 id。 */
export function isRegisteredRenderer(db: SdoDatabase, id: string): boolean {
  return isRendererRegistered(db, id);
}

export function registeredRenderer(db: SdoDatabase, id: string): RendererCatalogRow | undefined {
  return rendererById(db, id);
}

export function registeredRenderers(db: SdoDatabase): RendererCatalogRow[] {
  return readRendererCatalog(db);
}

/** C4：`views[]` 必须覆盖来源视图（见 `src/db/renderer.ts` 的 `rendererViewCoverage`）。 */
export function claimViewsCoverage(
  db: SdoDatabase,
  rendererId: string,
  frontierEventIds: readonly string[],
): RendererCoverage {
  return rendererViewCoverage(db, rendererId, frontierEventIds);
}
