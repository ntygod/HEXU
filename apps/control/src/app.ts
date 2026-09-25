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
import { SPACE_ID } from '../../../packages/db/src/seed.js';
import { MockAdapter } from '../../../packages/adapters/mock/src/index.js';

export async function createApp(
  options: {
    databasePath?: string;
    store?: Store;
    port?: number;
    stepMs?: number;
    webRoot?: string;
    logger?: boolean;
  } = {},
) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 32768 });
  const store = options.store ?? new Store(options.databasePath);
  store.recoverMockRuns();
  const mock = new MockAdapter(store, options.stepMs);
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
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin))
      throw new DomainError('ORIGIN_REJECTED', '不允许跨站访问本地预览', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site')
      throw new DomainError('ORIGIN_REJECTED', '不允许跨站访问本地预览', 403);
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers['x-hexu-client'] !== 'web'
    )
      throw new DomainError('CLIENT_HEADER_REQUIRED', '缺少本地客户端标识', 403);
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
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
  app.get('/health', async () => ({ status: 'ok', mode: 'local-preview' }));
  app.get('/ready', async () => {
    store.db.prepare('SELECT 1').get();
    return { status: 'ready' };
  });
  app.get('/api/v1/me', async () => ({ ...store.workbench().user, mode: 'local-preview' }));
  app.get('/api/v1/workbench', async () => store.workbench());
  app.get('/api/v1/spaces/:spaceId/projects', async (request) => {
    if (param(request.params, 'spaceId') !== SPACE_ID)
      throw new DomainError('NOT_FOUND', '工作空间不存在', 404);
    return { items: store.projects() };
  });
  app.post('/api/v1/spaces/:spaceId/projects', async (request, reply) => {
    if (param(request.params, 'spaceId') !== SPACE_ID)
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
    if (param(request.params, 'spaceId') !== SPACE_ID)
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
    if (param(request.params, 'spaceId') !== SPACE_ID)
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
    mock.stop(id);
    return run;
  });
  app.post('/api/v1/runs/:runId/inputs', async (request) => {
    const id = param(request.params, 'runId');
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
      const poll = () => {
        if (reply.raw.destroyed) return;
        const batch = store.events(after, taskId);
        after = batch.cursor;
        for (const event of batch.events)
          reply.raw.write(
            `id: ${event.sequence}\nevent: changed\ndata: ${JSON.stringify(event)}\n\n`,
          );
      };
      poll();
      const timer = setInterval(poll, 750);
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
    mock.close();
    store.close();
  });
  return app;
}
