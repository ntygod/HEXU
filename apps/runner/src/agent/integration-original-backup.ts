import { closeSync, fstatSync, lstatSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { RETENTION_LIMITS } from '../../../../packages/contracts/src/checkpoint-retention.js';
import { parseLocalApplicationRecord } from './integration-application-record.js';
import { planIntegrationFileRestoration } from './integration-restoration-plan.js';
import { PinnedRestoreParent, fdPath, identity, stamp } from './checkpoint-restore-files.js';
import { readIntegrationChangeFile } from './integration-change-files.js';
import type { ExistingIntegrationChanges } from './integration-existing-change-record.js';
const changed = () =>
  new DomainError(
    'INTEGRATION_ORIGINAL_BACKUP_CHANGED',
    '原文件备份身份、归属或字节已变化；保留现场，不从相似内容猜测恢复来源',
  );

/** Read only a completed application's exact original backup ledger. Caller must
 * obtain separate current authority and explicit read/restore consent first.
 * This class neither opens the original workspace/Git nor authorizes a write. */
export class OriginalIntegrationBackup {
  private readonly evidence: ExistingIntegrationChanges;
  private readonly parent: PinnedRestoreParent;
  private fd: number | undefined;
  private fingerprints: Map<string, string> | undefined;
  private modes = new Map<string, number>();
  constructor(body: unknown, integrationId: string) {
    const record = parseLocalApplicationRecord(body, integrationId);
    const plan = planIntegrationFileRestoration(body, integrationId);
    if (
      !record.existingChanges ||
      !plan.originalBackup ||
      record.existingChanges.changes.reduce((sum, entry) => sum + entry.before.bytes, 0) >
        RETENTION_LIMITS.bytes
    )
      throw changed();
    this.evidence = record.existingChanges;
    this.parent = new PinnedRestoreParent(this.evidence.backup);
    try {
      this.fd = this.parent.openStage(
        basename(this.evidence.backup.path),
        this.evidence.backupIdentity!,
      );
      this.checkStructure();
    } catch (cause) {
      this.close();
      throw cause;
    }
  }
  private checkStructure() {
    const e = this.evidence;
    if (this.fd === undefined) throw changed();
    this.parent.revalidate();
    const root = fstatSync(this.fd, { bigint: true });
    if (
      identity(root) !== e.backupIdentity ||
      (root.mode & 0o7777n) !== 0o700n ||
      root.uid !== BigInt(process.getuid!()) ||
      identity(lstatSync(e.backup.path, { bigint: true })) !== e.backupIdentity ||
      JSON.stringify(readdirSync(fdPath(this.fd)).sort()) !==
        JSON.stringify(e.changes.map((entry) => entry.backupName).sort())
    )
      throw changed();
  }
  read() {
    this.checkStructure();
    const bytes = new Map<string, Buffer>(),
      fingerprints = new Map<string, string>();
    for (const entry of this.evidence.changes) {
      const read = readIntegrationChangeFile(
        this.fd!,
        entry.backupName,
        entry.before,
        entry.backupIdentity,
      );
      bytes.set(entry.before.path, read.bytes);
      this.modes.set(entry.before.path, read.permissions);
      fingerprints.set(entry.backupName, read.fingerprint);
    }
    this.fingerprints = fingerprints;
    this.assertUnchanged();
    return bytes;
  }
  permissions(path: string) {
    const mode = this.modes.get(path);
    if (mode === undefined) throw changed();
    return mode;
  }
  /** Call again after all other material/target checks and immediately before a
   * bounded filesystem action. Earlier matching bytes are not a reservation. */
  assertUnchanged() {
    this.checkStructure();
    if (!this.fingerprints) throw changed();
    for (const [name, expected] of this.fingerprints) {
      const s = lstatSync(fdPath(this.fd!, name), { bigint: true });
      if (!s.isFile() || s.isSymbolicLink() || identity(s) + ':' + stamp(s) !== expected)
        throw changed();
    }
  }
  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    this.parent.close();
  }
}
