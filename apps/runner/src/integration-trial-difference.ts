import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { shareIntegrationTrialDifference } from './agent/integration-trial-difference.js';
async function main() {
  const options = new Map<string, string>(),
    args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--operation', '--state', '--trial'].includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new DomainError('INVALID_INPUT', '只接受 --operation ID --state HOME --trial TRIAL_ID');
    options.set(key, value);
  }
  if (options.size !== 3)
    throw new DomainError(
      'INVALID_INPUT',
      '用法：npm run runner:integration-trial-diff -- --operation ID --state HOME --trial TRIAL_ID',
    );
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
    historySize: 0,
  });
  const iterator = lines[Symbol.asyncIterator](),
    controller = new AbortController();
  const stop = () => {
    controller.abort();
    lines.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await shareIntegrationTrialDifference(
      options.get('--state')!,
      options.get('--operation')!,
      options.get('--trial')!,
      async (prompt) => {
        process.stdout.write(prompt);
        const next = await iterator.next();
        if (next.done) throw new DomainError('CONFIRMATION_REQUIRED', '未完成本机确认');
        return next.value;
      },
      { signal: controller.signal },
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
      : '候选差异未确认；保留原固定报告与凭证，重试只对账已授权待发包。',
  );
  process.exitCode = 1;
});
