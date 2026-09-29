import {
  createHash,
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  TRANSFER_LIMITS as limits,
  type TransferTicket,
  type TransferEnvelope,
  transferPublicKey,
} from '../../../../packages/contracts/src/checkpoint-transfer.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { verifySnapshot, type SnapshotObject, type ObjectType } from './checkpoint-objects.js';
export const transferDigest = (v: unknown) =>
  createHash('sha256').update(canonicalJson(v)).digest('hex');
export const bytesHash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
export function transferKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
}
function key(privateKey: string, publicKey: string, ticket: TransferTicket) {
  const shared = diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.from(privateKey, 'hex'),
      type: 'pkcs8',
      format: 'der',
    }),
    publicKey: createPublicKey({
      key: Buffer.from(transferPublicKey(publicKey), 'hex'),
      type: 'spki',
      format: 'der',
    }),
  });
  try {
    return Buffer.from(
      hkdfSync(
        'sha256',
        shared,
        Buffer.from(ticket.requestHash, 'hex'),
        'HEXU checkpoint transfer v1',
        32,
      ),
    );
  } finally {
    shared.fill(0);
  }
}
const magic = Buffer.from('HEXU-SNAPSHOT-1\n');
const types: ObjectType[] = ['commit', 'tree', 'blob'];
export function packSnapshot(objects: SnapshotObject[]) {
  if (objects.length > limits.objects)
    throw new DomainError('TRANSFER_LIMIT', '对象超过本次传输上限');
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length);
  const parts = [magic, count];
  let size = magic.length + 4;
  for (const o of objects) {
    const oid = Buffer.from(o.id, 'hex'),
      h = Buffer.alloc(6);
    h[0] = types.indexOf(o.type);
    h[1] = oid.length;
    h.writeUInt32BE(o.data.length, 2);
    size += h.length + oid.length + o.data.length;
    if (size > limits.payload) throw new DomainError('TRANSFER_LIMIT', '传输包过大');
    parts.push(h, oid, o.data);
  }
  return Buffer.concat(parts);
}
export async function unpackSnapshot(payload: Buffer, ticket: TransferTicket) {
  const bad = () => new DomainError('TRANSFER_CORRUPT', '接收材料不完整或损坏，没有发布可用副本');
  if (
    payload.length > limits.payload ||
    payload.length < magic.length + 4 ||
    !payload.subarray(0, magic.length).equals(magic)
  )
    throw bad();
  const count = payload.readUInt32BE(magic.length),
    map = new Map<string, SnapshotObject>();
  if (count !== ticket.manifest.coverage.objects || count > limits.objects) throw bad();
  let offset = magic.length + 4,
    bytes = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 6 > payload.length) throw bad();
    const type = types[payload[offset]!],
      width = payload[offset + 1]!,
      size = payload.readUInt32BE(offset + 2);
    offset += 6;
    if (
      !type ||
      width !== (ticket.manifest.objectFormat === 'sha1' ? 20 : 32) ||
      size > 8 * 1024 * 1024 ||
      offset + width + size > payload.length
    )
      throw bad();
    const id = payload.subarray(offset, offset + width).toString('hex');
    offset += width;
    if (map.has(id)) throw bad();
    map.set(id, { id, type, data: payload.subarray(offset, offset + size) });
    offset += size;
    bytes += size;
    if (bytes > limits.bytes) throw bad();
  }
  if (offset !== payload.length || bytes !== ticket.manifest.coverage.bytes) throw bad();
  const m = ticket.manifest;
  const result = await verifySnapshot(m.objectFormat, m.commit, m.tree, async (oid, type, max) => {
    const o = map.get(oid);
    if (!o || o.type !== type || o.data.length > max) throw bad();
    return o.data;
  });
  if (
    result.snapshotHash !== m.snapshotHash ||
    canonicalJson(result.coverage) !== canonicalJson(m.coverage) ||
    result.objects.length !== map.size
  )
    throw bad();
  return result.objects;
}
function aad(
  ticket: TransferTicket,
  recipientKey: string,
  envelope: Omit<TransferEnvelope, 'digest'>,
  sequence: number,
) {
  return Buffer.from(
    canonicalJson({ version: 1, ticket: ticket.requestHash, recipientKey, ...envelope, sequence }),
  );
}
function nonce(envelope: TransferEnvelope | Omit<TransferEnvelope, 'digest'>, sequence: number) {
  const n = Buffer.alloc(12);
  Buffer.from(envelope.noncePrefix, 'hex').copy(n);
  n.writeUInt32BE(sequence, 8);
  return n;
}
export function encryptSnapshot(payload: Buffer, ticket: TransferTicket, recipientKey: string) {
  if (!payload.length || payload.length > limits.payload)
    throw new DomainError('TRANSFER_LIMIT', '传输包超限');
  const keys = transferKeys(),
    secret = key(keys.privateKey, recipientKey, ticket);
  const header = {
    senderKey: keys.publicKey,
    noncePrefix: randomBytes(8).toString('hex'),
    bytes: payload.length,
    chunks: Math.ceil(payload.length / limits.chunk),
  };
  try {
    const chunks: Buffer[] = [];
    for (let i = 0; i < header.chunks; i++) {
      const cipher = createCipheriv('aes-256-gcm', secret, nonce(header, i + 1));
      cipher.setAAD(aad(ticket, recipientKey, header, i + 1));
      const encrypted = Buffer.concat([
        cipher.update(payload.subarray(i * limits.chunk, (i + 1) * limits.chunk)),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      chunks.push(encrypted);
    }
    return { envelope: { ...header, digest: bytesHash(Buffer.concat(chunks)) }, chunks };
  } finally {
    secret.fill(0);
  }
}
export function decryptSnapshot(
  chunks: Buffer[],
  ticket: TransferTicket,
  recipientKey: string,
  privateKey: string,
  envelope: TransferEnvelope,
) {
  const { digest, ...header } = envelope;
  if (chunks.length !== envelope.chunks || bytesHash(Buffer.concat(chunks)) !== digest)
    throw new DomainError('TRANSFER_CORRUPT', '密文包缺失或指纹不符');
  const secret = key(privateKey, envelope.senderKey, ticket);
  try {
    const parts = chunks.map((chunk, i) => {
      const expected = Math.min(limits.chunk, envelope.bytes - i * limits.chunk) + 16;
      if (chunk.length !== expected) throw new Error('Chunk size mismatch');
      const decipher = createDecipheriv('aes-256-gcm', secret, nonce(envelope, i + 1));
      decipher.setAAD(aad(ticket, recipientKey, header, i + 1));
      decipher.setAuthTag(chunk.subarray(-16));
      return Buffer.concat([decipher.update(chunk.subarray(0, -16)), decipher.final()]);
    });
    return Buffer.concat(parts);
  } catch {
    throw new DomainError('TRANSFER_CORRUPT', '接收密文认证失败，未保存可用对象');
  } finally {
    secret.fill(0);
  }
}
