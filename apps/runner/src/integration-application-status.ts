import { DomainError } from '../../../packages/contracts/src/index.js';
import { readIntegrationApplicationStatus } from './agent/integration-application-status.js';

function main() {
  const options = new Map<string, string>(),
    args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!,
      value = args[index + 1];
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
      '用法：npm run runner:integration-status -- --operation ID --state HOME',
    );
  console.log(
    JSON.stringify(
      readIntegrationApplicationStatus(options.get('--state')!, options.get('--operation')!),
    ),
  );
}

try {
  main();
} catch (cause) {
  console.error(
    JSON.stringify(
      cause instanceof DomainError
        ? { code: cause.code, message: cause.message }
        : {
            code: 'INTEGRATION_JOURNAL_UNREADABLE',
            message: '无法只读取得原应用快照；保留日志、凭证与写锁后重试',
          },
    ),
  );
  process.exitCode = 1;
}
