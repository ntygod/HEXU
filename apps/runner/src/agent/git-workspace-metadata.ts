import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { commitOid } from '../../../../packages/contracts/src/checkpoints.js';
import type { RestoreEntry } from './checkpoint-restore-plan.js';
import type { verifySnapshot } from './checkpoint-objects.js';

/** Git index v2, with no assume-valid, skip-worktree or extension records.
 * Zero stat cache forces Git to compare real working bytes. No Git subprocess,
 * checkout, hook, filter, original repository config or network is needed here.
 * Format: https://git-scm.com/docs/index-format */
export function snapshotIndex(format: 'sha1' | 'sha256', entries: readonly RestoreEntry[]) {
  const files = entries
    .filter((e) => e.kind === 'file')
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (files.length > 50000) throw new DomainError('WORKSPACE_LIMIT', '文件索引超出允许范围');
  const width = format === 'sha1' ? 20 : 32;
  const header = Buffer.alloc(12);
  header.write('DIRC');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(files.length, 8);
  const parts: Buffer[] = [header];
  let previous: string | null = null;
  let total = header.length + width;
  for (const entry of files) {
    const path = Buffer.from(entry.path);
    if (
      !path.length ||
      path.length > 4095 ||
      entry.path === previous ||
      entry.path
        .split('/')
        .some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') ||
      /[\0\\]/.test(entry.path) ||
      !['100644', '100755'].includes(entry.gitMode) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 8 * 1024 * 1024
    )
      throw new DomainError('WORKSPACE_INDEX_INVALID', '工作区索引包含不受支持的条目');
    previous = entry.path;
    const fixed = 40 + width + 2;
    const length = fixed + path.length;
    total += length + (8 - (length % 8));
    if (total > 32 * 1024 * 1024) throw new DomainError('WORKSPACE_LIMIT', '文件索引超过32 MiB');
    const record = Buffer.alloc(length + (8 - (length % 8))); // 1–8 NULs, including terminator
    record.writeUInt32BE(parseInt(entry.gitMode, 8), 24);
    record.writeUInt32BE(entry.bytes, 36);
    Buffer.from(commitOid(entry.objectId, format), 'hex').copy(record, 40);
    record.writeUInt16BE(Math.min(path.length, 0xfff), 40 + width);
    path.copy(record, fixed);
    parts.push(record);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash(format).update(body).digest()]);
}

/** Only this immutable snapshot, with its original commit identity. The shallow
 * boundary explicitly excludes ancestors; it is not a complete repository.
 * https://git-scm.com/docs/shallow */
export function gitWorkspaceMetadata(
  format: 'sha1' | 'sha256',
  commit: string,
  snapshot: Awaited<ReturnType<typeof verifySnapshot>>,
  entries: readonly RestoreEntry[],
) {
  commitOid(commit, format);
  const files = new Map<string, Buffer>();
  if (!snapshot.objects.some((o) => o.id === commit && o.type === 'commit'))
    throw new DomainError('SNAPSHOT_CORRUPT', '原提交不在此快照中');
  const objects = new Map(snapshot.objects.map((o) => [o.id, o]));
  for (const entry of entries.filter((e) => e.kind === 'file')) {
    const object = objects.get(entry.objectId);
    if (!object || object.type !== 'blob' || object.data.length !== entry.bytes)
      throw new DomainError('WORKSPACE_INDEX_INVALID', '索引与原始文件对象不一致');
  }
  if (snapshot.objects.length > 2048 || snapshot.coverage.bytes > 16 * 1024 * 1024)
    throw new DomainError('WORKSPACE_LIMIT', '工作区只接受当前受控传输的有界单提交对象');
  for (const object of snapshot.objects) {
    commitOid(object.id, format);
    const raw = Buffer.concat([Buffer.from(`${object.type} ${object.data.length}\0`), object.data]);
    if (createHash(format).update(raw).digest('hex') !== object.id)
      throw new DomainError('SNAPSHOT_CORRUPT', '原对象损坏，未准备工作区');
    files.set(`objects/${object.id.slice(0, 2)}/${object.id.slice(2)}`, deflateSync(raw));
  }
  files.set(
    'config',
    Buffer.from(
      format === 'sha256'
        ? '[core]\nrepositoryformatversion = 1\nbare = false\nfilemode = true\nhooksPath = /dev/null\n[extensions]\nobjectformat = sha256\n'
        : '[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\nhooksPath = /dev/null\n',
    ),
  );
  files.set('refs/heads/work', Buffer.from(commit + '\n'));
  files.set('shallow', Buffer.from(commit + '\n'));
  files.set('index', snapshotIndex(format, entries));
  files.set('HEAD', Buffer.from('ref: refs/heads/work\n'));
  return files;
}
