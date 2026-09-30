import { DomainError, revision, text } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash, commitOid } from './checkpoints.js';
import { retentionDate, type RetentionManifest } from './checkpoint-retention.js';
import { parseNextInputRefs, type NextInput, type NextInputRef } from './next-input.js';

export interface BranchWorkspaceTicket {
  id: string;
  taskId: string;
  branchId: string;
  branchRevision: number;
  groupId: string;
  startHash: string;
  ownerId: string;
  projectId: string;
  spaceId: string;
  sourceNodeId: string;
  retentionId: string;
  checkpointId: string;
  manifest: RetentionManifest;
  createdAt: string;
  expiresAt: string;
  requestHash: string;
}
export interface BranchWorkspaceProof {
  originHash: string;
  workspaceRef: string;
  restoreId: string;
  planHash: string;
  snapshotHash: string;
  verifiedAt: string;
}
export interface BranchWorkspaceOperation {
  ticket: BranchWorkspaceTicket;
  state: 'waiting_local' | 'prepared' | 'bound' | 'cancelled' | 'needs_attention';
  revision: number;
  proof: BranchWorkspaceProof | null;
  proofHash: string | null;
  nodeId: string | null;
  workingCopyId: string | null;
  updatedAt: string;
  reason: string | null;
}
export interface BranchExecutionBinding {
  branchId: string;
  groupId: string;
  operationId: string;
  startHash: string;
  originHash: string;
  commit: string;
  continueFrom?: BranchContinuationBinding;
}
export interface BranchContinuationBinding {
  inputs?: NextInputRef[];
  sourceRunId: string;
  sourceRunRevision: number;
  resultRevisionId: string;
  selectionRevision: number;
  code: {
    objectFormat: 'sha1' | 'sha256';
    commit: string;
    tree: string;
    repositoryIdentity: string;
    nodeRevision: number;
  };
}
export interface BranchContinuationPreview {
  inputOptions?: NextInput[];
  selection: ReturnType<typeof parseBranchRunSelection>;
  nodeId: string;
  workingCopyId: string;
  resultTitle: string;
  resultRevision: number;
  commit: string;
  contextText: string;
}
export function parseBranchExecutionBinding(input: unknown): BranchExecutionBinding {
  const b = exact(input, [
    'branchId',
    'groupId',
    'operationId',
    'startHash',
    'originHash',
    'commit',
    'continueFrom',
  ]);
  return {
    branchId: nodeId(b.branchId),
    groupId: nodeId(b.groupId),
    operationId: nodeId(b.operationId),
    startHash: checkpointHash(b.startHash),
    originHash: checkpointHash(b.originHash),
    commit: commitOid(b.commit),
    ...(b.continueFrom === undefined
      ? {}
      : { continueFrom: parseBranchContinuationBinding(b.continueFrom) }),
  };
}
function parseBranchContinuationBinding(input: unknown): BranchContinuationBinding {
  const b = exact(input, [
    'sourceRunId',
    'sourceRunRevision',
    'resultRevisionId',
    'selectionRevision',
    'code',
    'inputs',
  ]);
  const c = exact(b.code, ['objectFormat', 'commit', 'tree', 'repositoryIdentity', 'nodeRevision']);
  if (c.objectFormat !== 'sha1' && c.objectFormat !== 'sha256')
    throw new DomainError('INVALID_INPUT', '所选提交对象格式无效');
  return {
    sourceRunId: nodeId(b.sourceRunId),
    sourceRunRevision: revision(b.sourceRunRevision),
    resultRevisionId: nodeId(b.resultRevisionId),
    selectionRevision: revision(b.selectionRevision),
    ...(b.inputs === undefined ? {} : { inputs: parseNextInputRefs(b.inputs) }),
    code: {
      objectFormat: c.objectFormat,
      commit: commitOid(c.commit, c.objectFormat),
      tree: commitOid(c.tree, c.objectFormat),
      repositoryIdentity: checkpointHash(c.repositoryIdentity),
      nodeRevision: revision(c.nodeRevision),
    },
  };
}
function parseBranchContinuationSelection(input: unknown) {
  const b = exact(input, [
    'sourceRunId',
    'expectedRunRevision',
    'resultRevisionId',
    'expectedSelectionRevision',
    'inputs',
  ]);
  return {
    sourceRunId: nodeId(b.sourceRunId),
    expectedRunRevision: revision(b.expectedRunRevision),
    resultRevisionId: nodeId(b.resultRevisionId),
    expectedSelectionRevision: revision(b.expectedSelectionRevision),
    ...(b.inputs === undefined ? {} : { inputs: parseNextInputRefs(b.inputs) }),
  };
}
export function parseBranchWorkspaceCreate(input: unknown) {
  const b = exact(input, ['expectedRevision', 'retentionId', 'snapshotHash']);
  return {
    expectedRevision: revision(b.expectedRevision),
    retentionId: nodeId(b.retentionId),
    snapshotHash: checkpointHash(b.snapshotHash),
  };
}
export function parseBranchWorkspaceProof(input: unknown): BranchWorkspaceProof {
  const b = exact(input, [
    'originHash',
    'workspaceRef',
    'restoreId',
    'planHash',
    'snapshotHash',
    'verifiedAt',
  ]);
  return {
    originHash: checkpointHash(b.originHash),
    workspaceRef: checkpointHash(b.workspaceRef),
    restoreId: nodeId(b.restoreId),
    planHash: checkpointHash(b.planHash),
    snapshotHash: checkpointHash(b.snapshotHash),
    verifiedAt: retentionDate(b.verifiedAt),
  };
}
export function parseBranchWorkspaceCommand(input: unknown) {
  const action =
    input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  if (action === 'inspect') {
    const b = exact(input, ['action', 'operationId']);
    return { action, operationId: nodeId(b.operationId) } as const;
  }
  if (action === 'prepare') {
    const b = exact(input, ['action', 'operationId', 'requestHash', 'proof']);
    return {
      action,
      operationId: nodeId(b.operationId),
      requestHash: checkpointHash(b.requestHash),
      proof: parseBranchWorkspaceProof(b.proof),
    } as const;
  }
  if (action === 'bind') {
    const b = exact(input, ['action', 'operationId', 'requestHash', 'originHash', 'workspaceId']);
    return {
      action,
      operationId: nodeId(b.operationId),
      requestHash: checkpointHash(b.requestHash),
      originHash: checkpointHash(b.originHash),
      workspaceId: nodeId(b.workspaceId),
    } as const;
  }
  throw new DomainError('INVALID_INPUT', '不支持的方案现场命令');
}
export function parseBranchRunSelection(input: unknown) {
  const b = exact(input, ['branchId', 'expectedRevision', 'startHash', 'continueFrom']);
  return {
    branchId: nodeId(b.branchId),
    expectedRevision: revision(b.expectedRevision),
    startHash: checkpointHash(b.startHash),
    ...(b.continueFrom === undefined
      ? {}
      : { continueFrom: parseBranchContinuationSelection(b.continueFrom) }),
  };
}
/** Fixed shared input, intentionally excludes later discussion and sender sessions. */
export function branchContext(
  title: string,
  description: string,
  commit: string,
  name: string,
  goal: string,
) {
  return text(
    `# 共同任务\n${title}\n\n${description}\n\n# 共同代码提交\n${commit}\n\n# 当前方案：${name}\n${goal}`,
    '方案固定上下文',
    18000,
  );
}
/** Identical frontend preview and dispatch rendering; no original feedback is copied. */
export function branchContinuationContext(
  base: string,
  prompt: string,
  inputs?: Pick<NextInput, 'body' | 'authorName' | 'origin'>[],
) {
  let selected = '';
  if (inputs !== undefined) {
    const notes = inputs
      .map(
        (input, index) =>
          `${index + 1}. ${input.authorName}${input.origin ? `（来自成果 v${input.origin.resultRevision} 的反馈，已由保存者整理）` : ''}\n${input.body}`,
      )
      .join('\n\n');
    if (notes.length > 6000)
      throw new DomainError('MATERIAL_LIMIT', '所选下一轮要求合计超过 6000 字符，请减少选择');
    selected = `\n\n# 明确选择的下一轮要求\n${notes || '未选择'}`;
  }
  const rendered = `${base}${selected}\n\n# 本次要求\n${prompt}\n\n只使用已授权文件工具。不得执行 Shell、MCP 或仓库脚本；缺少能力时如实说明。`;
  if (rendered.length > 20000)
    throw new DomainError('MATERIAL_LIMIT', '本次材料超过 20000 字符，请缩短本次要求或减少选择');
  return rendered;
}
