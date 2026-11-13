# src/db/ · schema 与驱动

职责：`event` / `schema_version` 等 DDL、迁移框架（可建、可迁、可回滚）、SQLite 驱动适配。

- 写域：`core` 泳道（impl-core）。surface 不碰 DDL。
- 第一张填充卡：M0-1（schema 与迁移）；M0-6 接库位置与沙箱约束。
- 驱动：`better-sqlite3-multiple-ciphers@13.0.3`，SQLCipher 格式（`cipher='sqlcipher'` + `legacy=4`）；空口令拒绝、无明文回落，`openEncryptedDatabase` 在 open 内立即读一次 `sqlite_master`，错误口令/明文库当场失败。选型证据见 [M0-0 卡](../../plan/cards/M0-0.md) C4。
- 为什么是 13.x：tarball 自带 8 平台 `prebuilds/*.node`，安装期不需要 node-gyp/prebuild-install（离线/镜像友好）。因此干净安装钉 `npm ci --ignore-scripts`；裸 `npm ci` 会触发 npm 对 `binding.gyp` 的自动重建（见卡 E9/E10）。
- 为什么不是 12.11.1：12.x 不带 prebuilds，靠 `prebuild-install` 在安装期联网从 GitHub 下二进制（该依赖已停止维护），且 `npm ci --ignore-scripts` 后驱动直接不可用。
- 类型：13.x 的 `exports` map 缺 `"types"` 条件，`tsconfig.json` 用 `paths` 指到其 `index.d.ts`（上游缺陷，升级后重试删除）。
