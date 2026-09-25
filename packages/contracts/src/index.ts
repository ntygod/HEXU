export const taskStatuses = ['todo', 'in_progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export const runStates = [
  'queued',
  'preparing',
  'running',
  'waiting_input',
  'waiting_approval',
  'stopping',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type RunState = (typeof runStates)[number];
export type Tool = 'claude-code' | 'codex';
export type Scenario = 'success' | 'waiting_input' | 'waiting_approval' | 'failure';
export interface User {
  id: string;
  name: string;
  initial: string;
  color: string;
}
export interface Project {
  id: string;
  spaceId: string;
  name: string;
  description: string;
  color: string;
  revision: number;
}
export interface Task {
  id: string;
  shortId: string;
  spaceId: string;
  projectId: string | null;
  visibility: 'private' | 'project';
  title: string;
  description: string;
  ownerUserId: string;
  status: TaskStatus;
  revision: number;
  attention: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Message {
  id: string;
  taskId: string;
  actorType: 'human' | 'agent' | 'system';
  actorName: string;
  body: string;
  createdAt: string;
  resultId: string | null;
}
export interface Run {
  id: string;
  taskId: string;
  state: RunState;
  observation: 'fresh' | 'unknown';
  provider: 'mock';
  requestedTool: Tool;
  scenario: Scenario;
  previousRunId: string | null;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface Result {
  id: string;
  taskId: string;
  title: string;
  body: string;
  revision: number;
  kind: 'text' | 'demo-preview';
  createdAt: string;
  updatedAt: string;
}
export interface Workbench {
  mode: 'local-preview';
  user: User;
  members: User[];
  projects: Project[];
  tasks: Task[];
  results: Result[];
  runs: Run[];
}
export interface TaskDetail {
  task: Task;
  messages: Message[];
  runs: Run[];
  results: Result[];
}
export interface ApiErrorBody {
  error: { code: string; message: string; retryable: boolean };
  requestId: string;
}
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('INVALID_INPUT', '请求必须是 JSON 对象');
  return value as Record<string, unknown>;
};
export function text(value: unknown, name: string, max: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max)
    throw new DomainError(
      'INVALID_INPUT',
      `${name}需要${optional ? '有效文本' : '非空文本'}，最多 ${max} 个字符`,
    );
  return value.trim();
}
export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new DomainError('INVALID_INPUT', '需要有效的 expectedRevision');
  return value;
}
export function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new DomainError('INVALID_INPUT', `${label}不受支持`);
  return value as T;
}
export function parseTaskCreate(value: unknown) {
  const body = record(value);
  return {
    title: text(body.title, '任务标题', 160),
    description: text(body.description, '说明', 12000, true),
    projectId: body.projectId == null ? null : text(body.projectId, '项目', 100),
  };
}
export function parseRunCreate(value: unknown) {
  const body = record(value);
  if (body.provider !== 'mock')
    throw new DomainError('CAPABILITY_UNAVAILABLE', '本版本只支持模拟执行，原生工具尚未接通', 422);
  return {
    provider: 'mock' as const,
    requestedTool: enumValue(body.requestedTool, ['claude-code', 'codex'] as const, '工具'),
    scenario: enumValue(
      body.scenario ?? 'success',
      ['success', 'waiting_input', 'waiting_approval', 'failure'] as const,
      '场景',
    ),
    prompt: text(body.prompt, '要求', 12000, true),
    expectedRevision: revision(body.expectedRevision),
    reopenTask: body.reopenTask === true,
  };
}
