import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/db/src/store.js';
import { createApp } from '../apps/control/src/app.js';
import { localIdentityOptions } from '../packages/identity/src/config.js';
import { teamFixture, ORIGIN, SETUP, PASSWORD, cookies } from './helpers/team.js';

test('真实认证初始化只允许本机代码；Cookie 不通过响应体暴露，旧身份不混入', async () => {
  const f = await teamFixture();
  try {
    assert.equal((await f.call('identity')).json().setupRequired, true);
    assert.equal(
      (
        await f.call('identity/setup', null, {
          code: 'wrong-code'.repeat(5),
          name: '假的',
          email: 'fake@example.invalid',
          password: PASSWORD,
        })
      ).statusCode,
      403,
    );
    const response = await f.call('identity/setup', null, {
      code: SETUP,
      name: '测试甲',
      email: 'alice@example.invalid',
      password: PASSWORD,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true });
    assert.match(String(response.headers['set-cookie']), /HttpOnly/i);
    assert.match(String(response.headers['set-cookie']), /SameSite=Lax/i);
    const alice = await f.account(cookies(response));
    const work = (await f.call('workbench', alice)).json();
    assert.equal(work.mode, 'team-local');
    assert.equal(work.user.id, alice.user.id);
    assert.equal(work.user.name, '测试甲');
    assert.deepEqual(work.tasks, []);
    assert.deepEqual(work.projects, []);
    assert.equal(work.members.length, 1);
    assert.equal(
      (
        await f.call('identity/setup', null, {
          code: SETUP,
          name: '第二人',
          email: 'other@example.invalid',
          password: PASSWORD,
        })
      ).statusCode,
      409,
    );
    assert.equal((await f.call('identity')).json().setupRequired, false);
  } finally {
    await f.close();
  }
});

test('首次初始化并发只建立一个所有者账号', async () => {
  const f = await teamFixture();
  try {
    const results = await Promise.all(
      ['a', 'b'].map((name) =>
        f.call('identity/setup', null, {
          code: SETUP,
          name,
          email: name + '@example.invalid',
          password: PASSWORD,
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM collab_people').get()!.n, 1);
  } finally {
    await f.close();
  }
});

test('登录来源校验、伪造用户头和直接认证注册入口不能绕过会话', async () => {
  const f = await teamFixture();
  try {
    const alice = await f.setup();
    assert.equal((await f.call('workbench')).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/v1/workbench',
          headers: {
            'x-user-id': alice.user.id,
            'x-hexu-space': alice.spaceId,
            authorization: 'Bearer fake',
          },
        })
      ).statusCode,
      401,
    );
    for (const origin of [undefined, 'https://untrusted.example']) {
      const r = await f.app.inject({
        method: 'POST',
        url: '/api/v1/identity/sign-in',
        headers: { 'x-hexu-client': 'web', ...(origin ? { origin } : {}) },
        payload: { email: alice.user.email, password: PASSWORD },
      });
      assert.equal(r.statusCode, 403);
    }
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: ORIGIN, 'x-hexu-client': 'web' },
      payload: { name: 'rogue', email: 'rogue@example.invalid', password: PASSWORD },
    });
    assert.ok([401, 404].includes(r.statusCode));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM collab_people').get()!.n, 1);
  } finally {
    await f.close();
  }
});

test('真实密码验证、退出与全部会话撤销立即影响后续请求', async () => {
  const f = await teamFixture();
  try {
    const alice = await f.setup();
    assert.equal(
      (
        await f.call('identity/sign-in', null, {
          email: alice.user.email,
          password: 'incorrect-password',
        })
      ).statusCode,
      401,
    );
    const second = await f.login(alice.user.email);
    assert.equal((await f.call('identity/sign-out', second, {})).statusCode, 200);
    assert.equal((await f.call('workbench', second)).statusCode, 401);
    assert.equal((await f.call('workbench', alice)).statusCode, 200);
    const third = await f.login(alice.user.email);
    assert.equal((await f.call('identity/revoke-sessions', alice, {})).statusCode, 200);
    assert.equal((await f.call('workbench', third)).statusCode, 401);
    assert.equal((await f.call('workbench', alice)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('修改密码验证当前密码并撤销其他会话，不支持邮箱找回的伪成功', async () => {
  const f = await teamFixture();
  try {
    const alice = await f.setup(),
      second = await f.login('alice@example.invalid');
    assert.equal(
      (
        await f.call('identity/change-password', alice, {
          currentPassword: 'wrong-current',
          newPassword: 'A changed fictional password',
        })
      ).statusCode,
      400,
    );
    const changed = await f.call('identity/change-password', alice, {
      currentPassword: PASSWORD,
      newPassword: 'A changed fictional password',
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((await f.call('workbench', second)).statusCode, 401);
    assert.equal(
      (
        await f.call('identity/sign-in', null, {
          email: 'alice@example.invalid',
          password: PASSWORD,
        })
      ).statusCode,
      401,
    );
    await f.login('alice@example.invalid', 'A changed fictional password');
    assert.equal(
      (await f.call('identity/reset-password', null, { email: 'alice@example.invalid' }))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('认证数据和会话重启后保留；过期会话不可使用', async () => {
  const f = await teamFixture();
  let reopened: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const alice = await f.setup(),
      task = await f.task(alice, null, '不能丢失的任务');
    await f.app.close();
    reopened = await createApp({ databasePath: f.dbPath, identity: f.options });
    let r = await reopened.inject({
      url: `/api/v1/tasks/${task.id}`,
      headers: { cookie: alice.cookie, 'x-hexu-space': alice.spaceId },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().task.title, '不能丢失的任务');
    const db = new DatabaseSync(f.identityPath);
    db.prepare('UPDATE session SET expiresAt=?').run(Date.now() - 10_000);
    db.close();
    r = await reopened.inject({ url: '/api/v1/workbench', headers: { cookie: alice.cookie } });
    assert.equal(r.statusCode, 401);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('邀请绑定邮箱、明文仅出现一次，不进入数据库或幂等记录', async () => {
  const f = await teamFixture();
  try {
    const alice = await f.space(await f.setup());
    const path = `spaces/${alice.spaceId}/invitations`,
      body = { email: 'bob@example.invalid' },
      key = 'one-invite';
    const response = await f.call(path, alice, body, key),
      invite = response.json();
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(invite.token.length, 43);
    const retry = (await f.call(path, alice, body, key)).json();
    assert.equal(retry.id, invite.id);
    assert.equal(retry.token, null);
    const persisted =
      JSON.stringify(f.store.db.prepare('SELECT * FROM collab_invitations').all()) +
      JSON.stringify(f.store.db.prepare('SELECT * FROM idempotency_records').all());
    assert.ok(!persisted.includes(invite.token));
    assert.equal(
      (await f.call('identity/invitation-preview', null, { token: invite.token })).json().email,
      'bob@example.invalid',
    );
    assert.equal((await f.call('identity/join', alice, { token: invite.token })).statusCode, 403);
    const bob = await f.joinAccount(invite.token);
    assert.equal(bob.user.email, 'bob@example.invalid');
    assert.equal(
      (await f.call('identity/join', bob, { token: invite.token })).json().alreadyJoined,
      true,
    );
    assert.equal(
      (await f.call('identity/invitation-preview', null, { token: invite.token })).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test('邀请撤销、过期及已移除成员不能使用旧邀请恢复访问', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob, invitation } = await f.pair();
    assert.equal(
      (await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {})).statusCode,
      200,
    );
    assert.equal((await f.call('identity/join', bob, { token: invitation.token })).statusCode, 409);
    assert.equal((await f.call('workbench', bob)).statusCode, 403);
    const revoked = await f.invite(alice, 'new@example.invalid');
    await f.call(`spaces/${alice.spaceId}/invitations/${revoked.id}/revoke`, alice, {});
    assert.equal(
      (
        await f.call('identity/join', null, {
          token: revoked.token,
          name: '测试',
          password: PASSWORD,
        })
      ).statusCode,
      404,
    );
    const expired = await f.invite(alice, 'other@example.invalid');
    f.store.db
      .prepare('UPDATE collab_invitations SET expires_at=? WHERE id=?')
      .run('2000-01-01T00:00:00.000Z', expired.id);
    assert.equal(
      (await f.call('identity/invitation-preview', null, { token: expired.token })).statusCode,
      404,
    );
    const personal = { ...bob, spaceId: `personal-${bob.user.id}` };
    assert.equal((await f.call('workbench', personal)).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('邀请或登录频控不信任客户端转发 IP', async () => {
  const f = await teamFixture();
  try {
    let response;
    for (let i = 0; i < 31; i++)
      response = await f.app.inject({
        method: 'POST',
        url: '/api/v1/identity/invitation-preview',
        headers: {
          origin: ORIGIN,
          'x-hexu-client': 'web',
          'x-forwarded-for': `203.0.113.${i}`,
          'x-hexu-auth-ip': `203.0.114.${i}`,
        },
        payload: { token: 'x'.repeat(43) },
      });
    assert.equal(response!.statusCode, 429);
  } finally {
    await f.close();
  }
});

test('本地认证配置生成独立 secret/初始化代码，重启稳定且权限受限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-auth-config-'));
  const oldSecret = process.env.HEXU_AUTH_SECRET,
    oldCode = process.env.HEXU_SETUP_CODE;
  delete process.env.HEXU_AUTH_SECRET;
  delete process.env.HEXU_SETUP_CODE;
  try {
    const first = localIdentityOptions(dir, 4310),
      second = localIdentityOptions(dir, 4310);
    assert.equal(first.secret, second.secret);
    assert.equal(first.setupCode, second.setupCode);
    assert.notEqual(first.secret, first.setupCode);
    assert.equal((await stat(join(dir, 'auth-secret'))).mode & 0o777, 0o600);
    assert.equal((await readFile(join(dir, 'setup-code'), 'utf8')).length, 43);
  } finally {
    if (oldSecret !== undefined) process.env.HEXU_AUTH_SECRET = oldSecret;
    if (oldCode !== undefined) process.env.HEXU_SETUP_CODE = oldCode;
    await rm(dir, { recursive: true, force: true });
  }
});

test('团队模式不能重新标记旧示例库；新迁移保留旧任务 ID 与记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-mode-migration-')),
    path = join(dir, 'preview.sqlite');
  try {
    let store = new Store(path);
    const task = store.createTask(
      { title: '旧数据', description: '仍保留', projectId: null },
      'legacy',
    );
    store.close();
    assert.throws(() => new Store(path, undefined, { team: true }), /数据|模式|预览/);
    store = new Store(path);
    assert.equal(store.getTask(task.id).description, '仍保留');
    store.close();
    const team = join(dir, 'team.sqlite');
    store = new Store(team, undefined, { team: true });
    store.close();
    assert.throws(() => new Store(team), /数据|模式|预览/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
