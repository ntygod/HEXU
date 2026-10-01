import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type { ResultRevision } from '../../../packages/contracts/src/results.js';
import {
  normalizeResultReferenceUrl,
  parseResultReferenceCreate,
  type ResultReference,
  type ResultReferenceCreate,
  type ResultReferenceLifecycle,
  type ResultReferencePage,
} from '../../../packages/contracts/src/result-references.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Dialog, Icon } from '../../../packages/ui/src/index.js';
import { canEditTask, time, useApp, useTaskDraft } from './state.js';
import { useAssistanceRead } from './assistance-common.js';
import './result-references.css';
interface Attempt {
  path: string;
  body: ResultReferenceCreate | ResultReferenceLifecycle;
  key: string;
  requestId?: string;
}
interface Pending {
  attempt?: Attempt;
}
const decode = <T,>(value: string): T | null => {
  try {
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
};
const rootPath = (version: ResultRevision) =>
  `/results/${version.resultId}/versions/${version.id}/references`;
const createPurpose = (id: string) => `result-reference-create:${id}`;
const withdrawPurpose = (id: string) => `result-reference-withdraw:${id}`;
/** Shared only by this editor's two commands; requestId owns a UI response, never a server operation. */
function useReferenceMutation<D extends Pending>(
  task: Task,
  purpose: string,
  put: (value: D | null) => void,
  completed: (value: ResultReference) => void,
  allowed = true,
) {
  const { data, version, readDraft, saveDraft, refresh } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deniedAt, setDeniedAt] = useState<number | null>(null);
  const alive = useRef(true),
    inFlight = useRef(false),
    currentVersion = useRef(version);
  currentVersion.current = version;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = data.tasks.find((item) => item.id === task.id);
  const editable = allowed && !!current && canEditTask(data, current) && deniedAt !== version;
  useEffect(() => {
    if (!editable) {
      saveDraft(task.id, purpose, '');
      put(null);
    }
  }, [editable, task.id, purpose, saveDraft]);
  async function run(packet: Attempt, draft: D) {
    if (!editable || inFlight.current) return;
    // Another mounted editor may confirm the same immutable request before its old response arrives.
    const attempt = { ...packet, requestId: crypto.randomUUID() };
    const original = { ...draft, attempt };
    put(original);
    inFlight.current = true;
    setBusy(true);
    setError('');
    const matches = () =>
      decode<D>(readDraft(task.id, purpose) ?? '')?.attempt?.requestId === attempt.requestId;
    try {
      const value = await request<ResultReference>(attempt.path, {
        method: 'POST',
        body: attempt.body,
        key: attempt.key,
      });
      if (!matches()) return;
      saveDraft(task.id, purpose, '');
      if (!alive.current) return;
      put(null);
      completed(value);
      await refresh().catch(() => {});
    } catch (cause) {
      if (!matches()) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      const denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      const { attempt: _attempt, ...unsent } = original;
      if (known) saveDraft(task.id, purpose, denied ? '' : JSON.stringify(unsent));
      if (!alive.current) return;
      if (denied) {
        put(null);
        setDeniedAt(currentVersion.current);
      } else if (known) put(unsent as D);
      setError(cause instanceof Error ? cause.message : '关联操作失败');
      await refresh().catch(() => {});
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return { busy, error, setError, editable, run };
}
interface RegisterDraft extends Pending {
  kind: 'report' | 'release';
  title: string;
  url: string;
  environment: string;
}
function RegisterReference({
  task,
  version,
  allowed,
  created,
}: {
  task: Task;
  version: ResultRevision;
  allowed: boolean;
  created: () => void;
}) {
  const { data, notice } = useApp(),
    purpose = createPurpose(version.id);
  const [stored, setStored] = useTaskDraft(task.id, purpose),
    [open, setOpen] = useState(false);
  const draft = decode<RegisterDraft>(stored);
  const put = (value: RegisterDraft | null) => setStored(value ? JSON.stringify(value) : '');
  const command = useReferenceMutation<RegisterDraft>(
    task,
    purpose,
    put,
    (value) => {
      setOpen(false);
      notice(
        value.status === 'withdrawn'
          ? '原登记已撤下，确认回执没有恢复链接'
          : `链接已登记到v${version.revision}；外部状态未核验`,
      );
      created();
    },
    allowed,
  );
  useEffect(() => {
    if (!command.editable || !allowed) setOpen(false);
  }, [command.editable, allowed]);
  function submit() {
    if (!draft || draft.attempt || !allowed) return;
    try {
      const body = parseResultReferenceCreate({
        action: 'register',
        expectedResultRevision: version.revision,
        kind: draft.kind,
        title: draft.title,
        url: draft.url,
        environment: draft.environment,
      });
      void command.run({ path: rootPath(version), body, key: crypto.randomUUID() }, draft);
    } catch (cause) {
      command.setError(cause instanceof Error ? cause.message : '请核对链接');
    }
  }
  return (
    <div className="reference-register-action">
      <Button
        disabled={!command.editable || !allowed}
        onClick={() => {
          if (!draft) put({ kind: 'report', title: '', url: '', environment: '' });
          command.setError('');
          setOpen(true);
        }}
      >
        {draft?.attempt ? '确认原链接登记' : draft ? '继续编辑链接登记' : '登记报告或发布链接'}
      </Button>
      {command.error && !open && (
        <p className="form-error" role="alert">
          {command.error}
        </p>
      )}
      {open && command.editable && draft && (
        <Dialog title="登记报告或发布链接" onClose={() => setOpen(false)}>
          <form
            className="result-reference-form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <section className="reference-fixed-source" aria-label="链接的固定成果版本">
              <strong>
                {version.title} · v{version.revision}
              </strong>
              <p>
                {task.shortId} ·{' '}
                {task.visibility === 'private'
                  ? '仅自己可见'
                  : `原项目「${data.projects.find((p) => p.id === task.projectId)?.name ?? '当前项目'}」成员可见`}
              </p>
            </section>
            <p className="hint">
              只登记你确认的稳定地址，不读取外部内容或触发部署。链接可用性和发布状态均未核验，完成任务不要求登记链接。
            </p>
            <label className="field">
              链接类型
              <select
                aria-label="链接类型"
                value={draft.kind}
                disabled={command.busy || !!draft.attempt}
                onChange={(e) => put({ ...draft, kind: e.target.value as RegisterDraft['kind'] })}
              >
                <option value="report">报告链接</option>
                <option value="release">发布链接</option>
              </select>
            </label>
            <label className="field">
              链接标题
              <input
                aria-label="链接标题"
                autoFocus
                required
                maxLength={160}
                value={draft.title}
                disabled={command.busy || !!draft.attempt}
                onChange={(e) => put({ ...draft, title: e.target.value })}
              />
            </label>
            <label className="field">
              稳定链接
              <input
                aria-label="稳定链接"
                type="url"
                autoComplete="off"
                required
                maxLength={2048}
                value={draft.url}
                disabled={command.busy || !!draft.attempt}
                onChange={(e) => put({ ...draft, url: e.target.value })}
                placeholder="https://example.test/reports/release-1#section"
              />
            </label>
            <p className="hint">
              仅接受HTTP/HTTPS且不含查询参数的地址，不接受登录凭据或明显的token/签名片段；请改用可分享的稳定地址，系统不会自动剥离参数。普通行号/章节锚点可保留，请自行确认没有秘密内容。
            </p>
            <label className="field">
              环境说明（可选）
              <input
                aria-label="环境说明（可选）"
                maxLength={240}
                value={draft.environment}
                disabled={command.busy || !!draft.attempt}
                onChange={(e) => put({ ...draft, environment: e.target.value })}
                placeholder="例如：测试环境、正式环境；不填配置或凭据"
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            </label>
            {command.error && (
              <p className="form-error" role="alert">
                {command.error}
              </p>
            )}
            {draft.attempt && (
              <section className="reference-fixed-source" aria-label="原链接登记待确认">
                <p>
                  登记可能已经保存，只确认原版本、原内容和操作标识；关闭不撤销。待确认包仅在当前页面会话保留，硬刷新不恢复。
                </p>
                <Button
                  type="button"
                  busy={command.busy}
                  onClick={() => void command.run(draft.attempt!, draft)}
                >
                  确认原登记是否已保存
                </Button>
              </section>
            )}
            <footer className="dialog-actions">
              <Button type="button" onClick={() => setOpen(false)}>
                关闭并保留草稿
              </Button>
              {!draft.attempt && (
                <>
                  <Button
                    type="button"
                    disabled={command.busy}
                    onClick={() => {
                      put(null);
                      setOpen(false);
                    }}
                  >
                    放弃未提交登记
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    busy={command.busy}
                    disabled={!draft.title.trim() || !draft.url.trim()}
                  >
                    确认登记到v{version.revision}
                  </Button>
                </>
              )}
            </footer>
            <p className="hint">
              未提交草稿只在当前账号/空间的页面会话内保存；切换版本不转移来源，硬刷新后不恢复。
            </p>
          </form>
        </Dialog>
      )}
    </div>
  );
}
interface WithdrawDraft extends Pending {
  expectedRevision: number;
}
function ReferenceRow({
  task,
  version,
  reference,
  changed,
}: {
  task: Task;
  version: ResultRevision;
  reference: ResultReference;
  changed: () => void;
}) {
  const { notice } = useApp(),
    purpose = withdrawPurpose(reference.id);
  const [stored, setStored] = useTaskDraft(task.id, purpose),
    [open, setOpen] = useState(false);
  const draft = decode<WithdrawDraft>(stored),
    put = (value: WithdrawDraft | null) => setStored(value ? JSON.stringify(value) : '');
  const command = useReferenceMutation<WithdrawDraft>(task, purpose, put, () => {
    setOpen(false);
    notice('已撤下这条登记；外部页面和原成果版本不变');
    changed();
  });
  useEffect(() => {
    if (!command.editable) setOpen(false);
  }, [command.editable]);
  const dismiss = () => {
    if (!draft?.attempt) put(null);
    setOpen(false);
  };
  let href: string | null = null;
  try {
    href = normalizeResultReferenceUrl(reference.url);
  } catch {
    /* Never activate an out-of-contract stored URL. */
  }
  const stale =
    !!draft && (draft.expectedRevision !== reference.revision || reference.status !== 'active');
  return (
    <article
      className={`result-reference-row ${reference.status}`}
      data-reference-id={reference.id}
    >
      <div className="reference-row-heading">
        <span className="badge neutral">
          {reference.kind === 'report' ? '报告链接' : '发布链接'}
        </span>
        <strong>{reference.title}</strong>
        <span className="badge neutral">
          {reference.status === 'withdrawn' ? '已撤下' : '未核验'}
        </span>
      </div>
      {reference.status === 'active' && href ? (
        <a className="reference-external" href={href} target="_blank" rel="noopener noreferrer">
          {href}
          <Icon name="arrow" size={14} />
        </a>
      ) : (
        <details>
          <summary>查看原登记地址</summary>
          <p className="reference-original-url">{reference.url}</p>
        </details>
      )}
      {!!reference.environment && <p>环境说明：{reference.environment}</p>}
      <p className="hint">
        {reference.source.actor.name} 手动登记 · {time(reference.createdAt)} · v
        {reference.resultRevision} · 外部内容与发布状态未核验
      </p>
      {reference.status === 'withdrawn' && (
        <p className="hint">
          {reference.withdrawnBy?.name ?? '成员'} 于
          {reference.withdrawnAt ? time(reference.withdrawnAt) : '记录时间未知'}
          撤下登记；原记录保留。
        </p>
      )}
      {(reference.status === 'active' || draft?.attempt) && (
        <Button
          variant="ghost"
          disabled={!command.editable}
          onClick={() => {
            if (!draft) put({ expectedRevision: reference.revision });
            command.setError('');
            setOpen(true);
          }}
        >
          {draft?.attempt ? '确认原撤下请求' : '撤下登记'}
        </Button>
      )}
      {command.error && !open && (
        <p className="form-error" role="alert">
          {command.error}
        </p>
      )}
      {open && command.editable && draft && (
        <Dialog title="撤下这条链接登记" onClose={dismiss}>
          <div className="result-reference-form">
            <section className="reference-fixed-source" aria-label="准备撤下的固定登记">
              <strong>{reference.title}</strong>
              <p>
                {version.title} · v{version.revision}
              </p>
              <p className="reference-original-url">{reference.url}</p>
            </section>
            <p>
              仅从这个固定版本撤下链接，保留原登记和操作者记录。不删除外部页面、不修改发布状态，也不改变成果正文或任务完成状态。
            </p>
            {stale && !draft.attempt && (
              <p role="status">这条登记已变化，原确认不可用；关闭后查看当前记录。</p>
            )}
            {command.error && (
              <p className="form-error" role="alert">
                {command.error}
              </p>
            )}
            {draft.attempt && (
              <section className="reference-fixed-source" aria-label="原撤下请求待确认">
                <p>
                  可能已经撤下，只确认同一登记、修订和操作标识；关闭不会撤销已提交动作，硬刷新不恢复待确认包。
                </p>
                <Button
                  type="button"
                  busy={command.busy}
                  onClick={() => void command.run(draft.attempt!, draft)}
                >
                  确认原请求是否已撤下
                </Button>
              </section>
            )}
            <footer className="dialog-actions">
              <Button type="button" onClick={dismiss}>
                {draft.attempt ? '关闭' : '取消'}
              </Button>
              {!draft.attempt && (
                <Button
                  type="button"
                  variant="primary"
                  busy={command.busy}
                  disabled={stale}
                  onClick={() =>
                    void command.run(
                      {
                        path: rootPath(version) + `/${reference.id}/lifecycle`,
                        body: {
                          action: 'withdraw',
                          expectedResultRevision: version.revision,
                          expectedRevision: draft.expectedRevision,
                        },
                        key: crypto.randomUUID(),
                      },
                      draft,
                    )
                  }
                >
                  确认撤下登记
                </Button>
              )}
            </footer>
          </div>
        </Dialog>
      )}
    </article>
  );
}
export function ResultReferences({ task, version }: { task: Task; version: ResultRevision }) {
  const { saveDraft } = useApp();
  const [cursors, setCursors] = useState<string[]>([]),
    cursor = cursors.at(-1);
  const read = useAssistanceRead<ResultReferencePage>(
    rootPath(version) + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
  );
  const seen = useRef(new Set<string>());
  for (const reference of read.value?.items ?? []) seen.current.add(reference.id);
  useEffect(() => {
    if (read.denied) {
      saveDraft(task.id, createPurpose(version.id), '');
      for (const id of seen.current) saveDraft(task.id, withdrawPurpose(id), '');
    }
  }, [read.denied, saveDraft, task.id, version.id]);
  return (
    <section className="result-references" aria-label="此版本的报告与发布链接">
      <div className="reference-section-heading">
        <div>
          <h3>报告与发布链接</h3>
          <p className="hint">只关联当前v{version.revision}，成员自行登记，外部状态未核验。</p>
        </div>
        <RegisterReference
          task={task}
          version={version}
          allowed={!read.denied}
          created={() => {
            setCursors([]);
            read.retry();
          }}
        />
      </div>
      {read.error && (
        <p className="form-error" role="alert">
          {read.error}
          <Button type="button" onClick={read.retry}>
            重读链接登记
          </Button>
        </p>
      )}
      {!read.value && !read.error && <p role="status">正在读取此版本的链接…</p>}
      {read.value && !read.value.items.length && (
        <p className="hint">此版本没有链接登记；可以直接讨论、继续或完成任务。</p>
      )}
      {read.value?.items.map((reference) => (
        <ReferenceRow
          key={reference.id}
          task={task}
          version={version}
          reference={reference}
          changed={read.retry}
        />
      ))}
      {(cursors.length > 0 || read.value?.nextCursor) && (
        <nav className="reference-pagination" aria-label="链接登记分页">
          <Button disabled={!cursors.length} onClick={() => setCursors((old) => old.slice(0, -1))}>
            较新的登记
          </Button>
          <span>第{cursors.length + 1}页</span>
          <Button
            disabled={!read.value?.nextCursor}
            onClick={() => {
              if (read.value?.nextCursor) setCursors((old) => [...old, read.value!.nextCursor!]);
            }}
          >
            较早的登记
          </Button>
        </nav>
      )}
    </section>
  );
}
