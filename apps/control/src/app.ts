import { attachNodes } from './nodes.js';
import { createIdentity, type IdentityOptions } from '../../../packages/identity/src/index.js';
import { attachIdentity, identityHeaders } from './identity.js';
import { ContinuationCoordinator } from '../../runner/src/continuations.js';
import { parseContinuation } from '../../../packages/contracts/src/continuation.js';
import { NativeRuntime, type NativeOptions } from '../../runner/src/runtime.js';
import { parseNativeRunCreate } from '../../../packages/contracts/src/native.js';
import Fastify from 'fastify';
import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, relative, sep } from 'node:path';
import {
  DomainError,
  enumValue,
  parseRunCreate,
  parseTaskCreate,
  record,
  revision,
  text,
} from '../../../packages/contracts/src/index.js';
import { Store } from '../../../packages/db/src/store.js';
import { MockAdapter } from '../../../packages/adapters/mock/src/index.js';

export async function createApp(
  options: {
    databasePath?: string;
    store?: Store;
    port?: number;
    stepMs?: number;
    webRoot?: string;
    logger?: boolean;
    native?: NativeOptions;
    identity?: IdentityOptions;
  } = {},
) {
  if (options.identity && options.native?.enabled)
    throw new Error('团队模式不能启用宿主机原生执行；请等待独立节点授权。');
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.body.password',
            'req.body.currentPassword',
            'req.body.newPassword',
            'req.body.code',
            'req.body.token',
            'req.body.nodeToken',
          ],
        }
      : false,
    bodyLimit: 32768,
  });
  const store =
    options.store ?? new Store(options.databasePath, undefined, { team: !!options.identity });
  if (store.teamMode !== !!options.identity) throw new Error('数据模式与认证配置不一致');
  let identity;
  try {
    identity = options.identity ? await createIdentity(options.identity) : null;
  } catch (error) {
    store.close();
    throw error;
  }
  store.recoverMockRuns();
  const mock = new MockAdapter(store, options.stepMs);
  const native = new NativeRuntime(
    store,
    store.teamMode ? { enabled: false, roots: [] } : options.native,
  );
  try {
    if (!store.teamMode) await native.initialize();
  } catch (error) {
    identity?.close();
    store.close();
    throw error;
  }
  const continuations = new ContinuationCoordinator(store, native);
  const streams = new Set<ServerResponse>();
  const webRoot = resolve(options.webRoot ?? 'apps/web/dist');
  const allowedOrigins = new Set([
    `http://127.0.0.1:${options.port ?? 4310}`,
    `http://localhost:${options.port ?? 4310}`,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);
  const param = (value: unknown, name: string) => text(record(value)[name], name, 150);
  const key = (headers: Record<string, unknown>) =>
    text(headers['idempotency-key'], '操作标识', 128);
  app.addHook('onRequest', async (request, reply) => {
    let hostname: string;
    try {
      hostname = new URL(`http://${request.headers.host ?? ''}`).hostname;
    } catch {
      throw new DomainError('INVALID_HOST', '无效访问地址', 403);
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname))
      throw new DomainError('LOCAL_ONLY', '当前版本仅支持本机开发预览', 403);
    const nodeProtocol = new URL(request.url, 'http://localhost').pathname.startsWith(
      '/runner/v1/',
    );
    if (nodeProtocol) {
      if (!store.teamMode)
        throw new DomainError('TEAM_MODE_REQUIRED', '节点配对仅在真实账号模式启用', 404);
      if (
        request.method !== 'POST' ||
        request.headers.origin ||
        request.headers.cookie ||
        request.headers['sec-fetch-site'] ||
        request.headers['x-hexu-runner'] !== '1' ||
        new URL(request.url, 'http://localhost').search
      )
        throw new DomainError(
          'NODE_CHANNEL_REQUIRED',
          '节点通道不接受浏览器会话、查询参数或非节点请求',
          403,
        );
    }
    if (
      !nodeProtocol &&
      identity &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !request.headers.origin
    )
      throw new DomainError('ORIGIN_REQUIRED', '认证模式的写入请求必须提供来源', 403);
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin))
      throw new DomainError('ORIGIN_REJECTED', '不允许跨站访问本地预览', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site')
      throw new DomainError('ORIGIN_REJECTED', '不允许跨站访问本地预览', 403);
    if (
      !nodeProtocol &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers['x-hexu-client'] !== 'web'
    )
      throw new DomainError('CLIENT_HEADER_REQUIRED', '缺少本地客户端标识', 403);
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer');
    if (request.url.startsWith('/api/') || nodeProtocol) reply.header('Cache-Control', 'no-store');
  });
  attachIdentity(app, store, identity);
  attachNodes(app, store);
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof DomainError;
    const statusCode =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = known
      ? error.status
      : typeof statusCode === 'number' && statusCode < 500
        ? statusCode
        : 500;
    if (status >= 500) request.log.error(error);
    reply.code(status).send({
      error: {
        code: known ? error.code : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
        message: known
          ? error.message
          : status === 500
            ? '服务暂时无法完成操作，数据未被清空'
            : '请求格式不正确',
        retryable: status >= 500,
      },
      requestId: request.id,
    });
  });
  app.get('/health', async () => ({
    status: 'ok',
    mode: store.teamMode ? 'team-local' : 'local-preview',
  }));
  app.get('/ready', async () => {
    store.db.prepare('SELECT 1').get();
    return { status: 'ready' };
  });
  app.get('/api/v1/me', async () => ({
    ...store.workbench().user,
    mode: store.teamMode ? 'team-local' : 'local-preview',
  }));
  app.get('/api/v1/workbench', async () => store.workbench());
  app.get('/api/v1/spaces/:spaceId/projects', async (request) => {
    if (param(request.params, 'spaceId') !== store.spaceId)
      throw new DomainError('NOT_FOUND', '工作空间不存在', 404);
    return { items: store.projects() };
  });
  app.post('/api/v1/spaces/:spaceId/projects', async (request, reply) => {
    if (param(request.params, 'spaceId') !== store.spaceId)
      throw new DomainError('NOT_FOUND', '工作空间不存在', 404);
    const body = record(request.body);
    return reply.code(201).send(
      store.createProject(
        {
          name: text(body.name, '项目名称', 100),
          description: text(body.description, '说明', 2000, true),
        },
        key(request.headers),
      ),
    );
  });
  app.get('/api/v1/projects/:projectId', async (request) =>
    store.project(param(request.params, 'projectId')),
  );
  app.get('/api/v1/spaces/:spaceId/tasks', async (request) => {
    if (param(request.params, 'spaceId') !== store.spaceId)
      throw new DomainError('NOT_FOUND', '工作空间不存在', 404);
    const query = record(request.query);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DomainError('INVALID_INPUT', 'limit 必须为 1–100');
    let items = store.tasks();
    if (query.projectId) {
      const id = text(query.projectId, '项目', 100);
      store.project(id);
      items = items.filter((task) => task.projectId === id);
    }
    if (query.q) {
      const q = text(query.q, '搜索', 160).toLocaleLowerCase();
      items = items.filter((task) =>
        (task.title + ' ' + task.description + ' ' + task.shortId).toLocaleLowerCase().includes(q),
      );
    }
    if (query.cursor) {
      const position = items.findIndex((task) => task.id === query.cursor);
      if (position < 0) throw new DomainError('INVALID_CURSOR', '列表已变化，请重新加载');
      items = items.slice(position + 1);
    }
    return {
      items: items.slice(0, limit),
      nextCursor: items.length > limit ? items[limit - 1]!.id : null,
    };
  });
  app.post('/api/v1/spaces/:spaceId/tasks', async (request, reply) => {
    if (param(request.params, 'spaceId') !== store.spaceId)
      throw new DomainError('NOT_FOUND', '工作空间不存在', 404);
    return reply
      .code(201)
      .send(store.createTask(parseTaskCreate(request.body), key(request.headers)));
  });
  app.get('/api/v1/tasks/:taskId', async (request) =>
    store.detail(param(request.params, 'taskId')),
  );
  app.patch('/api/v1/tasks/:taskId', async (request) => {
    const body = record(request.body);
    const data: {
      expectedRevision: number;
      title?: string;
      description?: string;
      attention?: string | null;
    } = { expectedRevision: revision(body.expectedRevision) };
    if (body.status !== undefined)
      throw new DomainError('INVALID_INPUT', '请使用明确的完成或重新打开操作');
    if (body.title !== undefined) data.title = text(body.title, '标题', 160);
    if (body.description !== undefined)
      data.description = text(body.description, '说明', 12000, true);
    if (body.attention !== undefined)
      data.attention = body.attention === null ? null : text(body.attention, '等待原因', 300, true);
    return store.patchTask(param(request.params, 'taskId'), data, key(request.headers));
  });
  for (const [action, status] of [
    ['complete', 'done'],
    ['reopen', 'todo'],
    ['start', 'in_progress'],
    ['cancel', 'cancelled'],
  ] as const) {
    app.post(`/api/v1/tasks/:taskId/${action}`, async (request) => {
      const id = param(request.params, 'taskId');
      const body = record(request.body);
      const choice = enumValue(
        body.activeRunAction ?? 'stop',
        ['stop', 'keep'] as const,
        '执行处理方式',
      );
      const result = store.changeTask(
        id,
        status,
        revision(body.expectedRevision),
        choice,
        key(request.headers),
      );
      mock.settleStops(id);
      native.settleStops(id);
      return result;
    });
  }
  app.get('/api/v1/tasks/:taskId/messages', async (request) => ({
    items: store.messages(param(request.params, 'taskId')),
  }));
  app.post('/api/v1/tasks/:taskId/messages', async (request, reply) => {
    const body = record(request.body);
    return reply
      .code(201)
      .send(
        store.addMessage(
          param(request.params, 'taskId'),
          text(body.body, '内容', 12000),
          body.resultId == null ? null : text(body.resultId, '成果', 100),
          key(request.headers),
        ),
      );
  });
  app.post('/api/v1/tasks/:taskId/runs', async (request, reply) => {
    if (record(request.body).provider === 'native') {
      const run = await native.create(
        param(request.params, 'taskId'),
        parseNativeRunCreate(request.body),
        key(request.headers),
      );
      return reply.code(201).send(run);
    }
    const run = store.createRun(
      param(request.params, 'taskId'),
      parseRunCreate(request.body),
      key(request.headers),
    );
    mock.start(run.id);
    return reply.code(201).send(run);
  });
  app.get('/api/v1/runs/:runId', async (request) => store.run(param(request.params, 'runId')));
  app.post('/api/v1/runs/:runId/stop', async (request) => {
    const id = param(request.params, 'runId');
    const run = store.stopRun(id, key(request.headers));
    if (run.provider === 'native') native.stop(id);
    else mock.stop(id);
    return run;
  });
  app.post('/api/v1/runs/:runId/inputs', async (request) => {
    const id = param(request.params, 'runId');
    if (store.run(id).provider === 'native')
      throw new DomainError(
        'CAPABILITY_UNAVAILABLE',
        '此原生适配不支持运行中输入；请在结束后继续',
        422,
      );
    const body = record(request.body);
    const run = store.resumeRun(
      id,
      text(body.body, '回复', 12000),
      true,
      key(request.headers),
      'waiting_input',
    );
    mock.resume(id);
    return run;
  });
  app.post('/api/v1/runs/:runId/authorization', async (request) => {
    const id = param(request.params, 'runId');
    const body = record(request.body);
    if (store.run(id).provider === 'native')
      throw new DomainError('CAPABILITY_UNAVAILABLE', '原生执行不允许通过模拟授权入口扩权', 422);
    const choice = enumValue(body.decision, ['allow', 'deny'] as const, '决定');
    const run = store.resumeRun(
      id,
      '',
      choice === 'allow',
      key(request.headers),
      'waiting_approval',
    );
    mock.resume(id);
    return run;
  });
  app.post('/api/v1/tasks/:taskId/continuations', async (request, reply) => {
    const operation = continuations.create(
      param(request.params, 'taskId'),
      parseContinuation(request.body),
      key(request.headers),
    );
    return reply.code(202).header('Location', `/api/v1/operations/${operation.id}`).send(operation);
  });
  app.get('/api/v1/tasks/:taskId/continuations', async (request) => ({
    items: continuations.records.list(param(request.params, 'taskId')),
  }));
  app.get('/api/v1/operations/:operationId', async (request) =>
    continuations.records.get(param(request.params, 'operationId')),
  );
  app.post('/api/v1/operations/:operationId/cancel', async (request) =>
    continuations.records.cancel(
      param(request.params, 'operationId'),
      revision(record(request.body).expectedRevision),
      key(request.headers),
    ),
  );
  app.get('/api/v1/tasks/:taskId/continuation-preview', async (request) =>
    native.continuationPreview(
      param(request.params, 'taskId'),
      text(record(request.query).sourceRunId, '来源执行', 100),
    ),
  );
  app.post('/api/v1/native/codex/models', async () => native.codexModels());
  app.get('/api/v1/native', async () => native.overview());
  app.get('/api/v1/tasks/:taskId/native-context', async (request) => ({
    text: native.context(param(request.params, 'taskId')),
  }));
  app.get('/api/v1/native/workspaces/:workingCopyId', async (request) =>
    native.workspaces.snapshot(param(request.params, 'workingCopyId')),
  );
  app.get('/api/v1/native/workspaces/:workingCopyId/diff', async (request) => {
    const value = await native.workspaces.diff(
      param(request.params, 'workingCopyId'),
      text(record(request.query).path, '文件', 1000),
    );
    return { ...value, text: native.clean(value.text) };
  });
  app.get('/api/v1/runs/:runId/native-events', async (request) => {
    const after = Number(record(request.query).after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new DomainError('INVALID_CURSOR', '无效事件游标');
    return { items: store.nativeEvents(param(request.params, 'runId'), after) };
  });
  app.get('/api/v1/results', async () => ({ items: store.results() }));
  app.get('/api/v1/results/:resultId', async (request) => {
    const result = store.result(param(request.params, 'resultId'));
    return {
      result,
      task: store.getTask(result.taskId),
      messages: store.messages(result.taskId).filter((message) => message.resultId === result.id),
    };
  });
  app.post('/api/v1/tasks/:taskId/results', async (request, reply) => {
    const body = record(request.body);
    return reply
      .code(201)
      .send(
        store.createResult(
          param(request.params, 'taskId'),
          text(body.title, '成果标题', 160),
          text(body.body, '成果说明', 12000),
          key(request.headers),
        ),
      );
  });
  app.get('/api/v1/search', async (request) => {
    const q = text(record(request.query).q, '搜索', 160).toLocaleLowerCase();
    return {
      items: store
        .tasks()
        .filter((task) =>
          (task.title + ' ' + task.description + ' ' + task.shortId)
            .toLocaleLowerCase()
            .includes(q),
        )
        .slice(0, 30),
    };
  });
  for (const url of ['/api/v1/events', '/api/v1/tasks/:taskId/events'])
    app.get(url, async (request, reply) => {
      if (streams.size >= 32)
        throw new DomainError('TOO_MANY_CONNECTIONS', '本地预览连接过多', 429);
      const params = request.params as { taskId?: string };
      const taskId = params.taskId;
      if (taskId) store.getTask(taskId);
      const query = request.query as { after?: string };
      let after = Number(request.headers['last-event-id'] ?? query.after ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new DomainError('INVALID_CURSOR', '无效事件游标');
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      streams.add(reply.raw);
      reply.raw.write('event: ready\ndata: {}\n\n');
      let polling = false;
      const poll = async () => {
        if (reply.raw.destroyed || polling) return;
        polling = true;
        try {
          if (identity && !(await identity.current(identityHeaders(request), false))) {
            reply.raw.write('event: access-ended\ndata: {"reason":"session"}\n\n');
            reply.raw.end();
            return;
          }
          const batch = store.events(after, taskId);
          after = batch.cursor;
          for (const event of batch.events)
            reply.raw.write(
              `id: ${event.sequence}\nevent: changed\ndata: ${JSON.stringify(event)}\n\n`,
            );
        } catch {
          reply.raw.write('event: access-ended\ndata: {"reason":"permission"}\n\n');
          reply.raw.end();
        } finally {
          polling = false;
        }
      };
      void poll();
      const timer = setInterval(() => {
        void poll();
      }, 750);
      timer.unref();
      const ping = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
      ping.unref();
      reply.raw.on('close', () => {
        clearInterval(timer);
        clearInterval(ping);
        streams.delete(reply.raw);
      });
    });
  app.get('/*', async (request, reply) => {
    if (request.url.startsWith('/api/'))
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: '接口尚未实现', retryable: false },
        requestId: request.id,
      });
    const pathname = new URL(request.url, 'http://localhost').pathname;
    let file = resolve(webRoot, '.' + decodeURIComponent(pathname));
    const rel = relative(webRoot, file);
    if (rel === '..' || rel.startsWith('..' + sep))
      throw new DomainError('NOT_FOUND', '文件不存在', 404);
    if (!extname(file)) file = resolve(webRoot, 'index.html');
    try {
      const contents = await readFile(file);
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
      };
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      return reply.type(mime[extname(file)] ?? 'application/octet-stream').send(contents);
    } catch {
      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send('尚未构建网页，请在仓库根目录运行 npm run build，或用 npm run dev 启动开发模式。');
    }
  });
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });
  app.addHook('onClose', async () => {
    await continuations.close();
    await native.close();
    mock.close();
    identity?.close();
    store.close();
  });
  return app;
}
