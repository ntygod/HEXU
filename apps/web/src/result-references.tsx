import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, request } from '../../../packages/client/src/index.js';
import {
  parseAddResultReference,
  RESULT_REFERENCE_LIMIT,
  type AddResultReferenceInput,
  type ResultReference,
  type ResultReferenceList,
} from '../../../packages/contracts/src/result-references.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useAssistanceRead } from './assistance-common.js';
import { time } from './state.js';
import './result-references.css';

const kindLabel = { report: '报告', release: '发布' };
const emptyDraft = (): AddResultReferenceInput => ({
  kind: 'report',
  title: '',
  url: '',
  environment: '',
  sourceNote: '',
});
type Attempt = Readonly<{
  action: 'add' | 'remove';
  path: string;
  body: Readonly<AddResultReferenceInput> | Record<string, never>;
  key: string;
  snapshot: Readonly<AddResultReferenceInput>;
}>;

function ReferenceContent({ reference }: { reference: Readonly<AddResultReferenceInput> }) {
  return (
    <>
      <a href={reference.url} target="_blank" rel="noopener noreferrer">
        {reference.title}
      </a>
      <p className="result-reference-url">{reference.url}</p>
      <dl className="result-reference-notes">
        <dt>环境</dt>
        <dd>{reference.environment || '未填写'}</dd>
        <dt>来源说明</dt>
        <dd>{reference.sourceNote || '未填写'}</dd>
      </dl>
    </>
  );
}

/** Kept mounted while its editor is collapsed, and keyed by the loaded version by ResultPage. */
export function ResultReferencePanel({
  resultId,
  revisionId,
  revision,
  editable,
}: {
  resultId: string;
  revisionId: string;
  revision: number;
  editable: boolean;
}) {
  const path = `/results/${encodeURIComponent(resultId)}/versions/${encodeURIComponent(revisionId)}/references`;
  const read = useAssistanceRead<ResultReferenceList>(path);
  const helpId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [removing, setRemoving] = useState<ResultReference | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [acknowledgement, setAcknowledgement] = useState('');
  const [writeDenied, setWriteDenied] = useState(false);
  const pendingRef = useRef<Attempt | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const focusAfterClose = useRef(false);
  const removeOrigin = useRef<HTMLButtonElement | null>(null);
  const canWrite = editable && !read.denied && !writeDenied;
  const allowed = useRef(canWrite);
  allowed.current = canWrite;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (!canWrite) {
      generation.current++;
      pendingRef.current = null;
      inFlight.current = false;
      setPending(null);
      setBusy(false);
      setOpen(false);
      setRemoving(null);
      setDraft(emptyDraft());
    }
  }, [canWrite]);
  useEffect(() => {
    if (open || !focusAfterClose.current) return;
    focusAfterClose.current = false;
    panel.current
      ?.querySelector<HTMLButtonElement>(
        pending && !busy ? '[data-reference-retry]' : '[data-reference-add]',
      )
      ?.focus();
  }, [open, pending, busy]);

  async function send(attempt: Attempt) {
    // A synchronous guard also covers two clicks before React has rendered busy=true.
    if (!allowed.current || inFlight.current) return;
    if (pendingRef.current && pendingRef.current !== attempt) return;
    pendingRef.current = attempt;
    inFlight.current = true;
    setPending(attempt);
    setBusy(true);
    setError('');
    setAcknowledgement('');
    const current = generation.current;
    const isCurrent = () => alive.current && current === generation.current && allowed.current;
    try {
      await request<ResultReference>(attempt.path, {
        method: 'POST',
        body: attempt.body,
        key: attempt.key,
      });
      if (!isCurrent()) return;
      // The write is acknowledged before a separate list GET is requested. A failed GET
      // can only be retried as a read, never as another submission of the write.
      pendingRef.current = null;
      setPending(null);
      setRemoving(null);
      setDraft(emptyDraft());
      setOpen(false);
      setAcknowledgement(attempt.action === 'add' ? '已保存链接' : '已移除链接');
      read.retry();
    } catch (cause) {
      if (!isCurrent()) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      if (known) {
        pendingRef.current = null;
        setPending(null);
      }
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) setWriteDenied(true);
      setError(cause instanceof Error ? cause.message : '未能确认链接操作结果');
    } finally {
      if (isCurrent()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  function add() {
    if (!canWrite || inFlight.current || pendingRef.current || !read.value || read.error) return;
    try {
      const body = Object.freeze(parseAddResultReference(draft));
      void send(
        Object.freeze({ action: 'add', path, body, key: crypto.randomUUID(), snapshot: body }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请检查链接内容');
    }
  }

  function remove(reference: ResultReference) {
    if (!canWrite || inFlight.current || pendingRef.current) return;
    const snapshot = Object.freeze({
      kind: reference.kind,
      title: reference.title,
      url: reference.url,
      environment: reference.environment ?? '',
      sourceNote: reference.sourceNote ?? '',
    });
    void send(
      Object.freeze({
        action: 'remove',
        path: `${path}/${encodeURIComponent(reference.id)}/remove`,
        body: Object.freeze({}),
        key: crypto.randomUUID(),
        snapshot,
      }),
    );
  }

  const locked = busy || !!pending;
  const items = read.denied ? [] : (read.value?.items ?? []);
  const full = items.length >= RESULT_REFERENCE_LIMIT;
  return (
    <section ref={panel} className="result-references" aria-label="报告与发布链接">
      <header className="result-references-heading">
        <div>
          <h2>报告与发布链接</h2>
          <p>人工关联到当前固定版本 v{revision}，报告和发布链接均为可选项。</p>
        </div>
        {canWrite && !open && (
          <Button
            type="button"
            data-reference-add
            disabled={!read.value || (full && !pending) || (!!pending && pending.action !== 'add')}
            onClick={() => setOpen(true)}
          >
            添加链接
          </Button>
        )}
      </header>
      <p className="result-references-help" id={helpId}>
        仅记录成员填写的 HTTP(S)
        地址；不读取链接内容、不检查可用性，也不据此判断报告通过或发布上线。完成任务不要求添加链接。
      </p>
      {acknowledgement && (
        <p className="result-references-ack" role="status">
          {acknowledgement}；列表如未更新，可重新读取。
        </p>
      )}
      {read.error && (
        <div className="result-references-feedback" role="alert">
          <p>{read.error}</p>
          {!read.denied && (
            <p>
              {acknowledgement
                ? '操作已确认，列表读取失败；重新读取只会获取列表。'
                : '暂时无法读取最新链接，已显示的记录可能不是最新。'}
            </p>
          )}
        </div>
      )}
      {!read.denied && (
        <Button type="button" variant="ghost" onClick={read.retry}>
          重新读取链接
        </Button>
      )}
      {!read.value && !read.error && <p role="status">正在读取此版本的链接…</p>}
      {read.denied && <p>当前无法查看此版本的链接。</p>}
      {!canWrite && !read.denied && (
        <p className="result-references-help">
          当前为只读，具有任务编辑权限的成员可添加或移除链接。
        </p>
      )}
      {error && (
        <p className="result-references-feedback" role="alert">
          {error}
        </p>
      )}
      {canWrite && pending && (
        <section className="result-reference-pending" aria-label="链接请求待确认">
          <h3>{busy ? '正在提交原请求' : '尚未确认操作结果'}</h3>
          <p>
            原请求：{pending.action === 'add' ? '添加' : '移除'}
            {kindLabel[pending.snapshot.kind]}链接 · 固定版本 v{revision}
          </p>
          <ReferenceContent reference={pending.snapshot} />
          <p>请求可能已经保存。确认会复用原内容和请求标识；收起编辑不会撤销已发送的操作。</p>
          <Button type="button" data-reference-retry busy={busy} onClick={() => void send(pending)}>
            {pending.action === 'add' ? '确认原添加请求' : '确认原移除请求'}
          </Button>
        </section>
      )}
      {canWrite && open && (
        <form
          className="result-reference-form"
          aria-label="添加此版本的外部链接"
          aria-describedby={helpId}
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div className="result-reference-fields">
            <label className="field">
              链接类型
              <select
                aria-label="链接类型"
                value={draft.kind}
                disabled={locked}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    kind: event.target.value as AddResultReferenceInput['kind'],
                  })
                }
              >
                <option value="report">报告</option>
                <option value="release">发布</option>
              </select>
            </label>
            <label className="field">
              链接标题
              <input
                autoFocus
                required
                value={draft.title}
                maxLength={160}
                disabled={locked}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </label>
            <label className="field result-reference-wide">
              链接地址
              <input
                type="url"
                required
                value={draft.url}
                maxLength={2048}
                disabled={locked}
                placeholder="https://…"
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </label>
            <label className="field result-reference-wide">
              环境（可选）
              <input
                value={draft.environment ?? ''}
                maxLength={120}
                disabled={locked}
                placeholder="例如：测试环境"
                onChange={(event) => setDraft({ ...draft, environment: event.target.value })}
              />
            </label>
            <label className="field result-reference-wide">
              来源说明（可选）
              <textarea
                aria-label="来源说明（可选）"
                value={draft.sourceNote ?? ''}
                maxLength={1000}
                rows={3}
                disabled={locked}
                onChange={(event) => setDraft({ ...draft, sourceNote: event.target.value })}
              />
            </label>
          </div>
          <div className="result-reference-actions">
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={locked || full || !read.value || !!read.error}
            >
              保存链接
            </Button>
            <Button
              type="button"
              onClick={() => {
                focusAfterClose.current = true;
                setOpen(false);
              }}
            >
              收起编辑
            </Button>
          </div>
        </form>
      )}
      {!!removing && canWrite && !pending && (
        <section className="result-reference-pending" aria-label="移除链接确认">
          <h3>移除此版本的链接？</h3>
          <p>{removing.title}</p>
          <p>仅移除 HEXU 中的关联，不删除外部报告或发布内容。</p>
          <div className="result-reference-actions">
            <Button
              type="button"
              variant="danger"
              disabled={locked}
              onClick={() => remove(removing)}
            >
              确认移除此链接
            </Button>
            <Button
              type="button"
              onClick={() => {
                setRemoving(null);
                removeOrigin.current?.focus();
              }}
            >
              取消移除
            </Button>
          </div>
        </section>
      )}
      <div className="result-reference-list">
        {items.map((reference) => (
          <article
            className="result-reference-item"
            aria-label={`${kindLabel[reference.kind]}链接：${reference.title}`}
            key={reference.id}
          >
            <header>
              <span>{kindLabel[reference.kind]} · 人工记录</span>
              <span>可用性未检查 · 外部状态未知</span>
            </header>
            <ReferenceContent
              reference={{
                ...reference,
                environment: reference.environment ?? '',
                sourceNote: reference.sourceNote ?? '',
              }}
            />
            <footer>
              <p>
                记录人：{reference.recordedBy.name} ·{' '}
                <time dateTime={reference.recordedAt}>{time(reference.recordedAt)}</time>
              </p>
              {canWrite && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={locked}
                  onClick={(event) => {
                    removeOrigin.current = event.currentTarget;
                    setRemoving(reference);
                    setOpen(false);
                    setError('');
                  }}
                >
                  移除链接
                </Button>
              )}
            </footer>
          </article>
        ))}
      </div>
      {read.value && !read.denied && !items.length && !read.error && (
        <p className="result-references-help">此版本尚未关联报告或发布链接。</p>
      )}
      {full && (
        <p className="result-references-help">
          此版本最多保留 {RESULT_REFERENCE_LIMIT} 条有效链接，移除已有链接后可继续添加。
        </p>
      )}
      {canWrite && (
        <p className="result-references-help">
          未提交内容和待确认请求仅保留在当前页面内；收起后可继续。离开页面、切换版本或刷新页面会丢失本地请求，回来后请先重新读取链接核对，避免重复添加。
        </p>
      )}
    </section>
  );
}
