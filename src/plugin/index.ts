/**
 * 插件生命周期（M5-0 C1/C4/C10/C11）：注册工具、起停控制台与 signerd、dispose 清理。
 *
 * Host 入口 `index.js` 只做 re-export；本文件不 import 宿主包，便于单测直接用假 ctx。
 */

import type { SdoDatabase } from '../db/driver.js';
import { PluginConfigError, resolvePluginSettings, type PluginConfigInput } from './config.js';
import { afterSignerdStop, startSignerdProcess, type SignerdProcessHandle } from './signerd.js';
import { PluginRuntime } from './state.js';
import { buildTools, toolNames, type PluginApprovalService, type PluginTool } from './tools.js';
import { AccountStore } from './accounts.js';
import { ensurePluginBootstrap } from './bootstrap.js';
import { startPageServer, type PageServerHandle } from './page.js';
import { SigningService } from './signing.js';

export interface PluginToolsService {
  register(definition: PluginTool, options?: Record<string, unknown>): () => void;
}

export interface PluginContext {
  readonly tools: PluginToolsService;
  readonly approval?: PluginApprovalService;
  effect?(callback: () => (() => void) | void): () => void;
  get?(name: string): unknown;
}

export interface ActivePlugin {
  /** 配置非法时不创建 runtime（插件保持惰性，不拖垮宿主）。 */
  readonly runtime?: PluginRuntime;
  readonly tools: readonly PluginTool[];
  readonly consolePort: number | undefined;
  dispose(): Promise<void>;
}

export const TOOL_NAMES = ['sdo_query', 'sdo_verify', 'sdo_status', 'sdo_append'] as const;

/** 注册工具并启动附属资源；失败会被记录并抛出（宿主显示插件激活失败）。 */
export async function activatePlugin(
  ctx: PluginContext,
  config: PluginConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ActivePlugin> {
  let runtime: PluginRuntime;
  try {
    runtime = new PluginRuntime(resolvePluginSettings(config, env));
  } catch (error) {
    if (error instanceof PluginConfigError) {
      // P2：配置非法只禁本插件，不抛给宿主；日志给出可诊断原因。
      process.stderr.write(`${JSON.stringify({ event: 'plugin_config_invalid', reason: error.message })}\n`);
      return {
        tools: [],
        consolePort: undefined,
        async dispose(): Promise<void> {
          return;
        },
      };
    }
    throw error;
  }
  const requestId = `plugin-apply-${String(Date.now())}`;
  runtime.log({ event: 'apply', request_id: requestId, elapsed_ms: 0, actor: runtime.settings.actor ?? null });

  let db: SdoDatabase | undefined;
  try {
    db = runtime.open();
  } catch (error) {
    runtime.log({
      event: 'apply_db_unavailable',
      request_id: requestId,
      elapsed_ms: 0,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const accounts = new AccountStore(runtime.settings.stateDir);
  try {
    accounts.load();
    accounts.assertSecure();
  } catch (error) {
    runtime.log({
      event: 'accounts_unavailable',
      request_id: requestId,
      elapsed_ms: 0,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const signing = new SigningService({ signerdHome: runtime.settings.signerdHome });
  if (db !== undefined) {
    try {
      ensurePluginBootstrap(db);
    } catch (error) {
      runtime.log({
        event: 'bootstrap_failed',
        request_id: requestId,
        elapsed_ms: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const tools = buildTools(runtime, { accounts, signing, ...(ctx.approval === undefined ? {} : { approval: ctx.approval }) });
  const disposers: Array<() => void> = [];
  try {
    for (const tool of tools) {
      // 工具 disposer 由宿主 tools 服务托管；不要再给它注册第二个 effect。
      disposers.push(ctx.tools.register(tool));
    }
  } catch (error) {
    // 注册中途失败：回滚已注册的工具，避免宿主里留下半套工具面。
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 回滚失败不掩盖原始注册错误。
      }
    }
    throw error;
  }

  let pageHandle: PageServerHandle | undefined;
  if (runtime.settings.consoleEnabled && db !== undefined) {
    try {
      pageHandle = await startPageServer({ runtime, db, accounts, signing, port: runtime.settings.consolePort });
    } catch (error) {
      runtime.log({
        event: 'page_failed',
        request_id: requestId,
        elapsed_ms: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let signerd: SignerdProcessHandle | undefined;
  if (runtime.settings.signerdAutostart && runtime.settings.signerdPassphrase !== undefined) {
    try {
      signerd = await startSignerdProcess({
        home: runtime.settings.signerdHome,
        passphrase: runtime.settings.signerdPassphrase,
      });
      runtime.log({ event: 'signerd_started', request_id: requestId, elapsed_ms: 0, pid: signerd.pid ?? null });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      runtime.log({
        event: reason === 'signerd_already_running' ? 'signerd_reused' : 'signerd_failed',
        request_id: requestId,
        elapsed_ms: 0,
        reason,
        cleanup_owned_by_plugin: false,
      });
    }
  }

  let disposed = false;
  const plugin: ActivePlugin = {
    runtime,
    tools,
    consolePort: pageHandle?.port,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await pageHandle?.close().catch(() => undefined);
      await signing.dispose().catch(() => undefined);
      // P1-1：只清理本插件真正 spawn 的那份；复用外部实例时绝不 unlink 它的 socket/lock。
      if (signerd !== undefined) {
        const stopped = await signerd.stop().catch(() => false);
        await afterSignerdStop(signerd, stopped, (detail) => {
          runtime.log({
            event: 'signerd_stop_incomplete',
            request_id: requestId,
            elapsed_ms: 0,
            pid: detail.pid ?? null,
            socket: detail.socket,
          });
        });
      }
      for (const dispose of disposers) dispose();
      runtime.dispose();
      runtime.log({ event: 'dispose', request_id: requestId, elapsed_ms: 0 });
    },
  };
  // P2：宿主卸载路径只注册这一个生命周期 disposer；dispose 自身也幂等。
  if (ctx.effect !== undefined) ctx.effect(() => () => { void plugin.dispose(); });
  return plugin;
}

export function pluginToolNames(): readonly string[] {
  return toolNames(buildTools(new PluginRuntime(resolvePluginSettings({}, {}))));
}
