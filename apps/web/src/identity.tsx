import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from 'react';
import type { IdentityState } from '../../../packages/contracts/src/identity.js';
import { request, setActiveSpace } from '../../../packages/client/src/index.js';
import { Brand, Button, Icon } from '../../../packages/ui/src/index.js';

interface IdentityContextValue {
  state: IdentityState;
  spaceId: string;
  refresh(preferred?: string): Promise<void>;
  switchSpace(id: string): void;
  signOut(): Promise<void>;
}
const IdentityContext = createContext<IdentityContextValue | null>(null);
export function useIdentity() {
  const value = useContext(IdentityContext);
  if (!value) throw new Error('Missing identity context');
  return value;
}
function savedSpace(userId: string) {
  try {
    return sessionStorage.getItem(`hexu-space:${userId}`) ?? '';
  } catch {
    return '';
  }
}
function saveSpace(userId: string, id: string) {
  try {
    sessionStorage.setItem(`hexu-space:${userId}`, id);
  } catch {}
}
function home() {
  history.replaceState({}, '', '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function IdentityGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<IdentityState | null>(null),
    [spaceId, setSpaceId] = useState(''),
    [error, setError] = useState('');
  const [path, setPath] = useState(location.pathname);
  const select = (next: IdentityState, preferred?: string) => {
    const id = next.user
      ? (next.spaces.find((s) => s.id === (preferred ?? savedSpace(next.user!.id)))?.id ??
        `personal-${next.user.id}`)
      : '';
    setActiveSpace(id);
    setSpaceId(id);
    if (next.user) saveSpace(next.user.id, id);
  };
  const refresh = async (preferred?: string) => {
    const next = await request<IdentityState>('/identity');
    select(next, preferred);
    setState(next);
    setError('');
  };
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const auth = () => {
      setActiveSpace('');
      setState(null);
      void refresh().catch((e) => setError(e.message));
    };
    const revoked = () => {
      setActiveSpace('');
      setState(null);
      home();
      void refresh('').catch((e) => setError(e.message));
    };
    const route = () => setPath(location.pathname);
    window.addEventListener('hexu-auth-required', auth);
    window.addEventListener('hexu-space-revoked', revoked);
    window.addEventListener('popstate', route);
    return () => {
      window.removeEventListener('hexu-auth-required', auth);
      window.removeEventListener('hexu-space-revoked', revoked);
      window.removeEventListener('popstate', route);
    };
  }, []);
  if (!state)
    return (
      <div className="startup">
        <div className="startup-mark">H</div>
        <h1>HEXU · 合序</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button onClick={() => void refresh().catch((e) => setError(e.message))}>
              重新连接
            </Button>
          </>
        ) : (
          <p>正在恢复工作空间…</p>
        )}
      </div>
    );
  const signOut = async () => {
    await request('/identity/sign-out', { method: 'POST', body: {} });
    setActiveSpace('');
    await refresh();
  };
  const value: IdentityContextValue = {
    state,
    spaceId,
    refresh,
    signOut,
    switchSpace: (id) => {
      if (!state.spaces.some((s) => s.id === id)) return;
      setActiveSpace(id);
      setSpaceId(id);
      if (state.user) saveSpace(state.user.id, id);
      home();
    },
  };
  return (
    <IdentityContext.Provider value={value}>
      {state.mode === 'team-local' && (!state.user || path === '/join') ? (
        <AccountEntry key={`${state.user?.id ?? 'anonymous'}:${path}`} />
      ) : (
        <Fragment key={`${state.user?.id ?? 'preview'}:${spaceId}`}>{children}</Fragment>
      )}
    </IdentityContext.Provider>
  );
}
function AccountEntry() {
  const { state, refresh, signOut } = useIdentity();
  const joining = location.pathname === '/join',
    token = location.hash.slice(1);
  const [invitation, setInvitation] = useState<{
    email: string;
    spaceName: string;
    expiresAt: string;
  } | null>(null);
  const [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [code, setCode] = useState('');
  const [existing, setExisting] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const setup = state.setupRequired && !joining;
  useEffect(() => {
    if (joining)
      void request<{ email: string; spaceName: string; expiresAt: string }>(
        '/identity/invitation-preview',
        { method: 'POST', body: { token } },
      )
        .then((value) => {
          setInvitation(value);
          setEmail(value.email);
        })
        .catch((e) => setError(e.message));
  }, [joining, token]);
  useEffect(() => {
    try {
      document.documentElement.dataset.theme = localStorage.getItem('hexu-theme') ?? 'light';
    } catch {}
  }, []);
  const register = setup || (joining && !existing && !state.user);
  return (
    <main className="account-shell">
      <section className="account-story">
        <Brand />
        <div className="account-story-copy">
          <span className="eyebrow">人和 AI，一起交付</span>
          <h1>
            从你开始，
            <br />
            让协作有序发生。
          </h1>
          <p>保留自己的工作空间，在共同项目里连接讨论、任务和成果。</p>
          <div className="account-story-cards">
            <article>
              <Icon name="folder" />
              <strong>共同的项目</strong>
              <span>只分享需要协作的内容</span>
            </article>
            <article>
              <Icon name="people" />
              <strong>清楚的边界</strong>
              <span>账号、项目与执行权限各自独立</span>
            </article>
          </div>
        </div>
        <p className="account-footnote">
          E2a · 真实账号的本机开发模式
          <br />
          不依赖企业 SSO；暂不开放远程访问与宿主机执行。
        </p>
      </section>
      <section className="account-form-panel">
        <div className="account-form-header">
          <span className="badge neutral">
            {setup ? '首次启动' : joining ? '邀请加入' : '账号登录'}
          </span>
          <h2>
            {setup
              ? '建立你的第一个账号'
              : joining
                ? `加入${invitation?.spaceName ?? '团队空间'}`
                : '欢迎回到合序'}
          </h2>
          <p>
            {setup
              ? '初始化代码保存在本机数据目录的 setup-code 文件中。'
              : joining
                ? '邀请只授予空间成员资格，项目访问需要单独分配。'
                : '用你的账号继续工作，个人任务仍只对你可见。'}
          </p>
        </div>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              if (joining && existing && !state.user) {
                await request('/identity/sign-in', { method: 'POST', body: { email, password } });
                await refresh();
                return;
              }
              if (joining) {
                const result = await request<{ spaceId: string }>('/identity/join', {
                  method: 'POST',
                  body: { token, name, password },
                });
                await refresh(result.spaceId);
                home();
              } else {
                await request(setup ? '/identity/setup' : '/identity/sign-in', {
                  method: 'POST',
                  body: setup ? { name, email, password, code: code.trim() } : { email, password },
                });
                await refresh();
                home();
              }
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {state.user ? (
            <div className="account-current">
              <strong>{state.user.name}</strong>
              <p>当前账号：{state.user.email}</p>
              <Button type="button" onClick={() => void signOut()}>
                换一个账号
              </Button>
            </div>
          ) : (
            <>
              {register && (
                <label className="field">
                  你的名字
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              )}
              <label className="field">
                邮箱
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  readOnly={joining}
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="field">
                密码
                <input
                  name="password"
                  aria-label="密码"
                  aria-describedby="account-password-help"
                  type="password"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  required
                  minLength={register ? 12 : 1}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <small id="account-password-help">
                  {register
                    ? '至少 12 个字符；密码由认证组件处理。'
                    : '输入账号密码，不是模型 API key。'}
                </small>
              </label>
              {setup && (
                <label className="field">
                  初始化代码
                  <input
                    name="setupCode"
                    type="password"
                    autoComplete="off"
                    required
                    minLength={32}
                    maxLength={128}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
              )}
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" type="submit" busy={busy} disabled={joining && !invitation}>
            {setup
              ? '创建账号并开始'
              : joining
                ? state.user
                  ? '接受邀请'
                  : existing
                    ? '登录受邀账号'
                    : '创建账号并加入'
                : '登录工作台'}
            <Icon name="arrow-right" />
          </Button>
        </form>
        {joining && !state.user && (
          <button
            className="account-text-button"
            onClick={() => {
              setExisting(!existing);
              setError('');
            }}
          >
            {existing ? '还没有账号？通过此邀请创建' : '已有账号？先登录再接受邀请'}
          </button>
        )}
        {!joining && !setup && (
          <p className="account-help">
            新成员请使用邀请链接创建账号。邮箱找回密码尚未接入，不会显示虚假的“邮件已发送”。
          </p>
        )}
        {joining && (
          <button className="account-text-button" onClick={home}>
            返回工作台
          </button>
        )}
      </section>
    </main>
  );
}
export function SpaceSwitcher() {
  const { state, spaceId, switchSpace } = useIdentity();
  if (state.mode !== 'team-local')
    return (
      <div className="space-switch">
        <span className="space-grid">▦</span>
        <strong>合序团队</strong>
        <span className="space-demo">本地</span>
      </div>
    );
  return (
    <div className="space-switch team-space-switch">
      <span className="space-grid">▦</span>
      <select
        aria-label="当前工作空间"
        value={spaceId}
        onChange={(e) => switchSpace(e.target.value)}
      >
        {state.spaces.map((space) => (
          <option key={space.id} value={space.id}>
            {space.kind === 'personal' ? '个人' : '团队'} · {space.name}
          </option>
        ))}
      </select>
    </div>
  );
}
