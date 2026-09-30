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
