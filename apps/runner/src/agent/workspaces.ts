import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat, open, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, isAbsolute, sep, resolve, join } from 'node:path';
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
  // Inherit no user-supplied GIT_* switches. Discovery/config reads never refresh
  // the index. Status MUST use the isolated metadata directory below: disabling
  // fsmonitor/hooks alone does not prevent clean/process filter execution.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SYSTEMROOT: process.env.SYSTEMROOT,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  return (
    await exec(
      'git',
      [
        '--no-optional-locks',
        '--no-pager',
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
        '-c',
        'protocol.allow=never',
        ...args,
      ],
      { env, timeout: 4000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    )
  ).stdout;
}
// Read a bounded, regular metadata file; never follow a pipe or symlink into an
// unbounded source. The original index is not refreshed or written by the agent.
async function metadataFile(path: string, limit: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('Unsupported metadata');
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error('Metadata changed during capture');
    return buffer.subarray(0, length);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function isolatedStatus(w: LocalDirectory): Promise<string> {
  // Original repository configuration is read ONLY as data. Never pass includes,
  // filters, aliases, hooks, remotes or helper commands to the status process.
  const settings = new Map<string, string>();
  const raw = await git(w.root, ['config', '--null', '--list']);
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const newline = entry.indexOf('\n');
    if (newline < 0) throw new Error('Unsupported config');
    settings.set(entry.slice(0, newline).toLowerCase(), entry.slice(newline + 1));
  }
  // Filters can make raw working-tree bytes incomparable to indexed content.
  // Report unavailable, not a misleading clean count. Isolation below also
  // protects against configuration changing after this check.
  for (const [name, value] of settings) {
    if (/^filter\..*\.(clean|smudge|process)$/.test(name) && value)
      throw new Error('Filtered status requires an explicitly trusted native tool');
  }
  if (settings.get('core.sparsecheckout') === 'true')
    throw new Error('Sparse checkout summary is not implemented');
  const objectFormat = (await git(w.root, ['rev-parse', '--show-object-format'])).trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) throw new Error('Unsupported object format');
  const common = await realpath(
    (await git(w.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(),
  );
  const objects = await realpath(join(common, 'objects'));
  const index = await metadataFile(join(w.gitDir, 'index'), 32 * 1024 * 1024);
  let head: string;
  try {
    head = (await git(w.root, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (!new RegExp(`^[0-9a-f]{${objectFormat === 'sha256' ? 64 : 40}}$`).test(head))
      throw new Error('Invalid HEAD');
  } catch {
    // An unborn branch is valid; all other missing/corrupt HEAD states are not.
    const ref = (await git(w.root, ['symbolic-ref', '--quiet', 'HEAD'])).trim();
    if (!ref.startsWith('refs/heads/')) throw new Error('Invalid unborn HEAD');
    head = 'ref: refs/heads/hexu-summary-unborn';
  }
  const shadow = await mkdtemp(join(tmpdir(), 'hexu-git-summary-'));
  try {
    if (inside(w.root, shadow)) throw new Error('Temporary metadata must be outside workspace');
    await mkdir(join(shadow, 'refs'));
    await mkdir(join(shadow, 'info'));
    await symlink(objects, join(shadow, 'objects'), 'dir');
    await writeFile(join(shadow, 'HEAD'), head + '\n', { mode: 0o600 });
    if (index) await writeFile(join(shadow, 'index'), index, { mode: 0o600 });
    const exclude = await metadataFile(join(common, 'info', 'exclude'), 1024 * 1024);
    if (exclude) await writeFile(join(shadow, 'info', 'exclude'), exclude, { mode: 0o600 });
    // No original configuration is loaded, even if it changes concurrently.
    // Disable filters at the highest attribute precedence as defense in depth.
    await writeFile(join(shadow, 'info', 'attributes'), '* -filter\n', { mode: 0o600 });
    const options = [
      `--git-dir=${shadow}`,
      `--work-tree=${w.root}`,
      '-c',
      'core.bare=false',
      '-c',
      'core.attributesFile=/dev/null',
    ];
    if (objectFormat === 'sha256')
      options.push('-c', 'core.repositoryformatversion=1', '-c', 'extensions.objectformat=sha256');
    for (const name of [
      'core.filemode',
      'core.ignorecase',
      'core.symlinks',
      'core.autocrlf',
      'core.eol',
    ]) {
      const value = settings.get(name);
      if (value === undefined) continue;
      if (!['true', 'false', 'input', 'lf', 'crlf', 'native'].includes(value))
        throw new Error('Unsupported core configuration');
      options.push('-c', `${name}=${value}`);
    }
    const result = await git(w.root, [
      ...options,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--ignore-submodules=all',
    ]);
    if ((await git(w.root, ['config', '--null', '--list'])) !== raw)
      throw new Error('Configuration changed during capture');
    return result;
  } finally {
    await rm(shadow, { recursive: true, force: true });
  }
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
    const output = await isolatedStatus(w);
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
