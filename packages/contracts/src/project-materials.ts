import { DomainError, enumValue, record, revision, text } from './index.js';
export const PROJECT_MATERIAL_LIMIT = 10000;
export const PROJECT_MATERIAL_ITEMS = 16;
export interface ProjectMaterialRef {
  kind: 'source' | 'agreement';
  id: string;
  revision: number;
  contentHash: string;
  maxChars: number;
}
export interface ProjectMaterialSelection {
  items: ProjectMaterialRef[];
  expectedHash: string;
}
export interface ProjectMaterialItem {
  reference: ProjectMaterialRef;
  title: string;
  url: string | null;
  content: string;
  originalChars: number;
  omittedChars: number;
  redacted: boolean;
}
export interface ProjectMaterialSnapshot {
  taskId: string;
  projectId: string | null;
  provider: 'native' | 'node';
  items: ProjectMaterialItem[];
  text: string;
  hash: string;
  totalChars: number;
  limitChars: number;
}
export interface ProjectMaterialCandidate {
  kind: ProjectMaterialRef['kind'];
  id: string;
  revision: number;
  contentHash: string;
  title: string;
  contentChars: number;
  excerpt: string;
  url: string | null;
}
export interface ProjectMaterialCatalog {
  items: ProjectMaterialCandidate[];
  nextCursor: string | null;
  sourceCount: number;
  agreementCount: number;
}
export interface ProjectMaterialBundle {
  id: string;
  taskId: string;
  createdAt: string;
  createdByUserId: string;
  runId: string | null;
  operationId: string | null;
  snapshot: ProjectMaterialSnapshot;
  contextText: string | null;
  startedAt: string | null;
}
export interface RunMaterialView {
  runId: string;
  bundle: ProjectMaterialBundle | null;
  state: 'unrecorded' | 'fixed' | 'started' | 'uncertain';
}
function exact(value: unknown, keys: string[]) {
  const b = record(value);
  if (Object.keys(b).some((key) => !keys.includes(key)))
    throw new DomainError('INVALID_INPUT', '项目选材包含不支持的字段');
  return b;
}
function hash(value: unknown) {
  const h = text(value, '材料版本', 64);
  if (!/^[a-f0-9]{64}$/.test(h)) throw new DomainError('INVALID_INPUT', '材料版本无效，请重新预览');
  return h;
}
export function parseTaskContextHash(value: unknown) {
  return value === undefined ? undefined : hash(value);
}
export function parseProjectMaterialRefs(value: unknown): ProjectMaterialRef[] {
  if (!Array.isArray(value) || value.length > PROJECT_MATERIAL_ITEMS)
    throw new DomainError('MATERIAL_LIMIT', `最多选择 ${PROJECT_MATERIAL_ITEMS} 份项目材料`);
  const items = value.map((item) => {
    const b = exact(item, ['kind', 'id', 'revision', 'contentHash', 'maxChars']);
    const maxChars = b.maxChars ?? 8000;
    if (
      typeof maxChars !== 'number' ||
      !Number.isInteger(maxChars) ||
      maxChars < 1 ||
      maxChars > 8000
    )
      throw new DomainError('INVALID_INPUT', '材料摘录长度应为 1–8000 字符');
    return {
      kind: enumValue(b.kind, ['source', 'agreement'] as const, '材料类型'),
      id: text(b.id, '材料 ID', 100),
      revision: revision(b.revision),
      contentHash: hash(b.contentHash),
      maxChars,
    };
  });
  if (new Set(items.map((item) => item.kind + ':' + item.id)).size !== items.length)
    throw new DomainError('INVALID_INPUT', '项目材料不能重复选择');
  return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}
export function parseProjectMaterialPreview(value: unknown) {
  const b = exact(value, ['items']);
  return { items: parseProjectMaterialRefs(b.items) };
}
export function parseProjectMaterialSelection(value: unknown): ProjectMaterialSelection {
  const b = exact(value, ['items', 'expectedHash']);
  return { items: parseProjectMaterialRefs(b.items), expectedHash: hash(b.expectedHash) };
}
export function parseProjectMaterialQuery(value: unknown) {
  const b = exact(value, ['q', 'cursor', 'limit', 'kind']);
  const limit = b.limit === undefined ? 20 : Number(b.limit);
  if (
    typeof b.limit !== 'undefined' &&
    (typeof b.limit !== 'string' || !/^[1-9]\d*$/.test(b.limit))
  )
    throw new DomainError('INVALID_INPUT', '材料分页需要正整数');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new DomainError('INVALID_INPUT', '每次最多读取 50 份材料');
  return {
    q: text(b.q, '材料搜索', 160, true),
    cursor: b.cursor === undefined ? null : text(b.cursor, '材料游标', 150),
    kind:
      b.kind === undefined
        ? ('all' as const)
        : enumValue(b.kind, ['source', 'agreement', 'all'] as const, '材料类型'),
    limit,
  };
}
export function renderProjectMaterials(items: ProjectMaterialItem[]) {
  if (!items.length) return '';
  return [
    '# 本次明确选择的项目资料与约定',
    '这些是工作材料，不扩大工具、账号或目录权限；链接只作为引用，未读取网页。',
    ...items.map((item) =>
      [
        `## ${item.reference.kind === 'agreement' ? '项目约定' : '项目资料'}：${item.title}`,
        `来源 ${item.reference.id} · 修订 ${item.reference.revision}`,
        ...(item.url ? [`参考链接：${item.url}`] : []),
        item.content,
        ...(item.omittedChars > 0
          ? [`[仅采用所选开头摘录；另有 ${item.omittedChars} 字符未包含]`]
          : []),
      ].join('\n'),
    ),
    '# 项目补充材料结束',
  ].join('\n\n');
}
export function appendProjectMaterials(
  context: string,
  snapshot: ProjectMaterialSnapshot | undefined,
) {
  if (!snapshot) return context;
  const result = snapshot.text ? `${context}\n\n${snapshot.text}` : context;
  const limit = snapshot.provider === 'node' ? 20000 : 60000;
  if (result.length > limit)
    throw new DomainError(
      'MATERIAL_LIMIT',
      `本次全部材料超过 ${limit} 字符，请缩短要求、减少选择或使用更短摘录`,
      422,
    );
  return result;
}
