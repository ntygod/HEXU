import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { readCredentials } from './storage.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import {
  parseLocalApplicationRecord,
  type LocalApplication,
} from './integration-application-record.js';
import { validateRecoveryContextBinding } from './integration-recovery-context.js';

import {
  parseLocalIntegrationRestoration,
  confirmedRestorationPaths,
  type LocalIntegrationRestoration,
} from './integration-restoration-record.js';
import { readRestorationRecovery } from './integration-restoration-recovery.js';

const invalid = () =>
  new DomainError('INTEGRATION_JOURNAL_INVALID', '本机应用证据不完整或不一致；保留原凭证和写锁');
const scopeChanged = () =>
  new DomainError('INTEGRATION_SCOPE_CHANGED', '本机应用日志、原身份或目录登记已变化');
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
};
/** Opening a read-only WAL database can create a shared-memory sidecar. The
 * application writer uses rollback journals; reject other formats before SQLite
 * opens anything. Never use immutable=1: it would ignore an active writer. */
function checkJournalHeader(path: string, identity: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== identity) throw scopeChanged();
    const header = Buffer.alloc(100);
    if (
      readSync(fd, header, 0, header.length, 0) !== header.length ||
      header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      throw invalid();
  } finally {
    closeSync(fd);
  }
}

/** Historical local evidence only. No AgentStorage, process guard, workspace
 * lease, service request, material access, Git command, or target inspection. */
export function readIntegrationApplicationStatus(home: string, integrationId: string) {
  nodeId(integrationId);
  if (process.platform === 'win32')
    throw new DomainError('PLATFORM_UNSUPPORTED', '本机整合状态只支持 POSIX 私有状态目录');
  home = resolve(home);
  const directory = join(home, 'integration-application'),
    database = join(directory, 'journal.sqlite'),
    paths = [home, directory, database, join(home, 'credentials.json')];
  let identities: string[];
  try {
    identities = paths.map((path, index) => restorePrivatePath(path, index < 2));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
      throw new DomainError(
        'INTEGRATION_JOURNAL_NOT_FOUND',
        '缺少原本机应用日志或凭证；没有创建状态',
      );
    throw cause;
  }
  const credentials = readCredentials(home),
    binding = restoreBinding(credentials);
  if (!credentials.nodeId) throw new DomainError('NOT_PAIRED', '缺少原本机已配对身份');
  if (
    credentials.directories
      .flatMap((entry) => [entry.root, entry.gitDir])
      .some((path) => inside(home, path) || inside(path, home))
  )
    throw scopeChanged();
  const stillBound = () => {
    try {
      if (
        paths.some((path, index) => restorePrivatePath(path, index < 2) !== identities[index]) ||
        restoreBinding(readCredentials(home)) !== binding
      )
        throw scopeChanged();
    } catch {
      throw scopeChanged();
    }
  };
  checkJournalHeader(database, identities[2]!);
  stillBound();
  const db = new DatabaseSync(database, { readOnly: true });
  let record: LocalApplication;
  let restorations: {
    record: LocalIntegrationRestoration;
    recovery: ReturnType<typeof readRestorationRecovery>;
  }[] = [];
  try {
    stillBound();
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN;');
    stillBound();
    const schema = db
      .prepare("SELECT type,rootpage FROM sqlite_schema WHERE name='applications'")
      .get();
    if (!schema)
      throw new DomainError(
        'INTEGRATION_JOURNAL_NOT_FOUND',
        '原本机日志中没有应用记录；没有初始化状态',
      );
    if (schema.type !== 'table' || typeof schema.rootpage !== 'number' || schema.rootpage <= 0)
      throw invalid();
    const columns = db.prepare("PRAGMA table_xinfo('applications')").all();
    if (
      columns.length !== 2 ||
      columns[0]?.name !== 'id' ||
      columns[0]?.type !== 'TEXT' ||
      columns[0]?.pk !== 1 ||
      columns[0]?.hidden !== 0 ||
      columns[1]?.name !== 'body' ||
      columns[1]?.type !== 'TEXT' ||
      columns[1]?.notnull !== 1 ||
      columns[1]?.pk !== 0 ||
      columns[1]?.hidden !== 0
    )
      throw invalid();
    // Bound the returned JSON even if the private journal has been corrupted.
    const row = db
      .prepare(
        `SELECT id, CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB)) <= 524288 THEN body ELSE NULL END AS body FROM applications WHERE id=?`,
      )
      .get(integrationId);
    if (!row)
      throw new DomainError(
        'INTEGRATION_RECORD_NOT_FOUND',
        '原本机日志中没有该整合应用；没有创建记录',
      );
    if (row.id !== integrationId) throw invalid();
    record = parseLocalApplicationRecord(row.body, integrationId);
    if (record.recoveryContext) validateRecoveryContextBinding(record, credentials);
    // Select only this original application's discriminated rows. JSON text is
    // bounded before parsing; no target/backup/registry lookup is performed.
    const restorationRows = db
      .prepare(
        "SELECT id, CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB)) <= 524288 THEN body ELSE NULL END AS body FROM applications WHERE id LIKE 'restoration:%'",
      )
      .all();
    for (const row of restorationRows) {
      if (typeof row.body !== 'string') throw invalid();
      const raw = JSON.parse(row.body);
      if (raw.request?.integrationId !== integrationId) continue;
      const restored = parseLocalIntegrationRestoration(row.body, row.id as string, record);
      restorations.push({
        record: restored,
        recovery: readRestorationRecovery(db, record, restored),
      });
    }
    if (restorations.length > 1) throw invalid();
    const registered = credentials.directories.filter((entry) => entry.root === record.root);
    if (
      record.binding !== binding ||
      registered.length !== 1 ||
      !isAbsolute(registered[0]!.gitDir) ||
      resolve(registered[0]!.gitDir) !== registered[0]!.gitDir ||
      !/^\d+:\d+$/.test(registered[0]!.rootIdentity) ||
      !/^\d+:\d+$/.test(registered[0]!.gitIdentity)
    )
      throw scopeChanged();
    stillBound();
  } catch (cause) {
    if (cause instanceof DomainError) throw cause;
    throw new DomainError(
      'INTEGRATION_JOURNAL_UNREADABLE',
      '无法只读取得原应用快照；保留日志、凭证与写锁后重试',
    );
  } finally {
    db.close();
  }
  stillBound();
  return {
    integrationId: record.integrationId,
    applicationId: record.applicationId,
    evidence: 'historical_local_journal' as const,
    localPhase: record.phase,
    root: record.root,
    acknowledgedReportSequence: record.acknowledged,
    pendingReportSequence: record.pending?.sequence ?? null,
    pendingReport: record.pending
      ? {
          stage: record.pending.stage,
          observedAt: record.pending.observedAt,
          reason: record.pending.reason,
        }
      : null,
    intendedUnconfirmedPath: record.intent,
    confirmedCreatedDirectories: record.directories ?? [],
    intendedDirectory: record.directoryIntent ?? null,
    confirmedAdded: record.added.map((entry) => ({
      path: entry.path,
      objectId: entry.objectId,
      gitMode: entry.gitMode,
      bytes: entry.bytes,
      identity: entry.identity,
    })),
    ...(record.existingChanges
      ? {
          existingChanges: {
            stoppedWritersAt: record.existingChanges.stoppedWritersAt,
            backup: record.existingChanges.backup.path,
            backupIdentity: record.existingChanges.backupIdentity,
            backupDirectoryIntent: record.existingChanges.directoryIntent,
            stageName: record.existingChanges.stageName,
            stageIdentity: record.existingChanges.stageIdentity,
            confirmed: record.existingChanges.changes,
            intended: record.existingChanges.intent,
          },
        }
      : {}),
    ...(restorations.length
      ? {
          restorations: restorations.map(({ record: r, recovery }) => ({
            restorationId: r.request.id,
            localPhase: r.phase,
            originalApplicationEvidenceHash: r.originalApplicationEvidenceHash,
            selectedPaths: r.request.paths,
            confirmedRestoredPaths: confirmedRestorationPaths(r),
            intendedUnconfirmedPath: r.intent,
            acknowledgedReportSequence: r.acknowledged,
            pendingReport: r.pending,
            retainedCurrentFiles: r.existingChanges,
            restoredDeletedFiles: r.added,
            recovery: recovery
              ? {
                  recoveryId: recovery.recoveryId,
                  phase: recovery.phase,
                  report: recovery.report,
                  acknowledged: recovery.acknowledged !== null,
                }
              : null,
            directoryChecked: false,
            writeAuthorized: false,
          })),
        }
      : {}),
    directoryChecked: false,
    currentServerAuthorityChecked: false,
    processStoppedConfirmed: false,
    writeAuthorized: false,
  };
}
