import { DomainError, enumValue, revision, text } from './index.js';
import { exact, nodeId, publicName } from './nodes.js';
import { checkpointHash, commitOid } from './checkpoints.js';
import {
  parseRetentionManifest,
  retentionDate,
  type RetentionManifest,
  type RetentionTicket,
} from './checkpoint-retention.js';

// A deliberately smaller first transport slice; retention limits are unchanged.
export const TRANSFER_LIMITS = {
  objects: 2048,
  bytes: 16 * 1024 * 1024,
  payload: 17 * 1024 * 1024,
  chunk: 65536,
  chunks: 272,
  active: 4,
  perSource: 32,
  history: 1000,
} as const;
export interface TransferNode {
  id: string;
  ownerId: string;
  revision: number;
  name: string;
  ownerName: string;
}
export interface TransferTicket {
  version: 1;
  id: string;
  source: RetentionTicket;
  target: TransferNode;
  sourceName: string;
  manifest: RetentionManifest;
  createdAt: string;
  expiresAt: string;
  requestHash: string;
}
export interface TransferEnvelope {
  senderKey: string;
  noncePrefix: string;
  bytes: number;
  chunks: number;
  digest: string;
}
export type TransferState =
  | 'offered'
  | 'accepted'
  | 'uploading'
  | 'available'
  | 'received'
  | 'cancelled'
  | 'expired'
  | 'invalidated';
export interface TransferView {
  ticket: TransferTicket;
  state: TransferState;
  recipientKey: string | null;
  envelope: TransferEnvelope | null;
  uploadedChunks: number;
  receivedAt: string | null;
  authorized: boolean;
}
export interface TransferReply {
  view: TransferView;
  sequence?: number;
  hash?: string;
  ciphertext?: string;
}
export const transferCount = (value: unknown, max: number, min = 0) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new DomainError('INVALID_INPUT', '传输数量超出边界');
  return value;
};
export const transferPublicKey = (v: unknown): string => {
  if (typeof v !== 'string' || !/^302a300506032b656e032100[0-9a-f]{64}$/.test(v))
    throw new DomainError('INVALID_INPUT', '只接受本次传输的 X25519 公钥');
  return v;
};
export function parseTransferCreate(input: unknown) {
  const b = exact(input, ['targetNodeId', 'expectedTaskRevision', 'confirmTransfer']);
  if (b.confirmTransfer !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需明确同意传输固定提交的对象及风险');
  return {
    targetNodeId: nodeId(b.targetNodeId),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    confirmTransfer: true as const,
  };
}
export function parseTransferEnvelope(input: unknown): TransferEnvelope {
  const b = exact(input, ['senderKey', 'noncePrefix', 'bytes', 'chunks', 'digest']);
  if (typeof b.noncePrefix !== 'string' || !/^[0-9a-f]{16}$/.test(b.noncePrefix))
    throw new DomainError('INVALID_INPUT', '传输 nonce 无效');
  const bytes = transferCount(b.bytes, TRANSFER_LIMITS.payload, 1),
    chunks = transferCount(b.chunks, TRANSFER_LIMITS.chunks, 1);
  if (Math.ceil(bytes / TRANSFER_LIMITS.chunk) !== chunks)
    throw new DomainError('INVALID_INPUT', '传输分块清单不一致');
  return {
    senderKey: transferPublicKey(b.senderKey),
    noncePrefix: b.noncePrefix,
    bytes,
    chunks,
    digest: checkpointHash(b.digest),
  };
}
export function parseTransferTicket(input: unknown): TransferTicket {
  const b = exact(input, [
    'version',
    'id',
    'source',
    'target',
    'sourceName',
    'manifest',
    'createdAt',
    'expiresAt',
    'requestHash',
  ]);
  if (b.version !== 1) throw new DomainError('INVALID_INPUT', '传输版本不兼容');
  const s = exact(b.source, [
    'id',
    'checkpointId',
    'taskId',
    'nodeId',
    'nodeRevision',
    'projectId',
    'spaceId',
    'workspaceId',
    'ownerId',
    'objectFormat',
    'commit',
    'tree',
    'repositoryIdentity',
    'days',
    'requestHash',
    'createdAt',
    'expiresAt',
  ]);
  const objectFormat = enumValue(s.objectFormat, ['sha1', 'sha256'] as const, '对象格式');
  if (![1, 7, 30].includes(s.days as number))
    throw new DomainError('INVALID_INPUT', '来源期限无效');
  const source: RetentionTicket = {
    id: nodeId(s.id),
    checkpointId: nodeId(s.checkpointId),
    taskId: nodeId(s.taskId),
    nodeId: nodeId(s.nodeId),
    nodeRevision: revision(s.nodeRevision),
    projectId: nodeId(s.projectId),
    spaceId: nodeId(s.spaceId),
    workspaceId: nodeId(s.workspaceId),
    ownerId: nodeId(s.ownerId),
    objectFormat,
    commit: commitOid(s.commit, objectFormat),
    tree: commitOid(s.tree, objectFormat),
    repositoryIdentity: checkpointHash(s.repositoryIdentity),
    days: s.days as RetentionTicket['days'],
    requestHash: checkpointHash(s.requestHash),
    createdAt: retentionDate(s.createdAt),
    expiresAt: retentionDate(s.expiresAt),
  };
  const r = exact(b.target, ['id', 'ownerId', 'revision', 'name', 'ownerName']);
  const target = {
    id: nodeId(r.id),
    ownerId: nodeId(r.ownerId),
    revision: revision(r.revision),
    name: publicName(r.name),
    ownerName: text(r.ownerName, '接收者', 80),
  };
  const manifest = parseRetentionManifest(b.manifest),
    createdAt = retentionDate(b.createdAt),
    expiresAt = retentionDate(b.expiresAt);
  if (
    target.id === source.nodeId ||
    manifest.commit !== source.commit ||
    manifest.tree !== source.tree ||
    manifest.objectFormat !== source.objectFormat ||
    manifest.repositoryIdentity !== source.repositoryIdentity ||
    manifest.coverage.objects > TRANSFER_LIMITS.objects ||
    manifest.coverage.bytes > TRANSFER_LIMITS.bytes ||
    expiresAt <= createdAt ||
    expiresAt > manifest.expiresAt ||
    Date.parse(expiresAt) - Date.parse(createdAt) > 30 * 60000
  )
    throw new DomainError('TRANSFER_SCOPE', '传输来源、目标、大小或期限不受支持');
  return {
    version: 1,
    id: nodeId(b.id),
    source,
    target,
    sourceName: publicName(b.sourceName),
    manifest,
    createdAt,
    expiresAt,
    requestHash: checkpointHash(b.requestHash),
  };
}
export function parseTransferView(input: unknown): TransferView {
  const b = exact(input, [
    'ticket',
    'state',
    'recipientKey',
    'envelope',
    'uploadedChunks',
    'receivedAt',
    'authorized',
  ]);
  if (typeof b.authorized !== 'boolean')
    throw new DomainError('INVALID_RESPONSE', '传输权限响应无效');
  return {
    ticket: parseTransferTicket(b.ticket),
    state: enumValue(
      b.state,
      [
        'offered',
        'accepted',
        'uploading',
        'available',
        'received',
        'cancelled',
        'expired',
        'invalidated',
      ] as const,
      '传输状态',
    ),
    recipientKey: b.recipientKey === null ? null : transferPublicKey(b.recipientKey),
    envelope: b.envelope === null ? null : parseTransferEnvelope(b.envelope),
    uploadedChunks: transferCount(b.uploadedChunks, TRANSFER_LIMITS.chunks),
    receivedAt: b.receivedAt === null ? null : retentionDate(b.receivedAt),
    authorized: b.authorized,
  };
}
export type TransferAction =
  | { action: 'inspect'; transferId: string }
  | {
      action: 'accept';
      transferId: string;
      requestHash: string;
      publicKey: string;
      confirmReceive: true;
    }
  | {
      action: 'begin';
      transferId: string;
      requestHash: string;
      envelope: TransferEnvelope;
      confirmSend: true;
    }
  | {
      action: 'upload';
      transferId: string;
      requestHash: string;
      sequence: number;
      ciphertext: string;
      hash: string;
    }
  | { action: 'chunk'; transferId: string; requestHash: string; sequence: number }
  | {
      action: 'received';
      transferId: string;
      requestHash: string;
      snapshotHash: string;
      confirmVerified: true;
    }
  | { action: 'seal' | 'cancel'; transferId: string; requestHash: string };
export function parseTransferAction(input: unknown): TransferAction {
  const action = enumValue(
    (input as { action?: unknown } | null)?.action,
    ['inspect', 'accept', 'begin', 'upload', 'chunk', 'received', 'seal', 'cancel'] as const,
    '传输操作',
  );
  const extras: Record<typeof action, string[]> = {
    inspect: [],
    accept: ['publicKey', 'confirmReceive'],
    begin: ['envelope', 'confirmSend'],
    upload: ['sequence', 'ciphertext', 'hash'],
    chunk: ['sequence'],
    received: ['snapshotHash', 'confirmVerified'],
    seal: [],
    cancel: [],
  };
  const b = exact(input, [
    'action',
    'transferId',
    ...(action === 'inspect' ? [] : ['requestHash']),
    ...extras[action],
  ]);
  const transferId = nodeId(b.transferId);
  if (action === 'inspect') return { action, transferId };
  const base = { transferId, requestHash: checkpointHash(b.requestHash) };
  if (action === 'accept') {
    if (b.confirmReceive !== true)
      throw new DomainError('CONFIRMATION_REQUIRED', '缺少接收端本机同意');
    return { action, ...base, publicKey: transferPublicKey(b.publicKey), confirmReceive: true };
  }
  if (action === 'begin') {
    if (b.confirmSend !== true)
      throw new DomainError('CONFIRMATION_REQUIRED', '缺少源节点发送同意');
    return { action, ...base, envelope: parseTransferEnvelope(b.envelope), confirmSend: true };
  }
  if (action === 'received') {
    if (b.confirmVerified !== true)
      throw new DomainError('CONFIRMATION_REQUIRED', '未确认接收副本完整核验');
    return { action, ...base, snapshotHash: checkpointHash(b.snapshotHash), confirmVerified: true };
  }
  if (action === 'chunk')
    return { action, ...base, sequence: transferCount(b.sequence, TRANSFER_LIMITS.chunks, 1) };
  if (action === 'upload') {
    if (
      typeof b.ciphertext !== 'string' ||
      b.ciphertext.length < 24 ||
      b.ciphertext.length > 87404 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.ciphertext)
    )
      throw new DomainError('INVALID_INPUT', '密文块编码或长度无效');
    return {
      action,
      ...base,
      sequence: transferCount(b.sequence, TRANSFER_LIMITS.chunks, 1),
      ciphertext: b.ciphertext,
      hash: checkpointHash(b.hash),
    };
  }
  return { action, ...base };
}
