import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openRemoteOAuth, remoteOAuthFromEnvironment } from '../apps/control/src/remote-oauth.js';
import { Store } from '../packages/db/src/store.js';

const client = {
  id: 'fixture',
  name: 'Fictional client',
  redirectUris: ['https://client.example.invalid/callback'],
};
test('remote OAuth opt-in is exact, default-off and does not read unused configuration', () => {
  assert.equal(remoteOAuthFromEnvironment({}), undefined);
  assert.equal(
    remoteOAuthFromEnvironment({
      HEXU_COLLABORATION_OAUTH_ENABLED: '0',
      HEXU_COLLABORATION_IDENTITY_SECRET_FILE: '/nonexistent-fixture',
    }),
    undefined,
  );
  for (const flag of ['true', '', 'yes', '2'])
    assert.throws(() => remoteOAuthFromEnvironment({ HEXU_COLLABORATION_OAUTH_ENABLED: flag }));
});
test('remote OAuth configuration reads only the existing private secret and explicit public metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-oauth-config-'));
  try {
    const path = join(dir, 'auth-secret');
    const secret = 'fictional-secret-for-config-only-0123456789';
    writeFileSync(path, secret, { mode: 0o600 });
    const env = {
      HEXU_COLLABORATION_OAUTH_ENABLED: '1',
      HEXU_COLLABORATION_IDENTITY_DATABASE: join(dir, 'identity.sqlite'),
      HEXU_COLLABORATION_IDENTITY_SECRET_FILE: path,
      HEXU_COLLABORATION_OAUTH_CLIENT: JSON.stringify(client),
    };
    assert.deepEqual(remoteOAuthFromEnvironment(env), {
      identityDatabasePath: env.HEXU_COLLABORATION_IDENTITY_DATABASE,
      identitySecret: secret,
      client,
    });
    for (const value of [
      'null',
      '{}',
      '{"clientSecret":"not-permitted"}',
      JSON.stringify({ ...client, clientSecret: 'not-permitted' }),
      JSON.stringify({ ...client, redirectUris: [3] }),
    ])
      assert.throws(() =>
        remoteOAuthFromEnvironment({ ...env, HEXU_COLLABORATION_OAUTH_CLIENT: value }),
      );
    chmodSync(path, 0o644);
    assert.throws(() => remoteOAuthFromEnvironment(env));
    assert.equal(readFileSync(path, 'utf8'), secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('remote OAuth refuses missing, empty and business identity stores without provisioning users or credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-oauth-db-'));
  const businessPath = join(dir, 'business.sqlite');
  const store = new Store(businessPath, undefined, { team: true });
  chmodSync(businessPath, 0o600);
  const options = { identitySecret: 'fictional-secret-for-config-only-0123456789', client };
  try {
    await assert.rejects(
      openRemoteOAuth(store, 'https://hexu.example.invalid', {
        ...options,
        identityDatabasePath: join(dir, 'missing.sqlite'),
      }),
    );
    await assert.rejects(
      openRemoteOAuth(store, 'https://hexu.example.invalid', {
        ...options,
        identityDatabasePath: businessPath,
      }),
    );
    const identityPath = join(dir, 'identity.sqlite');
    const db = new DatabaseSync(identityPath);
    db.close();
    chmodSync(identityPath, 0o600);
    await assert.rejects(
      openRemoteOAuth(store, 'https://hexu.example.invalid', {
        ...options,
        identityDatabasePath: identityPath,
      }),
    );
    const check = new DatabaseSync(identityPath);
    assert.equal(check.prepare('SELECT count(*) AS n FROM sqlite_master').get()!.n, 0);
    check.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
