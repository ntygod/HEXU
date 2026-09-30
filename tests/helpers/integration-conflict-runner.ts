import assert from 'node:assert/strict';
import { join } from 'node:path';
import { integrationRunnerFixture } from './integration-runner.js';
import { preflightIntegration } from '../../apps/runner/src/agent/integration-preflight.js';
import { localIntegrationTrial } from '../../apps/runner/src/agent/integration-trial.js';
import { shareIntegrationTrialDifference } from '../../apps/runner/src/agent/integration-trial-difference.js';
import { WorkspaceLease } from '../../apps/runner/src/workspace-lease.js';
import type { IntegrationConflictSelection } from '../../packages/contracts/src/integration-conflict-selection.js';
export const silentConflict = () => {};
export async function preparedConflictApplication(onRequest?: (url: string) => Promise<void>) {
  const f = await integrationRunnerFixture(
    'sha256',
    true,
    true,
    {},
    {
      baseFiles: { 'delete.txt': 'BASE DELETE\n' },
      sourceDeletePaths: ['delete.txt'],
      targetFiles: { 'delete.txt': 'USER TARGET DELETE\n' },
      beforeListen: (app) => {
        if (!onRequest) return;
        const listeners = app.server.listeners('request');
        for (const listener of listeners) app.server.removeListener('request', listener as never);
        app.server.on('request', (request, response) => {
          void onRequest(request.url ?? '')
            .then(() => {
              for (const listener of listeners) listener.call(app.server, request, response);
            })
            .catch(() => {
              response.statusCode = 500;
              response.end('fixture barrier failed');
            });
        });
      },
    },
  );
  try {
    const id = await f.create();
    await preflightIntegration(f.target.home, id, f.ask(id), silentConflict);
    const selection: IntegrationConflictSelection = {
        version: 2,
        kind: 'explicit_conflict_choices',
        selectedPaths: ['README.md', 'delete.txt'],
        conflictChoices: [
          { path: 'README.md', choice: 'take_source' },
          { path: 'delete.txt', choice: 'take_source' },
        ],
      },
      ask = async (p: string) => /(?:SHARE_TRIAL_DIFF|DIFF_TRIAL|TRIAL) [a-f0-9-]{36}/.exec(p)![0],
      destination = join(f.dir, 'replay-candidate');
    const trial = await localIntegrationTrial(
      f.target.home,
      id,
      destination,
      selection.selectedPaths,
      ask,
      { log: silentConflict, conflictSelection: selection },
    );
    assert.equal(trial.state, 'ready');
    const shared = await shareIntegrationTrialDifference(f.target.home, id, trial.id, ask, {
        log: silentConflict,
      }),
      view = await f.read(id),
      response = await f.api.call(`${f.path}/${id}/apply`, f.alice, {
        expectedRevision: view.operation.revision,
        expectedTaskRevision: view.taskRevision,
        reportHash: view.reportHash,
        paths: selection.selectedPaths,
        confirmApplication: true,
        candidate: {
          trialId: trial.id,
          reportHash: shared.hash,
          manifestHash: trial.manifestHash,
          confirmExistingChanges: true,
        },
      });
    assert.equal(response.statusCode, 200, response.body);
    const application = response.json().operation.application;
    return {
      ...f,
      id,
      selection,
      trial,
      destination,
      application,
      backup: join(f.dir, 'replay-original-backup'),
      consent: async () => `STOPPED_AND_APPLY ${application.id}`,
      close: async () => {
        try {
          new WorkspaceLease(f.target.root, `integration:${application.id}`, true).release();
        } catch {}
        await f.close();
      },
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
