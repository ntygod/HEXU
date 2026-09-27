import { DomainError, enumValue, record, revision, text } from './index.js';

export interface DraftOrigin {
  messageId: string;
  actorName: string;
  createdAt: string;
  hash: string;
  excerpt: string;
  truncated: boolean;
}
export interface AiDraft {
  id: string;
  taskId: string;
  title: string;
  content: string;
  contentHash: string;
  origin: DraftOrigin;
  revision: number;
  createdAt: string;
  createdByUserId: string;
  createdByName: string;
  updatedAt: string;
  updatedByUserId: string;
  updatedByName: string;
}
export interface DraftPreview {
  origin: DraftOrigin;
  initialContent: string;
  contentTruncated: boolean;
}
export interface DraftRange {
  start: number;
  end: number;
}
export interface DraftTarget {
  kind: 'task' | 'source';
  id: string;
  title: string;
  content: string;
  revision: number;
  limit: number;
}
export interface DraftAdoptionInput {
  expectedRevision: number;
  ranges: DraftRange[];
  mode: 'append' | 'replace';
  target: Pick<DraftTarget, 'kind' | 'id'> & { expectedRevision: number };
}
export interface DraftAdoption {
  id: string;
  taskId: string;
  draftId: string;
  draftRevision: number;
  draftHash: string;
  ranges: DraftRange[];
  selectedText: string;
  mode: DraftAdoptionInput['mode'];
  target: Pick<DraftTarget, 'kind' | 'id' | 'title'> & {
    beforeRevision: number;
    afterRevision: number;
    beforeContent: string;
    afterContent: string;
  };
  createdAt: string;
  createdByUserId: string;
  createdByName: string;
}
export interface DraftPage {
  items: Omit<AiDraft, 'content'>[];
  nextCursor: string | null;
}
export interface DraftHistory {
  items: AiDraft[];
  nextCursor: number | null;
}
export interface DraftAdoptionPage {
  items: DraftAdoption[];
  nextCursor: string | null;
}
function strict(value: unknown, fields: string[]) {
  const b = record(value);
  if (Object.keys(b).some((key) => !fields.includes(key)))
    throw new DomainError('INVALID_INPUT', '草稿请求包含不支持的字段');
  return b;
}
function content(b: Record<string, unknown>) {
  const title = text(b.title, '草稿标题', 120);
  text(b.content, '草稿正文', 12000);
  return { title, content: b.content as string };
}
export function parseDraftCreate(value: unknown) {
  const b = strict(value, ['sourceMessageId', 'expectedSourceHash', 'title', 'content']);
  const expectedSourceHash = text(b.expectedSourceHash, '来源版本', 64);
  if (!/^[a-f0-9]{64}$/.test(expectedSourceHash))
    throw new DomainError('INVALID_INPUT', '来源版本无效，请重新查看原回复');
  return {
    ...content(b),
    sourceMessageId: text(b.sourceMessageId, '来源消息', 100),
    expectedSourceHash,
  };
}
export function parseDraftEdit(value: unknown) {
  const b = strict(value, ['expectedRevision', 'title', 'content']);
  return { ...content(b), expectedRevision: revision(b.expectedRevision) };
}
export function parseDraftRanges(value: unknown): DraftRange[] {
  if (!Array.isArray(value) || !value.length || value.length > 16)
    throw new DomainError('INVALID_INPUT', '请选择 1–16 个草稿片段');
  const ranges = value
    .map((v) => {
      const b = strict(v, ['start', 'end']);
      if (
        typeof b.start !== 'number' ||
        typeof b.end !== 'number' ||
        !Number.isInteger(b.start) ||
        !Number.isInteger(b.end) ||
        b.start < 0 ||
        b.end <= b.start ||
        b.end > 12000
      )
        throw new DomainError('INVALID_INPUT', '草稿片段范围无效');
      return { start: b.start, end: b.end };
    })
    .sort((a, b) => a.start - b.start);
  if (ranges.some((r, i) => i > 0 && r.start < ranges[i - 1]!.end))
    throw new DomainError('INVALID_INPUT', '草稿片段不能重叠');
  return ranges;
}
export function parseDraftTarget(value: unknown) {
  const b = strict(value, ['kind', 'id']);
  return {
    kind: enumValue(b.kind, ['task', 'source'] as const, '采用目标'),
    id: text(b.id, '目标 ID', 100),
  };
}
export function parseDraftAdoption(value: unknown): DraftAdoptionInput {
  const b = strict(value, ['expectedRevision', 'ranges', 'mode', 'target']);
  const target = strict(b.target, ['kind', 'id', 'expectedRevision']);
  return {
    expectedRevision: revision(b.expectedRevision),
    ranges: parseDraftRanges(b.ranges),
    mode: enumValue(b.mode, ['append', 'replace'] as const, '采用方式'),
    target: {
      ...parseDraftTarget({ kind: target.kind, id: target.id }),
      expectedRevision: revision(target.expectedRevision),
    },
  };
}
export function selectedDraftText(content: string, input: DraftRange[]) {
  const ranges = parseDraftRanges(input);
  const splitPair = (i: number) =>
    i > 0 &&
    i < content.length &&
    /[\uD800-\uDBFF]/.test(content[i - 1]!) &&
    /[\uDC00-\uDFFF]/.test(content[i]!);
  if (ranges.some((r) => r.end > content.length || splitPair(r.start) || splitPair(r.end)))
    throw new DomainError('DRAFT_RANGE_CHANGED', '所选片段超出草稿或拆开字符，请重新选择', 409);
  const result = ranges.map((r) => content.slice(r.start, r.end)).join('\n\n');
  if (!result.trim()) throw new DomainError('INVALID_INPUT', '采用片段不能只有空白');
  return result;
}
export function composeDraftAdoption(
  target: DraftTarget,
  selected: string,
  mode: DraftAdoptionInput['mode'],
) {
  const result =
    mode === 'append' && target.content ? `${target.content}\n\n${selected}` : selected;
  if (result.length > target.limit)
    throw new DomainError(
      'DRAFT_TARGET_LIMIT',
      `采用后超过目标的 ${target.limit} 字符上限，请减少片段`,
      422,
    );
  return result;
}
export function parseDraftPageQuery(value: unknown) {
  const b = strict(value, ['cursor', 'limit']);
  const limit = b.limit === undefined ? 20 : Number(b.limit);
  if (
    (b.limit !== undefined && (typeof b.limit !== 'string' || !/^[1-9]\d*$/.test(b.limit))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new DomainError('INVALID_INPUT', '每次最多读取 50 条草稿记录');
  return { limit, cursor: b.cursor === undefined ? null : text(b.cursor, '草稿游标', 100) };
}
export function parseDraftHistoryQuery(value: unknown) {
  const b = strict(value, ['before', 'limit']);
  const { limit } = parseDraftPageQuery({ ...(b.limit === undefined ? {} : { limit: b.limit }) });
  if (b.before !== undefined && (typeof b.before !== 'string' || !/^[1-9]\d*$/.test(b.before)))
    throw new DomainError('INVALID_INPUT', '草稿历史游标无效');
  return { limit, before: b.before === undefined ? null : revision(Number(b.before)) };
}
