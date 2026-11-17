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

- 写网关（M1-0/M3-1）：`src/db/write.ts` 的 `append(db, events, {session})` 是**唯一**往 `event` 写行的入口（`grep -rn "INSERT INTO event" src/` 只命中它）。**授权由事件 kind 决定，不接受调用方自报动作**：`src/core/auth/kind-actions.ts` 的 `KIND_ACTIONS` 给全部 supported kind 映射 `{action, scopeOf(payload)}`（scope 优先级：payload 显式 scope（前缀须与动作一致）→ task.scope_paths[0] → 单域常量），未映射的非 ACK kind ⇒ `unmapped_event_kind`；`authorizeEvent` 先按事件判 `hasRight(actor, action, scope)`（`action='sign'` 走未撤销 sign 权 + 决策 kind 对应 scope，M4 再进矩阵），再跑 `src/db/action-objects.ts` 的 `ACTION_OBJECT_CONDITIONS`（`defect.closed` 需 verify_run pass 且 closed_by=verify actor；`review.finding_verified` 需对象 producer 本人），失败码 `object_condition_failed`。`event.actor` 必须等于会话 actor；唯一白名单 `conflict.detected`（S22 落失败写入方，能力由检测路径一次性 mint）。`decision.valid` 的 actor 同样绑会话（=签名发起者/工具侧），验证生产者只放 `payload.producer`（由签名流程写入、不参与授权判定）；同批 `decision.signed` 的 actor 仍是签名者，回执绑 payload_hash/proposition_hash。`appendAsTool(db,events,actor,actor_kind)` 只给内部工具路径用（不再传 action/scope）。调用点清单 `APPEND_CALL_SITES`（`src/db/append-actions.ts`，13 条 file→kind 集合）与静态守卫测试一一对应，未登记即红；扫描局限：只看直接 `append(db`/`appendAsTool(db` 文本，动态拼接/别名调用不在静态守卫内。`scope_owns` 是**部署数据**（迁移 013 只读播种，无工具写路径，守卫测试断言 `src/` 无 INSERT；同库写者仍是可信边界）。入口在一个 `BEGIN IMMEDIATE` 事务里做四件事：信封/kind 白名单（`REDUCERS`/`ACK_KINDS`，`Object.hasOwn` 防原型链）→ 重放跳过（同 id 同 hash）→ 授权/对象条件（fresh 事件）→ 链连续性（`prev`=当前链头、`hash`=computeEventHash）→ 全量重放 `fold` 后 diff 落库；任一步失败 `ROLLBACK`，返回结构化 `reason_code`，不抛裸错。调用方已开事务时拒 `transaction_in_progress`（网关不嵌套事务）。
- 拒绝码：`unknown_event_kind`/`invalid_field`/`unsupported_scope`/`event_chain_broken`/`event_hash_mismatch`/`append_conflict`（插 `event` 撞库，如同批重复 id）/`transaction_in_progress`（调用方已有未提交事务）/`database_busy`（`BEGIN IMMEDIATE` 撞别的写者，`SQLITE_BUSY`）/`materialize_failed`/`no_permission`（M3-1 鉴权）/`object_condition_failed`（M3-1 C8 动作对象条件）/`unmapped_event_kind`/`actor_not_from_session`（M3-1 P0/P1-2）；M2-3 另有 `assumption_invalidated_is_derived`（派生读数不可写，D-078）与 `signature_not_from_signerd`（M2-0/C8）；拒绝码清单见 `plan/03` D-025（已登记）。失败返回 `written:0/skipped:0/attempted=通过校验条数/rolled_back:true`，`eventCount` 是调用前行数。
- 物化范围（M1-7 开闸，D-031 关闭）：`MATERIALIZED_TABLES = TABLE_NAMES − NON_MATERIALIZED`，覆盖 fold 能产出的全部表（当前 28 张）；`NON_MATERIALIZED` = `event`/`event_kind`/`claim`/`receipt`/`field_consumer`/`scenario`（事件存储、renderer 写、目录数据、设计缺口）。`SUPPORTED_KINDS` 由 `REDUCERS` 动态生成（56 个）；`ACK_KINDS`（无 reducer、无投影，如 `query_miss`）仍 `unsupported_scope`。`decision` 只落 `signature` 非空的行（D-019）：`decision.valid` 单批不落库、`decision.signed` 后才出现；`verify` 用同一口径。
- 键按 **DDL 主键**（`PRAGMA table_info` 的 pk 序号）而不是代理 `id`：`config.key`、`snapshot_parent(snapshot_id,parent_id)`、`release_item(release_id,kind,target)`、`design_lock(spec_id,spec_version_hash)` 等无单 id 表照常 diff/删。`release` 的插入触发器只接受 `draft`/`frozen`：物化最终态时先按 `frozen` 落行，再走允许的状态迁移（delivered/rolled_back）。
- 列对齐：`FOLD_ONLY_COLUMNS` 显式列出 fold 行比 001/004 DDL 多出的列（`intent.status`、`spec.*` 6 列、`criterion.*`、`decision.rejected_*`、`task.*` 14 列、`attention.*`、`defect.closed_at`、`goal_node.reparented_at`、`review.verified_at`、`stage_run.judged_at`、`redteam.disposed_at`、`design_lock.id`）；实际忽略列与白名单双向相等由 `test/db/write.all-tables.test.ts` 断言，漏/多登记都红。
- append-only 投影（D-039 / M1-7 P1-1/P1-2）：**create 语义的 reducer 走 `createOnce()`**——同 subject 已存在时，业务列相同 ⇒ 幂等 no-op，任一列不同 ⇒（注意：**`at` 不参与 create 一致性比较**，同 id 同业务列但 `at` 不同会静默 no-op） `FoldError: ... already exists with different content; this projection is append-only`。全部 28 个 create kind 由 `src/core/fold/reducers/semantics.ts` 的 `CREATE_SEMANTICS` 列出（`spec.defined`、`contract.defined`、`scope.declared`、`design.locked`、`assumption.recorded`、`restatement.recorded`、`restatement.diff_dispositioned`、`goal.declared`、`goal.integrated`、`task.created`、`report.recorded`、`attention.raised`、`defect.recorded`、`review.recorded`、`review.round_closed`、`redteam.recorded`、`criterion.registered`、`evidence.attached`、`snapshot.taken`、`release.frozen`、`baseline.frozen`/`amended`/`loosened`、`decision.valid`、`intent.signed`、`stage.entered`、`verify.passed`/`verify.failed`）。
  **设计本意的 upsert（后到覆盖）**：状态迁移类（`task.claimed`/`task.assigned`/`task.unassigned`/`task.blocked`/`task.unblocked`/`task.done`/`task.reopened`/`task.dropped`/`task.dependencies_changed`、`spec.revised`、`assumption.disposed`/`invalidated`、`attention.answered`/`withdrawn`、`defect.closed`、`review.finding_verified`、`stage.exited`/`gate.judged`、`decision.signed`/`revoked`/`rejected`、`release.delivered`/`superseded`、`config.changed`）与派生表（`work_unit`、`config`、`snapshot_parent`、`release_item`）——它们的“同 subject 再写”是投影更新，不是覆盖结论。
  清单完整性由 `test/core/fold.semantics.test.ts` 守着：28 个 create kind 的 reducer 函数体必须（直接或经同文件本地 helper）走到 `createOnce(`，且逐 kind 做“同内容重放 no-op / 异内容拒”行为断言；任一把 create 改回 upsert 该测试会红（变异红证已做）。新增 create 语义 reducer 时必须同时更新 `CREATE_SEMANTICS` 并改走 `createOnce`。
- `stage_run`（迁移 004）：`stage.entered` 时 `gate_id`/`baseline_hash` 允许空，`gate.judged` 后必填；迁移重建表时按 002 原文重装 `overview`/`pm_queue` 视图。
- 安全网：`materialize` 在 fold 之后若发现**传入物化面以外**的表有行（测试可用 `materialize(db, {tables})` 收窄），直接 `materialize_failed`，绝不静默丢投影。**物化集 ≠ 对账集**：`VERIFIED_TABLES` 仍只对账 `task`/`spec`/`release`/`decision` 4 张（M2 按 `view_catalog` 补齐）；直插物化集外的表（如 `criterion_fixture`）`verify` 看不见。别把安全网当“全库防篡改”。
- 动作对象条件（M3-1 C8）：`src/db/action-objects.ts` 的 `closeDefect()`（`verify_run.result='pass'` 且 `closed_by=verify_run.actor`）与 `verifyFinding()`（只认对象 `producer`）在动作实现里强制，返回 `object_condition_failed`；`docs/07` §2 这两行 required 为空，故拒因只可能是对象条件。
- 越权直写读数（M3-1 C5）：`verify()` 对 `VERIFIED_TABLES` 另扫 `unauthorized_row`——投影表里有事件日志产不出来的行，只可能是绕过网关直写。边界：链自洽的**直接 INSERT event** 与网关写入无法区分（事件信封无独立签名、actor 自称），M4 签名信封才解。
- 物化是**全量 diff、fold 为权威**：fold 里没有的行会从投影表删掉（`baseline` 例外：append-only 触发器会拒绝删除，属已知边界）。投影表只能由 `append` 产生；手工改行会在下一次 `append` 被覆盖（篡改由 `verify` 发现）。
- 物化只能表达**批末状态**：中间 fold 态若违反 DDL（典型 `redteam.disposition NOT NULL`、`stage_run.gate_id` 在 004 前），单事件 append 会 `materialize_failed`；这是 M1-7 的已知边界，故 per-kind 证据在 fold 层取证（`test/db/write.supported-kinds.test.ts`），DB 侧证据用整条 world 链一次 append 的“DB 行 == fold 最终态”逐表断言。要做“中途态可物化”需后续投影对齐卡。
- `release.frozen` 的 `frozen_by` 载荷自 M1-7 起是 **JSON 字符串数组**（DDL 存 JSON），不再是单个字符串；fold 只做结构校验（≥2 个 human 名称），不验 human 身份真伪——身份核对留 M3 actor registry（卡 C3 已写明）。
- 测试覆盖：`test/db/write.all-tables.test.ts`（56 kind 世界链、PK、FOLD_ONLY 双向、C7 冲突、release/stage_run 口径）、`write.supported-kinds.test.ts`（每个 supported kind 在 fold 层单独改变目标表 + world 链一次 append 后 DB 与 fold 最终态逐表相等）、`write.safety-net.test.ts`（收窄物化面失败关闭）。

## baseline 冻结网关（M2-1）

`src/db/freeze.ts`：`previewFreeze(db, input, session)` → `confirmFreeze(db, client, {preview_id, payload_hash, declared_direction?}, session)`。preview 落 `src/db/freeze-preview.ts` 的进程内 registry（TTL 10 分钟、最多 64 条），对外只返回 `preview_id` 与展示内容；confirm 只认 `preview_id`，且**服务端重跑 P15 与重算 hash**（P1-1）。

- 不过 P15（或结构校验失败）⇒ **落一条 `baseline.rejected`（ACK，不投影业务表，事件 id 带随机后缀防同毫秒撞）**，返回 P15 的首个 reason code；`baseline` 表 0 行。`baseline_unchanged`/`preview_expired`/`preview_consumed`/`preview_mismatch` 是幂等/状态错误，不产生 rejected 事件（P2-1）。
- 通过 ⇒ `signDecision(kind='baseline')` 真签；签成功后**紧邻** append `baseline.frozen`/`baseline.amended`/`baseline.loosened` 建新行（`prev`=旧 head，旧行永不改写）。签成功但 append 失败 ⇒ `baseline_append_failed` 带 `decision_id`，**需重新 preview**（不可重放恢复），已签 decision 留作审计。
- 签名为前置条件在写网关有库层兜底：`baseline.frozen|amended|loosened` 必须带 `payload.decision_id`，且 decision 已签、kind='baseline'，其载荷顶层 `baseline` 的 `hash`/`prev`/`direction`/`will_change_hash`/`guarantee_delta` 与事件 payload 逐字段一致；否则 `append` 返回 `invalid_field`（事件层不是唯一入口，C1/C2）。
- 同 hash 已冻结的重放 confirm 幂等返回已有行；`baseline_unchanged` 由 preview 返回（同内容不再签）。`verify()` 已接 baseline 引用对账（P1-2）；手改 baseline hash 会让 `verify()` 红（`baseline_hash_mismatch`）。
- **可疑操作审计（P2-1）**：`preview_mismatch`（registry 的 raw/preview 在 confirm 间被改）落一条 `security.alert`（载荷 `{kind:'preview_mismatch', preview_id, expected_hash, actual_hash, at}`）；已消费 preview 被再次 confirm（重放）落 `security.alert`（`{kind:'preview_replay', preview_id, at}`）；`preview_expired` 只是过期，静默。这三类都**不落** `baseline.rejected`（那是“冻结尝试被 P15/结构校验拒”）。审计事件是 **best-effort**：`securityAlert` 不检查 `append` 的返回值，库异常时该告警可能静默丢失（拒签本身仍然成立、不因告警失败而放行）；要保证“每次可疑操作必有告警”需要 M3 的告警持久化通道，这里只承诺“能落就落”。

## 门禁判定（M2-2）

- `judgeStage(db, {stage_run_id, baseline_hash?, release_id?, actor})`：
  全量重放 + `src/core/gate` 现算 → 登记一次性授权 → `append(gate.judged)`。
- 判定前校验：baseline 行存在且有 `baseline.frozen|amended|loosened` 事件
  （event payload.hash 相符、decision 已签）；否则 `baseline_not_frozen`。
- 传 `release_id` 时 release.baseline_hash 必须同版，否则 `baseline_mismatch`。
- `gate.judged` 只能由该流程写：裸 `append()` ⇒ `unauthorized_gate_judgement`
  （授权是进程内注册表，重启失效，D-080：判定重启后重算即可，属已知边界而非能力缺失）。
  mint 不导出、**没有测试缝**：测试需要判定行走 `judgeStage()` 真路径（第 2 轮评审）。
- 写路径对 `gate.judged` 做运行时 schema 校验（verdict ∈ pass/changes_requested/na、
  每条 reading 的 `criterion_id/verdict/reason_code` 必填、`na` 必须
  `reason_code='not_enforced_in_m2'`、未知字段拒），校验失败 ⇒ `invalid_field`；
  之后一次性消费 `(eventId, payload_hash, stage_run_id)` 能力，未登记 ⇒
  `unauthorized_gate_judgement`。
- fold 语义对账：`gate.judged.baseline_hash` 必须等于 `stage_run` 行记下的进入版本，
  否则 fold 抛错 ⇒ 该批 `materialize_failed`（消息含 `entry version`）；
  多 gate 时 `judgeStage()` 直接返回 `multiple_gates_unsupported`（不写事件）。
- `at` 必须 `entered_at ≤ at ≤ 注入时钟`，越界 ⇒ `invalid_field`。
- C10 码：`baseline_not_frozen` / `baseline_mismatch` / `core_not_effective` /
  `gate_empty` / `unauthorized_gate_judgement`；不实现 `judgement_mismatch`
  （判定读数由门禁现算，无外部读数可比）。
- 重判写**新** `gate.judged` 事件，`stage_run` 行随之更新；旧事件不改。

## 假设处置链（M2-3）

- `previewAssumptionSet(db)`：给**人**渲染 open 假设清单（含 inputs 边与 `content_hash`）与待签载荷骨架（`spec_ids` 当前 open 集合、`dispositions` 留空、`readings_hash` 由清单摘要现算）；不写事件。
- `disposeAssumptionSet(db, {decision_id, actor, …})`：只认**已签名**的 `decision(kind='assumption_set')`；按签名载荷的 `spec_ids[]`/`dispositions[]` 逐条校验（spec 是 assumption 且 `open`、签名覆盖该条、处置与签名一致），一次 `append` 落全部 `assumption.disposed`（同批 prev 顺序链接）。任一不满足 ⇒ **0 事件**（C7）。
- 拒绝码：`decision_not_signed`（decision 不存在/未签）、`not_covered_by_decision`（kind 不是 assumption_set 或 `spec_ids` 未覆盖）、`disposition_mismatch`（载荷 dispositions 结构非法/为空，或与事件不一致）、`cascade_conflict`（decision 已撤销/失效，或该假设已不在 `open`）、`invalid_request`（参数/事件链折叠失败）、`write_failed`（append 返回底层错误）。
- 事件 payload 只有 `decision_id`/`disposition`/可选 `successor_ref`；**不回填覆盖名单**（`covered_spec_ids`）：覆盖只认签名载荷（C2）。
- 撤销级联（C6）：`decision.revoked` 命中 `assumption_set` 时，`src/core/assumption/cascade.ts` 把该 decision 投影出的非 open 假设行回 `open`（清 `decision_id`/`successor_ref`/`disposed_at`，标 `invalidated_reason='decision revoked'`）。级联是 **fold 派生**、不新增事件 kind、不落额外迁移（撤销事件本身即审计，`verify` 重放可复算）；`spec` 行的 `decision_id`/`invalidated_*` 是 fold-only 列（不落 DB，见 DDL）。
- `spec_set` 侧的“覆盖需求集合失效、必须重签”在本卡以**判定面**表达：撤销后假设回 `open` ⇒ `assumption_set.signed`（及其所在 gate 的 core 三条）转红 ⇒ 重新签处置后才转绿；不存失效列（M2-3 无对应 DDL，D-078）。
- `verify()` 新增双向对账：有效已签 `assumption_set` 的每条 `dispositions[]` 必须有对应 `assumption.disposed` 事件（缺 ⇒ `assumption_disposition_missing`）；每条非 open 假设行必须由有效已签 decision 的 `spec_ids/dispositions` 与 disposed 事件共同支撑（否则 `assumption_decision_invalid`）。
- 失效 fold：假设 `inputs[]` 任一目标行 hash 变**或目标行消失** ⇒ 该假设回 `open`（`status` 是投影列，DB 落 `open`），幂等键 `(edge.kind,spec_id,input_id,旧 hash)`；恢复旧 hash 不自动复活（需新签）。
- **`assumption.invalidated` 不可写**（D-078）：它是派生读数、不是状态迁移事件。写网关在信封校验里前置拒（`assumption_invalidated_is_derived`、0 行），reducer 同样显式拒；kind 保留登记仅为兼容 003 种子，v2.1 删。因此 confirmed 之后不存在“无签名事件把状态改回 open”的路径——C4 的唯一迁移生产者是真的。
- **升级注意（D-081）**：M2 之前的库若写过 `assumption.invalidated`（003 曾登记该 kind），升级后 `verify` 会逐事件报 `legacy_assumption_invalidated`（objectId=事件 id，detail 说明“该 kind 已降为派生读数，请重建库或等 v2.1 清洗迁移”），该库判定为**不可信**；写网关与 fold 也不会再接受该 kind。这是“保持 fail-closed 但可读可行动”的升级口径，不是兼容写入。
- **`decision.rejected` 只对未签决策合法**：已 `valid`+`signed` 的决策再 rejected 会被 fold 拒（`decision_already_signed`），否则其投影的处置会被卡死（verify 红 `assumption_decision_invalid`、revoke/re-dispose 都拒）。撤销已签决策一律走 `decision.revoked`（带签字、级联回 open）。

## 身份层 actor/scope/right（M3-0）

- 迁移 008 建三张表（**不属 fold 投影**，不进 `TABLE_NAMES` / `SUPPORTED_KINDS`）：
  - `actor(id, kind ∈ human/agent/service, display, at)`：谁。`kind` 由会话凭据决定（`src/core/auth/session.ts`），**payload 里出现 `actor` 一律 `actor_not_from_session`**（收口 D-056）。
  - `scope(actor, scope, right, granted_by, at, revoked_at)`：membership + grant 合一。撤销只写 `revoked_at`、不物理删行（right 只增不减，M3-5 消费）；`PRIMARY KEY(actor, scope, right)` 保证幂等；`CHECK` 双保险拒绝 `*` 与未知前缀。
  - `right(action, required, self_sign, dual_human, boot_only, doc_row, doc_label, at)`：**决策权矩阵目录**，数据行由迁移 008 从 `docs/07` §2 播种（21 行 → 26 个动作）；`action`/`scope`/`right` 都有 CHECK 拒绝 `*`，`required` 另有 `CHECK (instr(required, '*') = 0)`（与 `migrations/008_identity.sql:42` 逐字一致；DB 纵深防御，直插负例见 `test/db/auth.test.ts`）。
- `src/db/auth.ts`：`enrollActor` / `grantRight` / `readMatrix` / `readGrants` / `hasRight` / `authorizeWrite`。写路径组合入口 `authorizeWrite(db, session, payload, action, scope)`：先拒 payload 自称 actor，再判权；**产品代码不得自己比较 right 字符串**（`test/db/auth.test.ts` 静态扫描 C4）。
- **身份层自己的写路径也要授权**：`enrollActor`/`grantRight` 的调用者必须持未撤销的 `admin@domain:*`（`{by: {id,kind}}`）；工具层**没有** bootstrap 参数可传。第一个 admin 只能由 `src/db/auth-bootstrap.ts` 的 `bootstrapEnrollActor`/`bootstrapGrantRight` 在迁移/CLI 初始化时写入——该文件不是工具层 API，禁止从 query/PM/sign 或任何事件写路径 import；迁移 008 用 SQL 播种，不依赖它。无 admin 的调用者 ⇒ `no_permission` 且 0 行。
- **接线边界**：本卡只提供判定入口与三张表；把 `hasRight`/`authorizeWrite` 接到 query 写路径、`src/db/write.ts`（仍直接收 `event.actor`）与 PM `src/core/pm/act.ts` 是 **M3-1** 的写域。
- **“权”与“对象条件”分层（M3-0 第 4 轮裁定）**：`hasRight` 只判权。`defect.close` 要求“`verify_run` 通过之后才能写”、`verify_finding` 要求“只认对象 `producer` 本人”——这些是动作级对象条件，与权正交，矩阵不表达（`right.required` 只有权列表、没有对象条件列）。它们由 M3-1 的动作实现强制；**`hasRight` 对这两个动作返回允许 ≠ 允许写**，调用点不得只看 `hasRight` 就放行。
- **调用方上下文是自证**：`AuthActorContext.by` 在 M3-0 没有任何凭据校验（可伪造 admin 上下文）；M3-1 必须从会话固定 actor，不接受模型/工具自报。
- `src/core/auth/rights.ts` 的 `hasRight(actor, action, scope, ctx)` 是唯一判定入口：fail-closed（未登记动作 / 未知前缀 / 无覆盖 grant ⇒ `no_permission`，带 `action/scope/actor_kind/missing_right`）；通配（`*`、空值、非法 scope 形状）⇒ `invalid_field`。
- scope 覆盖：`module:src/db` 覆盖 `module:src/db/x.ts`（`/` 边界前缀，不做层级树）；**跨前缀一律拒**（D-086）：目标 scope 前缀必须等于 required scope 前缀，不等 ⇒ `no_permission` 且返回体带 `reason:'cross_prefix_denied'`——本卡不猜 module↔domain 归属，M3-1 引入 membership 解析后再放开。
- 解析器边界（D-087）：`docs/07` §2 授权格里**括号只当注释**（`dependencies` 的「（不是 `write@module`——依赖是计划，不是代码）」不参与解析）；带 `@scope` 的未知权名、或裸权名漏 `@scope` ⇒ `unknown_right_in_matrix` 解析失败（fail-closed，不静默丢权）；其余反引号 token 视为正文引用。
- 空授权格只允许**显式白名单**（`EMPTY_REQUIRED_ACTIONS`：`defect.close` docs/07:50、`verify_finding` docs/07:52、`config.bootstrap` docs/07:48）；白名单之外的授权格解析为空（含“不是 x 而是 y”被截断、整格 `—`）⇒ `unknown_right_in_matrix`，不许静默变成“谁都能做”。
- 矩阵目录与 `docs/07` §2 的漂移由 `test/db/auth.test.ts` 双向机器比对抓：文档多/少一行 ⇒ 解析器抛错（C2 变异红证）；DB 目录被删一行 ⇒ 比对红（变异红证）。

## 冲突可见（M3-2）

- **强制声明**：强制声明的是内容编辑类 kind（当前 `spec.revised[clause]`、`criterion.revised[remedy]`）；豁免的是生命周期迁移与单写者产生的事件（`task.*` 的状态迁移、`config.changed`、`goal.reparented`、`restatement.diff_dispositioned` 等），它们不并发覆盖同一字段。。清单与逐条理由见
  `src/core/conflict/scope.ts` 的 `CONFLICT_TRACKED_FIELDS`；缺声明 ⇒ `conflict_scope_undeclared`
  （0 行落库）。`field` 必须是该 kind 的受管字段，否则 `invalid_field`。其余固定 payload schema 或
  一次性能力/签名路径产生的事件无法携带 CAS，伪造由能力/签名兜底（卡 M3-2 A3）。
- **威胁模型边界（Lead m08832 / m10752 裁定）**：mint 不是自由导出函数——`src/db/conflict-authority.ts`
  只导出工厂与 `consume`，registry 实例私有在 `src/db/conflict.ts`，真 CAS 路径经 `CONFLICT_AUTHORITY.mint`
  持有；`src/` 内除该内部调用外不出现 mint 引用。它只保证**产品代码路径**不得伪造
  `conflict.detected`；能 import 内部模块或直接写 SQLite 的代码已在威胁模型外（与 M2-2
  `gate.judged` 同口径）。M4 若要把威胁模型收紧到内部模块，须把 registry 下沉进 `src/db/write.ts` 私有。

- **`decision.valid.payload.producer`（M3-1 P3-3，D-112）**：非空字符串；若 producer 已在 `actor`
  表登记，kind 必须是 `agent`（human/service 冒充 ⇒ `invalid_field`、0 行）；未登记则放行（软校验，
  夹具/读数用未登记名）。producer 是审计归属，**不参与授权**；M4 签名信封落地后改硬校验。
- `base_hash` 比的是**该字段当前值的 hash**（`valueHash` = 规范化 JSON 的 sha256，见
  `src/core/conflict/hash.ts`），不是整行 hash。不同字段并发改互不冲突。
- **无自豁免**：判定只看声明的 base 与当前值是否一致，与 actor 无关；同 actor 用 stale base
  写也冲突（想覆盖就带当前 base）。winner = 链上该 subject 的上一写者，loser = 本次事件 actor，
  均从事件行取，不读 payload 自称。
- 冲突路径**已提交**：原事件不落，改落 `conflict.detected`（一次性能力 mint 于检测器，
  `src/db/conflict-authority.ts`；手工 append 该 kind ⇒ `unauthorized_conflict_detected`）；
  `append()` 返回 `{ok:false, reason_code:'conflict', conflict_id, base_hash, current_hash,
  rolled_back:false, written}`。调用方必须按 **409 语义**处理（不是“没写”），原意图留在
  `conflicts` 视图里等人裁决。
- 同批多事件：CAS 按 fold 逐条推进（前一条的 patch 对后一条可见），批内第二条 stale 同样冲突。
- `conflict` 表 + `conflicts` 视图（`migrations/009_conflict.sql`）；行由 fold 投影，`verify()`
  对账 **5 张表** `task/spec/release/decision/conflict`。直改 `conflict` 表报
  `runtime_inconsistent/conflict`；直改 `conflicts` 视图不报（视图无状态，SQLite 拒绝写视图）。
- `resolveConflict(db, client, {conflict_id, payload_hash, side, note?}, session)`：只允许 human
  会话，走 `signDecision(decision_kind='sign', extra.conflict_resolution = {conflict_id,
  adopted_actor, note})`（D-089：M3 用通用 `sign`，v2.1 若要独立 kind 再改枚举），成功后
  append `conflict.resolved`；无有效签名 ⇒ 冲突保持 `open`。
- `conflicts` 视图暂未注册 `view_catalog`（`sdo_query` 只执行 catalog 内 SQL）——
  **M3-4 收口项**，届时同步 13→14 视图断言。
- 不做自动合并；冲突**不产生** `dispute.*` 事件。

## 独立性（M3-3，`docs/07` §7）

- `decision.signed` 可多条（`dual_human` 载体，D-092）：第二条起 `payload_hash` 必须等于
  decision 行（`payload_mismatch`），同 actor 同 payload 重放幂等 no-op，投影行保持首签。
- 独立性等级只从 baseline 的 `assurance.independence` 解析（`dual_human` /
  `solo_cooldown(Nm)` / `solo`，D-094：不是 `policy`）；缺失/非法 ⇒ 判定拒，不默认 15m。
  门禁 `judgeStage` 在 baseline 独立性不满足时强制 `changes_requested`，`reasons` 只放码
  （`independence_unsatisfied` / `cooldown_active` / `independence_missing` / `assurance_invalid`）。
- `verify()` 用同一套判定复算（`src/core/independence/verify.ts`）：同一 decision 的签名
  `payload_hash` 与行不符 ⇒ `independence_unverifiable`；删一条签名/改 signer 使不同 signer
  不足 ⇒ `independence_unsatisfied`。策略缺失/非法归门禁 fail-closed，不在 `verify` 里把
  M3-3 之前的旧 baseline 全判红。
- 新拒绝码：`payload_mismatch`、`independence_unsatisfied`、`cooldown_active`、
  `cooldown_not_applicable`（`AppendReason` + `errors.ts` 闭集）。
- 边界（D-093）：actor 级声明，不防一人两账号；多钥留 M4。

### 独立性判定（M3-3，第 1 轮评审补充）

- 门禁（`judgeStage`）与 `verify` 都按**被判定对象绑定的 baseline 版本**取 `assurance`：
  `stage_run.baseline_hash` / 冻结 decision 签名载荷的 `payload.baseline.hash`；
  不是链头。旧库缺行时显式报 `independence_baseline_unbound`，不静默退化。
- 门禁 fail-closed 的四码：`independence_unsatisfied` / `cooldown_active` /
  `independence_missing` / `assurance_invalid`；缺/非法 assurance 一律 `changes_requested`，
  `verify` 只复算“签名证据”，不替代门禁的策略判定。
- `verify` 额外要求签名者可解析到 `actor.kind='human'`（未知/非 human ⇒ `independence_unverifiable`）。
- 多签是 `dual_human` 的唯一载体（D-092）；写网关仍逐条验证 signerd 回执。
- **回执一次性（第 2 轮 P1-2）**：迁移 012 的 `signerd_receipt_use(receipt_id PRIMARY KEY, event_id, decision_id, at)`
  在 append 事务内占位；同一 receipt 第二次写入 ⇒ `signerd_receipt_replayed`（整批回滚）。
- **签名时间三方一致（第 2 轮 P1-1）**：`event.at === receipt.at === payload.signerd.at`，
  不一致 ⇒ `signature_time_mismatch`；`signerd_receipt_use` + 该比对一起封死改 at 重放。

### 渲染器目录的投影哨兵与威胁模型（M3-4，第 2 轮评审补充）

- `renderer_catalog` 是**投影表**：行只由 `renderer.registered` 事件在 append 事务内 `materialize`
  投影（`applyRendererRegistrations`）；窗口外（含裸连接直插/直改/直删）由 011 的
  `projection_guard` 哨兵 + 三触发器 ABORT。
- 哨兵窗口（置位 → 写入 → 复位）整体包在事务里，`active` 复位在 `finally`；进程崩在窗口内则
  事务回滚，不会永久停在 1。
- **边界**：哨兵阻断的是“未在 append 事务窗口内的直写”，**不是**防同 uid 的恶意进程——
  能执行任意 SQL 的进程可以把哨兵置 1 再直插，这已在威胁模型外（与 M2-0 同 uid 威胁模型一致）。
  同理，`src/db/renderer-authority.ts` 的 `mint*` 是 `@internal`：产品路径不当入口调用；
  能 import 内部模块的代码同样在威胁模型外。

## 工作副本与内嵌 VCS（M4-0）

- **模块**：`src/core/workcopy/{paths,crlf,tree,main-tree}.ts`（纯函数：路径/越界/CRLF/对象与树 diff/主树重写）＋ `src/db/{vcs,workcopy}.ts`（isomorphic-git 封装与生命周期）＋ `src/db/workcopy-{authority,tool}.ts`（一次性能力与工具事件）。产品代码不执行系统 `git` CLI，也不执行 hooks。
- **目录**：`.work/<card>/`（卡工作目录）、`.sdo/vcs-cards/<card>.git/`（卡 gitdir，**每卡独立 index/HEAD**）、`.sdo/vcs-objects/`（共享 bare 对象库）。三者都被 `.gitignore` 覆盖。
- **与设计的偏离（D-126）**：isomorphic-git v1.44 不读 `objects/info/alternates`。实现改为卡 gitdir 的 `objects` **symlink** 指向 `<root>/.sdo/vcs-objects/objects`（只读回退 + 写后 `spillObjects` 进共享库）；alternates 文件仍写一份指向共享库的自描述。效果等价于“共享对象库、卡 gitdir 不复制对象”，但机制不是原设计的 alternates 文件。Windows 走 `junction`（不需开发者模式）；创建失败抛 `VcsLinkUnsupportedError` → API 返回 `vcs_link_unsupported`，不静默降级成复制。
- **工具专用事件（D-122）**：`workcopy.created`、`workcopy.removed`、`snapshot.taken` 只能由工具路径产生——`src/db/workcopy-capability.ts` 的工厂实例私有 `mint(payloadHash)`（P3-10：能力注册表下沉，`write.ts` 与 `workcopy-tool.ts` 都只 import 它，避免循环依赖），`src/db/workcopy.ts` 在构造事件后立刻 mint，`append` 的 `authorizeEvent` 在“其余 ACK 只做会话绑定”分支之前校验能力并把 `payload_hash` 绑定进去；失败 `unauthorized_workcopy_event`。通过后**跳过矩阵动作**（否则工具会话还得拿 `plan@domain`），但 `KIND_ACTIONS` 里 `snapshot.taken` 的 `create@domain` 映射保留——网关短路不等于矩阵行消失。裸 append 三种 kind 各一条负例见 `test/db/workcopy.edge.test.ts`。
- **生命周期**：`createWorkcopy`（共享库→卡 gitdir→按基线检出→`workcopy.created`）、`commitWorkcopy`（文本归一 LF→卡 gitdir 提交，parent=基线）、`admitWorkcopy`（合并→判主树脏→三路合并→重写主树→`snapshot.taken`+`workcopy.removed`→删副本）、`removeWorkcopy`（status 不干净 ⇒ `dirty_workcopy` 且保留证据）。返回 `timings.total_ms`，> 2 s 时 `warnSlow` 打一行告警（不静默拖死）。
- **主树重检出（D-120）**：`rewriteMainTree` 是 SDO 自实现的原子树重写（逐文件 blob hash 判脏 → 目标树为权威含删除 → 临时文件+rename → 不碰 `.git/`、`.sdo/`、`.work/`），**不是 `git checkout`**；v2.1 若要 checkout 语义再评估独立 main gitdir。
- **对象库交叉校验（D-121/D-123）**：`verify()` 对每个 `snapshot.git_oid` 沿 commit→tree→子树→blob **递归**读共享对象库、解 zlib、重算 sha1；缺 ⇒ `vcs_object_missing`，内容/类型/长度不符 ⇒ `vcs_object_hash_mismatch`。有 snapshot 行却定位不到 `<工作区根>/.sdo/vcs-objects/objects`（从 DB 路径向上找）⇒ `vcs_objects_dir_unresolved`；超过 20000 个对象或深度 64 ⇒ `vcs_object_graph_too_large`（均不静默通过）。只读不修，不改 `VERIFIED_TABLES` 语义。边界：只核对 snapshot 引用到的对象图，不遍历孤立对象（GC 归 M4-1+）。
- **阻塞码**：`merge_conflict`（三路冲突，交人）、`dirty_workcopy`（副本未回收干净）由 D-124 裁定扩进 `BLOCK_CODES`；v2.1 人签补 `docs/03` §4 枚举。`workcopy_busy` 是**瞬时 API 失败**（同卡被锁），只返回码、不落事件、不落 block，调用方自行重试。

## 路径前缀锁（M4-1）

- **模块**：`src/core/lock/{prefix,ttl,reducer}.ts`（规范化/按段相交、TTL、fold 投影）＋ `src/db/lock.ts`（DB 层互斥 + 事件）。`lock` 表由迁移 016 建立，`TABLE_NAMES`/`PREFIX_TABLE`/`KIND_ACTIONS` 均已登记；`lock.acquired`/`lock.released`/`lease.revoked` 不再是 ACK，而是有投影的 reducer（`ack.ts` 已移除）。
- **互斥权威在 fold（C1/P1-1，D-030）**：`lock` 行只由 `append` 物化，`acquireLock` **不直接 INSERT**。相交判定在 `lock.acquired` reducer 里做：append 事务中 fold 失败 ⇒ 事件与行走同一事务回滚，不存在“行在、事件不在”的孤儿活锁。`acquireLock` 在 append 前做一次**只读预扫**，仅用于给调用方友好 409；两个独立进程并发时，后者的 fold 会看到前者已提交的行并拒绝，映射为 `lock_conflict {prefix, holder, holder_card, since}`。`ux_lock_active_prefix(path_prefix) WHERE status='active'` 保留为第二道闸。
- **前缀（C2/C6）**：`normalizePrefix` 做过 `\`→`/`、`.` 段、重复/尾斜杠、大小写折叠，拒绝绝对路径/drive letter/NUL/`..` 逃逸/超 1024 字符，非法 ⇒ `invalid_field`（0 行）。`prefixesOverlap` 按路径段判交，`src/core` 与 `src/core2`/`src/co` 不相交；根前缀 `.` 规范化为 `''`，与任何前缀相交（C7 的整树锁）。
- **生命周期与释放权限（C4/P1-2）**：`lock.acquired` 建 active 行；`lock.released` 把行改成 released（保留证据，后续可重认领），**只有持有者本人可释放**（`releaseLock` 先校验 `row.actor===session.actor`，否则 `no_permission`；reducer 也做同一条守卫，事件流自己也会拒）。`lease.revoked` 把该卡的 active 行标 `released_by='lease_revoked'` 但**状态仍 active**——同一 actor 可重认领，其他 actor 仍冲突。
- **幂等只认同卡（M4-1 第 2 轮 P2）**：`heldConflict` 放行“同前缀、同 actor、同 `card_id`”的重放；同 actor 换卡认领算覆盖，fold 直接拒（`lock_conflict`），不再是静默改 `card_id`。API 预扫与 fold 口径一致。
- **卡收尾释放（P1-2 / 第 3 轮 P2+P3）**：`releaseCardLocksAsTool(db,{card_id,at})` 不再接收调用方 session——函数内部构造工具身份（`actor='sdo-workcopy'`、`actor_kind='service'`），每次释放事件由 `lock.ts` 私有实例 mint 一次性能力、网关消费（绑 `payload_hash`）；网关对带 `initiator='sdo-workcopy'` 的 `lock.released` 跳过“事件 actor=会话 actor”绑定，reducer 对同一标记跳过“仅持有者本人可释放”守卫（业务路径两条守卫不变）。返回值 `{ok,released,failures[]}`：逐条失败不吞，`workcopy.ts` 把它上报为结构化 `append_failed`，不静默留锁。业务层既拿不到 mint，也没有传 service 身份的口子（第 2 轮 P3-2 的工厂只导出类型/构造，实例在 `lock.ts` 私有）。M4-2 接工具层时沿用这条能力路径（D-148/D-149）。
- **根锁只走工具能力（P2-5）**：`acquireLock` 拒绝根前缀（业务调用会拿到 `no_permission`）。主树锁只能由 `admitWorkcopy` 调 `acquireMainTreeLock`（payload `initiator='sdo-workcopy'`）。**网关按事件流兜底（第 2 轮 P1）**：`lock.acquired` 且 subject 为根（`''`/`.`）时，`write.ts` 必须消费 `lock.ts` 的一次性能力（绑 `payload_hash`，`acquireMainTreeLock` 内 mint），否则 `unauthorized_root_lock`；reducer 另要求根锁 payload 带 `initiator='sdo-workcopy'`，事件流自证、不只靠网关。业务矩阵不参与根锁。scope 按前缀首段推导：非根 ⇒ `module:<首段>`；根 ⇒ `domain:core`。主树锁在 merge **之前**取得（C7/D-135），冲突 ⇒ `lock_conflict`、不写主树、不落 snapshot；成功路径由卡收尾释放覆盖，失败路径 `finally` 用 `releaseMainTreeLock` 释放，避免重复释放。
- **TTL（A3）**：仓库当前没有 lease 表（M4-2 才建），`LOCK_TTL_MS=2h`（`docs/07` §13 默认）与 `LOCK_GRACE_MS=10min` 作为 `lock_leaked` 阈值，记台账 explain；M4-2 落地 lease TTL 后改为复用。
- **verify（C5）**：`verifyLocks` 只在库内出现过锁事件时启用（旧库不追溯）。`lock_missing`：该卡**历史上申请过锁**、现在 `in_progress` 却没有 active 锁（从未申请过锁的卡不进检查——申请/释放接线在 M4-2 的 `claim`/收尾）。`lock_leaked`：任何 active 锁超过 `expires_at + LOCK_GRACE_MS` 即报（不要求卡已不在飞；不自动回收，过期锁由人/控制台显式释放，入口留到 M4-5/M5）。只读不修；异常归 `projection_check_failed`。


**根锁的三道闸（M4-1 第 5 轮 P2，D-157）**：`acquireMainTreeLock` 先用纯函数 `rootLockPrecheck` 判同 actor+同 card 放行（第一道，单测锁定）；事件流上 `lock.acquired` reducer 的 `heldConflict` 再判一次（fold 失败即整批回滚）；`migrations/016_lock.sql` 的 `ux_lock_active_prefix` 是 DB 行级第二道闸。只改一处不得宣称规则已生效。

**准入重试的幂等边界（M4-1 第 5 轮 P3，D-154）**：`admitWorkcopy` 若在 `snapshot.taken`/`workcopy.removed` 已落库、仅卡锁释放失败时返回 `append_failed`（副本保留）。重试同一 admit（同 `card` + 同 `base_snapshot_id`，副本目录仍在）会复用事件链里**唯一**的“该 base 下有 snapshot + removed”的完整准入：`completedAdmission()` 先查，命中则释放锁、删副本、返回 `{ok:true}`（事件不重复），不再 append 第二份 snapshot/removed。该路径**按 card 过滤**（`snapshot.taken` 的 `payload.card` + `workcopy.removed` 的 subject）；同一 base 下出现多条**本卡**完整准入（歧义）⇒ 直接返回 `{ok:false, reason_code:'admission_ambiguous'}`、不写任何事件、保留副本交人处理，**不按正常流程试跑**（D-156）。`FailureResult.reason_code` 是闭集 `WorkcopyFailureReason`（定义在 `src/core/workcopy/types.ts`），append 的细码不透传、统一归一为 `append_failed`（D-157）。**卡锁逐前缀释放失败**是例外：`reason_code:'lock_release_failed'`，逐条 `{prefix,reason_code,message}` 放 `details`，`message` 保留原文，不单取第一条（D-158）。

## 派发租约与预占/收回（M4-2）

- **模块**：`src/core/lease/{types,reducer,claim-guard,index}.ts`（TTL/投影/认领守卫）＋ `src/db/lease.ts`（真派发/过期/收回 API + 工具能力）＋ `src/core/verify-lease.ts`。迁移 `migrations/017_lease.sql` 建 `lease` 表：`id/card_id/actor/scope/frontier/ttl_s/issued_at/expires_at/status(active|expired|revoked)/revoked_at/revoked_by/expired_at`；`ux_lease_active_card(card_id) WHERE status='active'` 是第二道闸（一卡一活租约）。`lease.issued`/`lease.expired` 已从 ACK 迁为真 reducer；`lease.revoked` 的租约行处理与 D-150 actor 校验也归 lease reducer（D-164），`src/core/lock/reducer.ts` 只保留锁行标记。
- **唯一入口（C1）**：租约只能由 `dispatchLease(db, session, {card, actor, scope, ttl_s?, at})` 落：先 `hasRight(assign, scope)`（矩阵动作 `dispatch`，权名 `assign`），再构 `lease.issued`（payload `{card,actor,scope,frontier,ttl_s,expires_at,initiator:'sdo-lease'}`），由 `lease.ts` 私有实例 mint 一次性能力、`appendAsTool` 写入。裸 `append` 的 `lease.issued`（无标记/无能力）⇒ `unauthorized_lease_issue`、0 行；`lease.expired` 同理。
- **认领必须持活租约（C2，D-159 改口径为恒开）**：`src/db/write.ts` 对每个 `task.claimed` 调 `claimGuard(state, card, actor, at)`：`task.reserved_by/reserved_until` 在预占期内且非本人 ⇒ `not_reserved_actor`；否则必须存在同卡、同 actor、`issued_at <= at < expires_at` 的 active 租约，缺 ⇒ `no_lease`；有 expired 或 active 但已过期 ⇒ `lease_expired`。全部 0 事件。闸**无条件**（空库首条 claim 也拒），没有测试侧豁免；历史夹具按 A 方案改造（D-162/D-167）。
- **预占 ≠ 授权（C3/C6）**：`task.assigned` 只写 `reserved_by/reserved_until`，不改 task.status；`task.unassigned` 清预占。预占期内他人 claim 被 `claimGuard` 拒；预占本身不产生写权（无 lease 仍 `no_lease`）。
- **收回与过期（C4/C5，D-163）**：`revokeLease`/`expireLease` 都读 lease 行（必须 active）并走工具能力；`expireLease` 要求 `at >= expires_at` 否则 `lease_not_expired`，且都要求调用者对 `lease.scope` 有 `assign` 权。收回/过期在同一 `appendAsTool` 批里追加 `task.blocked(lease_revoked|lease_expired)` + `task.unblocked`，卡回 ready，**不删 `.work/<card>`**（M4-0 生命周期无关）。payload 记 `revoked_by/expired_by`，reducer 校验其等于事件 actor（防事件流伪造）。**撤租约的授权与 scope 完全同源（M4-2 第 2 轮 P1，D-174）**：`lease.revoked` 的动作映射为 `assign`，scope 唯一取自租约行 `lease.scope`（`kind-actions.ts` 的 `lease` 类别读 fold 态；payload 带 `scope` 时必须等于行 scope，否则 `invalid_field`）；租约不存在或非 active ⇒ `lease_not_active`。直 append 与 API `revokeLease` 走同一条规则，`lock.ts` 不再提供 `revokeLeaseLocks`（旧的“无租约行也能标锁”路径已删，D-175）。
- **时区（D-165）**：`claim-guard`/`verify-lease` 一律 `Date.parse` 比较绝对时刻，不直接比 ISO 字符串；带 `-05:00` 等偏移的事件同样正确。
- **verify（C7）**：`verifyLeases` 有 lease 事件即启用（旧库不追溯）：busy 卡无未过期活租约 ⇒ `lease_missing`；活租约 actor ≠ 最近 claim actor ⇒ `lease_actor_mismatch`；同卡多活租约 ⇒ `lease_multiple_active`。`reservation_mismatch` 已删（D-166；C3 网关阻断使其不可达）。只读不修。
- **TTL**：默认 `DEFAULT_LEASE_TTL_S = 4h`（S30 第 3 条；与锁的 2h 不是一个旋钮，D-136）；`config` 覆盖留后续卡。

## 公共面单写者（M4-3）

- **登记是数据（C1/D-178）**：`migrations/018_public_face.sql` 建 `public_face(prefix PK, note, since)` 并播种 6 条初始范围（视图目录种子 `002`/`011`、event_kind 登记面 `003`、`004`、`src/core/criteria/`、`src/core/fold/reducers/verify.ts`）。`public_face` **不是 fold 表**（不进 `TABLE_NAMES`）：登记内容只能由迁移写，产品代码不得 `INSERT`；`readPublicFace(db)` 只读。新增范围 = 新迁移。
- **准入相交检查（C2/D-182/D-183）**：写域唯一来源是 `task.scope_paths`（`task` 行不存在 ⇒ `task_not_found`；空/非法 ⇒ `scope_undeclared`），请求结构里已没有 `scope_paths` 参数。唯一落点是 `admitWorkcopy` 在**拿锁/写主树之前**：`publicFaceHits(task.scope_paths, readPublicFace(db))`，相交定义是**段级双向包含**（写域比公共面宽或窄都算相交，`a/b` 与 `a/bc` 不算）；命中 ⇒ `{ok:false,reason_code:'public_face_readonly',hits}`，主树一字节不写。`isSubset` 之后还会对实际 `changes` 再做一次同样的检查（第二道闸，纵深防御）。`createWorkcopy` 不拦（准入是写主树的唯一口，D-181），但同样读 task 行。
- **申请（C3）**：`requestPublicFace(db, session, {card,intent,diff,at})`：task 必须存在；权限复用矩阵既有动作 `claim`（即 `write@module` 行，矩阵没有名为 `write` 的动作，D-179），scope 由 task 写域推导（`module:<首段>`，缺省 `module:core`）。幂等键 `(card, intent_hash)`，`intent_hash = sha256(canonicalJson(intent))` 由函数内部算、不接受调用方传；重复申请返回 `{ok:true, idempotent:true, event_id}`（同一条事件 id），**不新增事件**。
- **单写者（C4/D-180/D-184）**：`public_face_writer(id INTEGER PK CHECK(id=1), actor, held_since, note)` 是 fold 表、物理上也只能一行（固定主键 + `public_face_writer_single` 触发器拦新增；交棒是同一 PK 的 UPDATE，不受触发器影响）；`publicface.writer_changed` 是真 reducer（`src/core/publicface/writer.ts`）：首次必须 `from:null`，之后 `from` 必须等于当前 actor、`to` 不得等于当前、`at` 不得早于 `held_since`——三条都有 fold 级负例。初始指派走 `bootstrapPublicFaceWriter`（能力路径），迁移不硬插行（否则第一次 append 物化会删掉它）。
- **执行（C4）**：`executePublicFaceChange(db, session, {request_id,at})` 只允许当前持有者；同一 request 重复执行幂等返回原事件（`{ok:true,idempotent:true}`，不再落第二条）。`publicface.executed` 由 `publicface.ts` 私有实例 mint 一次性能力（绑 `payload_hash`、`initiator='sdo-publicface'`），网关对 `publicface.executed`/`writer_changed` 消费能力并跳过矩阵；裸 append / 非持有者 ⇒ `not_public_face_writer`。单写者交棒 = `transferPublicFaceWriter`（同样走能力事件）。
- **verify（C6）**：`verifyPublicFace` 在 `public_face` 表存在时启用：任何 `task.scope_paths` 命中登记项 ⇒ `public_face_scope_overlap`；`publicface.requested` 无对应 `executed` 且距 `max(event.at)` 超过 **7 天** ⇒ `public_face_request_stale`；`public_face_writer` 投影对账 ⇒ `public_face_writer_missing/extra/mismatch`。只读不修。
- **已知边界**：`publicface.requested` 允许任意源卡发起（低权申请，执行才是闸，D-185）；`public_face` 的只读由 `projection_guard.active` 控制，同库写者可自行打开（与 renderer_catalog 同款边界，D-186）；`public_face` 不是 fold 表，verify 不对账登记内容本身。
- **CAP 能力边界**：`src/db/publicface-capability.ts` 只导出 marker/kinds/哈希/工厂类型；实例与 mint 在 `publicface.ts` 私有，产品代码拿不到；两码（`public_face_readonly`、`not_public_face_writer`）在 `src/db/write-types.ts`/`src/core/workcopy/types.ts` 闭集内。


## 派发告警与读数（M4-7）

- `agent.spawned` / `agent.spawn_streak` 是**能力事件**：`src/db/agent.ts` 写入前 mint 一次性能力（绑 `payload_hash`），`src/db/write.ts` 消费；裸 `append` 一律 `unauthorized_agent_event`、0 事件。其余 `agent.reused` / `agent.pick_declined` 仍为 ACK 审计事件（D-194）。
- `agent.spawned.payload.snapshot` 是调用方提供的**自洽证据**，不是池真源；M4 只校验理由与快照一致，不证明实际池状态（D-200）。
- `gaps`（020 重建）新增两类：`pick_declined_streak`（同 `dispatch_id` 的 declined 条数，>1 才出现）与 `spawn_streak`（连续新起次数，阈值 3）。count 语义：前四类=事件出现次数，`pick_declined_streak`=条数，`spawn_streak`=连续次数（`payload.count`）。等价性由 `test/db/gaps-equivalence.test.ts` 锁住（D-198）。
- 读数：`node scripts/m4-readings.mjs --only R-pick`；默认输出 `plan/milestone/M4-读数.{json,md}`，测试/取证用 `--out <临时前缀>`。
