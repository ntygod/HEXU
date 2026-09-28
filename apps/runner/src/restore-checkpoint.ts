import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { localRestoreCheckpoint, cleanupRestoreCheckpoint } from './agent/checkpoint-restore.js';
import { readRestoreProgress } from './agent/checkpoint-restore-journal.js';

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!['restore', 'status', 'cleanup'].includes(mode ?? ''))
    throw new DomainError('INVALID_INPUT', '只接受 restore/status/cleanup');
  const options = new Map<string, string>();
  const allowed =
    mode === 'restore' ? ['--state', '--request', '--target'] : ['--state', '--target'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (!allowed.includes(key) || options.has(key) || !value || value.startsWith('--'))
      throw new DomainError('INVALID_INPUT', '参数缺失、重复或不受支持；不接受网页计划或写入许可');
    options.set(key, value);
  }
  if (options.size !== allowed.length)
    throw new DomainError(
      'INVALID_INPUT',
      `需要 ${allowed.join('、')}；--target 为全新目录的规范绝对路径`,
    );
  const home = options.get('--state')!,
    target = options.get('--target')!;
  if (mode === 'status') {
    console.log(
      JSON.stringify({
        lastRecorded: readRestoreProgress(home, target),
        currentFilesVerified: false,
        modelExecutionAuthorized: false,
      }),
    );
    return;
  }
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
  const ask = async (prompt: string) => {
    process.stdout.write(prompt);
    if (controller.signal.aborted) return '';
    const next = await iterator.next();
    return next.done || controller.signal.aborted ? '' : next.value;
  };
  try {
    const progress =
      mode === 'cleanup'
        ? await cleanupRestoreCheckpoint(home, target, ask)
        : await localRestoreCheckpoint(home, options.get('--request')!, target, ask, {
            signal: controller.signal,
            onProgress: (p) => {
              console.log(JSON.stringify({ progress: p }));
            },
          });
    console.log(JSON.stringify({ lastRecorded: progress, modelExecutionAuthorized: false }));
    if (mode === 'restore' && progress.state !== 'restored') {
      console.error(
        '恢复没有确认完成；请用 runner:restore-status 查看最后记录。暂存仅可用 runner:restore-cleanup 明确清理，不能自动重跑或删除目标。',
      );
      process.exitCode = controller.signal.aborted ? 130 : 1;
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    lines.close();
  }
}
main().catch((cause: unknown) => {
  console.error(
    cause instanceof DomainError
      ? `${cause.code}: ${cause.message}`
      : '恢复操作失败；请核对本机持久日志与文件状态，不自动重试或清理。',
  );
  process.exitCode = 1;
});
