# src/db/ · schema 与驱动

职责：`event` / `schema_version` 等 DDL、迁移框架（可建、可迁、可回滚）、SQLite 驱动适配、打开路径守卫与读留痕 sidecar。

- 写域：`core` 泳道（impl-core）。surface 不碰 DDL。
- 填充卡：M0-1（schema 与迁移）、M0-6（打开路径守卫与读留痕）。
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

- 打开入口（M0-6）：`src/db/open.ts` 的 `openSdoDatabase(path, passphrase, {mustExist})` 先判 `mustExist` 存在性（缺失直接报错、不留空目录），再 `ensureDbDirectory`（0700、不可写即 `SdoPathError`），最后交给 `openEncryptedDatabase`；打开成功后把**绝对路径** `sdoPath` 绑到连接上（`db.name` 是传入时的相对路径，chdir 后会漂移），`access.log` 优先用它。调用方不要绕过 `--ignore-scripts` 那条安装纪律，也不要自己 `new Database`。
- 读留痕（M0-6）：`src/db/access-log.ts` 的 `recordAccess` 在库同目录追加 `access.log`，一行 `{at,view,args_hash,right}`（`args_hash = sha256(canonicalJson(args))`，0600、不进事件）。`sdo_query` 的唯一执行路径已接 `recordAccessSafe`：**best-effort**，日志不可写时读照常成功、每进程只打一条 stderr warning，失败计数可查（`accessLogFailureCount()`），不改 `QueryResult` 形状。该边界会丢：warning 只在本进程、计数重启即归零；M1 可接持久化告警。

- 写网关（M1-0）：`src/db/write.ts` 的 `append(db, events)` 是**唯一**往 `event` 写行的入口（`grep -rn "INSERT INTO event" src/` 只命中它）。入口在一个 `BEGIN IMMEDIATE` 事务里做四件事：信封/kind 白名单（`REDUCERS`/`ACK_KINDS`，用 `Object.hasOwn` 防原型链）→ 链连续性（`prev`=当前链头、`hash`=`computeEventHash`）→ 同批重放幂等（同 id 同 hash 跳过、不同 hash 拒）→ 全量重放 `fold` 后 diff 落库；任一步失败 `ROLLBACK`，返回结构化 `reason_code`，不抛裸错。调用方已开事务时直接拒 `transaction_in_progress`（网关不嵌套事务）。
- 拒绝码：`unknown_event_kind`/`invalid_field`/`unsupported_scope`/`event_chain_broken`/`event_hash_mismatch`/`append_conflict`（插 `event` 撞库，如同批重复 id）/`transaction_in_progress`（调用方已有未提交事务）/`database_busy`（`BEGIN IMMEDIATE` 撞别的写者，`SQLITE_BUSY`）/`materialize_failed`；台账 D-025 需同步登记这些新码。失败返回 `written:0/skipped:0/attempted=通过校验条数/rolled_back:true`，`eventCount` 是调用前行数。
- 物化范围（第 62 轮收窄，Lead 复认 B）：**7 张表**——`intent`/`spec`/`criterion`/`evidence` + `decision`（外键父）+ `restatement`/`restatement_diff`。可接受的 kind 集合 = 投影落在这 7 张表的 kind（`SUPPORTED_KINDS` 显式白名单）；其余已登记 kind 一律 `unsupported_scope`，`message` 带 kind 与所需表名。`decision` 只落 `signature` 非空的行（D-019）：`decision.valid` 单批不落库、`decision.signed` 后才出现；`verify` 用同一口径（`src/core/verify-projection.ts`，对账 `task`/`spec`/`release`/`decision` 四张，M2 补齐其余）。
- 安全网：`materialize` 在 fold 之后若发现**物化集以外**的表有 fold 产出的行，直接 `materialize_failed`（带表名），绝不静默丢投影。口径仅限 **fold 产出的行**：绕过网关直插的行要分两类——在物化集内的表，下一次 `append` 的全量 diff 会把它 DELETE 掉（被冲不等於被发现）；物化集外的表（如直接 `INSERT criterion_fixture`）**`verify` 看不见**（`VERIFIED_TABLES` 只对账 `task`/`spec`/`release`/`decision` 4 张），既不红也不冲，属 D-032/M1-7。别把安全网当“全库防篡改”。“物化全表”是独立设计对齐工作（D-031，建议 M1-7），本卡不做。
- 92 个 registered kind 的两种归属：可接受（`SUPPORTED_KINDS`，投影表 ⊆ 物化集）/ `unsupported_scope`（合法已登记、本卡不收，如 `task.*`、`release.*`）。`ACK_KINDS`（无 reducer、无投影，如 `query_miss`）是 `unsupported_scope` 的一个子集，码相同，不是第二个码。`criterion_fixture` 无任何 reducer 产出，**不是**生产路径；M1-2 测试里直接 `INSERT` 它属夹具旁路，M1-1 定其事件载体。
- 物化是**全量 diff、fold 为权威**：fold 里没有的行会从投影表删掉。这意味着投影表只能由 `append` 产生——手工 `INSERT`/改行会在下一次 `append` 被覆盖或删除（篡改仍由 `verify` 发现）。
- `FOLD_ONLY_COLUMNS`（`write-materialize.ts`）显式列出 fold 行比 001 DDL 多出的列（本卡相关：`intent.status`、`spec.revised_at`、`criterion.at/revised_at`）；新增忽略列不登记会让物化抛 `materialize_failed`，C5 用例断言“实际忽略列 == 白名单”。`task.*` 的 fold-only 列（`claimed_at`/`reserved_by`/`reserved_until`）属“表暂不物化”，记入 D-031 的 M1-7 输入。
- 已知边界：网关为校验链必须读 `event` 表（`readChain`/`chainHead`），属 `docs/02` §12 白名单（D-027 explain）；本卡只按 `event.id` 幂等，`request_id` 幂等属写 API 层（D-028 gap）；“批内 replay 必须排在新事件之前”是网关约束、设计稿未写（台账 explain）；`append` 不做并发写者保护（M4 才做锁）。C1 的“`src/` 里只有网关 `INSERT INTO event`”是**静态正则扫描**：动态拼接/生成代码只能尽力扫，不构成源码级证明（测试覆盖 `INSERT OR REPLACE`/引号/`main.event`/字符串拼接变体，但未知变体可能漏）；真正的运行时证据是每条接受路径后 `verify()` 绿 + 事件数。
- `FOLD_ONLY_COLUMNS` 现含 `decision.rejected_at/rejected_reason`、`intent.status`、`spec.revised_at/decision_id/successor_ref/disposed_at/invalidated_reason/invalidated_at`、`criterion.at/revised_at`；`assumption.disposed`/`invalidated` 主路径依赖这些列（P1，第 63 轮）。
