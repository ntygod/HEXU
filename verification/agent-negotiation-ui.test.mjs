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
const hash = 'a'.repeat(64),
  target = {
    participantId: 'agent-b',
    capabilityId: 'cap-b',
    capabilityVersion: 1,
    endpointRevision: 1,
    grantId: 'g-b',
    grantRevision: 1,
  };
const source = {
  messageId: 'msg',
  sourceHash: hash,
  taskRevision: 1,
  content: 'Fixed message for sharing.',
  truncated: false,
  actorType: 'human',
  actorName: 'Requester',
  createdAt: '2026-10-08T00:00:00.000Z',
};
const input = {
  question: 'Question',
  clarification: null,
  message: { sourceMessageId: 'msg', expectedSourceHash: hash, range: { start: 0, end: 5 } },
  projectTexts: { items: [], expectedHash: hash },
};
const task = { id: 'task', projectId: 'project', visibility: 'project', revision: 1 };
const detail = () => ({
  assistance: {
    id: 'help',
    recipientKind: 'agent',
    requester: { id: 'u-a', name: 'Requester' },
    recipient: { id: 'u-b', name: 'Recipient' },
    question: 'Question',
    state: 'open',
    revision: 1,
    canReply: true,
    canManage: false,
    canAdopt: false,
    canEditTask: false,
    accessEnded: false,
    taskLink: null,
    sourceChanged: null,
    snapshot: { text: 'Fixed', actorName: 'Requester', createdAt: '' },
    snapshotHash: hash,
    agent: {
      ...target,
      recipientParticipantId: 'agent-b',
      requesterParticipantId: 'agent-a',
      requestId: 'request',
      currentInputRevision: 1,
      accessRevision: 1,
      inputHash: hash,
      phase: 'awaiting_acceptance',
      terminalReason: null,
      clarification: null,
      materials: [{ id: 'material-1', label: '已分享消息摘录', text: 'Fixed' }],
      responses: [],
      pendingResponseId: null,
    },
  },
  replies: [],
  nextBefore: null,
});
let rendered, calls, route;
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function mount(node) {
  await act(async () => {
    rendered = create(node);
    await flush();
  });
}
const text = (node) =>
  typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
const button = (label) =>
  rendered.root.findAllByType('button').find((n) => text(n).trim() === label);
const field = (label) => rendered.root.find((n) => n.props['aria-label'] === label);
async function click(label) {
  const node = button(label);
  assert.ok(node, `button ${label}`);
  assert.ok(!node.props.disabled, `${label} disabled`);
  await act(async () => {
    node.props.onClick?.();
    await flush();
  });
}
async function change(label, value) {
  await act(async () => {
    field(label).props.onChange({ target: { value } });
    await flush();
  });
}
async function submit() {
  await act(async () => {
    rendered.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} });
    await flush();
  });
}
beforeEach(() => {
  calls = [];
  globalThis.__app = {
    data: { user: { id: 'u-b' }, tasks: [task] },
    version: 1,
    refresh: async () => {},
  };
  route = async (path, options) => {
    if (path.includes('/messages/')) return source;
    if (path.includes('/agent-capabilities'))
      return {
        items: [
          {
            ...target,
            participantName: 'Recipient',
            title: 'Text expertise',
            canRequest: true,
            callable: false,
            hexuIntegration: 'not_integrated',
          },
        ],
      };
    if (path.endsWith('/agent-participants')) return { items: [] };
    if (path.includes('/sources'))
      return {
        items: [
          {
            id: 'src',
            kind: 'text',
            title: 'Approved text',
            revision: 1,
            contentHash: hash,
            deletedAt: null,
          },
          { id: 'link', kind: 'link', title: 'Do not include', url: 'https://example.test' },
        ],
        nextCursor: null,
      };
    if (path.endsWith('/agent-assistance-preview')) {
      const b = JSON.parse(options.body);
      return {
        ...b,
        input: { ...b.input, projectTexts: { ...b.input.projectTexts, expectedHash: hash } },
        expectedTaskRevision: 1,
        inputHash: hash,
        materials: [{ id: 'material-1', label: '消息', text: 'Fixed' }],
      };
    }
    return detail();
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

test('create previews fixed message and only plain text, then explicit confirmation submits normalized input', async () => {
  let saved;
  await mount(
    React.createElement(
      UI.AgentAssistanceProvider,
      {},
      React.createElement(UI.AgentAssistanceEditor, {
        task,
        messageId: 'msg',
        onSaved: (id) => (saved = id),
      }),
    ),
  );
  await change('当前可请求能力', 'cap-b:g-b');
  await change('Agent 协助问题', 'Question');
  await act(async () =>
    field('Agent 消息选区').props.onSelect({
      currentTarget: { selectionStart: 0, selectionEnd: 5 },
    }),
  );
  await click('使用 Agent 分享选区');
  assert.ok(!text(rendered.toJSON()).includes('Do not include'));
  await click('预览完整分享内容');
  const consent = rendered.root
    .findAllByType('input')
    .find((n) => n.props.type === 'checkbox' && text(n.parent).includes('我已核对双方'));
  await act(async () => consent.props.onChange({ target: { checked: true } }));
  await submit();
  assert.equal(saved, 'help');
  const createCall = calls.find((c) => c.path.endsWith('/agent-assistances'));
  assert.ok(createCall);
  const body = JSON.parse(createCall.options.body);
  assert.equal(body.input.projectTexts.expectedHash, hash);
  assert.equal(body.shareConfirmed, true);
  assert.equal(body.requesterParticipantId, null);
  assert.deepEqual(body.input.message.range, { start: 0, end: 5 });
  assert.ok(!('actor' in body));
});

test('recipient typed response double submit is guarded, carries all frozen revisions and no parent link', async () => {
  let resolveWrite;
  route = (path) =>
    path.endsWith('/responses') ? new Promise((r) => (resolveWrite = r)) : detail();
  await mount(
    React.createElement(
      UI.AgentAssistanceProvider,
      {},
      React.createElement(UI.AgentAssistanceThread, {
        value: detail(),
        readError: '',
        onRetry() {},
      }),
    ),
  );
  assert.ok(!rendered.root.findAllByType('a').some((a) => a.props.href.startsWith('/tasks/')));
  await act(async () => {
    const f = rendered.root.findByType('form');
    f.props.onSubmit({ preventDefault() {} });
    f.props.onSubmit({ preventDefault() {} });
    await flush();
  });
  assert.equal(calls.filter((c) => c.path.endsWith('/responses')).length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.type, 'accept');
  assert.equal(body.inputRevision, 1);
  assert.equal(body.expectedAccessRevision, 1);
  assert.equal(body.expectedInputHash, hash);
  await act(async () => {
    resolveWrite(detail());
    await flush();
  });
});

test('uncertain packet survives dismissal under Provider and replays exact body and key', async () => {
  let hook;
  function Probe() {
    hook = UI.useAgentAssistanceCommand('response:help', () => {});
    return null;
  }
  function Tree({ show }) {
    return React.createElement(
      UI.AgentAssistanceProvider,
      {},
      show ? React.createElement(Probe) : null,
    );
  }
  route = async () => {
    throw new Error('connection lost');
  };
  await mount(React.createElement(Tree, { show: true }));
  await act(async () => {
    await hook.send('/assistances/help/responses', { type: 'accept', expectedRevision: 1 });
  });
  assert.ok(hook.pending);
  await act(async () => rendered.update(React.createElement(Tree, { show: false })));
  await act(async () => rendered.update(React.createElement(Tree, { show: true })));
  assert.ok(hook.pending);
  route = async () => detail();
  await act(async () => {
    await hook.confirm();
  });
  const writes = calls.filter((c) => c.options.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].options.body, writes[1].options.body);
  assert.equal(
    writes[0].options.headers['Idempotency-Key'],
    writes[1].options.headers['Idempotency-Key'],
  );
  assert.equal(hook.pending, null);
});

test('different business requests are not serialized by one pending packet', async () => {
  let a, b;
  function Probe() {
    a = UI.useAgentAssistanceCommand('create:a', () => {});
    b = UI.useAgentAssistanceCommand('create:b', () => {});
    return null;
  }
  route = async (path) => {
    if (path === '/api/v1/a') throw new Error('unknown');
    return detail();
  };
  await mount(React.createElement(UI.AgentAssistanceProvider, {}, React.createElement(Probe)));
  await act(async () => {
    await a.send('/a', { fixed: 'a' });
    await b.send('/b', { fixed: 'b' });
  });
  assert.ok(a.pending);
  assert.equal(b.pending, null);
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/api/v1/a', '/api/v1/b'],
  );
});

test('response draft keeps baseline across newer input; explicit comparison is required', async () => {
  const value = detail();
  value.assistance.agent.phase = 'accepted';
  await mount(
    React.createElement(UI.AgentAssistanceThread, { value, readError: '', onRetry() {} }),
  );
  await change('Agent 回应类型', 'answer');
  await change('Agent 回应正文', 'My saved draft');
  const latest = structuredClone(value);
  latest.assistance.revision = 2;
  latest.assistance.agent.currentInputRevision = 2;
  await act(async () =>
    rendered.update(
      React.createElement(UI.AgentAssistanceThread, {
        value: latest,
        readError: 'Transient read failure',
        onRetry() {},
      }),
    ),
  );
  assert.equal(field('Agent 回应正文').props.value, 'My saved draft');
  assert.equal(button('保存回答').props.disabled, true);
  assert.ok(text(rendered.toJSON()).includes('原输入修订 1'));
  await act(async () =>
    rendered.update(
      React.createElement(UI.AgentAssistanceThread, { value: latest, readError: '', onRetry() {} }),
    ),
  );
  await click('已比较当前输入，保留正文');
  await submit();
  assert.equal(JSON.parse(calls[0].options.body).inputRevision, 2);
});

test('scope proposal cannot deselect the required message and never offers new material input', async () => {
  await mount(
    React.createElement(UI.AgentAssistanceThread, { value: detail(), readError: '', onRetry() {} }),
  );
  await change('Agent 回应类型', 'propose_scope');
  const input = rendered.root.findAllByType('input').find((n) => n.props.type === 'checkbox');
  assert.equal(input.props.disabled, true);
  assert.equal(input.props.checked, true);
  await change('Agent 回应正文', 'Consider a narrower question');
  await change('提议问题', 'Narrow question');
  await submit();
  assert.deepEqual(JSON.parse(calls[0].options.body).scope.materialIds, ['material-1']);
});

test('lost request authority clears visible content and pending packet', async () => {
  const value = detail();
  await mount(
    React.createElement(UI.AgentAssistanceThread, { value, readError: '', onRetry() {} }),
  );
  await change('Agent 回应类型', 'request_input');
  await change('Agent 回应正文', 'Private draft');
  const revoked = structuredClone(value);
  revoked.assistance.accessEnded = true;
  revoked.assistance.canReply = false;
  await act(async () =>
    rendered.update(
      React.createElement(UI.AgentAssistanceThread, {
        value: revoked,
        readError: '',
        onRetry() {},
      }),
    ),
  );
  assert.ok(!text(rendered.toJSON()).includes('Private draft'));
  assert.ok(text(rendered.toJSON()).includes('授权已结束'));
});

test('credential token is one-time local UI state and never survives remount', async () => {
  const agent = { ...detail().assistance.agent, canIssueCredential: true, credential: null };
  route = async () => ({
    credential: {
      id: 'cred',
      revision: 1,
      scopes: ['material_read'],
      expiresAt: '2026-10-09T00:00:00.000Z',
      revokedAt: null,
    },
    token: 'fake-request-bound-token',
  });
  function Tree({ show }) {
    return React.createElement(
      UI.AgentAssistanceProvider,
      {},
      show
        ? React.createElement(UI.AgentAssistanceCredentials, { id: 'help', agent, onSaved() {} })
        : null,
    );
  }
  await mount(React.createElement(Tree, { show: true }));
  await change('凭据到期时间 UTC', '2026-10-09T00:00');
  const check = rendered.root
    .findAllByType('input')
    .find((n) => n.props.type === 'checkbox' && text(n.parent).includes('我作为'));
  await act(async () => check.props.onChange({ target: { checked: true } }));
  await click('开通本请求凭据');
  assert.ok(text(rendered.toJSON()).includes('fake-request-bound-token'));
  await act(async () => rendered.update(React.createElement(Tree, { show: false })));
  await act(async () => rendered.update(React.createElement(Tree, { show: true })));
  assert.ok(!text(rendered.toJSON()).includes('fake-request-bound-token'));
  assert.equal(JSON.parse(calls[0].options.body).expectedRevision, 0);
});

test('rotation secret remains visible while metadata GET still has preceding revision', async () => {
  const oldCredential = {
    id: 'cred',
    revision: 1,
    scopes: ['material_read'],
    expiresAt: '2026-10-09T00:00:00.000Z',
    revokedAt: null,
  };
  const agent = {
    ...detail().assistance.agent,
    canIssueCredential: true,
    credential: oldCredential,
  };
  route = async () => ({
    credential: { ...oldCredential, revision: 2 },
    token: 'fake-rotated-token',
  });
  await mount(
    React.createElement(UI.AgentAssistanceCredentials, { id: 'help', agent, onSaved() {} }),
  );
  await change('凭据到期时间 UTC', '2026-10-09T00:00');
  const check = rendered.root
    .findAllByType('input')
    .find((n) => n.props.type === 'checkbox' && text(n.parent).includes('我作为'));
  await act(async () => check.props.onChange({ target: { checked: true } }));
  await click('轮换本请求凭据');
  assert.ok(text(rendered.toJSON()).includes('fake-rotated-token'));
  await act(async () =>
    rendered.update(
      React.createElement(UI.AgentAssistanceCredentials, {
        id: 'help',
        agent: { ...agent, credential: { ...oldCredential, revision: 2 } },
        onSaved() {},
      }),
    ),
  );
  assert.ok(text(rendered.toJSON()).includes('fake-rotated-token'));
  await act(async () =>
    rendered.update(
      React.createElement(UI.AgentAssistanceCredentials, {
        id: 'help',
        agent: { ...agent, credential: { ...oldCredential, revision: 3 } },
        onSaved() {},
      }),
    ),
  );
  assert.ok(!text(rendered.toJSON()).includes('fake-rotated-token'));
});

test('collapsed unknown packet is cleared by request-level access revocation', async () => {
  let hook;
  function Probe() {
    hook = UI.useAgentAssistanceCommand('respond:help', () => {});
    return null;
  }
  function Tree({ show }) {
    return React.createElement(
      UI.AgentAssistanceProvider,
      {},
      show ? React.createElement(Probe) : null,
    );
  }
  route = async (path, options) => {
    if (options.method === 'POST') throw new Error('unknown');
    return detail();
  };
  await mount(React.createElement(Tree, { show: true }));
  await act(async () => {
    await hook.send('/assistances/help/responses', { type: 'accept' });
    await flush();
  });
  assert.ok(hook.pending);
  await act(async () => rendered.update(React.createElement(Tree, { show: false })));
  route = async () => ({ error: { code: 'NOT_FOUND', message: 'No access' }, status: 404 });
  globalThis.__app = { ...globalThis.__app, version: 2 };
  await act(async () => {
    rendered.update(React.createElement(Tree, { show: false }));
    await flush();
  });
  await act(async () => rendered.update(React.createElement(Tree, { show: true })));
  assert.equal(hook.pending, null);
  assert.equal(hook.denied, true);
});

test('ACK received while drawer is closed retains only assistance ID, never resends during recovery', async () => {
  let hook, finish;
  function Probe() {
    hook = UI.useAgentAssistanceCommand('create:task:msg', () => {});
    return null;
  }
  function Tree({ show }) {
    return React.createElement(
      UI.AgentAssistanceProvider,
      {},
      show ? React.createElement(Probe) : null,
    );
  }
  route = async (path, options) =>
    options.method === 'POST'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : source;
  await mount(React.createElement(Tree, { show: true }));
  let write;
  await act(async () => {
    write = hook.send('/tasks/task/agent-assistances', { fixed: 'input' });
    await flush();
  });
  await act(async () => rendered.update(React.createElement(Tree, { show: false })));
  await act(async () => {
    finish(detail());
    await write;
    await flush();
  });
  await act(async () => rendered.update(React.createElement(Tree, { show: true })));
  assert.equal(hook.receiptId, 'help');
  assert.equal(hook.pending, null);
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
  await act(async () => hook.forgetReceipt());
  assert.equal(hook.receiptId, undefined);
});
