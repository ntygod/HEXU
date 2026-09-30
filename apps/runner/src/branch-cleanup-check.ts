import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { checkBranchCleanup } from './agent/branch-cleanup-check.js';

async function main() {
  const args = process.argv.slice(2),
    options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--branch', '--revision', '--task-revision', '--retention', '--state'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      options.has(key)
    )
      throw new DomainError('INVALID_INPUT', '清理前核对参数无效或重复');
    options.set(key, value);
  }
  if (options.size !== 5)
    throw new DomainError(
      'INVALID_INPUT',
      '需要 --branch ID --revision N --task-revision N --retention ID --state HOME；没有删除参数',
    );
  const lines = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !!process.stdin.isTTY,
      historySize: 0,
    }),
    iterator = lines[Symbol.asyncIterator]();
  try {
    const result = await checkBranchCleanup(
      options.get('--state')!,
      {
        branchId: options.get('--branch'),
        expectedRevision: Number(options.get('--revision')),
        expectedTaskRevision: Number(options.get('--task-revision')),
        retentionId: options.get('--retention'),
      },
      async (prompt) => {
        process.stdout.write(prompt);
        const item = await iterator.next();
        return item.done ? '' : item.value;
      },
    );
    console.log(JSON.stringify(result));
    console.log('本次核对通过；这不是删除许可，目录、绑定和历史保持。用户后续编辑会使本观察过时。');
  } finally {
    lines.close();
  }
}
main().catch((cause: unknown) => {
  console.error(
    JSON.stringify(
      cause instanceof DomainError
        ? { code: cause.code, message: cause.message, deletionAuthorized: false }
        : {
            code: 'BRANCH_CLEANUP_CHECK_FAILED',
            message: '未能确认完整现场与副本；保留目录、凭证、日志和占用，没有删除授权',
            deletionAuthorized: false,
          },
    ),
  );
  process.exitCode = 1;
});
