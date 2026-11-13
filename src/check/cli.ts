/**
 * `sdo_check` CLI（M1-4 C1、C4；`npm run check`）。
 *
 * 退出码（卡假设 A3）：0 = 算完（无论判据 fail 多少）；2 = 参数错/未知判据或 stage；
 * 1 = 工具自身错（库打不开、事件链坏等）。预览不是门禁，判据 fail 不改退出码。
 *
 * 只读：打开库用 `mustExist: true`（不建库），不调用任何写入口。
 */

import { openSdoDatabase } from '../db/open.js';
import { runCheck, type CheckReport, type RunCheckOptions } from './index.js';

interface CliArgs {
  readonly criterion?: string;
  readonly gate?: string;
  readonly preset?: string;
  readonly db?: string;
  readonly pretty: boolean;
}

type ParseResult = { readonly ok: true; readonly args: CliArgs } | { readonly ok: false; readonly message: string };

function parseArgs(argv: readonly string[]): ParseResult {
  const values: { criterion?: string; gate?: string; preset?: string; db?: string } = {};
  let pretty = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pretty') {
      pretty = true;
      continue;
    }
    if (arg === '--criterion' || arg === '--gate' || arg === '--preset' || arg === '--db') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, message: `${arg} 需要参数值` };
      }
      values[arg.slice(2) as 'criterion' | 'gate' | 'preset' | 'db'] = value;
      index += 1;
      continue;
    }
    return { ok: false, message: `未知参数：${arg}` };
  }
  return { ok: true, args: { ...values, pretty } };
}

function emit(payload: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`);
}

function fail(reasonCode: string, message: string, pretty: boolean, exitCode: number): void {
  emit({ ok: false, reason_code: reasonCode, message }, pretty);
  process.exitCode = exitCode;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    fail('invalid_args', parsed.message, false, 2);
    return;
  }
  const args = parsed.args;
  const passphrase = process.env['SDO_DB_PASSPHRASE'];
  if (passphrase === undefined || passphrase.length === 0) {
    fail('tool_error', '缺少 SDO_DB_PASSPHRASE（不提供明文降级）', args.pretty, 1);
    return;
  }
  const dbPath = args.db ?? process.env['SDO_DB_PATH'] ?? './sdo.db';

  const options: RunCheckOptions = {
    ...(args.criterion === undefined ? {} : { criterion: args.criterion }),
    ...(args.gate === undefined ? {} : { gate: args.gate }),
    ...(args.preset === undefined ? {} : { preset: args.preset }),
  };

  let db;
  try {
    db = openSdoDatabase(dbPath, passphrase, { mustExist: true });
  } catch (error) {
    fail('tool_error', error instanceof Error ? error.message : String(error), args.pretty, 1);
    return;
  }

  try {
    const result = runCheck(db, options);
    if (!result.ok) {
      fail(result.reason_code, result.message, args.pretty, 2);
      return;
    }
    emit(result as CheckReport, args.pretty);
  } catch (error) {
    fail('tool_error', error instanceof Error ? error.message : String(error), args.pretty, 1);
  } finally {
    db.close();
  }
}

main();
