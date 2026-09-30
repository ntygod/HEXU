import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { inspectRestoreTarget } from './checkpoint-restore-plan.js';
import {
  fdPath,
  identity,
  PinnedRestoreParent,
  publishRestore,
} from './checkpoint-restore-files.js';
import type {
  CreatedIntegrationDirectory,
  IntegrationDirectoryIntent,
} from './integration-application-record.js';

const changed = () =>
  new DomainError('RESTORE_FILES_CHANGED', '原父目录或本次新目录已变化，保留现场与写锁');

/** Original ancestors are frozen before any write. Fresh observations may only
 * add directories with this attempt's exact published ownership evidence. */
export class IntegrationAdditionParents {
  private readonly original = new Map<string, string>();
  constructor(
    private readonly root: string,
    anchors: readonly string[],
    private readonly protectedPaths: readonly string[],
  ) {
    for (const path of anchors) {
      const observation = inspectRestoreTarget(join(root, path), protectedPaths);
      for (const parent of observation.parents) {
        if (this.original.has(parent.path) && this.original.get(parent.path) !== parent.identity)
          throw changed();
        this.original.set(parent.path, parent.identity);
      }
    }
  }
  open(path: string, directories: readonly CreatedIntegrationDirectory[]) {
    const observation = inspectRestoreTarget(join(this.root, path), this.protectedPaths);
    const owned = new Map(
      directories.map((directory) => [join(this.root, directory.path), directory.identity]),
    );
    for (const parent of observation.parents) {
      const recorded = owned.get(parent.path);
      if (recorded) {
        if (identity(lstatSync(parent.path, { bigint: true })) !== recorded) throw changed();
      } else if (this.original.get(parent.path) !== parent.identity) throw changed();
    }
    return new PinnedRestoreParent(observation);
  }
}

export function newIntegrationDirectoryIntent(path: string): IntegrationDirectoryIntent {
  return { path, stageName: `.hexu-restore-${randomUUID()}`, stageIdentity: null };
}

/** The caller persists the directory intent before entering this function and
 * persists the stage identity callback before the no-replace publication. No
 * failure path cleans up or decides that a surviving target implies success. */
export function publishIntegrationDirectory(
  parent: PinnedRestoreParent,
  intent: IntegrationDirectoryIntent,
  stageCreated: (identity: string) => void,
): CreatedIntegrationDirectory {
  if (basename(parent.observation.path) !== basename(intent.path) || intent.stageIdentity !== null)
    throw changed();
  let stage: number | undefined;
  try {
    stage = parent.createStage(intent.stageName);
    const initial = fstatSync(stage, { bigint: true });
    if (
      !initial.isDirectory() ||
      (initial.mode & 0o777n) !== 0o700n ||
      readdirSync(fdPath(stage)).length
    )
      throw changed();
    const ownedIdentity = identity(initial);
    stageCreated(ownedIdentity);
    parent.revalidate();
    parent.assertAbsent();
    if (
      identity(lstatSync(fdPath(parent.fd, intent.stageName), { bigint: true })) !== ownedIdentity
    )
      throw changed();
    const outcome = publishRestore(parent, intent.stageName, stage);
    if (outcome !== 'published')
      throw new DomainError(
        'INTEGRATION_DIRECTORY_UNKNOWN',
        '新父目录尚未确认排他发布；保留原意图和暂存，不自动重试或清理',
      );
    parent.revalidate();
    if (
      identity(
        lstatSync(fdPath(parent.fd, basename(parent.observation.path)), { bigint: true }),
      ) !== ownedIdentity ||
      readdirSync(fdPath(stage)).length
    )
      throw changed();
    return { path: intent.path, identity: ownedIdentity };
  } finally {
    if (stage !== undefined) closeSync(stage);
  }
}
