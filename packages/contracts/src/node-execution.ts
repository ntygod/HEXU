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
}
export interface ExecutionEvent {
  sequence: number;
  kind: 'accepted' | 'running' | 'output' | 'terminal' | 'unknown';
  text: string;
  result: 'succeeded' | 'failed' | 'cancelled' | null;
  terminationConfirmed: boolean;
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
  ]);
  const tool = enumValue(b.tool, ['claude-code', 'codex'] as const, '工具');
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
  ]);
  if (b.provider !== 'node' || b.confirmExecution !== true)
    throw new DomainError('EXECUTION_CONSENT_REQUIRED', '请确认共享输出、目录范围及模型费用', 422);
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
    ...(b.continuation === undefined
      ? {}
      : { continuation: parseNodeContinuation(b.continuation) }),
  };
}
export function parseExecutionEvent(value: unknown): ExecutionEvent {
  const b = exact(value, ['sequence', 'kind', 'text', 'result', 'terminationConfirmed']);
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
  return {
    sequence: parseSequence(b.sequence),
    kind,
    text: text(b.text, '事件文本', 6000, true),
    result,
    terminationConfirmed: b.terminationConfirmed,
  };
}
