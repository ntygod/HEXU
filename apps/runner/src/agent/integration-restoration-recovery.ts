import { randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { exact as contractExact, nodeId } from '../../../../packages/contracts/src/nodes.js';
import { retentionDate } from '../../../../packages/contracts/src/checkpoint-retention.js';
import {
  parseIntegrationFileRestorationRecoveryReport,
  type IntegrationFileRestorationRecoveryReport,
  type IntegrationFileRestorationRecoveryReceipt,
} from '../../../../packages/contracts/src/integration-restorations.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import {
  releaseWorkspaceClaim,
  workspaceReleaseReceipt,
  type WorkspaceReleaseRequest,
  type WorkspaceReleaseReceipt,
} from '../workspace-lease.js';
import { AgentStorage, readCredentials } from './storage.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import { nodeRequest } from './connection.js';
import {
  parseLocalApplicationRecord,
  type LocalApplication,
} from './integration-application-record.js';
import {
  integrationEvidenceHash as hash,
  validateRecoveryContextBinding,
} from './integration-recovery-context.js';
import {
  confirmedRestorationPaths,
  parseLocalIntegrationRestoration,
  restorationKey,
  type LocalIntegrationRestoration,
} from './integration-restoration-record.js';
import { terminalLabel } from './terminal-label.js';
interface LocalRestorationRecovery {
  version: 1;
  kind: 'integration_restoration_settlement';
  recoveryId: string;
  original: LocalIntegrationRestoration;
  phase: 'release_prepared' | 'released';
  releaseRequest: WorkspaceReleaseRequest;
  releaseReceipt: WorkspaceReleaseReceipt | null;
  report: IntegrationFileRestorationRecoveryReport | null;
  acknowledged: IntegrationFileRestorationRecoveryReceipt | null;
}
const invalid = () =>
  new DomainError(
    'INTEGRATION_RECOVERY_INVALID',
    '文件恢复结算证据或释放回执不一致；保留全部记录与材料',
  );
const exact = (value: unknown, keys: string[]) => {
  const body = contractExact(value, keys);
  if (Object.keys(body).length !== keys.length) throw invalid();
  return body;
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const withoutAcknowledgement = (r: LocalIntegrationRestoration) => {
  const { pending: _pending, acknowledged: _ack, ...e } = r;
  return e;
};
function reportFor(
  original: LocalApplication,
  r: LocalRestorationRecovery,
  receipt: WorkspaceReleaseReceipt,
) {
  const o = r.original,
    context = validateRecoveryContextBinding(original);
  return parseIntegrationFileRestorationRecoveryReport({
    version: 1,
    kind: 'local_integration_restoration_settlement',
    integrationId: o.request.integrationId,
    applicationId: o.request.applicationId,
    restorationId: o.request.id,
    recoveryId: r.recoveryId,
    integrationInputHash: context.integrationInputHash,
    applicationInputHash: o.request.applicationInputHash,
    restorationInputHash: o.request.inputHash,
    originalApplicationEvidenceHash: o.originalApplicationEvidenceHash,
    restorationEvidenceHash: hash(o),
    pendingReportHash: o.pending ? hash(o.pending) : null,
    stoppedConfirmedAt: r.releaseRequest.stoppedConfirmedAt,
    releasedAt: receipt.releasedAt,
    disposition: 'preserve_files',
    processEvidence: 'operator_confirmed_stopped',
    lease: 'released',
    filesVerified: false,
    recordedRestoredCount: confirmedRestorationPaths(o).length,
    unresolvedWriteIntent:
      o.intent !== null || o.existingChanges.directoryIntent || o.existingChanges.intent !== null,
    confirmPublication: true,
  });
}
function acknowledgement(value: unknown, p: IntegrationFileRestorationRecoveryReport) {
  const a = exact(value, [
    'integrationId',
    'applicationId',
    'restorationId',
    'recoveryId',
    'hash',
    'receivedAt',
  ]) as unknown as IntegrationFileRestorationRecoveryReceipt;
  if (
    a.integrationId !== p.integrationId ||
    a.applicationId !== p.applicationId ||
    a.restorationId !== p.restorationId ||
    a.recoveryId !== p.recoveryId ||
    a.hash !== hash(p)
  )
    throw invalid();
  retentionDate(a.receivedAt);
  return a;
}
function parse(
  body: unknown,
  original: LocalApplication,
  current: LocalIntegrationRestoration,
): LocalRestorationRecovery {
  try {
    if (typeof body !== 'string' || Buffer.byteLength(body) > 1048576) throw invalid();
    const r = exact(JSON.parse(body), [
      'version',
      'kind',
      'recoveryId',
      'original',
      'phase',
      'releaseRequest',
      'releaseReceipt',
      'report',
      'acknowledged',
    ]) as unknown as LocalRestorationRecovery;
    const o = parseLocalIntegrationRestoration(
        JSON.stringify(r.original),
        restorationKey(current.request.id),
        original,
      ),
      context = validateRecoveryContextBinding(original);
    if (
      r.version !== 1 ||
      r.kind !== 'integration_restoration_settlement' ||
      !['prepared', 'restoring', 'needs_attention'].includes(o.phase) ||
      !same(withoutAcknowledgement(o), withoutAcknowledgement(current)) ||
      !(
        (same(o.pending, current.pending) && o.acknowledged === current.acknowledged) ||
        (o.pending !== null &&
          current.pending === null &&
          current.acknowledged === o.pending.sequence)
      )
    )
      throw invalid();
    nodeId(r.recoveryId);
    const expected: WorkspaceReleaseRequest = {
      version: 1,
      recoveryId: r.recoveryId,
      claimId: `integration:${o.request.id}`,
      root: context.root,
      identity: context.rootIdentity,
      gitIdentity: context.gitIdentity,
      evidenceHash: hash(o),
      stoppedConfirmedAt: retentionDate(r.releaseRequest.stoppedConfirmedAt),
    };
    if (!same(r.releaseRequest, expected)) throw invalid();
    if (r.phase === 'release_prepared') {
      if (r.releaseReceipt !== null || r.report !== null || r.acknowledged !== null)
        throw invalid();
    } else if (r.phase === 'released') {
      if (
        !r.releaseReceipt ||
        !same(r.releaseReceipt, {
          ...expected,
          releasedAt: retentionDate(r.releaseReceipt.releasedAt),
        })
      )
        throw invalid();
      const p = reportFor(original, r, r.releaseReceipt);
      if (!same(r.report, p)) throw invalid();
      if (r.acknowledged) acknowledgement(r.acknowledged, p);
    } else throw invalid();
    return r;
  } catch {
    throw invalid();
  }
}
export function readRestorationRecovery(
  db: DatabaseSync,
  original: LocalApplication,
  r: LocalIntegrationRestoration,
) {
  const schema = db
    .prepare("SELECT type FROM sqlite_schema WHERE name='integration_restoration_recoveries'")
    .get();
  if (!schema) return null;
  if (schema.type !== 'table') throw invalid();
  const row = db
    .prepare('SELECT body FROM integration_restoration_recoveries WHERE restoration_id=?')
    .get(r.request.id);
  return row ? parse(row.body, original, r) : null;
}
function save(
  db: DatabaseSync,
  original: LocalApplication,
  current: LocalIntegrationRestoration,
  r: LocalRestorationRecovery,
) {
  parse(JSON.stringify(r), original, current);
  db.exec(
    'CREATE TABLE IF NOT EXISTS integration_restoration_recoveries(restoration_id TEXT PRIMARY KEY,body TEXT NOT NULL)',
  );
  const previous = readRestorationRecovery(db, original, current);
  if (
    previous &&
    (!same(previous.original, r.original) ||
      !same(previous.releaseRequest, r.releaseRequest) ||
      (previous.phase === 'released' &&
        (!same(previous.report, r.report) || !same(previous.releaseReceipt, r.releaseReceipt))) ||
      (previous.acknowledged && !same(previous, r)))
  )
    throw invalid();
  db.prepare(
    'INSERT INTO integration_restoration_recoveries VALUES(?,?) ON CONFLICT(restoration_id) DO UPDATE SET body=excluded.body',
  ).run(current.request.id, JSON.stringify(r));
}
export function hasSettledRestorationRecovery(
  db: DatabaseSync,
  original: LocalApplication,
  r: LocalIntegrationRestoration,
) {
  const recovery = readRestorationRecovery(db, original, r);
  if (!recovery || recovery.phase !== 'released' || !recovery.acknowledged || r.pending)
    return false;
  if (!same(workspaceReleaseReceipt(recovery.releaseRequest), recovery.releaseReceipt))
    throw invalid();
  return true;
}
/** A subject variant of the existing STOPPED preserve-only settlement. It uses
 * the same atomic lease receipt; neither original nor restoration file history
 * is rewritten, and no files/helpers/Git are read or run. */
export async function recoverIntegrationRestoration(
  home: string,
  integrationId: string,
  restorationId: string,
  ask: (p: string) => Promise<string>,
  log: (s: string) => void = console.log,
) {
  nodeId(integrationId);
  nodeId(restorationId);
  home = resolve(home);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '本机结算仅支持Linux');
  const paths = [
      home,
      join(home, 'integration-application'),
      join(home, 'integration-application', 'journal.sqlite'),
      join(home, 'credentials.json'),
    ],
    identities = paths.map((p, i) => restorePrivatePath(p, i < 2)),
    c = readCredentials(home),
    binding = restoreBinding(c),
    key = restorationKey(restorationId);
  const inside = (a: string, b: string) => {
    const r = relative(a, b);
    return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
  };
  if (
    !c.nodeId ||
    c.directories.flatMap((w) => [w.root, w.gitDir]).some((p) => inside(home, p) || inside(p, home))
  )
    throw invalid();
  const db = new AgentStorage(paths[1]!);
  try {
    const originalBody = db.db
        .prepare('SELECT body FROM applications WHERE id=?')
        .get(integrationId)?.body,
      original = parseLocalApplicationRecord(originalBody, integrationId),
      context = validateRecoveryContextBinding(original, c),
      body = db.db.prepare('SELECT body FROM applications WHERE id=?').get(key)?.body,
      r = parseLocalIntegrationRestoration(body, key, original);
    const bound = () => {
      if (
        paths.some((p, i) => restorePrivatePath(p, i < 2) !== identities[i]) ||
        restoreBinding(readCredentials(home)) !== binding ||
        db.db.prepare('SELECT body FROM applications WHERE id=?').get(integrationId)?.body !==
          originalBody ||
        db.db.prepare('SELECT body FROM applications WHERE id=?').get(key)?.body !== body
      )
        throw invalid();
    };
    bound();
    let recovery = readRestorationRecovery(db.db, original, r);
    if (!recovery) {
      if (!['prepared', 'restoring', 'needs_attention'].includes(r.phase))
        throw new DomainError(
          'INTEGRATION_RECOVERY_UNAVAILABLE',
          '仅能结算准备中、恢复中或待核对的恢复尝试',
        );
      log(
        `恢复 ${restorationId} · 原应用 ${original.applicationId}\n原目录 ${terminalLabel(context.root)}\n本次保留目录 ${terminalLabel(r.existingChanges.backup.path)}\n保留所有当前文件、原备份、新保留目录、HEAD和索引；只释放此次恢复的占用，不核验文件或宣称已恢复。确认同时共享停止与释放观察，未确认报告单独对账。`,
      );
      if (
        (await ask(
          `确认恢复进程 ${restorationId} 及所有 integration-add / integration-change / restore-publish 子进程/孤儿进程均已停止。输入 STOPPED ${restorationId}：`,
        )) !== `STOPPED ${restorationId}`
      )
        throw new DomainError(
          'CONFIRMATION_REQUIRED',
          '未明确确认恢复进程及所有子进程停止；保留原写锁',
        );
      bound();
      const recoveryId = randomUUID();
      recovery = {
        version: 1,
        kind: 'integration_restoration_settlement',
        recoveryId,
        original: structuredClone(r),
        phase: 'release_prepared',
        releaseRequest: {
          version: 1,
          recoveryId,
          claimId: `integration:${restorationId}`,
          root: context.root,
          identity: context.rootIdentity,
          gitIdentity: context.gitIdentity,
          evidenceHash: hash(r),
          stoppedConfirmedAt: new Date().toISOString(),
        },
        releaseReceipt: null,
        report: null,
        acknowledged: null,
      };
      save(db.db, original, r, recovery);
    }
    bound();
    const receipt =
      workspaceReleaseReceipt(recovery.releaseRequest) ??
      releaseWorkspaceClaim(recovery.releaseRequest);
    if (recovery.phase === 'release_prepared') {
      recovery.phase = 'released';
      recovery.releaseReceipt = receipt;
      recovery.report = reportFor(original, recovery, receipt);
      bound();
      save(db.db, original, r, recovery);
    } else if (!same(receipt, recovery.releaseReceipt)) throw invalid();
    let publicationError: string | null = null;
    if (!recovery.acknowledged) {
      try {
        const ack = await nodeRequest(
          c.controlUrl,
          'integration-restoration-recovery-publish',
          recovery.report,
          c.nodeToken,
        );
        bound();
        recovery.acknowledged = acknowledgement(ack, recovery.report!);
        save(db.db, original, r, recovery);
      } catch (e) {
        publicationError = e instanceof DomainError ? e.code : 'PUBLICATION_UNCONFIRMED';
        log('恢复占用已本机释放，全部文件和原记录保留；任务结算观察尚未确认，只重发原包。');
      }
    }
    return {
      integrationId,
      applicationId: original.applicationId,
      restorationId,
      recoveryId: recovery.recoveryId,
      state: 'released' as const,
      disposition: 'preserve_files' as const,
      filesVerified: false as const,
      publication: recovery.acknowledged ? ('acknowledged' as const) : ('pending' as const),
      publicationError,
      originalRestorationPhase: r.phase,
      originalPendingReportSequence: r.pending?.sequence ?? null,
    };
  } finally {
    db.close();
  }
}
