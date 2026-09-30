import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { retentionDate } from '../../../../packages/contracts/src/checkpoint-retention.js';
import type { RestoreEntry, RestoreTargetObservation } from './checkpoint-restore-plan.js';
import type { IntegrationFileChange } from './integration-change-files.js';

export interface ConfirmedIntegrationFileChange extends IntegrationFileChange {
  backupIdentity: string;
  targetIdentity: string | null;
}
/** Extends the original application evidence, not a second recovery state machine. */
export interface ExistingIntegrationChanges {
  backup: RestoreTargetObservation;
  stageName: string;
  stageIdentity: string | null;
  backupIdentity: string | null;
  directoryIntent: boolean;
  stoppedWritersAt: string;
  changes: ConfirmedIntegrationFileChange[];
  intent: IntegrationFileChange | null;
}
const invalid = () =>
  new DomainError('INTEGRATION_JOURNAL_INVALID', '已有文件写回证据不完整；保留原文件、备份与写锁');
const exact = (value: object, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const inode = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+:\d+$/.test(value);
const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+:\d+:\d+$/.test(value);
const absolute = (value: unknown): value is string =>
  typeof value === 'string' &&
  isAbsolute(value) &&
  resolve(value) === value &&
  Buffer.byteLength(value) <= 4095 &&
  !/[\\\p{Cc}\p{Cf}]/u.test(value);
const inside = (a: string, b: string) => {
  const path = relative(a, b);
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
};
function file(value: RestoreEntry) {
  return (
    value &&
    exact(value, ['path', 'kind', 'gitMode', 'objectId', 'bytes']) &&
    typeof value.path === 'string' &&
    Buffer.byteLength(value.path) <= 4095 &&
    !/[\\\p{Cc}\p{Cf}]/u.test(value.path) &&
    !value.path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') &&
    value.kind === 'file' &&
    ['100644', '100755'].includes(value.gitMode) &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.objectId) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    value.bytes <= 8 * 1024 * 1024
  );
}
export const hasExistingIntegrationMaterial = (r: ExistingIntegrationChanges | undefined) =>
  !!r &&
  (!!r.stageIdentity ||
    !!r.backupIdentity ||
    r.directoryIntent ||
    !!r.intent ||
    !!r.changes.length);
export function validateExistingIntegrationChanges(
  r: ExistingIntegrationChanges,
  root: string,
  selectedPaths: readonly string[],
) {
  if (
    !r ||
    !exact(r, [
      'backup',
      'stageName',
      'stageIdentity',
      'backupIdentity',
      'directoryIntent',
      'stoppedWritersAt',
      'changes',
      'intent',
    ]) ||
    !r.backup ||
    !exact(r.backup, ['path', 'parents']) ||
    !absolute(r.backup.path) ||
    inside(root, r.backup.path) ||
    inside(r.backup.path, root) ||
    Buffer.byteLength(JSON.stringify(r.backup)) > 128 * 1024 ||
    !Array.isArray(r.backup.parents) ||
    !r.backup.parents.length ||
    r.backup.parents.length > 2048 ||
    typeof r.stageName !== 'string' ||
    !/^\.hexu-restore-[a-f0-9-]{36}$/.test(r.stageName) ||
    (r.stageIdentity !== null && !identity(r.stageIdentity)) ||
    (r.backupIdentity !== null &&
      (!identity(r.backupIdentity) || r.backupIdentity !== r.stageIdentity)) ||
    typeof r.directoryIntent !== 'boolean' ||
    !Array.isArray(r.changes) ||
    r.changes.length > 80 ||
    (r.backupIdentity && r.directoryIntent) ||
    (r.stageIdentity && !r.backupIdentity && !r.directoryIntent)
  )
    throw invalid();
  retentionDate(r.stoppedWritersAt);
  let expected = dirname(r.backup.path);
  for (const [i, p] of r.backup.parents.entries()) {
    if (
      !p ||
      !exact(p, ['path', 'identity']) ||
      !absolute(p.path) ||
      p.path !== expected ||
      !inode(p.identity) ||
      (expected === '/' && i !== r.backup.parents.length - 1)
    )
      throw invalid();
    expected = dirname(expected);
  }
  if (r.backup.parents.at(-1)!.path !== '/') throw invalid();
  const names = new Set<string>(),
    paths = new Set<string>();
  function change(value: IntegrationFileChange, confirmed: boolean) {
    if (
      !value ||
      !exact(value, [
        'before',
        'after',
        'originalIdentity',
        'backupName',
        ...(confirmed ? ['backupIdentity', 'targetIdentity'] : []),
      ]) ||
      !file(value.before) ||
      (value.after !== null && (!file(value.after) || value.after.path !== value.before.path)) ||
      !selectedPaths.includes(value.before.path) ||
      paths.has(value.before.path) ||
      !inode(value.originalIdentity) ||
      typeof value.backupName !== 'string' ||
      !/^hexu-change-[a-f0-9-]{36}$/.test(value.backupName) ||
      names.has(value.backupName)
    )
      throw invalid();
    paths.add(value.before.path);
    names.add(value.backupName);
  }
  for (const entry of r.changes) {
    change(entry, true);
    if (
      !r.backupIdentity ||
      entry.backupIdentity !== entry.originalIdentity ||
      (entry.after === null ? entry.targetIdentity !== null : !inode(entry.targetIdentity))
    )
      throw invalid();
  }
  if (r.intent) {
    change(r.intent, false);
    if (!r.backupIdentity) throw invalid();
  }
}
