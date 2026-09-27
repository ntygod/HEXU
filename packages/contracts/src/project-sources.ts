import { DomainError, enumValue, record, revision, text } from './index.js';

export type SourceKind = 'text' | 'link';
export interface SourceContent {
  title: string;
  content: string;
  url: string | null;
}
export interface SourceCreate extends SourceContent {
  kind: SourceKind;
}
export interface SourceEdit extends SourceContent {
  expectedRevision: number;
}
export interface SourceLifecycle {
  action: 'delete' | 'restore';
  expectedRevision: number;
}
export interface ProjectSource extends SourceContent {
  id: string;
  spaceId: string;
  projectId: string;
  kind: SourceKind;
  revision: number;
  contentHash: string;
  createdAt: string;
  createdByUserId: string;
  createdByName: string;
  updatedAt: string;
  updatedByUserId: string;
  updatedByName: string;
  deletedAt: string | null;
  deletedByUserId: string | null;
}
export type SourceSummary = Omit<ProjectSource, 'content'> & { excerpt: string };
export interface SourcePage {
  items: SourceSummary[];
  nextCursor: string | null;
}
export interface SourceRevision {
  action: 'created' | 'updated' | 'deleted' | 'restored';
  source: ProjectSource;
}
export interface SourceRevisionPage {
  items: SourceRevision[];
  nextCursor: number | null;
}
export interface SourceListQuery {
  state: 'active' | 'deleted';
  q: string;
  cursor: string | null;
  limit: number;
}

function strict(value: unknown, keys: string[]) {
  const body = record(value);
  if (Object.keys(body).some((key) => !keys.includes(key)))
    throw new DomainError('INVALID_INPUT', '资料请求包含不支持的字段');
  return body;
}
function sourceContent(body: Record<string, unknown>, kind: SourceKind): SourceContent {
  const title = text(body.title, '资料标题', 120);
  text(body.content, '资料正文或链接说明', 8000, kind === 'link');
  // Keep the exact supplied text, including code indentation and line breaks.
  const content = (body.content ?? '') as string;
  if (kind === 'text') {
    if (body.url !== undefined && body.url !== null)
      throw new DomainError('INVALID_INPUT', '文本资料不能包含链接字段');
    return { title, content, url: null };
  }
  const url = text(body.url, '资料链接', 2048);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DomainError('INVALID_INPUT', '请填写完整的 HTTP 或 HTTPS 链接');
  }
  if (
    !/^https?:\/\//i.test(url) ||
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    /[\u0000-\u001f\u007f]/.test(url) ||
    parsed.href.length > 2048
  )
    throw new DomainError(
      'INVALID_INPUT',
      '资料链接仅支持不含用户名或密码的 HTTP/HTTPS 地址，最多 2048 个字符',
    );
  return { title, content, url: parsed.href };
}
export function parseSourceCreate(value: unknown): SourceCreate {
  const body = strict(value, ['kind', 'title', 'content', 'url']);
  const kind = enumValue(body.kind, ['text', 'link'] as const, '资料类型');
  return { kind, ...sourceContent(body, kind) };
}
/** Full content replacement; source type, identity, author and project never come from the browser. */
export function parseSourceEdit(value: unknown, kind: SourceKind): SourceEdit {
  const body = strict(value, ['expectedRevision', 'title', 'content', 'url']);
  return { expectedRevision: revision(body.expectedRevision), ...sourceContent(body, kind) };
}
export function parseSourceLifecycle(value: unknown): SourceLifecycle {
  const body = strict(value, ['action', 'expectedRevision']);
  return {
    action: enumValue(body.action, ['delete', 'restore'] as const, '资料操作'),
    expectedRevision: revision(body.expectedRevision),
  };
}
function queryNumber(value: unknown, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    throw new DomainError('INVALID_INPUT', '资料分页需要正整数');
  return revision(Number(value));
}
export function parseSourceListQuery(value: unknown): SourceListQuery {
  const query = strict(value, ['state', 'q', 'cursor', 'limit']);
  const limit = queryNumber(query.limit, 20);
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 条资料');
  return {
    state:
      query.state === undefined
        ? 'active'
        : enumValue(query.state, ['active', 'deleted'] as const, '资料状态'),
    q: text(query.q, '资料搜索', 160, true),
    cursor: query.cursor === undefined ? null : text(query.cursor, '资料游标', 100),
    limit,
  };
}
export function parseSourceRevisionQuery(value: unknown) {
  const query = strict(value, ['before', 'limit']);
  const limit = queryNumber(query.limit, 10);
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 个资料修订');
  return { before: query.before === undefined ? null : queryNumber(query.before), limit };
}
