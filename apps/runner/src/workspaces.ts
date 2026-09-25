import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep, parse } from 'node:path';
import { homedir } from 'node:os';
import { DomainError } from '../../../packages/contracts/src/index.js';
import type {
  FileChange,
  WorkingCopy,
  WorkingCopySnapshot,
} from '../../../packages/contracts/src/native.js';
import type { Store } from '../../../packages/db/src/store.js';
const exec = promisify(execFile);
export function safePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes('\\') || /[\x00-\x1f]/.test(path)) return false;
  return !path
    .split('/')
    .some(
      (part) =>
        part === '..' ||
        /^\.(git|hexu|ssh|aws|azure|kube|claude|codex)$/.test(part) ||
        /^\.env(?:\.|$)/i.test(part) ||
        /^(credentials|id_rsa|id_ed25519)(\.|$)/i.test(part) ||
        /\.(pem|key|p12|pfx)$/i.test(part),
    );
}
export async function git(root: string, args: string[]) {
  try {
    const { stdout } = await exec(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args],
      {
        timeout: 7000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: homedir(),
          LANG: 'C.UTF-8',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        },
      },
    );
    return stdout;
  } catch {
    throw new DomainError(
      'GIT_UNAVAILABLE',
      '无法读取 Git 状态：请检查仓库、Git 安装与输出大小',
      422,
    );
  }
}
export class LocalWorkspaces {
  private copies: WorkingCopy[] = [];
  constructor(
    private store: Store,
    private roots: string[],
  ) {}
  async initialize() {
    for (const root of this.roots) {
      if (!isAbsolute(root)) throw new Error('HEXU_NATIVE_ROOTS 必须包含绝对目录');
      const canonical = await realpath(root);
      if (canonical === parse(canonical).root || canonical === (await realpath(homedir())))
        throw new Error('不能将系统根目录或完整 HOME 作为原生工作目录');
      if (!(await stat(canonical)).isDirectory()) throw new Error('原生工作目录不存在');
      const top = (await git(canonical, ['rev-parse', '--show-toplevel'])).trim();
      if ((await realpath(top)) !== canonical)
        throw new Error('每项授权必须是一个 Git 工作树根目录，而不是任意子目录');
      if (
        this.copies.some(
          (c) => this.contains(c.root, canonical) || this.contains(canonical, c.root),
        )
      )
        throw new Error('授权工作目录不能重叠或重复');
      this.copies.push(
        this.store.registerWorkingCopy({
          id: 'wc-' + createHash('sha256').update(canonical).digest('hex').slice(0, 24),
          name: basename(canonical),
          root: canonical,
          createdAt: new Date().toISOString(),
        }),
      );
    }
  }
  private contains(root: string, file: string) {
    const rel = relative(root, file);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
  }
  list() {
    return this.copies;
  }
  async get(id: string) {
    const copy = this.copies.find((c) => c.id === id);
    if (!copy) throw new DomainError('NOT_FOUND', '工作目录未获本次启动配置授权', 404);
    if ((await realpath(copy.root).catch(() => '')) !== copy.root)
      throw new DomainError('WORKSPACE_CHANGED', '工作目录已移动或替换，请重新配置', 409);
    return copy;
  }
  async snapshot(id: string): Promise<WorkingCopySnapshot> {
    const workingCopy = await this.get(id);
    const raw = await git(workingCopy.root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
    ]);
    const parts = raw.split('\0');
    const changes: FileChange[] = [];
    let omitted = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const status = part.slice(0, 2),
        path = part.slice(3);
      const previousPath = /[RC]/.test(status) ? parts[++i] : undefined;
      if (!safePath(path) || (previousPath && !safePath(previousPath)) || changes.length >= 200) {
        omitted++;
        continue;
      }
      if (path.endsWith('/')) {
        omitted++;
        continue;
      } // no implicit recursive untracked-directory upload
      const target = resolve(workingCopy.root, path);
      const info = await lstat(target).catch(() => null);
      if (info?.isSymbolicLink()) {
        omitted++;
        continue;
      }
      changes.push({ path, status, ...(previousPath ? { previousPath } : {}) });
    }
    return {
      workingCopy,
      changes,
      omitted,
      branch:
        (
          await git(workingCopy.root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')
        ).trim() || null,
      head:
        (await git(workingCopy.root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim() ||
        null,
      capturedAt: new Date().toISOString(),
      busyRunId: this.store.nativeLock(id),
    };
  }
  async read(id: string, path: string) {
    const copy = await this.get(id);
    if (!safePath(path)) throw new DomainError('PATH_NOT_ALLOWED', '此文件不在允许查看的范围', 403);
    const full = resolve(copy.root, path);
    if (!this.contains(copy.root, full))
      throw new DomainError('PATH_NOT_ALLOWED', '文件超出授权目录', 403);
    let parent = copy.root;
    for (const part of path.split('/')) {
      parent = resolve(parent, part);
      if ((await lstat(parent)).isSymbolicLink())
        throw new DomainError('PATH_NOT_ALLOWED', '不读取符号链接目标', 403);
    }
    if ((await realpath(full)) !== full)
      throw new DomainError('PATH_NOT_ALLOWED', '文件路径发生变化', 409);
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 256 * 1024)
        throw new DomainError('FILE_TOO_LARGE', '仅显示 256 KiB 以内的普通文本文件', 422);
      const buffer = Buffer.alloc(256 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 256 * 1024)
        throw new DomainError('FILE_TOO_LARGE', '文件读取期间已超出大小限制', 422);
      if (buffer.subarray(0, bytesRead).includes(0))
        throw new DomainError('BINARY_FILE', '二进制文件不作为文本展示', 422);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }
  async diff(id: string, path: string) {
    if (!safePath(path)) throw new DomainError('PATH_NOT_ALLOWED', '此文件不在允许查看的范围', 403);
    const snapshot = await this.snapshot(id);
    const change = snapshot.changes.find((c) => c.path === path);
    if (!change) throw new DomainError('NOT_FOUND', '文件不在当前可见变更中', 404);
    if (change.status === '??')
      return { kind: 'untracked' as const, text: await this.read(id, path) };
    const copy = snapshot.workingCopy;
    const args = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--ignore-submodules=all',
    ];
    const text = await git(copy.root, [
      ...args,
      ...(snapshot.head ? ['HEAD'] : ['--cached']),
      '--',
      path,
    ]);
    return { kind: 'diff' as const, text };
  }
}
