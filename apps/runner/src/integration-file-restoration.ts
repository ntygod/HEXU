import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { restoreIntegrationFiles } from './agent/integration-file-restoration.js';
async function main() {
  const options = new Map<string, string>(),
    args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--operation', '--restoration', '--state', '--backup'].includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new DomainError(
        'INVALID_INPUT',
        '只接受 --operation ID、--restoration ID、--state HOME 与文件恢复所需的 --backup 全新绝对路径',
      );
    options.set(key, value);
  }
  if (!options.has('--operation') || !options.has('--restoration') || !options.has('--state'))
    throw new DomainError(
      'INVALID_INPUT',
      '用法：npm run runner:integration-restore -- --operation ID --restoration ID --state HOME --backup NEW_PATH',
    );
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
    historySize: 0,
  });
  const iterator = lines[Symbol.asyncIterator]();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await restoreIntegrationFiles(
      options.get('--state')!,
      options.get('--operation')!,
      options.get('--restoration')!,
      async (prompt) => {
        process.stdout.write(prompt);
        const next = await iterator.next();
        if (next.done) throw new DomainError('CONFIRMATION_REQUIRED', '未完成本机确认');
        return next.value;
      },
      console.log,
      controller.signal,
      { backup: options.get('--backup') },
    );
    console.log(JSON.stringify(result));
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    lines.close();
  }
}
main().catch((cause) => {
  console.error(
    cause instanceof DomainError
      ? `${cause.code}: ${cause.message}`
      : '文件恢复未确认；保留原记录，请核对本机状态与连接。',
  );
  process.exitCode = 1;
});
