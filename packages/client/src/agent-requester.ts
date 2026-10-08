import { request } from './index.js';
import type {
  AgentRequesterCredential,
  AgentRequesterCredentialIssue,
  AgentRequesterCredentialIssued,
} from '../../contracts/src/agent-requester.js';

export const agentRequesterCredentialsPath = (taskId: string) =>
  `/tasks/${encodeURIComponent(taskId)}/agent-requester-credentials`;
export const agentRequesterCredentialRevokePath = (taskId: string, credentialId: string) =>
  `${agentRequesterCredentialsPath(taskId)}/${encodeURIComponent(credentialId)}/revoke`;

/** Owner-session administration only. The native requester bearer is never used here. */
export const listAgentRequesterCredentials = (taskId: string, signal?: AbortSignal) =>
  request<{ items: AgentRequesterCredential[] }>(agentRequesterCredentialsPath(taskId), { signal });
export const issueAgentRequesterCredential = (
  taskId: string,
  body: AgentRequesterCredentialIssue,
  key: string,
) =>
  request<AgentRequesterCredentialIssued>(agentRequesterCredentialsPath(taskId), {
    method: 'POST',
    body,
    key,
  });
export const revokeAgentRequesterCredential = (
  taskId: string,
  credentialId: string,
  expectedRevision: number,
  key: string,
) =>
  request<{ credential: AgentRequesterCredential }>(
    agentRequesterCredentialRevokePath(taskId, credentialId),
    {
      method: 'POST',
      body: { expectedRevision },
      key,
    },
  );
