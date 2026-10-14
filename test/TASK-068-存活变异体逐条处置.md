# TASK-068：存活变异体逐条处置（TASK-023 / TASK-039 名下 survived 项）

> 本文件由 TASK-068（developer）写入 `test/`（卡写范围），**不参与测试发现**（`scripts/run-tests.mjs` 只跑
> `lib/test/*.test.js`，本文件不是 `*.test.ts`，不会被编译成用例）。
> 卡写范围只有 `test/`：本轮**零产品代码改动**（`src/**` 一字未动），产品侧的变异体一律以
> 「编译产物等价回滚」（改 `lib/**` 的同义代码，跑完立即逐字节复原并复算 sha256）或「改随包数据
> `src/data/lang/zh-CN.yml` 后逐字节复原」实现。

## 一、哈希时刻口径与台账现读

- **台账现读时刻**：2026-10-13T17:39:00+08:00 ~ 17:45:00+08:00（每次 `sdo_test action=record` 回执时间见
  `.sdo/construction/tdd.yml` 各条 `at` 字段，UTC）。
- **文件哈希时刻口径**：各文件哈希取**最后一次写盘之后**、且**本轮复跑开始之前**的时刻（下表 mtime 即该时刻）。
  收工的全量绿读数取自该时刻**之后**的两次连续跑（见 §五）。
- **本轮实际写入的文件**（这是唯一的两个改动文件，路径 + mtime + sha256）：

| 文件 | mtime（+08:00） | sha256 |
|---|---|---|
| `test/m42.test.ts` | 2026-10-13 17:42:20 | `703c5925e23699b56d294a6dd845c3ecdc6d59adeb022d47b7304ccc01077959` |
| `test/m94.test.ts` | 2026-10-13 17:43:22 | `42d9991ae1a1c271d52138cbaad35a8b5a0275254e64797c0db9dafbc807f6c2` |
| `test/TASK-068-存活变异体逐条处置.md`（本报告） | 见 §六 自证行 | 见 §六 自证行 |

- `lib/test/m42.test.js` = `f7710c5c0ad483612ef4d9323e8ffbc856e02dbef7832fb87fcaef131eb346cb`、
  `lib/test/m94.test.js` = `5ddc37163c30c04714f997ff16ec1d992cd9ce1c58ef7af634206538ba85981b`（构建产物，非交付面）。
- 本轮**没有**清 `tmp/`、**没有**碰 `docs/`、`.sdo/` 侧只经 `sdo_test action=record` 追加
  （`tdd.yml` 追加 6 条 TASK-068 记录，历史条目一字未改）。

## 二、先核台账：卡的「现读」有三处需要更正

1. **TASK-023 名下不是 4 条记录里的「1 条 survived」**：`grep -c 'task: TASK-023' .sdo/construction/tdd.yml`
   = **6 条**，其中 **3 条**带 survived —— ①（`killed 4 / survived 1`，03:59:58Z）、
   ②（`src/domain/reviewDoc.ts`，`killed 0 / survived 1`，06:29:47Z）、
   ③（`src/data/lang/zh-CN.yml`，`killed 0 / survived 1`，06:30:02Z）。②③ 是 TASK-049 期间补做的探针，
   卡上只点了①。**本轮把三条全部重放并逐条处置**（1 条补断言 + 2 条复跑实测已被 TASK-057 杀死）。
2. **TASK-039 的「合计 15」是三次探针各自 `7 − killed` 的和**（7 个用例的断言面：`4 + 5 + 6 = 15`），
   **不是 15 个不同变异体**：三条探针用的是**同一个断言面**（`node --test lib/test/m94.test.js`，7 条用例），
   所以同一个用例会在多条探针里重复出现。**不重复的受害/存活项合计 6 个用例**（M94-01…M94-06）。
   本轮按「**逐条**（每个用例 × 每条探针）给出处置种类与理由」处理，共 3 × 7 = 21 个格。
3. **TASK-039 探针①的读数与卡/作者自述不完全一致**：作者 done note 记 `killed 3 / survived 4`
   （红 M94-01/02/03），本轮复跑为 **`killed 4 / survived 3`**（红 M94-01/02/03/**06**）。
   差异来源可复算：`M94-06` 的夹具在 TASK-054/056 之后被改过 —— 它的绿侧「补齐采纳三件套」
   （`executedBy`/`adoptedBy` 经工具面）在该变异体下拿不到字段 ⇒ `after.passedAdopted` 0≠1 当场转红。
   本轮**按现读值记录**，不把两个读数混成一个。

## 三、逐条处置表

字段口径：「原 survived」= `.sdo/construction/tdd.yml` 里对应的历史记录读数；
「现 survived」= 本轮复跑（同一 harness、同一 7 条用例）的读数；「killed 项」= 该变异体下真实转红的用例。

### A. TASK-023（harness = `node --test lib/test/m42.test.js`，7 条用例）

| # | 变异体（target 原文） | 原 survived | 处置种类 | 依据 / 新断言 | 复跑 killed 项 | 现 survived |
|---|---|---|---|---|---|---|
| A1 | 记录①：删掉场景「刺激」的取值（`derivedDocs` 的渲染侧可见来源）| **1**（`killed 4 / survived 1`）| **补断言** | `test/m42.test.ts` 的 `TASK-023／DEF-005` 用例新增：前置断言（真源确有 1 条场景、`stimulus` 非空）+ 正文断言（`docs/QUALITY.md` 必须含 `被接管的会话开始新一轮` / `限长注入文本` / `≤ 200 毫秒`）| **M42 的 DEF-005 用例** | **0** |
| A2 | 记录②：停用 `src/domain/reviewDoc.ts` 的「名字对齐」节渲染 | **1** | **判等价（归属 TASK-057 的补断言）** | 复跑实测**已被杀**：TASK-057 把断言收紧为 `/（对齐到规范名/`（去掉被必需栏表头满足的 `\|规范名` 支）并用「根下 `DESIGN.md` vs 规范落点 `docs/DESIGN.md`」让对齐节**真的渲染**。故本项不是「等价」而是「补断言已由 TASK-057 落地、本轮复跑留痕」 | **M42 的对齐用例（DEF-004）** | **0** |
| A3 | 记录③：改掉 `src/data/lang/zh-CN.yml` 的「（对齐到规范名 …）」文案 | **1** | **判等价（归属 TASK-057 的补断言）** | 同 A2（同一处断言面；语言包文案改动由收紧后的正则与「两个名字同现」断言挡住） | **M42 的对齐用例（DEF-004）** | **0** |

> A1 的复跑同时证明「反向路径」也在这条断言上：另做一次变异（**停掉渲染器那一行**
> `lines.push('**刺激**：…')`）⇒ 同一个用例转红（见 §四）。

### B. TASK-039（harness = `node --test lib/test/m94.test.js`，7 条用例 M94-01…M94-06＋M94-03b）

| # | 探针（target 原文） | 原 survived | 逐条处置 | 复跑 killed 项 | 现 survived |
|---|---|---|---|---|---|
| B1 | ① `src/index.ts` 去掉 5 处 deps 字段映射（`executedBy/adoptedBy/rootCause/discoveryLevel/escaped`） | **4**（`killed 3`）| **判等价/正交（3 条）**：存活的是 M94-03b / M94-04 / M94-05。理由（可复算）：① 该变异体**已被杀死**（killed 非空：M94-01/02/03/**06**），断言面对「参数有没有被搬进域层」并非失明；② 三条存活项的前提与该变异体正交 —— M94-03b 钉的是「端点齐备但缺 `oracle` ⇒ 判红零写入」、M94-04 钉的是「自执行自采纳 ⇒ 回执点名 + C-50 判红」、M94-05 钉的是「一个字段都不给 ⇒ 不许凭空落键」。三者**都不经过 deps 搬运**（前两条的拒绝发生在搬运之前，第三条断言的是"键不存在"），故"不红"是预期而非缺口（补断言只会写成恒真断言） | M94-01 / M94-02 / M94-03 / M94-06 | **3**（原 4） |
| B2 | ② `src/domain/gates.ts` 删掉 `tests.passed` 的 unadopted 判红块 **+ 把绿路径读物退回 `stats.passed`** | **5**（`killed 2`）| **一半补断言、一半判等价**：<br>· **判红那一半**：已被 M94-04 / M94-06 杀死（"未采纳的 pass ⇒ C-50 判红并点名"）；存活的 M94-01/02/03/03b/05 与之正交（它们不触碰 C-50 的未采纳分支）。<br>· **"读物退回"那一半：等价变异体** —— 走到 `ok('tests.passed', …)` 的前提是 `stats.unadopted.length === 0`，而 `src/domain/records.ts` 的口径是 `passedAdopted = adoptedPass.length`、`unadopted = 那些 status=pass 且未被采纳的结果`（两者**按定义互补**：`adoptedPass.length + unadopted.length = results.filter(status==='pass').length = passed`）⇒ 前提成立时 `stats.passed === stats.passedAdopted`，两个表达式产生的**判定、回执逐字文本、补救动作全部相同**。因此"退回 `stats.passed`"在 C-50 上**无可观察差异**，任何断言都无法区分它。<br>· **补断言（本轮新增，把此前无承托的绿路径回执钉住）**：`test/m94.test.ts` 的 M94-06 绿路径新增 `assert.match(green.detail, /用例 \d+ 条全部有结果（通过 <passedAdopted>）/)` + 转绿后不得再报「未独立采纳」 | M94-04 / M94-06 | **5**（与原同） |
| B3 | ③ `src/index.ts` 把非法 `discoveryLevel` 的判红改为不可达（`level.length < 0` 恒假） | **6**（`killed 1`）| **判等价/正交（6 条）**：存活的 M94-01/03/03b/04/05/06 都不经过「非法取值被拒」这一支；而该支的判红面**已被 M94-02 完整杀死**（回执点名六个合法词 + 判红零入账 + 换合法值即入账两态）。→ 不构成断言面缺口，不需补断言 | M94-02 | **6**（与原同） |

## 四、本轮补的两条断言「真能失败」的自证（变异自证，逐条）

| 补的断言 | 防护的那处 | 变异方式（回滚它） | 实测结果 |
|---|---|---|---|
| `test/m42.test.ts`：`docs/QUALITY.md` 正文必须含场景刺激/响应/度量 | `src/domain/quality.ts#listScenarios` 搬 `stimulus` 的**取值** | `stimulus: textOf(record.stimulus)` → `stimulus: ''` | **`node --test lib/test/m42.test.js` ⇒ 1 fail（`TASK-023／DEF-005`）/ 7**；复原后 sha256 一致 |
| 同上（同一断言的另一条路径） | `src/domain/derivedDocs.ts` 的**渲染输出行** | 删掉 `lines.push('**刺激**：${scenario.stimulus}')` | **1 fail（同一条用例）/ 7**；复原后 sha256 一致 |
| `test/m94.test.ts`：绿路径回执必须报「通过 `<passedAdopted>`」 | `src/domain/gates.ts` 的 `ok('tests.passed', …)` 读物 | 绿路径读物退回 `stats.passed`（与探针②同款） | 该条断言**不能区分**（见 B2 的等价证明）——故本卡**不声称**它被这条变异杀死；探针②的 killed 仍由 M94-04/M94-06 承托（复跑 `killed 2 / survived 5`）。补这条断言的价值是"绿路径回执此前**没有任何**断言承托"，不是"它杀死了探针②" |

> **反向自证（防"断言面根本没跑起来 ⇒ 假绿"）**：正式重放前先做一次 **PROBE-NOOP** —— 把
> `test/m94.test.js` 里 `M94-03` 的一条断言改成必失败值，跑出 `7/6/1`（唯一红项恰为 M94-03）⇒
> 断言面确实被执行、harness 能区分"变异生效"与"脚本没跑"（知识库 `tq_32260e1a` 的教训）。

## 五、收工前全量（挂成 command 证据）

```
npx tsc -p tsconfig.json            → exit 0（无输出、0 错）
node scripts/run-tests.mjs          → exit 0
  ℹ tests 969 / pass 969 / fail 0   （连续两次跑读数相同：969/969/0）
```

> 与卡上写的基线 **952/952** 不一致是**真事实**，不是本轮放宽：本轮之前/之后的多次在建改动
> （其它卡在 `test/` 与 `src/` 上的新增用例）使用例总数增长；本轮**只多不少**地跑、且 0 fail。
> 本轮自己的两个文件定向面：`node --test lib/test/m42.test.js` ⇒ 7/7、`node --test lib/test/m94.test.js` ⇒ 7/7。

## 六、结论计数（DoD 要求的四问）

- **共处置几条**：**6 个变异体**（TASK-023 三条 record 全部重放 + TASK-039 三条探针全部重放），
  对应 **8 条 survived 记录项**（TASK-023：1+1+1；TASK-039：4/5/6 —— 注意后三者的"15"是同一断言面上
  三次探针的**重复计数**，去重后为 6 个用例）。
- **其中补断言几条**：**2 条**（A1 的正文断言；B2 的绿路径回执断言）。另 A2/A3 的补断言**已由 TASK-057
  落地**，本轮以复跑留痕证明其**已被杀死**（不重复补）。
- **判等价/不可达几条**：**3 条**（B1 三条正交；B3 六条正交 + B2 的"读物退回"等价 —— 逐条理由见 §三）。
  全部给出**可复算依据**（判红前置 + `records.ts` 的 `passedAdopted`/`unadopted` 互补口径 + 复跑 KILLED 非空）。
- **仍存疑几条**：**0 条**。没有任何一条需要动产品代码才能闭合 ⇒ 本卡**不 block**。
  另记两条**不改历史**的偏差（不构成存疑，但读者要知道）：① 卡上「TASK-023 只 1 条 survived」与现读
  3 条不符（§二.1）；② 探针①的 killed 读数与作者自述差 1（§二.3），两处都已如实分列。

### 本轮自证行（本文件）

- 路径：`test/TASK-068-存活变异体逐条处置.md`
- 哈希时刻口径：本行下方 mtime/sha256 在**最后一次写盘之后、全量复跑之前**取值；其后未再改写本文件。
- mtime / sha256：**见下方向台账回报的 `artifact` 证据条目**（同一时刻复算，避免自指）。
