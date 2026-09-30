import { closeSync, constants as F, fstatSync, lstatSync, openSync, readdirSync } from 'node:fs';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  fdPath,
  identity,
  stamp,
  PinnedRestoreParent,
  publishRestore,
} from './checkpoint-restore-files.js';
import { verifyIntegrationChangeFile } from './integration-change-files.js';
import type { ExistingIntegrationChanges } from './integration-existing-change-record.js';

const changed = () =>
  new DomainError('INTEGRATION_BACKUP_CHANGED', '本次私有备份目录或材料已变化；保留现场与写锁');
/** One explicitly named NEW directory. Never reuse an existing backup directory
 * or remove it on error; the original application journal owns its evidence. */
export class IntegrationApplicationBackup {
  private parent: PinnedRestoreParent;
  private fd: number | undefined;
  private verifiedEntries = new Map<string, string>();
  constructor(
    readonly evidence: ExistingIntegrationChanges,
    targetRoot: string,
  ) {
    this.parent = new PinnedRestoreParent(evidence.backup);
    try {
      this.parent.assertAbsent();
      if (fstatSync(this.parent.fd).dev !== lstatSync(targetRoot).dev) throw changed();
    } catch (cause) {
      this.parent.close();
      throw cause;
    }
  }
  create(save: () => void, ready: () => void) {
    const e = this.evidence;
    if (e.stageIdentity || e.backupIdentity || e.directoryIntent) throw changed();
    e.directoryIntent = true;
    save();
    this.fd = this.parent.createStage(e.stageName);
    e.stageIdentity = identity(fstatSync(this.fd, { bigint: true }));
    save();
    ready();
    if (
      readdirSync(fdPath(this.fd)).length ||
      identity(lstatSync(fdPath(this.parent.fd, e.stageName), { bigint: true })) !== e.stageIdentity
    )
      throw changed();
    const outcome = publishRestore(this.parent, e.stageName, this.fd);
    if (outcome !== 'published') throw changed();
    this.parent.revalidate();
    if (identity(lstatSync(e.backup.path, { bigint: true })) !== e.stageIdentity) throw changed();
    e.backupIdentity = e.stageIdentity;
    e.directoryIntent = false;
    save();
  }
  verify() {
    const e = this.evidence;
    if (this.fd === undefined || !e.backupIdentity || e.directoryIntent) throw changed();
    this.parent.revalidate();
    const current = fstatSync(this.fd, { bigint: true });
    if (
      identity(current) !== e.backupIdentity ||
      (current.mode & 0o7777n) !== 0o700n ||
      current.uid !== BigInt(process.getuid!()) ||
      identity(lstatSync(e.backup.path, { bigint: true })) !== e.backupIdentity
    )
      throw changed();
    const names = readdirSync(fdPath(this.fd)).sort();
    if (JSON.stringify(names) !== JSON.stringify(e.changes.map((c) => c.backupName).sort()))
      throw changed();
    // Reverify every saved original at each later/final application boundary;
    // user-edited backups are not evidence that the original remains intact.
    this.verifiedEntries.clear();
    for (const change of e.changes) {
      this.verifiedEntries.set(
        change.backupName,
        verifyIntegrationChangeFile(
          this.fd,
          change.backupName,
          change.before,
          change.backupIdentity,
        ),
      );
      const s = lstatSync(fdPath(this.fd, change.backupName), { bigint: true });
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.nlink !== 1n ||
        `${s.dev}:${s.ino}` !== change.backupIdentity
      )
        throw changed();
    }
  }
  revalidate() {
    const e = this.evidence;
    if (this.fd === undefined || !e.backupIdentity) throw changed();
    this.parent.revalidate();
    const root = fstatSync(this.fd, { bigint: true });
    if (
      identity(root) !== e.backupIdentity ||
      (root.mode & 0o7777n) !== 0o700n ||
      identity(lstatSync(e.backup.path, { bigint: true })) !== e.backupIdentity ||
      JSON.stringify(readdirSync(fdPath(this.fd)).sort()) !==
        JSON.stringify([...this.verifiedEntries.keys()].sort())
    )
      throw changed();
    for (const [name, expected] of this.verifiedEntries) {
      const s = lstatSync(fdPath(this.fd, name), { bigint: true });
      if (!s.isFile() || s.isSymbolicLink() || identity(s) + ':' + stamp(s) !== expected)
        throw changed();
    }
  }
  openSlot(name: string) {
    if (this.fd === undefined || !this.evidence.backupIdentity) throw changed();
    this.parent.revalidate();
    const path = `${this.evidence.backup.path}/${name}`;
    const parents = [
      {
        path: this.evidence.backup.path,
        identity: `${fstatSync(this.fd, { bigint: true }).dev}:${fstatSync(this.fd, { bigint: true }).ino}`,
      },
      ...this.evidence.backup.parents,
    ];
    const pinned = new PinnedRestoreParent({ path, parents });
    if (identity(fstatSync(pinned.fd, { bigint: true })) !== this.evidence.backupIdentity) {
      pinned.close();
      throw changed();
    }
    return pinned;
  }
  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    this.parent.close();
  }
}
