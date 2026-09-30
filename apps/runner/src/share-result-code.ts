import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { shareResultCode } from './agent/result-code.js';
async function main() {
  const options = new Map<string, string>(),
    args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--revision', '--state'].includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new DomainError('INVALID_INPUT', '只接受 --revision ID 与 --state HOME');
    options.set(key, value);
  }
  if (options.size !== 2)
    throw new DomainError(
      'INVALID_INPUT',
      '用法：npm run runner:result-code -- --revision ID --state HOME',
    );
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
    historySize: 0,
  });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    const result = await shareResultCode(
      options.get('--state')!,
      options.get('--revision')!,
      async (prompt) => {
        process.stdout.write(prompt);
        const next = await iterator.next();
        if (next.done) throw new DomainError('CONFIRMATION_REQUIRED', '未完成本机确认');
        return next.value;
      },
    );
    console.log(JSON.stringify(result));
  } finally {
    lines.close();
  }
}
main().catch((cause) => {
  console.error(
    cause instanceof DomainError
      ? `${cause.code}: ${cause.message}`
      : '代码差异共享失败；保留原记录，请核对本机状态与连接。',
  );
  process.exitCode = 1;
});
