// Focused renderer checks, no browser navigation, real credentials or model calls.
// HEXU_UI_TEST_TOOLS points to a package.json with React 19.2/react-test-renderer/esbuild.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const root = resolve(import.meta.dirname, '..');
const require = createRequire(process.env.HEXU_UI_TEST_TOOLS || join(root, 'package.json'));
const { build } = require('esbuild'),
  React = require('react'),
  { act, create } = require('react-test-renderer');
const temp = await mkdtemp(join(tmpdir(), 'hexu-requester-ui-'));
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
              ? `import React from 'react'; export const useApp=()=>globalThis.__app; export const time=v=>v; export const canEditTask=()=>globalThis.__canEdit; export const Link=({to,...p})=>React.createElement('a',{href:to,...p});`
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
const hash = 'a'.repeat(64);
const task = {
  id: 'task',
  projectId: 'project',
  spaceId: 'space',
  visibility: 'project',
  revision: 1,
};
const target = {
  participantId: 'agent-b',
  capabilityId: 'cap',
  capabilityVersion: 1,
  endpointRevision: 1,
  grantId: 'grant',
  grantRevision: 1,
};
const input = {
  question: 'Only this question',
  clarification: null,
  message: { sourceMessageId: 'message', expectedSourceHash: hash, range: { start: 0, end: 5 } },
  projectTexts: { items: [], expectedHash: hash },
};
const preview = {
  target,
  requesterParticipantId: 'agent-a',
  input,
  expectedTaskRevision: 1,
  inputHash: hash,
  materials: [{ id: 'message', label: '固定消息', text: 'Fixed' }],
};
const future = (hours = 1) => new Date(Date.now() + hours * 3600000).toISOString();
const credential = () => ({
  id: 'credential',
  revision: 1,
  taskId: 'task',
  participantId: 'agent-a',
  target,
  inputHash: hash,
  materialLabels: ['固定消息'],
  expiresAt: future(),
  revokedAt: null,
  createdAt: new Date().toISOString(),
});
let rendered, calls, route, items, props;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const text = (node) =>
  typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
const button = (label) =>
  rendered.root.findAllByType('button').find((node) => text(node).trim() === label);
const field = (label) => rendered.root.find((node) => node.props['aria-label'] === label);
const writes = () => calls.filter((call) => call.options.method === 'POST');
function Tree({ show = true, ...overrides }) {
  return React.createElement(
    UI.AgentAssistanceProvider,
    {},
    show ? React.createElement(UI.AgentRequesterCredentials, { ...props, ...overrides }) : null,
  );
}
async function mount(overrides = {}) {
  await act(async () => {
    rendered = create(React.createElement(Tree, overrides));
    await flush();
  });
}
async function update(overrides = {}) {
  await act(async () => {
    rendered.update(React.createElement(Tree, overrides));
    await flush();
  });
}
async function click(label) {
  const found = button(label);
  assert.ok(found, label);
  assert.ok(!found.props.disabled, `disabled: ${label}`);
  await act(async () => {
    found.props.onClick?.();
    await flush();
  });
}
async function change(label, value) {
  await act(async () => {
    field(label).props.onChange({ target: { value } });
    await flush();
  });
}
async function consent(checked = true) {
  const checkbox = rendered.root
    .findAllByType('input')
    .find((node) => node.props.type === 'checkbox');
  assert.ok(!checkbox.props.disabled);
  await act(async () => {
    checkbox.props.onChange({ target: { checked } });
    await flush();
  });
}
async function ready() {
  await change('原生发起凭据到期时间 UTC', future().slice(0, 16));
  await consent();
}
beforeEach(() => {
  calls = [];
  items = [];
  globalThis.__canEdit = true;
  globalThis.__app = {
    data: { user: { id: 'owner' }, tasks: [task] },
    version: 1,
    refresh: async () => {},
  };
  props = {
    task,
    messageId: 'message',
    preview,
    requesterName: 'My Agent',
    requesterEndpointReady: true,
    recipientName: 'Expert Agent',
    grantExpiresAt: future(2),
    shareConfirmed: true,
    disabled: false,
  };
  route = async (path, options) => {
    if (options.method !== 'POST') return { items };
    if (path.endsWith('/revoke')) {
      items = [{ ...items[0], revision: 2, revokedAt: new Date().toISOString() }];
      return { credential: items[0] };
    }
    const value = credential();
    items = [value];
    return { credential: value, token: 'fake-requester-one-time-secret' };
  };
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path, options: structuredClone({ ...options, signal: undefined }) });
    const result = await route(path, options);
    return { ok: !result?.error, status: result?.status ?? 200, json: async () => result };
  };
});
afterEach(async () => {
  if (rendered) await act(async () => rendered.unmount());
  rendered = null;
  delete globalThis.__app;
});

test('new authorization is unavailable before owner selection, full preview and separate consent', async () => {
  await mount({ preview: null, shareConfirmed: false });
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
  assert.equal(writes().length, 0);
  await update({ preview: { ...preview, requesterParticipantId: null } });
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
  await update();
  await change('原生发起凭据到期时间 UTC', future().slice(0, 16));
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
  await consent();
  assert.equal(button('明确开通原生发起凭据').props.disabled, false);
  assert.ok(text(rendered.toJSON()).includes('不会升级 capability_read'));
  assert.ok(text(rendered.toJSON()).includes('唯一目标：Expert Agent'));
  assert.equal(writes().length, 0);
});

test('requester without a registered endpoint cannot issue and sees the required setup', async () => {
  await mount({ requesterEndpointReady: false });
  await ready();
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
  assert.ok(text(rendered.toJSON()).includes('尚未登记独立端点'));
  assert.equal(writes().length, 0);
});

test('new requester panel clears the one-time secret and confirmation when identity changes', async () => {
  await mount();
  await ready();
  await click('明确开通原生发起凭据');
  globalThis.__app = {
    ...globalThis.__app,
    data: { ...globalThis.__app.data, user: { id: 'other-owner' } },
  };
  await update();
  assert.equal(
    rendered.root.findAll((node) => node.props['aria-label'] === '一次性原生发起凭据').length,
    0,
  );
  assert.equal(field('原生发起凭据到期时间 UTC').props.value, '');
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
  assert.equal(writes().length, 1);
});

test('issuance freezes normalized preview and exact task/participant/target; no assistance is created', async () => {
  await mount();
  await ready();
  await click('明确开通原生发起凭据');
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].path, '/api/v1/tasks/task/agent-requester-credentials');
  const body = JSON.parse(writes()[0].options.body);
  assert.deepEqual(body.preview, { target, requesterParticipantId: 'agent-a', input });
  assert.equal(body.participantId, 'agent-a');
  assert.equal(body.expectedInputHash, hash);
  assert.equal(body.expectedTaskRevision, 1);
  assert.equal(body.shareConfirmed, true);
  assert.equal(field('一次性原生发起凭据').props.value, 'fake-requester-one-time-secret');
  assert.equal(field('一次性原生发起凭据').props.autoComplete, 'off');
  assert.ok(!calls.some((call) => call.options.headers?.Authorization));
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
});

test('duration is bounded by 24 hours and target grant expiry; expired time cannot issue', async () => {
  await mount({ grantExpiresAt: future(48) });
  await change('原生发起凭据到期时间 UTC', future(25).slice(0, 16));
  await consent();
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
  await change('原生发起凭据到期时间 UTC', future(-1).slice(0, 16));
  await consent();
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
  await update({ grantExpiresAt: future(0.5) });
  await ready();
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
  assert.equal(writes().length, 0);
});

test('changing scope or expiry resets permission confirmation', async () => {
  await mount();
  await ready();
  await update({ preview: { ...preview, inputHash: 'b'.repeat(64) } });
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
  await consent();
  assert.equal(button('明确开通原生发起凭据').props.disabled, false);
  await change('原生发起凭据到期时间 UTC', future(1.5).slice(0, 16));
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
});

test('double clicks issue only one fixed write and token never survives dismissal', async () => {
  let finish;
  route = async (_, options) =>
    options.method === 'POST'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { items };
  await mount();
  await ready();
  await act(async () => {
    const action = button('明确开通原生发起凭据');
    action.props.onClick();
    action.props.onClick();
    await flush();
  });
  assert.equal(writes().length, 1);
  await act(async () => {
    const value = credential();
    items = [value];
    finish({ credential: value, token: 'fake-requester-one-time-secret' });
    await flush();
  });
  assert.equal(field('一次性原生发起凭据').props.value, 'fake-requester-one-time-secret');
  await update({ show: false });
  await update();
  assert.equal(
    rendered.root.findAll((node) => node.props['aria-label'] === '一次性原生发起凭据').length,
    0,
  );
  assert.equal(writes().length, 1);
});

test('unknown issue survives dismissal and confirms original body/key without repeat token reveal', async () => {
  route = async (_, options) => {
    if (options.method === 'POST') throw new Error('response lost');
    return { items };
  };
  await mount();
  await ready();
  await click('明确开通原生发起凭据');
  const original = writes()[0];
  await update({ show: false });
  await update({ preview: null, shareConfirmed: false });
  assert.ok(text(rendered.toJSON()).includes('结果未知'));
  route = async (_, options) =>
    options.method === 'POST' ? { credential: credential(), token: null } : { items };
  await click('确认原 Agent 协助操作');
  assert.equal(writes().length, 2);
  assert.equal(writes()[1].options.body, original.options.body);
  assert.equal(
    writes()[1].options.headers['Idempotency-Key'],
    original.options.headers['Idempotency-Key'],
  );
  assert.ok(text(rendered.toJSON()).includes('密钥不会再次返回'));
  assert.ok(!button('确认原 Agent 协助操作'));
});

test('metadata refresh failure preserves authorization input and blocks a new issue', async () => {
  await mount();
  await ready();
  const entered = field('原生发起凭据到期时间 UTC').props.value;
  route = async () => {
    throw new Error('transient read');
  };
  await click('刷新原生发起凭据');
  assert.equal(field('原生发起凭据到期时间 UTC').props.value, entered);
  assert.equal(button('明确开通原生发起凭据').props.disabled, true);
  assert.ok(text(rendered.toJSON()).includes('授权输入已保留'));
});

test('revoke has a separate explicit confirmation, fixed revision and immediately clears secret', async () => {
  await mount();
  await ready();
  await click('明确开通原生发起凭据');
  await click('撤销原生发起凭据');
  assert.equal(writes().length, 1);
  await click('保留原生发起凭据');
  assert.equal(writes().length, 1);
  await click('撤销原生发起凭据');
  await click('确认撤销原生发起凭据');
  assert.equal(writes().length, 2);
  assert.equal(
    writes()[1].path,
    '/api/v1/tasks/task/agent-requester-credentials/credential/revoke',
  );
  assert.deepEqual(JSON.parse(writes()[1].options.body), { expectedRevision: 1 });
  assert.equal(
    rendered.root.findAll((node) => node.props['aria-label'] === '一次性原生发起凭据').length,
    0,
  );
  assert.ok(text(rendered.toJSON()).includes('已撤销'));
});

test('current permission loss clears the requester secret and pending authorization', async () => {
  await mount();
  await ready();
  await click('明确开通原生发起凭据');
  route = async () => ({ status: 403, error: { code: 'FORBIDDEN', message: 'Access ended' } });
  await click('刷新原生发起凭据');
  assert.ok(text(rendered.toJSON()).includes('权限已撤销'));
  assert.equal(rendered.root.findAllByType('textarea').length, 0);
  assert.ok(!button('明确开通原生发起凭据'));
});

test('requester expiration removes one-time secret without another network response', async () => {
  route = async (_, options) => {
    if (options.method !== 'POST') return { items };
    const value = { ...credential(), expiresAt: new Date(Date.now() + 50).toISOString() };
    items = [value];
    return { credential: value, token: 'fake-short-lived-secret' };
  };
  await mount();
  await ready();
  await click('明确开通原生发起凭据');
  assert.equal(field('一次性原生发起凭据').props.value, 'fake-short-lived-secret');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 70));
  });
  assert.equal(
    rendered.root.findAll((node) => node.props['aria-label'] === '一次性原生发起凭据').length,
    0,
  );
});

test('drawer-closed unknown requester issuance is cleared by current task authorization loss', async () => {
  route = async (_, options) => {
    if (options.method === 'POST') throw new Error('unknown');
    return { items };
  };
  await mount();
  await ready();
  await click('明确开通原生发起凭据');
  await update({ show: false });
  globalThis.__canEdit = false;
  globalThis.__app = { ...globalThis.__app, version: 2 };
  await update({ show: false });
  globalThis.__canEdit = true;
  await update();
  assert.ok(text(rendered.toJSON()).includes('权限已撤销'));
  assert.ok(!button('确认原 Agent 协助操作'));
  assert.equal(writes().length, 1);
});
