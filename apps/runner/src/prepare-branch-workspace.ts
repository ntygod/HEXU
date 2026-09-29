import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import {
  prepareBranchWorkspace,
  bindBranchWorkspace,
  readBranchWorkspaceStatus,
  cleanupBranchPreparation,
} from './agent/branch-workspace.js';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function main() {
  const [mode, ...args] = process.argv.slice(2),
    options = new Map<string, string>();
  if (!['prepare', 'status', 'bind', 'cleanup'].includes(mode ?? ''))
    throw new DomainError('INVALID_INPUT', '仅接受prepare/status/bind/cleanup');
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--state', '--operation', '--target'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      options.has(key)
    )
      throw new DomainError('INVALID_INPUT', '参数无效或重复');
    options.set(key, value);
  }
  if (
    !options.has('--state') ||
    (mode === 'bind'
      ? options.size !== 1
      : !options.has('--operation') ||
        (mode === 'prepare' ? options.size !== 3 : options.size !== 2))
  )
    throw new DomainError(
      'INVALID_INPUT',
      'prepare需要state/operation/target；bind仅需新节点state；status/cleanup需原state/operation',
    );
  const home = options.get('--state')!,
    id = options.get('--operation')!;
  if (mode === 'status') {
    console.log(
      JSON.stringify({
        lastRecorded: readBranchWorkspaceStatus(home, id),
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
  const ask = async (prompt: string) => {
    process.stdout.write(prompt);
    const item = await iterator.next();
    return item.done ? '' : item.value;
  };
  try {
    if (mode === 'bind') {
      const value = await bindBranchWorkspace(home, ask);
      console.log(JSON.stringify({ lastRecorded: value, startsModel: false }));
      if (value.state !== 'bound') process.exitCode = 1;
      return;
    }
    const p =
      mode === 'cleanup'
        ? await cleanupBranchPreparation(home, id, ask)
        : await prepareBranchWorkspace(home, id, options.get('--target')!, ask);
    console.log(
      JSON.stringify({
        lastRecorded: p,
        currentFilesVerified: false,
        modelExecutionAuthorized: false,
      }),
    );
    if (p.git?.nodeState && p.git.configPath && p.result?.state === 'prepared')
      console.log(
        `现场已准备，请用本人原项目配对码确认独立节点：\nnpm run runner -- connect --state ${quote(p.git.nodeState)} --config ${quote(p.git.configPath)}\n配对后登记到方案：\nnpm run runner:branch-bind -- --state ${quote(p.git.nodeState)}\n随后在这个新state单独enable-execution并start，再从原方案发起新Run。`,
      );
    if (p.phase === 'needs_attention' || p.phase === 'pending') process.exitCode = 1;
  } finally {
    lines.close();
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof DomainError
      ? `${error.code}: ${error.message}`
      : '方案现场尚未确认，请保留原目录和本机记录。',
  );
  process.exitCode = 1;
});
