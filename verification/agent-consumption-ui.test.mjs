// Renderer-only projection checks. The read hook is a fixture; no browser claim.
import { test } from 'node:test';
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
const temp = await mkdtemp(join(tmpdir(), 'hexu-consumption-ui-'));
await build({
  entryPoints: [join(root, 'apps/web/src/agent-consumption.tsx')],
  outfile: join(temp, 'ui.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  plugins: [
    {
      name: 'fixtures',
      setup(b) {
        b.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
          path: require.resolve(args.path),
          external: true,
        }));
        b.onResolve({ filter: /assistance-common\.js$/ }, () => ({
          path: 'read',
          namespace: 'fixture',
        }));
        b.onResolve({ filter: /packages\/ui\/src\/index\.js$/ }, () => ({
          path: 'ui',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents:
            args.path === 'read'
              ? 'export const useAssistanceRead = () => globalThis.__read;'
              : "import React from 'react'; export const Button=p=>React.createElement('button',p);",
          loader: 'js',
        }));
      },
    },
  ],
});
const { AgentConsumptionStatus } = await import(join(temp, 'ui.mjs'));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const item = {
  requestId: 'request',
  binding: { id: 'binding', provider: 'codex', createdAt: 'now', cancelledAt: null },
  consumption: null,
};
async function render(value, error = '', denied = false) {
  globalThis.__read = { value, error, denied, retry() {} };
  let renderer;
  await act(async () => {
    renderer = create(
      React.createElement(AgentConsumptionStatus, { taskId: 'task', requestId: 'request' }),
    );
  });
  const result = JSON.stringify(renderer.toJSON());
  await act(async () => renderer.unmount());
  return result;
}
test('unbound and waiting states do not claim continued execution', async () => {
  assert.match(await render({ items: [] }), /尚未绑定原工作/);
  assert.match(await render({ items: [item] }), /等待回答或发起 Agent 取用/);
});
test('claim without ACK is explicitly unknown and cannot be replayed', async () => {
  const text = await render({
    items: [
      { ...item, consumption: { responseId: 'answer', inputRevision: 2, acknowledgement: null } },
    ],
  });
  assert.match(text, /后续使用尚未确认/);
  assert.match(text, /不重复启动/);
});
test('ACK displays self-reported output as plain text and cancellation stays cancelled', async () => {
  const text = await render({
    items: [
      {
        ...item,
        binding: { ...item.binding, cancelledAt: 'now' },
        consumption: {
          responseId: 'answer',
          inputRevision: 2,
          acknowledgement: {
            output: '<script>not executable</script>',
            late: true,
            cancelled: true,
          },
        },
      },
    ],
  });
  assert.match(text, /未来回接已取消/);
  assert.match(text, /迟到观测/);
  assert.match(text, /<script>not executable<\/script>/);
  assert.doesNotMatch(text, /"type":"script"/);
});
test('temporary read failure retains last observation and offers read-only retry', async () => {
  const text = await render({ items: [item] }, 'temporary failure');
  assert.match(text, /temporary failure/);
  assert.match(text, /重读回接记录/);
  assert.match(text, /等待回答/);
});
test('revoked projection hides prior source and output', async () => {
  const text = await render(
    {
      items: [
        {
          ...item,
          consumption: {
            responseId: 'secret-answer',
            inputRevision: 2,
            acknowledgement: { output: 'secret-output' },
          },
        },
      ],
    },
    'revoked',
    true,
  );
  assert.doesNotMatch(text, /secret-answer|secret-output/);
  assert.match(text, /revoked/);
});
test('unresolved initial read does not assert missing binding', async () => {
  const text = await render(null);
  assert.match(text, /正在核对/);
  assert.doesNotMatch(text, /尚未绑定原工作/);
});
test('late observation without cancellation is not mislabeled as cancelled', async () => {
  const text = await render({
    items: [
      {
        ...item,
        consumption: {
          responseId: 'answer',
          inputRevision: 2,
          acknowledgement: { output: 'later', late: true, cancelled: false },
        },
      },
    ],
  });
  assert.match(text, /请求结束或输入改变/);
  assert.doesNotMatch(text, /取消后的迟到观测/);
});
