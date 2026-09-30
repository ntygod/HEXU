import { DomainError } from '../../../../packages/contracts/src/index.js';
import type { RestoreEntry } from './checkpoint-restore-plan.js';
import { parseLocalApplicationRecord } from './integration-application-record.js';
import { originalApplicationEvidenceHash } from './integration-recovery-context.js';

export interface IntegrationRestorationFile {
  path: string;
  /** Expected currently applied file. Null means the original deletion must
   * still be absent; it is never permission to overwrite a later user file. */
  before: (RestoreEntry & { identity: string }) | null;
  /** Original bytes must be read from this exact confirmed private backup,
   * never reconstructed from display diff or a possibly expired source. */
  after: (RestoreEntry & { backupName: string; backupIdentity: string }) | null;
}
export interface IntegrationRestorationPlan {
  version: 1;
  kind: 'restore_confirmed_integration_files';
  integrationId: string;
  applicationId: string;
  originalEvidenceHash: string;
  applicationInputHash: string;
  root: string;
  originalCommit: string;
  originalSnapshotHash: string;
  originalBackup: { path: string; identity: string } | null;
  files: IntegrationRestorationFile[];
  /** Empty original application-created directories are deliberately retained.
   * This file restoration scope is not directory cleanup or generic backup. */
  retainedDirectories: { path: string; identity: string }[];
  evidence: 'historical_application_only';
  writeAuthorized: false;
}
const unavailable = () =>
  new DomainError(
    'INTEGRATION_RESTORATION_UNAVAILABLE',
    '此范围只处理已完成且回执已确认的原应用全部文件；未知意图、部分应用和用户编辑必须另外处理，不猜测归属',
  );
const file = (entry: RestoreEntry): RestoreEntry => ({
  path: entry.path,
  kind: entry.kind,
  objectId: entry.objectId,
  gitMode: entry.gitMode,
  bytes: entry.bytes,
});

/** Pure inverse of confirmed evidence only. No file/backup/Git read, network,
 * lease or permission check happens here. The eventual writer must obtain NEW
 * explicit consent/current authority and verify both complete filesystem sides.
 * Keeping this separate cannot turn preserve-only settlement into rollback. */
export function planIntegrationFileRestoration(
  body: unknown,
  integrationId: string,
): IntegrationRestorationPlan {
  const r = parseLocalApplicationRecord(body, integrationId),
    context = r.recoveryContext;
  if (
    !context ||
    r.phase !== 'completed' ||
    r.acknowledged !== 2 ||
    r.pending !== null ||
    r.intent !== null ||
    r.directoryIntent ||
    r.existingChanges?.intent ||
    r.existingChanges?.directoryIntent
  )
    throw unavailable();
  const files: IntegrationRestorationFile[] = r.added.map((added) => ({
    path: added.path,
    before: { ...file(added), identity: added.identity },
    after: null,
  }));
  for (const change of r.existingChanges?.changes ?? []) {
    files.push({
      path: change.before.path,
      before: change.after ? { ...file(change.after), identity: change.targetIdentity! } : null,
      after: {
        ...file(change.before),
        backupName: change.backupName,
        backupIdentity: change.backupIdentity,
      },
    });
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (
    !files.length ||
    files.length !== context.selectedPaths.length ||
    new Set(files.map((entry) => entry.path)).size !== files.length ||
    files.some((entry) => !context.selectedPaths.includes(entry.path))
  )
    throw unavailable();
  const backup = r.existingChanges;
  return {
    version: 1,
    kind: 'restore_confirmed_integration_files',
    integrationId: r.integrationId,
    applicationId: r.applicationId,
    originalEvidenceHash: originalApplicationEvidenceHash(r),
    applicationInputHash: r.inputHash,
    root: r.root,
    originalCommit: context.target.commit,
    originalSnapshotHash: context.target.snapshotHash,
    originalBackup: backup ? { path: backup.backup.path, identity: backup.backupIdentity! } : null,
    files,
    retainedDirectories: (r.directories ?? []).map((entry) => ({ ...entry })),
    evidence: 'historical_application_only',
    writeAuthorized: false,
  };
}
