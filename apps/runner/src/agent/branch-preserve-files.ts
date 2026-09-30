import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { PinnedRestoreParent, identity } from './checkpoint-restore-files.js';

const executable = fileURLToPath(new URL('../native/workspace-preserve', import.meta.url));
export function checkBranchPreserveHelper() {
  const r = spawnSync(executable, ['--version'], {
    env: { LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (r.error || r.status !== 0 || r.stdout.trim() !== 'hexu-workspace-preserve-v1')
    throw new DomainError(
      'BRANCH_PRESERVE_HELPER_UNAVAILABLE',
      '缺少Linux整目录排他移出组件；不会退回copy/delete或可覆盖rename',
    );
}
/** Caller owns explicit new consent, exact journal intent and persistent claim.
 * Keep both fds/locations on any unknown outcome; this helper never retries. */
export function preserveBranchDirectory(
  source: PinnedRestoreParent,
  destination: PinnedRestoreParent,
  root: number,
  git: number,
  rootIdentity: string,
  gitIdentity: string,
): 'preserved' | 'not_moved' | 'unknown' {
  source.revalidate();
  destination.revalidate();
  destination.assertAbsent();
  if (
    identity(fstatSync(root, { bigint: true })) !== rootIdentity ||
    identity(fstatSync(git, { bigint: true })) !== gitIdentity
  )
    throw new DomainError('BRANCH_PRESERVE_SCOPE_CHANGED', '原根目录或Git身份已变化，未移动');
  const r = spawnSync(
    executable,
    [basename(source.observation.path), basename(destination.observation.path)],
    {
      stdio: ['ignore', 'pipe', 'pipe', source.fd, destination.fd, root, git],
      env: { LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
    },
  );
  if (!r.error && r.status === 20 && r.stdout.trim() === 'not_moved') return 'not_moved';
  if (!r.error && r.status === 0 && r.stdout.trim() === 'preserved') return 'preserved';
  return 'unknown';
}
