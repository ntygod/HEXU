// Real BetterAuth implementation with ephemeral accounts and in-memory auth database.
// No server listener, real account, network request, or model execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
const dist = resolve(process.env.HEXU_SERVER_DIST ?? 'dist');
const { createIdentity } = await import(
  pathToFileURL(resolve(dist, 'packages/identity/src/index.js'))
);
const origin = 'http://127.0.0.1:4173';
const headers = (cookie) =>
  new Headers({
    'content-type': 'application/json',
    origin,
    'x-hexu-auth-ip': '127.0.0.1',
    ...(cookie ? { cookie } : {}),
  });
const cookieFrom = (response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
test('real BetterAuth setup, signed cookie identity, invalid cookie and sign-out', async () => {
  const setupCode = randomBytes(32).toString('hex');
  const identity = await createIdentity({
    databasePath: ':memory:',
    secret: randomBytes(32).toString('hex'),
    setupCode,
    baseURL: origin,
    trustedOrigins: [origin],
  });
  try {
    assert.equal(identity.setupRequired(), true);
    const created = await identity.setup(
      setupCode,
      {
        name: 'Ephemeral test member',
        email: 'test@example.invalid',
        password: randomBytes(24).toString('hex'),
      },
      headers(),
    );
    assert.equal(created.response.status, 200);
    assert.equal(identity.setupRequired(), false);
    const cookie = cookieFrom(created.response);
    assert.ok(cookie);
    const current = await identity.current(headers(cookie));
    assert.equal(current.user.id, created.user.id);
    assert.equal(current.user.email, 'test@example.invalid');
    assert.equal(await identity.current(headers()), null);
    assert.equal(await identity.current(headers('hexu-team.session_token=invalid')), null);
    const bearerOnly = headers();
    bearerOnly.set('authorization', `Bearer ${cookie}`);
    assert.equal(await identity.current(bearerOnly), null);
    assert.equal((await identity.signOut(headers(cookie))).status, 200);
    assert.equal(await identity.current(headers(cookie)), null);
  } finally {
    identity.close();
  }
});
