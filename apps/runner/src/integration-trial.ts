import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import {
  parseIntegrationConflictSelection,
  type IntegrationConflictSelection,
} from '../../../packages/contracts/src/integration-conflict-selection.js';
import { integrationTrialSelection, localIntegrationTrial } from './agent/integration-trial.js';
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
async function main() {
  const options = new Map<string, string>(),
    args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--operation', '--state', '--target', '--files', '--selection'].includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new DomainError(
        'INVALID_INPUT',
        '只接受 --operation ID --state HOME --target NEW_ABSOLUTE_DIRECTORY --files JSON_ARRAY 或 --selection VERSION_2_JSON（互斥）',
      );
    options.set(key, value);
  }
  if (
    options.size !== 4 ||
    !options.has('--operation') ||
    !options.has('--state') ||
    !options.has('--target') ||
    options.has('--files') === options.has('--selection')
  )
    throw new DomainError(
      'INVALID_INPUT',
      '用法：npm run runner:integration-trial -- --operation ID --state HOME --target NEW_ABSOLUTE_DIRECTORY --files \'["path"]\'',
    );
  let paths: string[], conflictSelection: IntegrationConflictSelection | undefined;
  try {
    if (options.has('--selection')) {
      conflictSelection = parseIntegrationConflictSelection(
        JSON.parse(options.get('--selection')!),
      );
      paths = conflictSelection.selectedPaths;
    } else paths = integrationTrialSelection(JSON.parse(options.get('--files')!));
  } catch {
    throw new DomainError(
      'INVALID_INPUT',
      '--files 必须是旧无冲突路径数组；--selection 必须是明确版本2整文件决策JSON，两者只能选一项',
    );
  }
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
    const result = await localIntegrationTrial(
      options.get('--state')!,
      options.get('--operation')!,
      options.get('--target')!,
      paths,
      async (prompt) => {
        process.stdout.write(prompt);
        const next = await iterator.next();
        if (next.done) throw new DomainError('CONFIRMATION_REQUIRED', '未完成本机确认');
        return next.value;
      },
      { signal: controller.signal, conflictSelection },
    );
    console.log(JSON.stringify(result));
    if (result.state !== 'ready') process.exitCode = 1;
    else
      console.log(
        `另行只读核验并选择共享候选差异：npm run runner:integration-trial-diff -- --operation ${shellQuote(options.get('--operation')!)} --state ${shellQuote(options.get('--state')!)} --trial ${shellQuote(result.id)}`,
      );
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
      : '本机试应用未确认；保留原日志与现场，不自动重试或清理。',
  );
  process.exitCode = 1;
});
