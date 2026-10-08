// Focused React-renderer checks; no browser, real accounts, endpoints or model calls.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = { dispatchEvent() {} };
let rendered, calls, route;
const member = { id: 'u1', name: 'Owner', email: 'owner@example.test' };
const agent = {
  id: 'a1',
  spaceId: 's1',
  ownerUserId: 'u1',
  name: 'Research Agent',
  nativeInstanceRef: null,
  revision: 1,
  revokedAt: null,
  createdAt: '',
  updatedAt: '',
  endpoint: {
    id: 'e1',
    participantId: 'a1',
    revision: 1,
    protocol: 'custom',
    address: 'https://agent.example.test/',
    implementation: 'Test',
    implementationVersion: '1',
    receiveMode: 'manual',
    authentication: 'not_integrated',
    lastVerifiedAt: null,
  },
  capability: {
    id: 'c1',
    participantId: 'a1',
    endpointId: 'e1',
    version: 1,
    title: 'API expertise',
    description: 'Read-only text help',
    kind: 'text_expertise',
    input: 'text',
    output: 'text',
    providerSupport: 'unverified',
    hexuIntegration: 'not_integrated',
  },
  grants: [],
};
const listing = {
  participantId: 'a1',
  participantName: 'Research Agent',
  ownerUserId: 'u1',
  capabilityId: 'c1',
  capabilityVersion: 1,
  title: 'API expertise',
  description: 'Read-only text',
  kind: 'text_expertise',
  providerSupport: 'unverified',
  hexuIntegration: 'not_integrated',
  authorizationEnvironment: 'unverified',
  canRequest: true,
  autoAccept: false,
  callable: false,
  blocker: '真实端点尚未接入',
  grantId: 'g1',
  grantRevision: 1,
  expiresAt: '2027-01-01T00:00:00.000Z',
  maxConcurrent: 1,
  costBearerUserId: 'u1',
};
beforeEach(() => {
  calls = [];
  route = async (path) =>
    path.endsWith('/agent-participants')
      ? { items: [agent] }
      : path.endsWith('/members')
        ? { items: [member] }
        : { items: [listing] };
  globalThis.__testApp = {
    data: {
      mode: 'team-local',
      user: member,
      members: [member],
      projects: [{ id: 'p1', spaceId: 's1', name: 'Project', access: 'edit' }],
    },
    version: 1,
  };
  globalThis.fetch = async (path, opts) => {
    calls.push({ path, ...opts });
    const value = await route(path, opts);
    return { ok: true, status: 200, json: async () => value };
  };
});
afterEach(async () => {
  if (rendered) await act(async () => rendered.unmount());
  rendered = null;
});
async function mount(element) {
  await act(async () => {
    rendered = create(element);
  });
  return rendered.root;
}
const text = () => JSON.stringify(rendered.toJSON());
const button = (label) =>
  rendered.root.findAllByType('button').find((b) => b.children.join('') === label);
const click = async (label) => {
  const b = button(label);
  assert.ok(b, `button ${label}`);
  assert.ok(!b.props.disabled, `enabled ${label}`);
  await act(async () => b.props.onClick?.({}));
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
test('preview never loads or registers account Agents', async () => {
  globalThis.__testApp.data.mode = 'local-preview';
  await mount(React.createElement(AgentResources));
  assert.match(text(), /示例身份不能登记真实 Agent/);
  assert.equal(calls.length, 0);
  assert.equal(rendered.root.findAllByType('button').length, 0);
});
test('multiple owned Agents, explicit three dimensions, endpoint and fixed capability editing', async () => {
  route = async () => ({ items: [agent, { ...agent, id: 'a2', name: 'Second Agent' }] });
  await mount(React.createElement(AgentResources));
  assert.match(text(), /Second Agent/);
  for (const label of ['提供方支持', 'HEXU 接入', '当前授权与环境', '不可调用'])
    assert.ok(text().includes(label));
  await click('登记独立端点');
  const inputs = rendered.root.findAllByType('input');
  assert.ok(
    inputs.some(
      (i) => i.props.name === 'address' && i.props.defaultValue === agent.endpoint.address,
    ),
  );
  assert.match(text(), /不会登录、探测或授予持续访问/);
  await click('取消编辑');
  await click('编辑文本专业能力');
  assert.equal(rendered.root.findByType('textarea').props.defaultValue, 'Read-only text help');
});
test('grant editor requires explicit project, members, expiry and bounded owner costs', async () => {
  await mount(React.createElement(AgentResources));
  await click('开放项目能力');
  const project = rendered.root.findAllByType('select')[0];
  await act(async () => project.props.onChange({ target: { value: 'p1' } }));
  assert.ok(
    rendered.root
      .findAllByType('input')
      .some((i) => i.props.name === 'requesterUserIds' && i.props.value === 'u1'),
  );
  assert.ok(
    rendered.root
      .findAllByType('input')
      .some((i) => i.props.name === 'expiresAt' && i.props.required),
  );
  const concurrency = rendered.root
    .findAllByType('input')
    .find((i) => i.props.name === 'maxConcurrent');
  assert.equal(concurrency.props.max, 4);
  assert.match(text(), /费用由 Agent 所有者/);
  assert.match(text(), /不授予执行、目录写入或任何外部影响权限/);
});
test('unknown writes retain exact packet/key; duplicate click locked; accepted refresh performs GET only', async () => {
  let hook;
  let accepted = 0;
  const wait = deferred();
  route = async () => wait.promise;
  function Probe() {
    hook = useAgentWrite(
      () => {
        accepted++;
        void fetch('/api/v1/agent-participants', { method: 'GET' });
      },
      () => {},
    );
    return null;
  }
  await mount(React.createElement(Probe));
  const input = {
    path: '/agent-participants',
    method: 'POST',
    body: { name: 'first', nativeInstanceRef: null },
  };
  let pending;
  await act(async () => {
    pending = hook.submit(input);
    void hook.submit({ ...input, body: { name: 'second' } });
  });
  assert.equal(calls.length, 1);
  await act(async () => {
    wait.reject(new Error('lost response'));
    await pending;
  });
  assert.ok(hook.pending);
  input.body.name = 'mutated';
  route = async () => agent;
  await act(async () => hook.submit({ ...input, body: { name: 'different' } }));
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  assert.match(calls[1].body, /first/);
  assert.equal(accepted, 1);
  assert.equal(calls[2].method, 'GET');
  assert.equal(hook.pending, null);
});
test('definitive access denial clears fixed packet and invokes revocation callback', async () => {
  let hook,
    denied = 0;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { code: 'FORBIDDEN', message: 'revoked' } }),
  });
  function Probe() {
    hook = useAgentWrite(
      () => assert.fail('not accepted'),
      () => denied++,
    );
    return null;
  }
  await mount(React.createElement(Probe));
  await act(async () =>
    hook.submit({
      path: '/agent-participants/a1/revoke',
      method: 'POST',
      body: { expectedRevision: 1 },
    }),
  );
  assert.equal(denied, 1);
  assert.equal(hook.pending, null);
});
test('temporary reads retain value; superseded read cannot clear replacement', async () => {
  let hook;
  let version = 1;
  let load = async () => ({ name: 'initial' });
  function Probe() {
    hook = useAgentRead(load, version);
    return null;
  }
  await mount(React.createElement(Probe));
  assert.equal(hook.value.name, 'initial');
  load = async () => {
    throw new Error('offline');
  };
  await act(async () => hook.refresh());
  assert.equal(hook.value.name, 'initial');
  assert.equal(hook.error, 'offline');
  const old = deferred();
  load = () => old.promise;
  await act(async () => hook.refresh());
  load = async () => ({ name: 'new' });
  version++;
  await act(async () => rendered.update(React.createElement(Probe)));
  await act(async () => {
    old.resolve({ name: 'obsolete' });
    await old.promise;
  });
  assert.equal(hook.value.name, 'new');
});
test('directory selection is fixed-ID preparation, never starts assistance/model', async () => {
  route = async (path, opts) =>
    path.endsWith('/select')
      ? {
          projectId: 'p1',
          participantId: 'a1',
          capabilityId: 'c1',
          capabilityVersion: 1,
          grantId: 'g1',
          grantRevision: 1,
          callable: false,
          blocker: '未接入',
        }
      : { items: [listing] };
  await mount(React.createElement(ProjectAgentCapabilities, { projectId: 'p1' }));
  await click('选择并准备标识');
  assert.match(text(), /已准备能力标识，尚未发起协作/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/api/v1/projects/p1/agent-capabilities/c1/select');
  assert.equal(calls[1].body, JSON.stringify({ expectedVersion: 1 }));
  await click('清除选择');
  assert.doesNotMatch(text(), /已准备能力标识，尚未发起协作/);
});
test('preview project has no discovery and no fabricated callable entries', async () => {
  globalThis.__testApp.data.mode = 'local-preview';
  await mount(React.createElement(ProjectAgentCapabilities, { projectId: 'p1' }));
  assert.equal(calls.length, 0);
  assert.match(text(), /示例项目不提供真实账号/);
});

test('unknown packet survives route unmount and reuses the original key on recovery', async () => {
  let hook;
  let visible = true;
  route = async () => {
    throw new Error('lost response');
  };
  function Page() {
    hook = useAgentWrite(
      () => {},
      () => {},
    );
    return null;
  }
  function Shell() {
    return React.createElement(
      AgentRequestProvider,
      null,
      visible ? React.createElement(Page) : null,
    );
  }
  await mount(React.createElement(Shell));
  await act(async () =>
    hook.submit({
      path: '/agent-participants',
      method: 'POST',
      body: { name: 'once', nativeInstanceRef: null },
    }),
  );
  const fixed = hook.pending;
  assert.ok(fixed);
  visible = false;
  await act(async () => rendered.update(React.createElement(Shell)));
  visible = true;
  await act(async () => rendered.update(React.createElement(Shell)));
  assert.equal(hook.pending.key, fixed.key);
  route = async () => agent;
  await act(async () =>
    hook.submit({
      path: '/agent-participants',
      method: 'POST',
      body: { name: 'replacement', nativeInstanceRef: null },
    }),
  );
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
});
test('replacing identity provider clears old packets and ignores old acknowledgements', async () => {
  let hook;
  let owner = 'u1';
  const wait = deferred();
  route = async () => wait.promise;
  function Page() {
    hook = useAgentWrite(
      () => {},
      () => {},
    );
    return null;
  }
  function Shell() {
    return React.createElement(AgentRequestProvider, { key: owner }, React.createElement(Page));
  }
  await mount(React.createElement(Shell));
  let sent;
  await act(async () => {
    sent = hook.submit({
      path: '/agent-participants',
      method: 'POST',
      body: { name: 'old', nativeInstanceRef: null },
    });
  });
  owner = 'u2';
  await act(async () => rendered.update(React.createElement(Shell)));
  assert.equal(hook.pending, null);
  await act(async () => {
    wait.resolve(agent);
    await sent;
  });
  assert.equal(hook.pending, null);
});
async function submitForm(values) {
  const Original = globalThis.FormData;
  globalThis.FormData = class {
    get(k) {
      const v = values[k];
      return Array.isArray(v) ? v[0] : (v ?? null);
    }
    getAll(k) {
      const v = values[k];
      return v == null ? [] : Array.isArray(v) ? v : [v];
    }
    has(k) {
      return values[k] != null;
    }
  };
  try {
    await act(async () =>
      rendered.root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: {} }),
    );
  } finally {
    globalThis.FormData = Original;
  }
}
test('registration submit uses current owner context without client supplied owner IDs', async () => {
  route = async (path, opts) => (opts.method === 'POST' ? agent : { items: [agent] });
  await mount(React.createElement(AgentRequestProvider, null, React.createElement(AgentResources)));
  await click('登记 Agent');
  await submitForm({ name: 'New Agent', nativeInstanceRef: 'native-reference' });
  const write = calls.find((c) => c.method === 'POST');
  assert.equal(write.path, '/api/v1/agent-participants');
  assert.deepEqual(JSON.parse(write.body), {
    name: 'New Agent',
    nativeInstanceRef: 'native-reference',
  });
  assert.match(text(), /配置已保存/);
});
test('short-lived read connection explicitly confirms, displays once, never enters recovery packet', async () => {
  const token = 'test-only-not-a-live-secret';
  route = async (path, opts) =>
    path.endsWith('/connection') ? { agent, token } : { items: [agent] };
  await mount(React.createElement(AgentRequestProvider, null, React.createElement(AgentResources)));
  await click('开通或轮换只读连接');
  assert.match(text(), /最长|24 小时/);
  const select = rendered.root.findAllByType('select')[0];
  await act(async () => select.props.onChange({ target: { value: 'p1' } }));
  assert.ok(button('确认开通或轮换'));
  await submitForm({ expiresAt: '2026-10-08T12:00' });
  const write = calls.find((c) => c.method === 'POST');
  assert.equal(write.path, '/api/v1/agent-participants/a1/connection');
  assert.deepEqual(JSON.parse(write.body), {
    expectedRevision: 0,
    projectId: 'p1',
    expiresAt: new Date('2026-10-08T12:00').toISOString(),
  });
  const secret = rendered.root.findAllByType('textarea').find((n) => n.props.readOnly);
  assert.equal(secret.props.value, token);
  assert.ok(!calls.some((c) => c.body?.includes(token)));
  await click('隐藏并清除凭据');
  assert.ok(!rendered.root.findAllByType('textarea').some((n) => n.props.value === token));
});
test('connection replay without a token explains explicit rotation instead of false delivery', async () => {
  route = async (path, opts) =>
    path.endsWith('/connection') ? { agent, token: null } : { items: [agent] };
  await mount(React.createElement(AgentRequestProvider, null, React.createElement(AgentResources)));
  await click('开通或轮换只读连接');
  await act(async () =>
    rendered.root.findAllByType('select')[0].props.onChange({ target: { value: 'p1' } }),
  );
  await submitForm({ expiresAt: '2026-10-08T12:00' });
  assert.match(text(), /一次性凭据不可再次读取/);
  assert.match(text(), /请显式轮换/);
});
test('recovery rejection remains visible after the packet clears', async () => {
  let visible = true;
  function Shell() {
    return React.createElement(
      AgentRequestProvider,
      null,
      visible ? React.createElement(AgentResources) : null,
    );
  }
  route = async (path, options) => {
    if (options.method === 'POST') throw new Error('lost response');
    return { items: [agent] };
  };
  await mount(React.createElement(Shell));
  await click('登记 Agent');
  await submitForm({ name: 'Unknown', nativeInstanceRef: '' });
  visible = false;
  await act(async () => rendered.update(React.createElement(Shell)));
  visible = true;
  await act(async () => rendered.update(React.createElement(Shell)));
  assert.match(text(), /有一项原请求等待确认/);
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (path, options) =>
    options.method === 'POST'
      ? {
          ok: false,
          status: 409,
          json: async () => ({ error: { code: 'AUTHORIZATION_EXPIRED', message: '授权已经失效' } }),
        }
      : fetchOriginal(path, options);
  await click('核对原请求');
  assert.match(text(), /授权已经失效/);
  assert.doesNotMatch(text(), /有一项原请求等待确认/);
});
test('current project permission loss clears a closed grant packet on return', async () => {
  let visible = true;
  function Shell() {
    return React.createElement(
      AgentRequestProvider,
      null,
      visible ? React.createElement(AgentResources) : null,
    );
  }
  route = async (path, options) => {
    if (options.method === 'POST') throw new Error('lost response');
    return path.endsWith('/members') ? { items: [member] } : { items: [agent] };
  };
  await mount(React.createElement(Shell));
  await click('开放项目能力');
  await act(async () =>
    rendered.root.findAllByType('select')[0].props.onChange({ target: { value: 'p1' } }),
  );
  await submitForm({ requesterUserIds: ['u1'], expiresAt: '2026-10-09T12:00', maxConcurrent: '1' });
  assert.match(text(), /写入结果未知/);
  visible = false;
  await act(async () => rendered.update(React.createElement(Shell)));
  globalThis.__testApp.data.projects[0].access = 'view';
  visible = true;
  await act(async () => rendered.update(React.createElement(Shell)));
  assert.match(text(), /当前 Agent 或项目编辑权限已失效/);
  assert.doesNotMatch(text(), /有一项原请求等待确认/);
});
