import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { localTransfer } from './agent/checkpoint-transfer.js';
const abort = new AbortController();
const stop = () => abort.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
let lines: ReturnType<typeof createInterface> | undefined;
try {
  const { values, positionals, tokens } = parseArgs({
    tokens: true,
    allowPositionals: true,
    strict: true,
    options: { state: { type: 'string' }, transfer: { type: 'string' } },
  });
  const flags = tokens.filter((t) => t.kind === 'option').map((t) => t.name);
  if (new Set(flags).size !== flags.length) throw new DomainError('INVALID_INPUT', '参数不能重复');
  const mode = positionals[0];
  if (
    positionals.length !== 1 ||
    !['accept', 'send', 'receive', 'status', 'forget'].includes(mode ?? '') ||
    !values.state ||
    !values.transfer
  )
    throw new DomainError(
      'INVALID_INPUT',
      '用法：runner:transfer <accept|send|receive|status|forget> --transfer ID --state 原私有状态目录',
    );
  lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
    historySize: 0,
  });
  const iterator = lines[Symbol.asyncIterator]();
  const onAbort = () => lines?.close();
  abort.signal.addEventListener('abort', onAbort, { once: true });
  const result = await localTransfer(
    values.state,
    values.transfer,
    mode as 'accept' | 'send' | 'receive' | 'status' | 'forget',
    async (prompt) => {
      process.stdout.write(prompt);
      const next = await iterator.next();
      if (next.done) throw new DomainError('CONFIRMATION_REQUIRED', '未完成本机确认');
      return next.value;
    },
    console.log,
    abort.signal,
  );
  console.log(JSON.stringify(result));
} catch (cause) {
  console.error(
    cause instanceof DomainError
      ? `${cause.code}: ${cause.message}`
      : 'TRANSFER_FAILED: 操作未获确认，固定日志保留；请核对本机记录，不自动重试。',
  );
  process.exitCode = 1;
} finally {
  lines?.close();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
