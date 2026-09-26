import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, sep, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  publicName,
  NODE_MAX_WORKSPACES,
  type GitSummary,
  type NodeSnapshot,
} from '../../../../packages/contracts/src/nodes.js';
const exec = promisify(execFile);
export interface LocalDirectory {
  id: string;
  name: string;
  root: string;
  rootIdentity: string;
  gitDir: string;
  gitIdentity: string;
}
const identity = async (path: string) => {
  const s = await stat(path);
  return `${s.dev}:${s.ino}`;
};
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
};

async function git(root: string, args: string[]) {
  // Inherit no user-supplied GIT_* switches. Disable repository-configured helpers
  // that status could otherwise execute. Never invoke a shell, hooks or providers.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SYSTEMROOT: process.env.SYSTEMROOT,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  return (
    await exec(
      'git',
      [
        '--no-optional-locks',
        '-C',
        root,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'status.renames=false',
        ...args,
      ],
      { env, timeout: 4000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    )
  ).stdout;
}
export async function authorizeDirectories(
  input: { name: string; path: string }[],
  stateDirectory?: string,
): Promise<LocalDirectory[]> {
  if (!Array.isArray(input) || input.length < 1 || input.length > NODE_MAX_WORKSPACES)
    throw new DomainError('INVALID_CONFIG', `需要 1–${NODE_MAX_WORKSPACES} 个明确的 Git 根目录`);
  const roots: LocalDirectory[] = [];
  for (const item of input) {
    try {
      const name = publicName(item.name),
        root = await realpath(resolve(item.path));
      const top = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim());
      if (root !== top) throw new Error('not a Git root');
      if (
        stateDirectory &&
        (inside(root, await realpath(stateDirectory)) ||
          inside(await realpath(stateDirectory), root))
      )
        throw new DomainError(
          'STATE_INSIDE_WORKSPACE',
          '节点状态目录必须在授权仓库之外，防止凭证被加入 Git',
        );
      if (
        roots.some((old) => old.name === name || inside(old.root, root) || inside(root, old.root))
      )
        throw new DomainError('OVERLAPPING_WORKSPACES', '不能重复授权目录、别名或重叠路径');
      const gitDir = await realpath((await git(root, ['rev-parse', '--absolute-git-dir'])).trim());
      roots.push({
        id: randomUUID(),
        name,
        root,
        rootIdentity: await identity(root),
        gitDir,
        gitIdentity: await identity(gitDir),
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'WORKSPACE_UNAVAILABLE',
        '目录不可访问或不是可用的 Git 工作树根目录；没有执行仓库脚本',
      );
    }
  }
  return roots;
}
export function countStatus(output: string) {
  let staged = 0,
    modified = 0,
    untracked = 0,
    conflicts = 0;
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('Invalid porcelain');
    const xy = entry.slice(0, 2);
    if (xy === '??') {
      untracked++;
      continue;
    }
    if (xy === '!!') continue;
    if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)) {
      conflicts++;
      continue;
    }
    if (xy[0] !== ' ' && xy[0] !== '?') staged++;
    if (xy[1] !== ' ' && xy[1] !== '?') modified++;
    if (xy.includes('R') || xy.includes('C')) i++; // v1 -z has an extra original-path entry.
  }
  return { staged, modified, untracked, conflicts };
}
export async function captureDirectory(w: LocalDirectory): Promise<GitSummary> {
  const summary: GitSummary = {
    id: w.id,
    state: 'unavailable',
    capturedAt: new Date().toISOString(),
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
  };
  try {
    if (
      (await realpath(w.root)) !== w.root ||
      (await identity(w.root)) !== w.rootIdentity ||
      (await identity(w.gitDir)) !== w.gitIdentity ||
      (await realpath((await git(w.root, ['rev-parse', '--absolute-git-dir'])).trim())) !== w.gitDir
    ) {
      return { ...summary, state: 'authorization_changed' };
    }
    const output = await git(w.root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--ignore-submodules=all',
    ]);
    // Recheck after capture; no summary is sent for a replaced authorization target.
    if ((await identity(w.root)) !== w.rootIdentity || (await identity(w.gitDir)) !== w.gitIdentity)
      return { ...summary, state: 'authorization_changed' };
    return {
      ...summary,
      state: 'available',
      ...countStatus(output),
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return summary;
  } // Never send raw Git stderr, filenames or absolute paths.
}
export async function captureSnapshot(directories: LocalDirectory[]): Promise<NodeSnapshot> {
  const workspaces = await Promise.all(directories.map(captureDirectory));
  return { capturedAt: new Date().toISOString(), workspaces };
}
