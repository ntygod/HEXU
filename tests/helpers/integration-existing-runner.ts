import assert from 'node:assert/strict';
import { join } from 'node:path';
import { integrationRunnerFixture } from './integration-runner.js';
import { preflightIntegration } from '../../apps/runner/src/agent/integration-preflight.js';
import { localIntegrationTrial } from '../../apps/runner/src/agent/integration-trial.js';
import { shareIntegrationTrialDifference } from '../../apps/runner/src/agent/integration-trial-difference.js';
import { WorkspaceLease } from '../../apps/runner/src/workspace-lease.js';
import type { IntegrationView } from '../../packages/contracts/src/integrations.js';
const silent = () => {};
export const selection = ['README.md', 'delete.txt', 'new-module/nested.txt', 'new.txt'];
export async function preparedExistingApplication(
  format: 'sha1' | 'sha256' = 'sha1',
  onRequest?: (url: string) => Promise<void>,
) {
  const f = await integrationRunnerFixture(
    format,
    format === 'sha256',
    false,
    { 'new-module/nested.txt': 'NESTED\n', 'unselected.txt': 'NOT SELECTED\n' },
    {
      baseFiles: { 'delete.txt': 'ORIGINAL DELETE\n' },
      sourceDeletePaths: ['delete.txt'],
      beforeListen: (app) => {
        if (!onRequest) return;
        // The protocol fixture is already ready from setup injections. Gate its
        // actual HTTP listener before listen(), not the product Fastify hooks.
        const listeners = app.server.listeners('request');
        for (const listener of listeners) app.server.removeListener('request', listener as never);
        app.server.on('request', (request, response) => {
          void onRequest(request.url ?? '')
            .then(() => {
              for (const listener of listeners) listener.call(app.server, request, response);
            })
            .catch(() => {
              response.statusCode = 500;
              response.end('fixture gate failed');
            });
        });
      },
    },
  );
  try {
    const id = await f.create();
    await preflightIntegration(f.target.home, id, f.ask(id), silent);
    const destination = join(f.dir, 'candidate');
    const trial = await localIntegrationTrial(
      f.target.home,
      id,
      destination,
      selection,
      async (p) => /TRIAL [0-9a-f-]{36}/.exec(p)![0],
      { log: silent },
    );
    assert.equal(trial.state, 'ready');
    const shared = await shareIntegrationTrialDifference(
      f.target.home,
      id,
      trial.id,
      async (p) => /(?:SHARE_TRIAL_DIFF|DIFF_TRIAL) [0-9a-f-]{36}/.exec(p)![0],
      { log: silent },
    );
    const v = await f.read(id);
    const selected = await f.api.call(`${f.path}/${id}/apply`, f.alice, {
      expectedRevision: v.operation.revision,
      expectedTaskRevision: v.taskRevision,
      reportHash: v.reportHash,
      paths: selection,
      confirmApplication: true,
      candidate: {
        trialId: trial.id,
        reportHash: shared.hash,
        manifestHash: trial.manifestHash,
        confirmExistingChanges: true,
      },
    });
    assert.equal(selected.statusCode, 200, selected.body);
    const application = (selected.json() as IntegrationView).operation.application!;
    return {
      ...f,
      id,
      destination,
      trial,
      backup: join(f.dir, 'private-backup'),
      application,
      consent: async () => `STOPPED_AND_APPLY ${application.id}`,
      close: async () => {
        try {
          new WorkspaceLease(f.target.root, `integration:${application.id}`, true).release();
        } catch {
          /* disposable fixture only */
        }
        await f.close();
      },
    };
  } catch (cause) {
    await f.close();
    throw cause;
  }
}
