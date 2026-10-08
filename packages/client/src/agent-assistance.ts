import { request } from './index.js';
import type {
  AgentAssistancePreview,
  AgentAssistancePreviewCommand,
} from '../../contracts/src/agent-assistance.js';
export const agentAssistancePreview = (
  taskId: string,
  body: AgentAssistancePreviewCommand,
  signal?: AbortSignal,
) =>
  request<AgentAssistancePreview>(`/tasks/${encodeURIComponent(taskId)}/agent-assistance-preview`, {
    method: 'POST',
    body,
    signal,
  });
