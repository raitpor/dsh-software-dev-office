# `src/check/` — `sdo_check` 判据只读预览（M1-4）

给人和 agent 一个**不改库**的判据预览：现算某条判据或某个 stage 出口的 gate，
每条结果都带依据，并明确标注“这是预览，不是判定”。

```
SDO_DB_PATH=./sdo.db SDO_DB_PASSPHRASE=… npm run check -- --criterion provenance.present
SDO_DB_PATH=./sdo.db SDO_DB_PASSPHRASE=… npm run check -- --gate req --preset waterfall --pretty
```

退出码（卡假设 A3）：`0` = 算完（判据 fail 也是 0，预览不是门禁）；`2` = 参数错 /
未知判据 / 未知 stage / 未知 preset；`1` = 工具自身错（库打不开、事件链坏、缺口令）。

## 只读契约（C4/C5）

- 不写事件、不写 `gate.judged`、不改任何表；打开库用 `mustExist: true`（不会建库）。
- `gate.judged` 在 M1 不存在：C5 的取证是“跑完所有入口后 `gate.judged` 表数量为 0”，
  不是 catch 吞掉写失败。M2 才写判定行。
- 静态扫描：`src/check/*.ts` 不含 INSERT/UPDATE/DELETE 等写关键字；SQL 只有
  `SELECT` 和只读的 `PRAGMA table_info`。

## 输出形状（C1–C3、卡 A4）

顶层：

```jsonc
{
  "ok": true, "preview": true, "judged": false, "baseline": null,
  "at": "…", "mode": "criterion" | "gate",
  "criterion": { "criterion_id", "result": "pass|fail|na|unknown",
                 "preview": true, "judged": false,
                 "effective": true, "binding_reasons": [],
                 "reasons": [{ "code", "detail?", "level?", "why?" }],
                 "basis": { "evidence_ids"?, "spec_ids"?, "task_ids"? } },
  "gate": { "preset", "stage", "kinds", "gates": [...], "criteria": [...],
            "result", "gaps": [] }
}
```

- `effective` / `binding_reasons` 一律来自 `src/core/criteria/binding.ts`（C6）；
  gate 结构一律来自 `src/core/baseline/presets.ts`，本目录没有第二份
  `applies_to` / `guarantee` / stage 表。
- M1 只强制 core 三条（`spec_set.signed` / `assumption_set.signed` / `provenance.present`，
  `docs/09` §16.2）+ 内置 `dead_field`；其余目录判据没有数据载体 ⇒
  `result:"unknown"` + `reasons:[{code:"insufficient_data"}]`，**不冒充 pass**（卡 A2）。
  卡假设 A2 已确认：允许 unknown，但 core 三条必须给 pass/fail、**不许 na**。第 1 轮评审 P1
  把 `spec_set.signed` 在“还没有 requirement”时的结果从 `na` 改成 **fail**
  （`reasons:[{code:"no_requirement_yet"}]`）；gate 聚合也把任何 `na` 显式归 fail，
  避免 core/阶段判据的 na 被洗成 pass。

## 已实现的求值

| 判据 | M1 口径 |
| --- | --- |
| `provenance.present` | 每条 `task`/`spec` 的 `created_by` 非空 ⇒ pass；`reasons` 恒带 `actor_registry_unavailable`（M1 无 actor 注册表，未校验 ≠ 已校验） |
| `spec_set.signed` | 无 requirement ⇒ **fail** + `no_requirement_yet`（core 不许 na，P1）；否则须有效 `decision(kind='spec_set')` 覆盖全部 requirement 且带 frontier |
| `assumption_set.signed` | 有 open 假设 ⇒ fail；否则须有效 `decision(kind='assumption_set')` 覆盖全部假设（没有假设也要签空集） |
| `dead_field` | 六张主表逐列：有写入方无消费者 ⇒ fail；无写入方 ⇒ `level:"info", why:"no_writer"`；pass 时附 `dead_field_checked` info（扫描列数）作为依据；消费者 = 视图 body / `field_consumer` 行 / `src/query` `src/ui` `src/align` 的字段名读取 |

`dead_field` 的写入方清单在 `deadfield.ts` 的 `ENGINE_WRITERS`：按 fold reducer 实际写的列
列出（注释里点名来源文件）；产品清单不可被测试修改，红例通过 `evaluateDeadField` 的
`options.writers` 注入测试专用列（`@internal test-only`）。

`--preset` 只认 `waterfall`/`prototype`/`incremental`（字面键，`Object.hasOwn` 判断），
`lite` 走 D-043 的 policy 文件，不走 preset；原型链键（如 `toString`）同样 ⇒ `unknown_preset` 退 2。

## 文件

- `evaluate.ts`：读事件链 + fold（`readCheckState`）、core 三判据求值、`dead_field` 转接、
  `stageGap`（C7）。
- `gate.ts`：preset → `Policy`、stage 出口 gate 预览与聚合。
- `deadfield.ts`：内置 `dead_field` 判据。
- `cli.ts`：`npm run check` 的入口（只读打开 + 参数校验 + 退出码）。

## 边界（M1）

- 不是门禁：不写 `gate.judged`、不冻结基线、不阻断任务；M1 只强制 core 三条。
- `provenance.present` 只验 `created_by` 非空（M3 前没有 actor 注册表）；在事件链上
  `created_by` 由 reducer 强制非空，所以该判据 M1 实际恒 pass，红例要等 M3。
- 判据 fail 不改退出码（预览不是门禁）。
