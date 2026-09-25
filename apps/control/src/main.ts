import { nativeOptionsFromEnvironment } from '../../runner/src/runtime.js';
import { resolve } from 'node:path';
import { createApp } from './app.js';
const host = process.env.HEXU_HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost'].includes(host))
  throw new Error('HEXU local-preview 尚未实现多人身份认证，拒绝监听非回环地址。');
const port = Number(process.env.HEXU_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('HEXU_PORT 应为 1024–65535 的整数。');
const app = await createApp({
  databasePath: resolve(process.env.HEXU_DATA_DIR ?? '.hexu', 'preview.sqlite'),
  port,
  logger: true,
  native: nativeOptionsFromEnvironment(),
});
try {
  await app.listen({ host, port });
  console.log(
    `\nHEXU · 合序 http://${host}:${port}\n本地开发预览 · 示例身份 · 原生能力以资源页为准 · 不对公网开放\n`,
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
