# 可执行性测试报告

> 目的：把 `docs/` 的设计**当成假设**验证一次——建得起来吗？约束真会拦人吗？
> 结论先说：**25 PASS / 0 GAP / 0 FAIL**（25 条输出行，16 项探针，3/4/14/16 拆子项）。G1–G5 已全部决定（见 [docs/14](../docs/14-待决缺口.md)），本报告按决定后的设计复跑。

运行：`python3 probe/run.py`（SQLite 3.54，Python 3.14，`:memory:` + 单文件锁测试）

---

## 一、结果总表

| # | 探针 | 结果 | 含义 |
|---|---|---|---|
| 1 | 探针覆盖的 29 张表能一次建起来 | ✅ PASS | 29 张**探针子集**表（不是全部设计表：`task`/`release`/`decision`/`baseline` 等未建；本轮新增 `config`/`defect`/`verify_run`）+ SQLite 内部表 |
| 2 | `work_unit` 复合外键 | ✅ PASS | `spec_id` 偏离 `criterion.spec_id`、`evidence` 挂错判据，都被拒绝；一致行可插入 |
| 3a | 快照祖先闭包（递归 CTE） | ✅ PASS | `S3 → S2 → S1` 可判定 |
| 3b | 父链完整性（链接表 + 外键） | ✅ PASS | 指向不存在的父快照被拒绝 |
| 4 | 事件链 + 折叠 + 篡改检测 | ✅ PASS | 3 条事件可折叠；改一条 payload，链上出现 1 处断点 |
| 5 | 两段式写：payload 变了就拒 | ✅ PASS | confirm 的哈希对不上即拒绝 |
| 6 | 门禁 `all_of` 与 `na` | ✅ PASS | `pass+na → pass`、`pass+fail → fail`；手填与算出的差异可检出 |
| 7 | 单写：第二个写者被拒 | ✅ PASS | 0.20 s 内返回 `database is locked` |
| 8 | 派生列：应用层重算 + verify | ✅ PASS | 重算一致；手填后 verify 能发现（DB 不拦，已知边界） |
| 9 | 夹具基数 | ✅ PASS（已修） | 同极性可多条、同一输入不许重复；"至少 1 正 1 负"由注册门槛保证 |
| 10 | 判据注册门槛（唯一入口） | ✅ PASS | 无负例被拒；补负例后通过 |
| 11 | 一卡一行（`UNIQUE(task_id)`） | ✅ PASS | 第二行被拒绝 |
| 12 | 事件 `kind` 闭包（参考表） | ✅ PASS | 未知 kind 被外键拒绝 |
| 13 | 假设条款形状（`status` / `blast_radius` 与 `kind` 一致） | ✅ PASS | 缺 `blast_radius`、缺 `status`、非假设却有 `status` 都被拒；合法行可插入 |
| 14a–c | 分解树根：根唯一、子节点不误伤、根必须指向 intent | ✅ PASS | 同一 intent 第二个根被部分唯一索引拒绝；`part` 可多个；根无 `intent_id` 被 CHECK 拒绝 |
| 15 | 假设状态机：先签后处置、旧签字过期、撤销级联、空集 | ✅ PASS | 无签字处置/载荷不一致/撤销后旧签字写处置 都被拒；`invalidated` 后旧签字不算；空集未签 vs 空集已签区分正确 |
| 16a–d | 部署配置范围、缺陷关闭凭复验、`verify_run` 的 `actor_kind` | ✅ PASS | 配置 0 被 CHECK 拒；无 `verify_run` 关缺陷被拒；`actor_kind` 非 human/service/agent 被拒；带复验读数可关闭 |

---

## 二、已修的 FAIL：夹具基数自相矛盾

**初版发现**：设计文本说"至少 1 正 1 负"，表却用 `PRIMARY KEY(criterion_id, polarity)` 限制成"恰好各 1"；插第二条正例被拒。

**修法（选 A）**：

- `criterion_fixture` 加代理键 `id`，约束改为 `UNIQUE(criterion_id, polarity, input)`；
- "至少 1 正 1 负"移到**注册门槛**（`docs/04`）保证；
- 明确"夹具可有多组"——多条负例正是变异自证的材料（`docs/03` / `docs/04` 已同步）。

复跑：同极性第二条可插入、同一输入重复被拒。

---

## 三、G1–G5 的决定（已回流 [`docs/14`](../docs/14-待决缺口.md)）：数据库表达不了，必须由应用层/判据兜住

| GAP | 现象 | 必须补什么 |
|---|---|---|
| **3b 快照父链** | 已定 A：`snapshot_parent` 链接表 + 外键；悬空父快照被拒 | 已修（G1） |
| **8 派生列可手填** | `spec.code_artifact_sha256` 能被写成任意值 | 已定 A：**L1 fold/hash 重算**写列（不是触发器）+ `verify` 重算比对；文档要写明"派生列不手填"是**判据**，不是注释 |
| **10 负例缺失可注册** | 没有夹具的判据照样插入 | 注册校验（`04` 注册门槛）必须在写入路径上执行，不能事后扫 |
| **11 一卡多行** | 同一 task 两条 `work_unit` 合法 | 已定 A：DDL 上 `UNIQUE(task_id)`（表约束，不是判据） |
| **12 事件 kind 无闭包** | `whatever.happened` 可写入 | 参考表 / CHECK 约束，或写入路径白名单（`02` 的登记表要变成数据） |

---

## 四、这轮测试**没有**证明的事

**先声明 assumption 的覆盖边界**：探针 #13 只证明**形状能表达**；**#15 是把 `docs/03/04/06` 的规则照抄成函数**，验证授权与新鲜度（无签字处置被拒、载荷不一致被拒、`open` 拦派发、`invalidated` 后旧签字不算、撤销集合签字会级联回 `open`）——它验的是**规则本身**，不是实现；真正的 fold、落库与并发仍未验证。**25 PASS 不等于"assumption 整套已验证"**——#15 还不测 `fold` 的真实执行（依赖 hash 变化触发 `invalidated` 的落库）。

避免误读，逐条列出：

- **没有证明** isomorphic-git 在并发 checkout 下可用（探针没跑 git，只跑了 SQL）；
- **没有证明** policy 的 `stages[]`（`kinds`/`after`）与 `criteria[].guarantee` 能被库约束住：它们是 baseline 里的 JSON，**只能在 P15 校验器里查**（kind 枚举、id 唯一、`after` 无环可达、core 适用性、`guarantee_delta` 推导），探针不覆盖；
- **没有证明** 24 条判据能拦住真实缺陷（探针只验证了门禁函数的三态语义）；
- **没有证明** 性能达标（P95 预算未测）；
- **没有实现** 任何业务逻辑——`run.py` 只是断言集合。

---

## 五、对下一阶段（结构化设计）的输入

按优先级，这 5 件事已在结构化设计里定下（[`docs/14`](../docs/14-待决缺口.md) 全 A），实现阶段照此落地、不再另选：

2. `snapshot` 父链：数组还是链接表（GAP 3b）；
3. 派生列的重算机制（GAP 8）；
4. 判据注册校验放在哪一层（GAP 10）；
5. `work_unit` 是否 `UNIQUE(task_id)`（GAP 11）；
6. 事件 kind 闭包的数据形态（GAP 12）。

## 六、复跑

```bash
make probe            # 或 python3 probe/run.py；退出码 0 = 无 FAIL
make check            # docs/check.py 的规则（含条件运行的 R7；没有 R8）
```

> 本目录不是实现，也不应被当作实现的起点；它只回答"设计能不能落地"。
