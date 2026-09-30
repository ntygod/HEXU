import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { exact as contractExact, nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  checkpointHash,
  commitOid,
  type CheckpointManifest,
} from '../../../../packages/contracts/src/checkpoints.js';
import { retentionDate } from '../../../../packages/contracts/src/checkpoint-retention.js';
import { integrationPaths } from '../../../../packages/contracts/src/integrations.js';
import {
  parseIntegrationFileRestorationReport,
  type IntegrationFileRestorationRequest,
  type IntegrationFileRestorationReport,
} from '../../../../packages/contracts/src/integration-restorations.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import {
  parseLocalApplicationRecord,
  type LocalApplication,
} from './integration-application-record.js';
import {
  integrationEvidenceHash as hash,
  validateRecoveryContextBinding,
} from './integration-recovery-context.js';
import { planIntegrationFileRestoration } from './integration-restoration-plan.js';
import {
  validateExistingIntegrationChanges,
  hasExistingIntegrationMaterial,
  type ExistingIntegrationChanges,
} from './integration-existing-change-record.js';
import type { RestoreEntry } from './checkpoint-restore-plan.js';

export interface LocalIntegrationRestoration {
  version: 1;
  kind: 'local_integration_file_restoration';
  binding: string;
  request: IntegrationFileRestorationRequest;
  originalApplicationEvidenceHash: string;
  contextHash: string;
  planHash: string;
  manifest: Pick<CheckpointManifest, 'commit' | 'tree' | 'objectFormat' | 'repositoryIdentity'>;
  phase: 'prepared' | 'restoring' | 'completed' | 'failed' | 'needs_attention';
  added: (RestoreEntry & { identity: string })[];
  intent: string | null;
  existingChanges: ExistingIntegrationChanges;
  pending: IntegrationFileRestorationReport | null;
  acknowledged: 0 | 1 | 2;
}
const invalid = () =>
  new DomainError(
    'INTEGRATION_RESTORATION_JOURNAL_INVALID',
    '文件恢复证据不完整或不一致；保留原凭证、全部材料与写锁',
  );
const exact = (value: unknown, keys: string[]) => {
  const body = contractExact(value, keys);
  if (Object.keys(body).length !== keys.length) throw invalid();
  return body;
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export const restorationKey = (id: string) => `restoration:${nodeId(id)}`;
export const confirmedRestorationPaths = (r: LocalIntegrationRestoration) =>
  [...r.added.map((e) => e.path), ...r.existingChanges.changes.map((e) => e.before.path)].sort();
export const restorationHasMaterial = (r: LocalIntegrationRestoration) =>
  !!r.added.length || r.intent !== null || hasExistingIntegrationMaterial(r.existingChanges);
export function parseRestorationRequest(value: unknown): IntegrationFileRestorationRequest {
  const r = exact(value, [
    'version',
    'kind',
    'id',
    'integrationId',
    'applicationId',
    'applicationInputHash',
    'completedReportHash',
    'paths',
    'inputHash',
    'requestedAt',
    'requestedBy',
  ]) as unknown as IntegrationFileRestorationRequest;
  if (r.version !== 1 || r.kind !== 'restore_confirmed_integration_files') throw invalid();
  [r.id, r.integrationId, r.applicationId].forEach((value) => nodeId(value));
  [r.applicationInputHash, r.completedReportHash, r.inputHash].forEach(checkpointHash);
  integrationPaths(r.paths, false);
  retentionDate(r.requestedAt);
  exact(r.requestedBy, ['id', 'name']);
  nodeId(r.requestedBy.id);
  if (typeof r.requestedBy.name !== 'string' || r.requestedBy.name.length > 200) throw invalid();
  const { inputHash, ...body } = r;
  if (inputHash !== hash(body)) throw invalid();
  return r;
}
const entry = (e: RestoreEntry) => ({
  path: e.path,
  kind: e.kind,
  objectId: e.objectId,
  gitMode: e.gitMode,
  bytes: e.bytes,
});
export function parseLocalIntegrationRestoration(
  body: unknown,
  key: string,
  original: LocalApplication,
): LocalIntegrationRestoration {
  try {
    if (typeof body !== 'string' || Buffer.byteLength(body) > 524288) throw invalid();
    const r = exact(JSON.parse(body), [
      'version',
      'kind',
      'binding',
      'request',
      'originalApplicationEvidenceHash',
      'contextHash',
      'planHash',
      'manifest',
      'phase',
      'added',
      'intent',
      'existingChanges',
      'pending',
      'acknowledged',
    ]) as unknown as LocalIntegrationRestoration;
    const request = parseRestorationRequest(r.request),
      plan = planIntegrationFileRestoration(JSON.stringify(original), original.integrationId),
      context = validateRecoveryContextBinding(original);
    if (
      r.version !== 1 ||
      r.kind !== 'local_integration_file_restoration' ||
      key !== restorationKey(request.id) ||
      r.binding !== original.binding ||
      request.integrationId !== original.integrationId ||
      request.applicationId !== original.applicationId ||
      request.applicationInputHash !== original.inputHash ||
      r.originalApplicationEvidenceHash !== plan.originalEvidenceHash ||
      r.contextHash !== context.contextHash ||
      r.planHash !== hash(plan) ||
      !same([...request.paths].sort(), context.selectedPaths.slice().sort())
    )
      throw invalid();
    exact(r.manifest, ['commit', 'tree', 'objectFormat', 'repositoryIdentity']);
    commitOid(r.manifest.commit);
    commitOid(r.manifest.tree);
    checkpointHash(r.manifest.repositoryIdentity);
    if (
      r.manifest.commit !== context.target.commit ||
      !['sha1', 'sha256'].includes(r.manifest.objectFormat) ||
      r.manifest.tree.length !== (r.manifest.objectFormat === 'sha1' ? 40 : 64) ||
      !['prepared', 'restoring', 'completed', 'failed', 'needs_attention'].includes(r.phase) ||
      ![0, 1, 2].includes(r.acknowledged) ||
      !Array.isArray(r.added) ||
      r.added.length > 80
    )
      throw invalid();
    validateExistingIntegrationChanges(r.existingChanges, original.root, request.paths);
    const seen = new Set<string>();
    for (const e of r.added) {
      exact(e, ['path', 'kind', 'objectId', 'gitMode', 'bytes', 'identity']);
      const f = plan.files.find((f) => f.path === e.path);
      if (
        !f ||
        f.before !== null ||
        !f.after ||
        !same(entry(e), entry(f.after)) ||
        typeof e.identity !== 'string' ||
        !/^\d+:\d+$/.test(e.identity) ||
        seen.has(e.path)
      )
        throw invalid();
      seen.add(e.path);
    }
    for (const change of [
      ...r.existingChanges.changes,
      ...(r.existingChanges.intent ? [r.existingChanges.intent] : []),
    ]) {
      const f = plan.files.find((f) => f.path === change.before.path);
      if (
        !f?.before ||
        !same(change.before, entry(f.before)) ||
        !same(change.after, f.after && entry(f.after)) ||
        change.originalIdentity !== f.before.identity ||
        seen.has(f.path)
      )
        throw invalid();
      seen.add(f.path);
    }
    if (
      r.intent !== null &&
      (!request.paths.includes(r.intent) ||
        r.added.some((e) => e.path === r.intent) ||
        r.existingChanges.changes.some((e) => e.before.path === r.intent))
    )
      throw invalid();
    if (r.existingChanges.intent && r.intent !== r.existingChanges.intent.before.path)
      throw invalid();
    if (
      r.intent &&
      !r.existingChanges.intent &&
      plan.files.find((f) => f.path === r.intent)?.before !== null
    )
      throw invalid();
    const paths = confirmedRestorationPaths(r);
    if (r.pending) {
      const p = parseIntegrationFileRestorationReport(r.pending);
      if (
        p.integrationId !== request.integrationId ||
        p.applicationId !== request.applicationId ||
        p.restorationId !== request.id ||
        p.inputHash !== request.inputHash ||
        p.originalApplicationEvidenceHash !== r.originalApplicationEvidenceHash ||
        p.sequence !== r.acknowledged + 1 ||
        p.stage !== (r.phase === 'prepared' ? 'restoring' : r.phase) ||
        !same(p.restoredPaths, paths)
      )
        throw invalid();
    }
    if (r.phase === 'prepared' && (restorationHasMaterial(r) || r.acknowledged > 1))
      throw invalid();
    if (r.phase === 'restoring' && (r.acknowledged !== 1 || r.pending)) throw invalid();
    if (
      r.phase === 'completed' &&
      (r.intent ||
        r.existingChanges.intent ||
        r.existingChanges.directoryIntent ||
        !r.existingChanges.backupIdentity ||
        !same(paths, request.paths.slice().sort()) ||
        (r.pending ? r.acknowledged !== 1 : r.acknowledged !== 2))
    )
      throw invalid();
    if (r.phase === 'failed' && restorationHasMaterial(r)) throw invalid();
    if (r.phase === 'needs_attention' && (r.pending ? r.acknowledged !== 1 : r.acknowledged !== 2))
      throw invalid();
    return r;
  } catch {
    throw invalid();
  }
}
export function readRestorationOriginal(
  db: DatabaseSync,
  r: Pick<LocalIntegrationRestoration, 'request'>,
) {
  const row = db.prepare('SELECT body FROM applications WHERE id=?').get(r.request.integrationId);
  if (!row) throw invalid();
  return parseLocalApplicationRecord(row.body, r.request.integrationId);
}
/** Same original commit, with only the not-yet-restored application overlays and
 * exact identities of files restored so far. Empty created directories remain. */
export function restorationWorkspaceOverlay(
  original: LocalApplication,
  r: LocalIntegrationRestoration,
) {
  const restored = new Set(confirmedRestorationPaths(r));
  const additions = original.added.filter((e) => !restored.has(e.path));
  const changes = (original.existingChanges?.changes ?? []).map((c) => {
    const restoredEntry = r.added.find((e) => e.path === c.before.path);
    const restoredChange = r.existingChanges.changes.find((e) => e.before.path === c.before.path);
    const id = restoredEntry?.identity ?? restoredChange?.targetIdentity;
    return {
      before: c.before,
      after: restored.has(c.before.path)
        ? { ...c.before, identity: id! }
        : c.after
          ? { ...c.after, identity: c.targetIdentity! }
          : null,
    };
  });
  return { additions, changes, directories: original.directories ?? [] };
}
