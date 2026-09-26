import {
  readFileSync,
  lstatSync,
  existsSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DomainError, text } from '../../../../packages/contracts/src/index.js';
import { exact } from '../../../../packages/contracts/src/nodes.js';
import {
  parsePolicy,
  type ExecutionPolicy,
} from '../../../../packages/contracts/src/node-execution.js';
import { requiredFlags } from '../../../../packages/adapters/claude-code/src/index.js';
import { runProcess } from '../process-host.js';
import type { NodeCredentials } from './storage.js';
export interface LocalExecution {
  version: 1;
  executable: string;
  policy: ExecutionPolicy;
}
export function keyFor(policy: ExecutionPolicy) {
  return process.env[policy.tool === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY']?.trim();
}
function secure(path: string) {
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    (process.getuid && s.uid !== process.getuid()) ||
    s.size > 32768
  )
    throw new DomainError('INSECURE_POLICY', '本机执行授权文件必须为独占的 0600 普通文件');
}
export function readExecutionPolicy(home: string): LocalExecution | null {
  const path = join(home, 'execution.json');
  if (!existsSync(path)) return null;
  secure(path);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value === null) return null;
  const v = exact(value, ['version', 'executable', 'policy']);
  if (v.version !== 1 || typeof v.executable !== 'string' || !isAbsolute(v.executable))
    throw new DomainError('INVALID_POLICY', '本机执行授权无效');
  return { version: 1, executable: v.executable, policy: parsePolicy(v.policy) };
}
export function writeExecutionPolicy(home: string, value: LocalExecution | null) {
  const path = join(home, 'execution.json');
  if (existsSync(path)) secure(path);
  const temp = join(home, `.execution-${randomUUID()}`),
    fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(home, 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export async function probeExecution(executable: string, policy: ExecutionPolicy) {
  if (!isAbsolute(executable) || !statSync(executable).isFile())
    throw new DomainError('INVALID_EXECUTABLE', '需要本机原生工具的绝对文件路径');
  const probe = async (args: string[]) => {
    let out = '';
    const handle = runProcess({
      executable,
      args,
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      timeoutMs: 5000,
      maxOutputBytes: 262144,
      onLine: (line) => {
        out += line + '\n';
      },
    });
    const result = await handle.done;
    if (result.code !== 0 || result.error || !result.terminationConfirmed)
      throw new DomainError('CAPABILITY_UNAVAILABLE', '原生工具探测失败；未发布执行授权');
    return out;
  };
  const version = (await probe(['--version'])).trim().slice(0, 200);
  const help = await probe(policy.tool === 'codex' ? ['app-server', '--help'] : ['--help']);
  const flags = policy.tool === 'codex' ? ['--listen', '--config'] : requiredFlags;
  if (!version || flags.some((flag) => !help.includes(flag)))
    throw new DomainError('CAPABILITY_UNAVAILABLE', '原生工具缺少必要受限参数；不降级权限');
  return version;
}
export async function configureExecution(
  path: string,
  credentials: NodeCredentials,
): Promise<LocalExecution> {
  const raw = readFileSync(path, 'utf8');
  if (raw.length > 32768) throw new DomainError('INVALID_POLICY', '配置过大');
  const b = exact(JSON.parse(raw), [
    'tool',
    'executable',
    'model',
    'mode',
    'workspaces',
    'timeoutSeconds',
    'maxTurns',
    'maxBudgetUsd',
  ]);
  if (!Array.isArray(b.workspaces) || !b.workspaces.length)
    throw new DomainError('INVALID_POLICY', '请选择已配对的目录别名');
  const ids = b.workspaces.map((name) => {
    const directory = credentials.directories.find((w) => w.name === name);
    if (!directory) throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '只能授权已经配对的目录别名');
    return directory.id;
  });
  const specified = text(b.executable, '工具绝对路径', 4096);
  if (!isAbsolute(specified))
    throw new DomainError('INVALID_EXECUTABLE', '工具必须使用本机绝对路径');
  const executable = realpathSync(specified);
  for (const directory of credentials.directories) {
    const r = relative(directory.root, executable);
    if (!r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)))
      throw new DomainError('UNTRUSTED_EXECUTABLE', '原生工具不能安装在可编辑的授权仓库内');
  }
  const policy = parsePolicy({
    grantId: randomUUID(),
    tool: b.tool,
    model: b.model ?? null,
    mode: b.mode,
    workspaceIds: ids,
    timeoutSeconds: b.timeoutSeconds ?? 300,
    maxTurns: b.maxTurns ?? 8,
    maxBudgetUsd: b.tool === 'codex' ? (b.maxBudgetUsd ?? null) : (b.maxBudgetUsd ?? 1),
    toolVersion: 'pending-probe',
  });
  if (!keyFor(policy))
    throw new DomainError(
      'API_KEY_REQUIRED',
      '请只在节点本机环境配置对应 API key，不要写入配置文件或网页',
    );
  policy.toolVersion = await probeExecution(executable, policy);
  return { version: 1, executable, policy };
}
