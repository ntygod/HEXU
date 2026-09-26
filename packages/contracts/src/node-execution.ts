import { parseNodeContinuation, type NodeContinuationSelection } from './next-input.js';
import { DomainError, enumValue, revision, text, type Tool, type RunState } from './index.js';
import { exact, nodeId, parseSequence } from './nodes.js';

/** Separate, explicitly enabled channel. Metadata pairing never enables this protocol. */
export interface ExecutionPolicy {
  grantId: string;
  tool: Tool;
  model: string | null;
  mode: 'read-only' | 'edit';
  workspaceIds: string[];
  timeoutSeconds: number;
  maxTurns: number;
  maxBudgetUsd: number | null;
  toolVersion: string;
  retainSessions?: true;
}
export interface NativeSessionInfo {
  ref: string;
  action: 'created' | 'resumed';
  expiresAt: string;
}
export interface SessionRequest {
  ref: string;
  sourceDispatchId: string;
}
export interface NodeRunInfo {
  nodeId: string;
  nodeName: string;
  workingCopyId: string;
  workingCopyName: string;
  dispatchId: string;
  policyHash: string;
  mode: 'read-only' | 'edit';
  model: string | null;
  timeoutSeconds: number;
  maxBudgetUsd: number | null;
  phase: 'queued' | 'accepted' | 'preparing' | 'running' | 'unknown' | 'terminal';
  terminationConfirmed: boolean;
  acceptedAt?: string;
  permittedAt?: string;
  startedAt?: string;
  continuationInputIds?: string[];
  sessionMode?: 'resume';
  nativeSession?: NativeSessionInfo;
}
export interface NodeRunInput {
  provider: 'node';
  nodeId: string;
  workingCopyId: string;
  policyHash: string;
  mode: 'read-only' | 'edit';
  prompt: string;
  expectedRevision: number;
  reopenTask: boolean;
  confirmExecution: true;
  continuation?: NodeContinuationSelection;
  sessionMode?: 'resume';
}
export interface DispatchCommand {
  id: string;
  generation: string;
  runId: string;
  taskId: string;
  projectId: string;
  workspaceId: string;
  policyHash: string;
  policy: ExecutionPolicy;
  mode: 'read-only' | 'edit';
  context: string;
  expiresAt: string;
  session?: SessionRequest;
}
export interface ExecutionEvent {
  sequence: number;
  kind: 'accepted' | 'running' | 'output' | 'terminal' | 'unknown';
  text: string;
  result: 'succeeded' | 'failed' | 'cancelled' | null;
  terminationConfirmed: boolean;
  nativeSession?: NativeSessionInfo;
}
export interface NodeExecutionOption {
  nodeId: string;
  name: string;
  available: boolean;
  reason: string;
  policyHash: string;
  policy: ExecutionPolicy;
  workspaces: { id: string; name: string }[];
}
export function parsePolicy(value: unknown): ExecutionPolicy {
  const b = exact(value, [
    'grantId',
    'tool',
    'model',
    'mode',
    'workspaceIds',
    'timeoutSeconds',
    'maxTurns',
    'maxBudgetUsd',
    'toolVersion',
    'retainSessions',
  ]);
  const tool = enumValue(b.tool, ['claude-code', 'codex'] as const, '工具');
  if (b.retainSessions !== undefined && (b.retainSessions !== true || tool !== 'codex'))
    throw new DomainError('INVALID_POLICY', '原生会话保留目前仅支持明确启用的 Codex');
  const integer = (n: unknown, min: number, max: number) => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
      throw new DomainError('INVALID_POLICY', `执行限额应为 ${min}–${max} 的整数`);
    return n;
  };
  if (!Array.isArray(b.workspaceIds) || b.workspaceIds.length < 1 || b.workspaceIds.length > 8)
    throw new DomainError('INVALID_POLICY', '需要明确的目录授权');
  const workspaceIds = b.workspaceIds.map((id) => nodeId(id));
  if (new Set(workspaceIds).size !== workspaceIds.length)
    throw new DomainError('INVALID_POLICY', '目录重复');
  const model = b.model == null ? null : text(b.model, '模型', 100);
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model))
    throw new DomainError('INVALID_POLICY', '模型名称无效');
  if (
    (tool === 'codex' && b.maxBudgetUsd !== null) ||
    (tool === 'claude-code' &&
      (typeof b.maxBudgetUsd !== 'number' ||
        !Number.isFinite(b.maxBudgetUsd) ||
        b.maxBudgetUsd < 0.01 ||
        b.maxBudgetUsd > 10))
  )
    throw new DomainError('INVALID_POLICY', 'Claude 预算应为 0.01–10 美元；Codex 不支持美元硬预算');
  return {
    grantId: nodeId(b.grantId),
    tool,
    model,
    mode: enumValue(b.mode, ['read-only', 'edit'] as const, '模式'),
    workspaceIds,
    timeoutSeconds: integer(b.timeoutSeconds, 10, 600),
    maxTurns: integer(b.maxTurns, 1, 30),
    maxBudgetUsd: b.maxBudgetUsd as number | null,
    toolVersion: text(b.toolVersion, '工具版本', 200),
    ...(b.retainSessions === true ? { retainSessions: true as const } : {}),
  };
}
export function parseNodeRun(value: unknown): NodeRunInput {
  const b = exact(value, [
    'provider',
    'nodeId',
    'workingCopyId',
    'policyHash',
    'mode',
    'prompt',
    'expectedRevision',
    'reopenTask',
    'confirmExecution',
    'continuation',
    'sessionMode',
  ]);
  if (b.provider !== 'node' || b.confirmExecution !== true)
    throw new DomainError('EXECUTION_CONSENT_REQUIRED', '请确认共享输出、目录范围及模型费用', 422);
  if (b.sessionMode !== undefined && (b.sessionMode !== 'resume' || !b.continuation))
    throw new DomainError('INVALID_SESSION_MODE', '恢复原会话必须明确选择来源执行');
  const hash = text(b.policyHash, '授权版本', 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new DomainError('INVALID_INPUT', '授权版本无效');
  return {
    provider: 'node',
    nodeId: nodeId(b.nodeId),
    workingCopyId: nodeId(b.workingCopyId),
    policyHash: hash,
    mode: enumValue(b.mode, ['read-only', 'edit'] as const, '模式'),
    prompt: text(b.prompt, '本次要求', 6000),
    expectedRevision: revision(b.expectedRevision),
    reopenTask: b.reopenTask === true,
    confirmExecution: true,
    ...(b.sessionMode === 'resume' ? { sessionMode: 'resume' as const } : {}),
    ...(b.continuation === undefined
      ? {}
      : { continuation: parseNodeContinuation(b.continuation) }),
  };
}
export function parseExecutionEvent(value: unknown): ExecutionEvent {
  const b = exact(value, [
    'sequence',
    'kind',
    'text',
    'result',
    'terminationConfirmed',
    'nativeSession',
  ]);
  const kind = enumValue(
    b.kind,
    ['accepted', 'running', 'output', 'terminal', 'unknown'] as const,
    '事件',
  );
  const result =
    b.result === null
      ? null
      : enumValue(b.result, ['succeeded', 'failed', 'cancelled'] as const, '结果');
  if (
    typeof b.terminationConfirmed !== 'boolean' ||
    (kind === 'terminal' && (!result || !b.terminationConfirmed)) ||
    (kind !== 'terminal' && (result !== null || b.terminationConfirmed))
  )
    throw new DomainError('INVALID_EVENT', '终态必须明确确认进程已停止；其他事件不能伪造终态');
  if (b.nativeSession !== undefined && (kind !== 'terminal' || result !== 'succeeded'))
    throw new DomainError('INVALID_SESSION_EVENT', '只有成功终态可声明会话已保留');
  return {
    ...(b.nativeSession === undefined
      ? {}
      : { nativeSession: parseNativeSession(b.nativeSession) }),
    sequence: parseSequence(b.sequence),
    kind,
    text: text(b.text, '事件文本', 6000, true),
    result,
    terminationConfirmed: b.terminationConfirmed,
  };
}

export function parseNativeSession(value: unknown): NativeSessionInfo {
  const b = exact(value, ['ref', 'action', 'expiresAt']);
  if (typeof b.expiresAt !== 'string' || !Number.isFinite(Date.parse(b.expiresAt)))
    throw new DomainError('INVALID_SESSION_EVENT', '会话期限无效');
  return {
    ref: nodeId(b.ref),
    action: enumValue(b.action, ['created', 'resumed'] as const, '会话操作'),
    expiresAt: b.expiresAt,
  };
}
export function parseSessionRequest(value: unknown): SessionRequest {
  const b = exact(value, ['ref', 'sourceDispatchId']);
  return { ref: nodeId(b.ref), sourceDispatchId: nodeId(b.sourceDispatchId) };
}
