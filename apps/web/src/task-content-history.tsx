import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type {
  TaskContentHistory,
  TaskContentRevision,
} from '../../../packages/contracts/src/task-content-history.js';
import { ApiError } from '../../../packages/client/src/index.js';
import { taskContentHistory } from '../../../packages/client/src/task-content-history.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { time, useApp } from './state.js';
import './task-content-history.css';

const fields = { title: '标题', description: '说明', attention: '关注内容' };
const sources = {
  created: '创建任务',
  edited: '手工编辑',
  adopted: '明确采用内容',
  status: '状态操作清除关注',
  legacy: '已有内容快照',
};

export function TaskContentHistoryButton({ task }: { task: Task }) {
  const { data } = useApp();
  const [openScope, setOpenScope] = useState<string | null>(null);
  const scope = `${data.mode}:${data.user.id}:${data.space?.id ?? 'preview'}:${task.id}`;
  useEffect(() => setOpenScope(null), [scope]);
  // TaskPage also gates the whole workspace against its current visibility snapshot.
  if (!data.tasks.some((item) => item.id === task.id)) return null;
  return (
    <>
      <button className="text-button" onClick={() => setOpenScope(scope)}>
        工作说明历史
      </button>
      {openScope === scope && (
        <History key={scope} taskId={task.id} onClose={() => setOpenScope(null)} />
      )}
    </>
  );
}

function History({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { version } = useApp();
  const [page, setPage] = useState<TaskContentHistory | null>(null);
  const pageRef = useRef<TaskContentHistory | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newer, setNewer] = useState(false);
  const [denied, setDenied] = useState(false);
  const deniedRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const probe = useRef<AbortController | null>(null);
  const attempted = useRef<number | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  function failure(cause: unknown) {
    const blocked = cause instanceof ApiError && [401, 403, 404, 422].includes(cause.status);
    if (blocked) {
      deniedRef.current = true;
      controller.current?.abort();
      pageRef.current = null;
      setPage(null);
      setDenied(true);
      setBusy(false);
      setNewer(false);
    }
    setError(cause instanceof Error ? cause.message : '无法读取工作说明历史');
  }
  async function load(before?: number) {
    if (deniedRef.current) return;
    // An older permission probe cannot overrule a newer explicit history read.
    probe.current?.abort();
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    attempted.current = before;
    setBusy(true);
    setError('');
    try {
      const result = await taskContentHistory(taskId, before, next.signal);
      if (next.signal.aborted || deniedRef.current) return;
      const value = {
        ...result,
        items:
          before === undefined
            ? result.items
            : [...(pageRef.current?.items ?? []), ...result.items],
      };
      pageRef.current = value;
      setPage(value);
      if (before === undefined) {
        setNewer(false);
        setGeneration((value) => value + 1);
      }
    } catch (cause) {
      if (!next.signal.aborted) failure(cause);
    } finally {
      if (!next.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      controller.current?.abort();
      probe.current?.abort();
    };
  }, [taskId]);
  useEffect(() => {
    if (!pageRef.current || deniedRef.current) return;
    const check = new AbortController();
    probe.current = check;
    // Recheck current read authority on SSE without replacing the history being read.
    void taskContentHistory(taskId, undefined, check.signal, 1)
      .then((latest) => {
        if (check.signal.aborted || deniedRef.current) return;
        setNewer((latest.items[0]?.revision ?? 0) > (pageRef.current?.items[0]?.revision ?? 0));
      })
      .catch((cause: unknown) => {
        if (!check.signal.aborted) failure(cause);
      });
    return () => check.abort();
  }, [taskId, version]);
  return (
    <Dialog title="工作说明历史" drawer onClose={onClose}>
      <div className="drawer-form">
        <div className="dialog-body task-content-history">
          <p>
            保存标题、说明或关注内容的变化。任务修订还包含状态等操作，因此编号可能不连续。查看历史不会改变当前任务或执行。
          </p>
          {newer && <p role="status">有新的工作说明记录，可重新读取；当前展开内容保留。</p>}
          {denied && <p role="alert">工作说明历史已不可访问，先前内容已清除。</p>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {!denied && (
            <div className="task-content-history-actions">
              <Button disabled={busy} onClick={() => void load()}>
                重新读取历史
              </Button>
              {error && (
                <Button disabled={busy} onClick={() => void load(attempted.current)}>
                  重试历史读取
                </Button>
              )}
            </div>
          )}
          <div key={generation}>
            {page?.items.map((item, index) => (
              <Snapshot key={item.revision} item={item} first={index === 0} />
            ))}
          </div>
          {page && !page.items.length && <p>暂无已记录的工作说明历史。</p>}
          {busy && <p role="status">正在读取工作说明历史…</p>}
          {!denied && page?.nextCursor !== null && page?.nextCursor !== undefined && (
            <Button disabled={busy} onClick={() => void load(page.nextCursor!)}>
              更早的工作说明
            </Button>
          )}
        </div>
        <div className="dialog-footer">
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </Dialog>
  );
}
function Snapshot({ item, first }: { item: TaskContentRevision; first: boolean }) {
  return (
    <article className="task-content-snapshot" aria-label={`工作说明修订 ${item.revision}`}>
      <h3>
        任务修订 {item.revision} · {sources[item.source]}
      </h3>
      <p>
        {item.actorName ?? '操作者未记录'} ·{' '}
        {item.savedAt ? (
          <time dateTime={item.savedAt} title={item.savedAt}>
            {time(item.savedAt)}
          </time>
        ) : (
          '保存时间未记录'
        )}
      </p>
      {item.source === 'legacy' ? (
        <p>仅保留当时已有的内容，之前的修改过程未记录。</p>
      ) : item.changedFields.length > 0 ? (
        <p>变更：{item.changedFields.map((field) => fields[field]).join('、')}</p>
      ) : (
        <p>初始工作说明</p>
      )}
      <details open={first}>
        <summary>查看此版完整内容</summary>
        <dl>
          <dt>标题</dt>
          <dd>{item.title}</dd>
          <dt>说明</dt>
          <dd>{item.description || '（空）'}</dd>
          <dt>关注内容</dt>
          <dd>{item.attention || '（无）'}</dd>
        </dl>
      </details>
    </article>
  );
}
