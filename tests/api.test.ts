import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../apps/control/src/app.js';
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
test('HTTP 轻量创建、评论、完成与读取闭环', async () => {
  const app = await createApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces/space-demo/tasks',
      headers: headers(),
      payload: { title: 'API 新任务' },
    });
    assert.equal(created.statusCode, 201);
    const task = created.json();
    const comment = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/messages`,
      headers: headers(),
      payload: { body: '内容已保存' },
    });
    assert.equal(comment.statusCode, 201);
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/complete`,
      headers: headers(),
      payload: { expectedRevision: 1 },
    });
    assert.equal(completed.json().status, 'done');
    const detail = await app.inject(`/api/v1/tasks/${task.id}`);
    assert.equal(detail.json().messages[0].body, '内容已保存');
  } finally {
    await app.close();
  }
});
test('拒绝跨站、DNS rebinding 和无标识写请求', async () => {
  const app = await createApp();
  try {
    for (const input of [
      { url: '/api/v1/workbench', headers: { host: 'evil.example' } },
      { url: '/api/v1/workbench', headers: { origin: 'https://evil.example' } },
      { method: 'POST' as const, url: '/api/v1/spaces/space-demo/tasks', payload: { title: 'no' } },
    ])
      assert.equal((await app.inject(input)).statusCode, 403);
  } finally {
    await app.close();
  }
});
test('请求验证与 409 并发更新', async () => {
  const app = await createApp();
  try {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/spaces/space-demo/tasks',
          headers: headers(),
          payload: { title: ' ' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/tasks/task-24',
          headers: headers(),
          payload: { expectedRevision: 99, title: '覆盖' },
        })
      ).statusCode,
      409,
    );
    assert.equal((await app.inject('/api/v1/spaces/space-demo/tasks?limit=-1')).statusCode, 400);
  } finally {
    await app.close();
  }
});
test('明确拒绝未接通的原生工具', async () => {
  const app = await createApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/task-24/runs',
      headers: headers(),
      payload: { provider: 'native', requestedTool: 'codex', expectedRevision: 1 },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'CAPABILITY_UNAVAILABLE');
  } finally {
    await app.close();
  }
});
test('模拟执行可真实进入等待、被拒绝并保持任务未完成', async () => {
  const app = await createApp({ stepMs: 10 });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/task-24/runs',
      headers: headers(),
      payload: {
        provider: 'mock',
        requestedTool: 'codex',
        scenario: 'waiting_approval',
        expectedRevision: 1,
      },
    });
    const id = response.json().id;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await app.inject(`/api/v1/runs/${id}`)).json().state, 'waiting_approval');
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${id}/authorization`,
      headers: headers(),
      payload: { decision: 'deny' },
    });
    assert.equal(denied.json().state, 'failed');
    assert.equal((await app.inject('/api/v1/tasks/task-24')).json().task.status, 'in_progress');
  } finally {
    await app.close();
  }
});
