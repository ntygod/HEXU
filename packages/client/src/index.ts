let activeSpace = '';
export function setActiveSpace(id: string) {
  activeSpace = id;
}
export function getActiveSpace() {
  return activeSpace;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'X-Hexu-Client': 'web' };
  if (activeSpace) headers['X-Hexu-Space'] = activeSpace;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if ((options.method ?? 'GET') !== 'GET')
    headers['Idempotency-Key'] = options.key ?? crypto.randomUUID();
  const response = await fetch('/api/v1' + path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (!path.startsWith('/identity')) {
      if (response.status === 401) window.dispatchEvent(new Event('hexu-auth-required'));
      if (data?.error?.code === 'SPACE_ACCESS_REVOKED')
        window.dispatchEvent(new Event('hexu-space-revoked'));
    }
    throw new ApiError(
      data?.error?.message ?? '无法完成操作，请稍后重试',
      data?.error?.code ?? 'REQUEST_FAILED',
      response.status,
    );
  }
  if (data == null) throw new ApiError('服务返回了无法读取的数据', 'INVALID_RESPONSE', 502);
  return data as T;
}
