import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REASON_CODES } from '../../../src/core/errors/codes.js';

const ROOT = new URL('../../../../', import.meta.url);
const SRC = new URL('../../../../src/', import.meta.url);

interface Token {
  readonly kind: 'id' | 'str' | 'tmpl' | 'punct';
  readonly text: string;
  readonly line: number;
}

/** TypeScript 7 原生包不导出 compiler API（无 ts.createSourceFile），故用等价词法器扫描。 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  const push = (kind: Token['kind'], value: string): void => {
    tokens.push({ kind, text: value, line });
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') { line += 1; i += 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line += 1; i += 1; }
      i += 2; continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch; i += 1;
      const start = i;
      while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i += 1; if (text[i] === '\n') line += 1; i += 1; }
      push('str', text.slice(start, i));
      i += 1; continue;
    }
    if (ch === '`') {
      i += 1;
      while (i < text.length && text[i] !== '`') { if (text[i] === '\\') i += 1; if (text[i] === '\n') line += 1; i += 1; }
      i += 1; push('tmpl', '`'); continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j]!)) j += 1;
      push('id', text.slice(i, j)); i = j; continue;
    }
    push('punct', ch); i += 1;
  }
  return tokens;
}

function files(): string[] {
  return globSync('**/*.ts', { cwd: SRC })
    .map((rel) => join(SRC.pathname, rel))
    .filter((file) => !file.endsWith('/core/errors/codes.ts'));
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * 白名单只放行“传递参数”这一个形态，并且必须带理由：
 * - freeze-store.ts / gate.ts 的 `failure(reason)` / `fail(reason)` 是统一失败构造器，
 *   参数类型已由调用方收紧；值不是新造码，故不判红（若改成字面量仍会红）。
 * 其余形态（字面量/模板/裸小写标识符/as const 对象）一律违规。
 */
const PASS_THROUGH_PARAM_WHITELIST: Readonly<Record<string, string>> = {
  'src/db/freeze-store.ts': 'failure(reason) 统一失败构造器参数',
  'src/db/gate.ts': 'fail(reason) 统一失败构造器参数',
};

/** 少数“首码透传”的值不是字面量、也不是 CODE 成员，但来源类型仍是联合；列明理由。 */
const PASS_THROUGH_VALUE_WHITELIST: Readonly<Record<string, string>> = {
  'src/db/freeze.ts:first': 'P15 首码透传，来源是 p15.reason_codes 联合',
  'src/core/baseline/freeze.ts:first': 'P15 首码透传，来源是 p15.reason_codes 联合',
  'src/core/pm/queue.ts:reason': 'query miss 映射后的局部联合（no_permission|invalid_args）',
  'src/core/gate/evaluate.ts:reasonCode': '局部联合变量，声明处已收窄',
  'src/core/gate/schema.ts:reasonCode': '局部联合变量，声明处已收窄',
  'src/core/auth/rights.ts:code': 'RightDeny 构造参数，类型为 RightDenyReason',
  'src/claim/gateway.ts:code': 'ClaimFailure 构造参数，类型为 ClaimReason',
  'src/check/cli.ts:reasonCode': '局部联合变量，声明处已收窄',
};

/**
 * 属性赋值白名单：只放行“把已类型化参数写入实例字段”这一种形态，且带理由。
 * 新增条目必须同时改台账 D-208；值为字面量/模板/裸标识符仍红。
 */
const ASSIGNMENT_VALUE_WHITELIST: Readonly<Record<string, string>> = {
  'src/sign/errors.ts:this.reason_code=reason_code':
    'SignError 构造函数把已类型化的 SignReason 参数写入实例（参数声明处已收窄）',
};

/**
 * C2：`reason_code` 的对象字面量赋值必须是 `CODE.<name>`；类型位置允许类型引用，
 * 显式传参放行白名单内“参数名 reason”。词法扫描覆盖字面量/模板/标识符/`as const` 对象。
 */
test('C2: every reason_code value is a CODE.<name> member access (lexical scan)', () => {
  const violations: string[] = [];
  for (const file of files()) {
    const rel = file.slice(file.indexOf('/src/') + 1);
    const toks = tokenize(read(file));
    for (let i = 0; i < toks.length; i += 1) {
      if (toks[i]!.kind !== 'id' || toks[i]!.text !== 'reason_code') continue;
      let j = i + 1;
      if (toks[j]?.text === '?') j += 1;
      if (toks[j]?.text !== ':') continue;
      j += 1;
      const first = toks[j];
      const second = toks[j + 1];
      const third = toks[j + 2];
      const isCode =
        first?.kind === 'id' && first.text === 'CODE' && second?.text === '.' && third?.kind === 'id';
      const isTypeReference =
        (first?.kind === 'id' && /^[A-Z]/.test(first.text) && second?.text !== '.') ||
        (first?.kind === 'id' && ['string', 'boolean', 'number', 'unknown'].includes(first.text)) ||
        (first?.kind === 'id' && first.text === 'typeof' && second?.text === 'CODE' && third?.text === '.');
      const isPassThrough =
        first?.kind === 'id' &&
        second?.text === '.' &&
        third?.kind === 'id' &&
        (third.text === 'reason_code' || third.text === 'reason');
      const isUnionType =
        first?.kind === 'punct' &&
        first.text === '|' &&
        second?.text === 'typeof' &&
        third?.text === 'CODE';
      const isWhitelistedParam =
        first?.kind === 'id' &&
        ((first.text === 'reason' && PASS_THROUGH_PARAM_WHITELIST[rel] !== undefined) ||
          PASS_THROUGH_VALUE_WHITELIST[`${rel}:${first.text}`] !== undefined);
      if (!isCode && !isTypeReference && !isPassThrough && !isUnionType && !isWhitelistedParam) {
        violations.push(`${file}:${first?.line ?? toks[i]!.line} ${first?.kind === 'id' ? first.text : `<${first?.kind ?? 'eof'}>`}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

/**
 * C2（续）：属性赋值与计算属性键也必须是 `CODE.<name>`。
 * 覆盖 `obj.reason_code = value`、`obj['reason_code'] = value`、`{ ['reason_code']: value }`。
 * 不覆盖动态键 `obj[key] = value`（键不是字面量，静态不可证明；card/D-208 已写明）。
 */
test('C2: reason_code property assignments and computed keys use CODE.<name>', () => {
  const violations: string[] = [];
  for (const file of files()) {
    const rel = file.slice(file.indexOf('/src/') + 1);
    const toks = tokenize(read(file));
    for (let i = 0; i < toks.length; i += 1) {
      const tok = toks[i]!;
      if (tok.kind === 'id' && tok.text === 'reason_code' && toks[i - 1]?.text === '.') {
        if (toks[i + 1]?.text !== '=') continue;
        if (toks[i + 2]?.text === '=' || toks[i + 2]?.text === '>') continue; // ==、===、=>
        const rhs = toks[i + 2];
        const lhsPrefix = toks[i - 2]?.text === 'this' ? 'this.reason_code' : 'reason_code';
        const key = `${rel}:${lhsPrefix}=${rhs?.kind === 'id' ? rhs.text : '<non-id>'}`;
        const isCode = rhs?.kind === 'id' && rhs.text === 'CODE' && toks[i + 3]?.text === '.' && toks[i + 4]?.kind === 'id';
        if (!isCode && ASSIGNMENT_VALUE_WHITELIST[key] === undefined) {
          violations.push(`${file}:${tok.line} ${lhsPrefix} = ${rhs?.text ?? '<eof>'}`);
        }
        continue;
      }
      // 字符串键：`obj['reason_code'] = v` 或 `{ ['reason_code']: v }`
      if (tok.kind === 'str' && tok.text === 'reason_code' && toks[i - 1]?.text === '[' && toks[i + 1]?.text === ']') {
        const op = toks[i + 2]?.text;
        if (op !== '=' && op !== ':') continue;
        if (op === '=' && (toks[i + 3]?.text === '=' || toks[i + 3]?.text === '>')) continue;
        const rhs = toks[i + 3];
        const isCode = rhs?.kind === 'id' && rhs.text === 'CODE' && toks[i + 4]?.text === '.' && toks[i + 5]?.kind === 'id';
        if (!isCode) violations.push(`${file}:${tok.line} computed reason_code ${op} ${rhs?.text ?? '<eof>'}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

interface SnapshotProvenance {
  readonly unions_by_file: Readonly<Record<string, readonly string[]>>;
  readonly arrays_by_name: Readonly<Record<string, readonly string[]>>;
}

test('C5: each *_CODES array derives its union and matches the snapshot set exactly', () => {
  const provenance = JSON.parse(
    readFileSync(new URL('../../../../test/core/errors/code-snapshot.json', import.meta.url), 'utf8'),
  ) as SnapshotProvenance;
  const known = new Set(REASON_CODES.map((entry) => entry.code));
  for (const file of Object.keys(provenance.unions_by_file)) {
    const text = read(join(ROOT.pathname, file));
    const arrays = [...text.matchAll(/export const (\w+_(?:CODES|REASONS)) = \[([\s\S]*?)\] as const;/g)];
    assert.ok(arrays.length > 0, `${file}: no *_CODES/*_REASONS array`);
    for (const array of arrays) {
      const name = array[1]!;
      assert.match(text, new RegExp(`export type \\w+ = \\(typeof ${name}\\)\\[number\\];`), name);
      const expected =
        provenance.arrays_by_name[`${file}:${name}`] ??
        (arrays.length === 1 ? provenance.unions_by_file[file] : undefined);
      assert.ok(expected !== undefined, `${file}:${name} missing from snapshot expected sets`);
      const body = (array[2] ?? '').replace(/\/\/[^\n]*/g, '');
      const actualCodes = new Set<string>();
      const actualLiterals = new Set<string>();
      for (const m of body.matchAll(/CODE\.(\w+)/g)) actualCodes.add(m[1]!);
      for (const m of body.matchAll(/'([a-z0-9_]+)'/g)) actualLiterals.add(m[1]!);
      const actual = [...new Set([...actualCodes, ...actualLiterals])].sort();
      assert.deepEqual(actual, [...expected].sort(), `${file}:${name} array set != snapshot set`);
      for (const code of actualCodes) assert.ok(known.has(code), `${file}: ${code} not in table`);
    }
  }
});
