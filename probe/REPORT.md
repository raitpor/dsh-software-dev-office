# 可执行性测试报告

> 目的：把 `docs/` 的设计**当成假设**验证一次——建得起来吗？约束真会拦人吗？
> 结论先说：**11 PASS / 5 GAP / 0 FAIL**（16 条输出行，对应 12 项探针，3/4 拆子项）。初版抓到的那处矛盾（夹具基数）已修；剩下 5 处必须在结构化设计里定死，见 `probe/GAPS.md`。

运行：`python3 probe/run.py`（SQLite 3.54，Python 3.14，`:memory:` + 单文件锁测试）

---

## 一、结果总表

| # | 探针 | 结果 | 含义 |
|---|---|---|---|
| 1 | 23 张设计表 + 探针辅助表能一次建起来 | ✅ PASS | 设计表 24 + 探针表 1 + SQLite 内部 1 |
| 2 | `work_unit` 复合外键 | ✅ PASS | `spec_id` 偏离 `criterion.spec_id`、`evidence` 挂错判据，都被拒绝；一致行可插入 |
| 3a | 快照祖先闭包（递归 CTE） | ✅ PASS | `S3 → S2 → S1` 可判定 |
| 3b | `snapshot.parent_ids` 是 JSON 数组 | ⚠️ GAP | 数据库不能约束其引用完整性 |
| 4 | 事件链 + 折叠 + 篡改检测 | ✅ PASS | 3 条事件可折叠；改一条 payload，链上出现 1 处断点 |
| 5 | 两段式写：payload 变了就拒 | ✅ PASS | confirm 的哈希对不上即拒绝 |
| 6 | 门禁 `all_of` 与 `na` | ✅ PASS | `pass+na → pass`、`pass+fail → fail`；手填与算出的差异可检出 |
| 7 | 单写：第二个写者被拒 | ✅ PASS | 0.20 s 内返回 `database is locked` |
| 8 | 派生列 `code_artifact_sha256` | ⚠️ GAP | 可被手填；SQLite 无内置 sha256 |
| 9 | 夹具基数 | ✅ PASS（已修） | 同极性可多条、同一输入不许重复；"至少 1 正 1 负"由注册门槛保证 |
| 10 | 没有负例的判据仍可注册 | ⚠️ GAP | 注册门槛只在文档里 |
| 11 | "一卡一判据一证据 = 一行" | ⚠️ GAP | 同一 task 可插多行 `work_unit` |
| 12 | 事件 `kind` 闭包 | ⚠️ GAP | 任意 kind 都能写入 |

---

## 二、已修的 FAIL：夹具基数自相矛盾

**初版发现**：设计文本说"至少 1 正 1 负"，表却用 `PRIMARY KEY(criterion_id, polarity)` 限制成"恰好各 1"；插第二条正例被拒。

**修法（选 A）**：

- `criterion_fixture` 加代理键 `id`，约束改为 `UNIQUE(criterion_id, polarity, input)`；
- "至少 1 正 1 负"移到**注册门槛**（`docs/04`）保证；
- 明确"夹具可有多组"——多条负例正是变异自证的材料（`docs/03` / `docs/04` 已同步）。

复跑：同极性第二条可插入、同一输入重复被拒。

---

## 三、5 个 GAP：数据库表达不了，必须由应用层/判据兜住

| GAP | 现象 | 必须补什么 |
|---|---|---|
| **3b 快照父链是数组** | `parent_ids` 里的 id 可以指向不存在的快照 | 要么加 `snapshot_parent` 链接表（探针已证明可行），要么在 `verify` 里做全员存在性检查 |
| **8 派生列可手填** | `spec.code_artifact_sha256` 能被写成任意值 | 触发器 + `verify` 重算比对；文档要写明"派生列不手填"是**判据**，不是注释 |
| **10 负例缺失可注册** | 没有夹具的判据照样插入 | 注册校验（`04` 注册门槛）必须在写入路径上执行，不能事后扫 |
| **11 一卡多行** | 同一 task 两条 `work_unit` 合法 | `task.single_criterion` 判据；或在 DDL 上 `UNIQUE(task_id)` 并明确"一卡只能一条" |
| **12 事件 kind 无闭包** | `whatever.happened` 可写入 | 参考表 / CHECK 约束，或写入路径白名单（`02` 的登记表要变成数据） |

---

## 四、这轮测试**没有**证明的事

避免误读，逐条列出：

- **没有证明** isomorphic-git 在并发 checkout 下可用（探针没跑 git，只跑了 SQL）；
- **没有证明** 18 条判据能拦住真实缺陷（探针只验证了门禁函数的三态语义）；
- **没有证明** 性能达标（P95 预算未测）；
- **没有实现** 任何业务逻辑——`run.py` 只是断言集合。

---

## 五、对下一阶段（结构化设计）的输入

按优先级，这 5 件事必须在结构化设计里定死，否则实现阶段会各自发挥：

2. `snapshot` 父链：数组还是链接表（GAP 3b）；
3. 派生列的重算机制（GAP 8）；
4. 判据注册校验放在哪一层（GAP 10）；
5. `work_unit` 是否 `UNIQUE(task_id)`（GAP 11）；
6. 事件 kind 闭包的数据形态（GAP 12）。

## 六、复跑

```bash
make probe            # 或 python3 probe/run.py；退出码 0 = 无 FAIL
make check            # docs 的 R1–R18
```

> 本目录不是实现，也不应被当作实现的起点；它只回答"设计能不能落地"。
