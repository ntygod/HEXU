import { DomainError, record, revision, text } from './index.js';

export interface ProjectPatch {
  expectedRevision: number;
  name?: string;
  description?: string;
}
export interface ProjectRevision {
  projectId: string;
  revision: number;
  name: string;
  description: string;
  actorId: string | null;
  actorName: string | null;
  savedAt: string | null;
}
export interface ProjectRevisionPage {
  items: ProjectRevision[];
  nextCursor: number | null;
}
export function parseProjectPatch(value: unknown): ProjectPatch {
  const body = record(value);
  if (Object.keys(body).some((key) => !['expectedRevision', 'name', 'description'].includes(key)))
    throw new DomainError('INVALID_INPUT', '项目设置只接受名称、说明和修订号');
  if (body.name === undefined && body.description === undefined)
    throw new DomainError('INVALID_INPUT', '请提供要修改的项目名称或说明');
  return {
    expectedRevision: revision(body.expectedRevision),
    ...(body.name !== undefined ? { name: text(body.name, '项目名称', 100) } : {}),
    ...(body.description !== undefined
      ? { description: text(body.description, '项目说明', 2000, true) }
      : {}),
  };
}
export function parseProjectRevisionQuery(value: unknown) {
  const body = record(value);
  if (Object.keys(body).some((key) => !['before', 'limit'].includes(key)))
    throw new DomainError('INVALID_INPUT', '不支持的项目修订查询参数');
  const number = (value: unknown) => {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
      throw new DomainError('INVALID_INPUT', '修订查询需要正整数');
    return revision(Number(value));
  };
  const limit = body.limit === undefined ? 10 : number(body.limit);
  if (limit > 50) throw new DomainError('INVALID_INPUT', '每次最多读取 50 个项目修订');
  return { limit, before: body.before === undefined ? null : number(body.before) };
}
