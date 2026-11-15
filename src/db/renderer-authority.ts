/**
 * M3-4 / P1-2：`renderer.registered` 的一次性写授权（能力模式，对齐 M2-2 `gate.judged`）。
 *
 * 该 kind 是 ACK（不投影 fold 表），若不设写路径守卫，任何人都能手工 `append` 一条
 * 注册事件绕过 `registerRenderer()` 的权限、模块 `import()` 校验与 id 冲突检查。
 *
 * 协议：
 * - `registerRenderer()` 在全部校验通过、即将调 `append()` 前调用 `mint()`（本模块不导出
 *   mint，仅 `src/db/renderer.ts` 能 import）；能力绑**规范化载荷的 sha256**。
 * - 写网关在 append 事务里对 `renderer.registered` 重新算载荷摘要并 `consume()`；
 *   消费即烧毁（不常驻），找不到/摘要不符 ⇒ `unauthorized_renderer_registration`、整批回滚。
 */

import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';

const AUTHORITIES = new Set<string>();

/** 载荷摘要口径：与 `renderer.registered` 的 `{id, module_path, views}` 规范化 JSON 一致。 */
export function rendererRegistrationPayloadHash(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const id = record['id'];
  const modulePath = record['module_path'];
  const views = record['views'];
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (typeof modulePath !== 'string' || modulePath.length === 0) return undefined;
  if (!Array.isArray(views) || views.some((view) => typeof view !== 'string' || view.length === 0)) {
    return undefined;
  }
  return sha256Hex(canonicalJson({ id, module_path: modulePath, views }));
}

/**
 * 登记能力（mint）。
 * @internal 只允许 `src/db/renderer.ts` 的 `registerRenderer()` 调用；不对外导出。
 */
export function mintRendererRegistrationAuthority(payloadHash: string): void {
  AUTHORITIES.add(payloadHash);
}

/**
 * 写网关调用：校验并烧毁一次性能力。
 * @internal 仅供 `src/db/write.ts` 使用。
 */
export function consumeRendererRegistrationAuthority(payloadHash: string): boolean {
  return AUTHORITIES.delete(payloadHash);
}

/** 测试清理（能力只存在于进程内；跨用例残留会让“无授权”用例假绿）。 */
export function clearRendererRegistrationAuthorities(): void {
  AUTHORITIES.clear();
}
