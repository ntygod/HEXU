import { request } from './index.js';
import type {
  AgentParticipantView,
  AgentConnectionIssue,
  parseAgentConnection,
  AgentCapabilityListing,
  AgentCapabilitySelection,
  parseAgentRegistration,
  parseAgentUpdate,
  parseAgentEndpoint,
  parseAgentCapability,
  parseDelegationGrant,
} from '../../contracts/src/agent-capabilities.js';
export type AgentWriteBody =
  | ReturnType<typeof parseAgentConnection>
  | ReturnType<typeof parseAgentRegistration>
  | ReturnType<typeof parseAgentUpdate>
  | ReturnType<typeof parseAgentEndpoint>
  | ReturnType<typeof parseAgentCapability>
  | ReturnType<typeof parseDelegationGrant>
  | { expectedRevision: number };
export interface AgentWritePacket {
  path: string;
  method: 'POST' | 'PATCH';
  body: AgentWriteBody;
  key: string;
}
export const myAgents = (signal?: AbortSignal) =>
  request<{ items: AgentParticipantView[] }>('/agent-participants', { signal });
export const saveAgentPacket = (packet: AgentWritePacket) =>
  request<AgentParticipantView | AgentConnectionIssue>(packet.path, packet);
export const projectAgentCapabilities = (projectId: string, signal?: AbortSignal) =>
  request<{ items: AgentCapabilityListing[] }>(
    `/projects/${encodeURIComponent(projectId)}/agent-capabilities`,
    { signal },
  );
export const selectAgentCapability = (
  projectId: string,
  capabilityId: string,
  expectedVersion: number,
) =>
  request<AgentCapabilitySelection>(
    `/projects/${encodeURIComponent(projectId)}/agent-capabilities/${encodeURIComponent(capabilityId)}/select`,
    { method: 'POST', body: { expectedVersion } },
  );

export type AgentWriteResult = AgentParticipantView | AgentConnectionIssue;
