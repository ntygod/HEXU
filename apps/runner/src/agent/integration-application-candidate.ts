import { closeSync, fstatSync } from 'node:fs';
import { basename } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import type { IntegrationOperation } from '../../../../packages/contracts/src/integrations.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { identity, PinnedRestoreParent, checkOwnedTree } from './checkpoint-restore-files.js';
import {
  IntegrationTrialJournal,
  trialHash,
  type IntegrationTrialRecord,
} from './integration-trial-journal.js';
import type { IntegrationTrialPlan } from './integration-trial-plan.js';
import { verifyTrialFiles } from './integration-trial.js';

const changed = () =>
  new DomainError(
    'INTEGRATION_CANDIDATE_CHANGED',
    '固定候选差异、本机所有权或字节已变化；不能写回，保留原材料',
  );

/** Hold the existing trial guard and original ancestry for the entire new
 * application. This never replaces/rebuilds the candidate or reads display diff
 * as file bytes. Legacy ADD-only applications do not enter this class. */
export class IntegrationApplicationCandidate {
  readonly journal: IntegrationTrialJournal;
  readonly record: IntegrationTrialRecord;
  private parent: PinnedRestoreParent | undefined;
  private fd: number | undefined;
  constructor(home: string, binding: string, operation: IntegrationOperation) {
    this.journal = new IntegrationTrialJournal(home);
    try {
      const application = operation.application,
        candidate = application?.candidate;
      if (!application || !candidate) throw changed();
      const record = this.journal.byId(candidate.trialId),
        p = record?.progress;
      if (
        !record ||
        !p ||
        record.binding !== binding ||
        p.integrationId !== operation.id ||
        p.state !== 'ready' ||
        p.materialState !== 'published' ||
        !p.stageIdentity ||
        p.inputHash !== operation.inputHash ||
        p.reportHash !== application.reportHash ||
        p.manifestHash !== candidate.manifestHash ||
        canonicalJson([...p.selectedPaths].sort()) !== canonicalJson(application.paths)
      )
        throw changed();
      const difference = this.journal.difference(record);
      if (
        !difference ||
        difference.state !== 'shared' ||
        !difference.receipt ||
        difference.hash !== candidate.reportHash ||
        difference.report.manifestHash !== candidate.manifestHash
      )
        throw changed();
      this.record = record;
      this.parent = new PinnedRestoreParent(record.observation);
      this.fd = this.parent.openStage(basename(p.target), p.stageIdentity);
    } catch (cause) {
      this.close();
      throw cause;
    }
  }
  verify(plan: IntegrationTrialPlan) {
    if (!this.parent || this.fd === undefined) throw changed();
    const p = this.record.progress;
    this.journal.stillBound();
    if (
      plan.manifestHash !== p.manifestHash ||
      trialHash(plan.manifest) !== p.manifestHash ||
      canonicalJson(plan.manifest) !== canonicalJson(this.record.manifest)
    )
      throw changed();
    this.parent.revalidate();
    if (identity(fstatSync(this.fd, { bigint: true })) !== p.stageIdentity) throw changed();
    const named = this.parent.openStage(basename(p.target), p.stageIdentity!);
    closeSync(named);
    verifyTrialFiles(this.fd, plan, this.journal, this.record, false);
    this.parent.revalidate();
  }
  revalidate() {
    if (!this.parent || this.fd === undefined) throw changed();
    this.parent.revalidate();
    const named = this.parent.openStage(
      basename(this.record.progress.target),
      this.record.progress.stageIdentity!,
    );
    closeSync(named);
    checkOwnedTree(this.fd, this.journal.entries(this.record.progress.id));
  }
  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    this.parent?.close();
    this.parent = undefined;
    this.journal.close();
  }
}
