import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { exact, nodeId } from '../../../../packages/contracts/src/nodes.js';
import { retentionDate } from '../../../../packages/contracts/src/checkpoint-retention.js';
import {
  parseIntegrationTrialDifference,
  type IntegrationTrialDifferenceReport,
  type IntegrationTrialDifferenceReceipt,
} from '../../../../packages/contracts/src/integration-trial.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { AgentStorage } from './storage.js';
import { restorePrivatePath } from './checkpoint-restore-preflight.js';
import type { RestoreTargetObservation } from './checkpoint-restore-plan.js';
import type { OwnedRestoreEntry } from './checkpoint-restore-files.js';
import type { IntegrationTrialManifest } from './integration-trial-plan.js';

import { parseIntegrationConflictSelection } from '../../../../packages/contracts/src/integration-conflict-selection.js';

export const trialHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export interface IntegrationTrialCleanup {
  version: 1;
  kind: 'discard_known_unpublished_trial_stage';
  phase: 'cleaning' | 'cleaned' | 'needs_attention';
  originalEvidenceHash: string;
  stoppedConfirmedAt: string;
  completedAt: string | null;
}
export interface IntegrationTrialProgress {
  id: string;
  integrationId: string;
  target: string;
  selectedPaths: string[];
  inputHash: string;
  reportHash: string;
  manifestHash: string;
  state: 'preparing' | 'writing' | 'verified' | 'publishing' | 'ready' | 'failed' | 'interrupted';
  materialState: 'none' | 'staging' | 'published' | 'unknown';
  stageName: string;
  stageIdentity: string | null;
  intent: string | null;
  completedFiles: number;
  writtenBytes: number;
  totalFiles: number;
  totalBytes: number;
  errorCode: string | null;
  verifiedAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  trialOnly: true;
  applied: false;
  writeAuthorized: false;
  cleanup?: IntegrationTrialCleanup;
}
export interface IntegrationTrialRecord {
  version: 1 | 2;
  binding: string;
  observation: RestoreTargetObservation;
  manifest: IntegrationTrialManifest;
  progress: IntegrationTrialProgress;
}
export interface LocalIntegrationTrialDifference {
  report: IntegrationTrialDifferenceReport;
  hash: string;
  state: 'frozen' | 'pending' | 'shared';
  receipt: IntegrationTrialDifferenceReceipt | null;
}
const invalid = () =>
  new DomainError(
    'INTEGRATION_TRIAL_JOURNAL_INVALID',
    '试应用记录不一致；保留现场，不推断发布或重写',
  );
function decode(body: string, target: string): IntegrationTrialRecord {
  const r = JSON.parse(body) as IntegrationTrialRecord,
    p = r?.progress;
  if (!p) throw invalid();
  nodeId(p.id);
  nodeId(p.integrationId);
  if (
    ![1, 2].includes(r.version) ||
    r.version !== r.manifest?.version ||
    (r.version === 1
      ? r.manifest.selection !== 'apply_source' || Object.hasOwn(r.manifest, 'conflictChoices')
      : r.manifest.selection !== 'explicit_conflict_choices') ||
    p.target !== target ||
    r.observation.path !== target ||
    p.stageName !== `.hexu-restore-${p.id}` ||
    p.manifestHash !== trialHash(r.manifest) ||
    canonicalJson(p.selectedPaths) !== canonicalJson(r.manifest.selectedPaths) ||
    p.trialOnly !== true ||
    p.applied !== false ||
    p.writeAuthorized !== false ||
    !['preparing', 'writing', 'verified', 'publishing', 'ready', 'failed', 'interrupted'].includes(
      p.state,
    ) ||
    !['none', 'staging', 'published', 'unknown'].includes(p.materialState) ||
    !Number.isSafeInteger(p.completedFiles) ||
    p.completedFiles < 0 ||
    p.completedFiles > p.totalFiles ||
    !Number.isSafeInteger(p.writtenBytes) ||
    p.writtenBytes < 0 ||
    p.writtenBytes > p.totalBytes ||
    p.totalBytes !== r.manifest.materializedBytes ||
    p.totalFiles !== r.manifest.entries.filter((e) => e.kind === 'file').length ||
    (p.state === 'ready' &&
      (!p.publishedAt ||
        !p.verifiedAt ||
        p.materialState !== 'published' ||
        !p.stageIdentity ||
        p.intent !== null ||
        p.completedFiles !== p.totalFiles ||
        p.writtenBytes !== p.totalBytes))
  )
    throw invalid();
  if (r.version === 2) {
    const decision = parseIntegrationConflictSelection({
      version: 2,
      kind: 'explicit_conflict_choices',
      selectedPaths: p.selectedPaths,
      conflictChoices: r.manifest.conflictChoices,
    });
    if (canonicalJson(decision.conflictChoices) !== canonicalJson(r.manifest.conflictChoices))
      throw invalid();
  }
  if (p.cleanup) {
    const c = exact(p.cleanup, [
      'version',
      'kind',
      'phase',
      'originalEvidenceHash',
      'stoppedConfirmedAt',
      'completedAt',
    ]);
    if (
      c.version !== 1 ||
      c.kind !== 'discard_known_unpublished_trial_stage' ||
      !['cleaning', 'cleaned', 'needs_attention'].includes(String(c.phase)) ||
      c.originalEvidenceHash !== integrationTrialCleanupEvidence(r) ||
      !['failed', 'interrupted'].includes(p.state) ||
      p.materialState !== 'staging' ||
      !p.stageIdentity ||
      p.intent !== null ||
      p.publishedAt !== null ||
      (c.phase === 'cleaned') !== (c.completedAt !== null)
    )
      throw invalid();
    retentionDate(c.stoppedConfirmedAt);
    if (c.completedAt !== null) retentionDate(c.completedAt);
  }
  return r;
}
/** Original historical state and ownership are never rewritten as cleanup success. */
export function integrationTrialCleanupEvidence(record: IntegrationTrialRecord) {
  const { cleanup: _cleanup, updatedAt: _updatedAt, ...progress } = record.progress;
  return trialHash({ ...record, progress });
}

/** Separate local process guard and durable, private evidence. There is no
 * automatic resumption, rollback or cleanup operation. Difference sharing uses
 * this same guard; frozen local reports do not imply permission to publish. */
export class IntegrationTrialJournal {
  readonly storage: AgentStorage;
  private readonly identities: string[];
  private readonly paths: string[];
  constructor(home: string) {
    this.storage = new AgentStorage(join(home, 'integration-trials'));
    this.paths = [this.storage.home, join(this.storage.home, 'journal.sqlite')];
    try {
      this.identities = this.paths.map((p, i) => restorePrivatePath(p, i === 0));
      this.storage.db
        .exec(`CREATE TABLE IF NOT EXISTS trials(target TEXT PRIMARY KEY, context TEXT NOT NULL, progress TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS trial_entries(attempt_id TEXT NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(attempt_id,path));
        CREATE TABLE IF NOT EXISTS trial_differences(trial_id TEXT PRIMARY KEY,binding TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT);`);
    } catch (cause) {
      this.storage.close();
      throw cause;
    }
  }
  stillBound() {
    if (this.paths.some((p, i) => restorePrivatePath(p, i === 0) !== this.identities[i]))
      throw invalid();
  }
  row(target: string): IntegrationTrialRecord | undefined {
    this.stillBound();
    const row = this.storage.db
      .prepare('SELECT context,progress FROM trials WHERE target=?')
      .get(target) as { context: string; progress: string } | undefined;
    return (
      row &&
      decode(
        JSON.stringify({ ...JSON.parse(row.context), progress: JSON.parse(row.progress) }),
        target,
      )
    );
  }
  byId(id: string): IntegrationTrialRecord | undefined {
    this.stillBound();
    nodeId(id);
    const rows = this.storage.db.prepare('SELECT target FROM trials').all() as { target: string }[];
    let result: IntegrationTrialRecord | undefined;
    for (const row of rows) {
      const record = this.row(row.target)!;
      if (record.progress.id !== id) continue;
      if (result) throw invalid();
      result = record;
    }
    return result;
  }
  difference(record: IntegrationTrialRecord): LocalIntegrationTrialDifference | undefined {
    this.stillBound();
    const row = this.storage.db
      .prepare('SELECT * FROM trial_differences WHERE trial_id=?')
      .get(record.progress.id) as
      | { binding: string; body: string; hash: string; state: string; receipt: string | null }
      | undefined;
    if (!row) return;
    const report = parseIntegrationTrialDifference(JSON.parse(row.body));
    const p = record.progress;
    if (
      row.binding !== record.binding ||
      report.trialId !== p.id ||
      report.integrationId !== p.integrationId ||
      report.integrationInputHash !== p.inputHash ||
      report.preflightReportHash !== p.reportHash ||
      report.manifestHash !== p.manifestHash ||
      report.materializedAt !== p.publishedAt ||
      report.version !== record.version ||
      report.selection !== record.manifest.selection ||
      canonicalJson(report.conflictChoices ?? null) !==
        canonicalJson(record.manifest.conflictChoices ?? null) ||
      canonicalJson(report.selectedPaths) !== canonicalJson(p.selectedPaths) ||
      row.hash !== trialHash(report) ||
      !['frozen', 'pending', 'shared'].includes(row.state) ||
      (row.state === 'shared') !== (row.receipt !== null)
    )
      throw invalid();
    const receipt =
      row.receipt === null ? null : this.checkedReceipt(report, JSON.parse(row.receipt));
    return {
      report,
      hash: row.hash,
      state: row.state as LocalIntegrationTrialDifference['state'],
      receipt,
    };
  }
  /** Freeze the verified report locally, without authorizing publication. */
  freezeDifference(record: IntegrationTrialRecord, value: IntegrationTrialDifferenceReport) {
    this.stillBound();
    const report = parseIntegrationTrialDifference(value);
    const prior = this.difference(record);
    if (prior) {
      if (prior.hash !== trialHash(report)) throw invalid();
      return prior;
    }
    this.storage.db
      .prepare('INSERT INTO trial_differences VALUES(?,?,?,?,?,NULL)')
      .run(record.progress.id, record.binding, JSON.stringify(report), trialHash(report), 'frozen');
    return this.difference(record)!;
  }
  /** Called only after the separate SHARE_TRIAL_DIFF confirmation and revalidation. */
  authorizeDifference(record: IntegrationTrialRecord, expectedHash: string) {
    const value = this.difference(record);
    if (!value || value.hash !== expectedHash) throw invalid();
    if (value.state === 'frozen')
      this.storage.db
        .prepare("UPDATE trial_differences SET state='pending' WHERE trial_id=? AND state='frozen'")
        .run(record.progress.id);
    return this.difference(record)!;
  }
  private checkedReceipt(
    report: IntegrationTrialDifferenceReport,
    input: unknown,
  ): IntegrationTrialDifferenceReceipt {
    const r = exact(input, ['integrationId', 'trialId', 'hash', 'receivedAt']);
    if (
      r.integrationId !== report.integrationId ||
      r.trialId !== report.trialId ||
      r.hash !== trialHash(report)
    )
      throw invalid();
    return {
      integrationId: report.integrationId,
      trialId: report.trialId,
      hash: r.hash as string,
      receivedAt: retentionDate(r.receivedAt),
    };
  }
  acknowledgeDifference(record: IntegrationTrialRecord, input: unknown) {
    const value = this.difference(record);
    if (!value || value.state === 'frozen') throw invalid();
    const receipt = this.checkedReceipt(value.report, input);
    if (value.receipt && canonicalJson(value.receipt) !== canonicalJson(receipt)) throw invalid();
    this.storage.db
      .prepare("UPDATE trial_differences SET state='shared',receipt=? WHERE trial_id=?")
      .run(JSON.stringify(receipt), record.progress.id);
    return receipt;
  }
  hasPendingDifferences() {
    this.stillBound();
    // Unknown/corrupt states also keep credentials; only explicit frozen/shared settle.
    return !!this.storage.db
      .prepare(
        "SELECT 1 FROM trial_differences WHERE state NOT IN ('frozen','shared') OR (state='shared' AND receipt IS NULL)",
      )
      .get();
  }
  begin(
    input: Omit<IntegrationTrialRecord, 'version' | 'progress'> & {
      integrationId: string;
      inputHash: string;
      reportHash: string;
    },
  ): IntegrationTrialRecord {
    this.stillBound();
    const count = this.storage.db.prepare('SELECT COUNT(*) AS n FROM trials').get() as {
      n: number;
    };
    if (count.n >= 1000) throw new DomainError('INTEGRATION_TRIAL_LIMIT', '本机试应用记录已达上限');
    const id = randomUUID();
    const record: IntegrationTrialRecord = {
      version: input.manifest.version,
      binding: input.binding,
      observation: input.observation,
      manifest: input.manifest,
      progress: {
        id,
        integrationId: input.integrationId,
        inputHash: input.inputHash,
        reportHash: input.reportHash,
        target: input.observation.path,
        selectedPaths: input.manifest.selectedPaths,
        manifestHash: trialHash(input.manifest),
        state: 'preparing',
        materialState: 'none',
        stageName: `.hexu-restore-${id}`,
        stageIdentity: null,
        intent: null,
        completedFiles: 0,
        writtenBytes: 0,
        totalFiles: input.manifest.entries.filter((e) => e.kind === 'file').length,
        totalBytes: input.manifest.materializedBytes,
        errorCode: null,
        verifiedAt: null,
        publishedAt: null,
        updatedAt: new Date().toISOString(),
        trialOnly: true,
        applied: false,
        writeAuthorized: false,
      },
    };
    this.storage.db.prepare('INSERT INTO trials VALUES(?,?,?)').run(
      record.progress.target,
      JSON.stringify({
        version: record.version,
        binding: record.binding,
        observation: record.observation,
        manifest: record.manifest,
      }),
      JSON.stringify(record.progress),
    );
    return record;
  }
  save(record: IntegrationTrialRecord) {
    this.stillBound();
    record.progress.updatedAt = new Date().toISOString();
    this.storage.db
      .prepare('UPDATE trials SET progress=? WHERE target=?')
      .run(JSON.stringify(record.progress), record.progress.target);
  }
  track(id: string, entry: OwnedRestoreEntry) {
    this.stillBound();
    this.storage.db
      .prepare(
        'INSERT INTO trial_entries VALUES(?,?,?) ON CONFLICT(attempt_id,path) DO UPDATE SET body=excluded.body',
      )
      .run(id, entry.path, JSON.stringify(entry));
  }
  entries(id: string) {
    this.stillBound();
    const rows = this.storage.db
      .prepare('SELECT path,body FROM trial_entries WHERE attempt_id=?')
      .all(id) as { path: string; body: string }[];
    return new Map(
      rows.map((row) => {
        const entry = JSON.parse(row.body) as OwnedRestoreEntry;
        if (entry.path !== row.path) throw invalid();
        return [entry.path, entry];
      }),
    );
  }
  close() {
    this.storage.close();
  }
}

/** Hold the same trial process guard across credential replacement/deletion,
 * including network waits. Old settled history needs no live credentials. */
export async function withSettledIntegrationTrials<T>(
  home: string,
  action: () => Promise<T>,
): Promise<T> {
  const journal = new IntegrationTrialJournal(home);
  try {
    if (journal.hasPendingDifferences())
      throw new DomainError(
        'INTEGRATION_TRIAL_DIFFERENCE_PENDING',
        '候选差异共享回执待确认；保留原节点凭证与固定待发包，不自动清理',
      );
    const rows = journal.storage.db.prepare('SELECT target FROM trials').all() as {
      target: string;
    }[];
    for (const { target } of rows) {
      const record = journal.row(target)!;
      const p = record.progress;
      const settled =
        p.state === 'ready' ||
        p.cleanup?.phase === 'cleaned' ||
        (['failed', 'interrupted'].includes(p.state) &&
          p.materialState === 'none' &&
          p.stageIdentity === null &&
          p.intent === null &&
          p.completedFiles === 0 &&
          p.writtenBytes === 0);
      if (!settled)
        throw new DomainError(
          'INTEGRATION_TRIAL_UNSETTLED',
          '本机试应用仍有暂存、未知现场或未完成写入；保留原节点凭证与日志，不自动清理',
        );
    }
    return await action();
  } finally {
    journal.close();
  }
}
