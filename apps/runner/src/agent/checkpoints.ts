import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, lstat, readdir } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname, basename, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  commitOid,
  checkpointHash,
  parseCheckpointManifest,
  parseCheckpointPublish,
  type CheckpointManifest,
  type CheckpointRequest,
} from '../../../../packages/contracts/src/checkpoints.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { captureDirectory, type LocalDirectory } from './workspaces.js';
import {
  AgentStorage,
  ensurePrivateHome,
  readCredentials,
  type NodeCredentials,
} from './storage.js';
import { nodeRequest } from './connection.js';
const exec = promisify(execFile);
const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const safe = (v: string) => v.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
const identity = async (p: string) => {
  const s = await lstat(p);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Untrusted directory');
  return `${s.dev}:${s.ino}`;
};
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
};
async function git(root: string, args: string[], home: string, limit = 1024 * 1024) {
  return (
    await exec(
      'git',
      [
        '--no-optional-locks',
        '--no-pager',
        '--no-replace-objects',
        '-C',
        root,
        '-c',
        'protocol.allow=never',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          HOME: home,
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
        },
        timeout: 4000,
        maxBuffer: limit,
        encoding: 'buffer',
      },
    )
  ).stdout;
}
/** Reject alternate object databases and symlinks before letting Git inspect the local store.
 * No original repository configuration is passed to cat-file; missing objects cannot trigger fetch. */
async function inspectObjectStore(objects: string) {
  const stack = [objects];
  let count = 0;
  while (stack.length) {
    const path = stack.pop()!;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++count > 50000) throw new Error('Object store inspection limit');
      const file = join(path, entry.name),
        s = await lstat(file);
      if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()))
        throw new Error('Unsupported object-store entry');
      if (
        file === join(objects, 'info', 'alternates') ||
        file === join(objects, 'info', 'http-alternates')
      )
        throw new Error('Alternate stores require separate authorization');
      if (s.isDirectory()) {
        if (path !== objects) throw new Error('Unsupported object-store nesting');
        stack.push(file);
      }
    }
  }
}
export async function captureCommitReference(
  w: LocalDirectory,
  oid: string,
  clientId: string,
  stateHome: string,
  inspectSnapshot?: (
    read: (id: string, type: 'commit' | 'tree' | 'blob', max: number) => Promise<Buffer>,
    commit: Buffer,
    tree: string,
  ) => Promise<void>,
): Promise<CheckpointManifest> {
  commitOid(oid);
  let shadow: string | undefined;
  try {
    if (
      (await realpath(w.root)) !== w.root ||
      (await identity(w.root)) !== w.rootIdentity ||
      (await realpath(w.gitDir)) !== w.gitDir ||
      (await identity(w.gitDir)) !== w.gitIdentity ||
      inside(w.root, resolve(stateHome)) ||
      inside(resolve(stateHome), w.root)
    )
      throw new Error('Authorization changed');
    // Reject an in-repository temporary parent before creating any scratch directory.
    const temporaryRoot = await realpath(tmpdir());
    if (inside(w.root, temporaryRoot)) throw new Error('Temporary parent inside workspace');
    shadow = await mkdtemp(join(temporaryRoot, 'hexu-checkpoint-'));
    if (inside(w.root, shadow)) throw new Error('Temporary metadata inside workspace');
    const text = async (args: string[]) =>
      (await git(w.root, args, shadow!)).toString('utf8').trim();
    if ((await realpath(await text(['rev-parse', '--absolute-git-dir']))) !== w.gitDir)
      throw new Error('Git directory changed');
    const common = await realpath(
      await text(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    // Standard linked worktrees store their git directory immediately below common/worktrees.
    // A changed commondir must not redirect a paired directory into another repository.
    if (
      common !== w.gitDir &&
      !(dirname(dirname(w.gitDir)) === common && basename(dirname(w.gitDir)) === 'worktrees')
    )
      throw new Error('Common directory outside authorized repository layout');
    const objects = join(common, 'objects');
    if ((await realpath(objects)) !== objects) throw new Error('Redirected objects');
    const binding = [await identity(common), await identity(objects)];
    await inspectObjectStore(objects);
    const format = await text(['rev-parse', '--show-object-format']);
    if (format !== 'sha1' && format !== 'sha256') throw new Error('Unsupported format');
    commitOid(oid, format);
    await mkdir(join(shadow, 'refs'));
    // Git determines storage format from repository config, not command-line -c overrides.
    await writeFile(
      join(shadow, 'config'),
      format === 'sha256'
        ? '[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectformat = sha256\n'
        : '[core]\nrepositoryformatversion = 0\nbare = true\n',
      { mode: 0o600 },
    );
    await writeFile(join(shadow, 'HEAD'), `${'0'.repeat(oid.length)}\n`, { mode: 0o600 });
    await symlink(objects, join(shadow, 'objects'), 'dir');
    const flags = [
      `--git-dir=${shadow}`,
      '-c',
      'core.bare=true',
      ...(format === 'sha256'
        ? ['-c', 'core.repositoryformatversion=1', '-c', 'extensions.objectformat=sha256']
        : []),
    ];
    const object = async (id: string, type: 'commit' | 'tree' | 'blob', max: number) => {
      const actualType = (await git(shadow!, [...flags, 'cat-file', '-t', id], shadow!))
        .toString()
        .trim();
      if (actualType !== type) throw new Error('Object type mismatch');
      const size = Number(
        (await git(shadow!, [...flags, 'cat-file', '-s', id], shadow!)).toString().trim(),
      );
      if (!Number.isSafeInteger(size) || size < 0 || size > max)
        throw new Error('Object too large');
      const raw = await git(shadow!, [...flags, 'cat-file', type, id], shadow!, max + 1);
      if (
        raw.length !== size ||
        createHash(format).update(`${type} ${size}\0`).update(raw).digest('hex') !== id
      )
        throw new Error('Object identity mismatch');
      return raw;
    };
    const commit = await object(oid, 'commit', 65536);
    const line = commit.subarray(0, oid.length + 6).toString('ascii');
    if (!new RegExp(`^tree [0-9a-f]{${oid.length}}\\n$`).test(line))
      throw new Error('Invalid commit tree');
    const tree = line.slice(5, -1);
    await object(tree, 'tree', 4 * 1024 * 1024);
    if (inspectSnapshot) await inspectSnapshot(object, commit, tree);
    // A working-tree observation is deliberately NOT a snapshot of mutable contents.
    const workingCopy = await captureDirectory(w);
    if (
      workingCopy.state === 'authorization_changed' ||
      (await identity(w.root)) !== w.rootIdentity ||
      (await identity(w.gitDir)) !== w.gitIdentity ||
      (await realpath(await text(['rev-parse', '--path-format=absolute', '--git-common-dir']))) !==
        common ||
      binding[0] !== (await identity(common)) ||
      binding[1] !== (await identity(objects))
    )
      throw new Error('Authorization changed');
    return parseCheckpointManifest({
      version: 1,
      kind: 'git_commit_reference',
      objectFormat: format,
      commit: oid,
      tree,
      repositoryIdentity: digest(['local-git-reference-v1', clientId, w.id, ...binding]),
      verifiedAt: new Date().toISOString(),
      verifiedObjects: 'commit_and_root_tree',
      availability: 'local_reference',
      workingCopy,
    });
  } catch (cause) {
    if (
      cause instanceof DomainError &&
      ['INVALID_COMMIT', 'RETENTION_LIMIT', 'SNAPSHOT_INCOMPLETE'].includes(cause.code)
    )
      throw cause;
    throw new DomainError(
      'CHECKPOINT_UNAVAILABLE',
      '提交或根树不存在、超出核对边界或目录授权变化；未记录检查点，没有修改仓库',
    );
  } finally {
    if (shadow) await rm(shadow, { recursive: true, force: true });
  }
}
function validateTicket(r: CheckpointRequest, requestId: string, c: NodeCredentials) {
  if (
    r.id !== requestId ||
    r.nodeId !== c.nodeId ||
    r.projectId !== c.projectId ||
    r.spaceId !== c.spaceId ||
    !['pending', 'recorded', 'cancelled', 'expired', 'invalidated'].includes(r.state) ||
    !Number.isFinite(Date.parse(r.expiresAt))
  )
    throw new DomainError('CHECKPOINT_MISMATCH', '服务端请求不属于本机已授权范围');
  nodeId(r.taskId);
  nodeId(r.workspaceId);
  checkpointHash(r.requestHash);
  commitOid(r.commit);
  if (
    typeof r.taskTitle !== 'string' ||
    r.taskTitle.length > 240 ||
    typeof r.label !== 'string' ||
    r.label.length > 60
  )
    throw new DomainError('INVALID_RESPONSE', '检查点请求无效');
}
export async function publishLocalCheckpoint(
  home: string,
  requestId: string,
  ask: (prompt: string) => Promise<string>,
  log: (message: string) => void = console.log,
) {
  nodeId(requestId);
  home = ensurePrivateHome(home);
  const c = readCredentials(home);
  if (!c.nodeId) throw new DomainError('NODE_AUTH_REQUIRED', '请先完成节点配对');
  // Separate private process guard: immutable reads do not require stopping the running agent.
  const journal = new AgentStorage(join(home, 'checkpoints'));
  try {
    journal.db.exec(
      'CREATE TABLE IF NOT EXISTS publication(id INTEGER PRIMARY KEY CHECK(id=1),request_id TEXT NOT NULL,binding TEXT NOT NULL,body TEXT NOT NULL);',
    );
    const binding = digest([c.controlUrl, c.nodeId, c.clientId, c.projectId, c.spaceId]);
    const pending = journal.db
      .prepare('SELECT request_id,binding,body FROM publication WHERE id=1')
      .get() as { request_id: string; binding: string; body: string } | undefined;
    if (pending && (pending.request_id !== requestId || pending.binding !== binding))
      throw new DomainError(
        'CHECKPOINT_PENDING',
        `已有未确认记录，请先核对请求 ${pending.request_id}`,
      );
    const r = await nodeRequest<CheckpointRequest>(
      c.controlUrl,
      'checkpoint-inspect',
      { requestId },
      c.nodeToken,
    );
    validateTicket(r, requestId, c);
    if (r.state === 'recorded') {
      nodeId(r.checkpointId);
      journal.db.prepare('DELETE FROM publication WHERE id=1').run();
      return { requestId, checkpointId: r.checkpointId! };
    }
    if (r.state !== 'pending') {
      journal.db.prepare('DELETE FROM publication WHERE id=1').run();
      throw new DomainError('CHECKPOINT_REQUEST_CLOSED', '请求已取消或过期，没有发布新引用');
    }
    let body: ReturnType<typeof parseCheckpointPublish>;
    if (pending) {
      body = parseCheckpointPublish(JSON.parse(pending.body));
      if (body.requestHash !== r.requestHash)
        throw new DomainError('CHECKPOINT_MISMATCH', '原请求身份变化，保留待确认记录');
      log('确认原核对结果；不重新采集、不替换提交或变更数量。');
    } else {
      const w = c.directories.find((w) => w.id === r.workspaceId);
      if (!w) throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '请求目录未在本机授权');
      log(`任务：${safe(r.taskTitle)} · ${r.taskId}`);
      log(`本机目录：${safe(w.root)} · ${safe(w.name)}`);
      log(`提交：${r.commit}`);
      log(
        '只核对并公开提交/根树 ID、本机仓库指纹和变更数量，不上传路径、文件名、代码、作者邮箱或凭证。',
      );
      log(
        '未提交、暂存、未跟踪和忽略内容均不包含；未备份 Git 对象，也未验证子模块/LFS/全部文件或远端可用性。',
      );
      if (
        (await ask(`确认本次引用范围，输入 CHECKPOINT ${r.commit}：`)) !== `CHECKPOINT ${r.commit}`
      )
        throw new DomainError('CONFIRMATION_REQUIRED', '已取消本机核对');
      const manifest = await captureCommitReference(w, r.commit, c.clientId, home);
      body = { requestId, requestHash: r.requestHash, manifest, confirmPublication: true };
      journal.db
        .prepare('INSERT INTO publication VALUES(1,?,?,?)')
        .run(requestId, binding, JSON.stringify(body));
    }
    const receipt = await nodeRequest<{ requestId: string; checkpointId: string }>(
      c.controlUrl,
      'checkpoint-publish',
      body,
      c.nodeToken,
    );
    if (receipt.requestId !== requestId)
      throw new DomainError('INVALID_RESPONSE', '未确认同一检查点请求，保留原核对记录');
    nodeId(receipt.checkpointId);
    journal.db.prepare('DELETE FROM publication WHERE id=1').run();
    return receipt;
  } finally {
    journal.close();
  }
}
export async function checkpointCommand(home: string, requestId: string) {
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
    historySize: 0,
  });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    const receipt = await publishLocalCheckpoint(home, requestId, async (prompt) => {
      process.stdout.write(prompt);
      const line = await iterator.next();
      if (line.done) throw new DomainError('CONFIRMATION_REQUIRED', '未完成本机确认');
      return line.value;
    });
    console.log(JSON.stringify(receipt));
  } finally {
    lines.close();
  }
}
