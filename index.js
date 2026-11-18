/**
 * SDO Host 入口（M5-0 C1）。只做装配，所有逻辑在 src/plugin/（编译到 lib/src/plugin/）；
 * 包内相对 import，避免宿主 profile 需要额外解析 SDO 的模块名。
 */
import { activatePlugin } from './lib/src/plugin/index.js';

export const inject = ['tools', 'approval'];

export async function apply(ctx, config) {
  // 生命周期只在 activatePlugin 内用 ctx.effect 注册一次，避免重复注销。
  // 注意：Cordis 会把 apply 的返回值当 effect 收集（只接受函数/null），
  // 因此这里绝不能 `return plugin`，否则宿主报 `TypeError: Invalid effect`。
  await activatePlugin(ctx, config ?? {});
}
