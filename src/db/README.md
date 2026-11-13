# src/db/ · schema 与驱动

职责：`event` / `schema_version` 等 DDL、迁移框架（可建、可迁、可回滚）、SQLite 驱动适配。

- 写域：`core` 泳道（impl-core）。surface 不碰 DDL。
- 第一张填充卡：M0-1（schema 与迁移）；M0-6 接库位置与沙箱约束。
- 驱动：`better-sqlite3-multiple-ciphers@13.0.3`，SQLCipher 格式（`cipher='sqlcipher'` + `legacy=4`）；空口令拒绝、无明文回落，`openEncryptedDatabase` 在 open 内立即读一次 `sqlite_master`，错误口令/明文库当场失败。选型证据见 [M0-0 卡](../../plan/cards/M0-0.md) C4。
- 为什么是 13.x：tarball 自带 8 平台 `prebuilds/*.node`，安装期不需要 node-gyp/prebuild-install（离线/镜像友好）。因此干净安装钉 `npm ci --ignore-scripts`；裸 `npm ci` 会触发 npm 对 `binding.gyp` 的自动重建（见卡 E9/E10）。
- 为什么不是 12.11.1：12.x 不带 prebuilds，靠 `prebuild-install` 在安装期联网从 GitHub 下二进制（该依赖已停止维护），且 `npm ci --ignore-scripts` 后驱动直接不可用。
- 类型：13.x 的 `exports` map 缺 `"types"` 条件，`tsconfig.json` 用 `paths` 指到其 `index.d.ts`（上游缺陷，升级后重试删除）。
- 迁移（M0-1）：`migrations/001_init.sql` 单文件建全部表与约束；`src/db/migrate.ts` 只负责按 `PRAGMA user_version` 逐个装载 SQL、每文件一个事务并把版本推到该文件号——不打开连接（由调用方用 `openEncryptedDatabase` 建库），不写业务数据。
- schema 形状：docs/03 的 25 张表 + docs/02/04/06/07/09/12 的 9 张支撑表（`decision`、`baseline`、`task`、`event`、`event_kind`、`config`、`verify_run`、`release`、`release_item`），共 34 张；`event`/`baseline` 只追加、`release` 冻结后不可变且状态迁移只能是 draft→frozen→delivered/rolled_back（禁回 draft）、`defect` 关闭只认 `verify_run.result='pass'`，均由触发器在库层拒绝（不是 TS 的 if）。
- 只追加的完整性：`INSERT OR REPLACE` 本质是“删旧行 + 插新行”，SQLite 默认 `recursive_triggers=OFF` 时不会触发 DELETE 触发器——`openEncryptedDatabase` 显式 `PRAGMA recursive_triggers = ON`，REPLACE 才被拒。这是**库层护栏，不是不可篡改**：直接改库文件、或整链重算后重写 `event`/`baseline`，库本身发现不了，只有 `verify`（M0-2 起）按链复核能发现；M-10 本来就不承诺防篡改。`release`/`defect` 的状态合法性同样以事件折叠为准（M0-2），触发器只拦库层非法写。
- 外键：驱动编译了 `DEFAULT_FOREIGN_KEYS`，裸连接默认 FK=ON；`openEncryptedDatabase` 仍显式 `PRAGMA foreign_keys = ON`，每连接生效。
- `config` 只建表、不填四把钥匙的缺省值（M0-7 的事）；迁移幂等：第二次 `runMigrations` 返回 `applied: []`。
- `defect` 的 `closed` 是终态：关闭人必须就是复验的 actor（`closed_by = verify_run.actor`，且该 verify 必须 `result='pass'`）；关掉后任何 `UPDATE` 都被拒（重开、换复验证据都不行）。设计里没有定义“重开”（docs/03 只有 open/closed）——若要重开，先改设计（新增事件与状态迁移），不是库层放宽。
