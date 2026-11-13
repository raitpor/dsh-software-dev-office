# test/ · 测试骨架

- `*.test.ts`：参与 `npm test`。先由 `tsc` 编译到 `lib/test/`，再由零依赖的 `node --test lib/test/` 执行。**每条测试都必须有断言**。
- `fixtures/always-red.test.mjs`：故意红的负例素材，只由 `negative-sample.test.ts` 以子进程调用，证明「红真的会红」；它不参与 `tsc`，也不在 `node --test lib/test/` 的发现范围里。
- `spike/`：M0-0 驱动选型的复现脚本（不参与 `npm test`）：`npm run spike:driver-native`、`npm run spike:node-sqlite`、`node test/spike/install-matrix.mjs [--out artifacts/install-matrix.log]`（六格安装矩阵）。样本库与矩阵日志留在仓库根 `artifacts/`（内容命中 `.gitignore` 的 `*.db`/`*.log`，不入库），卡里的 `file`/`xxd` 命令可对同一文件复算；重跑 spike 会覆盖样本（SQLCipher 页头含随机 salt）。

## 为什么元测试要剥 `NODE_TEST_CONTEXT`

`negative-sample.test.ts` 在父 `node --test` 进程里再 `spawn` 一个 `node --test` 去跑红 fixture。父进程会把 `NODE_TEST_CONTEXT` 继承给子进程；子 runner 看到它后进入「递归调用 test runner」保护模式，跳过文件并以 0 退出——于是「红会红」会假通过。所以 spawn 前 `delete env['NODE_TEST_CONTEXT']`；同时断言 `run.error === undefined`，避免 spawn 本身失败时 `status` 为 `null` 也被 `notEqual(status, 0)` 放过。

## 安装方式

干净安装用 `npm ci --ignore-scripts`（等价 `npm run setup`）：驱动 13.x 的 prebuilt 二进制随 tarball 发布，安装期不需要任何脚本。裸 `npm ci` 会触发 npm 对 `binding.gyp` 的自动 `node-gyp rebuild`，本环境 HOME 只读会失败（详见 [plan/cards/M0-0.md](../plan/cards/M0-0.md) E9）。
