import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { createRemoteCollaboration } from '../apps/control/src/remote-collaboration.js';
import { bridgeConfiguration } from '../apps/mcp/src/http.js';
import { Store } from '../packages/db/src/store.js';
import { requesterFixture } from './helpers/agent-requester.js';

test('classic remote transport is explicit HTTPS requester only, leaving local behavior intact', () => {
  const common = {
    HEXU_AGENT_ROLE: 'requester',
    HEXU_AGENT_TOKEN: `hexu_requester_${'a'.repeat(43)}`,
  };
  assert.equal(bridgeConfiguration(common).baseURL, 'http://127.0.0.1:4310');
  assert.throws(() =>
    bridgeConfiguration({ ...common, HEXU_CONTROL_URL: 'https://collab.example.invalid' }),
  );
  assert.equal(
    bridgeConfiguration({
      ...common,
      HEXU_TRANSPORT: 'remote',
      HEXU_CONTROL_URL: 'https://collab.example.invalid',
    }).baseURL,
    'https://collab.example.invalid',
  );
  for (const url of [
    'http://collab.example.invalid',
    'https://x:y@collab.example.invalid',
    'https://collab.example.invalid/?token=x',
    'https://collab.example.invalid/path',
  ])
    assert.throws(() =>
      bridgeConfiguration({ ...common, HEXU_TRANSPORT: 'remote', HEXU_CONTROL_URL: url }),
    );
  assert.throws(() =>
    bridgeConfiguration({
      HEXU_AGENT_ROLE: 'receiver',
      HEXU_TRANSPORT: 'remote',
      HEXU_CONTROL_URL: 'https://collab.example.invalid',
      HEXU_AGENT_TOKEN: `hexu_request_${'a'.repeat(43)}`,
      HEXU_REQUEST_ID: 'r',
    }),
  );
});

test('separate TLS listener serves original finite business API and rejects host/proxy/browser/human/native surfaces', async () => {
  const f = await requesterFixture(),
    dir = await mkdtemp(join(tmpdir(), 'hexu-tls-fixture-'));
  let remote: Awaited<ReturnType<typeof createRemoteCollaboration>> | undefined;
  try {
    // Disposable self-signed test trust root, trusted only by this fixture client. No real key/cert.
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=collab.example.invalid',
        '-addext',
        'subjectAltName=DNS:collab.example.invalid',
      ],
      { stdio: 'ignore' },
    );
    const key = await readFile(join(dir, 'key.pem')),
      cert = await readFile(join(dir, 'cert.pem'));
    remote = await createRemoteCollaboration({
      store: f.store,
      publicOrigin: 'https://collab.example.invalid',
      tls: { key, cert },
      encryptionKey: Buffer.alloc(32, 2),
      automaticDrain: false,
    });
    await remote.app.listen({ host: '127.0.0.1', port: 0 });
    const address = remote.app.server.address();
    assert.ok(address && typeof address === 'object');
    const send = (path: string, headers: Record<string, string> = {}, body?: unknown) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path,
            method: body === undefined ? 'GET' : 'POST',
            servername: 'collab.example.invalid',
            ca: cert,
            headers: {
              host: 'collab.example.invalid',
              authorization: `Bearer ${f.issued.token}`,
              'x-hexu-agent-api': '1',
              ...(body === undefined
                ? {}
                : { 'content-type': 'application/json', 'idempotency-key': 'remote-create' }),
              ...headers,
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
          },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    assert.equal((await send('/agent-requester/v1/identity')).status, 200);
    const created = await send('/agent-requester/v1/requests', {}, f.createBody);
    assert.equal(created.status, 201, JSON.stringify(created));
    assert.equal(
      (await send(`/agent-requester/v1/requests/${created.body.requestId}`)).body.requestId,
      created.body.requestId,
    );
    assert.equal(
      (await send('/agent-requester/v1/identity', { authorization: 'Bearer invalid' })).status,
      401,
    );
    for (const path of [
      '/api/v1/identity',
      '/api/v1/tasks',
      '/runner/v1/poll',
      '/',
      '/agent-assistance/v1/identity',
    ])
      assert.equal((await send(path)).status, 404, path);
    for (const headers of [
      { host: 'attacker.invalid' },
      { 'x-forwarded-host': 'collab.example.invalid' },
      { forwarded: 'host=collab.example.invalid' },
      { origin: 'https://collab.example.invalid' },
      { cookie: 'session=x' },
    ] as Record<string, string>[])
      assert.equal((await send('/agent-requester/v1/identity', headers)).status, 403);
    assert.equal(
      (
        await f.app.inject({
          url: '/agent-requester/v1/identity',
          headers: {
            host: 'collab.example.invalid',
            authorization: `Bearer ${f.issued.token}`,
            'x-hexu-agent-api': '1',
          },
        })
      ).statusCode,
      403,
      'original local host boundary unchanged',
    );
  } finally {
    if (remote) await remote.app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('consistent backup restores finite credentials and business receipts without starting work', async () => {
  const f = await requesterFixture(),
    dir = await mkdtemp(join(tmpdir(), 'hexu-backup-fixture-'));
  let restored: Store | undefined;
  try {
    const response = await f.requesterCall('requests', f.createBody);
    assert.equal(response.statusCode, 201, response.body);
    const target = join(dir, 'backup.sqlite');
    execFileSync(process.execPath, ['scripts/backup-collaboration.mjs', f.dbPath, target], {
      stdio: 'pipe',
    });
    restored = new Store(target, undefined, { team: true });
    assert.equal(
      (restored.db.prepare('SELECT count(*) AS n FROM assistances').get() as { n: number }).n,
      1,
    );
    assert.equal(
      (restored.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n,
      0,
    );
    assert.equal(
      restored.db.prepare('SELECT token_hash FROM agent_requester_credentials').get()!.token_hash,
      f.store.db.prepare('SELECT token_hash FROM agent_requester_credentials').get()!.token_hash,
    );
    assert.throws(() =>
      execFileSync(process.execPath, ['scripts/backup-collaboration.mjs', f.dbPath, target], {
        stdio: 'pipe',
      }),
    );
  } finally {
    restored?.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
