import type { Tool } from './index.js';
import type { WorkBranchStart } from './work-branches.js';
import type { BranchExecutionBinding } from './work-branch-workspaces.js';

/** A read-only proposal for a future save, never an immutable Result version. */
export interface WorkBranchResultSource {
  schemaVersion: 1;
  taskId: string;
  branchId: string;
  branchRevision: number;
  groupId: string;
  start: WorkBranchStart;
  startHash: string;
  binding: BranchExecutionBinding;
  run: {
    id: string;
    revision: number;
    state: 'succeeded' | 'failed' | 'cancelled';
    tool: Tool;
    model: string | null;
    nodeId: string;
    workingCopyId: string;
    startedAt: string | null;
    updatedAt: string;
  };
  input: { context: string; prompt: string };
  output: {
    text: string;
    totalBytes: number;
    retainedBytes: number;
    truncated: boolean;
    eventCount: number;
    /** Hashes the full, already-shared output events, not just the retained prefix. */
    digest: string;
  };
  evidence: {
    receivedThroughSequence: number;
    includedThroughSequence: number;
    ignoredAfterTerminal: number;
    terminal: {
      sequence: number;
      result: 'succeeded' | 'failed' | 'cancelled';
      text: string;
    } | null;
    /** Kept distinct from the control service's terminal Run state. */
    toolReportedSuccess: boolean;
  };
  code: { status: 'not_captured' };
  limitations: string[];
  /** Stable for identical evidence; changes even when an omitted suffix changes. */
  sourceHash: string;
}
