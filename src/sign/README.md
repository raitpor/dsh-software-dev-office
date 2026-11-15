# src/sign/ · 签字与安全

职责：签章口令（unlock）、`signerd` 私钥进程、免密窗口、决策签名与回执、写网关验签、verify 认账。

- 写域：`security` 泳道（impl-security）。M0 只留职责说明；**M2-0 起进场**（本目录即实现）。
- 纪律：agent 任何路径都不能产生 `decision` 行；私钥只在 signerd 进程内存/加密盘上，
  插件与模型只拿 `{receipt_id, signature, key_id, channel}`。

## 文件

| 文件 | 职责 |
| --- | --- |
| `paths.ts` | 平台检查、固定信任根 / runtime 目录 / socket 路径（sun_path ≤107B；D-054 不读信任根 env） |
| `permissions.ts` | 0600/0700 校验（lstat + uid + 精确位）、原子写 0600 |
| `keys.ts` | 生成 Ed25519、Argon2id 派生 + AES-256-GCM 加密私钥信封（`sdo-signerd-key-v1`） |
| `receipt.ts` | 规范签名消息、Ed25519 签/验、receipt 结构与 `receipt_id`、回执哈希链 |
| `window.ts` | 免密窗口（TTL 0/5/15/60；D-060：TTL=0 单次，TTL>0 供会话式批量复用；frontier 变即失效） |
| `store.ts` | signerd 持久化：key 信封、keyring、receipts、capability、失败计数/限速 |
| `protocol.ts` | unix socket JSON-per-line 协议：`status/unlock/lock/sign` |
| `signerd.ts` | socket server、单实例锁、权限拒启、请求分发 |
| `client.ts` | 插件侧客户端（capability 从 0600 文件读，口令走请求体） |
| `provenance.ts` | 写网关用：只验“签名是否 signerd 产出”（受信公钥 + Ed25519 + receipt 逐字段） |
| `verify.ts` | `verify` 用：decision 行 vs 签名载荷 vs receipt；缺回执/改签名/改 payload/断链都红 |
| `decision.ts` | 插件侧签发流程：四元组闸门 → signerd → 同批写 `decision.valid`+`decision.signed`；另含 D-060 会话式批量 API：`stageDecision`（只签名不落库）、`submitStagedBatch`（整批一次 append）、`discardStagedSignatures` |
| `proposition.ts` | 签字页命题渲染器（D-061）：从 `claim` 行渲染命题，模型只能选 claim 集合 |
| `page.ts` | D-060 会话式批量签字页服务端状态机：preview N → 解锁 → 逐条 confirm（暂存签名）→ 整批提交 |
| `errors.ts` | 稳定拒绝码闭集与 `{ok:false,reason_code,message}` 形状 |

## 默认路径（D-054：信任根固定，不用 env 覆盖）

- home：`~/.local/state/sdo/signerd`（0700）。**产品代码不读 `SDO_SIGNERD_HOME` 之类的 env**；
  嵌入方/测试要换位置，走显式参数 `signerdPaths({homeDir})` / CLI `--home`；
  测试也可用 `HOME` 指向临时根来模拟产品默认路径（`<state>` 随 HOME 走，见 `test/sign/helpers.ts`）。
  **产品 CLI 只认 `--home` 与默认 home，不读其它 env 覆盖。**
  里面：`signing_key.json`（0600 单行 JSON 信封）、`public_keys.json`（0600）、
  `receipts.jsonl`（0600，逐条带 `prev_receipt_hash` 哈希链）、`client.capability`（0600）。
- socket：`$XDG_RUNTIME_DIR/sdo/signerd.sock` 或 `$TMPDIR/sdo-<uid>/signerd.sock`；
  显式给 `--socket`/`socketPath` 时 runtime 目录跟随 socket 所在目录。
  runtime 目录 0700，socket 0600；路径超过 `sun_path` 107 字节直接拒。
- 平台：Linux / macOS；Windows 起手返回 `platform_unsupported`（D-050，M2 不实现）。
- Node 没有 `SO_PEERCRED`：socket 0600 **不是认证**（同用户进程都能连），客户端认证靠
  `client.capability`（0600 文件里的随机 capability，请求必须带对）。

## 信任根边界（D-054，诚实降级）

- 防的是：**没有 signerd 参与**的插件/agent/脚本伪造 `decision.signed`（写网关验签，0 行）。
- **不防**能改写自己 `<state>/sdo/signerd` 的同 uid 攻击者；这一类靠“可发现”而非“不可篡改”：
  `receipts.jsonl` 是哈希链、keyring/receipts 由 `verify` 逐条重算，篡改/插入/删除会红
  （`receipt_chain_broken` / `signature_unverifiable` / `runtime_inconsistent`）。
- T0（同机 root 读进程内存）不在防护范围（docs/06 §9）。
- 权限错误码分层（同一性质、两处码名不同）：verifier 发现 home 不合法返回
  `signerd_home_insecure`（它只能报“信任根不安全”）；signerd 启动发现 home 不合法返回
  `dir_perm_insecure`（启动阶段的目录权限码）。二者都是 fail-closed。
- DoS 边界：signerd 持单实例锁后若发现 0600 的遗留 socket 会删除它（只可能发生在崩溃残留场景；
  同 uid 攻击者抢占 socket 路径属于相同信任级问题，不承诺可用性）。
- orphan 回执：签发后复核失败（`frontier_stale`）时，刚写入的“未被 decision 行消费”的回执
  会被 `client.discardReceiptOnFailure()` 清理（仅供失败路径用）：在链尾则删除该行；不在链尾
  则标 `consumed:false`。**`consumed:false` 是客户端失败清理标记**，verify/provenance 视其为
  不存在；重算后缀 `prev_receipt_hash` 是**受控的链重写**——回执链只证明剩余回执的 append
  顺序，不证明某条未被 tombstone；伪造 decision 不会因此验绿（该 decision 会变成
  `signature_unverifiable`，fail-closed）。`runtime_inconsistent` 时 decision 已落盘，回执
  保留供人工核对。
- **并发边界（D-059，已知不可用）**：`discardReceiptOnFailure` 与 signerd 的 `appendReceipt`
  都是无锁读-改-写；两个签名者并发时，失败清理可能基于旧快照覆盖、丢掉别人刚 append 的回执
  （丢尾 ⇒ `signature_unverifiable`，丢中 ⇒ 链断）。M2-0 不修（需要跨进程锁，属 M4 单写者
  问题）；**M4 单写者/锁落地前，多签名者并发签名属于已知不可用场景**。

## 身份边界（D-056）

M2-0 **不校验调用者身份**：`actor` / `actor_kind` 由调用方传入，属工具层信任边界
（socket 层仅拒绝 `actor_kind='agent'` 直接签）。M2-1 才在工具层固定 `actor_kind`。

## 拒绝码（C10，只增不改）

签字链：`awaiting_unlock`、`not_a_signer`、`no_blind_sign`、`frontier_stale`、
`signature_not_from_signerd`、`signature_unverifiable`、`runtime_inconsistent`、
`signerd_home_insecure`、`receipt_chain_broken`、`event_chain_broken`（写网关透传的真实原因：
签后复核通过、但 append 时链头已被并发推进）。
signerd：`bad_passphrase`、`rate_limited`、`locked`、`invalid_request`、`invalid_field`（D-062：
`extra` 键与 payload 固定字段重名）、`unknown_request`、
`store_not_initialized`、`key_missing`、`key_file_insecure`、`key_dir_insecure`、
`dir_perm_insecure`、`file_perm_insecure`、`key_envelope_invalid`、`receipt_not_found`、
`signerd_already_running`、`signerd_lock_insecure`。
平台/路径：`platform_unsupported`、`socket_dir_insecure`、`socket_perm_insecure`、
`socket_path_too_long`、`socket_not_ready`、`runtime_dir_insecure`、`path_missing`、
`path_is_symlink`、`path_not_directory`、`path_not_regular_file`、`path_owner_mismatch`。

## 签字页（M2-6，D-060 会话式批量）

签字页不是“再做一个确认弹窗”，是 `no_blind_sign` 的最后一公里：
人看到的是 **renderer 从 claim 渲染的命题**，不是模型摘要；模型只能选 claim 集合。

- 命题渲染：`src/sign/proposition.ts`。`resolveClaimDecision` 从 claim 行渲染命题、
  派生 subject/value/evidence；提交的 `proposition` 与服务端复算不一致 ⇒ `no_blind_sign`。
- 两段式：`createRequest` 产出 `proposition`/`payload_hash`，`confirm` 必须原样回传；
  任何字段变化 ⇒ `payload_changed`（要求重新预览）。
- **会话式批量（D-060）**：一次解锁 = 一个签名会话，绑定解锁时 frontier `f0`。
  `preview` 一次生成 N 条（同 `f0`）；人逐条 `confirm`，每次只调 signerd 签名并暂存，
  **确认期间不 append**；整批确认完后一次 `append` N 条 `decision.valid`+`decision.signed`
  （`submitStagedBatch`）。因此确认期间链头始终是 `f0`，signerd 的
  `request.frontier === window.frontier_hash` 严格成立；不是“全部同意”——服务端拒绝
  一次请求提交多条 payload 的签名捷径（C8），批量只发生在逐条确认之后的提交。
- 放弃/超时：`abandon` ⇒ 已签回执全部 `consumed:false` 清理、不 append 任何事件。
- TTL：`0` 只能签一条（N=1）；多条需要 `TTL∈{5,15,60}` 的免密窗口，且**不会自动开窗**。
  TTL 由 signerd 启动参数/环境变量 `SDO_SIGNERD_WINDOW_TTL_MINUTES` 决定，**页面不能改**；`needs_window` 时须人工以 TTL>0 重启 signerd 后重新解锁。
  守卫在 `createRequest` 与 `confirm` 两处：已解锁且 TTL=0 的会话里再登记/再确认第二条
  ⇒ 结构化拒绝 `ttl_requires_window`（带 `staged`/`requested`），页面进入 `needs_window` 态。
- 两个时长字段（第 1 轮 P2-2）：signerd 回执的 `unlock_wait_ms` = 本次签发**实际等人解锁**
  的时长（同一窗口第 2 条起为 0）；`since_last_unlock_ms` = 距上次解锁的时长（保留，
  M2-G 可能要看）。页面原样透出前者而不是自己的计时。
- `submitStagedBatch` 失败时返回体带 `append_reason_code`（写网关原始码），不只折成
  `unknown_request`；`stageDecision` 单独调用也强制 baseline 的 `will_change`/
  `guarantee_delta`（只有 `prepareDecision` 这一道闸门，不存在绕过两段式的 API）。
- 交互计数（A2，Lead 定死）：一次交互 = 一个需要人输入并提交的 POST
  （`/sign/unlock` 或 `/sign/confirm`）；GET/轮询不计；计数随响应返回。
  单条 = 解锁 + 确认 = 2；批量第一条 2、后续每条 1。
- 成本（A3）：`sign_ms` 与 `unlock_wait_ms` **取 signerd 回执原值**；页面侧
  `page_total_ms` 仅展示，不参与 M2-G 读数；`page_unlock_wait_ms` 在复用会话时为 0。
- 失败态都带 `title`/`next`（`failureGuidance`）；不透出私钥或签名原文以外的材料。

### HTTP 页面

```sh
npm run build
SDO_DB_PATH=./sdo.db SDO_DB_PASSPHRASE='<口令>' node lib/src/ui/sign-serve.js
# 默认 http://127.0.0.1:4174/sign；SDO_SIGN_PAGE_PORT 覆盖，0 为随机端口
```

路由：`GET /sign`（页面）、`GET /sign/status`、`GET /sign/costs`、
`POST /sign/requests`（preview）、`POST /sign/unlock`、`POST /sign/confirm`、
`POST /sign/submit`（批量确认后提交）、`POST /sign/abandon`。
页面只绑 `127.0.0.1`；`src/ui/` 不直接碰库（DB 读都在 `src/sign/`）。

测试：

```sh
node --test lib/test/sign/          # 命题渲染 + 签字页状态机 + 批量/负例
node --test lib/test/ui/            # HTTP 壳（含 sign-page 端到端）
```

## 使用

```sh
npm run signerd -- init        # 口令从 stdin（不落 argv）；--home <dir> 显式指定信任根（测试/嵌入）
npm run signerd -- serve       # 前台 unix socket server（--sign-delay-ms 仅测试时序注入用）
npm run signerd -- status
npm run signerd -- unlock --actor alice --frontier <chain head>
npm run signerd -- sign --decision-id d1 --payload-hash sha256:... --proposition-hash sha256:... \
                       --frontier <hash> --nonce n1 --channel ui
npm run signerd -- lock --actor alice
```

插件侧：`signDecision(db, client, ...)` 未解锁返回 `awaiting_unlock`（0 行）；成功时
`decision` 行的 `signature/key_id/signer/channel/frontier` 与 signerd 回执一致。
裸 `append` 一条 `decision.signed` 会被写网关拒（`signature_not_from_signerd`）。
**决策载荷形状（D-062，按 `docs/06` §5）**：`decision_kind`、`subject`、`value`、`proposition`、
`evidence`、`difference`、`consequence`、`as_of_frontier` 是顶层固定字段；kind 专属字段
（`baseline`、`plan`、`intent`、`spec_ids`、`dispositions`、`clause_readings`、`readings_hash`、
`rollback`、`scenarios_run` 等）由调用方的 `extra` 注入，**铺在 payload 顶层**（不存在
`payload.extra` 这一层）。`extra` 的键与固定字段重名 ⇒ `invalid_field`、0 行、链上零事件。
`decision.valid` 的 `payload_hash` 必须等于 `sha256:` + `sha256(canonicalJson(payload.payload))`
（D-055，写网关与 `verify` 双向重算）；`verify` 还要求 decision 行的 `payload_hash` 等于
**已签名载荷**里的 `payload_hash`（成对改 payload+hash 也会红）。
sign 请求的 `frontier` 必须等于当前库链头（P1-1）；并且 **签名返回后会再读一次链头复核**
（D-058：签发期间并发 append ⇒ `frontier_stale`、丢弃回执、窗口失效、0 行）。复核通过后
建 `decision.valid` 时 `prev` **直接用复核读到的 head**（不再读第三次），此后任何并发 append
都会让 append 的 prev 校验失败 ⇒ `event_chain_broken`、0 行。
同一 decision **允许多条** `decision.signed`（M3-3：这是 `dual_human` 的载体；M2-0 的“单签”
指免密窗口绑定，不是签名条数）。第二条起 `payload_hash` 必须与 decision 行一致（否则
`payload_mismatch`）；同 actor 同 payload 重放 ⇒ 幂等 no-op；投影行保持**首签**，次数与
去重 signer 由事件重算。`counterSignDecision(db, client, {decision_id, actor, actor_kind,
producer, frontier, channel, now?})` 是第二签入口：调用前须先为该 actor 解锁窗口。

## 独立性（M3-3，`docs/07` §7）

- 等级唯一来源：baseline 的 `assurance.independence`（`docs/04` §5.1，在 baseline hash 内），
  解析 `dual_human`｜`solo_cooldown(<N>m)`（N∈[5,60]）｜`solo`；缺失/非法 ⇒ 判定拒
  （`independence_missing`/`assurance_invalid`），**不默认 15m**。哪些动作需要独立性来自
  M3-0 矩阵目录（`right.dual_human`），不写死。
- `dual_human`：同一 decision 至少 2 个不同 `signer`（按 actor 去重）；同 actor 连签不计数。
- `solo_cooldown(Nm)`：首签后 N 分钟内再签同一 decision ⇒ 拒 `cooldown_active`（带剩余），
  到期后第二次确认即可；冷却只锁这一条 decision，不阻塞其它卡。
- **边界（D-093）**：M2 signerd 是单钥单 home，本卡判“actor 级声明”——两个不同 actor 名
  可以共用同一把私钥，不防一人两账号；同 uid 攻击者不在威胁模型（T0）。真正多钥留 M4。
- 门禁：缺独立性时 `judgeStage` 出 `changes_requested` 且 `reasons` 只放码；`verify` 用同一套
  纯函数从事件 + baseline 重算（删一条签名/改 signer ⇒ 红），`VERIFIED_TABLES` 不动。
`runtime_inconsistent` 表示“已落盘但提交后链头变化”，返回体带 `written_decision_id` 与
`events_written`，需人工核对。

测试注入口：`test/sign/fixture-signerd.ts` 的 `installTestSignerd()` 固定测试钥匙，
**仅供测试**，生产不可用；产品代码没有任何“测试时跳过验签”的分支。

- 成本归因：`costs()` 按实际签名顺序 `sign_seq` 升序；`interactions` 与 `page_unlock_wait_ms`
  只归给本次解锁后第一条真正签下的条目（`sign_seq` 最小），其余条目 1 次/0。
  `interactions` 口径 = 本次解锁 POST 数 + 本次确认 POST（正常路径 `[2,1,1]`；同窗口重复 unlock 后首条为 3）。
  `signerd_unlock_wait_ms` / `since_last_unlock_ms` / `sign_ms` 一律逐条取回执原值（测试逐条与 `receipts.jsonl` 比对）。
  `created_at` 只决定页面展示顺序，不参与归因（同毫秒创建、乱序确认也必须归对）；`page_total_ms` 与成本 `at` 用同一注入时钟。

### 独立性第 1 轮评审补充（M3-3）

- **版本绑定（P1-1）**：判定独立性用的 `assurance` 取自“被判定对象绑定那一版 baseline”：
  - `judgeStage` 用 `stage_run.baseline_hash` 指向的 baseline 行；
  - 冻结类 decision 用其签名载荷里的 `payload.baseline.hash`；
  - 只有旧库确实缺该行时才回退当前 head，且 core `verify` 会报 `independence_baseline_unbound`（不静默）。
  因此 `baseline.amended` 之后，旧 decision / 旧 `stage_run` 的独立性结论不会翻转。
- **冷却时钟（P2-1）**：`counterSignDecision` 的冷却基准与事件 `at` 都用 signerd 回执里的
  `signed.at`（服务端真时钟）；调用方传入的 `now` 只影响审计告警，不能改变判定。
  预检查只做快速失败，权威判定在签名返回后按回执时钟复核（不满足则丢弃回执、lock、0 行）。
- **签名者口径（P2-2）**：core `verify` 要求每个签名者都能解析到 `actor` 表中 `kind='human'`；
  未知 actor / 非 human 的签名判 `independence_unverifiable`。边界：M2 signerd 是单钥，
  “两个不同 actor 名”仍是 actor 级声明（同一把钥匙可伪造成两个名字），真正多钥在 M4（D-093）。
- **签名时间三方一致（第 2 轮 P1-1）**：`decision.signed` 的 `event.at === receipt.at === payload.signerd.at`，
  任一不等 ⇒ 写网关拒 `signature_time_mismatch`（0 行），core `verify` 复算同一比对（`runtime_inconsistent`）。
  未知码 `signerd_receipt_replayed`：同一 `receipt_id` 已被另一条事件使用（迁移 012 的
  `signerd_receipt_use` 唯一约束，append 事务内占位）。二者共同封死“复制已签名事件、只改 at、重算 hash”
  伪造冷却已过的重放。
- **冷却按回执时钟（fail-closed）**：`signaturesForDecision` 取 `payload.signerd.at` 作为签名时间（不依赖网关保证）；该字段缺失（直插旧日志）⇒ `independence_unverifiable`，不回退 `event.at`。
- **多签合法性（P3）**：同一 decision 的多条 `decision.signed` 是 D-092 的合法形态，
  `verifyDecisionSignatures` 逐条验签、投影行只与首签一致；不再判 `runtime_inconsistent`。
  `judgeIndependence` 不接收 `now` 参数，冷却只从签名 `at` 差计算（纯函数）。
