import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import type { IdentityUser } from '../../packages/contracts/src/identity.js';
import { Store } from '../../packages/db/src/store.js';
import { createApp } from '../../apps/control/src/app.js';

export const ORIGIN = 'http://127.0.0.1:4310';
export const SETUP = 'fictional-setup-code-not-a-secret-0123456789';
export const PASSWORD = 'Fictional Password 2026!';
export interface Account {
  cookie: string;
  user: IdentityUser;
  spaceId: string;
}
export function cookies(response: { headers: Record<string, unknown> }) {
  const value = response.headers['set-cookie'];
  return (Array.isArray(value) ? value : [value])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.split(';')[0])
    .join('; ');
}
export async function teamFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-identity-test-'));
  const dbPath = join(dir, 'workspace.sqlite'),
    identityPath = join(dir, 'identity.sqlite');
  const store = new Store(dbPath, undefined, { team: true });
  const options = {
    databasePath: identityPath,
    secret: 'fictional-auth-secret-not-real-0123456789',
    setupCode: SETUP,
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
  };
  const app = await createApp({ store, identity: options });
  const call = (
    path: string,
    account: Account | null = null,
    body?: unknown,
    key: string = randomUUID(),
    method?: 'GET' | 'POST' | 'PATCH',
  ) =>
    app.inject({
      url: '/api/v1/' + path,
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        origin: ORIGIN,
        'x-hexu-client': 'web',
        'idempotency-key': key,
        ...(account ? { cookie: account.cookie, 'x-hexu-space': account.spaceId } : {}),
      },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  const account = async (cookie: string): Promise<Account> => {
    const r = await app.inject({ url: '/api/v1/identity', headers: { cookie } });
    assert.equal(r.statusCode, 200, r.body);
    return { cookie, user: r.json().user, spaceId: `personal-${r.json().user.id}` };
  };
  const setup = async () => {
    const r = await call('identity/setup', null, {
      code: SETUP,
      name: '测试甲',
      email: 'alice@example.invalid',
      password: PASSWORD,
    });
    assert.equal(r.statusCode, 200, r.body);
    return account(cookies(r));
  };
  const login = async (email: string, password = PASSWORD) => {
    const r = await call('identity/sign-in', null, { email, password });
    assert.equal(r.statusCode, 200, r.body);
    return account(cookies(r));
  };
  const space = async (user: Account) => {
    const r = await call('spaces', user, { name: '共同研发' });
    assert.equal(r.statusCode, 201, r.body);
    return { ...user, spaceId: r.json().id };
  };
  const invite = async (owner: Account, email = 'bob@example.invalid') => {
    const r = await call(`spaces/${owner.spaceId}/invitations`, owner, { email });
    assert.equal(r.statusCode, 201, r.body);
    return r.json() as { id: string; token: string; email: string };
  };
  const joinAccount = async (token: string, name = '测试乙') => {
    const r = await call('identity/join', null, { token, name, password: PASSWORD });
    assert.equal(r.statusCode, 200, r.body);
    return { ...(await account(cookies(r))), spaceId: r.json().spaceId };
  };
  const pair = async () => {
    const alice = await space(await setup()),
      invitation = await invite(alice),
      bob = await joinAccount(invitation.token);
    return { alice, bob, invitation };
  };
  const project = async (owner: Account) => {
    const r = await call(`spaces/${owner.spaceId}/projects`, owner, { name: '共享项目' });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  };
  const task = async (owner: Account, projectId: string | null = null, title = '测试任务') => {
    const r = await call(`spaces/${owner.spaceId}/tasks`, owner, { title, projectId });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  };
  return {
    dir,
    dbPath,
    identityPath,
    options,
    store,
    app,
    call,
    account,
    setup,
    login,
    space,
    invite,
    joinAccount,
    pair,
    project,
    task,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
