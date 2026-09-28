import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  parseRetentionManifest,
  type RetentionTicket,
  type RetentionView,
} from '../../../../packages/contracts/src/checkpoint-retention.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { readCredentials, type NodeCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import { buildRestorePlan, inspectRestoreTarget } from './checkpoint-restore-plan.js';

// Must match the immutable retention-v1 binding; no source/model permission upgrade.
const bindingFor = (c: NodeCredentials) =>
  createHash('sha256')
    .update(
      canonicalJson([
        'retention-v1',
        c.controlUrl,
        c.nodeId,
        c.clientId,
        c.nodeToken,
        c.spaceId,
        c.projectId,
        c.directories,
      ]),
    )
    .digest('hex');
function privatePath(path: string, directory: boolean) {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    (directory ? !s.isDirectory() : !s.isFile()) ||
    s.mode & 0o077 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw new DomainError('INSECURE_STATE_DIRECTORY', '恢复预检只读取当前用户独占的原本机状态');
  for (let p = dirname(path); ; p = dirname(p)) {
    const parent = lstatSync(p);
    if (parent.isSymbolicLink() || !parent.isDirectory())
      throw new DomainError('INSECURE_STATE_DIRECTORY', '节点私有状态的父目录不能经过符号链接');
    if (p === dirname(p)) break;
  }
  return `${s.dev}:${s.ino}`;
}
interface BundleRow {
  binding: string;
  ticket: string;
  manifest: string;
  status: string;
  sequence: number;
  published: number;
  pending: string | null;
}

/** Owner-only local preflight. Reads the existing vault in a read-only SQLite
 * snapshot; no creation/retention report, renewal, replay, repair or filesystem write. */
export async function localRestorePreflight(
  home: string,
  id: string,
  target: string,
  ask: (prompt: string) => Promise<string>,
  log: (message: string) => void = console.log,
  signal?: AbortSignal,
) {
  nodeId(id);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '当前恢复预检仅支持 Linux 普通文件/目录');
  const live = () => {
    if (signal?.aborted)
      throw new DomainError('RESTORE_PLAN_CANCELLED', '已取消恢复预检，没有创建目标目录');
  };
  live();
  home = resolve(home);
  const vaultHome = join(home, 'retained-checkpoints');
  const database = join(vaultHome, 'journal.sqlite');
  // Unlike ensurePrivateHome/RetentionVault, this command must not initialize state.
  const paths = [home, vaultHome, database];
  const identities = paths.map((path, i) => privatePath(path, i !== 2));
  const credentials = readCredentials(home);
  if (!credentials.nodeId) throw new DomainError('NOT_PAIRED', '请先完成本机配对');
  const binding = bindingFor(credentials);
  const protectedPaths = [home, ...credentials.directories.flatMap((w) => [w.root, w.gitDir])];
  const targetBefore = inspectRestoreTarget(target, protectedPaths);
  const stillBound = () => {
    live();
    if (
      bindingFor(readCredentials(home)) !== binding ||
      paths.some((path, i) => privatePath(path, i !== 2) !== identities[i])
    )
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '本机身份、目录绑定或副本状态位置发生变化');
  };
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM bundles WHERE id=?').get(id) as unknown as
      | BundleRow
      | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '本机没有该保留副本，不重新采集或创建');
    if (row.binding !== binding)
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '不能借当前新身份读取原绑定的对象副本');
    if (row.status !== 'retained' || row.published !== 1 || row.pending)
      throw new DomainError('RESTORE_NOT_AVAILABLE', '副本不可用或存在未确认回执，请先核对原保留记录');
    const ticket = JSON.parse(row.ticket) as RetentionTicket;
    const manifest = parseRetentionManifest(JSON.parse(row.manifest));
    if (
      ticket.id !== id ||
      ticket.nodeId !== credentials.nodeId ||
      ticket.projectId !== credentials.projectId ||
      ticket.spaceId !== credentials.spaceId ||
      !credentials.directories.some((w) => w.id === ticket.workspaceId) ||
      ticket.commit !== manifest.commit ||
      ticket.tree !== manifest.tree ||
      ticket.objectFormat !== manifest.objectFormat ||
      ticket.repositoryIdentity !== manifest.repositoryIdentity
    )
      throw new DomainError('CHECKPOINT_MISMATCH', '原请求、节点绑定与保留清单不一致');
    const authorized = async () => {
      stillBound();
      const current = await nodeRequest<RetentionView>(
        credentials.controlUrl,
        'checkpoint-retention-inspect',
        { requestId: id },
        credentials.nodeToken,
      );
      stillBound();
      if (
        current?.state !== 'retained' ||
        current.nodeAuthorized !== true ||
        current.sequence !== row.sequence ||
        canonicalJson(current.request) !== canonicalJson(ticket) ||
        canonicalJson(current.manifest) !== canonicalJson(manifest)
      )
        throw new DomainError('RESTORE_NOT_AVAILABLE', '当前权限或原保留记录已变化，未生成恢复计划');
      if (Date.parse(manifest.expiresAt) <= Date.now())
        throw new DomainError('RESTORE_RETENTION_EXPIRED', '副本已到期，不续期或读取恢复材料');
    };
    await authorized();
    log(`保留请求 ${id} · 提交 ${manifest.commit} · 到期 ${manifest.expiresAt}`);
    log(`目标：${target}`);
    log('仅生成本机恢复预检和文件清单；可能含已提交的敏感文件名。不会创建目录、恢复文件或授权模型执行。');
    if ((await ask(`输入 PLAN ${id}：`)) !== `PLAN ${id}`)
      throw new DomainError('CONFIRMATION_REQUIRED', '已取消恢复预检，没有创建目标目录');
    await authorized();
    // Do not hold a SQLite read lock while waiting for the user's confirmation.
    db.exec('BEGIN');
    if (canonicalJson(db.prepare('SELECT * FROM bundles WHERE id=?').get(id)) !== canonicalJson(row))
      throw new DomainError('RESTORE_NOT_AVAILABLE', '确认期间本机副本状态已变化');
    const count = db
      .prepare('SELECT COUNT(*) AS n,COALESCE(SUM(length(data)),0) AS bytes FROM objects WHERE bundle_id=?')
      .get(id) as { n: number; bytes: number };
    if (count.n !== manifest.coverage.objects || count.bytes !== manifest.coverage.bytes)
      throw new DomainError('SNAPSHOT_INCOMPLETE', '持久副本对象缺失或大小不符，不从原仓库修补');
    const plan = await buildRestorePlan(
      {
        requestId: id,
        checkpointId: ticket.checkpointId,
        nodeId: ticket.nodeId,
        workspaceId: ticket.workspaceId,
        manifest,
      },
      async (oid, type, max) => {
        stillBound();
        const meta = db
          .prepare('SELECT type,length(data) AS size FROM objects WHERE bundle_id=? AND oid=?')
          .get(id, oid) as { type: string; size: number } | undefined;
        if (!meta || meta.type !== type || meta.size > max) throw new Error('Object unavailable');
        const value = db.prepare('SELECT data FROM objects WHERE bundle_id=? AND oid=?').get(id, oid) as {
          data: Uint8Array;
        };
        return Buffer.from(value.data);
      },
      target,
      protectedPaths,
      signal,
    );
    db.exec('ROLLBACK');
    // Snapshot availability is not authority. Recheck after traversal before exposing names.
    await authorized();
    if (canonicalJson(db.prepare('SELECT * FROM bundles WHERE id=?').get(id)) !== canonicalJson(row))
      throw new DomainError('RESTORE_NOT_AVAILABLE', '核验后本机副本状态已变化');
    if (canonicalJson(inspectRestoreTarget(target, protectedPaths)) !== canonicalJson(targetBefore))
      throw new DomainError('RESTORE_TARGET_CHANGED', '确认或预检期间目标父目录已变化');
    return plan;
  } finally {
    db.close(); // Closing rolls back the read transaction, without changing lifecycle evidence.
  }
}
