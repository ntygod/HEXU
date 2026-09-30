import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { exact, nodeId } from '../../../../packages/contracts/src/nodes.js';
import { retentionDate } from '../../../../packages/contracts/src/checkpoint-retention.js';
import {
  parseIntegrationRecoveryReport,
  type IntegrationRecoveryReport,
} from '../../../../packages/contracts/src/integrations.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import {
  workspaceReleaseReceipt,
  type WorkspaceReleaseRequest,
  type WorkspaceReleaseReceipt,
} from '../workspace-lease.js';
import {
  parseLocalApplicationRecord,
  type LocalApplication,
} from './integration-application-record.js';
import {
  integrationEvidenceHash,
  originalApplicationEvidenceHash,
  validateRecoveryContextBinding,
} from './integration-recovery-context.js';

export interface RecoveryAcknowledgement {
  integrationId: string;
  applicationId: string;
  recoveryId: string;
  hash: string;
  receivedAt: string;
}
export interface LocalIntegrationRecovery {
  version: 1;
  integrationId: string;
  applicationId: string;
  recoveryId: string;
  contextHash: string;
  originalApplicationEvidenceHash: string;
  originalApplication: LocalApplication;
  phase: 'release_prepared' | 'released';
  releaseRequest: WorkspaceReleaseRequest;
  releaseReceipt: WorkspaceReleaseReceipt | null;
  report: IntegrationRecoveryReport | null;
  recoveryPending: IntegrationRecoveryReport | null;
  acknowledged: RecoveryAcknowledgement | null;
}
const invalid = () =>
  new DomainError(
    'INTEGRATION_RECOVERY_INVALID',
    '原结算证据或释放回执不一致；保留原记录，不猜测已释放',
  );

export function recoveryReport(
  record: LocalApplication,
  recovery: LocalIntegrationRecovery,
  receipt: WorkspaceReleaseReceipt,
) {
  const original = recovery.originalApplication;
  const context = validateRecoveryContextBinding(original);
  return parseIntegrationRecoveryReport({
    version: 1,
    kind: 'local_integration_settlement',
    integrationId: record.integrationId,
    applicationId: record.applicationId,
    recoveryId: recovery.recoveryId,
    integrationInputHash: context.integrationInputHash,
    applicationInputHash: record.inputHash,
    originalApplicationEvidenceHash: recovery.originalApplicationEvidenceHash,
    stoppedConfirmedAt: recovery.releaseRequest.stoppedConfirmedAt,
    releasedAt: receipt.releasedAt,
    disposition: 'preserve_files',
    processEvidence: 'operator_confirmed_stopped',
    lease: 'released',
    filesVerified: false,
    recordedAddedCount: original.added.length,
    unresolvedWriteIntent: original.intent !== null,
    confirmPublication: true,
  });
}
export function parseRecoveryAcknowledgement(
  value: unknown,
  report: IntegrationRecoveryReport,
): RecoveryAcknowledgement {
  const ack = exact(value, [
    'integrationId',
    'applicationId',
    'recoveryId',
    'hash',
    'receivedAt',
  ]) as unknown as RecoveryAcknowledgement;
  if (
    ack.integrationId !== report.integrationId ||
    ack.applicationId !== report.applicationId ||
    ack.recoveryId !== report.recoveryId ||
    ack.hash !== integrationEvidenceHash(report)
  )
    throw invalid();
  retentionDate(ack.receivedAt);
  return ack;
}
export function parseLocalIntegrationRecovery(
  body: unknown,
  record: LocalApplication,
): LocalIntegrationRecovery {
  try {
    if (typeof body !== 'string' || Buffer.byteLength(body) > 524288) throw invalid();
    const r = exact(JSON.parse(body), [
      'version',
      'integrationId',
      'applicationId',
      'recoveryId',
      'contextHash',
      'originalApplicationEvidenceHash',
      'originalApplication',
      'phase',
      'releaseRequest',
      'releaseReceipt',
      'report',
      'recoveryPending',
      'acknowledged',
    ]) as unknown as LocalIntegrationRecovery;
    const c = validateRecoveryContextBinding(record);
    const original = parseLocalApplicationRecord(
      JSON.stringify(r.originalApplication),
      record.integrationId,
    );
    if (
      r.version !== 1 ||
      r.integrationId !== record.integrationId ||
      r.applicationId !== record.applicationId ||
      r.contextHash !== c.contextHash ||
      r.originalApplicationEvidenceHash !== originalApplicationEvidenceHash(original) ||
      !['prepared', 'applying', 'needs_attention'].includes(original.phase) ||
      ['binding', 'integrationId', 'applicationId', 'inputHash', 'root', 'recoveryContext'].some(
        (key) =>
          canonicalJson(original[key as keyof LocalApplication]) !==
          canonicalJson(record[key as keyof LocalApplication]),
      )
    )
      throw invalid();
    nodeId(r.recoveryId);
    exact(r.releaseRequest, [
      'version',
      'recoveryId',
      'claimId',
      'root',
      'identity',
      'gitIdentity',
      'evidenceHash',
      'stoppedConfirmedAt',
    ]);
    const expected: WorkspaceReleaseRequest = {
      version: 1,
      recoveryId: r.recoveryId,
      claimId: `integration:${record.applicationId}`,
      root: c.root,
      identity: c.rootIdentity,
      gitIdentity: c.gitIdentity,
      evidenceHash: r.originalApplicationEvidenceHash,
      stoppedConfirmedAt: retentionDate(r.releaseRequest.stoppedConfirmedAt),
    };
    if (canonicalJson(r.releaseRequest) !== canonicalJson(expected)) throw invalid();
    if (r.phase === 'release_prepared') {
      if (
        r.releaseReceipt !== null ||
        r.report !== null ||
        r.recoveryPending !== null ||
        r.acknowledged !== null
      )
        throw invalid();
    } else if (r.phase === 'released') {
      exact(r.releaseReceipt, [...Object.keys(expected), 'releasedAt']);
      if (
        !r.releaseReceipt ||
        canonicalJson(r.releaseReceipt) !==
          canonicalJson({ ...expected, releasedAt: retentionDate(r.releaseReceipt.releasedAt) })
      )
        throw invalid();
      const report = recoveryReport(record, r, r.releaseReceipt);
      if (canonicalJson(r.report) !== canonicalJson(report)) throw invalid();
      if (r.recoveryPending !== null) {
        if (canonicalJson(r.recoveryPending) !== canonicalJson(report) || r.acknowledged !== null)
          throw invalid();
      } else {
        parseRecoveryAcknowledgement(r.acknowledged, report);
      }
    } else throw invalid();
    return r;
  } catch {
    throw invalid();
  }
}

/** Read only: shared by the credential guard and historical status reader. */
export function readLocalIntegrationRecovery(
  db: DatabaseSync,
  record: LocalApplication,
): LocalIntegrationRecovery | null {
  const schema = db
    .prepare("SELECT type FROM sqlite_schema WHERE name='integration_recoveries'")
    .get();
  if (!schema) return null;
  if (schema.type !== 'table') throw invalid();
  const row = db
    .prepare('SELECT body FROM integration_recoveries WHERE application_id=?')
    .get(record.applicationId) as { body: string } | undefined;
  return row ? parseLocalIntegrationRecovery(row.body, record) : null;
}
export function saveLocalIntegrationRecovery(
  db: DatabaseSync,
  record: LocalApplication,
  recovery: LocalIntegrationRecovery,
) {
  parseLocalIntegrationRecovery(JSON.stringify(recovery), record);
  db.exec(
    'CREATE TABLE IF NOT EXISTS integration_recoveries(application_id TEXT PRIMARY KEY,body TEXT NOT NULL)',
  );
  const previous = readLocalIntegrationRecovery(db, record);
  if (
    previous &&
    (previous.recoveryId !== recovery.recoveryId ||
      canonicalJson(previous.releaseRequest) !== canonicalJson(recovery.releaseRequest) ||
      previous.contextHash !== recovery.contextHash ||
      previous.originalApplicationEvidenceHash !== recovery.originalApplicationEvidenceHash ||
      canonicalJson(previous.originalApplication) !== canonicalJson(recovery.originalApplication) ||
      (previous.phase === 'released' &&
        (recovery.phase !== 'released' ||
          canonicalJson(previous.report) !== canonicalJson(recovery.report) ||
          canonicalJson(previous.releaseReceipt) !== canonicalJson(recovery.releaseReceipt))) ||
      (previous.acknowledged && canonicalJson(previous) !== canonicalJson(recovery)))
  )
    throw invalid();
  db.prepare(
    'INSERT INTO integration_recoveries VALUES(?,?) ON CONFLICT(application_id) DO UPDATE SET body=excluded.body',
  ).run(record.applicationId, JSON.stringify(recovery));
}
export function hasSettledIntegrationRecovery(db: DatabaseSync, record: LocalApplication) {
  const r = readLocalIntegrationRecovery(db, record);
  if (
    !r ||
    r.phase !== 'released' ||
    !r.acknowledged ||
    r.recoveryPending !== null ||
    record.pending !== null
  )
    return false;
  const durable = workspaceReleaseReceipt(r.releaseRequest);
  if (!durable || canonicalJson(durable) !== canonicalJson(r.releaseReceipt)) throw invalid();
  return true;
}
