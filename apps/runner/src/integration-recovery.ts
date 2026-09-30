import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { recoverIntegration } from './agent/integration-recovery.js';

async function main() {
  const args = process.argv.slice(2),
    options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--operation', '--state'].includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new DomainError('INVALID_INPUT', '只接受 --operation ID 与 --state HOME');
    options.set(key, value);
  }
  if (options.size !== 2)
    throw new DomainError(
      'INVALID_INPUT',
      '用法：npm run runner:integration-recover -- --operation ID --state HOME',
    );
  const lines = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !!process.stdin.isTTY,
      historySize: 0,
    }),
    iterator = lines[Symbol.asyncIterator]();
  try {
    console.log(
      JSON.stringify(
        await recoverIntegration(
          options.get('--state')!,
          options.get('--operation')!,
          async (prompt) => {
            process.stdout.write(prompt);
            const next = await iterator.next();
            if (next.done) throw new DomainError('CONFIRMATION_REQUIRED', '未完成本机停止确认');
            return next.value;
          },
        ),
      ),
    );
  } finally {
    lines.close();
  }
}
main().catch((cause) => {
  console.error(
    cause instanceof DomainError
      ? `${cause.code}: ${cause.message}`
      : '本机结算未确认；保留原凭证、应用证据与结算记录后重试。',
  );
  process.exitCode = 1;
});
