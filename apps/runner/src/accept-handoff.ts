import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { acceptLocalHandoff } from './agent/handoff-acceptance.js';

async function main() {
  const args = process.argv.slice(2),
    values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (
      !['--state', '--operation', '--target'].includes(k) ||
      values.has(k) ||
      !v ||
      v.startsWith('--')
    )
      throw new DomainError(
        'INVALID_INPUT',
        '仅接受一次 --state、--operation、--target；不接受网页路径或模型参数',
      );
    values.set(k, v);
  }
  if (values.size !== 3)
    throw new DomainError(
      'INVALID_INPUT',
      '用法：runner:handoff-accept -- --operation ID --state 原接收状态目录 --target 本机已恢复目录',
    );
  const abort = new AbortController(),
    lines = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !!process.stdin.isTTY,
      historySize: 0,
    });
  const iterator = lines[Symbol.asyncIterator]();
  const stop = () => {
    abort.abort();
    lines.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const op = await acceptLocalHandoff(
      values.get('--state')!,
      values.get('--operation')!,
      values.get('--target')!,
      async (prompt) => {
        process.stdout.write(prompt);
        const line = await iterator.next();
        return line.done ? '' : line.value;
      },
      { signal: abort.signal },
    );
    console.log(
      JSON.stringify({
        operation: op.ticket.id,
        state: op.state,
        acceptedAt: op.acceptedAt,
        modelExecutionAuthorized: false,
      }),
    );
    if (op.state !== 'succeeded') process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    lines.close();
  }
}
main().catch((cause: unknown) => {
  console.error(
    cause instanceof DomainError
      ? `${cause.code}: ${cause.message}`
      : '接手确认未完成；保留原状态目录，使用相同命令对账。',
  );
  process.exitCode = 1;
});
