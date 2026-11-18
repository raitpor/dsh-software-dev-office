'use strict';

/**
 * 宿主 CJS 主入口（M5-0 E1b）：Cordis 的 `require(main)` 路径要求导出对象，
 * 而不是 ESM 的模块命名空间；两条入口共用 `activatePlugin`，不复制装配逻辑。
 */
module.exports = {
  name: 'sdo',
  inject: ['tools', 'approval'],
  async apply(ctx, config) {
    const { activatePlugin } = await import('./lib/src/plugin/index.js');
    await activatePlugin(ctx, config ?? {});
  },
};
