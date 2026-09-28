import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../packages/contracts/src/index.js';
import type {
  ProjectSource,
  SourceContent,
  SourceKind,
  SourcePage,
  SourceRevision,
  SourceRevisionPage,
  SourceSummary,
} from '../../../packages/contracts/src/project-sources.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Dialog, Empty, Icon } from '../../../packages/ui/src/index.js';
import { time, useApp } from './state.js';
import './project-sources.css';

const pathFor = (projectId: string, id?: string) =>
  `/projects/${encodeURIComponent(projectId)}/sources${id ? '/' + encodeURIComponent(id) : ''}`;
const kindLabel = { text: '文本资料', link: '链接引用' };
const actionLabel = { created: '创建', updated: '更新', deleted: '删除', restored: '恢复' };
type Attempt = { path: string; method: 'POST' | 'PATCH'; body: unknown; key: string };
function useSourceCommand(onSaved: (source: ProjectSource) => void) {
  const { refresh, notice } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState<Attempt | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(attempt: Attempt) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const source = await request<ProjectSource>(attempt.path, attempt);
      if (!alive.current) return;
      setUncertain(null);
      let refreshed = true;
      await refresh().catch(() => {
        refreshed = false;
      });
      if (!alive.current) return;
      notice(refreshed ? '资料操作已保存' : '资料操作已保存，页面刷新失败，请重新加载', !refreshed);
      onSaved(source);
    } catch (cause) {
      if (!alive.current) return;
      setUncertain(
        cause instanceof ApiError && cause.status >= 400 && cause.status < 500 ? null : attempt,
      );
      setError(cause instanceof Error ? cause.message : '资料操作失败');
      await refresh().catch(() => {});
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return { busy, error, uncertain, save };
}
function CommandFeedback({ command }: { command: ReturnType<typeof useSourceCommand> }) {
  return (
    <>
      {command.error && (
        <p role="alert" className="form-error">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="source-conflict" aria-label="资料操作待确认">
          <strong>尚未确认操作结果</strong>
          <p>请求可能已经保存。确认会复用原请求，关闭不会撤销已发送的操作。</p>
          <Button
            type="button"
            busy={command.busy}
            onClick={() => void command.save(command.uncertain!)}
          >
            确认上次资料操作
          </Button>
        </section>
      )}
    </>
  );
}
function SourceFields({
  kind,
  setKind,
  value,
  onChange,
  disabled,
}: {
  kind: SourceKind;
  setKind?: (kind: SourceKind) => void;
  value: SourceContent;
  onChange(value: SourceContent): void;
  disabled: boolean;
}) {
  return (
    <>
      {setKind && (
        <label className="field">
          资料类型
          <select
            aria-label="资料类型"
            value={kind}
            disabled={disabled}
            onChange={(event) => setKind(event.target.value as SourceKind)}
          >
            <option value="text">文本资料</option>
            <option value="link">链接引用</option>
          </select>
        </label>
      )}
      <label className="field">
        资料标题
        <input
          aria-label="资料标题"
          required
          maxLength={120}
          disabled={disabled}
          value={value.title}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
          placeholder="例如：订单接口说明"
        />
      </label>
      {kind === 'link' && (
        <label className="field">
          资料链接
          <input
            aria-label="资料链接"
            type="url"
            required
            maxLength={2048}
            disabled={disabled}
            value={value.url ?? ''}
            onChange={(event) => onChange({ ...value, url: event.target.value })}
            placeholder="https://example.com/document"
          />
        </label>
      )}
      <label className="field">
        {kind === 'text' ? '资料正文' : '链接说明'}
        <textarea
          aria-label={kind === 'text' ? '资料正文' : '链接说明'}
          required={kind === 'text'}
          rows={12}
          maxLength={8000}
          disabled={disabled}
          value={value.content}
          onChange={(event) => onChange({ ...value, content: event.target.value })}
          placeholder={
            kind === 'text'
              ? '保存项目说明、接口示例或参考文字…'
              : '这个链接包含什么，什么时候需要参考…'
          }
        />
      </label>
      <p className="hint">
        {kind === 'link'
          ? '只保存链接与说明，不读取外部网页。'
          : '正文按原文保存，保留换行和缩进。'}{' '}
        保存不会自动发送给模型。
      </p>
    </>
  );
}

export function ProjectSources({
  project,
  sourceId,
  onSelect,
}: {
  project: Project;
  sourceId: string;
  onSelect(id: string): void;
}) {
  const { version, data } = useApp();
  const editable = data.mode === 'local-preview' || project.access !== 'view';
  const [creating, setCreating] = useState(false),
    [state, setState] = useState('active'),
    [query, setQuery] = useState('');
  const [items, setItems] = useState<SourceSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    if (!editable) setCreating(false);
  }, [editable]);
  const listPath = pathFor(project.id) + `?state=${state}&q=${encodeURIComponent(query)}`;
  useEffect(() => {
    const current = ++generation.current,
      abort = new AbortController();
    setBusy(true);
    setError('');
    request<SourcePage>(listPath, { signal: abort.signal })
      .then((page) => {
        if (current === generation.current) {
          setItems(page.items);
          setCursor(page.nextCursor);
        }
      })
      .catch((cause) => {
        if (current === generation.current) {
          setItems([]);
          setCursor(null);
          setError(cause.message);
        }
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [listPath, version, reload]);
  async function loadMore() {
    if (busy || !cursor) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      const page = await request<SourcePage>(listPath + '&cursor=' + encodeURIComponent(cursor));
      if (current === generation.current) {
        setItems((old) => [
          ...old,
          ...page.items.filter((item) => !old.some((previous) => previous.id === item.id)),
        ]);
        setCursor(page.nextCursor);
      }
    } catch (cause) {
      if (current === generation.current) {
        setItems([]);
        setCursor(null);
        setError((cause as Error).message);
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <section className="project-sources" aria-label="项目资料">
      <div className="source-intro">
        <div>
          <h2>项目资料</h2>
          <p>把说明与参考链接放在项目中，供成员查阅。</p>
        </div>
        <Button
          variant="primary"
          disabled={!editable}
          title={editable ? '保存文本或链接' : '需要项目编辑权限'}
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" />
          新建资料
        </Button>
      </div>
      <div className="source-toolbar">
        <div className="work-view-switch" aria-label="资料状态">
          <button aria-pressed={state === 'active'} onClick={() => setState('active')}>
            当前资料
          </button>
          <button aria-pressed={state === 'deleted'} onClick={() => setState('deleted')}>
            已删除资料
          </button>
        </div>
        <label className="work-filter">
          <Icon name="search" size={15} />
          <input
            aria-label="搜索项目资料"
            maxLength={160}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="标题、正文或链接…"
          />
        </label>
      </div>
      {error && (
        <div className="source-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setReload((value) => value + 1)}>重试资料列表</Button>
        </div>
      )}
      {busy && (
        <p className="hint" role="status">
          正在读取资料…
        </p>
      )}
      <div className="source-grid stagger">
        {items.map((source) => (
          <article className="source-card spotlight" key={source.id}>
            <button
              className="source-open"
              aria-label={`查看资料 ${source.title}`}
              onClick={() => onSelect(source.id)}
            >
              <span className="source-kind">
                <Icon name={source.kind === 'text' ? 'file' : 'arrow'} size={16} />
                {kindLabel[source.kind]}
                {source.deletedAt && ' · 已删除'}
              </span>
              <strong>{source.title}</strong>
              <p>{source.excerpt || source.url || '未填写说明'}</p>
              <span className="source-meta">
                {source.updatedByName} · {time(source.updatedAt)} · 修订 {source.revision}
              </span>
            </button>
          </article>
        ))}
      </div>
      {!busy && !error && !items.length && (
        <Empty
          icon={state === 'deleted' ? 'box' : query ? 'search' : 'file'}
          title={
            query ? '没有匹配的资料' : state === 'deleted' ? '没有已删除资料' : '还没有项目资料'
          }
          description={
            state === 'deleted'
              ? '删除仅移出当前列表，历史仍可查看和恢复。'
              : query
                ? '换一个关键词，或者新建一条资料。'
                : '可以先保存一段项目说明或参考链接。'
          }
          action={
            !query && state !== 'deleted' && editable ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} />
                新建资料
              </Button>
            ) : query ? (
              <Button onClick={() => setQuery('')}>清除关键词</Button>
            ) : undefined
          }
        />
      )}
      {cursor && (
        <Button busy={busy} onClick={() => void loadMore()}>
          加载更多资料
        </Button>
      )}
      <p className="hint source-boundary">
        支持文本和链接；可在原生或节点执行面板明确选材。附件上传尚未接入。
      </p>
      {creating && editable && (
        <CreateSource
          projectId={project.id}
          onClose={() => setCreating(false)}
          onCreated={(source) => {
            setCreating(false);
            onSelect(source.id);
          }}
        />
      )}
      {sourceId && (
        <SourceDetails
          key={sourceId}
          projectId={project.id}
          sourceId={sourceId}
          editable={editable}
          onClose={() => onSelect('')}
        />
      )}
    </section>
  );
}
function CreateSource({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose(): void;
  onCreated(source: ProjectSource): void;
}) {
  const [kind, setKind] = useState<SourceKind>('text'),
    [value, setValue] = useState<SourceContent>({ title: '', content: '', url: null });
  const command = useSourceCommand(onCreated);
  const valid =
    !!value.title.trim() && (kind === 'text' ? !!value.content.trim() : !!value.url?.trim());
  return (
    <Dialog title="新建项目资料" drawer onClose={() => !command.busy && onClose()}>
      <form
        className="drawer-form source-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !command.busy && !command.uncertain)
            void command.save({
              path: pathFor(projectId),
              method: 'POST',
              body: { kind, ...value, url: kind === 'text' ? null : value.url },
              key: crypto.randomUUID(),
            });
        }}
      >
        <div className="dialog-body">
          <SourceFields
            kind={kind}
            setKind={setKind}
            value={value}
            onChange={setValue}
            disabled={command.busy || !!command.uncertain}
          />
          <CommandFeedback command={command} />
        </div>
        <div className="dialog-footer">
          <Button type="button" disabled={command.busy} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={command.busy}
            disabled={!valid || !!command.uncertain}
          >
            保存资料
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function SourceText({ source }: { source: ProjectSource }) {
  return (
    <div className="source-reading">
      {source.url && (
        <a className="source-link" href={source.url} target="_blank" rel="noopener noreferrer">
          {source.url}
          <Icon name="arrow" size={15} />
        </a>
      )}
      {source.content ? (
        <pre className="source-content">{source.content}</pre>
      ) : (
        <p className="hint">未填写链接说明</p>
      )}
    </div>
  );
}
function SourceDetails({
  projectId,
  sourceId,
  editable,
  onClose,
}: {
  projectId: string;
  sourceId: string;
  editable: boolean;
  onClose(): void;
}) {
  const { version } = useApp();
  const [source, setSource] = useState<ProjectSource | null>(null),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    request<ProjectSource>(pathFor(projectId, sourceId), { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setSource(value);
      })
      .catch((cause) => {
        if (abort.signal.aborted) return;
        // A temporary read failure must not unmount an unsent editor. Confirmed loss of access must.
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          setSource(null);
          setEditing(false);
        }
        setError(cause instanceof Error ? cause.message : '资料读取失败');
      });
    return () => abort.abort();
  }, [projectId, sourceId, version, reload]);
  const [editing, setEditing] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [changing, setChanging] = useState(false);
  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);
  return (
    <Dialog title="项目资料" drawer onClose={() => !busy && onClose()}>
      {source && error && (
        <div className="source-read-error" role="alert">
          <p>{error}。保留上次读取的资料与未保存草稿。</p>
          <Button onClick={() => setReload((value) => value + 1)}>重新读取资料</Button>
        </div>
      )}
      {!source ? (
        <div className="dialog-body">
          <Empty title={error ? '暂时无法读取资料' : '正在读取资料'} description={error} />
          {error && <Button onClick={() => setReload((value) => value + 1)}>重试读取资料</Button>}
        </div>
      ) : editing && editable ? (
        <EditSource source={source} onClose={() => setEditing(false)} onBusy={setBusy} />
      ) : (
        <>
          <div className="dialog-body source-detail">
            <span className="source-kind">
              {kindLabel[source.kind]} · 修订 {source.revision}
            </span>
            <h3>{source.title}</h3>
            <p className="source-meta">
              {source.updatedByName} 更新于 {time(source.updatedAt)}
            </p>
            {source.deletedAt && (
              <p className="source-deleted" role="status">
                此资料已删除。历史保留，已有任务和执行材料不受影响。
              </p>
            )}
            <SourceText source={source} />
            <p className="hint">
              每次执行的选材版本与启动状态可在任务中查看。链接仅作引用，不会自动读取外部网页。
            </p>
            {editable && (
              <div className="source-actions">
                {!source.deletedAt && (
                  <Button disabled={changing} onClick={() => setEditing(true)}>
                    <Icon name="file" size={15} />
                    编辑资料
                  </Button>
                )}
                <SourceLifecycleControl source={source} onBusy={setBusy} onPending={setChanging} />
              </div>
            )}
            <details className="source-provenance">
              <summary>来源信息</summary>
              <dl>
                <dt>创建</dt>
                <dd>
                  {source.createdByName} · {time(source.createdAt)}
                </dd>
                <dt>资料 ID</dt>
                <dd>{source.id}</dd>
                <dt>内容指纹</dt>
                <dd>{source.contentHash}</dd>
              </dl>
            </details>
            <Button aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>
              资料修订记录
            </Button>
            {historyOpen && <SourceHistory projectId={projectId} sourceId={sourceId} />}
          </div>
          <div className="dialog-footer">
            <Button disabled={busy} onClick={onClose}>
              关闭资料
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
function EditSource({
  source,
  onClose,
  onBusy,
}: {
  source: ProjectSource;
  onClose(): void;
  onBusy(value: boolean): void;
}) {
  const [base, setBase] = useState(source),
    [value, setValue] = useState<SourceContent>({
      title: source.title,
      content: source.content,
      url: source.url,
    });
  const command = useSourceCommand(onClose);
  useEffect(() => {
    onBusy(command.busy);
    return () => onBusy(false);
  }, [command.busy, onBusy]);
  const conflict = source.revision !== base.revision;
  const dirty =
    value.title.trim() !== base.title ||
    value.content !== base.content ||
    (source.kind === 'link' && value.url !== base.url);
  const valid =
    !!value.title.trim() && (source.kind === 'text' ? !!value.content.trim() : !!value.url?.trim());
  return (
    <form
      className="drawer-form source-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !dirty || conflict || source.deletedAt || command.busy || command.uncertain)
          return;
        void command.save({
          path: pathFor(source.projectId, source.id),
          method: 'PATCH',
          body: { ...value, expectedRevision: base.revision },
          key: crypto.randomUUID(),
        });
      }}
    >
      <div className="dialog-body">
        <p className="source-kind">
          编辑{kindLabel[source.kind]} · 基于修订 {base.revision}
        </p>
        <SourceFields
          kind={source.kind}
          value={value}
          onChange={setValue}
          disabled={command.busy || !!command.uncertain}
        />
        {conflict && (
          <section className="source-conflict" aria-label="资料版本冲突">
            <strong>资料已有新版本 · 修订 {source.revision}</strong>
            <p role="status">
              本地草稿已保留。
              {source.deletedAt
                ? '此资料已删除，请退出编辑并明确恢复后再修改。'
                : '请比较最新内容，再选择如何继续。'}
            </p>
            <h4>{source.title}</h4>
            <SourceText source={source} />
            {!source.deletedAt && (
              <div className="source-actions">
                <Button
                  type="button"
                  disabled={command.busy || !!command.uncertain}
                  onClick={() => {
                    setBase(source);
                    setValue({ title: source.title, content: source.content, url: source.url });
                  }}
                >
                  载入最新资料
                </Button>
                <Button
                  type="button"
                  disabled={command.busy || !!command.uncertain}
                  onClick={() => setBase(source)}
                >
                  保留草稿，基于最新修订
                </Button>
              </div>
            )}
          </section>
        )}
        <CommandFeedback command={command} />
      </div>
      <div className="dialog-footer">
        <Button type="button" disabled={command.busy} onClick={onClose}>
          取消编辑
        </Button>
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={!valid || !dirty || conflict || !!source.deletedAt || !!command.uncertain}
        >
          保存资料修改
        </Button>
      </div>
    </form>
  );
}
function SourceLifecycleControl({
  source,
  onBusy,
  onPending,
}: {
  source: ProjectSource;
  onBusy(value: boolean): void;
  onPending(value: boolean): void;
}) {
  const [pending, setPending] = useState<{
    action: 'delete' | 'restore';
    expectedRevision: number;
  } | null>(null);
  const command = useSourceCommand(() => setPending(null));
  useEffect(() => {
    onBusy(command.busy);
    return () => onBusy(false);
  }, [command.busy, onBusy]);
  useEffect(() => {
    onPending(!!pending);
    return () => onPending(false);
  }, [pending, onPending]);
  const conflict = !!pending && pending.expectedRevision !== source.revision;
  return (
    <div className="source-lifecycle">
      {!pending ? (
        <Button
          variant={source.deletedAt ? 'secondary' : 'ghost'}
          onClick={() =>
            setPending({
              action: source.deletedAt ? 'restore' : 'delete',
              expectedRevision: source.revision,
            })
          }
        >
          {source.deletedAt ? '恢复资料' : '删除资料'}
        </Button>
      ) : (
        <section className="source-conflict" aria-label="资料删除或恢复">
          <strong>{pending.action === 'delete' ? '删除这份资料？' : '恢复这份资料？'}</strong>
          <p>
            {pending.action === 'delete'
              ? '移入已删除列表，保留修订历史；已有任务、运行与冻结材料保持不变。'
              : '恢复到当前资料列表，不会重新发送给模型。'}
          </p>
          {conflict && <p role="status">资料已变化，请取消后重新核对。</p>}
          <div className="source-actions">
            <Button type="button" disabled={command.busy} onClick={() => setPending(null)}>
              取消资料操作
            </Button>
            <Button
              type="button"
              variant={pending.action === 'delete' ? 'danger' : 'primary'}
              busy={command.busy}
              disabled={conflict || !!command.uncertain}
              onClick={() =>
                void command.save({
                  path: pathFor(source.projectId, source.id) + '/lifecycle',
                  method: 'POST',
                  body: pending,
                  key: crypto.randomUUID(),
                })
              }
            >
              {pending.action === 'delete' ? '确认删除资料' : '确认恢复资料'}
            </Button>
          </div>
          <CommandFeedback command={command} />
        </section>
      )}
    </div>
  );
}
function SourceHistory({ projectId, sourceId }: { projectId: string; sourceId: string }) {
  const [items, setItems] = useState<SourceRevision[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  async function load(before?: number, signal?: AbortSignal) {
    setBusy(true);
    setError('');
    try {
      const result = await request<SourceRevisionPage>(
        pathFor(projectId, sourceId) + '/revisions' + (before ? '?before=' + before : ''),
        { signal },
      );
      if (alive.current && !signal?.aborted) {
        setItems((old) =>
          before
            ? [
                ...old,
                ...result.items.filter(
                  (item) =>
                    !old.some((previous) => previous.source.revision === item.source.revision),
                ),
              ]
            : result.items,
        );
        setCursor(result.nextCursor);
      }
    } catch (cause) {
      if (alive.current && !signal?.aborted) {
        setItems([]);
        setCursor(null);
        setError((cause as Error).message);
      }
    } finally {
      if (alive.current && !signal?.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    void load(undefined, abort.signal);
    return () => {
      alive.current = false;
      abort.abort();
    };
  }, [projectId, sourceId]);
  return (
    <section className="source-history" aria-label="资料历史版本">
      <Button disabled={busy} onClick={() => void load()}>
        刷新资料记录
      </Button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {items.map((item) => (
        <details key={item.source.revision}>
          <summary>
            修订 {item.source.revision} · {actionLabel[item.action]} · {item.source.title}
          </summary>
          <p className="source-meta">
            {item.source.updatedByName} · {time(item.source.updatedAt)}
          </p>
          <SourceText source={item.source} />
        </details>
      ))}
      {busy && (
        <p className="hint" role="status">
          正在读取修订…
        </p>
      )}
      {cursor && (
        <Button busy={busy} onClick={() => void load(cursor)}>
          加载更早资料修订
        </Button>
      )}
    </section>
  );
}
