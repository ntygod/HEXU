import { DomainError, revision, text } from './index.js';
import { exact, nodeId, publicName } from './nodes.js';
import type { CommitCheckpoint } from './checkpoints.js';

export interface WorkBranchStart {
  taskRevision: number;
  taskTitle: string;
  taskDescription: string;
  checkpoint: CommitCheckpoint;
}
export interface WorkBranchGroup {
  id: string;
  taskId: string;
  projectId: string;
  spaceId: string;
  start: WorkBranchStart;
  startHash: string;
  createdBy: { id: string; name: string };
  createdAt: string;
}
// A definition is not a prepared directory, started Run or result. Later lifecycle
// states are added only alongside their real producers and invariant checks.
export interface WorkBranch {
  id: string;
  groupId: string;
  taskId: string;
  name: string;
  goal: string;
  revision: number;
  state: 'planned' | 'discarded';
  workingCopyId: null;
  runId: null;
  resultId: null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkBranchView {
  group: WorkBranchGroup;
  branches: WorkBranch[];
  taskChanged: boolean;
}
export interface WorkBranchPage {
  items: WorkBranchView[];
  nextCursor: number | null;
}
export interface WorkBranchOptions {
  taskRevision: number;
  taskTitle: string;
  taskDescription: string;
  checkpoints: CommitCheckpoint[];
}
export interface WorkBranchEvent {
  revision: number;
  action: 'plan' | 'discard';
  actor: { id: string; name: string };
  at: string;
}
export function parseWorkBranchCreate(input: unknown) {
  const b = exact(input, ['expectedTaskRevision', 'checkpointId', 'branches']);
  if (!Array.isArray(b.branches) || b.branches.length < 2 || b.branches.length > 6)
    throw new DomainError('INVALID_INPUT', '每组需要2至6个独立方案');
  const branches = b.branches.map((value) => {
    const branch = exact(value, ['name', 'goal']);
    return { name: publicName(branch.name), goal: text(branch.goal, '方案目标', 3000) };
  });
  if (new Set(branches.map((v) => v.name.normalize('NFC').toLowerCase())).size !== branches.length)
    throw new DomainError('INVALID_INPUT', '同组方案名称不能重复');
  const result = {
    expectedTaskRevision: revision(b.expectedTaskRevision),
    checkpointId: nodeId(b.checkpointId),
    branches,
  };
  // Six individually valid Chinese goals can exceed the control API's 32 KiB
  // request boundary. Keep a byte budget, including JSON escaping, in the DTO.
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 24 * 1024)
    throw new DomainError('INVALID_INPUT', '整组方案内容超过24 KiB，请缩短目标或减少方案');
  return result;
}
export function parseWorkBranchDiscard(input: unknown) {
  const b = exact(input, ['expectedRevision']);
  return { expectedRevision: revision(b.expectedRevision) };
}
