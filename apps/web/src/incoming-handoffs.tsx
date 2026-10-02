import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IncomingHandoffPage,
  IncomingHandoffSummary,
} from '../../../packages/contracts/src/incoming-handoffs.js';
import { INCOMING_HANDOFF_CURSOR_MAX_LENGTH } from '../../../packages/contracts/src/incoming-handoffs.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Icon } from '../../../packages/ui/src/index.js';
import { Link, time, useApp } from './state.js';
import './incoming-handoffs.css';

export const incomingHandoffUrl = (taskId: string, handoffId: string) =>
  `/tasks/${encodeURIComponent(taskId)}/handoffs/${encodeURIComponent(handoffId)}`;

// Discovery reads have their own lifecycle: they never enter invitation material,
// expiry persistence, or the existing handling panel. A new visibility snapshot
// invalidates old responses before its replacement request finishes.
function useIncomingRead<T>(path: string, allowed = true) {
  const { data, version } = useApp();
  const [reload, setReload] = useState(0);
  const scope = `${data.mode}:${data.user.id}:${data.space?.id ?? ''}`;
  const session = `${scope}:${reload}:${path}`;
  const key = `${session}:${version}`;
  const current = useRef(key);
  current.current = key;
  const blockedSession = useRef<{
    session: string;
    unavailable: boolean;
    error: string;
  } | null>(null);
  if (!allowed) blockedSession.current = { session, unavailable: true, error: '' };
  const blocked = blockedSession.current?.session === session ? blockedSession.current : null;
  const [result, setResult] = useState<{
    key: string;
    value: T | null;
    error: string;
    unavailable: boolean;
    loading: boolean;
  }>({ key, value: null, error: '', unavailable: false, loading: allowed });
  useEffect(() => {
    if (blocked) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () =>
      !abort.signal.aborted &&
      current.current === key &&
      blockedSession.current?.session !== session;
    async function read() {
      if (!active()) return;
      setResult((previous) => ({
        key,
        value: previous.key === key ? previous.value : null,
        error: '',
        unavailable: false,
        loading: true,
      }));
      try {
        const value = await request<T>(path, { signal: abort.signal });
        if (active()) setResult({ key, value, error: '', unavailable: false, loading: false });
      } catch (cause) {
        if (!active()) return;
        const unavailable =
          cause instanceof ApiError && [401, 403, 404, 422].includes(cause.status);
        const invalidCursor = cause instanceof ApiError && cause.code === 'INVALID_CURSOR';
        const error = cause instanceof Error ? cause.message : '暂时无法读取待接手邀请';
        if (unavailable || invalidCursor) blockedSession.current = { session, unavailable, error };
        setResult((previous) => ({
          key,
          value: unavailable || invalidCursor || previous.key !== key ? null : previous.value,
          error,
          unavailable,
          loading: false,
        }));
        // Explicit retry starts a new read session; never repopulate a target
        // automatically after a definitive denial or an invalid page cursor.
        if (unavailable || invalidCursor) return;
      }
      if (active()) timer = setTimeout(() => void read(), 3000);
    }
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [path, key, session, blocked]);
  const matching = !blocked && result.key === key;
  const expire = useCallback(() => {
    blockedSession.current = { session, unavailable: true, error: '' };
    setResult({ key, value: null, error: '', unavailable: true, loading: false });
  }, [session, key]);
  return {
    value: matching ? result.value : null,
    error: blocked?.error ?? (matching ? result.error : ''),
    unavailable: blocked?.unavailable || (matching && result.unavailable),
    loading: !blocked && (!matching || result.loading),
    retry: () => setReload((value) => value + 1),
    expire,
  };
}

// Deadline hiding is local and read-only, including while a GET is delayed.
function useDeadline(items: IncomingHandoffSummary[]) {
  const [now, setNow] = useState(Date.now);
  const deadline = Math.min(
    ...items.map((item) => Date.parse(item.expiresAt)).filter((value) => value > now),
  );
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [deadline]);
  return Math.max(now, Date.now());
}

function pageUrl(cursor = '') {
  const query = new URLSearchParams(location.search);
  if (cursor) query.set('incomingCursor', cursor);
  else query.delete('incomingCursor');
  return `${location.pathname}${query.size ? `?${query}` : ''}`;
}

function pageCursor() {
  const values = new URLSearchParams(location.search).getAll('incomingCursor');
  if (!values.length) return '';
  const value = values[0]!;
  return values.length === 1 &&
    value.length <= INCOMING_HANDOFF_CURSOR_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null;
}

function IncomingList() {
  const { data } = useApp();
  const [cursor, setCursor] = useState(pageCursor);
  useEffect(() => {
    const changed = () => setCursor(pageCursor());
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  const read = useIncomingRead<IncomingHandoffPage>(
    `/incoming-handoffs?limit=20${cursor !== '' ? `&cursor=${encodeURIComponent(cursor ?? '')}` : ''}`,
    cursor !== null,
  );
  const now = useDeadline(read.value?.items ?? []);
  const items =
    read.value?.items.filter(
      (item) =>
        Date.parse(item.expiresAt) > now && data.tasks.some((task) => task.id === item.task.id),
    ) ?? [];
  return (
    <section className="incoming-handoffs work-section" aria-label="发给我的待接手邀请">
      <header className="incoming-handoffs-heading">
        <div>
          <h2>发给我的待接手邀请</h2>
          <p>当前空间中仍可查看、尚未到期的邀请，与任务负责人无关。</p>
        </div>
        <Button busy={read.loading} disabled={cursor === null} onClick={read.retry}>
          刷新待接手邀请
        </Button>
      </header>
      {(read.error || read.unavailable) && (
        <div role="alert" className="incoming-handoffs-message">
          <p>
            {cursor === null
              ? '邀请列表位置已无效，请返回第一页。'
              : read.unavailable
                ? '当前无法查看待接手邀请，摘要已清除。'
                : read.error}
          </p>
          {cursor !== null && <Button onClick={read.retry}>重试读取待接手邀请</Button>}
        </div>
      )}
      {read.loading && !read.value && <p role="status">正在读取待接手邀请…</p>}
      {read.value && !items.length && (
        <p className="work-empty-text">
          {cursor ? '此页没有可查看的待接手邀请。' : '当前没有发给你的待接手邀请。'}
        </p>
      )}
      {!!items.length && (
        <div className="incoming-handoff-list">
          {items.map((item) => (
            <article className="incoming-handoff-row" key={item.id} data-handoff-id={item.id}>
              <div>
                <span className="incoming-handoff-meta">
                  {item.task.shortId} · {item.sender?.name ?? '记录中的成员'} 发来
                </span>
                <h3>{item.task.title}</h3>
                <p className="incoming-handoff-excerpt">{item.summary}</p>
                <span className="incoming-handoff-meta">
                  邀请有效至 <time dateTime={item.expiresAt}>{time(item.expiresAt)}</time>
                </span>
              </div>
              <Link className="button secondary" to={incomingHandoffUrl(item.task.id, item.id)}>
                查看邀请摘要 <Icon name="arrow" size={15} />
              </Link>
            </article>
          ))}
        </div>
      )}
      {(cursor !== '' || read.value?.nextCursor) && (
        <nav className="incoming-handoffs-pagination" aria-label="待接手邀请分页">
          {cursor !== '' ? (
            <Link className="button secondary" to={pageUrl()}>
              返回第一页
            </Link>
          ) : (
            <span className="hint">第一页</span>
          )}
          {read.value?.nextCursor && (
            <Link className="button secondary" to={pageUrl(read.value.nextCursor)}>
              较早邀请 <Icon name="arrow" size={15} />
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}

export function IncomingHandoffsWorkbench() {
  const { data } = useApp();
  if (data.mode !== 'team-local') return null;
  return <IncomingList key={`${data.user.id}:${data.space?.id}`} />;
}

export function IncomingHandoffSummaryPanel({
  taskId,
  handoffId,
  onHandle,
}: {
  taskId: string;
  handoffId: string;
  onHandle(): void;
}) {
  const { data } = useApp();
  const visible = data.mode === 'team-local' && data.tasks.some((task) => task.id === taskId);
  const read = useIncomingRead<IncomingHandoffSummary>(
    `/incoming-handoffs/${encodeURIComponent(taskId)}/${encodeURIComponent(handoffId)}`,
    visible,
  );
  const now = useDeadline(read.value ? [read.value] : []);
  const item = visible && read.value && Date.parse(read.value.expiresAt) > now ? read.value : null;
  const unavailable = !visible || read.unavailable || (!!read.value && !item);
  const expired = !!read.value && Date.parse(read.value.expiresAt) <= now;
  useEffect(() => {
    if (expired) read.expire();
  }, [expired, read.expire]);
  return (
    <section className="incoming-handoff-summary" aria-label="待接手邀请摘要">
      <div className="incoming-handoff-summary-content">
        {unavailable ? (
          <p role="alert">
            此邀请当前不可查看，可能已结束、到期或访问权限发生变化。先前摘要已清除。
          </p>
        ) : (
          <>
            {read.error && (
              <div role="alert">
                <p>{read.error}</p>
                <Button onClick={read.retry}>重试读取邀请摘要</Button>
              </div>
            )}
            {read.loading && !item && <p role="status">正在读取邀请摘要…</p>}
            {item && (
              <>
                <span className="incoming-handoff-meta">
                  {item.task.shortId} · {item.sender?.name ?? '记录中的成员'} 发来
                </span>
                <h3>{item.task.title}</h3>
                <p className="incoming-handoff-meta">
                  邀请有效至 <time dateTime={item.expiresAt}>{time(item.expiresAt)}</time>
                </p>
                <section>
                  <h4>工作摘要</h4>
                  <p className="incoming-handoff-text">{item.summary}</p>
                </section>
                {item.remainingWork && (
                  <section>
                    <h4>剩余工作</h4>
                    <p className="incoming-handoff-text">{item.remainingWork}</p>
                  </section>
                )}
                {item.environment && (
                  <section>
                    <h4>环境说明</h4>
                    <p className="incoming-handoff-text">{item.environment}</p>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>
      <div className="incoming-handoff-summary-actions">
        <p>查看摘要不会接受接手。继续后可在任务邀请中明确选择处理方式。</p>
        <Button
          variant="primary"
          disabled={!item || read.loading || !!read.error}
          onClick={() => {
            // The deadline can pass between paint and click, even with a suspended tab.
            if (item && Date.parse(item.expiresAt) > Date.now()) onHandle();
            else read.retry();
          }}
        >
          查看并处理邀请
        </Button>
        <Button busy={read.loading} disabled={!visible} onClick={read.retry}>
          刷新邀请摘要
        </Button>
      </div>
    </section>
  );
}
