import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { exact, nodeId } from '../../../../packages/contracts/src/nodes.js';
import { checkpointHash } from '../../../../packages/contracts/src/checkpoints.js';
import { retentionDate } from '../../../../packages/contracts/src/checkpoint-retention.js';
import {
  parseBranchPreservationReport,
  type BranchPreservationRequest,
  type BranchPreservationReport,
} from '../../../../packages/contracts/src/branch-preservation.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import type { RestoreTargetObservation } from './checkpoint-restore-plan.js';
import type { AgentStorage, NodeCredentials } from './storage.js';
import { restoreBinding } from './checkpoint-restore-preflight.js';
import {
  parseBranchPreservedRelease,
  type BranchPreservedRelease,
  type BranchPreservedReceipt,
} from './branch-preserve-lease.js';

export interface LocalBranchPreservation {
  version: 1;
  kind: 'branch_directory_preservation';
  id: string;
  binding: string;
  request: BranchPreservationRequest;
  root: string;
  sourceObservation: RestoreTargetObservation;
  destination: RestoreTargetObservation;
  rootIdentity: string;
  gitIdentity: string;
  destinationRef: string;
  stoppedConfirmedAt: string;
  phase: 'prepared' | 'moving' | 'known_outcome' | 'needs_attention' | 'settled';
  intent: boolean;
  helperOutcome: 'preserved' | 'not_moved' | 'unknown' | null;
  claimAcquired: boolean;
  outcome: 'preserved' | 'not_moved' | null;
  observedAt: string | null;
  releaseRequest: BranchPreservedRelease | null;
  releaseReceipt: BranchPreservedReceipt | null;
  pending: BranchPreservationReport | null;
  acknowledged: 0 | 1 | 2;
  acknowledgedHash: string | null;
  cancelled: boolean;
}
export const branchPreservationHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const invalid = () =>
  new DomainError(
    'BRANCH_PRESERVATION_JOURNAL_INVALID',
    '原移出保留记录不完整或不一致；保留文件、凭证和占用，不重放移动',
  );
export function parseLocalBranchPreservation(
  input: unknown,
  request?: BranchPreservationRequest,
  c?: NodeCredentials,
): LocalBranchPreservation {
  const p = exact(input, [
    'version',
    'kind',
    'id',
    'binding',
    'request',
    'root',
    'sourceObservation',
    'destination',
    'rootIdentity',
    'gitIdentity',
    'destinationRef',
    'stoppedConfirmedAt',
    'phase',
    'intent',
    'helperOutcome',
    'claimAcquired',
    'outcome',
    'observedAt',
    'releaseRequest',
    'releaseReceipt',
    'pending',
    'acknowledged',
    'acknowledgedHash',
    'cancelled',
  ]) as unknown as LocalBranchPreservation;
  if (
    p.version !== 1 ||
    p.kind !== 'branch_directory_preservation' ||
    !['prepared', 'moving', 'known_outcome', 'needs_attention', 'settled'].includes(p.phase) ||
    ![null, 'preserved', 'not_moved'].includes(p.outcome) ||
    ![null, 'preserved', 'not_moved', 'unknown'].includes(p.helperOutcome) ||
    ![0, 1, 2].includes(p.acknowledged) ||
    [p.intent, p.claimAcquired, p.cancelled].some((v) => typeof v !== 'boolean') ||
    typeof p.root !== 'string' ||
    !isAbsolute(p.root) ||
    resolve(p.root) !== p.root ||
    !p.sourceObservation ||
    p.sourceObservation.path !== p.root ||
    !p.destination ||
    typeof p.destination.path !== 'string' ||
    !isAbsolute(p.destination.path) ||
    resolve(p.destination.path) !== p.destination.path ||
    !Array.isArray(p.sourceObservation.parents) ||
    !Array.isArray(p.destination.parents) ||
    !/^\d+:\d+:\d+$/.test(p.rootIdentity) ||
    !/^\d+:\d+:\d+$/.test(p.gitIdentity)
  )
    throw invalid();
  nodeId(p.id);
  nodeId(p.destinationRef);
  checkpointHash(p.binding);
  retentionDate(p.stoppedConfirmedAt);
  const r = p.request;
  if (
    !r ||
    r.id !== p.id ||
    r.version !== 1 ||
    r.kind !== 'preserve_complete_branch_directory' ||
    branchPreservationHash({ ...r, inputHash: '' }) !== r.inputHash ||
    (request && canonicalJson(request) !== canonicalJson(r)) ||
    (c &&
      (restoreBinding(c) !== p.binding ||
        r.nodeId !== c.nodeId ||
        r.spaceId !== c.spaceId ||
        r.projectId !== c.projectId ||
        !c.directories.some(
          (w) =>
            w.id === r.scope.branch.workingCopyId &&
            w.root === p.root &&
            w.rootIdentity === p.rootIdentity.split(':').slice(0, 2).join(':') &&
            w.gitIdentity === p.gitIdentity.split(':').slice(0, 2).join(':'),
        )))
  )
    throw invalid();
  if (p.observedAt !== null && retentionDate(p.observedAt) < p.stoppedConfirmedAt) throw invalid();
  if (p.acknowledged === 0 ? p.acknowledgedHash !== null : !p.acknowledgedHash) throw invalid();
  if (p.acknowledgedHash) checkpointHash(p.acknowledgedHash);
  if ((p.intent || p.helperOutcome !== null) && !p.claimAcquired) throw invalid();
  if (p.outcome === 'preserved' && p.helperOutcome !== 'preserved') throw invalid();
  if (p.outcome === 'not_moved' && p.helperOutcome !== null && p.helperOutcome !== 'not_moved')
    throw invalid();
  if (p.releaseRequest) {
    const release = parseBranchPreservedRelease(p.releaseRequest);
    if (
      !p.claimAcquired ||
      release.preservationId !== p.id ||
      release.root !== p.root ||
      release.destination !== p.destination.path ||
      release.rootIdentity !== p.rootIdentity ||
      release.gitIdentity !== p.gitIdentity ||
      release.stoppedConfirmedAt !== p.stoppedConfirmedAt ||
      release.observedAt !== p.observedAt ||
      release.outcome !== p.outcome
    )
      throw invalid();
  }
  if (p.releaseReceipt) {
    const { releasedAt, ...release } = p.releaseReceipt;
    if (
      !p.releaseRequest ||
      canonicalJson(parseBranchPreservedRelease(release)) !== canonicalJson(p.releaseRequest) ||
      retentionDate(releasedAt) < p.releaseRequest.observedAt
    )
      throw invalid();
  }
  if (p.pending) {
    const report = parseBranchPreservationReport(p.pending);
    if (
      report.preservationId !== p.id ||
      report.inputHash !== r.inputHash ||
      report.destinationRef !== p.destinationRef ||
      report.sequence !== p.acknowledged + 1 ||
      (report.stage === 'preserved' && (p.outcome !== 'preserved' || !p.releaseReceipt)) ||
      (report.stage === 'failed' &&
        (p.outcome !== 'not_moved' || (p.claimAcquired && !p.releaseReceipt)))
    )
      throw invalid();
  }
  if (p.outcome && (!p.observedAt || p.intent || !['known_outcome', 'settled'].includes(p.phase)))
    throw invalid();
  if (
    p.phase === 'settled' &&
    (p.pending ||
      p.intent ||
      !p.outcome ||
      (p.cancelled
        ? p.acknowledged !== 0 || p.claimAcquired || p.outcome !== 'not_moved'
        : p.acknowledged !== 2 || (p.claimAcquired && !p.releaseReceipt)))
  )
    throw invalid();
  if (p.cancelled && p.phase !== 'settled') throw invalid();
  return p;
}
export function readBranchPreservation(
  storage: AgentStorage,
  id: string,
  request: BranchPreservationRequest,
  c: NodeCredentials,
) {
  const row = storage.db
    .prepare(
      'SELECT CASE WHEN length(CAST(body AS BLOB))<=1048576 THEN body ELSE NULL END body FROM branch_binding WHERE id=?',
    )
    .get('preservation:' + id) as { body: string } | undefined;
  if (row && typeof row.body !== 'string') throw invalid();
  return row ? parseLocalBranchPreservation(JSON.parse(row.body), request, c) : null;
}
export function saveBranchPreservation(storage: AgentStorage, p: LocalBranchPreservation) {
  parseLocalBranchPreservation(p);
  if (Buffer.byteLength(JSON.stringify(p)) > 1048576) throw invalid();
  storage.db
    .prepare(
      'INSERT INTO branch_binding(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
    )
    .run('preservation:' + p.id, JSON.stringify(p));
}
