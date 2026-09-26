import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { DomainError } from '../../contracts/src/index.js';
import type { IdentityUser } from '../../contracts/src/identity.js';

export interface IdentityOptions {
  databasePath: string;
  secret: string;
  setupCode: string;
  baseURL: string;
  trustedOrigins: string[];
}
export interface CurrentIdentity {
  user: IdentityUser;
  expiresAt: string;
  cookies: string[];
}
export interface IdentityPort {
  current(headers: Headers, refresh?: boolean): Promise<CurrentIdentity | null>;
  signIn(body: { email: string; password: string }, headers: Headers): Promise<Response>;
  signOut(headers: Headers): Promise<Response>;
  revokeSessions(headers: Headers): Promise<Response>;
}
const hash = (value: string) => createHash('sha256').update(value).digest();

/** Better Auth owns password hashes, session cookies and revocation. No app JWT/password scheme. */
export async function createIdentity(options: IdentityOptions) {
  if (options.secret.length < 32 || options.setupCode.length < 32)
    throw new Error('认证 secret 与初始化 code 必须至少 32 个字符，不能使用共享默认值。');
  const origin = new URL(options.baseURL);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/'
  )
    throw new Error('E2a 认证只允许明确的本机 origin，不支持外部部署。');
  if (options.databasePath !== ':memory:')
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(options.databasePath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  if (options.databasePath !== ':memory:') chmodSync(options.databasePath, 0o600);
  const registration = new AsyncLocalStorage<boolean>();
  const auth = betterAuth({
    appName: 'HEXU',
    database: db,
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: '/api/auth',
    trustedOrigins: options.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    session: { expiresIn: 7 * 86400, updateAge: 12 * 3600, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 20 } },
    },
    advanced: {
      cookiePrefix: 'hexu-team',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: ['x-hexu-auth-ip'] },
      useSecureCookies: origin.protocol === 'https:',
    },
    telemetry: { enabled: false },
    logger: { disabled: true },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email' && registration.getStore() !== true)
          throw new APIError('FORBIDDEN', {
            message: 'Registration requires an explicit HEXU invitation or setup code.',
          });
      }),
    },
  });
  try {
    await (await getMigrations(auth.options)).runMigrations();
    db.exec(
      "CREATE TABLE IF NOT EXISTS hexu_bootstrap(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL); INSERT OR IGNORE INTO hexu_bootstrap VALUES(1,'idle');",
    );
  } catch (error) {
    db.close();
    throw error;
  }
  const userCount = () => Number(db.prepare('SELECT count(*) AS n FROM "user"').get()!.n);
  const current = async (headers: Headers, refresh = true): Promise<CurrentIdentity | null> => {
    const response = await auth.api.getSession({
      headers,
      asResponse: true,
      query: { disableCookieCache: true, disableRefresh: !refresh },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.user || !data.session || new Date(data.session.expiresAt).getTime() <= Date.now())
      return null;
    return {
      user: { id: data.user.id, name: data.user.name, email: data.user.email },
      expiresAt: data.session.expiresAt,
      cookies: response.headers.getSetCookie(),
    };
  };
  const register = async (
    body: { name: string; email: string; password: string },
    headers: Headers,
  ) => {
    const response = await registration.run(true, () =>
      auth.api.signUpEmail({ body, headers, asResponse: true }),
    );
    if (!response.ok)
      throw new DomainError('REGISTRATION_FAILED', '账号无法创建，请登录已有账号或联系邀请者', 409);
    const data = await response.clone().json();
    if (!data.user?.id) throw new DomainError('REGISTRATION_FAILED', '账号创建未能完成', 500);
    return {
      response,
      user: { id: data.user.id, name: data.user.name, email: data.user.email } as IdentityUser,
    };
  };
  return {
    setupRequired: () => userCount() === 0,
    current,
    async setup(
      code: string,
      body: { name: string; email: string; password: string },
      headers: Headers,
    ) {
      if (!timingSafeEqual(hash(code), hash(options.setupCode)))
        throw new DomainError('SETUP_DENIED', '初始化代码不正确或已失效', 403);
      if (userCount() !== 0) throw new DomainError('SETUP_COMPLETE', '初始化已完成，请登录', 409);
      const claim = db
        .prepare("UPDATE hexu_bootstrap SET state='claimed' WHERE id=1 AND state='idle'")
        .run();
      if (claim.changes !== 1)
        throw new DomainError('SETUP_BUSY', '初始化正在进行或上次中断；请核对本机初始化状态', 409);
      try {
        return await register(body, headers);
      } finally {
        db.prepare('UPDATE hexu_bootstrap SET state=? WHERE id=1').run(
          userCount() ? 'done' : 'idle',
        );
      }
    },
    register,
    // Public endpoints are strictly allowlisted by the app; sign-up is also guarded in the library hook.
    async signIn(body: { email: string; password: string }, headers: Headers) {
      return auth.handler(
        new Request(`${options.baseURL}/api/auth/sign-in/email`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      );
    },
    signOut: (headers: Headers) => auth.api.signOut({ headers, asResponse: true }),
    revokeSessions: (headers: Headers) => auth.api.revokeSessions({ headers, asResponse: true }),
    changePassword: (body: { currentPassword: string; newPassword: string }, headers: Headers) =>
      auth.api.changePassword({
        headers,
        body: { ...body, revokeOtherSessions: true },
        asResponse: true,
      }),
    close() {
      db.close();
    },
  };
}
export type IdentityService = Awaited<ReturnType<typeof createIdentity>>;
