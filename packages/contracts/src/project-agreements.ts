import { DomainError, enumValue, record, revision, text } from './index.js';
export type AgreementState = 'active' | 'inactive' | 'superseded';
export interface DiscussionOrigin {
  projectId: string;
  taskId: string;
  taskShortId: string;
  taskTitle: string;
  messageId: string;
  actorType: 'human' | 'agent';
  actorName: string;
  createdAt: string;
  hash: string;
  excerpt: string;
  truncated: boolean;
}
export interface AgreementPreview {
  origin: DiscussionOrigin;
  initialContent: string;
  contentTruncated: boolean;
}
export interface AgreementContent {
  title: string;
  content: string;
}
export interface AgreementCreate extends AgreementContent {
  sourceTaskId: string;
  sourceMessageId: string;
  expectedSourceHash: string;
  replaces: { id: string; expectedRevision: number } | null;
}
export interface AgreementEdit extends AgreementContent {
  expectedRevision: number;
}
export interface AgreementLifecycle {
  action: 'deactivate' | 'reactivate';
  expectedRevision: number;
  reason: string;
}
export interface ProjectAgreement extends AgreementContent {
  id: string;
  projectId: string;
  spaceId: string;
  revision: number;
  state: AgreementState;
  contentHash: string;
  origin: DiscussionOrigin;
  replacesId: string | null;
  supersededById: string | null;
  statusReason: string | null;
  createdAt: string;
  createdByUserId: string;
  createdByName: string;
  updatedAt: string;
  updatedByUserId: string;
  updatedByName: string;
}
export type AgreementSummary = Omit<ProjectAgreement, 'content' | 'origin'> & { excerpt: string };
export interface AgreementPage {
  items: AgreementSummary[];
  nextCursor: string | null;
}
export interface AgreementRevision {
  action: 'created' | 'updated' | 'deactivated' | 'reactivated' | 'superseded';
  agreement: ProjectAgreement;
}
export interface AgreementHistory {
  items: AgreementRevision[];
  nextCursor: number | null;
}
export interface AgreementNotice {
  projectId: string;
  version: number;
  activeCount: number;
}
function strict(value: unknown, keys: string[]) {
  const body = record(value);
  if (Object.keys(body).some((key) => !keys.includes(key)))
    throw new DomainError('INVALID_INPUT', '约定请求包含不支持的字段');
  return body;
}
function content(body: Record<string, unknown>): AgreementContent {
  const title = text(body.title, '约定标题', 120);
  text(body.content, '约定正文', 8000);
  return { title, content: body.content as string };
}
export function parseAgreementCreate(value: unknown): AgreementCreate {
  const body = strict(value, [
    'title',
    'content',
    'sourceTaskId',
    'sourceMessageId',
    'expectedSourceHash',
    'replaces',
  ]);
  const hash = text(body.expectedSourceHash, '讨论来源版本', 64);
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new DomainError('INVALID_INPUT', '讨论来源版本无效，请重新选择原消息');
  let replaces: AgreementCreate['replaces'] = null;
  if (body.replaces !== undefined && body.replaces !== null) {
    const source = strict(body.replaces, ['id', 'expectedRevision']);
    replaces = {
      id: text(source.id, '被替代约定', 100),
      expectedRevision: revision(source.expectedRevision),
    };
  }
  return {
    ...content(body),
    sourceTaskId: text(body.sourceTaskId, '来源任务', 100),
    sourceMessageId: text(body.sourceMessageId, '来源消息', 100),
    expectedSourceHash: hash,
    replaces,
  };
}
export function parseAgreementEdit(value: unknown): AgreementEdit {
  const body = strict(value, ['expectedRevision', 'title', 'content']);
  return { ...content(body), expectedRevision: revision(body.expectedRevision) };
}
export function parseAgreementLifecycle(value: unknown): AgreementLifecycle {
  const body = strict(value, ['expectedRevision', 'action', 'reason']);
  return {
    expectedRevision: revision(body.expectedRevision),
    action: enumValue(body.action, ['deactivate', 'reactivate'] as const, '约定操作'),
    reason: text(body.reason, '原因', 600, true),
  };
}
function positive(value: unknown, defaultValue: number) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    throw new DomainError('INVALID_INPUT', '约定分页需要正整数');
  return revision(Number(value));
}
export function parseAgreementQuery(value: unknown) {
  const query = strict(value, ['state', 'q', 'cursor', 'limit']);
  const limit = positive(query.limit, 20);
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 条约定');
  return {
    state:
      query.state === undefined
        ? ('active' as const)
        : enumValue(query.state, ['active', 'inactive', 'superseded', 'all'] as const, '约定状态'),
    q: text(query.q, '约定搜索', 160, true),
    cursor: query.cursor === undefined ? null : text(query.cursor, '约定游标', 100),
    limit,
  };
}
export function parseAgreementHistoryQuery(value: unknown) {
  const query = strict(value, ['before', 'limit']);
  const limit = positive(query.limit, 10);
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 个约定修订');
  return { before: query.before === undefined ? null : positive(query.before, 1), limit };
}
