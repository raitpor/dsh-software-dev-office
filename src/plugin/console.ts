/**
 * 独立只读控制台（M5-0 C3 退路）。
 *
 * 宿主 Web UI 插槽在本卡未验证可用，因此先提供 127.0.0.1 的独立只读页；
 * 身份来自插件配置，缺身份不启动（fail-closed）。README 写缺口。
 */

import type { Server } from 'node:http';

import type { SdoDatabase } from '../db/driver.js';
import { createConsoleServer } from '../ui/server.js';
import type { PluginRuntime } from './state.js';

export interface ConsoleHandle {
  readonly port: number;
  readonly host: '127.0.0.1';
  close(): Promise<void>;
}

export async function startPluginConsole(runtime: PluginRuntime, db: SdoDatabase): Promise<ConsoleHandle> {
  const actor = runtime.settings.actor;
  if (actor === undefined || actor.length === 0) {
    runtime.log({ event: 'console_skipped', request_id: 'console', elapsed_ms: 0, reason: 'missing_actor' });
    throw new Error('控制台需要身份：SDO_PLUGIN_ACTOR 未设置（fail-closed）');
  }
  const server: Server = createConsoleServer({ db, actor, actorKind: runtime.settings.actorKind });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(runtime.settings.consolePort, '127.0.0.1');
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : runtime.settings.consolePort;
  runtime.log({ event: 'console_listening', request_id: 'console', elapsed_ms: 0, port });
  return {
    port,
    host: '127.0.0.1',
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
