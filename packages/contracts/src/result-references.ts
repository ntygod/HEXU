import { DomainError, enumValue, revision, text } from './index.js';
import { exact, nodeId } from './nodes.js';

export interface ResultReferenceCreate {
  action: 'register';
  expectedResultRevision: number;
  kind: 'report' | 'release';
  title: string;
  url: string;
  /** A short human explanation, never execution settings or authentication. */
  environment?: string;
}
export interface ResultReferenceLifecycle {
  action: 'withdraw';
  expectedResultRevision: number;
  expectedRevision: number;
}
export interface ResultReferenceOriginal {
  id: string;
  taskId: string;
  resultId: string;
  resultRevisionId: string;
  resultRevision: number;
  kind: ResultReferenceCreate['kind'];
  title: string;
  url: string;
  environment: string;
  source: { kind: 'member'; actor: { id: string; name: string } };
  createdAt: string;
  /** User registration does not establish reachability or publication. */
  availability: 'unverified';
  publication: 'unverified';
}
export interface ResultReference extends ResultReferenceOriginal {
  revision: number;
  status: 'active' | 'withdrawn';
  withdrawnAt: string | null;
  withdrawnBy: { id: string; name: string } | null;
}
export interface ResultReferencePage {
  items: ResultReference[];
  nextCursor: string | null;
}
export interface ResultReferenceListQuery {
  cursor: string | null;
  limit: number;
}

const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function plain(value: unknown, label: string, limit: number, optional = false) {
  const result = text(value, label, limit, optional);
  if (typeof value === 'string' && controls.test(value))
    throw new DomainError('INVALID_INPUT', `${label}只接受单行文字`);
  return result;
}

/** Reject credential-shaped fragments, not a general secret detector. */
function credentialFragment(fragment: string) {
  return (
    /(?:^|[^a-z0-9])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|key|password|passwd|secret|client[_-]?secret|credential|authorization|auth|bearer|signature|sig)(?:\s*[=:\/]|[_-])/i.test(
      fragment,
    ) ||
    /(?:^|[^a-z0-9])(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|sk-[a-z0-9_-]+|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)/i.test(
      fragment,
    )
  );
}

export function normalizeResultReferenceUrl(value: unknown): string {
  const url = text(value, '关联链接', 2048);
  const invalid = () =>
    new DomainError(
      'INVALID_INPUT',
      '请使用不含查询参数、用户名、密码或凭证片段的完整 HTTP/HTTPS 稳定链接，最多 2048 个字符',
    );
  if (typeof value !== 'string' || controls.test(value) || value.includes('\\')) throw invalid();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid();
  }
  if (
    !/^https?:\/\/[^/?#\\]+/i.test(url) ||
    // Reject even empty userinfo (https://@host), which URL normalizes away.
    url.match(/^https?:\/\/([^/?#]+)/i)?.[1]?.includes('@') ||
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    // URL.search alone does not detect an explicitly supplied empty query ("?").
    url.split('#')[0]!.includes('?') ||
    parsed.href.length > 2048
  )
    throw invalid();
  let decoded = url;
  // Also reject percent-encoded controls/backslashes and credential fragment keys.
  // Bound nested decoding; excessively encoded inputs do not become accepted loopholes.
  for (let depth = 0; depth < 5; depth++) {
    if (controls.test(decoded) || decoded.includes('\\')) throw invalid();
    if (credentialFragment(decoded.slice(decoded.indexOf('#') + 1)) && decoded.includes('#'))
      throw invalid();
    if (!/%[0-9a-f]{2}/i.test(decoded)) return parsed.href;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return parsed.href;
      decoded = next;
    } catch {
      throw invalid();
    }
  }
  throw invalid();
}

function environmentDescription(value: unknown) {
  const result = plain(value, '环境说明', 240, true);
  if (
    /^[{[]/.test(result) ||
    /(?:^|[\s;,])[-\w.]+\s*=/.test(result) ||
    credentialFragment(result) ||
    /(?:^|\s)bearer\s+\S+/i.test(result)
  )
    throw new DomainError('INVALID_INPUT', '环境只填写简短说明，请勿填写配置、认证信息或令牌');
  return result;
}

export function parseResultReferenceCreate(value: unknown): ResultReferenceCreate {
  const body = exact(value, [
    'action',
    'expectedResultRevision',
    'kind',
    'title',
    'url',
    'environment',
  ]);
  return {
    action: enumValue(body.action, ['register'] as const, '关联操作'),
    expectedResultRevision: revision(body.expectedResultRevision),
    kind: enumValue(body.kind, ['report', 'release'] as const, '关联类型'),
    title: plain(body.title, '关联标题', 160),
    url: normalizeResultReferenceUrl(body.url),
    environment: environmentDescription(body.environment),
  };
}
export function parseResultReferenceLifecycle(value: unknown): ResultReferenceLifecycle {
  const body = exact(value, ['action', 'expectedResultRevision', 'expectedRevision']);
  return {
    action: enumValue(body.action, ['withdraw'] as const, '关联操作'),
    expectedResultRevision: revision(body.expectedResultRevision),
    expectedRevision: revision(body.expectedRevision),
  };
}
export function parseResultReferenceListQuery(value: unknown): ResultReferenceListQuery {
  const query = exact(value, ['cursor', 'limit']);
  if (
    query.limit !== undefined &&
    (typeof query.limit !== 'string' || !/^[1-9]\d*$/.test(query.limit))
  )
    throw new DomainError('INVALID_INPUT', '关联分页需要正整数');
  const limit = query.limit === undefined ? 20 : revision(Number(query.limit));
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 条关联');
  return {
    cursor: query.cursor === undefined ? null : nodeId(query.cursor, '关联游标'),
    limit,
  };
}
