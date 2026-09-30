import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { branchResultFixture } from './branch-results.js';
import { codeSnapshot, recordResultCode, saveResultCode } from './result-code.js';
import { CheckpointRetentionStore } from '../../packages/db/src/checkpoint-retention.js';
import type { IntegrationView } from '../../packages/contracts/src/integrations.js';
import { buildIntegrationPlan } from '../../apps/runner/src/agent/integration-plan.js';

/** Protocol metadata + verified pure object graphs, never advertised as node filesystem evidence. */
export async function integrationFixture(
  origin?: string,
  format: 'sha1' | 'sha256' = 'sha1',
  options: { targetText?: string; targetDeleted?: boolean } = {},
) {
  const base = await codeSnapshot([{ name: 'README.md', text: 'BASE' }], format);
  const source = await codeSnapshot(
    [
      { name: 'README.md', text: 'SOURCE_SECRET_BODY' },
      { name: 'new.txt', text: 'NEW_BODY' },
    ],
    format,
  );
  const target = await codeSnapshot(
    [
      ...(options.targetDeleted ? [] : [{ name: 'README.md', text: options.targetText ?? 'BASE' }]),
      { name: 'target.txt', text: 'TARGET_ONLY' },
    ],
    format,
  );
  const f = await branchResultFixture(origin, base);
  try {
    const run = f.begin();
    run.start();
    run.finish();
    const sourceCp = await recordResultCode(f, source),
      targetCp = await recordResultCode(f, target);
    const saved = await saveResultCode(f, sourceCp.checkpointId),
      retained = new CheckpointRetentionStore(f.api.store);
    const retain = (checkpointId: string, snapshot: typeof base, index = 0) => {
      const r = f.as(() =>
        retained.create(
          f.task.id,
          checkpointId,
          {
            days: 7,
            expectedTaskRevision: f.api.store.getTask(f.task.id).revision,
            confirmLocalRetention: true,
          },
          randomUUID(),
        ),
      );
      const at = new Date().toISOString();
      retained.report(f.ns[index]!.token, {
        requestId: r.request.id,
        requestHash: r.request.requestHash,
        sequence: 1,
        confirmPublication: true,
        report: {
          state: 'retained',
          observedAt: at,
          manifest: {
            version: 1,
            kind: 'git_snapshot_objects',
            objectFormat: format,
            commit: snapshot.commit,
            tree: snapshot.tree,
            repositoryIdentity: 'c'.repeat(64),
            snapshotHash: snapshot.snapshotHash,
            coverage: snapshot.coverage,
            scope: 'commit_snapshot_without_ancestors_or_external_content',
            retainedAt: at,
            expiresAt: new Date(Date.parse(at) + 7 * 86400000).toISOString(),
          },
        },
      });
      return f.as(() => retained.get(f.task.id, checkpointId, r.request.id));
    };
    const sr = retain(sourceCp.checkpointId, source),
      tr = retain(targetCp.checkpointId, target);
    const body = () => ({
      resultId: saved.resultId,
      resultRevisionId: saved.revisionId,
      targetCheckpointId: targetCp.checkpointId,
      targetRetentionId: tr.request.id,
      sourceMaterial: { kind: 'retention', id: sr.request.id },
      expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id).revision),
      confirmPreflight: true,
    });
    const path = `tasks/${f.task.id}/integrations`;
    const create = async () => {
      const r = await f.api.call(path, f.alice, body());
      assert.equal(r.statusCode, 201, r.body);
      return r.json() as IntegrationView;
    };
    const report = (view: IntegrationView) => ({
      integrationId: view.operation.id,
      inputHash: view.operation.inputHash,
      observedAt: new Date().toISOString(),
      plan: buildIntegrationPlan(
        format,
        { base: base.tree, source: source.tree, target: target.tree },
        { base, source, target },
        '/fixture-repo',
      ),
      reason: null,
      confirmPublication: true,
    });
    const protocol = (endpoint: string, body: unknown, index = 0) =>
      f.api.app.inject({
        method: 'POST',
        url: '/runner/v1/integration-' + endpoint,
        headers: { 'x-hexu-runner': '1', authorization: `Bearer ${f.ns[index]!.token}` },
        payload: body as Record<string, unknown>,
      });
    return {
      ...f,
      base,
      source,
      target,
      sourceCp,
      targetCp,
      saved,
      sr,
      tr,
      retain,
      retained,
      body,
      integrationPath: path,
      create,
      report,
      protocol,
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
