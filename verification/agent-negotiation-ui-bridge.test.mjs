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
const temp = await mkdtemp(join(tmpdir(), 'hexu-negotiation-ui-'));
await build({
  stdin: {
    contents: `export { AgentAssistanceThread } from './apps/web/src/agent-assistance-thread.tsx'; export { AgentAssistanceEditor } from './apps/web/src/agent-assistance-create.tsx'; export { AgentAssistanceProvider, useAgentAssistanceCommand } from './apps/web/src/agent-assistance-state.tsx'; export { AgentAssistanceCredentials } from './apps/web/src/agent-assistance-credentials.tsx';`,
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
async function step(fn) {
  await act(async () => {
    await fn();
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
      if (dropCreate && path.endsWith('/agent-assistances') && response.statusCode === 201) {
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
  return {
    alice,
    bob,
    task,
    project,
    message,
    selection: resource.capability.id + ':' + resource.grants[0].id,
  };
}
async function createRequest(data, lose = false) {
  const { alice, task, message, selection } = data;
  context(alice, task);
  let id;
  await mount(
    React.createElement(UI.AgentAssistanceEditor, {
      task,
      messageId: message.id,
      onSaved: (value) => {
        id = value;
      },
    }),
  );
  await change('当前可请求能力', selection);
  await change('Agent 协助问题', 'Please review the chosen API question.');
  await step(() =>
    field('Agent 消息选区').props.onSelect({
      currentTarget: { selectionStart: 0, selectionEnd: 24 },
    }),
  );
  await click('使用 Agent 分享选区');
  await checked('Approved API note');
  await click('预览完整分享内容');
  assert.ok(text(rendered.toJSON()).includes('Only this approved project note.'));
  assert.ok(
    !text(rendered.root.find((n) => n.props['aria-label'] === 'Agent 完整分享预览')).includes(
      'Do not share the rest.',
    ),
  );
  await checked('我已核对双方');
  dropCreate = lose;
  await submit();
  if (lose) {
    assert.equal(id, undefined);
    await click('确认原 Agent 协助操作');
  }
  assert.ok(id, text(rendered.toJSON()));
  return id;
}

test('real UI journey: lost create receipt, typed clarification, immutable revised input, answer and request credential revocation', async () => {
  const data = await setup();
  const { alice, bob, task, project, message } = data;
  const id = await createRequest(data, true);
  const creates = calls.filter((c) => c.path.endsWith('/agent-assistances'));
  assert.equal(creates.length, 2);
  assert.equal(creates[0].body, creates[1].body);
  assert.equal(creates[0].key, creates[1].key);
  assert.equal(
    f.store.db.prepare('SELECT count(*) AS n FROM assistance_agent_requests').get().n,
    1,
  );
  await thread(id, bob, task);
  await submit();
  assert.equal((await read(id)).assistance.agent.phase, 'accepted');
  await thread(id, bob, task);
  await change('Agent 回应类型', 'request_input');
  await change('Agent 回应正文', 'Which API version is intended?');
  await submit();
  assert.equal((await read(id)).assistance.agent.phase, 'waiting_input');
  await unmount();
  context(alice, task);
  const original = await read(id);
  let revised = false;
  await mount(
    React.createElement(UI.AgentAssistanceEditor, {
      task,
      messageId: message.id,
      existing: original,
      onSaved: () => {
        revised = true;
      },
    }),
  );
  await change('本轮补充或范围确认', 'Version 2; keep only the explicitly approved material.');
  await click('预览完整分享内容');
  await checked('我已核对双方');
  await submit();
  assert.equal(revised, true);
  const second = await read(id);
  assert.equal(second.assistance.agent.currentInputRevision, 2);
  assert.equal(second.assistance.agent.phase, 'awaiting_acceptance');
  assert.equal(second.assistance.agent.responses[0].inputRevision, 1);
  await thread(id, bob, task);
  await submit();
  assert.equal((await read(id)).assistance.agent.phase, 'accepted');
  await thread(id, bob, task);
  await change('凭据到期时间 UTC', new Date(Date.now() + 1800_000).toISOString().slice(0, 16));
  await checked('另授予本请求');
  await checked('我作为此 Agent');
  await click('开通本请求凭据');
  const token = rendered.root
    .findAllByType('pre')
    .map((n) => text(n))
    .find((t) => t.startsWith('hexu_request_'));
  assert.ok(token);
  const requestId = (await read(id)).assistance.agent.requestId;
  const limited = await f.app.inject({
    url: `/agent-assistance/v1/requests/${requestId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(limited.statusCode, 200, limited.body);
  for (const hidden of [task.id, task.title, project.id, message.id, 'Do not share the rest.'])
    assert.equal(limited.body.includes(hidden), false, hidden);
  await thread(id, bob, task);
  await change('Agent 回应类型', 'answer');
  await change('Agent 回应正文', 'External text answer from the human owner, no model execution.');
  await submit();
  const answered = await read(id);
  assert.equal(answered.assistance.state, 'responded');
  assert.equal(answered.assistance.agent.responses.at(-1).type, 'answer');
  assert.equal(answered.assistance.agent.responses.at(-1).actor.kind, 'human');
  assert.equal(answered.assistance.agent.responses.at(-1).inputRevision, 2);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  await thread(id, alice, task);
  await click('撤销 Agent 分享');
  await click('确认撤销');
  assert.equal((await read(id)).assistance.state, 'cancelled');
  const denied = await f.app.inject({
    url: `/agent-assistance/v1/requests/${requestId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.ok([401, 403, 404].includes(denied.statusCode), denied.body);
});

test('real UI scope proposal stays pending until requester explicitly confirms a replacement input', async () => {
  const data = await setup();
  const { alice, bob, task, message } = data;
  const id = await createRequest(data);
  await thread(id, bob, task);
  await change('Agent 回应类型', 'propose_scope');
  await change('Agent 回应正文', 'Please narrow the question.');
  await change('提议问题', 'Only evaluate compatibility.');
  const boxes = rendered.root
    .findAllByType('input')
    .filter((n) => n.props.type === 'checkbox' && text(n.parent).includes('Approved API note'));
  assert.equal(boxes.length, 1);
  await step(() => boxes[0].props.onChange({ target: { checked: false } }));
  await submit();
  let pendingDetail = await read(id);
  assert.equal(pendingDetail.assistance.agent.phase, 'waiting_input');
  assert.equal(pendingDetail.assistance.agent.currentInputRevision, 1);
  assert.equal(pendingDetail.assistance.agent.materials.length, 2);
  await unmount();
  context(alice, task);
  pendingDetail = await read(id);
  await mount(
    React.createElement(UI.AgentAssistanceEditor, {
      task,
      messageId: message.id,
      existing: pendingDetail,
      onSaved() {},
    }),
  );
  await change('Agent 协助问题', 'Only evaluate compatibility.');
  await change(
    '本轮补充或范围确认',
    'I confirm the narrower question and remove the project note.',
  );
  await click('清除所选项目文本');
  await click('预览完整分享内容');
  await checked('我已核对双方');
  await submit();
  const confirmed = await read(id);
  assert.equal(confirmed.assistance.agent.currentInputRevision, 2);
  assert.equal(confirmed.assistance.agent.materials.length, 1);
  assert.equal(confirmed.assistance.agent.phase, 'awaiting_acceptance');
  assert.equal(confirmed.assistance.agent.responses.at(-1).scope.materialIds.length, 1);
});
