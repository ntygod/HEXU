import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ContinuationStore } from '../../../packages/db/src/continuations.js';
import type { Store } from '../../../packages/db/src/store.js';
import type { IdentityService } from '../../../packages/identity/src/index.js';
import { DomainError, enumValue, record, text } from '../../../packages/contracts/src/index.js';
import {
  emailAddress,
  secretText,
  type Principal,
} from '../../../packages/contracts/src/identity.js';

export function identityHeaders(request: FastifyRequest) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'x-hexu-auth-ip': request.ip });
  for (const name of ['cookie', 'origin', 'user-agent']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers; // Never trust forwarded host/proto/IP, user-ID headers or bearer tokens.
}
async function respond(reply: FastifyReply, response: Response) {
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie', cookies);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    if (response.status === 429)
      reply.header('retry-after', response.headers.get('retry-after') ?? '60');
    return reply.code(response.status).send({
      error: {
        code: data?.code ?? 'AUTH_FAILED',
        message:
          response.status === 429
            ? '尝试过于频繁，请稍后重试'
            : '账号或密码不正确，或当前会话已失效',
        retryable: false,
      },
    });
  }
  // Never return the library's raw session token in page-readable JSON.
  return reply.send({ ok: true });
}
export function attachIdentity(
  app: FastifyInstance,
  store: Store,
  identity: IdentityService | null,
) {
  const people = store.collaboration;
  const principalByRequest = new WeakMap<FastifyRequest, Principal>();
  const key = (request: FastifyRequest) =>
    text(request.headers['idempotency-key'], '操作标识', 128);
  const params = (request: FastifyRequest, name: string) =>
    text(record(request.params)[name], name, 150);
  const limit = new Map<string, { count: number; expires: number }>();
  function rate(request: FastifyRequest) {
    const at = Date.now();
    for (const [key, entry] of limit) if (entry.expires <= at) limit.delete(key);
    const entry = limit.get(request.ip) ?? { count: 0, expires: at + 60_000 };
    if (++entry.count > 30 || limit.size > 1000)
      throw new DomainError('RATE_LIMITED', '请求过于频繁，请稍后重试', 429);
    limit.set(request.ip, entry);
  }
  app.addHook('onRequest', async (request, reply) => {
    if (!identity || !request.url.startsWith('/api/')) return;
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/api/v1/identity' || pathname.startsWith('/api/v1/identity/')) return;
    const session = await identity.current(identityHeaders(request));
    if (!session) throw new DomainError('AUTH_REQUIRED', '登录已失效，请重新登录', 401);
    if (session.cookies.length) reply.header('set-cookie', session.cookies);
    const spaces = people.ensurePerson(session.user);
    const selection =
      request.headers['x-hexu-space'] ??
      (pathname.endsWith('/events')
        ? new URL(request.url, 'http://localhost').searchParams.get('spaceId')
        : null);
    const spaceId =
      selection == null ? `personal-${session.user.id}` : text(selection, '空间', 150);
    if (!spaces.some((space) => space.id === spaceId))
      throw new DomainError('SPACE_ACCESS_REVOKED', '空间访问已撤销，请切换空间', 403);
    principalByRequest.set(request, { user: session.user, spaceId });
  });
  // AsyncLocalStorage.run around Fastify's continuation, not mutable global actor state.
  app.addHook('onRequest', (request, _reply, done) => {
    const principal = principalByRequest.get(request);
    if (principal) store.as(principal, done);
    else done();
  });
  app.addHook('preHandler', async (request) => {
    if (!identity) return;
    const p = record(request.params ?? {});
    if (p.spaceId && p.spaceId !== store.spaceId)
      throw new DomainError('NOT_FOUND', '空间不匹配', 404);
    if (p.taskId)
      store.getTask(text(p.taskId, '任务', 150), !['GET', 'HEAD'].includes(request.method));
    if (p.runId)
      store.getTask(
        store.run(text(p.runId, '执行', 150)).taskId,
        !['GET', 'HEAD'].includes(request.method),
      );
    if (p.operationId)
      store.getTask(
        new ContinuationStore(store).get(text(p.operationId, '操作', 150)).taskId,
        !['GET', 'HEAD'].includes(request.method),
      );
    // Until node identities and dispatch grants exist, no account inherits host execution.
    const path = new URL(request.url, 'http://localhost').pathname;
    if (
      path.startsWith('/api/v1/native') ||
      /\/(continuation-preview|native-context)(\/|$)/.test(path) ||
      (/\/(runs|continuations)(\/|$)/.test(path) && request.method !== 'GET')
    )
      throw new DomainError(
        'RUNNER_REQUIRED',
        '团队模式尚未接入节点任务派发，不使用宿主机目录或模型账号',
        422,
      );
  });
  app.get('/api/v1/identity', async (request, reply) => {
    if (!identity) return { mode: 'local-preview', setupRequired: false, user: null, spaces: [] };
    const current = await identity.current(identityHeaders(request));
    if (current?.cookies.length) reply.header('set-cookie', current.cookies);
    return {
      mode: 'team-local',
      setupRequired: identity.setupRequired(),
      user: current?.user ?? null,
      spaces: current ? people.ensurePerson(current.user) : [],
    };
  });
  if (!identity) return;
  app.post('/api/v1/identity/sign-in', async (request, reply) => {
    const body = record(request.body);
    return respond(
      reply,
      await identity.signIn(
        { email: emailAddress(body.email), password: secretText(body.password, '密码', 1) },
        identityHeaders(request),
      ),
    );
  });
  app.post('/api/v1/identity/sign-out', async (request, reply) =>
    respond(reply, await identity.signOut(identityHeaders(request))),
  );
  app.post('/api/v1/identity/revoke-sessions', async (request, reply) =>
    respond(reply, await identity.revokeSessions(identityHeaders(request))),
  );
  app.post('/api/v1/identity/change-password', async (request, reply) => {
    const body = record(request.body);
    return respond(
      reply,
      await identity.changePassword(
        {
          currentPassword: secretText(body.currentPassword, '当前密码', 1),
          newPassword: secretText(body.newPassword, '新密码'),
        },
        identityHeaders(request),
      ),
    );
  });
  app.post('/api/v1/identity/setup', async (request, reply) => {
    rate(request);
    const body = record(request.body);
    const result = await identity.setup(
      secretText(body.code, '初始化代码', 32),
      {
        email: emailAddress(body.email),
        name: text(body.name, '姓名', 80),
        password: secretText(body.password, '密码'),
      },
      identityHeaders(request),
    );
    people.ensurePerson(result.user);
    return respond(reply, result.response);
  });
  app.post('/api/v1/identity/invitation-preview', async (request) => {
    rate(request);
    return people.previewInvitation(text(record(request.body).token, '邀请', 128));
  });
  app.post('/api/v1/identity/join', async (request, reply) => {
    rate(request);
    const body = record(request.body),
      token = text(body.token, '邀请', 128);
    const current = await identity.current(identityHeaders(request));
    if (current) {
      people.ensurePerson(current.user);
      return people.accept(token, current.user);
    }
    const invitation = people.previewInvitation(token);
    const result = await identity.register(
      {
        email: invitation.email,
        name: text(body.name, '姓名', 80),
        password: secretText(body.password, '密码'),
      },
      identityHeaders(request),
    );
    people.ensurePerson(result.user);
    // Recheck token revocation/expiry after asynchronous password hashing.
    const accepted = people.accept(token, result.user);
    reply.header('set-cookie', result.response.headers.getSetCookie());
    return accepted;
  });
  app.get('/api/v1/spaces', async () => ({ items: people.spaces(store.actorId) }));
  app.post('/api/v1/spaces', async (request, reply) =>
    reply
      .code(201)
      .send(people.createSpace(text(record(request.body).name, '空间名称', 100), key(request))),
  );
  app.get('/api/v1/spaces/:spaceId/members', async () => ({ items: people.members() }));
  app.post('/api/v1/spaces/:spaceId/members/:userId/remove', async (request) =>
    people.removeMember(params(request, 'userId'), key(request)),
  );
  app.get('/api/v1/spaces/:spaceId/invitations', async () => ({ items: people.invitations() }));
  app.post('/api/v1/spaces/:spaceId/invitations', async (request, reply) =>
    reply
      .code(201)
      .send(people.createInvitation(emailAddress(record(request.body).email), key(request))),
  );
  app.post('/api/v1/spaces/:spaceId/invitations/:invitationId/revoke', async (request) =>
    people.revokeInvitation(params(request, 'invitationId'), key(request)),
  );
  app.get('/api/v1/projects/:projectId/members', async (request) => ({
    items: people.projectMembers(params(request, 'projectId')),
  }));
  app.post('/api/v1/projects/:projectId/members/:userId', async (request) => {
    const role = record(request.body).role;
    return people.setProjectMember(
      params(request, 'projectId'),
      params(request, 'userId'),
      role === null ? null : enumValue(role, ['view', 'edit', 'manage'] as const, '项目角色'),
      key(request),
    );
  });
}
