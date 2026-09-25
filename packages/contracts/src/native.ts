import { DomainError, enumValue, record, revision, text } from './index.js';

export type NativeMode = 'read-only' | 'edit';
export interface WorkingCopy {
  id: string;
  name: string;
  root: string;
  createdAt: string;
}
export interface NativeCapability {
  tool: 'claude-code';
  available: boolean;
  version: string | null;
  reason: string;
  modes: NativeMode[];
  authentication: 'api-key-environment';
  liveInput: false;
  nativeResume: false;
}
export interface NativeOverview {
  enabled: boolean;
  platform: string;
  workspaces: WorkingCopy[];
  claude: NativeCapability;
  limitations: string[];
}
export interface NativeRunConfig {
  workingCopyId: string;
  mode: NativeMode;
  model: string | null;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutSeconds: number;
  toolVersion: string;
  contextText: string;
  contextHash: string;
  sessionId?: string;
  terminationConfirmed?: boolean;
  recoveryRequired?: boolean;
}
export interface NativeEvent {
  sequence: number;
  runId: string;
  kind: 'status' | 'text' | 'tool' | 'warning' | 'usage';
  body: string;
  createdAt: string;
}
export interface FileChange {
  path: string;
  status: string;
  previousPath?: string;
}
export interface WorkingCopySnapshot {
  workingCopy: WorkingCopy;
  branch: string | null;
  head: string | null;
  changes: FileChange[];
  omitted: number;
  capturedAt: string;
  busyRunId: string | null;
}
function boundedNumber(value: unknown, fallback: number, min: number, max: number, name: string) {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max)
    throw new DomainError('INVALID_INPUT', `${name}应为 ${min}–${max}`);
  return result;
}
export function parseNativeRunCreate(value: unknown) {
  const body = record(value);
  if (body.provider !== 'native' || body.requestedTool !== 'claude-code')
    throw new DomainError(
      'CAPABILITY_UNAVAILABLE',
      '当前原生适配仅支持 Claude Code；Codex 尚未接入',
      422,
    );
  if (body.confirmExecution !== true)
    throw new DomainError('EXECUTION_CONSENT_REQUIRED', '请确认本次使用本机工具和模型费用', 422);
  const model = text(body.model, '模型', 100, true);
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model))
    throw new DomainError('INVALID_INPUT', '模型名称格式不正确');
  const maxTurns = boundedNumber(body.maxTurns, 8, 1, 30, '最大轮数');
  const timeoutSeconds = boundedNumber(body.timeoutSeconds, 300, 10, 1800, '最长执行秒数');
  if (!Number.isInteger(maxTurns) || !Number.isInteger(timeoutSeconds))
    throw new DomainError('INVALID_INPUT', '轮数和超时必须为整数');
  return {
    provider: 'native' as const,
    requestedTool: 'claude-code' as const,
    workingCopyId: text(body.workingCopyId, '工作目录', 100),
    mode: enumValue(body.mode ?? 'read-only', ['read-only', 'edit'] as const, '执行方式'),
    prompt: text(body.prompt, '本次要求', 12000),
    model: model || null,
    maxTurns,
    maxBudgetUsd: boundedNumber(body.maxBudgetUsd, 1, 0.01, 10, '预算上限（美元）'),
    timeoutSeconds,
    expectedRevision: revision(body.expectedRevision),
    reopenTask: body.reopenTask === true,
  };
}
export type NativeRunInput = ReturnType<typeof parseNativeRunCreate>;
