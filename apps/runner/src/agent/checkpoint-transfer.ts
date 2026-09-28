import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  TRANSFER_LIMITS as limits,
  parseTransferView,
  parseTransferTicket,
  type TransferTicket,
  type TransferView,
  type TransferEnvelope,
  type TransferReply,
  type TransferAction,
} from '../../../../packages/contracts/src/checkpoint-transfer.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { AgentStorage, readCredentials } from './storage.js';
import {
  restoreBinding,
  restorePrivatePath,
  withRestoreSource,
} from './checkpoint-restore-preflight.js';
import { nodeRequest } from './connection.js';
import { verifySnapshot, type SnapshotObject, type ObjectType } from './checkpoint-objects.js';
import {
  bytesHash,
  transferDigest,
  transferKeys,
  packSnapshot,
  unpackSnapshot,
  encryptSnapshot,
  decryptSnapshot,
} from './checkpoint-transfer-crypto.js';
interface LocalRow {
  id: string;
  binding: string;
  role: 'sender' | 'recipient';
  ticket: string;
  status: string;
  public_key: string;
  private_key: string | null;
  envelope: string | null;
  verified_at: string | null;
  received_at: string | null;
  prior_status: string | null;
}
/** Separate private store: never copy the source credentials/SQLite or forge a
 * RetentionTicket owned by the recipient. Received objects are not a working directory. */
export class TransferVault {
  readonly storage: AgentStorage;
  constructor(home: string) {
    this.storage = new AgentStorage(join(home, 'checkpoint-transfers'));
    this.db.exec(`PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY,binding TEXT NOT NULL,role TEXT NOT NULL,ticket TEXT NOT NULL,status TEXT NOT NULL,public_key TEXT NOT NULL,private_key TEXT,envelope TEXT,verified_at TEXT,received_at TEXT,prior_status TEXT);
      CREATE TABLE IF NOT EXISTS chunks(transfer_id TEXT NOT NULL,sequence INTEGER NOT NULL,data BLOB NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(transfer_id,sequence));
      CREATE TABLE IF NOT EXISTS objects(transfer_id TEXT NOT NULL,oid TEXT NOT NULL,type TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(transfer_id,oid));`);
  }
  get db() {
    return this.storage.db;
  }
  close() {
    this.storage.close();
  }
  atomic<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = f();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  row(id: string) {
    return this.db.prepare('SELECT * FROM transfers WHERE id=?').get(id) as unknown as
      | LocalRow
      | undefined;
  }
  create(
    t: TransferTicket,
    binding: string,
    role: LocalRow['role'],
    publicKey: string,
    privateKey: string | null,
    envelope: TransferEnvelope | null,
    chunks: Buffer[] = [],
  ) {
    this.atomic(() => {
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM transfers WHERE status!='forgotten'")
        .get() as { n: number };
      const history = this.db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
      if (count.n >= 16 || history.n >= 1000)
        throw new DomainError('TRANSFER_LIMIT', '本机传输副本或历史达到上限');
      this.db
        .prepare('INSERT INTO transfers VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL)')
        .run(
          t.id,
          binding,
          role,
          JSON.stringify(t),
          role === 'sender' ? 'sealed' : 'accepted',
          publicKey,
          privateKey,
          envelope ? JSON.stringify(envelope) : null,
        );
      chunks.forEach((c, i) =>
        this.db.prepare('INSERT INTO chunks VALUES(?,?,?,?)').run(t.id, i + 1, c, bytesHash(c)),
      );
    });
  }
  chunks(id: string) {
    return (
      this.db
        .prepare('SELECT sequence,data,hash FROM chunks WHERE transfer_id=? ORDER BY sequence')
        .all(id) as unknown as { sequence: number; data: Uint8Array; hash: string }[]
    ).map((c, i) => {
      const data = Buffer.from(c.data);
      if (c.sequence !== i + 1 || bytesHash(data) !== c.hash)
        throw new DomainError('TRANSFER_CORRUPT', '本机固定密文损坏，不重新采集');
      return data;
    });
  }
  async verify(id: string) {
    const row = this.row(id);
    if (!row || row.status === 'forgotten')
      throw new DomainError('NOT_FOUND', '本机没有可核验的接收副本');
    const t = parseTransferTicket(JSON.parse(row.ticket)),
      m = t.manifest;
    const count = this.db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(length(data)),0) AS bytes FROM objects WHERE transfer_id=?',
      )
      .get(id) as { n: number; bytes: number };
    if (count.n !== m.coverage.objects || count.bytes !== m.coverage.bytes)
      throw new DomainError('TRANSFER_CORRUPT', '本机接收对象缺失或长度不符');
    const v = await verifySnapshot(m.objectFormat, m.commit, m.tree, async (oid, type, max) => {
      const meta = this.db
        .prepare('SELECT type,length(data) AS size FROM objects WHERE transfer_id=? AND oid=?')
        .get(id, oid) as { type: ObjectType; size: number } | undefined;
      if (!meta || meta.type !== type || meta.size > max)
        throw new DomainError('TRANSFER_CORRUPT', '接收对象缺失或类型错误');
      return Buffer.from(
        (
          this.db
            .prepare('SELECT data FROM objects WHERE transfer_id=? AND oid=?')
            .get(id, oid) as { data: Uint8Array }
        ).data,
      );
    });
    if (
      v.snapshotHash !== m.snapshotHash ||
      canonicalJson(v.coverage) !== canonicalJson(m.coverage)
    )
      throw new DomainError('TRANSFER_CORRUPT', '接收副本清单核验失败');
    return v;
  }
  saveObjects(id: string, objects: SnapshotObject[]) {
    this.atomic(() => {
      for (const o of objects)
        this.db.prepare('INSERT INTO objects VALUES(?,?,?,?)').run(id, o.id, o.type, o.data);
      this.db.prepare("UPDATE transfers SET status='verifying' WHERE id=?").run(id);
    });
  }
  forget(id: string) {
    this.atomic(() => {
      this.db.prepare('DELETE FROM objects WHERE transfer_id=?').run(id);
      this.db.prepare('DELETE FROM chunks WHERE transfer_id=?').run(id);
      this.db
        .prepare(
          "UPDATE transfers SET prior_status=status,status='forgotten',private_key=NULL WHERE id=? AND status!='forgotten'",
        )
        .run(id);
    });
  }
}
function summary(r: LocalRow) {
  const t = parseTransferTicket(JSON.parse(r.ticket));
  return {
    transferId: r.id,
    role: r.role,
    localState: r.status,
    priorState: r.prior_status,
    sourceCommit: t.manifest.commit,
    snapshotHash: t.manifest.snapshotHash,
    expiresAt: t.manifest.expiresAt,
    verifiedAt: r.verified_at,
    receivedAt: r.received_at,
    currentObjectsVerified: false,
    restored: false,
    modelExecutionAuthorized: false,
  };
}
const inside = (a: string, b: string) => {
  const p = relative(a, b);
  return !p || (p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p));
};
export async function localTransfer(
  home: string,
  id: string,
  mode: 'accept' | 'send' | 'receive' | 'status' | 'forget',
  ask: (prompt: string) => Promise<string>,
  log: (message: string) => void = console.log,
  signal?: AbortSignal,
) {
  nodeId(id);
  home = resolve(home);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '本次传输仅支持 Linux 回环节点');
  restorePrivatePath(home, true);
  const c = readCredentials(home),
    binding = restoreBinding(c);
  if (!c.nodeId) throw new DomainError('NOT_PAIRED', '尚未配对');
  if (c.directories.some((w) => [w.root, w.gitDir].some((p) => inside(p, home) || inside(home, p))))
    throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '私有传输状态与授权源仓库重叠');
  const live = () => {
    if (signal?.aborted)
      throw new DomainError('TRANSFER_INTERRUPTED', '传输已中断，固定日志保留；没有自动重试');
    if (restoreBinding(readCredentials(home)) !== binding)
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '本机身份或目录配置已改变');
  };
  live();
  if (
    ['status', 'forget', 'receive'].includes(mode) &&
    !existsSync(join(home, 'checkpoint-transfers', 'journal.sqlite'))
  )
    throw new DomainError('NOT_FOUND', '没有原传输记录，请先明确接受接收');
  const vault = new TransferVault(home);
  try {
    let row = vault.row(id);
    if (row && row.binding !== binding)
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '新凭证不能管理原传输副本');
    if (mode === 'status') {
      if (!row) throw new DomainError('NOT_FOUND', '本机没有原传输记录');
      return summary(row);
    }
    if (mode === 'forget') {
      if (!row) throw new DomainError('NOT_FOUND', '本机没有原传输记录');
      if (row.status === 'forgotten') return summary(row);
      log(
        '只删除此传输的本机密文/接收对象和临时私钥；不删除来源、恢复目录或服务端历史。不会自动撤回对方已收到的副本。',
      );
      if ((await ask(`输入 FORGET ${id}：`)) !== `FORGET ${id}`)
        throw new DomainError('CONFIRMATION_REQUIRED', '未确认本机清理');
      live();
      vault.forget(id);
      return summary(vault.row(id)!);
    }
    if (row?.status === 'forgotten')
      throw new DomainError('TRANSFER_DELETED', '原传输本机材料已明确删除，不能复活');
    let pinned: TransferTicket | undefined = row
      ? parseTransferTicket(JSON.parse(row.ticket))
      : undefined;
    const request = async (packet: TransferAction): Promise<TransferReply> => {
      live();
      const result = await nodeRequest<TransferReply>(
        c.controlUrl,
        'checkpoint-transfer',
        packet,
        c.nodeToken,
        signal,
      );
      live();
      const view = parseTransferView(result?.view),
        t = view.ticket;
      if (
        t.id !== id ||
        t.source.spaceId !== c.spaceId ||
        t.source.projectId !== c.projectId ||
        ![t.source.nodeId, t.target.id].includes(c.nodeId!) ||
        transferDigest({ ...t, requestHash: '' }) !== t.requestHash ||
        (pinned && canonicalJson(t) !== canonicalJson(pinned))
      )
        throw new DomainError('INVALID_RESPONSE', '传输响应与原本机身份或固定来源不符');
      pinned = t;
      return { ...result, view };
    };
    let view = (await request({ action: 'inspect', transferId: id })).view;
    const t = view.ticket,
      sender = t.source.nodeId === c.nodeId;
    const base = { transferId: id, requestHash: t.requestHash };
    if ((mode === 'send') !== sender)
      throw new DomainError('TRANSFER_ROLE', '请在对应的源节点或接收节点执行');
    if (row && (row.role === 'sender') !== sender)
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '原本机收发角色不一致');
    if (view.state === 'received') {
      if (!row)
        throw new DomainError(
          'TRANSFER_DELETED',
          '服务端有历史回执，但此节点没有原本机材料，不重新接收',
        );
      if (!sender && row.status === 'verified') {
        vault.db
          .prepare(
            "UPDATE transfers SET status='received',received_at=?,private_key=NULL WHERE id=?",
          )
          .run(view.receivedAt, id);
        vault.db.prepare('DELETE FROM chunks WHERE transfer_id=?').run(id);
      }
      return { ...summary(vault.row(id)!), remoteState: view.state };
    }
    const active = (v: TransferView) => {
      live();
      if (
        !v.authorized ||
        ['cancelled', 'expired', 'invalidated'].includes(v.state) ||
        t.expiresAt <= new Date().toISOString()
      )
        throw new DomainError('TRANSFER_CLOSED', '传输或授权已失效，未继续读写材料');
    };
    active(view);
    if (mode === 'accept') {
      if (!row) {
        if (view.state !== 'offered')
          throw new DomainError('TRANSFER_CONFLICT', '已有接收同意，但本机密钥记录缺失，不替换');
        log(
          `接收自 ${t.sourceName} · 提交 ${t.manifest.commit} · ${t.manifest.coverage.objects} 对象 / ${t.manifest.coverage.bytes} 字节 · 传输至 ${t.expiresAt}`,
        );
        log(
          '仅接收独立私有对象副本，可能含已提交敏感内容；无祖先/未提交内容，LFS仅指针、子模块仅引用。不会创建工作目录、接手任务或启动模型。',
        );
        if ((await ask(`输入 RECEIVE ${id}：`)) !== `RECEIVE ${id}`)
          throw new DomainError('CONFIRMATION_REQUIRED', '未确认本机接收');
        view = (await request({ action: 'inspect', transferId: id })).view;
        active(view);
        const keys = transferKeys();
        vault.create(t, binding, 'recipient', keys.publicKey, keys.privateKey, null);
        row = vault.row(id)!;
      }
      view = (
        await request({
          action: 'accept',
          ...base,
          publicKey: row.public_key,
          confirmReceive: true,
        })
      ).view;
      if (view.recipientKey !== row.public_key)
        throw new DomainError('INVALID_RESPONSE', '接收公钥回执不一致');
      return { ...summary(row), remoteState: view.state };
    }
    if (mode === 'send') {
      if (!view.recipientKey)
        throw new DomainError('TRANSFER_CONSENT_REQUIRED', '接收方尚未在本机确认');
      if (!row) {
        if (view.state !== 'accepted')
          throw new DomainError('TRANSFER_CONFLICT', '原发送包本机记录缺失，不重新加密或采集');
        log(
          `发送提交 ${t.manifest.commit} 到 ${t.target.ownerName.replace(/[\p{Cc}\p{Cf}]/gu, ' ')} / ${t.target.name} · ${t.target.id} · ${t.manifest.coverage.bytes} 字节`,
        );
        log(
          '会读取此份已保留提交的全部对象，可能包含已提交的敏感内容及文件名；只加密发送到指定接收节点。不会转交账号、HOME或原工作目录。',
        );
        if ((await ask(`输入 SEND ${id}：`)) !== `SEND ${id}`)
          throw new DomainError('CONFIRMATION_REQUIRED', '未确认本机发送');
        const recipientKey = view.recipientKey;
        await withRestoreSource(home, t.source.id, signal, async (source) => {
          if (
            canonicalJson(source.ticket) !== canonicalJson(t.source) ||
            canonicalJson(source.manifest) !== canonicalJson(t.manifest)
          )
            throw new DomainError('TRANSFER_CONFLICT', '传输材料与原本机副本不一致');
          const snapshot = await source.snapshot((read) =>
            verifySnapshot(t.manifest.objectFormat, t.manifest.commit, t.manifest.tree, read),
          );
          if (
            snapshot.snapshotHash !== t.manifest.snapshotHash ||
            canonicalJson(snapshot.coverage) !== canonicalJson(t.manifest.coverage)
          )
            throw new DomainError('TRANSFER_CORRUPT', '原对象与固定清单不符');
          view = (await request({ action: 'inspect', transferId: id })).view;
          active(view);
          if (view.recipientKey !== recipientKey || view.state !== 'accepted')
            throw new DomainError('TRANSFER_CONFLICT', '接收同意或密钥发生变化');
          const payload = packSnapshot(snapshot.objects);
          try {
            const packet = encryptSnapshot(payload, t, recipientKey);
            live();
            vault.create(t, binding, 'sender', recipientKey, null, packet.envelope, packet.chunks);
          } finally {
            payload.fill(0);
          }
        });
        row = vault.row(id)!;
      }
      if (row.public_key !== view.recipientKey || !row.envelope)
        throw new DomainError('TRANSFER_CONFLICT', '原发送包与接收密钥不一致');
      const envelope = JSON.parse(row.envelope) as TransferEnvelope,
        chunks = vault.chunks(id);
      if (chunks.length !== envelope.chunks || bytesHash(Buffer.concat(chunks)) !== envelope.digest)
        throw new DomainError('TRANSFER_CORRUPT', '原固定密文包损坏，不重采集');
      view = (await request({ action: 'begin', ...base, envelope, confirmSend: true })).view;
      if (canonicalJson(view.envelope) !== canonicalJson(envelope))
        throw new DomainError('INVALID_RESPONSE', '发送包回执不一致');
      // Start at one on explicit retry: the server compares every old sequence/hash.
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!,
          hash = bytesHash(chunk);
        const reply = await request({
          action: 'upload',
          ...base,
          sequence: i + 1,
          ciphertext: chunk.toString('base64'),
          hash,
        });
        if (reply.sequence !== i + 1 || reply.hash !== hash)
          throw new DomainError('INVALID_RESPONSE', '密文块回执未确认，固定包仍在本机');
        log(`已确认密文块 ${i + 1}/${chunks.length}`);
      }
      view = (await request({ action: 'seal', ...base })).view;
      if (view.state !== 'available')
        throw new DomainError('INVALID_RESPONSE', '完整密文发布未确认');
      return { ...summary(row), remoteState: view.state, received: false };
    }
    if (!row || row.role !== 'recipient' || row.public_key !== view.recipientKey)
      throw new DomainError('TRANSFER_CONSENT_REQUIRED', '没有匹配的本机接收授权与密钥');
    if (view.state !== 'available' || !view.envelope)
      throw new DomainError('TRANSFER_NOT_READY', '发送尚未完整提交，不读取部分包');
    if (row.envelope && canonicalJson(JSON.parse(row.envelope)) !== canonicalJson(view.envelope))
      throw new DomainError('TRANSFER_CONFLICT', '原接收包发生变化');
    if (!row.envelope)
      vault.db
        .prepare("UPDATE transfers SET envelope=?,status='receiving' WHERE id=?")
        .run(JSON.stringify(view.envelope), id);
    if (!['verifying', 'verified'].includes(row.status)) {
      if (!row.private_key) throw new DomainError('TRANSFER_CONFLICT', '本机原接收密钥缺失');
      const chunks = vault.chunks(id);
      for (let i = chunks.length; i < view.envelope.chunks; i++) {
        const reply = await request({ action: 'chunk', ...base, sequence: i + 1 });
        active(reply.view);
        const encoded = reply.ciphertext;
        if (typeof encoded !== 'string' || encoded.length > 87404)
          throw new DomainError('INVALID_RESPONSE', '接收密文格式无效');
        const chunk = Buffer.from(encoded, 'base64'),
          expected = Math.min(limits.chunk, view.envelope.bytes - i * limits.chunk) + 16;
        if (
          reply.sequence !== i + 1 ||
          chunk.length !== expected ||
          chunk.toString('base64') !== encoded ||
          bytesHash(chunk) !== reply.hash
        )
          throw new DomainError('TRANSFER_CORRUPT', '接收块的长度或指纹不符');
        live();
        vault.db.prepare('INSERT INTO chunks VALUES(?,?,?,?)').run(id, i + 1, chunk, reply.hash!);
        chunks.push(chunk);
        log(`已保存接收密文块 ${i + 1}/${view.envelope.chunks}`);
      }
      const payload = decryptSnapshot(chunks, t, row.public_key, row.private_key, view.envelope);
      try {
        const objects = await unpackSnapshot(payload, t);
        view = (await request({ action: 'inspect', transferId: id })).view;
        active(view);
        live();
        vault.saveObjects(id, objects);
      } finally {
        payload.fill(0);
      }
    }
    // Verify the committed independent SQLite copy, not only the decrypted in-memory buffer.
    await vault.verify(id);
    live();
    if (vault.row(id)!.status !== 'verified')
      vault.db
        .prepare("UPDATE transfers SET status='verified',verified_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
    view = (
      await request({
        action: 'received',
        ...base,
        snapshotHash: t.manifest.snapshotHash,
        confirmVerified: true,
      })
    ).view;
    if (view.state !== 'received' || !view.receivedAt)
      throw new DomainError('INVALID_RESPONSE', '接收核验回执未获确认，原证据保留');
    vault.atomic(() => {
      vault.db
        .prepare("UPDATE transfers SET status='received',received_at=?,private_key=NULL WHERE id=?")
        .run(view.receivedAt, id);
      vault.db.prepare('DELETE FROM chunks WHERE transfer_id=?').run(id);
    });
    return { ...summary(vault.row(id)!), remoteState: view.state };
  } finally {
    vault.close();
  }
}
