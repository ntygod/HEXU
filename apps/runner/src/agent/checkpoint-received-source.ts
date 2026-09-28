import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { retentionDate } from '../../../../packages/contracts/src/checkpoint-retention.js';
import {
  parseTransferTicket,
  parseTransferEnvelope,
  parseTransferView,
  type TransferReply,
} from '../../../../packages/contracts/src/checkpoint-transfer.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import { transferDigest } from './checkpoint-transfer-crypto.js';
import {
  restoreBinding,
  restorePrivatePath,
  type RestoreMaterialSource,
} from './checkpoint-restore-preflight.js';
import type { ObjectReader } from './checkpoint-objects.js';

interface ReceivedRow {
  id: string;
  binding: string;
  role: string;
  ticket: string;
  status: string;
  public_key: string;
  envelope: string | null;
  verified_at: string | null;
  received_at: string | null;
}

/** Read only the receiver's already-confirmed independent copy. Never initialize a
 * transfer database, settle a receive ACK, download, renew, repair or relabel retention.
 * A prompt never holds a SQLite read transaction. Byte reads are bounded snapshots. */
export async function withReceivedRestoreSource<T>(
  home: string,
  id: string,
  signal: AbortSignal | undefined,
  visit: (source: RestoreMaterialSource) => Promise<T>,
): Promise<T> {
  nodeId(id);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '接收副本恢复目前仅支持 Linux');
  home = resolve(home);
  const paths = [
    home,
    join(home, 'checkpoint-transfers'),
    join(home, 'checkpoint-transfers', 'journal.sqlite'),
  ];
  const identities = paths.map((p, i) => restorePrivatePath(p, i < 2));
  const credentials = readCredentials(home),
    binding = restoreBinding(credentials);
  if (!credentials.nodeId) throw new DomainError('NOT_PAIRED', '请先完成接收节点配对');
  const live = () => {
    if (signal?.aborted)
      throw new DomainError('RESTORE_PLAN_CANCELLED', '恢复已取消，未继续读取接收材料');
  };
  const stillBound = () => {
    live();
    if (
      restoreBinding(readCredentials(home)) !== binding ||
      paths.some((p, i) => restorePrivatePath(p, i < 2) !== identities[i])
    )
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '原接收身份或私有副本位置变化，未继续恢复');
  };
  stillBound();
  const db = new DatabaseSync(paths[2]!, { readOnly: true });
  try {
    const readRow = () =>
      db.prepare('SELECT * FROM transfers WHERE id=?').get(id) as unknown as
        | ReceivedRow
        | undefined;
    const row = readRow();
    if (
      !row ||
      row.status !== 'received' ||
      row.role !== 'recipient' ||
      !row.received_at ||
      !row.verified_at ||
      !row.envelope
    )
      throw new DomainError(
        'RESTORE_NOT_AVAILABLE',
        '没有已确认接收副本；不补确认回执、重新下载或创建材料',
      );
    if (row.binding !== binding)
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '接收副本属于原本机身份');
    const ticket = parseTransferTicket(JSON.parse(row.ticket)),
      manifest = ticket.manifest;
    const envelope = parseTransferEnvelope(JSON.parse(row.envelope));
    if (
      ticket.id !== id ||
      ticket.target.id !== credentials.nodeId ||
      ticket.source.spaceId !== credentials.spaceId ||
      ticket.source.projectId !== credentials.projectId ||
      transferDigest({ ...ticket, requestHash: '' }) !== ticket.requestHash
    )
      throw new DomainError('CHECKPOINT_MISMATCH', '传输身份或接收节点绑定不一致');
    const verifiedAt = retentionDate(row.verified_at),
      receivedAt = retentionDate(row.received_at);
    if (
      verifiedAt < manifest.retainedAt ||
      verifiedAt > manifest.expiresAt ||
      receivedAt < ticket.createdAt ||
      receivedAt > ticket.expiresAt
    )
      throw new DomainError('CHECKPOINT_MISMATCH', '接收副本的核验或接收时间不一致');
    const unchanged = () => {
      stillBound();
      if (canonicalJson(readRow()) !== canonicalJson(row))
        throw new DomainError('RESTORE_NOT_AVAILABLE', '本机接收副本已删除或改变，不继续使用');
      if (Date.parse(manifest.expiresAt) <= Date.now())
        throw new DomainError('RESTORE_RETENTION_EXPIRED', '接收材料已到期，不续期或回源修补');
    };
    const authorized = async () => {
      unchanged();
      const response = await nodeRequest<TransferReply>(
        credentials.controlUrl,
        'checkpoint-transfer',
        { action: 'inspect', transferId: id },
        credentials.nodeToken,
        signal,
      );
      unchanged();
      const current = parseTransferView(response.view);
      if (
        !current.authorized ||
        current.state !== 'received' ||
        current.receivedAt !== receivedAt ||
        current.recipientKey !== row.public_key ||
        canonicalJson(current.envelope) !== canonicalJson(envelope) ||
        canonicalJson(current.ticket) !== canonicalJson(ticket)
      )
        throw new DomainError('RESTORE_NOT_AVAILABLE', '原传输接收回执或当前双方权限不再匹配');
    };
    const snapshot = async <V>(consume: (read: ObjectReader) => Promise<V>): Promise<V> => {
      await authorized();
      db.exec('BEGIN');
      let value: V;
      try {
        unchanged();
        const count = db
          .prepare(
            'SELECT COUNT(*) AS n,COALESCE(SUM(length(data)),0) AS bytes FROM objects WHERE transfer_id=?',
          )
          .get(id)!;
        if (count.n !== manifest.coverage.objects || count.bytes !== manifest.coverage.bytes)
          throw new DomainError('SNAPSHOT_INCOMPLETE', '接收副本对象缺失或大小不符，不重新下载');
        value = await consume(async (oid, type, max) => {
          unchanged();
          const meta = db
            .prepare('SELECT type,length(data) AS size FROM objects WHERE transfer_id=? AND oid=?')
            .get(id, oid) as { type: string; size: number } | undefined;
          if (!meta || meta.type !== type || meta.size > max)
            throw new DomainError('SNAPSHOT_INCOMPLETE', '接收对象类型或大小不符');
          const result = db
            .prepare('SELECT data FROM objects WHERE transfer_id=? AND oid=?')
            .get(id, oid) as { data: Uint8Array };
          return Buffer.from(result.data);
        });
      } finally {
        db.exec('ROLLBACK');
      }
      await authorized();
      return value;
    };
    return await visit({
      home,
      binding,
      manifest,
      planSource: {
        kind: 'transfer',
        transfer: ticket,
        requestId: id,
        checkpointId: ticket.source.checkpointId,
        nodeId: ticket.target.id,
        workspaceId: null,
        manifest,
      },
      protectedPaths: [home, ...credentials.directories.flatMap((w) => [w.root, w.gitDir])],
      protectedIdentities: credentials.directories.flatMap((w) => [w.rootIdentity, w.gitIdentity]),
      stillBound,
      authorized,
      snapshot,
    });
  } finally {
    db.close();
  }
}
