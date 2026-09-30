import { isAbsolute, resolve } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  parseIntegrationApplicationReport,
  type IntegrationApplicationReport,
} from '../../../../packages/contracts/src/integrations.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import type { RestoreEntry } from './checkpoint-restore-plan.js';
import {
  validateExistingIntegrationChanges,
  hasExistingIntegrationMaterial,
  type ExistingIntegrationChanges,
} from './integration-existing-change-record.js';
import { INTEGRATION_DIRECTORY_LIMITS } from './integration-application-plan.js';
import {
  validateRecoveryContextBinding,
  type IntegrationRecoveryContext,
} from './integration-recovery-context.js';
const invalid = () =>
  new DomainError('INTEGRATION_JOURNAL_INVALID', '本机应用证据不完整或不一致；保留原凭证和写锁');
type Added = RestoreEntry & { identity: string };
export interface CreatedIntegrationDirectory {
  path: string;
  identity: string;
}
export interface IntegrationDirectoryIntent {
  path: string;
  stageName: string;
  stageIdentity: string | null;
}
export interface LocalApplication {
  binding: string;
  integrationId: string;
  applicationId: string;
  inputHash: string;
  root: string;
  phase: 'prepared' | 'applying' | 'completed' | 'failed' | 'needs_attention';
  added: Added[];
  intent: string | null;
  pending: IntegrationApplicationReport | null;
  acknowledged: number;
  recoveryContext?: IntegrationRecoveryContext;
  /** Absent on older file-only records; never backfill unknown ownership. */
  directories?: CreatedIntegrationDirectory[];
  directoryIntent?: IntegrationDirectoryIntent | null;
  existingChanges?: ExistingIntegrationChanges;
}
export const confirmedApplicationPaths = (record: LocalApplication) =>
  [
    ...record.added.map((entry) => entry.path),
    ...(record.existingChanges?.changes.map((entry) => entry.before.path) ?? []),
  ].sort();
export function validateLocalShape(record: LocalApplication) {
  const invalid = () =>
    new DomainError('INTEGRATION_JOURNAL_INVALID', '本机应用证据不完整或不一致；保留原凭证和写锁');
  const path = (value: unknown) =>
    typeof value === 'string' &&
    Buffer.byteLength(value) <= 4096 &&
    !/[\\\p{Cc}\p{Cf}]/u.test(value) &&
    !value.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git');
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.root !== 'string' ||
    !isAbsolute(record.root) ||
    resolve(record.root) !== record.root ||
    Buffer.byteLength(record.root) > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(record.root) ||
    typeof record.binding !== 'string' ||
    typeof record.inputHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.binding) ||
    !/^[a-f0-9]{64}$/.test(record.inputHash) ||
    !['prepared', 'applying', 'completed', 'failed', 'needs_attention'].includes(record.phase) ||
    !Array.isArray(record.added) ||
    record.added.length > 80 ||
    ![0, 1, 2].includes(record.acknowledged) ||
    (record.intent !== null && !path(record.intent))
  )
    throw invalid();
  try {
    nodeId(record.integrationId);
    nodeId(record.applicationId);
  } catch {
    throw invalid();
  }
  const seen = new Set<string>();
  for (const entry of record.added) {
    if (
      !entry ||
      !path(entry.path) ||
      seen.has(entry.path) ||
      entry.kind !== 'file' ||
      !['100644', '100755'].includes(entry.gitMode) ||
      typeof entry.objectId !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.objectId) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 8 * 1024 * 1024 ||
      typeof entry.identity !== 'string' ||
      !/^\d+:\d+$/.test(entry.identity)
    )
      throw invalid();
    seen.add(entry.path);
  }
  if ((record.directories === undefined) !== (record.directoryIntent === undefined))
    throw invalid();
  if (record.directories !== undefined) {
    if (
      !record.recoveryContext ||
      !Array.isArray(record.directories) ||
      record.directories.length > INTEGRATION_DIRECTORY_LIMITS.count
    )
      throw invalid();
    let pathBytes = 0;
    for (const directory of record.directories) {
      if (
        !directory ||
        !path(directory.path) ||
        seen.has(directory.path) ||
        typeof directory.identity !== 'string' ||
        !/^\d+:\d+:\d+$/.test(directory.identity)
      )
        throw invalid();
      seen.add(directory.path);
      pathBytes += Buffer.byteLength(directory.path);
    }
    if (pathBytes > INTEGRATION_DIRECTORY_LIMITS.pathBytes) throw invalid();
    const intent = record.directoryIntent;
    if (intent !== null) {
      if (
        !intent ||
        !path(intent.path) ||
        seen.has(intent.path) ||
        record.intent === null ||
        !record.intent.startsWith(intent.path + '/') ||
        typeof intent.stageName !== 'string' ||
        !/^\.hexu-restore-[a-f0-9-]{36}$/.test(intent.stageName) ||
        (intent.stageIdentity !== null && !/^\d+:\d+:\d+$/.test(intent.stageIdentity))
      )
        throw invalid();
      try {
        nodeId(intent.stageName.slice('.hexu-restore-'.length));
      } catch {
        throw invalid();
      }
    }
  }
  if (record.existingChanges !== undefined) {
    if (!record.recoveryContext?.candidate) throw invalid();
    validateExistingIntegrationChanges(
      record.existingChanges,
      record.root,
      record.recoveryContext.selectedPaths,
    );
    if (
      record.existingChanges.changes.some((entry) => seen.has(entry.before.path)) ||
      (record.existingChanges.intent && record.intent !== record.existingChanges.intent.before.path)
    )
      throw invalid();
  } else if (record.recoveryContext?.candidate) throw invalid();
  if (record.pending !== null) {
    try {
      parseIntegrationApplicationReport(record.pending);
    } catch {
      throw invalid();
    }
  }
}
const exact = (value: object, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

/** Validate only what the journal actually records. There is no saved operation
 * plan here, so this cannot establish current directory contents or permissions. */
export function parseLocalApplicationRecord(
  body: unknown,
  integrationId: string,
): LocalApplication {
  try {
    if (typeof body !== 'string' || Buffer.byteLength(body) > 524288) throw invalid();
    const record = JSON.parse(body) as LocalApplication;
    validateLocalShape(record);
    if (
      !exact(record, [
        'binding',
        'integrationId',
        'applicationId',
        'inputHash',
        'root',
        'phase',
        'added',
        'intent',
        'pending',
        'acknowledged',
        ...(record.recoveryContext === undefined ? [] : ['recoveryContext']),
        ...(record.directories === undefined ? [] : ['directories', 'directoryIntent']),
        ...(record.existingChanges === undefined ? [] : ['existingChanges']),
      ]) ||
      record.integrationId !== integrationId ||
      nodeId(record.applicationId) !== record.applicationId ||
      record.added.some(
        (entry) => !exact(entry, ['path', 'kind', 'objectId', 'gitMode', 'bytes', 'identity']),
      ) ||
      record.added.some((entry) => entry.path === record.intent) ||
      record.directories?.some((entry) => !exact(entry, ['path', 'identity'])) ||
      (record.directoryIntent &&
        !exact(record.directoryIntent, ['path', 'stageName', 'stageIdentity']))
    )
      throw invalid();

    const pending = record.pending && parseIntegrationApplicationReport(record.pending);
    if (
      pending &&
      (pending.integrationId !== record.integrationId ||
        pending.applicationId !== record.applicationId ||
        pending.inputHash !== record.inputHash ||
        pending.sequence !== record.acknowledged + 1 ||
        pending.stage !== (record.phase === 'prepared' ? 'applying' : record.phase) ||
        canonicalJson(pending.appliedPaths) !== canonicalJson(confirmedApplicationPaths(record)))
    )
      throw invalid();

    switch (record.phase) {
      case 'prepared':
        // The start ACK is persisted before the following phase update, so a
        // concurrent observer can legitimately see prepared + acknowledged=1.
        if (
          record.added.length ||
          record.intent !== null ||
          record.acknowledged > 1 ||
          record.directories?.length ||
          record.directoryIntent ||
          hasExistingIntegrationMaterial(record.existingChanges)
        )
          throw invalid();
        break;
      case 'applying':
        if (record.acknowledged !== 1 || pending) throw invalid();
        break;
      case 'completed':
        if (
          record.existingChanges &&
          (!record.existingChanges.backupIdentity ||
            record.existingChanges.directoryIntent ||
            record.existingChanges.intent)
        )
          throw invalid();
        if (
          !confirmedApplicationPaths(record).length ||
          record.intent !== null ||
          record.directoryIntent ||
          (pending ? record.acknowledged !== 1 : record.acknowledged !== 2)
        )
          throw invalid();
        break;
      case 'failed':
        if (
          record.added.length ||
          record.intent !== null ||
          record.directories?.length ||
          record.directoryIntent ||
          hasExistingIntegrationMaterial(record.existingChanges)
        )
          throw invalid();
        break;
      case 'needs_attention':
        if (pending ? record.acknowledged !== 1 : record.acknowledged !== 2) throw invalid();
        break;
    }
    if (record.recoveryContext !== undefined) validateRecoveryContextBinding(record);
    return record;
  } catch {
    throw invalid();
  }
}
