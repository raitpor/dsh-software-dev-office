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
| `window.ts` | 免密窗口（TTL 0/5/15/60；D-051 单次签发） |
| `store.ts` | signerd 持久化：key 信封、keyring、receipts、capability、失败计数/限速 |
| `protocol.ts` | unix socket JSON-per-line 协议：`status/unlock/lock/sign` |
| `signerd.ts` | socket server、单实例锁、权限拒启、请求分发 |
| `client.ts` | 插件侧客户端（capability 从 0600 文件读，口令走请求体） |
| `provenance.ts` | 写网关用：只验“签名是否 signerd 产出”（受信公钥 + Ed25519 + receipt 逐字段） |
| `verify.ts` | `verify` 用：decision 行 vs 签名载荷 vs receipt；缺回执/改签名/改 payload/断链都红 |
| `decision.ts` | 插件侧签发流程：四元组闸门 → signerd → 同批写 `decision.valid`+`decision.signed` |
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
signerd：`bad_passphrase`、`rate_limited`、`locked`、`invalid_request`、`unknown_request`、
`store_not_initialized`、`key_missing`、`key_file_insecure`、`key_dir_insecure`、
`dir_perm_insecure`、`file_perm_insecure`、`key_envelope_invalid`、`receipt_not_found`、
`signerd_already_running`、`signerd_lock_insecure`。
平台/路径：`platform_unsupported`、`socket_dir_insecure`、`socket_perm_insecure`、
`socket_path_too_long`、`socket_not_ready`、`runtime_dir_insecure`、`path_missing`、
`path_is_symlink`、`path_not_directory`、`path_not_regular_file`、`path_owner_mismatch`。

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
`decision.valid` 的 `payload_hash` 必须等于 `sha256:` + `sha256(canonicalJson(payload.payload))`
（D-055，写网关与 `verify` 双向重算）；`verify` 还要求 decision 行的 `payload_hash` 等于
**已签名载荷**里的 `payload_hash`（成对改 payload+hash 也会红）。
sign 请求的 `frontier` 必须等于当前库链头（P1-1）；并且 **签名返回后会再读一次链头复核**
（D-058：签发期间并发 append ⇒ `frontier_stale`、丢弃回执、窗口失效、0 行）。复核通过后
建 `decision.valid` 时 `prev` **直接用复核读到的 head**（不再读第三次），此后任何并发 append
都会让 append 的 prev 校验失败 ⇒ `event_chain_broken`、0 行。
同一 decision 出现多条 `decision.signed` 会被 `verify` 判红（M2 要求唯一，取最新一条验签）。
`runtime_inconsistent` 表示“已落盘但提交后链头变化”，返回体带 `written_decision_id` 与
`events_written`，需人工核对。

测试注入口：`test/sign/fixture-signerd.ts` 的 `installTestSignerd()` 固定测试钥匙，
**仅供测试**，生产不可用；产品代码没有任何“测试时跳过验签”的分支。
