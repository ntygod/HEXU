import { localIdentityOptions } from '../../../packages/identity/src/config.js';
import { nativeOptionsFromEnvironment } from '../../runner/src/runtime.js';
import { resolve } from 'node:path';
import { createApp } from './app.js';
const host = process.env.HEXU_HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost'].includes(host))
  throw new Error('当前版本仍只支持回环地址；真实账号不等于已完成远程安全部署。');
const port = Number(process.env.HEXU_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('HEXU_PORT 应为 1024–65535 的整数。');
const mode = process.env.HEXU_MODE ?? 'preview';
if (!['preview', 'team-local'].includes(mode))
  throw new Error('HEXU_MODE 必须为 preview 或 team-local');
const team = mode === 'team-local';
if (team && process.env.HEXU_NATIVE_ENABLED === '1')
  throw new Error('team-local 模式禁止启用宿主机原生工具。');
const directory = resolve(process.env.HEXU_DATA_DIR ?? (team ? '.hexu/team' : '.hexu'));
const app = await createApp({
  databasePath: resolve(directory, team ? 'workspace.sqlite' : 'preview.sqlite'),
  identity: team ? localIdentityOptions(directory, port) : undefined,
  port,
  logger: true,
  native: team ? { enabled: false, roots: [] } : nativeOptionsFromEnvironment(),
});
try {
  await app.listen({ host, port });
  console.log(
    `\nHEXU · 合序 http://${host}:${port}\n${team ? '真实账号 · 本机团队开发模式 · 初始化代码见数据目录中的 setup-code' : '本地开发预览 · 示例身份 · 原生能力以资源页为准'} · 不对公网开放\n`,
  );
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
  });
