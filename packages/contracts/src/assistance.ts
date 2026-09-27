import { DomainError, enumValue, record, revision, text } from './index.js';

export type AssistanceState = 'open' | 'responded' | 'closed' | 'cancelled';
export interface AssistanceRange {
  start: number;
  end: number;
}
export interface AssistancePreview {
  sourceMessageId: string;
  sourceHash: string;
  actorType: 'human' | 'agent';
  actorName: string;
  createdAt: string;
  text: string;
  originalChars: number;
  truncated: boolean;
}
export interface AssistanceCreate {
  recipientUserId: string;
  question: string;
  sourceMessageId: string;
  expectedSourceHash: string;
  ranges: AssistanceRange[];
  expiresInDays: 1 | 7 | 30;
  confirmShare: true;
}
export interface AssistanceSnapshot {
  text: string;
  actorType: 'human' | 'agent';
  actorName: string;
  createdAt: string;
  selectedChars: number;
  omittedChars: number;
}
export interface AssistanceSummary {
  id: string;
  question: string;
  requesterId: string;
  requesterName: string;
  recipientId: string;
  recipientName: string;
  state: AssistanceState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  grantRevokedAt: string | null;
  grantReason: string | null;
  canReply: boolean;
  canManage: boolean;
  // Only present when the current caller has independent access to the original task.
  task: { id: string; shortId: string; title: string } | null;
}
export interface AssistanceView extends AssistanceSummary {
  snapshot: AssistanceSnapshot;
  sourceChanged: boolean;
}
export interface AssistanceReply {
  id: string;
  assistanceId: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}
export interface AssistancePage {
  items: AssistanceSummary[];
  nextCursor: string | null;
}
export interface AssistanceReplyPage {
  items: AssistanceReply[];
  nextCursor: string | null;
}
export interface AssistanceCandidates {
  items: { id: string; name: string }[];
  nextCursor: string | null;
}
function strict(value: unknown, fields: string[]) {
  const b = record(value);
  if (Object.keys(b).some((key) => !fields.includes(key)))
    throw new DomainError('INVALID_INPUT', '协助请求包含不支持的字段');
  return b;
}
export function parseAssistanceRanges(value: unknown): AssistanceRange[] {
  if (!Array.isArray(value) || !value.length || value.length > 16)
    throw new DomainError('INVALID_INPUT', '请选择 1–16 个协助材料片段');
  const ranges = value
    .map((item) => {
      const b = strict(item, ['start', 'end']);
      if (
        typeof b.start !== 'number' ||
        typeof b.end !== 'number' ||
        !Number.isInteger(b.start) ||
        !Number.isInteger(b.end) ||
        b.start < 0 ||
        b.end <= b.start ||
        b.end > 12000
      )
        throw new DomainError('INVALID_INPUT', '协助材料片段范围无效');
      return { start: b.start, end: b.end };
    })
    .sort((a, b) => a.start - b.start);
  if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1]!.end))
    throw new DomainError('INVALID_INPUT', '协助材料片段不能重叠');
  return ranges;
}
export function assistanceExcerpt(value: string, input: AssistanceRange[]) {
  const ranges = parseAssistanceRanges(input);
  const split = (at: number) =>
    /[\uD800-\uDBFF]/.test(value[at - 1] ?? '') && /[\uDC00-\uDFFF]/.test(value[at] ?? '');
  if (ranges.some((range) => range.end > value.length || split(range.start) || split(range.end)))
    throw new DomainError('ASSISTANCE_SOURCE_CHANGED', '所选片段无效，请重新核对来源', 409);
  const result = ranges.map((range) => value.slice(range.start, range.end)).join('\n\n');
  if (!result.trim() || result.length > 12000)
    throw new DomainError('INVALID_INPUT', '分享片段需要有效文本，合计最多 12000 字符');
  return result;
}
export function parseAssistanceCreate(value: unknown): AssistanceCreate {
  const b = strict(value, [
    'recipientUserId',
    'question',
    'sourceMessageId',
    'expectedSourceHash',
    'ranges',
    'expiresInDays',
    'confirmShare',
  ]);
  if (b.confirmShare !== true)
    throw new DomainError('SHARE_CONFIRMATION_REQUIRED', '请核对接收者和所选分享内容', 409);
  const expectedSourceHash = text(b.expectedSourceHash, '来源版本', 64);
  if (!/^[a-f0-9]{64}$/.test(expectedSourceHash))
    throw new DomainError('INVALID_INPUT', '协助来源版本无效');
  const expiresInDays = b.expiresInDays ?? 7;
  if (![1, 7, 30].includes(expiresInDays as number))
    throw new DomainError('INVALID_INPUT', '协助访问期限应为 1、7 或 30 天');
  return {
    recipientUserId: text(b.recipientUserId, '接收者', 100),
    question: text(b.question, '协助问题', 2000),
    sourceMessageId: text(b.sourceMessageId, '来源消息', 100),
    expectedSourceHash,
    ranges: parseAssistanceRanges(b.ranges),
    expiresInDays: expiresInDays as 1 | 7 | 30,
    confirmShare: true,
  };
}
export function parseAssistanceReply(value: unknown) {
  const b = strict(value, ['body']);
  return { body: text(b.body, '协助回复', 8000) };
}
export function parseAssistanceLifecycle(value: unknown) {
  const b = strict(value, ['action', 'expectedRevision']);
  return {
    action: enumValue(b.action, ['close', 'cancel'] as const, '协助操作'),
    expectedRevision: revision(b.expectedRevision),
  };
}
export function parseAssistancePageQuery(value: unknown, search = false) {
  const b = strict(value, search ? ['q', 'cursor', 'limit'] : ['cursor', 'limit']);
  const limit = b.limit === undefined ? 20 : Number(b.limit);
  if (
    (b.limit !== undefined && (typeof b.limit !== 'string' || !/^[1-9]\d*$/.test(b.limit))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new DomainError('INVALID_INPUT', '每次最多读取 50 条协助记录');
  return {
    limit,
    cursor: b.cursor === undefined ? null : text(b.cursor, '协助游标', 100),
    q: text(b.q, '成员搜索', 160, true),
  };
}
