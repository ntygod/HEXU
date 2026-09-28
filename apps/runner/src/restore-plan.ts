import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { localRestorePreflight } from './agent/checkpoint-restore-preflight.js';

async function main() {
  const options = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (
      !['--request', '--state', '--target'].includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new DomainError('INVALID_INPUT', '只接受一次 --request、--state 和 --target 参数');
    options.set(key, value);
  }
  if (options.size !== 3)
    throw new DomainError('INVALID_INPUT', '用法：npm run runner:restore-plan -- --request ID --state HOME --target /绝对路径/全新目录');
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
    historySize: 0,
  });
  const iterator = lines[Symbol.asyncIterator]();
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    lines.close();
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await localRestorePreflight(
      options.get('--state')!,
      options.get('--request')!,
      options.get('--target')!,
      async (prompt) => {
        process.stdout.write(prompt);
        const next = await iterator.next();
        if (next.done) throw new DomainError('CONFIRMATION_REQUIRED', '没有完成本机预检确认');
        return next.value;
      },
      console.log,
      controller.signal,
    );
    console.log(JSON.stringify(result));
    console.log('预检完成；实际文件恢复尚未实现，目标未创建，计划不是写入许可。');
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    lines.close();
  }
}
main().catch((cause: unknown) => {
  console.error(cause instanceof DomainError ? `${cause.code}: ${cause.message}` : '恢复预检失败；未创建目标目录，请核对本机状态与服务连接。');
  process.exitCode = 1;
});
