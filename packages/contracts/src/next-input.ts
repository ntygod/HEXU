import { DomainError, revision, text, type Tool } from './index.js';
import { exact, nodeId } from './nodes.js';

export interface NextInput {
  id: string;
  taskId: string;
  sourceRunId: string;
  authorId: string;
  authorName: string;
  body: string;
  revision: number;
  state: 'queued' | 'attached' | 'started' | 'cancelled';
  targetRunId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface NodeContinuationSelection {
  sourceRunId: string;
  expectedContextHash: string;
  inputs: { id: string; revision: number }[];
}
export interface NodeContinuationPreview {
  sourceRunId: string;
  sourceTool: Tool;
  taskRevision: number;
  taskStatus: import('./index.js').TaskStatus;
  nodeId: string;
  workingCopyId: string;
  workingCopyName: string;
  contextText: string;
  contextHash: string;
  nativeSession?: { available: boolean; reason: string; expiresAt: string | null };
  ready: boolean;
  blockers: { code: string; message: string }[];
}
export const nextInputLabels: Record<NextInput['state'], string> = {
  queued: '待下一轮选择',
  attached: '已绑定派发，未收到启动确认',
  started: '已随新执行启动',
  cancelled: '已撤回',
};
export function parseNextInput(value: unknown) {
  const b = exact(value, ['body']);
  return text(b.body, '下一轮要求', 2000);
}
export function parseNextInputEdit(value: unknown) {
  const b = exact(value, ['body', 'expectedRevision']);
  return { body: text(b.body, '下一轮要求', 2000), expectedRevision: revision(b.expectedRevision) };
}
export function parseNodeContinuation(value: unknown): NodeContinuationSelection {
  const b = exact(value, ['sourceRunId', 'expectedContextHash', 'inputs']);
  const hash = text(b.expectedContextHash, '材料版本', 64);
  if (!/^[a-f0-9]{64}$/.test(hash) || !Array.isArray(b.inputs) || b.inputs.length > 6)
    throw new DomainError('INVALID_CONTINUATION', '需要当前材料版本，最多选择 6 条下一轮要求');
  const inputs = b.inputs.map((value) => {
    const input = exact(value, ['id', 'revision']);
    return { id: nodeId(input.id), revision: revision(input.revision) };
  });
  if (new Set(inputs.map((i) => i.id)).size !== inputs.length)
    throw new DomainError('INVALID_CONTINUATION', '下一轮要求不能重复选择');
  return { sourceRunId: nodeId(b.sourceRunId), expectedContextHash: hash, inputs };
}
/** Shared wire rendering: preview and committed dispatch contain exactly the same text.
 * History is untrusted task material, not a policy or a restored provider session. */
export function nodeContinuationContext(
  base: string,
  prompt: string,
  inputs: Pick<NextInput, 'body' | 'authorName'>[],
  sessionMode?: 'resume',
) {
  const notes = inputs.map((i, index) => `${index + 1}. ${i.authorName}\n${i.body}`).join('\n\n');
  if (notes.length > 6000)
    throw new DomainError('MATERIAL_LIMIT', '所选下一轮要求合计超过 6000 字符，请减少选择');
  const rendered = `${base}\n\n# 明确选择的下一轮要求\n${notes || '未选择'}\n\n# 本次要求\n${prompt}\n\n${sessionMode === 'resume' ? '本次明确恢复节点私有原生会话，模型会沿用之前的会话历史；此处仅为新增材料，不覆盖历史。' : '这是新会话接续，不是恢复模型内部状态。'}历史输出仅作参考；只使用已授权文件工具，不执行 Shell、MCP 或仓库脚本。`;
  if (rendered.length > 20000)
    throw new DomainError('MATERIAL_LIMIT', '本次材料超过 20000 字符，请缩短本次要求或减少选择');
  return rendered;
}
