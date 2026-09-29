import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import {
  prepareHandoffWorkspace,
  cleanupHandoffWorkspace,
  readGitWorkspaceProgress,
} from './agent/handoff-workspace.js';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function main() {
  const [mode, ...args] = process.argv.slice(2),
    options = new Map<string, string>();
  if (!['prepare', 'status', 'cleanup'].includes(mode ?? ''))
    throw new DomainError('INVALID_INPUT', '仅接受prepare/status/cleanup');
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]!,
      v = args[i + 1];
    if (
      !['--state', '--operation', '--target'].includes(k) ||
      options.has(k) ||
      !v ||
      v.startsWith('--')
    )
      throw new DomainError('INVALID_INPUT', '参数无效或重复');
    options.set(k, v);
  }
  if (
    !options.has('--state') ||
    !options.has('--operation') ||
    (mode === 'prepare' ? options.size !== 3 : options.size !== 2)
  )
    throw new DomainError(
      'INVALID_INPUT',
      '需要--state/--operation；prepare另需--target原接手目录',
    );
  const home = options.get('--state')!,
    id = options.get('--operation')!;
  if (mode === 'status') {
    console.log(
      JSON.stringify({
        lastRecorded: readGitWorkspaceProgress(home, id),
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
    }),
    iterator = lines[Symbol.asyncIterator]();
  try {
    const ask = async (prompt: string) => {
      process.stdout.write(prompt);
      const next = await iterator.next();
      return next.done ? '' : next.value;
    };
    const p =
      mode === 'prepare'
        ? await prepareHandoffWorkspace(home, id, options.get('--target')!, ask)
        : await cleanupHandoffWorkspace(home, id, ask);
    console.log(
      JSON.stringify({
        lastRecorded: p,
        currentFilesVerified: false,
        modelExecutionAuthorized: false,
      }),
    );
    if (p.state === 'ready' && p.nodeState && p.configPath)
      console.log(
        `Git现场已准备。请用自己的账号在原项目生成配对码，然后执行：\nnpm run runner -- connect --state ${quote(p.nodeState)} --config ${quote(p.configPath)}\n随后在该独立节点单独 enable-execution 并 start；此步骤不会复用旧节点凭证或启动模型。`,
      );
    if (p.state === 'needs_attention') process.exitCode = 1;
  } finally {
    lines.close();
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof DomainError
      ? `${error.code}: ${error.message}`
      : 'Git现场准备未确认，请保留原目录与本机记录。',
  );
  process.exitCode = 1;
});
