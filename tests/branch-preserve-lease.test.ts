import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { openSync, closeSync, fstatSync, constants as F } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import { inspectRestoreTarget } from '../apps/runner/src/agent/checkpoint-restore-plan.js';
import {
  PinnedRestoreParent,
  identity,
} from '../apps/runner/src/agent/checkpoint-restore-files.js';
import { preserveBranchDirectory } from '../apps/runner/src/agent/branch-preserve-files.js';
import {
  branchPreservedReleaseReceipt,
  releasePreservedBranchClaim,
  type BranchPreservedRelease,
} from '../apps/runner/src/agent/branch-preserve-lease.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-preserve-release-')),
    original = join(dir, 'active'),
    keep = join(dir, 'kept'),
    root = join(original, 'repo'),
    target = join(keep, 'repo');
  await mkdir(original, { mode: 0o700 });
  await mkdir(keep, { mode: 0o700 });
  const sourceObservation = inspectRestoreTarget(root, []),
    targetObservation = inspectRestoreTarget(target, []);
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, '.git'), { mode: 0o700 });
  await writeFile(join(root, 'keep'), 'KEEP ALL ORIGINAL DATA');
  const source = new PinnedRestoreParent(sourceObservation),
    destination = new PinnedRestoreParent(targetObservation),
    fd = openSync(root, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW),
    git = openSync(join(root, '.git'), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW),
    id = randomUUID();
  const claim = new WorkspaceLease(root, 'branch-preserve:' + id),
    now = new Date().toISOString();
  const request: BranchPreservedRelease = {
    version: 1,
    kind: 'branch_directory_preservation_settlement',
    outcome: 'preserved',
    preservationId: id,
    claimId: 'branch-preserve:' + id,
    root,
    destination: target,
    rootIdentity: identity(fstatSync(fd, { bigint: true })),
    gitIdentity: identity(fstatSync(git, { bigint: true })),
    evidenceHash: 'a'.repeat(64),
    stoppedConfirmedAt: now,
    observedAt: now,
  };
  const move = () =>
    preserveBranchDirectory(
      source,
      destination,
      fd,
      git,
      request.rootIdentity,
      request.gitIdentity,
    );
  const release = () => releasePreservedBranchClaim(request, source, destination, fd, git);
  return {
    root,
    target,
    keep,
    request,
    claim,
    move,
    release,
    close: async () => {
      claim.release();
      closeSync(git);
      closeSync(fd);
      source.close();
      destination.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test('移动后结算精确原占用且原文件完整；持久收据重复先于后来原路径和后来写入者', async () => {
  const f = await fixture();
  let later: WorkspaceLease | undefined;
  try {
    assert.equal(branchPreservedReleaseReceipt(f.request), null);
    assert.equal(f.move(), 'preserved');
    const receipt = f.release();
    assert.equal(receipt.claimId, f.request.claimId);
    assert.deepEqual(branchPreservedReleaseReceipt(f.request), receipt);
    await mkdir(f.root, { mode: 0o700 });
    await writeFile(join(f.root, 'user'), 'LATER ORIGINAL PATH');
    later = new WorkspaceLease(f.root, 'later-' + randomUUID());
    await rename(f.target, f.target + '-user-moved');
    assert.deepEqual(f.release(), receipt);
    later.assertHeld();
    assert.equal(await readFile(join(f.root, 'user'), 'utf8'), 'LATER ORIGINAL PATH');
    assert.equal(
      await readFile(join(f.target + '-user-moved', 'keep'), 'utf8'),
      'KEEP ALL ORIGINAL DATA',
    );
    assert.throws(
      () => branchPreservedReleaseReceipt({ ...f.request, evidenceHash: 'b'.repeat(64) }),
      { code: 'BRANCH_PRESERVE_RELEASE_MISMATCH' },
    );
  } finally {
    later?.release();
    await f.close();
  }
});
test('尚未移动、错误claim或后来重叠占用均不能清锁，不从旧路径消失猜成功', async () => {
  const f = await fixture();
  let other: WorkspaceLease | undefined;
  try {
    assert.throws(f.release);
    f.claim.assertHeld();
    assert.equal(branchPreservedReleaseReceipt(f.request), null);
    other = new WorkspaceLease(f.keep, 'other-' + randomUUID());
    assert.equal(f.move(), 'preserved');
    assert.throws(f.release, { code: 'BRANCH_PRESERVE_RELEASE_MISMATCH' });
    other.assertHeld();
    assert.equal(branchPreservedReleaseReceipt(f.request), null);
    assert.equal(await readFile(join(f.target, 'keep'), 'utf8'), 'KEEP ALL ORIGINAL DATA');
  } finally {
    other?.release();
    await f.close();
  }
});
test('错误目录身份、未来时间或缺失原claim拒绝，不为后来同名目录创建结算收据', async () => {
  const f = await fixture();
  try {
    assert.equal(f.move(), 'preserved');
    assert.throws(
      () =>
        branchPreservedReleaseReceipt({
          ...f.request,
          claimId: 'integration:' + f.request.preservationId,
        }),
      { code: 'BRANCH_PRESERVE_RELEASE_MISMATCH' },
    );
    const observedAt = f.request.observedAt,
      rootIdentity = f.request.rootIdentity;
    f.request.observedAt = new Date(Date.now() + 60000).toISOString();
    assert.throws(f.release, { code: 'BRANCH_PRESERVE_RELEASE_MISMATCH' });
    f.request.observedAt = observedAt;
    f.request.rootIdentity = '1:2:3';
    assert.throws(f.release, { code: 'BRANCH_PRESERVE_RELEASE_MISMATCH' });
    f.request.rootIdentity = rootIdentity;
    f.claim.release();
    assert.throws(f.release, { code: 'BRANCH_PRESERVE_RELEASE_MISMATCH' });
    assert.equal(branchPreservedReleaseReceipt(f.request), null);
    assert.equal(await readFile(join(f.target, 'keep'), 'utf8'), 'KEEP ALL ORIGINAL DATA');
  } finally {
    await f.close();
  }
});
test('已明确未移动的失败只结算原claim，不查看/释放已被别人占用的目标', async () => {
  const f = await fixture();
  let other: WorkspaceLease | undefined;
  try {
    f.request.outcome = 'not_moved';
    other = new WorkspaceLease(f.keep, 'unrelated-target-owner');
    const receipt = f.release();
    assert.equal(receipt.outcome, 'not_moved');
    other.assertHeld();
    assert.equal(await readFile(join(f.root, 'keep'), 'utf8'), 'KEEP ALL ORIGINAL DATA');
    assert.deepEqual(branchPreservedReleaseReceipt(f.request), receipt);
  } finally {
    other?.release();
    await f.close();
  }
});
