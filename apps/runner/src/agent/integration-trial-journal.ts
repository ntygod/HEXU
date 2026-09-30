import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { AgentStorage } from './storage.js';
import { restorePrivatePath } from './checkpoint-restore-preflight.js';
import type { RestoreTargetObservation } from './checkpoint-restore-plan.js';
import type { OwnedRestoreEntry } from './checkpoint-restore-files.js';
import type { IntegrationTrialManifest } from './integration-trial-plan.js';

export const trialHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
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
}
export interface IntegrationTrialRecord {
  version: 1;
  binding: string;
  observation: RestoreTargetObservation;
  manifest: IntegrationTrialManifest;
  progress: IntegrationTrialProgress;
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
    r.version !== 1 ||
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
  return r;
}

/** Separate local process guard and durable, private evidence. There is no
 * metadata publication, automatic resumption, rollback or cleanup operation. */
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
        CREATE TABLE IF NOT EXISTS trial_entries(attempt_id TEXT NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(attempt_id,path));`);
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
      version: 1,
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
    const rows = journal.storage.db.prepare('SELECT target FROM trials').all() as {
      target: string;
    }[];
    for (const { target } of rows) {
      const record = journal.row(target)!;
      const p = record.progress;
      const settled =
        p.state === 'ready' ||
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
