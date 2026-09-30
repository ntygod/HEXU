import test from 'node:test';
import assert from 'node:assert/strict';
import {
  integrationEvidenceHash as hash,
  originalApplicationEvidenceHash,
  type IntegrationRecoveryContext,
} from '../apps/runner/src/agent/integration-recovery-context.js';
import type { LocalApplication } from '../apps/runner/src/agent/integration-application-record.js';
import { planIntegrationFileRestoration } from '../apps/runner/src/agent/integration-restoration-plan.js';
const entry = (path: string, oid: string) => ({
  path,
  kind: 'file' as const,
  objectId: oid.repeat(40),
  gitMode: '100644' as const,
  bytes: 4,
});
function original(mixed = true): LocalApplication {
  const paths = mixed ? ['added.txt', 'deleted.txt', 'modified.txt'] : ['added.txt'];
  const candidate = {
    trialId: 'fixed-trial',
    reportHash: 'c'.repeat(64),
    manifestHash: 'd'.repeat(64),
    confirmExistingChanges: true as const,
  };
  const inputHash = hash({
    integrationId: 'integration',
    applicationId: 'application',
    reportHash: 'a'.repeat(64),
    paths,
    ...(mixed ? { candidate } : {}),
  });
  const c: Omit<IntegrationRecoveryContext, 'contextHash'> = {
    version: 1,
    integrationId: 'integration',
    applicationId: 'application',
    taskId: 'task',
    projectId: 'project',
    spaceId: 'space',
    nodeId: 'node',
    workspaceId: 'workspace',
    integrationInputHash: 'b'.repeat(64),
    applicationInputHash: inputHash,
    source: {
      resultId: 'result',
      revisionId: 'revision',
      revision: 1,
      branchId: 'branch',
      materialId: 'source-material',
      materialKind: 'retention',
      commit: 'a'.repeat(40),
      snapshotHash: 'a'.repeat(64),
    },
    target: {
      checkpointId: 'target-checkpoint',
      retentionId: 'target-material',
      commit: 'b'.repeat(40),
      snapshotHash: 'b'.repeat(64),
    },
    reportHash: 'a'.repeat(64),
    selectedPaths: paths,
    ...(mixed ? { candidate } : {}),
    root: '/tmp/fixed-original-target',
    rootIdentity: '1:2',
    gitDir: '/tmp/fixed-original-target/.git',
    gitIdentity: '1:3',
  };
  return {
    binding: 'f'.repeat(64),
    integrationId: 'integration',
    applicationId: 'application',
    inputHash,
    root: c.root,
    phase: 'completed',
    added: [{ ...entry('added.txt', 'c'), identity: '1:10' }],
    intent: null,
    pending: null,
    acknowledged: 2,
    recoveryContext: { ...c, contextHash: hash(c) },
    directories: [],
    directoryIntent: null,
    ...(mixed
      ? {
          existingChanges: {
            backup: {
              path: '/tmp/original-private-backup',
              parents: [
                { path: '/tmp', identity: '1:4' },
                { path: '/', identity: '1:5' },
              ],
            },
            stageName: '.hexu-restore-00000000-0000-0000-0000-000000000000',
            stageIdentity: '1:6:7',
            backupIdentity: '1:6:7',
            directoryIntent: false,
            stoppedWritersAt: '2026-09-30T00:00:00.000Z',
            intent: null,
            changes: [
              {
                before: entry('deleted.txt', 'd'),
                after: null,
                originalIdentity: '1:11',
                backupName: 'hexu-change-00000000-0000-0000-0000-000000000001',
                backupIdentity: '1:11',
                targetIdentity: null,
              },
              {
                before: entry('modified.txt', 'e'),
                after: entry('modified.txt', 'f'),
                originalIdentity: '1:12',
                backupName: 'hexu-change-00000000-0000-0000-0000-000000000002',
                backupIdentity: '1:12',
                targetIdentity: '1:13',
              },
            ],
          },
        }
      : {}),
  };
}
test('明确恢复计划只反转已确认的新增/修改/删除全部文件，不假装授权或访问材料', () => {
  const r = original(),
    body = JSON.stringify(r);
  const plan = planIntegrationFileRestoration(body, r.integrationId);
  assert.equal(plan.originalEvidenceHash, originalApplicationEvidenceHash(r));
  assert.equal(plan.applicationInputHash, r.inputHash);
  assert.equal(plan.writeAuthorized, false);
  assert.equal(plan.evidence, 'historical_application_only');
  assert.deepEqual(
    plan.files.map((f) => [f.path, f.before?.objectId ?? null, f.after?.objectId ?? null]),
    [
      ['added.txt', 'c'.repeat(40), null],
      ['deleted.txt', null, 'd'.repeat(40)],
      ['modified.txt', 'f'.repeat(40), 'e'.repeat(40)],
    ],
  );
  assert.equal(plan.files[1]!.after!.backupIdentity, '1:11');
  assert.equal(plan.files[2]!.before!.identity, '1:13');
  plan.files[0]!.before!.path = 'changed-plan-copy';
  assert.equal(JSON.stringify(r), body);
});
test('已确认的旧新增应用可规划移到新备份，不能虚构原文件备份或目录清理', () => {
  const r = original(false),
    p = planIntegrationFileRestoration(JSON.stringify(r), r.integrationId);
  assert.equal(p.originalBackup, null);
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0]!.after, null);
  assert.deepEqual(p.retainedDirectories, []);
});
test('部分/未知/回执未确认或缺原上下文时拒绝恢复计划，不利用看起来相同的文件', () => {
  const base = original();
  for (const mutate of [
    (r: LocalApplication) => {
      r.phase = 'needs_attention';
    },
    (r: LocalApplication) => {
      r.phase = 'applying';
      r.acknowledged = 1;
    },
    (r: LocalApplication) => {
      r.acknowledged = 1;
    },
    (r: LocalApplication) => {
      r.intent = 'modified.txt';
    },
    (r: LocalApplication) => {
      delete r.recoveryContext;
    },
    (r: LocalApplication) => {
      r.existingChanges!.backupIdentity = null;
    },
    (r: LocalApplication) => {
      r.existingChanges!.changes[0]!.before.path = 'unconfirmed-file';
    },
  ]) {
    const r = structuredClone(base);
    mutate(r);
    assert.throws(() => planIntegrationFileRestoration(JSON.stringify(r), r.integrationId));
  }
  assert.throws(() =>
    planIntegrationFileRestoration(JSON.stringify(base), 'different-integration'),
  );
});

async function realBackup() {
  const { mkdtempSync, mkdirSync, lstatSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { objectHash } = await import('../apps/runner/src/agent/checkpoint-objects.js');
  const { observeIntegrationChangeTarget } = await import(
    '../apps/runner/src/agent/integration-change-files.js'
  );
  const { identity, inode } = await import('../apps/runner/src/agent/checkpoint-restore-files.js');
  const dir = mkdtempSync(join(tmpdir(), 'hexu-original-backup-read-')),
    root = join(dir, 'original-target'),
    backup = join(dir, 'original-backup');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(backup, { mode: 0o700 });
  const r = original();
  r.root = root;
  r.recoveryContext!.root = root;
  r.recoveryContext!.gitDir = join(root, '.git');
  r.existingChanges!.backup = observeIntegrationChangeTarget(backup);
  r.existingChanges!.stageIdentity = r.existingChanges!.backupIdentity = identity(
    lstatSync(backup, { bigint: true }),
  );
  for (const c of r.existingChanges!.changes) {
    const data = Buffer.from(c.before.path === 'deleted.txt' ? 'gone' : 'prev');
    writeFileSync(join(backup, c.backupName), data, { mode: 0o600 });
    c.before.bytes = data.length;
    c.before.objectId = objectHash('sha1', 'blob', data);
    c.originalIdentity = c.backupIdentity = inode(
      lstatSync(join(backup, c.backupName), { bigint: true }),
    );
  }
  const { contextHash: _hash, ...context } = r.recoveryContext!;
  r.recoveryContext!.contextHash = hash(context);
  return {
    r,
    dir,
    root,
    backup,
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test(
  '原备份读取只按确认清单/身份/哈希返回字节，不依赖目标Git或过期来源材料',
  { skip: process.platform !== 'linux' },
  async () => {
    const { OriginalIntegrationBackup } = await import(
      '../apps/runner/src/agent/integration-original-backup.js'
    );
    const { readdirSync, readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const f = await realBackup();
    const reader = new OriginalIntegrationBackup(JSON.stringify(f.r), f.r.integrationId);
    try {
      assert.throws(() => reader.assertUnchanged());
      const bytes = reader.read();
      assert.equal(bytes.get('deleted.txt')!.toString(), 'gone');
      assert.equal(bytes.get('modified.txt')!.toString(), 'prev');
      assert.deepEqual(
        readdirSync(f.root),
        [],
        'no Git, target or candidate material was created/read',
      );
      reader.assertUnchanged();
      bytes.get('deleted.txt')!.fill(0);
      assert.equal(
        readFileSync(join(f.backup, f.r.existingChanges!.changes[0]!.backupName), 'utf8'),
        'gone',
      );
      writeFileSync(join(f.backup, f.r.existingChanges!.changes[1]!.backupName), 'USER');
      assert.throws(() => reader.assertUnchanged());
      assert.throws(() => reader.read());
      assert.equal(
        readFileSync(join(f.backup, f.r.existingChanges!.changes[1]!.backupName), 'utf8'),
        'USER',
      );
    } finally {
      reader.close();
      f.close();
    }
  },
);
test(
  '原备份多出文件或目录改名/替换时拒绝，不扫描其他目录或接管用户副本',
  { skip: process.platform !== 'linux' },
  async () => {
    const { OriginalIntegrationBackup } = await import(
      '../apps/runner/src/agent/integration-original-backup.js'
    );
    const { writeFileSync, renameSync, mkdirSync, readdirSync, readFileSync } = await import(
      'node:fs'
    );
    const { join } = await import('node:path');
    const f = await realBackup();
    const reader = new OriginalIntegrationBackup(JSON.stringify(f.r), f.r.integrationId);
    try {
      reader.read();
      writeFileSync(join(f.backup, 'user-extra'), 'KEEP');
      assert.throws(() => reader.assertUnchanged());
      assert.throws(() => new OriginalIntegrationBackup(JSON.stringify(f.r), f.r.integrationId));
      renameSync(f.backup, f.backup + '-moved');
      mkdirSync(f.backup, { mode: 0o700 });
      assert.throws(() => reader.assertUnchanged());
      assert.equal(readFileSync(join(f.backup + '-moved', 'user-extra'), 'utf8'), 'KEEP');
      assert.deepEqual(readdirSync(f.backup), []);
    } finally {
      reader.close();
      f.close();
    }
  },
);
