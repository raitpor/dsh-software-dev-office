-- M1-6 C7：claim 只追加（docs/03 §3：结论行一经生成不可改写）。
-- 与 001 的 event/baseline 同口径：UPDATE/DELETE 一律库层拒绝；
-- `recursive_triggers=ON` 已在 openEncryptedDatabase 显式设置，INSERT OR REPLACE 也走 DELETE 触发器。
CREATE TRIGGER trg_claim_append_only_update
BEFORE UPDATE ON claim
BEGIN
  SELECT RAISE(ABORT, 'claim is append-only: UPDATE rejected');
END;

CREATE TRIGGER trg_claim_append_only_delete
BEFORE DELETE ON claim
BEGIN
  SELECT RAISE(ABORT, 'claim is append-only: DELETE rejected');
END;
