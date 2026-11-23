# 出口勾选表：<M> 阶段门

> 使用前须替换：把 `<M>`、`<preset>`、`<gate-id>` 换成实际值，并按 `presets/<preset>.md` 的 `G_*` criteria 逐条复制行——**`<gate-id>` 与每行第一个单元格必须换成该 preset 里真实存在的 gate id 与 criteria id（形如 `G_harden_exit`）**，否则 `gate.mjs --file` 只会报「找不到 gate id」，读的人不知道要换什么。**本模板不含顶层勾选表**（示例在代码块里），避免被 `gate.mjs --file` 误判为某道门。

> 用途：阶段出口勾选表：把某阶段 gate 的 criteria 逐条列出，供人勾选判读。**它不写 overall**——overall 属读数门，见 `readings.md`。

> gate：`<gate-id>`（本文件对应哪道 gate；一文件多 gate 时按 `## <gate-id>` 分段）

证据时点：<ISO> ｜ 被取证树：`<commit>` ｜ 命令：见下

## 1. 出口勾选表（对应 preset 的 `G_*`）

```
| # | 判据 | 判据说明 | 证据（命令/文件:行） | 判定 |
|---|---|---|---|---|
| 1 | <preset criteria> |  |  | pass / partial / fail |
| 2 |  |  |  |  |
```

> core 三条每个出口都要过：`spec_set.signed`、`assumption_set.signed`、`provenance.present`。

## 2. 偏差（没过的项）

| 判据 | 为什么没过 | 下一步 | 谁接受 partial |
|---|---|---|---|

## 3. 人签

- 选项：签：接受 overall partial / 改：复述不准（请指出） / 不签：先不做（三选一必须以「签：/改：/不签：」开头）
- 时间：<ISO>
- 被签对象：<commit + 本文件 sha256>
