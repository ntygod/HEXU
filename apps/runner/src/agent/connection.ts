import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  controlOrigin,
  nodeId,
  type NodeHello,
  type PairingView,
} from '../../../../packages/contracts/src/nodes.js';
import {
  AgentStorage,
  readCredentials,
  writeCredentials,
  type NodeCredentials,
} from './storage.js';
import { captureSnapshot } from './workspaces.js';

const messages: Record<string, string> = {
  NODE_REVOKED: '节点或所有者的项目权限已撤销，停止同步。',
  NODE_AUTH_REQUIRED: '节点身份未获确认，请核对配对结果。',
  NODE_ALREADY_CONNECTED: '已有连接仍有效，等待旧连接过期后重试。',
  RECONNECT_REQUIRED: '连接过期，重新握手。',
  PAIRING_INVALID: '配对码不存在、已撤销或已过期。',
  PAIRING_USED: '配对码已经使用。',
  SEQUENCE_CONFLICT: '相同事件序号的内容发生变化，停止同步并保留现场。',
  SEQUENCE_GAP: '事件序号不连续，停止同步并保留现场。',
  WORKSPACE_SCOPE_MISMATCH: '目录范围与配对记录不一致。',
  CLOCK_SKEW: '采集时间超前，请核对系统时钟。',
  PROTOCOL_UNSUPPORTED: '节点协议版本不兼容。',
};
export async function nodeRequest<T>(
  origin: string,
  path: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  const url = controlOrigin(origin);
  if (!['pairing-preview', 'pair', 'hello', 'sync', 'goodbye', 'disconnect'].includes(path))
    throw new Error('Unsupported node endpoint');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Hexu-Runner': '1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const abort = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
  const response = await fetch(`${url}/runner/v1/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error',
    signal: abort,
    credentials: 'omit',
  });
  const reader = response.body?.getReader();
  if (!reader) throw new DomainError('INVALID_RESPONSE', '节点服务没有返回协议响应');
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 32768) {
        await reader.cancel();
        throw new DomainError('INVALID_RESPONSE', '节点响应超出上限');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let data: any;
  try {
    data = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new DomainError('INVALID_RESPONSE', '无法读取节点响应');
  }
  if (!response.ok) {
    const code =
      typeof data?.error?.code === 'string' && /^[A-Z_]{1,60}$/.test(data.error.code)
        ? data.error.code
        : 'NODE_REQUEST_FAILED';
    throw new DomainError(
      code,
      messages[code] ?? '节点请求未获接受，请在网页核对当前配置。',
      response.status,
    );
  }
  return data as T;
}
export function validatePreview(v: PairingView): PairingView {
  nodeId(v.id);
  nodeId(v.projectId);
  nodeId(v.spaceId);
  if (
    v.state !== 'pending' ||
    ![v.ownerName, v.spaceName, v.projectName].every(
      (n) => typeof n === 'string' && n.length <= 160,
    )
  )
    throw new DomainError('INVALID_RESPONSE', '配对预览不是有效的待确认项目');
  return v;
}
export class AgentConnection {
  readonly connectionId = randomUUID();
  credentials: NodeCredentials;
  connected = false;
  constructor(
    readonly storage: AgentStorage,
    private log: (message: string) => void = () => {},
  ) {
    this.credentials = readCredentials(storage.home);
  }
  async hello(signal?: AbortSignal) {
    const c = this.credentials;
    const hello = await nodeRequest<NodeHello>(
      c.controlUrl,
      'hello',
      { protocol: 1, connectionId: this.connectionId },
      c.nodeToken,
      signal,
    );
    nodeId(hello.nodeId);
    if (
      hello.protocol !== 1 ||
      hello.executionEnabled !== false ||
      hello.projectId !== c.projectId ||
      hello.spaceId !== c.spaceId ||
      hello.connectionId !== this.connectionId ||
      (c.nodeId && c.nodeId !== hello.nodeId)
    )
      throw new DomainError('SCOPE_MISMATCH', '服务端身份或项目范围与本机确认不一致，没有同步目录');
    this.storage.reconcile(hello.acknowledgedSequence);
    if (!c.nodeId) {
      c.nodeId = hello.nodeId;
      writeCredentials(this.storage.home, c);
    }
    this.connected = true;
    this.log('已连接；仅同步获授权的 Git 数量摘要，不接收执行命令。');
  }
  async cycle(signal?: AbortSignal) {
    if (!this.connected) await this.hello(signal);
    const item =
      this.storage.pending() ??
      this.storage.enqueue(await captureSnapshot(this.credentials.directories));
    const response = await nodeRequest<{ acknowledgedSequence: number }>(
      this.credentials.controlUrl,
      'sync',
      {
        connectionId: this.connectionId,
        sequence: item.sequence,
        snapshot: item.snapshot,
      },
      this.credentials.nodeToken,
      signal,
    );
    this.storage.acknowledge(response.acknowledgedSequence);
  }
  async goodbye() {
    if (!this.connected) return;
    try {
      await nodeRequest(
        this.credentials.controlUrl,
        'goodbye',
        { connectionId: this.connectionId },
        this.credentials.nodeToken,
      );
    } catch {
      this.log('未确认服务端断开；网页将按最后心跳时间显示陈旧或离线。');
    }
    this.connected = false;
  }
}
