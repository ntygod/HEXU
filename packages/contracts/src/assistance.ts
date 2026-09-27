import { DomainError, enumValue, record, revision, text } from './index.js';

export const ASSISTANCE_SOURCE_LIMIT = 12000;
export const ASSISTANCE_EXCERPT_LIMIT = 6000;
export type AssistanceState = 'open' | 'responded' | 'closed' | 'cancelled';
export interface AssistancePerson {
  id: string;
  name: string;
}
export interface AssistanceRange {
  start: number;
  end: number;
}
export interface AssistanceSnapshot {
  text: string;
  actorType: 'human' | 'agent';
  actorName: string;
  createdAt: string;
  sourceHash: string;
}
export interface AssistancePreview {
  messageId: string;
  sourceHash: string;
  taskRevision: number;
  content: string;
  truncated: boolean;
  actorType: 'human' | 'agent';
  actorName: string;
  createdAt: string;
}
export interface Assistance {
  recipientKind?: 'ai';
  ai?: { run: import('./index.js').Run; inputText: string; inputHash: string };
  id: string;
  question: string;
  requester: AssistancePerson;
  recipient: AssistancePerson;
  state: AssistanceState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  snapshot: AssistanceSnapshot;
  snapshotHash: string;
  sourceChanged: boolean | null;
  taskLink: { id: string; title: string; shortId: string } | null;
  canReply: boolean;
  canManage: boolean;
  accessEnded: boolean;
}
export interface AssistanceReply {
  actorType?: 'agent';
  runId?: string;
  id: string;
  revision: number;
  author: AssistancePerson;
  body: string;
  createdAt: string;
}
export interface AssistanceDetail {
  assistance: Assistance;
  replies: AssistanceReply[];
  nextBefore: number | null;
}
export interface AssistanceList {
  items: Omit<Assistance, 'snapshot'>[];
  nextCursor: string | null;
}
export interface AssistanceRecipients {
  items: AssistancePerson[];
  nextCursor: string | null;
}
function strict(value: unknown, fields: string[]) {
  const b = record(value);
  if (Object.keys(b).some((key) => !fields.includes(key)))
    throw new DomainError('INVALID_INPUT', '协助请求包含不支持的字段');
  return b;
}
export function parseAssistanceRange(value: unknown): AssistanceRange {
  const b = strict(value, ['start', 'end']);
  if (
    typeof b.start !== 'number' ||
    typeof b.end !== 'number' ||
    !Number.isInteger(b.start) ||
    !Number.isInteger(b.end) ||
    b.start < 0 ||
    b.end <= b.start ||
    b.end > ASSISTANCE_SOURCE_LIMIT ||
    b.end - b.start > ASSISTANCE_EXCERPT_LIMIT
  )
    throw new DomainError('INVALID_INPUT', '请选择一段不超过 6000 字符的消息摘录');
  return { start: b.start, end: b.end };
}
export function selectedAssistanceText(content: string, value: AssistanceRange) {
  const range = parseAssistanceRange(value);
  const split = (i: number) =>
    i > 0 &&
    i < content.length &&
    ((/[\uD800-\uDBFF]/.test(content[i - 1]!) && /[\uDC00-\uDFFF]/.test(content[i]!)) ||
      (content[i - 1] === '\r' && content[i] === '\n'));
  if (range.end > content.length || split(range.start) || split(range.end))
    throw new DomainError('ASSISTANCE_RANGE_CHANGED', '选区越界或拆开字符，请重新选择', 409);
  const result = content.slice(range.start, range.end);
  if (!result.trim()) throw new DomainError('INVALID_INPUT', '分享片段不能只有空白');
  return result;
}
export function parseAssistanceCreate(value: unknown) {
  const b = strict(value, [
    'sourceMessageId',
    'expectedSourceHash',
    'expectedTaskRevision',
    'range',
    'recipientId',
    'question',
    'shareConfirmed',
  ]);
  const expectedSourceHash = text(b.expectedSourceHash, '来源版本', 64);
  if (!/^[a-f0-9]{64}$/.test(expectedSourceHash))
    throw new DomainError('INVALID_INPUT', '来源版本无效，请重新查看消息');
  if (b.shareConfirmed !== true)
    throw new DomainError('SHARING_CONFIRMATION_REQUIRED', '请确认本次接收者与分享片段', 422);
  text(b.question, '协助问题', 2000);
  return {
    sourceMessageId: text(b.sourceMessageId, '来源消息', 100),
    expectedSourceHash,
    expectedTaskRevision: revision(b.expectedTaskRevision),
    range: parseAssistanceRange(b.range),
    recipientId: text(b.recipientId, '接收者', 150),
    question: b.question as string,
    shareConfirmed: true as const,
  };
}
export function parseAssistanceReply(value: unknown) {
  const b = strict(value, ['body', 'expectedRevision']);
  text(b.body, '协助回复', 6000);
  return { body: b.body as string, expectedRevision: revision(b.expectedRevision) };
}
export function parseAssistanceStateChange(value: unknown) {
  const b = strict(value, ['expectedRevision', 'action']);
  return {
    expectedRevision: revision(b.expectedRevision),
    action: enumValue(b.action, ['close', 'cancel'] as const, '协助操作'),
  };
}
function page(b: Record<string, unknown>) {
  const limit = b.limit === undefined ? 20 : Number(b.limit);
  if (
    (b.limit !== undefined && (typeof b.limit !== 'string' || !/^[1-9]\d*$/.test(b.limit))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new DomainError('INVALID_INPUT', '每次最多读取 50 条协助记录');
  return { limit, cursor: b.cursor === undefined ? null : text(b.cursor, '协助游标', 150) };
}
export function parseAssistanceList(value: unknown) {
  const b = strict(value, ['box', 'state', 'cursor', 'limit']);
  return {
    ...page(b),
    box:
      b.box === undefined
        ? ('received' as const)
        : enumValue(b.box, ['received', 'sent'] as const, '协助范围'),
    state:
      b.state === undefined
        ? ('active' as const)
        : enumValue(b.state, ['active', 'all'] as const, '协助状态'),
  };
}
export function parseAssistanceRecipients(value: unknown) {
  const b = strict(value, ['q', 'cursor', 'limit']);
  return { ...page(b), q: text(b.q, '同事搜索', 100, true) };
}
export function parseAssistanceHistory(value: unknown) {
  const b = strict(value, ['before', 'limit']);
  if (b.before !== undefined && (typeof b.before !== 'string' || !/^[1-9]\d*$/.test(b.before)))
    throw new DomainError('INVALID_INPUT', '协助历史游标无效');
  return {
    limit: page(b).limit,
    before: b.before === undefined ? null : revision(Number(b.before)),
  };
}
