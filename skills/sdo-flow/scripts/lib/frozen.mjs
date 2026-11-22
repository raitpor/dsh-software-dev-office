// 冻结段 hash 的唯一定义：重算前删掉 `hash:`、`状态：`、`- 追加签：` 开头行。
// check.mjs 与 lib/trace.mjs 都必须从这里取，禁止各自再实现一份（同判定两份实现会漂移）。
import crypto from "node:crypto";

export function frozenHashRaw(raw) {
  const ls = raw.replace(/\n$/, "").split("\n").filter((l) => !/^hash:/.test(l) && !/^状态：/.test(l) && !/^- 追加签：/.test(l));
  return crypto.createHash("sha256").update(ls.join("\n") + "\n", "utf8").digest("hex");
}
