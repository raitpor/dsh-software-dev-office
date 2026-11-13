/**
 * 游标：不透明 base64url(JSON)，编码 `(view, args, as_of, offset, 最后一行摘要)`（M0-4，判据 C5）。
 *
 * 设计依据：docs/05 §4「超预算截断 + 游标、同一 (view,args,as_of) 确定性」。
 *
 * 为什么带 `as_of`：分页只在同一 snapshot 内成立。续查时若当前 frontier 变了，
 * 查询层拒绝续查（结构化 `stale_as_of`），而不是用 offset 硬翻——否则中间插入会重/漏。
 * `last_row_hash` 是最后一行 JSON 的 sha256 摘要（前 32 个十六进制字符）：续查前按 `offset-1`
 * 重查该行、重算摘要比对，用来核对边界（直接写表而不落事件时也能发现漂移）。
 * 不存整行：整行 base64 约占行宽 4/3，会与行一起挤占 8KB 预算，把中等行打成 `result_too_large`
 * （第 54 轮 P1）；摘要定长 32 字符，比 64 字符省空间，128 bit 碰撞风险对边界核对可忽略。
 */

/** 游标里冻结的查询参数；与当前请求不一致即拒绝续查。 */
export interface CursorArgs {
  readonly view: string;
  readonly select?: readonly string[];
  readonly limit: number;
}

/** 游标载荷；`v` 用于将来演进（旧游标显式失效而不是静默解释错）。 */
export interface CursorPayload {
  readonly v: 1;
  readonly args: CursorArgs;
  readonly as_of: readonly string[];
  readonly offset: number;
  readonly last_row_hash: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 解码并 fail-closed 校验；任何形状不对都抛错，由查询层转成 `invalid_args`。 */
export function decodeCursor(raw: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cursor is not base64url-encoded JSON');
  }
  if (!isPlainObject(parsed)) throw new Error('cursor payload must be an object');
  if (parsed['v'] !== 1) throw new Error('unsupported cursor version');
  if (!isStringArray(parsed['as_of'])) throw new Error('cursor as_of must be a string array');
  const offset = parsed['offset'];
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new Error('cursor offset must be a non-negative integer');
  }
  const lastRowHash = parsed['last_row_hash'];
  if (typeof lastRowHash !== 'string' || !/^[0-9a-f]{32}$/.test(lastRowHash)) {
    throw new Error('cursor last_row_hash must be 32 lowercase hex characters');
  }
  const args = parsed['args'];
  if (!isPlainObject(args)) throw new Error('cursor args must be an object');
  if (typeof args['view'] !== 'string' || args['view'].length === 0) {
    throw new Error('cursor args.view must be a non-empty string');
  }
  const limit = args['limit'];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new Error('cursor args.limit must be a positive integer');
  }
  const select = args['select'];
  if (select !== undefined && !isStringArray(select)) {
    throw new Error('cursor args.select must be a string array when present');
  }
  return {
    v: 1,
    args: { view: args['view'], limit, ...(select === undefined ? {} : { select }) },
    as_of: parsed['as_of'],
    offset,
    last_row_hash: lastRowHash,
  };
}

/** 参数等价：`select` 的顺序参与比较（投影列顺序影响行内 key 顺序）。 */
export function sameCursorArgs(a: CursorArgs, b: CursorArgs): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
