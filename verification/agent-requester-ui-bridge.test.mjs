// Real React UI → shared client → createApp/Fastify.inject → BetterAuth + SQLite.
// Transport/context/UI primitives are fixtures; domain/routes/authorization are production.
// HEXU_UI_TEST_TOOLS points to a package.json with React 19.2/react-test-renderer/esbuild.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '..');
const require = createRequire(process.env.HEXU_UI_TEST_TOOLS || join(root, 'package.json'));
const { build } = require('esbuild'),
  React = require('react'),
  { act, create } = require('react-test-renderer');
const temp = await mkdtemp(join(tmpdir(), 'hexu-requester-ui-bridge-'));
await build({
  stdin: {
    contents: `export { AgentAssistanceThread } from './apps/web/src/agent-assistance-thread.tsx'; export { AgentAssistanceEditor } from './apps/web/src/agent-assistance-create.tsx'; export { AgentAssistanceProvider, useAgentAssistanceCommand } from './apps/web/src/agent-assistance-state.tsx'; export { AgentRequesterCredentials } from './apps/web/src/agent-requester-credentials.tsx';`,
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
      name: 'context',
      setup(b) {
        b.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
          path: require.resolve(args.path),
          external: true,
        }));
        b.onResolve({ filter: /\/state\.js$/ }, () => ({ path: 'context', namespace: 'stub' }));
        b.onResolve({ filter: /packages\/ui\/src\/index\.js$/ }, () => ({
          path: 'ui',
          namespace: 'stub',
        }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents:
            args.path === 'context'
              ? `import React from 'react'; export const useApp=()=>globalThis.__app; export const time=v=>v; export const canEditTask=()=>true; export const Link=({to,...p})=>React.createElement('a',{href:to,...p});`
              : `import React from 'react'; export const Button=({variant,busy,...p})=>React.createElement('button',{type:'button',...p}); export const Dialog=({children})=>React.createElement('section',{},children); export const Icon=()=>null; export const RunBadge=()=>null;`,
          loader: 'js',
        }));
      },
    },
  ],
});
const UI = await import(join(temp, 'ui.mjs'));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = { dispatchEvent() {} };
const dist = process.env.HEXU_SERVER_DIST || join(root, 'dist');
const { teamFixture, ORIGIN } = await import(
  pathToFileURL(join(dist, 'tests/helpers/team.js')).href
);
let f, current, rendered, calls, dropCreate, pending;
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  do {
    await Promise.allSettled([...pending]);
    await flush();
  } while (pending.size);
}
async function prepareRequester(data) {
  const { alice, task, message, selection, requesterId } = data;
  context(alice, task);
  await mount(
    React.createElement(UI.AgentAssistanceEditor, {
      task,
      messageId: message.id,
      onSaved() {
        throw new Error('credential issuance must not create Assistance');
      },
    }),
  );
  await change('当前可请求能力', selection);
  await change('关联本人 Agent', requesterId);
  await change('Agent 协助问题', 'Please review the chosen API question.');
  await step(() =>
    field('Agent 消息选区').props.onSelect({
      currentTarget: { selectionStart: 0, selectionEnd: 24 },
    }),
  );
  await click('使用 Agent 分享选区');
  await checked('Approved API note');
  await click('预览完整分享内容');
  await checked('我已核对双方');
  await change(
    '原生发起凭据到期时间 UTC',
    new Date(Date.now() + 1800000).toISOString().slice(0, 16),
  );
  await checked('我明确授权本人 Agent');
}

test('real requester UI: explicit fixed authorization issues only one credential, shows scope, and revokes it', async () => {
  const data = await setup();
  await prepareRequester(data);
  await click('明确开通原生发起凭据');
  const token = field('一次性原生发起凭据').props.value;
  assert.ok(token.startsWith('hexu_requester_'));
  const list = await f.call(`tasks/${data.task.id}/agent-requester-credentials`, data.alice);
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().items.length, 1);
  assert.equal(list.json().items[0].participantId, data.requesterId);
  assert.equal(list.json().items[0].materialLabels.length, 2);
  assert.ok(!list.body.includes(token));
  assert.equal(
    f.store.db.prepare('SELECT count(*) AS n FROM assistance_agent_requests').get().n,
    0,
  );
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  assert.equal(
    calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/agent-requester-credentials'),
    ).length,
    1,
  );
  await click('撤销原生发起凭据');
  await click('确认撤销原生发起凭据');
  assert.ok(text(rendered.toJSON()).includes('已撤销'));
  assert.equal(
    rendered.root.findAll((node) => node.props['aria-label'] === '一次性原生发起凭据').length,
    0,
  );
  const after = await f.call(`tasks/${data.task.id}/agent-requester-credentials`, data.alice);
  assert.ok(after.json().items[0].revokedAt);
});

test('real requester UI: dropped committed issue replays exact original key and does not reveal token twice', async () => {
  const data = await setup();
  await prepareRequester(data);
  dropCreate = true;
  await click('明确开通原生发起凭据');
  assert.ok(text(rendered.toJSON()).includes('结果未知'));
  await click('确认原 Agent 协助操作');
  const writes = calls.filter(
    (call) => call.method === 'POST' && call.path.endsWith('/agent-requester-credentials'),
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body, writes[1].body);
  assert.equal(writes[0].key, writes[1].key);
  assert.ok(text(rendered.toJSON()).includes('密钥不会再次返回'));
  assert.equal(
    rendered.root.findAll((node) => node.props['aria-label'] === '一次性原生发起凭据').length,
    0,
  );
  const list = await f.call(`tasks/${data.task.id}/agent-requester-credentials`, data.alice);
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().items.length, 1);
  assert.equal(
    f.store.db.prepare('SELECT count(*) AS n FROM assistance_agent_requests').get().n,
    0,
  );
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
});
async function step(fn) {
  await act(async () => {
    await fn();
    await settle();
  });
  // Credential ACK schedules a metadata GET from the next effect flush.
  await act(async () => {
    await settle();
  });
}
async function mount(node) {
  await step(() => {
    rendered = create(React.createElement(UI.AgentAssistanceProvider, {}, node));
  });
}
async function unmount() {
  if (rendered) await step(() => rendered.unmount());
  rendered = null;
}
const text = (node) =>
  typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
const button = (label) =>
  rendered.root.findAllByType('button').find((n) => text(n).trim() === label);
const field = (label) => {
  const nodes = rendered.root.findAll((n) => n.props['aria-label'] === label);
  assert.ok(nodes[0], label + ': ' + text(rendered.toJSON()));
  return nodes[0];
};
async function click(label) {
  const node = button(label);
  assert.ok(node, `missing button ${label}`);
  assert.ok(!node.props.disabled, `disabled ${label}: ${text(rendered.toJSON())}`);
  await step(() => node.props.onClick?.());
}
async function change(label, value) {
  await step(() => field(label).props.onChange({ target: { value } }));
}
async function submit() {
  await step(() => rendered.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));
}
async function checked(label) {
  const node = rendered.root
    .findAllByType('input')
    .find((n) => n.props.type === 'checkbox' && text(n.parent).includes(label));
  assert.ok(node, label);
  await step(() => node.props.onChange({ target: { checked: true } }));
}
async function read(id, who = current) {
  const r = await f.call(`assistances/${id}`, who);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
function context(account, task) {
  current = account;
  globalThis.__app = {
    data: { user: account.user, tasks: [task], mode: 'team-local' },
    version: 1,
    refresh: async () => {},
  };
}
async function thread(id, account, task) {
  await unmount();
  context(account, task);
  await mount(
    React.createElement(UI.AgentAssistanceThread, {
      value: await read(id),
      readError: '',
      onRetry() {},
    }),
  );
}
beforeEach(async () => {
  f = await teamFixture();
  calls = [];
  pending = new Set();
  dropCreate = false;
  globalThis.fetch = (path, options = {}) => {
    const run = (async () => {
      calls.push({
        path,
        method: options.method ?? 'GET',
        body: options.body,
        key: options.headers?.['Idempotency-Key'],
      });
      const response = await f.app.inject({
        url: path,
        method: options.method ?? 'GET',
        headers: {
          ...options.headers,
          origin: ORIGIN,
          cookie: current.cookie,
          'x-hexu-space': current.spaceId,
        },
        ...(options.body === undefined ? {} : { payload: options.body }),
      });
      if (
        dropCreate &&
        path.endsWith('/agent-requester-credentials') &&
        response.statusCode === 201
      ) {
        dropCreate = false;
        throw new Error('simulated response lost after committed SQLite transaction');
      }
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: async () => response.json(),
      };
    })();
    pending.add(run);
    run.finally(() => pending.delete(run)).catch(() => {});
    return run;
  };
});
afterEach(async () => {
  await unmount();
  await f.close();
  delete globalThis.__app;
});
async function setup() {
  const { alice, bob } = await f.pair();
  const project = await f.project(alice);
  assert.equal(
    (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' }))
      .statusCode,
    200,
  );
  const task = await f.task(alice, project.id, 'Hidden parent title');
  const posted = await f.call(`tasks/${task.id}/messages`, alice, {
    body: 'Share this fixed excerpt. Do not share the rest.',
  });
  assert.equal(posted.statusCode, 201, posted.body);
  const message = posted.json();
  const source = await f.call(`projects/${project.id}/sources`, alice, {
    kind: 'text',
    title: 'Approved API note',
    content: 'Only this approved project note.',
    url: null,
  });
  assert.equal(source.statusCode, 201, source.body);
  const registration = await f.call('agent-participants', bob, {
    name: 'Fictional recipient Agent',
    nativeInstanceRef: null,
  });
  assert.equal(registration.statusCode, 201, registration.body);
  const id = registration.json().id;
  assert.equal(
    (
      await f.call(`agent-participants/${id}/endpoint`, bob, {
        expectedRevision: 0,
        protocol: 'custom',
        address: 'https://fixture.example.invalid/agent',
        implementation: 'fictional test',
        implementationVersion: '1',
        receiveMode: 'poll',
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.call(`agent-participants/${id}/capability`, bob, {
        expectedRevision: 0,
        title: 'Text expertise',
        description: 'Only explicit shared input',
      })
    ).statusCode,
    200,
  );
  const grant = await f.call(`agent-participants/${id}/grants`, bob, {
    projectId: project.id,
    audience: 'selected_members',
    requesterUserIds: [alice.user.id],
    request: true,
    autoAccept: false,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    maxConcurrent: 2,
    costBearer: 'owner',
    expectedCapabilityVersion: 1,
    expectedEndpointRevision: 1,
  });
  assert.equal(grant.statusCode, 201, grant.body);
  const resource = grant.json();
  const requester = await f.call('agent-participants', alice, {
    name: 'Fictional requester Agent',
    nativeInstanceRef: null,
  });
  assert.equal(requester.statusCode, 201, requester.body);
  const endpoint = await f.call(`agent-participants/${requester.json().id}/endpoint`, alice, {
    expectedRevision: 0,
    protocol: 'mcp',
    address: 'https://fixture.example.invalid/requester',
    implementation: 'fictional requester',
    implementationVersion: '1',
    receiveMode: 'manual',
  });
  assert.equal(endpoint.statusCode, 200, endpoint.body);
  return {
    requesterId: requester.json().id,
    alice,
    bob,
    task,
    project,
    message,
    selection: resource.capability.id + ':' + resource.grants[0].id,
  };
}
