# src/importer — M0-7 只读导入器

把 v1 的只读导出（夹具格式 `sdo1-export`）读进来，**不写库**地推演两件事：

1. **抽样重建**：把导出里的「结论型回执（claim）」重建成 v2 fold 能吃的合成事件流，
   折叠后读 `work_unit` 行，逐字段与导出比对，产出可判的差异清单；
2. **seq 回填**：给存量卡产出 `card_id → seq` 映射表（1..N 唯一单调），**只产表，不落库**。

M0-7 是 M1 真导入的预演，同时证明「v2 的 fold 能吃 v1 老数据」。真导入（写库、幂等键）
不在本卡范围。

## M0 没做的

这段写给评审者和后续接管者：本卡交付的是「只读预演 + 自证」，下面三件事**不在 M0-7 范围**，
不要按已实现使用。

1. **不写库**：导入器不打开、不创建、不写 SQLite；只有显式 `--out` 写报告文件。真导入的落库
   （事务、幂等键、重放校验）属 **M1 导入卡**。
2. **`claim` / `receipt` 不物化**：M0 的 fold 没有这两张表的 reducer（见
   `plan/03-偏差台账.md` D-008 的文本约定，以及 `src/core/fold/RULES.md` 把 `claim`/`receipt`
   留给 M-3/M-5/M-10），重建只产出 `work_unit` 行；`frontier` / `renderer` 仅做输入校验，
   `claim` 的 subject/predicate/value 是 `work_unit` 投影，不是真实行。
3. **没有真 v1 样本**：`test/fixtures/v1-export.json` 是按假设 A1 自定的最小字段集，不是从
   v1 导出得到；字段名映射只是本卡约定，真样本到位要按实际格式加兼容卡复核，不能拿夹具
   反推 v1 格式。

## 命令

```bash
npm run build
node lib/src/importer/index.js --input test/fixtures/v1-export.json --sample 20
node lib/src/importer/index.js --input test/fixtures/v1-export.json --sample 20 --backfill-seq
node lib/src/importer/index.js --input test/fixtures/v1-export.json --sample 20 --out /tmp/report.json
```

| 参数 | 含义 |
| --- | --- |
| `--input <file>` | 必填；导出文件（只读） |
| `--sample <N>` | 重建前 N 条 claim；**缺省 = 全部，且导出须 ≥20 条**（否则 `sample_too_small`，C2 下限 fail-closed）；显式 N 时报告记 `sample.declared=true`；N 大于 claim 数时 fail-closed |
| `--backfill-seq` | 追加 seq 回填映射表 |
| `--out <file>` | 报告同时写文件；**缺省只写 stdout**；不得与 `--input` 同一路径（`invalid_field`），这是本目录唯一的写文件路径 |
| `--help` | 用法 |

退出码：`0` 重建/回填通过且差异为空；`1` 导入错误或差异非空。
错误写 stderr JSON：`{error:{code,message,offset?,cardIds?,path?,available?,required?}}`。

**抽样前先校验整份导出**（P2-3）：重复 `claim_no` 由解析层全量拒绝；同一 `task_id` 多回执、
seq 冲突/跳号由结构校验拦截——不因为 `--sample` 只取前 N 条就把坏记录藏起来。

## 输入格式（假设 A1：夹具，不是真 v1 样本）

卡假设 A1：仓库里没有真 v1 导出样本，先用 `test/fixtures/v1-export.json` 定最小字段集；
`docs/09` 说 v1 由 `sdo1 export` 提供只读导出，但 v1 源码里没找到该命令实现。
**真样本到位后按实际格式加兼容卡，这里不猜。**

```jsonc
{
  "format": "sdo1-export",
  "format_version": 1,
  "exported_at": "2026-11-12T00:00:00Z",
  "source": "...",
  "records": [
    { "kind": "card",  "card_id": "v1-M0-0", "title": "...", "seq": 1 },
    { "kind": "card",  "card_id": "v1-M0-1", "title": "...", "seq": null },
    { "kind": "claim", "claim_no": "RC-2026-0001", "task_id": "TASK-001", "task_title": "...",
      "task_kind": "review", "task_seq": 1, "criterion_id": "CRIT-101", "spec_id": "SPEC-001",
      "evidence_id": "EV-001", "artifact_uri": "artifact://...", "artifact_sha256": "sha256:...",
      "predicate": "done", "value": true, "frontier": "f:...", "renderer": "renderer:gate-result",
      "actor": "alice", "at": "2026-09-30T08:01:00Z" }
  ]
}
```

fail-closed 规则：

- 未知 `kind`（record 级）或未知 `task_kind` → 报错并给 `offset`，**不猜默认值**；
- 缺字段 / 空字符串 / 非整数 → 报错；
- `predicate !== 'done'` 或 `value !== true` → `unsupported_conclusion`（M0 只建结论型回执）；
- 重复 `claim_no` → `duplicate_claim`。

## 字段映射（夹具 → v2 落点）

| 夹具字段 | 含义 | 重建落点 |
| --- | --- | --- |
| `claim_no` | v1 回执号 | 合成事件 id 前缀 `imp:<claim_no>:*`（不当作 v2 主键） |
| `task_id` | 卡号 | `claim.subject`（D-008 文本约定）/ `work_unit.task_id` / `task.id` |
| `task_title` | 卡标题 | `task.title` |
| `task_kind` | 卡类型 | `task.kind`（implement/design/review/docs 之外 fail-closed） |
| `task_seq` | 卡序号 | `task.created.seq` |
| `criterion_id` | 判据 id | `criterion.id` / `work_unit.criterion_id` |
| `spec_id` | 规格 id | `criterion.spec_id` / `work_unit.spec_id` |
| `evidence_id` | 证据 id | `evidence.id` / `work_unit.evidence_id` |
| `artifact_uri` / `artifact_sha256` | 证据制品 | `evidence.artifact_uri` / `evidence.artifact_sha256` |
| `predicate` / `value` | 回执谓词/值 | `claim.predicate='done'` / `claim.value=true`（仅结论型） |
| `frontier` | 前沿 | `receipt.frontier`（M0 不物化 receipt，见下） |
| `renderer` | 渲染器 | `receipt.renderer`（M0 不物化 receipt） |
| `actor` / `at` | 操作者/时间 | 事件 `actor`/`at` + `claim.actor`/`claim.at` |
| card `card_id` / `seq` | 存量卡 | seq 映射表 `card_id → seq`（不写 `task` 表） |

## 重建：一条 claim → 4 条合成事件

v2 的 `work_unit` 由 `task.created` + `task.claimed` + `criterion.registered` +
`evidence.attached` 物化（见 `src/core/fold/reducers/workunit.ts`），单条事件没有物化路径，
所以一条 claim 重建为 4 条事件（id 前缀 `imp:<claim_no>:`，`prev` 从
`imp:<claim_no>:root` 起逐条链到上一条事件的 hash；`actor`/`at` 全取导出值，
无时钟、无随机，同输入必得同事件流）。

事件 hash **直接复用 `src/core/verify-events.ts` 的 `computeEventHash`**
（`sha256(canonical(body) + prev)`，见 `docs/02` §10），不在本目录自写公式；这样 M1
把同类事件落库后 `verify` 不会因为公式不一致全链红。（`prev` 目前是每 claim 独立的
`imp:<claim_no>:root` 链根，M1 按落库顺序重链时再校验全链——M0 不落库，本卡不验。）

| 顺序 | 事件 | 关键 payload |
| --- | --- | --- |
| 1 | `task.created` | `{seq, title, kind, created_by}` |
| 2 | `task.claimed` | `{owner}` |
| 3 | `criterion.registered` | `{spec_id, remedy: 'rebuilt-from-v1-export:<claim_no>'}` |
| 4 | `evidence.attached` | `{criterion_id, artifact_uri, artifact_sha256, task_id}` → 触发 work_unit 物化 |

## 差异清单（判据 C5）

报告 `diffs[]` 每项固定 **`{path, v1, rebuilt, verdict, reason}`**：

- `path`：`claims[i].work_unit.<field>`（6 个字段）、`claims[i].claim.<subject|predicate|value>`，
  或整个 `claims[i].work_unit`；
- `v1`：按导出字段推出的期望值；`rebuilt`：fold 物化出来的实际值（缺失时 `null`）；
- `verdict`：`mismatch` | `missing`；`reason`：人可读的一句话，说明为什么算差异；
- 报告 `summary` 有 `claims / work_units / fields_compared / diffs`，并有逐条
  `claims[i].{claim_no, work_unit, claim}` 明细；
- `fields_compared` **只计独立比较**：每条 claim = `work_unit` 6 字段 + `subject` 投影 1 列
  = 7 次（20 条 → 140）；`predicate=done` / `value=true` 由解析层强制，单列在
  `asserted_by_parser={fields:['claim.predicate','claim.value'],claims:N}`，不混进计数；
- 差异清单覆盖 6+3 列；其余 claim 字段（`task_title`/`frontier`/`renderer` 等）仅由单测覆盖。

## seq 回填（判据 C3）

- 卡号唯一；已有 `seq` 保留，必须是 `1..N` 内正整数且不重复；
- 缺 `seq` 的卡按导出顺序取剩下的号（升序）；回填后整列严格递增；
- 冲突 → `seq_conflict`（双卡号）、跳号/超范围 → `seq_gap`（卡号）、非正数 → `seq_invalid`（卡号）；
- 汇总：`summary={cards,distinct,nulls,min,max,monotonic}`，供「不同 seq 数 = 卡数、空值 0」校验。

## 只读保证（判据 C1）

- `src/importer/` 里只有 `index.ts` 的显式 `--out` 一处写文件调用；
- 不打开/不创建 SQLite 库（M0-7 不写库），没有 `INSERT/UPDATE/DELETE/DDL`；
- 运行后导出文件与库文件的 mtime/内容不变；不跑 `--out` 时目录不新增文件。

## 已知边界

- 夹具不是真 v1 导出（A1）；字段名是 v1 旧名口径的**假设**，真样本到了要复核映射表；
- M0 不物化 `claim` / `receipt` 表（fold 还没有它们的 reducer），因此 `frontier`/`renderer`
  只做输入校验、不落物化行；`claim` 三列由 `work_unit` 行投影；
- 不做「导入写库」与幂等键 DB 校验（M0 没有写库动作）；seq 回填只产映射表；
- 差异清单在「事件流由导出字段重建」的结构下，正常导出应当恒为空；结构可判性由
  `diffClaim` 的注入测试证明（见 `test/importer/rebuild.test.ts`）。
- 事件 hash 公式复用 core verify（一致性由单测断言）；但每 claim 的 `prev` 链根是
  `imp:<claim_no>:root`，不是 `sha256:genesis`——M0 只做重建推演、不落库，M1 落库时需按
  全局事件顺序重链并跑全链校验。
