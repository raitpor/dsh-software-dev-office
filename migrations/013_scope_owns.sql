-- SDO v2 · 迁移 013：scope 归属链（user_version 12 -> 13）
-- 卡：M3-1 C9；真源：docs/07 §1（scope 是 module/domain/release 三段前缀）、D-086 的 M3-1 落点。
--
-- 为什么需要这张表：`plan@domain:D` 要放行 `module:M`，但 scope 是自包含字符串，没有隐含的
-- module→domain 映射（D-086：不猜前缀）。归属必须显式登记，判定沿 parent 链向上找。
--
-- 口径：
-- - 一行表示 child_scope 属于 parent_scope；链可以多跳（module:M → domain:D）。
-- - 只追加：update/delete 由触发器拒绝；改归属 = 追加新边（历史可审计）。
-- - 空表 ⇒ 所有跨前缀判定为 `no_ownership`（fail-closed）。
--
-- 重跑安全：建表用 IF NOT EXISTS，不播种（归属是部署/运营数据，不是设计常量）。

CREATE TABLE IF NOT EXISTS scope_owns (
  child_scope  TEXT NOT NULL CHECK (length(child_scope) > 0 AND instr(child_scope, '*') = 0),
  parent_scope TEXT NOT NULL CHECK (length(parent_scope) > 0 AND instr(parent_scope, '*') = 0),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (child_scope, parent_scope),
  CHECK (child_scope <> parent_scope),
  CHECK (
    (child_scope LIKE 'module:%' OR child_scope LIKE 'domain:%' OR child_scope LIKE 'release:%')
    AND (parent_scope LIKE 'module:%' OR parent_scope LIKE 'domain:%' OR parent_scope LIKE 'release:%')
  ),
  CHECK (substr(child_scope, instr(child_scope, ':') + 1) <> ''),
  CHECK (substr(parent_scope, instr(parent_scope, ':') + 1) <> '')
);

CREATE TRIGGER IF NOT EXISTS scope_owns_no_update
BEFORE UPDATE ON scope_owns
BEGIN
  SELECT RAISE(ABORT, 'scope_owns is append-only');
END;

CREATE TRIGGER IF NOT EXISTS scope_owns_no_delete
BEFORE DELETE ON scope_owns
BEGIN
  SELECT RAISE(ABORT, 'scope_owns is append-only');
END;
