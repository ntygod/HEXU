// UI → real shared client → in-process Fastify routes → SQLite/PermissionService.
// Only app/request identity context, Button and FormData are fixtures. No HTTP listener or external calls.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
const require = createRequire(
  process.env.HEXU_UI_TEST_TOOLS ?? '/tmp/hexu-followup-tools/package.json',
);
const { build } = require('esbuild');
const React = require('react');
const { act, create } = require('react-test-renderer');
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'hexu-agent-ui-'));
await build({
  stdin: {
    contents: `export { AgentResources } from './apps/web/src/agent-resources.tsx'; export { ProjectAgentCapabilities } from './apps/web/src/project-agent-capabilities.tsx'; export { useAgentWrite, useAgentRead, AgentRequestProvider } from './apps/web/src/agent-resource-state.ts';`,
    resolveDir: root,
    loader: 'tsx',
  },
  outfile: join(temp, 'ui.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'test-context',
      setup(b) {
        b.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
          path: require.resolve(args.path),
          external: true,
        }));
        b.onResolve({ filter: /\/state\.js$/ }, () => ({ path: 'app-context', namespace: 'test' }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export const useApp = () => globalThis.__testApp;',
          loader: 'js',
        }));
        b.onResolve({ filter: /packages\/ui\/src\/index\.js$/ }, () => ({
          path: 'test-ui',
          namespace: 'button',
        }));
        b.onLoad({ filter: /.*/, namespace: 'button' }, () => ({
          contents: `import React from 'react'; export function Button({variant,...props}) { return React.createElement('button',{type:'button',...props}); }`,
          loader: 'js',
        }));
      },
    },
  ],
});
const {
  AgentResources,
  ProjectAgentCapabilities,
  useAgentWrite,
  useAgentRead,
  AgentRequestProvider,
} = await import(join(temp, 'ui.mjs'));
await build({
  stdin: {
    contents: `export { migrations } from './packages/db/src/schema.ts'; export { PermissionService } from './packages/db/src/permissions.ts'; export { attachAgentCapabilities } from './apps/control/src/agent-capabilities.ts'; export { AgentCapabilitiesStore } from './packages/db/src/agent-capabilities.ts'; export { DomainError } from './packages/contracts/src/index.ts';`,
    resolveDir: root,
    loader: 'ts',
  },
  outfile: join(temp, 'backend.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const { migrations, PermissionService, attachAgentCapabilities, DomainError } = await import(
  join(temp, 'backend.mjs')
);
const Fastify = createRequire(join(root, 'package.json'))('fastify');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = { dispatchEvent() {} };
let db, app, context, rendered, currentUser, screen, version, calls, outstanding, dropResponse;
const people = ['a', 'b'].map((id) => ({
  id,
  name: `Member ${id}`,
  email: `${id}@example.invalid`,
}));
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const m of migrations) db.exec(m.sql);
  for (const p of people)
    db.prepare('INSERT INTO collab_people VALUES(?,?,?)').run(p.id, p.name, p.email);
  db.prepare('INSERT INTO collab_spaces VALUES(?,?,?,?)').run(
    's',
    'Fixture space',
    'team',
    new Date().toISOString(),
  );
  for (const p of people)
    db.prepare('INSERT INTO collab_memberships VALUES(?,?,?)').run(
      's',
      p.id,
      p.id === 'a' ? 'owner' : 'member',
    );
  db.prepare('INSERT INTO projects VALUES(?,?,?)').run(
    'p',
    's',
    JSON.stringify({ id: 'p', archivedAt: null }),
  );
  for (const p of people)
    db.prepare('INSERT INTO collab_project_members VALUES(?,?,?)').run(
      'p',
      p.id,
      p.id === 'a' ? 'manage' : 'edit',
    );
  context = new AsyncLocalStorage();
  const principal = () => {
    const p = context.getStore();
    if (!p) throw new DomainError('AUTH_REQUIRED', 'No fixture identity', 401);
    return p;
  };
  const permissions = new PermissionService(db, principal);
  const host = {
    db,
    teamMode: true,
    permissions,
    get actorId() {
      return principal().user.id;
    },
    get spaceId() {
      return principal().spaceId;
    },
  };
  app = Fastify();
  app.addHook('onRequest', (req, reply, done) => {
    const user = people.find((p) => p.id === req.headers['x-fixture-user']);
    if (!user) return done();
    context.run({ user, spaceId: 's' }, done);
  });
  app.setErrorHandler((e, req, reply) =>
    reply.code(e.status ?? 500).send({ error: { code: e.code ?? 'INTERNAL', message: e.message } }),
  );
  attachAgentCapabilities(app, host);
  await app.ready();
  currentUser = 'a';
  screen = 'resources';
  version = 1;
  calls = [];
  outstanding = new Set();
  dropResponse = null;
  globalThis.fetch = (path, opts = {}) => {
    const actor = currentUser;
    const call = {
      path,
      method: opts.method ?? 'GET',
      body: opts.body,
      headers: { ...opts.headers },
    };
    calls.push(call);
    const work = (async () => {
      const response = await app.inject({
        url: path,
        method: call.method,
        headers: { ...opts.headers, 'x-fixture-user': actor },
        payload: opts.body,
      });
      call.status = response.statusCode;
      if (dropResponse?.(call)) {
        dropResponse = null;
        throw new Error('fixture drops committed response');
      }
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: async () => response.json(),
      };
    })();
    outstanding.add(work);
    void work.finally(() => outstanding.delete(work)).catch(() => {});
    return work;
  };
});
afterEach(async () => {
  if (rendered) await act(async () => rendered.unmount());
  rendered = null;
  await Promise.allSettled([...outstanding]);
  await app.close();
  db.close();
});
function Shell() {
  const row = db
    .prepare('SELECT role FROM collab_project_members WHERE project_id=? AND user_id=?')
    .get('p', currentUser);
  const project = JSON.parse(db.prepare('SELECT body FROM projects WHERE id=?').get('p').body);
  globalThis.__testApp = {
    data: {
      mode: 'team-local',
      user: people.find((p) => p.id === currentUser),
      members: people,
      projects: row
        ? [
            {
              id: 'p',
              spaceId: 's',
              name: 'Bridge project',
              access: row.role,
              archivedAt: project.archivedAt,
            },
          ]
        : [],
    },
    version,
  };
  return React.createElement(
    AgentRequestProvider,
    { key: currentUser },
    screen === 'resources'
      ? React.createElement(AgentResources)
      : screen === 'directory'
        ? React.createElement(ProjectAgentCapabilities, { projectId: 'p' })
        : null,
  );
}
async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.allSettled([...outstanding]);
      await Promise.resolve();
    });
    if (!outstanding.size) return;
  }
  assert.fail('UI did not settle');
}
async function render() {
  await act(async () => {
    if (rendered) rendered.update(React.createElement(Shell));
    else rendered = create(React.createElement(Shell));
  });
  await settle();
}
const text = () => JSON.stringify(rendered.toJSON());
const button = (label) =>
  rendered.root.findAllByType('button').find((b) => b.children.join('') === label);
async function click(label) {
  const b = button(label);
  assert.ok(b, `button ${label}`);
  assert.ok(!b.props.disabled, `enabled ${label}`);
  await act(async () => b.props.onClick?.({}));
  await settle();
}
async function submit(values) {
  const original = globalThis.FormData;
  globalThis.FormData = class {
    get(k) {
      return values[k] ?? null;
    }
    getAll(k) {
      return Array.isArray(values[k]) ? values[k] : values[k] == null ? [] : [values[k]];
    }
    has(k) {
      return values[k] != null;
    }
  };
  try {
    await act(async () =>
      rendered.root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: {} }),
    );
    await settle();
  } finally {
    globalThis.FormData = original;
  }
}
const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const agent = () =>
  JSON.parse(db.prepare('SELECT body FROM agent_participants LIMIT 1').get().body);
async function enroll() {
  await render();
  await click('登记 Agent');
  await submit({ name: 'Bridge Agent', nativeInstanceRef: 'fixture-native-instance' });
  assert.equal(count('agent_participants'), 1);
  assert.equal(agent().ownerUserId, 'a');
  await click('登记独立端点');
  await submit({
    protocol: 'custom',
    address: 'https://receiver.example.invalid/text',
    implementation: 'Fixture receiver',
    implementationVersion: '1',
    receiveMode: 'manual',
  });
  await click('编辑文本专业能力');
  await submit({
    title: 'Read-only API expertise',
    description: 'Bounded text explanation\nNo execution',
  });
  assert.equal(count('agent_endpoints'), 1);
  assert.equal(count('agent_capabilities'), 1);
}
async function grant() {
  await click('开放项目能力');
  let selects = rendered.root.findAllByType('select');
  // Explicitly authorize the two seeded project members; no member-list route substitute.
  await act(async () => selects[1].props.onChange({ target: { value: 'project_members' } }));
  selects = rendered.root.findAllByType('select');
  await act(async () => selects[0].props.onChange({ target: { value: 'p' } }));
  const requestBox = rendered.root
    .findAllByType('input')
    .find((n) => n.props.type === 'checkbox' && typeof n.props.checked === 'boolean');
  await act(async () => requestBox.props.onChange({ target: { checked: true } }));
  const date = new Date(Date.now() + 3600_000);
  const expiry = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  await submit({ expiresAt: expiry, maxConcurrent: '1', autoAccept: 'on' });
  assert.equal(count('agent_delegation_grants'), 1);
}
test('actual UI lifecycle reaches SQLite grant and another member read-only selection', async () => {
  await enroll();
  await grant();
  const saved = JSON.parse(
    db.prepare('SELECT body FROM agent_delegation_grants LIMIT 1').get().body,
  );
  assert.equal(saved.costBearerUserId, 'a');
  assert.equal(saved.request, true);
  assert.equal(saved.execution, false);
  assert.equal(saved.externalEffects, false);
  currentUser = 'b';
  screen = 'directory';
  version++;
  await render();
  assert.match(text(), /Read-only API expertise/);
  assert.match(text(), /不可调用/);
  await click('选择并准备标识');
  assert.match(text(), /已准备能力标识，尚未发起协作/);
  assert.equal(calls.at(-1).status, 200);
  assert.match(calls.at(-1).path, /\/select$/);
  assert.equal(count('tasks'), 0);
  assert.equal(count('runs'), 0);
  assert.ok(calls.every((c) => c.status < 400));
});
test('committed response loss survives route change and real receipt deduplicates original key', async () => {
  await render();
  await click('登记 Agent');
  dropResponse = (c) => c.method === 'POST' && c.path === '/api/v1/agent-participants';
  await submit({ name: 'Once only', nativeInstanceRef: '' });
  assert.equal(count('agent_participants'), 1);
  assert.match(text(), /写入结果未知/);
  screen = 'away';
  await render();
  screen = 'resources';
  await render();
  assert.match(text(), /有一项原请求等待确认/);
  await click('核对原请求');
  assert.equal(count('agent_participants'), 1);
  const writes = calls.filter((c) => c.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body, writes[1].body);
  assert.equal(writes[0].headers['Idempotency-Key'], writes[1].headers['Idempotency-Key']);
  assert.doesNotMatch(text(), /有一项原请求等待确认/);
  assert.equal(count('idempotency_records'), 1);
});
test('real project revocation clears a hidden unknown grant packet and removes directory access', async () => {
  await enroll();
  dropResponse = (c) => c.method === 'POST' && c.path.endsWith('/grants');
  await grant();
  assert.match(text(), /写入结果未知/);
  screen = 'away';
  await render();
  db.prepare('UPDATE collab_project_members SET role=? WHERE project_id=? AND user_id=?').run(
    'view',
    'p',
    'a',
  );
  version++;
  screen = 'resources';
  await render();
  assert.match(text(), /当前 Agent 或项目编辑权限已失效/);
  assert.doesNotMatch(text(), /有一项原请求等待确认/);
  currentUser = 'b';
  screen = 'directory';
  version++;
  await render();
  assert.match(text(), /当前没有可发现的能力/);
  assert.equal(count('agent_delegation_grants'), 1);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/grants')).length, 1);
});
test('real archive invalidates visible capability selection on refresh', async () => {
  await enroll();
  await grant();
  currentUser = 'b';
  screen = 'directory';
  version++;
  await render();
  await click('选择并准备标识');
  assert.match(text(), /已准备能力标识/);
  db.prepare('UPDATE projects SET body=? WHERE id=?').run(
    JSON.stringify({ id: 'p', archivedAt: new Date().toISOString() }),
    'p',
  );
  version++;
  await render();
  assert.doesNotMatch(text(), /已准备能力标识/);
  assert.ok(/归档|当前没有可发现/.test(text()));
  assert.equal(count('tasks'), 0);
  assert.equal(count('runs'), 0);
});
