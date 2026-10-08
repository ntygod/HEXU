/** Stateless, loopback-only adapter. No cookies, redirect following, retries or model calls. */
export interface BridgeConfiguration {
  baseURL: string;
  token: string;
  role: 'requester' | 'receiver';
  requestId?: string;
}
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: 'not_sent' | 'rejected' | 'unknown' = 'rejected',
  ) {
    super(message);
  }
}
export function bridgeConfiguration(env: NodeJS.ProcessEnv): BridgeConfiguration {
  let url: URL;
  try {
    url = new URL(env.HEXU_CONTROL_URL ?? 'http://127.0.0.1:4310');
  } catch {
    throw new BridgeError('CONFIGURATION_INVALID', 'Invalid HEXU control URL', 'not_sent');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new BridgeError(
      'LOCAL_ONLY',
      'Only an explicit loopback HTTP origin is supported',
      'not_sent',
    );
  const role = env.HEXU_AGENT_ROLE;
  const token = env.HEXU_AGENT_TOKEN ?? '';
  if (role !== 'requester' && role !== 'receiver')
    throw new BridgeError(
      'CONFIGURATION_INVALID',
      'HEXU_AGENT_ROLE must be requester or receiver',
      'not_sent',
    );
  const prefix = role === 'requester' ? 'hexu_requester_' : 'hexu_request_';
  if (!new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`).test(token))
    throw new BridgeError(
      'CONFIGURATION_INVALID',
      'A matching independent limited credential is required',
      'not_sent',
    );
  const requestId = env.HEXU_REQUEST_ID;
  if (role === 'receiver' && (!requestId || !/^[A-Za-z0-9_-]{1,150}$/.test(requestId)))
    throw new BridgeError(
      'CONFIGURATION_INVALID',
      'Receiver requires the exact pre-authorized request ID',
      'not_sent',
    );
  return { baseURL: url.origin, token, role, ...(role === 'receiver' ? { requestId } : {}) };
}
export class HexuTransport {
  constructor(readonly config: BridgeConfiguration) {}
  async request(
    path: string,
    body?: unknown,
    operationKey?: string,
  ): Promise<Record<string, unknown>> {
    const writing = body !== undefined;
    const timeout = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await fetch(`${this.config.baseURL}${path}`, {
        method: writing ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'x-hexu-agent-api': '1',
          ...(writing ? { 'content-type': 'application/json' } : {}),
          ...(operationKey ? { 'idempotency-key': operationKey } : {}),
        },
        ...(writing ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: timeout,
      });
      if (response.headers.get('x-hexu-agent-api') !== '1') {
        await response.body?.cancel();
        throw new BridgeError(
          'API_VERSION_MISMATCH',
          'Control API version is unsupported; inspect the original request before retrying a write',
          writing ? 'unknown' : 'rejected',
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty');
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('response limit');
        }
        chunks.push(chunk.value);
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('shape');
      const data = result as Record<string, unknown>;
      if (!response.ok) {
        const error = data.error as { code?: unknown; message?: unknown } | undefined;
        const code =
          typeof error?.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code)
            ? error.code
            : 'CONTROL_REJECTED';
        // Never forward arbitrary response text, which may include credentials or reflected input.
        throw new BridgeError(
          code,
          `HEXU rejected this action (HTTP ${response.status}). Re-read current request and authority.`,
          response.status >= 500 && writing ? 'unknown' : 'rejected',
        );
      }
      return data;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        'CONTROL_UNAVAILABLE',
        writing
          ? 'Write outcome is unknown. Query the original request or creation receipt; do not create a new operation key.'
          : 'Control service unavailable or response invalid. This read may be retried.',
        writing ? 'unknown' : 'not_sent',
      );
    }
  }
  async verify() {
    return this.request(
      this.config.role === 'requester'
        ? '/agent-requester/v1/identity'
        : '/agent-assistance/v1/identity',
    );
  }
}
