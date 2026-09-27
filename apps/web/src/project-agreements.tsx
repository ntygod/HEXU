import { useEffect, useRef, useState } from 'react';
import type { Project, Task } from '../../../packages/contracts/src/index.js';
import type {
  AgreementContent,
  AgreementHistory,
  AgreementNotice,
  AgreementPage,
  AgreementRevision,
  AgreementSummary,
  ProjectAgreement,
} from '../../../packages/contracts/src/project-agreements.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Dialog, Empty, Icon } from '../../../packages/ui/src/index.js';
import { canEditTask, Link, time, useApp } from './state.js';
import {
  agreementPath,
  agreementStateText,
  AgreementFeedback,
  AgreementFields,
  useAgreementCommand,
  useAgreementRead,
} from './agreement-common.js';
import './project-agreements.css';

function AgreementCollection({
  projectId,
  onSelect,
  compact = false,
}: {
  projectId: string;
  onSelect(id: string): void;
  compact?: boolean;
}) {
  const { version } = useApp();
  const [state, setState] = useState('active'),
    [query, setQuery] = useState(''),
    [reload, setReload] = useState(0);
  const [items, setItems] = useState<AgreementSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const path = agreementPath(projectId) + `?state=${state}&q=${encodeURIComponent(query)}`;
  useEffect(() => {
    const current = ++generation.current,
      abort = new AbortController();
    setBusy(true);
    setError('');
    void request<AgreementPage>(path, { signal: abort.signal })
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
  }, [path, version, reload]);
  async function more() {
    if (busy || !cursor) return;
    const current = generation.current;
    setBusy(true);
    try {
      const page = await request<AgreementPage>(path + '&cursor=' + encodeURIComponent(cursor));
      if (current === generation.current) {
        setItems((old) => [
          ...old,
          ...page.items.filter((item) => !old.some((existing) => existing.id === item.id)),
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
    <section
      className={`agreement-collection ${compact ? 'compact' : ''}`}
      aria-label="项目约定列表"
    >
      <div className="agreement-toolbar">
        <label>
          约定状态
          <select
            aria-label="约定状态筛选"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="active">当前有效</option>
            <option value="inactive">已停用</option>
            <option value="superseded">已替代</option>
            <option value="all">全部记录</option>
          </select>
        </label>
        <label className="work-filter">
          <Icon name="search" size={15} />
          <input
            aria-label="搜索项目约定"
            value={query}
            maxLength={160}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="标题或约定正文…"
          />
        </label>
      </div>
      {error && (
        <div role="alert" className="form-error">
          {error}
          <Button onClick={() => setReload((value) => value + 1)}>重读约定列表</Button>
        </div>
      )}
      {busy && (
        <p className="hint" role="status">
          正在读取项目约定…
        </p>
      )}
      <div className="agreement-grid">
        {items.map((item) => (
          <article className="agreement-card" key={item.id}>
            <button aria-label={`查看约定 ${item.title}`} onClick={() => onSelect(item.id)}>
              <span className="agreement-kicker">
                {agreementStateText[item.state]} · 修订 {item.revision}
              </span>
              <strong>{item.title}</strong>
              <p>{item.excerpt}</p>
              <small>
                {item.updatedByName} · {time(item.updatedAt)}
              </small>
            </button>
          </article>
        ))}
      </div>
      {!items.length && !busy && !error && (
        <Empty
          title="暂无匹配的项目约定"
          description="在项目任务的讨论中选择“设为项目约定”，编辑后明确保存。"
        />
      )}
      {cursor && (
        <Button busy={busy} onClick={() => void more()}>
          加载更多约定
        </Button>
      )}
    </section>
  );
}
export function ProjectAgreements({
  project,
  agreementId,
  onSelect,
}: {
  project: Project;
  agreementId: string;
  onSelect(id: string): void;
}) {
  const { data } = useApp();
  const editable =
    data.mode === 'local-preview' || ['edit', 'manage'].includes(project.access ?? '');
  return (
    <section className="project-agreements">
      <header className="agreement-intro">
        <h2>项目约定</h2>
        <p>来自具体讨论，经成员编辑并明确保存。普通资料与 AI 建议不会自动成为约定。</p>
      </header>
      <AgreementCollection projectId={project.id} onSelect={onSelect} />
      {agreementId && (
        <AgreementDialog
          projectId={project.id}
          agreementId={agreementId}
          editable={editable}
          onSelect={onSelect}
          onClose={() => onSelect('')}
        />
      )}
    </section>
  );
}
function AgreementDialog({
  projectId,
  agreementId,
  editable,
  onSelect,
  onClose,
}: {
  projectId: string;
  agreementId: string;
  editable: boolean;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="项目约定" drawer onClose={() => !busy && onClose()}>
      <AgreementViewer
        key={agreementId}
        projectId={projectId}
        id={agreementId}
        editable={editable}
        onBusy={setBusy}
        onSelect={onSelect}
        onBack={onClose}
      />
    </Dialog>
  );
}
export function TaskAgreements({ task }: { task: Task }) {
  return task.visibility === 'project' && task.projectId ? (
    <TaskAgreementNotice key={`${task.id}:${task.projectId}`} task={task} />
  ) : null;
}
function TaskAgreementNotice({ task }: { task: Task }) {
  const { data } = useApp();
  const { value, error, retry } = useAgreementRead<AgreementNotice>(
    `/tasks/${task.id}/agreements-notice`,
  );
  const [seen, setSeen] = useState<number | null>(null),
    [open, setOpen] = useState(false),
    [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (value && seen === null) setSeen(value.version);
  }, [value, seen]);
  const editable = canEditTask(data, task);
  const changed = !!value && seen !== null && value.version !== seen;
  return (
    <>
      <button
        className="text-button"
        aria-label={`项目约定（${value?.activeCount ?? 0}）${changed ? '，有更新' : ''}`}
        disabled={!value}
        onClick={() => {
          setOpen(true);
          setSelected('');
          setSeen(value!.version);
        }}
      >
        项目约定 {value?.activeCount ?? 0}
        {changed && <span className="agreement-updated">有更新</span>}
      </button>
      {error && (
        <button className="text-button" onClick={retry}>
          重试约定提示
        </button>
      )}
      {open && (
        <Dialog title="任务中的项目约定" drawer onClose={() => !busy && setOpen(false)}>
          {selected ? (
            <AgreementViewer
              key={selected}
              projectId={task.projectId!}
              id={selected}
              editable={editable}
              onBusy={setBusy}
              onSelect={setSelected}
              onBack={() => setSelected('')}
            />
          ) : (
            <>
              <div className="dialog-body agreement-task-list">
                <p className="hint">
                  当前项目中明确保存的约定。查看或修改不会自动发送到正在运行的模型。
                </p>
                <AgreementCollection projectId={task.projectId!} onSelect={setSelected} compact />
              </div>
              <div className="dialog-footer">
                <Button
                  onClick={() => {
                    if (value) setSeen(value.version);
                    setOpen(false);
                  }}
                >
                  关闭约定
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
function AgreementViewer({
  projectId,
  id,
  editable,
  onBusy,
  onSelect,
  onBack,
}: {
  projectId: string;
  id: string;
  editable: boolean;
  onBusy(value: boolean): void;
  onSelect(id: string): void;
  onBack(): void;
}) {
  const loaded = useAgreementRead<ProjectAgreement>(agreementPath(projectId, id));
  const agreement = loaded.value;
  const [editing, setEditing] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [changing, setChanging] = useState(false);
  useEffect(() => {
    if (!editable || loaded.denied) setEditing(false);
  }, [editable, loaded.denied]);
  return (
    <>
      {loaded.error && (
        <div className="agreement-read-error" role="alert">
          {loaded.error}
          <Button type="button" onClick={loaded.retry}>
            重读项目约定
          </Button>
        </div>
      )}
      {!agreement ? (
        <div className="dialog-body">
          <Empty title={loaded.error ? '暂时无法查看约定' : '正在读取约定'} />
        </div>
      ) : editing && editable ? (
        <AgreementEditor agreement={agreement} onClose={() => setEditing(false)} onBusy={onBusy} />
      ) : (
        <>
          <div className="dialog-body agreement-detail">
            <span className="agreement-kicker">
              {agreementStateText[agreement.state]} · 修订 {agreement.revision}
            </span>
            <h3>{agreement.title}</h3>
            <p className="hint">
              {agreement.updatedByName} · {time(agreement.updatedAt)}
            </p>
            <pre className="agreement-text">{agreement.content}</pre>
            {agreement.statusReason && (
              <p className="agreement-state-note">{agreement.statusReason}</p>
            )}
            {agreement.supersededById && (
              <Button onClick={() => onSelect(agreement.supersededById!)}>查看后续约定</Button>
            )}
            {agreement.replacesId && (
              <Button variant="ghost" onClick={() => onSelect(agreement.replacesId!)}>
                查看被替代约定
              </Button>
            )}
            <details className="agreement-origin">
              <summary>
                讨论来源 · {agreement.origin.taskShortId} · {agreement.origin.actorName}
              </summary>
              <p>
                {agreement.origin.actorType === 'agent' ? 'AI 回复，经人明确保存' : '成员讨论'} ·{' '}
                {time(agreement.origin.createdAt)}
              </p>
              <pre>{agreement.origin.excerpt}</pre>
              {agreement.origin.truncated && (
                <p className="hint">来源节选，完整讨论保留在原任务。</p>
              )}
              <Link to={`/tasks/${agreement.origin.taskId}`}>查看原任务</Link>
              <p className="hint">
                发布人：{agreement.createdByName} · {time(agreement.createdAt)}
              </p>
            </details>
            <p className="hint">模型选材与发送尚未接入；保存或停用不会改变已有运行和冻结材料。</p>
            <div className="agreement-actions">
              {editable && agreement.state === 'active' && (
                <Button disabled={changing} onClick={() => setEditing(true)}>
                  编辑约定
                </Button>
              )}
              {editable && agreement.state !== 'superseded' && (
                <AgreementStateControl
                  agreement={agreement}
                  onBusy={onBusy}
                  onPending={setChanging}
                />
              )}
            </div>
            <Button aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>
              约定修订记录
            </Button>
            {historyOpen && <AgreementVersions projectId={projectId} id={id} />}
          </div>
          <div className="dialog-footer">
            <Button disabled={changing} onClick={onBack}>
              返回约定列表
            </Button>
          </div>
        </>
      )}
    </>
  );
}
function AgreementEditor({
  agreement,
  onClose,
  onBusy,
}: {
  agreement: ProjectAgreement;
  onClose(): void;
  onBusy(value: boolean): void;
}) {
  const [base, setBase] = useState(agreement),
    [value, setValue] = useState<AgreementContent>({
      title: agreement.title,
      content: agreement.content,
    });
  const command = useAgreementCommand(onClose);
  useEffect(() => {
    onBusy(command.busy);
    return () => onBusy(false);
  }, [command.busy, onBusy]);
  useEffect(() => {
    if (command.denied) setValue({ title: '', content: '' });
  }, [command.denied]);
  const conflict = base.revision !== agreement.revision;
  const dirty = value.title.trim() !== base.title || value.content !== base.content;
  const valid = !!value.title.trim() && !!value.content.trim();
  if (command.denied)
    return (
      <div className="dialog-body">
        <AgreementFeedback command={command} />
        <Button onClick={onClose}>关闭编辑</Button>
      </div>
    );
  return (
    <form
      className="drawer-form agreement-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !valid ||
          !dirty ||
          conflict ||
          agreement.state !== 'active' ||
          command.busy ||
          command.uncertain
        )
          return;
        void command.save({
          path: agreementPath(agreement.projectId, agreement.id),
          method: 'PATCH',
          body: { ...value, expectedRevision: base.revision },
          key: crypto.randomUUID(),
        });
      }}
    >
      <div className="dialog-body">
        <p className="agreement-kicker">编辑约定 · 基于修订 {base.revision}</p>
        <AgreementFields
          value={value}
          onChange={setValue}
          disabled={command.busy || !!command.uncertain}
        />
        {conflict && (
          <section className="agreement-conflict" aria-label="约定版本冲突">
            <strong>
              当前约定已变化 · {agreementStateText[agreement.state]} · r{agreement.revision}
            </strong>
            <h4>{agreement.title}</h4>
            <pre>{agreement.content}</pre>
            <p>本地草稿保留，比较后再明确保存。</p>
            {agreement.state === 'active' && (
              <div className="agreement-actions">
                <Button
                  type="button"
                  disabled={command.busy || !!command.uncertain}
                  onClick={() => {
                    setBase(agreement);
                    setValue({ title: agreement.title, content: agreement.content });
                  }}
                >
                  载入最新约定
                </Button>
                <Button
                  type="button"
                  disabled={command.busy || !!command.uncertain}
                  onClick={() => setBase(agreement)}
                >
                  保留草稿，基于最新约定
                </Button>
              </div>
            )}
          </section>
        )}
        <AgreementFeedback command={command} />
      </div>
      <div className="dialog-footer">
        <Button type="button" disabled={command.busy} onClick={onClose}>
          取消编辑约定
        </Button>
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={
            !valid || !dirty || conflict || agreement.state !== 'active' || !!command.uncertain
          }
        >
          保存约定修改
        </Button>
      </div>
    </form>
  );
}
function AgreementStateControl({
  agreement,
  onBusy,
  onPending,
}: {
  agreement: ProjectAgreement;
  onBusy(value: boolean): void;
  onPending(value: boolean): void;
}) {
  const [pending, setPending] = useState<{
      action: 'deactivate' | 'reactivate';
      expectedRevision: number;
    } | null>(null),
    [reason, setReason] = useState('');
  const command = useAgreementCommand(() => {
    setPending(null);
    setReason('');
  });
  useEffect(() => {
    onBusy(command.busy);
    return () => onBusy(false);
  }, [command.busy, onBusy]);
  useEffect(() => {
    onPending(!!pending);
    return () => onPending(false);
  }, [pending, onPending]);
  if (!pending)
    return (
      <Button
        variant="ghost"
        onClick={() =>
          setPending({
            action: agreement.state === 'active' ? 'deactivate' : 'reactivate',
            expectedRevision: agreement.revision,
          })
        }
      >
        {agreement.state === 'active' ? '停用约定' : '重新启用约定'}
      </Button>
    );
  const conflict =
    agreement.revision !== pending.expectedRevision || agreement.state === 'superseded';
  return (
    <section className="agreement-conflict agreement-state-control" aria-label="约定状态操作">
      <strong>{pending.action === 'deactivate' ? '停用这条约定？' : '重新启用这条约定？'}</strong>
      <p>保留历史，已有运行和已确认的材料不会改变。</p>
      {pending.action === 'deactivate' && (
        <label className="field">
          停用原因（可选）
          <input
            aria-label="停用原因"
            value={reason}
            maxLength={600}
            disabled={command.busy || !!command.uncertain}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      )}
      {conflict && (
        <p className="form-error" role="alert">
          约定已变化，请取消后重新核对。
        </p>
      )}
      <div className="agreement-actions">
        <Button disabled={command.busy} onClick={() => setPending(null)}>
          取消约定操作
        </Button>
        <Button
          variant={pending.action === 'deactivate' ? 'danger' : 'primary'}
          busy={command.busy}
          disabled={conflict || !!command.uncertain || command.denied}
          onClick={() =>
            void command.save({
              path: agreementPath(agreement.projectId, agreement.id) + '/lifecycle',
              method: 'POST',
              body: { ...pending, reason },
              key: crypto.randomUUID(),
            })
          }
        >
          {pending.action === 'deactivate' ? '确认停用约定' : '确认启用约定'}
        </Button>
      </div>
      <AgreementFeedback command={command} />
    </section>
  );
}
function AgreementVersions({ projectId, id }: { projectId: string; id: string }) {
  const [items, setItems] = useState<AgreementRevision[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  const labels = {
    created: '发布',
    updated: '修改',
    deactivated: '停用',
    reactivated: '启用',
    superseded: '被替代',
  };
  async function load(before?: number, signal?: AbortSignal) {
    setBusy(true);
    setError('');
    try {
      const result = await request<AgreementHistory>(
        agreementPath(projectId, id) + '/revisions' + (before ? '?before=' + before : ''),
        { signal },
      );
      if (alive.current && !signal?.aborted) {
        setItems((old) =>
          before
            ? [
                ...old,
                ...result.items.filter(
                  (item) =>
                    !old.some(
                      (previous) => previous.agreement.revision === item.agreement.revision,
                    ),
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
  }, [projectId, id]);
  return (
    <section className="agreement-history" aria-label="约定历史版本">
      <Button disabled={busy} onClick={() => void load()}>
        刷新约定记录
      </Button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {items.map((item) => (
        <details key={item.agreement.revision}>
          <summary>
            修订 {item.agreement.revision} · {labels[item.action]} · {item.agreement.title}
          </summary>
          <p className="hint">
            {item.agreement.updatedByName} · {time(item.agreement.updatedAt)}
          </p>
          <pre>{item.agreement.content}</pre>
          {item.agreement.statusReason && <p>{item.agreement.statusReason}</p>}
        </details>
      ))}
      {cursor && (
        <Button busy={busy} onClick={() => void load(cursor)}>
          加载更早约定修订
        </Button>
      )}
    </section>
  );
}
