import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { cleanupIntegrationTrial } from './agent/integration-trial-cleanup.js';
async function main() {
  const options = new Map<string, string>(),
    args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--operation', '--trial', '--state'].includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new DomainError(
        'INVALID_INPUT',
        '只接受 --operation ID --trial ID --state HOME，不接受目标路径、强制或递归清理',
      );
    options.set(key, value);
  }
  if (options.size !== 3)
    throw new DomainError(
      'INVALID_INPUT',
      '用法：npm run runner:integration-trial-cleanup -- --operation ID --trial ID --state HOME',
    );
  const lines = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !!process.stdin.isTTY,
      historySize: 0,
    }),
    iterator = lines[Symbol.asyncIterator]();
  const stop = () => lines.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await cleanupIntegrationTrial(
      options.get('--state')!,
      options.get('--operation')!,
      options.get('--trial')!,
      async (prompt) => {
        process.stdout.write(prompt);
        const next = await iterator.next();
        if (next.done) throw new DomainError('CONFIRMATION_REQUIRED', '未完成本机停止与清理确认');
        return next.value;
      },
    );
    console.log(
      result.historical
        ? '仅返回原暂存清理收据；未读取或删除当前目录。'
        : '本次已知未发布暂存已按明确确认清理；原试应用状态和所有权记录保留为历史。',
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
      : '暂存处置未确认；保留原日志、剩余材料和凭证，不自动重试或清理其他目录。',
  );
  process.exitCode = 1;
});
