import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { exact, nodeId } from '../../../../packages/contracts/src/nodes.js';
import { checkpointHash, commitOid } from '../../../../packages/contracts/src/checkpoints.js';
import type { IntegrationOperation } from '../../../../packages/contracts/src/integrations.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import type { NodeCredentials } from './storage.js';
import type { LocalApplication } from './integration-application-record.js';
import { restoreBinding } from './checkpoint-restore-preflight.js';

export const integrationEvidenceHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Frozen before the first write. This is original authorization context, not
 * evidence of current authority, process termination or current file contents. */
export interface IntegrationRecoveryContext {
  version: 1;
  integrationId: string;
  applicationId: string;
  taskId: string;
  projectId: string;
  spaceId: string;
  nodeId: string;
  workspaceId: string;
  integrationInputHash: string;
  applicationInputHash: string;
  source: {
    resultId: string;
    revisionId: string;
    revision: number;
    branchId: string;
    materialId: string;
    materialKind: 'retention' | 'transfer';
    commit: string;
    snapshotHash: string;
  };
  target: { checkpointId: string; retentionId: string; commit: string; snapshotHash: string };
  reportHash: string;
  selectedPaths: string[];
  root: string;
  rootIdentity: string;
  gitDir: string;
  gitIdentity: string;
  contextHash: string;
}
const invalid = () =>
  new DomainError(
    'INTEGRATION_CONTEXT_INVALID',
    '原应用恢复上下文不完整或绑定已变化；保留现场与写锁',
  );
export function parseIntegrationRecoveryContext(value: unknown): IntegrationRecoveryContext {
  try {
    const c = exact(value, [
      'version',
      'integrationId',
      'applicationId',
      'taskId',
      'projectId',
      'spaceId',
      'nodeId',
      'workspaceId',
      'integrationInputHash',
      'applicationInputHash',
      'source',
      'target',
      'reportHash',
      'selectedPaths',
      'root',
      'rootIdentity',
      'gitDir',
      'gitIdentity',
      'contextHash',
    ]) as unknown as IntegrationRecoveryContext;
    if (c.version !== 1) throw invalid();
    for (const id of [
      c.integrationId,
      c.applicationId,
      c.taskId,
      c.projectId,
      c.spaceId,
      c.nodeId,
      c.workspaceId,
    ])
      nodeId(id);
    for (const h of [c.integrationInputHash, c.applicationInputHash, c.reportHash, c.contextHash])
      checkpointHash(h);
    exact(c.source, [
      'resultId',
      'revisionId',
      'revision',
      'branchId',
      'materialId',
      'materialKind',
      'commit',
      'snapshotHash',
    ]);
    for (const id of [
      c.source.resultId,
      c.source.revisionId,
      c.source.branchId,
      c.source.materialId,
    ])
      nodeId(id);
    if (
      !Number.isSafeInteger(c.source.revision) ||
      c.source.revision < 1 ||
      !['retention', 'transfer'].includes(c.source.materialKind)
    )
      throw invalid();
    commitOid(c.source.commit);
    checkpointHash(c.source.snapshotHash);
    exact(c.target, ['checkpointId', 'retentionId', 'commit', 'snapshotHash']);
    nodeId(c.target.checkpointId);
    nodeId(c.target.retentionId);
    commitOid(c.target.commit);
    checkpointHash(c.target.snapshotHash);
    if (
      !Array.isArray(c.selectedPaths) ||
      !c.selectedPaths.length ||
      c.selectedPaths.length > 80 ||
      new Set(c.selectedPaths).size !== c.selectedPaths.length
    )
      throw invalid();
    for (const path of c.selectedPaths)
      if (
        typeof path !== 'string' ||
        Buffer.byteLength(path) > 4096 ||
        /[\\\p{Cc}\p{Cf}]/u.test(path) ||
        path
          .split('/')
          .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
      )
        throw invalid();
    for (const path of [c.root, c.gitDir])
      if (
        typeof path !== 'string' ||
        !isAbsolute(path) ||
        resolve(path) !== path ||
        Buffer.byteLength(path) > 4096 ||
        /[\p{Cc}\p{Cf}]/u.test(path)
      )
        throw invalid();
    if (
      c.gitDir !== join(c.root, '.git') ||
      typeof c.rootIdentity !== 'string' ||
      typeof c.gitIdentity !== 'string' ||
      !/^\d+:\d+$/.test(c.rootIdentity) ||
      !/^\d+:\d+$/.test(c.gitIdentity)
    )
      throw invalid();
    const { contextHash, ...body } = c;
    if (
      contextHash !== integrationEvidenceHash(body) ||
      c.applicationInputHash !==
        integrationEvidenceHash({
          integrationId: c.integrationId,
          applicationId: c.applicationId,
          reportHash: c.reportHash,
          paths: c.selectedPaths,
        })
    )
      throw invalid();
    return c;
  } catch {
    throw invalid();
  }
}

/** Only use an exact, currently authorized inspect response for legacy hydration.
 * Material availability is deliberately not consulted for preserve-only release. */
export function freezeIntegrationRecoveryContext(
  o: IntegrationOperation,
  credentials: NodeCredentials,
) {
  const a = o.application,
    w = credentials.directories.find((w) => w.id === o.target?.checkpoint?.request.workspaceId);
  if (
    !a ||
    !o.report?.plan ||
    !w ||
    !credentials.nodeId ||
    o.projectId !== credentials.projectId ||
    o.spaceId !== credentials.spaceId ||
    o.target.checkpoint.request.nodeId !== credentials.nodeId ||
    o.inputHash !==
      integrationEvidenceHash({
        id: o.id,
        taskId: o.taskId,
        source: o.source,
        target: o.target,
        material: o.material,
      }) ||
    a.reportHash !== integrationEvidenceHash(o.report) ||
    a.inputHash !==
      integrationEvidenceHash({
        integrationId: o.id,
        applicationId: a.id,
        reportHash: a.reportHash,
        paths: a.paths,
      })
  )
    throw invalid();
  const body = {
    version: 1 as const,
    integrationId: o.id,
    applicationId: a.id,
    taskId: o.taskId,
    projectId: o.projectId,
    spaceId: o.spaceId,
    nodeId: credentials.nodeId,
    workspaceId: w.id,
    integrationInputHash: o.inputHash,
    applicationInputHash: a.inputHash,
    source: {
      resultId: o.source.resultId,
      revisionId: o.source.revisionId,
      revision: o.source.revision,
      branchId: o.source.branchId,
      materialId: o.material.id,
      materialKind: o.material.kind,
      commit: o.material.manifest.commit,
      snapshotHash: o.material.manifest.snapshotHash,
    },
    target: {
      checkpointId: o.target.checkpoint.id,
      retentionId: o.target.retentionId,
      commit: o.target.manifest.commit,
      snapshotHash: o.target.manifest.snapshotHash,
    },
    reportHash: a.reportHash,
    selectedPaths: [...a.paths],
    root: w.root,
    rootIdentity: w.rootIdentity,
    gitDir: w.gitDir,
    gitIdentity: w.gitIdentity,
  };
  return parseIntegrationRecoveryContext({ ...body, contextHash: integrationEvidenceHash(body) });
}

export function validateRecoveryContextBinding(
  record: LocalApplication,
  credentials?: NodeCredentials,
) {
  const c = parseIntegrationRecoveryContext(record.recoveryContext);
  if (
    c.integrationId !== record.integrationId ||
    c.applicationId !== record.applicationId ||
    c.applicationInputHash !== record.inputHash ||
    c.root !== record.root ||
    record.added.some((entry) => !c.selectedPaths.includes(entry.path)) ||
    (record.intent !== null && !c.selectedPaths.includes(record.intent))
  )
    throw invalid();
  if (record.phase === 'completed' && record.added.length !== c.selectedPaths.length)
    throw invalid();
  if (credentials) {
    const registered = credentials.directories.filter((w) => w.id === c.workspaceId);
    if (
      record.binding !== restoreBinding(credentials) ||
      c.projectId !== credentials.projectId ||
      c.spaceId !== credentials.spaceId ||
      c.nodeId !== credentials.nodeId ||
      registered.length !== 1 ||
      ['root', 'rootIdentity', 'gitDir', 'gitIdentity'].some(
        (key) => registered[0]![key as 'root'] !== c[key as 'root'],
      )
    )
      throw invalid();
  }
  return c;
}

/** Context hydration is metadata, never a rewrite of original application evidence. */
export function originalApplicationEvidenceHash(record: LocalApplication) {
  const { recoveryContext: _context, ...evidence } = record;
  return integrationEvidenceHash(evidence);
}
