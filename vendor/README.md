# vendor/ —— CI 的离线依赖

**不要手工改这里**。它由 `npm run vendor:ci`（`scripts/vendor-ci.mjs`）生成，内容是本插件
`devDependencies + dependencies + peerDependencies` 的**传递闭包**（含各包的 peer），共 **34** 个包。

CI 用 `node scripts/ci-install.mjs` 从这里**离线安装**，因此：

- **不需要 `package-lock.json`**（也就没有 `npm ci` / `cache: npm` 的锁文件前置）；
- **不需要 registry**（`@deepseek-ai/*` 就算不在公开源上也能构建与测试）；
- 换依赖后**重新生成**：`npm install`（联网开发机）→ `npm run vendor:ci` → 提交 `vendor/`。
