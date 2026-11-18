# SDO v2 — 事件溯源的开发台账（Cordis bundle 适配器）

本仓库既是 SDO v2 的实现（`src/` + `migrations/` + `test/`），也是一个可被
DeepSeek Harness 安装的 Cordis bundle（根 `package.json` 的 `dsh.bundle` +
`cordis.patch.yml` + `index.js`）。设计口径见 `docs/`、`design/`（冻结于
`frozen/design-v2.0`），执行卡与证据在 `plan/`。

## 安装（宿主侧）

```bash
# 1) 先构建，bundle 入口 import 的是 lib/
npm run build

# 2) 在宿主主会话里安装（需要 plugin_manager 审批；名称 = 目录名 D-222）
plugin_manager install_bundle dsh-software-dev-office
```

卸载：

```bash
plugin_manager remove_bundle dsh-software-dev-office
```

安装/卸载是宿主 profile 操作，数据目录不会被删除；重装后 `sdo_verify` 仍应通过。
本卡只验证“同进程内装后 `list_plugins` 可见”和工具可注册；重启后 active 由
M5-2/收口步骤验证，单测不假装覆盖重启。

## 入口

- 宿主 `require(main)`：`index.cjs`（CJS，`main`，导出 `{name,inject,apply}`）。
- 直接 import/测试：`index.js`（ESM）。
两条入口共用 `src/plugin/index.ts` 的 `activatePlugin`，装配逻辑只有一份。`apply` 不得返回插件对象（Cordis 会把返回值当 effect，非函数/空值即 `Invalid effect`）。

## 配置

`config` 只放**非秘密**开关；口令只从进程环境读，不写进 profile：

| config 键 | 环境变量 | 说明 |
| --- | --- | --- |
| `db_path` | — | 缺省 `~/.local/state/sdo/<slug>.db`（目录 0700、文件 0600）；显式指定时只许 `~/.local/state/sdo/**` 或 `<project_dir>/.sdo/**` |
| `actor` | `SDO_PLUGIN_ACTOR` | 工具面身份；缺省 `sdo:plugin-agent`（agent，只走工具通道） |
| `actor_kind` | `SDO_PLUGIN_ACTOR_KIND` | `agent` 缺省；显式 `human` **等于把签字权交给模型**，仅影子期/演练用 |
| `console` | — | 缺省 `true`，起独立页（登录/注册申请/看板/签字确认） |
| `console_port` | `SDO_PLUGIN_CONSOLE_PORT` | 缺省 4173；只绑 `127.0.0.1` |
| `signerd_home` | — | 缺省 `~/.local/state/sdo/signerd` |
| `signerd_autostart` | `SDO_SIGNERD_AUTOSTART=1` | 缺省关；开时需 `SDO_SIGNERD_PASSPHRASE` |
| `project_dir` | — | 缺省 `process.cwd()`，用于解析 db 路径 |

库口令：`SDO_DB_PASSPHRASE` 可选；零配置时自动生成 `<state>/db.key`（0600）并只从该文件读取，不打印、不进工具返回。

DB 路径规则（与卡 C5 一致）：默认 `~/.local/state/sdo/<slug>.db`；显式 `db_path` 在项目下时只许 `<project_dir>/.sdo/**`；任何情况都拒绝仓库根、`.git/`、`docs/`、`src/`，越界启动即 `invalid_config`。`.sdo/` 已在仓库 `.gitignore` 中，落项目目录也不会被提交。

## 工具

- `sdo_query`：读视图（字段白名单，不接受 raw SQL）。
- `sdo_verify`：事件链/投影对账，返回 problems 前 20 条。
- `sdo_status`：库路径、schema 版本、事件数、身份。
- `sdo_append`：**唯一写入口**，`events` ≤20 条，actor 只来自插件会话；内部只调
  `append(db, events, {session})`，不直接写 SQL。`conflict`/权限拒绝以结构化 `reason_code` 返回。

`src/plugin/signerd.ts` 只在**适配器侧**起停既有 `scripts/signerd.mjs` 进程，不改
signerd 入口；重复启动返回 `signerd_already_running`。kill -9 后的 signerd 自身锁恢复路径**本卡未验证**（见「已知边界」）。

## 控制台页

本卡**未挂宿主 Web UI 插槽**（slot 契约与稳定挂载点未在宿主侧验证），退路是
`127.0.0.1:<port>` 的独立只读页：身份来自插件配置，缺身份不启动；页面只读，
写操作仍只能走工具面。后续 milestone 若确认插槽，再补 `client.js`。

## 宿主安装树哈希

```bash
node scripts/plugin/host-digest.mjs --install "$DSH_INSTALL" \
  --exclude "$DSH_INSTALL/plugins/dsh-software-dev-office" \
  --exclude "$DSH_INSTALL/node_modules/.cache"
```

输出安装树内容 sha256；安装前后应相等（排除插件自身与缓存）。


## 已知边界

- **单实例假设**：默认库路径按 `basename(project_dir)` 生成，同一项目从不同目录启动会得到不同库；driver 未开 WAL / `busy_timeout`，两个实例共用同一库只会 `open_failed` / `database_busy`。同一项目请只起一个 SDO 插件实例。WAL 与多实例留台账 gap（D-235，改 driver 超出本卡写域）。
- **卸载保留数据**：卸载插件只移除代码与安装目录；状态目录（含库、`signing_key.json`、signerd home）原样保留，重装后数据仍在。需要彻底清理时手动删除 `~/.local/state/sdo/`。
- **宿主被 SIGKILL**：插件来不及 dispose，自己 spawn 的 signerd 可能成为孤儿。发现方式：`ps` 中有 `scripts/signerd.mjs serve`、`signerd.sock` 仍存在但插件已不在；清理：先 `kill` 该进程，再删除对应 `signerd.sock` 与 `signerd.lock`（路径见 `signerdPaths`；默认 `~/.local/state/sdo/signerd/` 或 `XDG_RUNTIME_DIR` 下）。
- **signerd 自身锁恢复未验证**：kill -9 后 signerd 是否自动清理过期锁，本卡没有测试支撑，不要当成已保证。
- **控制台插槽未验**：见上节；独立只读页是本卡退路，不等价于宿主内嵌页面。


## 账号与审批（C13）

- 账号存 `<state>/accounts.json`（目录 0700、文件 0600、原子写），口令用 Argon2id；不新增数据库表/迁移。
- 注册是**两步**：页面 `POST /register` 只写挂起申请（`<state>/pending-registration.json`，0600，TTL 15 分钟），**不创建账号**；随后在对话里让 agent 调 `sdo_account_confirm`，工具把服务端校验后的申请快照（用户名/角色/来源/申请 id +「提交方无法验证」）交给宿主 `ctx.approval`，**只有 `allowed-once` 才建账号**；`rejected/cancelled/unavailable` 不建账号、挂起保留到 TTL。宿主没有审批答案器时 `approval_unavailable` fail-closed。
- 因此本插件没有“直接建账号”的 HTTP 路由；`/register` 仅是申请入口，不能用于绕开人工审批。挂起文件被篡改会返回 `pending_registration_tampered`。
- 会话在服务端，cookie `sdo_session` 为 HttpOnly + SameSite=Lax（TTL 8h、闲置 30min）；写操作校验双提交 CSRF cookie `sdo_csrf`。登录按 IP+用户名 5 次/5 分钟限速（`rate_limited`）。首账号 `admin`，之后 `user`；账号 actor id 为 `user:<uuid>`，删除账号文件后旧 uuid 不可恢复、旧 grant 不迁移。
- **未决**：审批 id 目前取工具 `callId` 兜底，尚未从 `approval/asked` 审计事件反查（记为待收口缺口）。

## 双人证签字（C14）

- `db.key` 只加密数据库；签名密钥由 signerd 保管，用**人设解锁串**（首次初始化时由人输入 ≥12 位）作为 KEK、经 Argon2id 加密 `signing_key.json`。插件不保存、不回显、不写日志、不进工具返回，也不新增任何“机器可读的签名解锁文件”。
- 流程：初始化签名密钥 → agent 提案（`sdo_append` 的 `request_sign`，ACK 的 signer 留空/pending）→ 人类在页面打开确认页（服务端按 `decision_payload` 重建摘要：种类、claim id+标题+状态、payload hash 前 8 位；提案方叙述单独标注，不一致标红并默认拒签）→ 输入解锁串（signerd 窗口 TTL=0，绑定当时 frontier）→ 签发；`signer` 由页面会话写入，签发后断言确认页 signer == 实际 actor；`key_id` 必须等于账号记录指纹，否则 `no_permission`。
- 确认到签发之间事件链变化会 `frontier_stale`；轮换需要账号口令 + 旧 signerd 口令。

## 零配置与授权（C15/C16）

空环境 + 干净状态目录可走完：初始化 → 注册（人工审批）→ 登录 → 提案 → 确认 → 解锁 → 签。

- agent 通道固定 actor `sdo:plugin-agent`（kind=agent）：`read@domain:core`、`plan@domain:sdo`、`plan@domain:core`（动作 `create`/`propose_plan` 映射到 `plan` 右）。
- human 首账号：`read@domain:core`、`read@domain:sdo`、`decide@domain:sdo`、`sign@domain:core`、`sign@release:current`。
- bootstrap 只内部入口、不进工具清单、不授 `admin`；create-once 按 `(actor,right,scope)` 是否已有 `right.granted` 判定（不看 `revoked_at`，已撤销不复活）。

## 软约束（C17，非安全边界）

工具/skill/页面文案约束模型：不得代签、不得声称“人已批准”、不得自行注册、不得读取状态目录；签字只能由登录的人类在页面发起，agent 一律 `not_a_signer`。这些只是降低误操作，**不是安全边界**：同 uid 进程可读状态目录；若沙箱不拦写，可直写账号/库/签名文件；审批 seam 与盘同域；来源不可证。

**未决**：宿主 skill 注册接口本卡未接（README 文案代替）；页面 decision 行尚未显示审批 id。
