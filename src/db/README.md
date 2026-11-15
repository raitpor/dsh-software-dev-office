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
- 拒绝码：`unknown_event_kind`/`invalid_field`/`unsupported_scope`/`event_chain_broken`/`event_hash_mismatch`/`append_conflict`（插 `event` 撞库，如同批重复 id）/`transaction_in_progress`（调用方已有未提交事务）/`database_busy`（`BEGIN IMMEDIATE` 撞别的写者，`SQLITE_BUSY`）/`materialize_failed`；M2-3 另有 `assumption_invalidated_is_derived`（派生读数不可写，D-078）与 `signature_not_from_signerd`（M2-0/C8）；拒绝码清单见 `plan/03` D-025（已登记）。失败返回 `written:0/skipped:0/attempted=通过校验条数/rolled_back:true`，`eventCount` 是调用前行数。
- 物化范围（M1-7 开闸，D-031 关闭）：`MATERIALIZED_TABLES = TABLE_NAMES − NON_MATERIALIZED`，覆盖 fold 能产出的全部表（当前 28 张）；`NON_MATERIALIZED` = `event`/`event_kind`/`claim`/`receipt`/`field_consumer`/`scenario`（事件存储、renderer 写、目录数据、设计缺口）。`SUPPORTED_KINDS` 由 `REDUCERS` 动态生成（56 个）；`ACK_KINDS`（无 reducer、无投影，如 `query_miss`）仍 `unsupported_scope`。`decision` 只落 `signature` 非空的行（D-019）：`decision.valid` 单批不落库、`decision.signed` 后才出现；`verify` 用同一口径。
- 键按 **DDL 主键**（`PRAGMA table_info` 的 pk 序号）而不是代理 `id`：`config.key`、`snapshot_parent(snapshot_id,parent_id)`、`release_item(release_id,kind,target)`、`design_lock(spec_id,spec_version_hash)` 等无单 id 表照常 diff/删。`release` 的插入触发器只接受 `draft`/`frozen`：物化最终态时先按 `frozen` 落行，再走允许的状态迁移（delivered/rolled_back）。
- 列对齐：`FOLD_ONLY_COLUMNS` 显式列出 fold 行比 001/004 DDL 多出的列（`intent.status`、`spec.*` 6 列、`criterion.*`、`decision.rejected_*`、`task.*` 14 列、`attention.*`、`defect.closed_at`、`goal_node.reparented_at`、`review.verified_at`、`stage_run.judged_at`、`redteam.disposed_at`、`design_lock.id`）；实际忽略列与白名单双向相等由 `test/db/write.all-tables.test.ts` 断言，漏/多登记都红。
- append-only 投影（D-039 / M1-7 P1-1/P1-2）：**create 语义的 reducer 走 `createOnce()`**——同 subject 已存在时，业务列相同 ⇒ 幂等 no-op，任一列不同 ⇒（注意：**`at` 不参与 create 一致性比较**，同 id 同业务列但 `at` 不同会静默 no-op） `FoldError: ... already exists with different content; this projection is append-only`。全部 28 个 create kind 由 `src/core/fold/reducers/semantics.ts` 的 `CREATE_SEMANTICS` 列出（`spec.defined`、`contract.defined`、`scope.declared`、`design.locked`、`assumption.recorded`、`restatement.recorded`、`restatement.diff_dispositioned`、`goal.declared`、`goal.integrated`、`task.created`、`report.recorded`、`attention.raised`、`defect.recorded`、`review.recorded`、`review.round_closed`、`redteam.recorded`、`criterion.registered`、`evidence.attached`、`snapshot.taken`、`release.frozen`、`baseline.frozen`/`amended`/`loosened`、`decision.valid`、`intent.signed`、`stage.entered`、`verify.passed`/`verify.failed`）。
  **设计本意的 upsert（后到覆盖）**：状态迁移类（`task.claimed`/`task.assigned`/`task.unassigned`/`task.blocked`/`task.unblocked`/`task.done`/`task.reopened`/`task.dropped`/`task.dependencies_changed`、`spec.revised`、`assumption.disposed`/`invalidated`、`attention.answered`/`withdrawn`、`defect.closed`、`review.finding_verified`、`stage.exited`/`gate.judged`、`decision.signed`/`revoked`/`rejected`、`release.delivered`/`superseded`、`config.changed`）与派生表（`work_unit`、`config`、`snapshot_parent`、`release_item`）——它们的“同 subject 再写”是投影更新，不是覆盖结论。
  清单完整性由 `test/core/fold.semantics.test.ts` 守着：28 个 create kind 的 reducer 函数体必须（直接或经同文件本地 helper）走到 `createOnce(`，且逐 kind 做“同内容重放 no-op / 异内容拒”行为断言；任一把 create 改回 upsert 该测试会红（变异红证已做）。新增 create 语义 reducer 时必须同时更新 `CREATE_SEMANTICS` 并改走 `createOnce`。
- `stage_run`（迁移 004）：`stage.entered` 时 `gate_id`/`baseline_hash` 允许空，`gate.judged` 后必填；迁移重建表时按 002 原文重装 `overview`/`pm_queue` 视图。
- 安全网：`materialize` 在 fold 之后若发现**传入物化面以外**的表有行（测试可用 `materialize(db, {tables})` 收窄），直接 `materialize_failed`，绝不静默丢投影。**物化集 ≠ 对账集**：`VERIFIED_TABLES` 仍只对账 `task`/`spec`/`release`/`decision` 4 张（M2 按 `view_catalog` 补齐）；直插物化集外的表（如 `criterion_fixture`）`verify` 看不见。别把安全网当“全库防篡改”。
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
