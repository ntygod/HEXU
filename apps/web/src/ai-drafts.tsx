import { useEffect, useState } from 'react';
import type { Message, Task } from '../../../packages/contracts/src/index.js';
import type {
  AiDraft,
  DraftPreview,
  DraftPage,
  DraftHistory,
  DraftAdoptionPage,
} from '../../../packages/contracts/src/ai-drafts.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { canEditTask, time, useApp } from './state.js';
import { draftPath, DraftFeedback, useDraftCommand, useDraftRead } from './draft-common.js';
import { AdoptDraft } from './draft-adoption.js';
import './ai-drafts.css';

export function DraftFromMessage({ message }: { message: Message }) {
  const { data } = useApp();
  const task = data.tasks.find((t) => t.id === message.taskId);
  const allowed = !!task && canEditTask(data, task) && message.actorType === 'agent';
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!allowed) setOpen(false);
  }, [allowed]);
  if (!allowed || !task) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="draft-message-action"
        onClick={() => setOpen(true)}
      >
        整理为草稿
      </Button>
      {open && (
        <DraftDrawer task={task} sourceMessageId={message.id} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
export function TaskDrafts({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="text-button" onClick={() => setOpen(true)}>
        AI 草稿
      </button>
      {open && <DraftDrawer task={task} onClose={() => setOpen(false)} />}
    </>
  );
}
function DraftDrawer({
  task,
  sourceMessageId,
  onClose,
}: {
  task: Task;
  sourceMessageId?: string;
  onClose(): void;
}) {
  const { data } = useApp();
  const editable = canEditTask(data, task);
  const [id, setId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [source, setSource] = useState(sourceMessageId);
  return (
    <Dialog title="AI 草稿" drawer onClose={() => !busy && onClose()}>
      <div className="draft-drawer" key={editable ? 'edit' : 'read'}>
        {id ? (
          <DraftDetail
            task={task}
            id={id}
            editable={editable}
            onBusy={setBusy}
            onBack={() => setId(null)}
          />
        ) : source && editable ? (
          <DraftSource
            task={task}
            messageId={source}
            onBusy={setBusy}
            onSaved={(draft) => {
              setSource(undefined);
              setId(draft.id);
            }}
          />
        ) : (
          <DraftList task={task} onSelect={setId} />
        )}
      </div>
    </Dialog>
  );
}
function DraftFields({
  value,
  onChange,
  disabled,
}: {
  value: { title: string; content: string };
  onChange(value: { title: string; content: string }): void;
  disabled: boolean;
}) {
  return (
    <>
      <label className="field">
        草稿标题
        <input
          aria-label="草稿标题"
          required
          maxLength={120}
          disabled={disabled}
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
      </label>
      <label className="field">
        草稿正文
        <textarea
          aria-label="草稿正文"
          required
          rows={12}
          maxLength={12000}
          disabled={disabled}
          value={value.content}
          onChange={(e) => onChange({ ...value, content: e.target.value })}
        />
      </label>
    </>
  );
}
function DraftSource({
  task,
  messageId,
  onBusy,
  onSaved,
}: {
  task: Task;
  messageId: string;
  onBusy(v: boolean): void;
  onSaved(draft: AiDraft): void;
}) {
  const read = useDraftRead<DraftPreview>(`/tasks/${task.id}/messages/${messageId}/draft-preview`);
  if (!read.value || read.denied)
    return (
      <div className="dialog-body">
        <ReadProblem read={read} />
      </div>
    );
  return (
    <DraftCreate
      task={task}
      preview={read.value}
      readError={read.error}
      onRetry={read.retry}
      onBusy={onBusy}
      onSaved={onSaved}
    />
  );
}
function DraftCreate({
  task,
  preview,
  readError,
  onRetry,
  onBusy,
  onSaved,
}: {
  task: Task;
  preview: DraftPreview;
  readError: string;
  onRetry(): void;
  onBusy(v: boolean): void;
  onSaved(draft: AiDraft): void;
}) {
  const [base, setBase] = useState(preview),
    [value, setValue] = useState({ title: 'AI 建议草稿', content: preview.initialContent });
  const command = useDraftCommand<AiDraft>(onSaved, onBusy);
  const conflict = base.origin.hash !== preview.origin.hash,
    locked = command.busy || !!command.uncertain;
  if (command.denied)
    return (
      <div className="dialog-body">
        <DraftFeedback command={command} />
        <p>权限已变化，编辑内容已关闭。</p>
      </div>
    );
  return (
    <form
      className="drawer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (locked || conflict || readError || !value.content.trim() || !value.title.trim()) return;
        void command.send(
          draftPath(task.id),
          'POST',
          {
            ...value,
            sourceMessageId: base.origin.messageId,
            expectedSourceHash: base.origin.hash,
          },
          'AI 草稿已保存；尚未采用到任务或资料',
        );
      }}
    >
      <div className="dialog-body draft-content">
        <p>
          把已有回复整理成可编辑草稿。
          {task.visibility === 'private' ? '沿用当前私有任务范围。' : '当前任务的项目成员可查看。'}
          保存不会自动发布约定或发起执行。
        </p>
        <Origin draft={{ origin: base.origin }} />
        {base.contentTruncated && (
          <p className="hint">原回复较长，预填前 12000 字符；原文仍保留在讨论中。</p>
        )}
        <DraftFields value={value} onChange={setValue} disabled={locked} />
        {readError && (
          <p className="form-error" role="alert">
            {readError}；编辑内容已保留。
            <Button type="button" onClick={onRetry}>
              重读草稿来源
            </Button>
          </p>
        )}
        {conflict && (
          <section className="draft-conflict">
            <p>原回复已变化。下方是当前来源，编辑内容没有被替换。</p>
            <pre>{preview.initialContent}</pre>
            <Button type="button" disabled={locked} onClick={() => setBase(preview)}>
              核对新来源，保留我的编辑
            </Button>
          </section>
        )}
        <DraftFeedback command={command} />
      </div>
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={
            locked || conflict || !!readError || !value.content.trim() || !value.title.trim()
          }
        >
          保存 AI 草稿
        </Button>
      </div>
    </form>
  );
}
function DraftList({ task, onSelect }: { task: Task; onSelect(id: string): void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const read = useDraftRead<DraftPage>(draftPath(task.id) + (cursor ? `?cursor=${cursor}` : ''));
  return (
    <div className="dialog-body draft-content">
      <p>草稿保留 AI 来源和人工修订。采用哪些片段、放到哪里，由你决定。</p>
      {read.error && <ReadProblem read={read} />}
      {read.value?.items.map((draft) => (
        <button
          className="draft-list-item spotlight"
          key={draft.id}
          onClick={() => onSelect(draft.id)}
        >
          <strong>{draft.title}</strong>
          <span>
            r{draft.revision} · {draft.updatedByName} · {time(draft.updatedAt)}
          </span>
          <small>来源：{draft.origin.actorName}</small>
        </button>
      ))}
      {read.value && !read.value.items.length && (
        <p className="hint">还没有草稿。在 AI 回复下选择“整理为草稿”即可开始。</p>
      )}
      <div className="draft-actions">
        {cursor && <Button onClick={() => setCursor(null)}>返回草稿首页</Button>}
        {read.value?.nextCursor && (
          <Button onClick={() => setCursor(read.value!.nextCursor)}>下一页草稿</Button>
        )}
      </div>
    </div>
  );
}
function DraftDetail({
  task,
  id,
  editable,
  onBusy,
  onBack,
}: {
  task: Task;
  id: string;
  editable: boolean;
  onBusy(v: boolean): void;
  onBack(): void;
}) {
  const read = useDraftRead<AiDraft>(draftPath(task.id, id));
  if (!read.value || read.denied)
    return (
      <div className="dialog-body">
        <ReadProblem read={read} />
      </div>
    );
  return (
    <DraftEditor
      task={task}
      draft={read.value}
      readError={read.error}
      onRetry={read.retry}
      editable={editable}
      onBusy={onBusy}
      onBack={onBack}
    />
  );
}
function DraftEditor({
  task,
  draft,
  readError,
  onRetry,
  editable,
  onBusy,
  onBack,
}: {
  task: Task;
  draft: AiDraft;
  readError: string;
  onRetry(): void;
  editable: boolean;
  onBusy(v: boolean): void;
  onBack(): void;
}) {
  const [base, setBase] = useState(draft),
    [value, setValue] = useState({ title: draft.title, content: draft.content });
  const [tab, setTab] = useState<'edit' | 'adopt' | 'history'>('edit'),
    [adoptionLocked, setAdoptionLocked] = useState(false);
  const command = useDraftCommand<AiDraft>((next) => {
    setBase(next);
    setValue({ title: next.title, content: next.content });
  }, onBusy);
  const dirty = value.title !== base.title || value.content !== base.content;
  const changed = draft.revision !== base.revision,
    locked = command.busy || !!command.uncertain || adoptionLocked;
  if (command.denied)
    return (
      <div className="dialog-body">
        <DraftFeedback command={command} />
        <p>权限已变化，编辑内容已关闭。</p>
      </div>
    );
  return (
    <>
      <div className="draft-tabs">
        <Button type="button" disabled={locked} onClick={onBack}>
          草稿列表
        </Button>
        <Button
          type="button"
          disabled={locked}
          aria-pressed={tab === 'edit'}
          onClick={() => setTab('edit')}
        >
          编辑与来源
        </Button>
        {editable && (
          <Button
            type="button"
            disabled={locked || dirty || changed || !!readError}
            aria-pressed={tab === 'adopt'}
            onClick={() => setTab('adopt')}
          >
            选择片段采用
          </Button>
        )}
        <Button
          type="button"
          disabled={locked}
          aria-pressed={tab === 'history'}
          onClick={() => setTab('history')}
        >
          草稿与采用记录
        </Button>
      </div>
      {tab === 'adopt' ? (
        <AdoptDraft
          task={task}
          draft={draft}
          onBusy={onBusy}
          onLock={setAdoptionLocked}
          onAdopted={() => setTab('history')}
        />
      ) : tab === 'history' ? (
        <DraftRecords taskId={task.id} id={draft.id} />
      ) : (
        <form
          className="drawer-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (
              !editable ||
              locked ||
              changed ||
              readError ||
              !dirty ||
              !value.content.trim() ||
              !value.title.trim()
            )
              return;
            void command.send(
              draftPath(task.id, base.id),
              'PATCH',
              { ...value, expectedRevision: base.revision },
              '草稿修订已保存；已采用内容不会被改写',
            );
          }}
        >
          <div className="dialog-body draft-content">
            <p className="draft-kicker">
              AI 建议 · r{base.revision} · {base.updatedByName} · {time(base.updatedAt)}
            </p>
            <Origin draft={base} />
            {editable ? (
              <DraftFields value={value} onChange={setValue} disabled={locked} />
            ) : (
              <>
                <h3>{draft.title}</h3>
                <pre>{draft.content}</pre>
              </>
            )}
            {dirty && <p className="hint">编辑尚未保存。先保存修订，再选择需要采用的片段。</p>}
            {readError && (
              <p role="alert" className="form-error">
                {readError}；本地编辑已保留，请稍后重试。
                <Button type="button" onClick={onRetry}>
                  重读当前草稿
                </Button>
              </p>
            )}
            {changed && (
              <section className="draft-conflict" aria-label="草稿版本冲突">
                <strong>草稿已更新为 r{draft.revision}</strong>
                <p>你的编辑仍基于 r{base.revision}。核对当前版本后再决定。</p>
                <h4>{draft.title}</h4>
                <pre>{draft.content}</pre>
                <Button type="button" disabled={locked} onClick={() => setBase(draft)}>
                  以最新草稿为基线，保留我的编辑
                </Button>
                <Button
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    setBase(draft);
                    setValue({ title: draft.title, content: draft.content });
                  }}
                >
                  放弃本地编辑，读取最新草稿
                </Button>
              </section>
            )}
            <DraftFeedback command={command} />
          </div>
          {editable && (
            <div className="form-actions">
              <Button
                type="submit"
                variant="primary"
                busy={command.busy}
                disabled={
                  locked ||
                  changed ||
                  !!readError ||
                  !dirty ||
                  !value.content.trim() ||
                  !value.title.trim()
                }
              >
                保存草稿修订
              </Button>
            </div>
          )}
        </form>
      )}
    </>
  );
}
function Origin({ draft }: { draft: Pick<AiDraft, 'origin'> }) {
  return (
    <details className="draft-origin">
      <summary>
        AI 来源 · {draft.origin.actorName} · {time(draft.origin.createdAt)}
      </summary>
      <pre>{draft.origin.excerpt}</pre>
      {draft.origin.truncated && (
        <p className="hint">这是原回复节选，完整内容保留在当前任务讨论中。</p>
      )}
    </details>
  );
}
function ReadProblem({ read }: { read: { error: string; denied: boolean; retry(): void } }) {
  return read.error ? (
    <p className="form-error" role="alert">
      {read.error}
      {!read.denied && <Button onClick={read.retry}>重读草稿</Button>}
    </p>
  ) : (
    <p className="hint">正在读取草稿…</p>
  );
}
function DraftRecords({ taskId, id }: { taskId: string; id: string }) {
  const [before, setBefore] = useState<number | null>(null),
    [cursor, setCursor] = useState<string | null>(null);
  const revisions = useDraftRead<DraftHistory>(
    draftPath(taskId, id) + '/revisions' + (before ? `?before=${before}` : ''),
  );
  const adopted = useDraftRead<DraftAdoptionPage>(
    draftPath(taskId, id) + '/adoptions' + (cursor ? `?cursor=${cursor}` : ''),
  );
  return (
    <div className="dialog-body draft-content" aria-label="草稿历史与采用记录">
      <h3>采用记录</h3>
      <p className="hint">已采用内容独立保存；继续编辑草稿不会反向改写目标。</p>
      {adopted.error && <ReadProblem read={adopted} />}
      {adopted.value?.items.map((item) => (
        <details key={item.id} className="draft-record">
          <summary>
            {item.createdByName} · {item.target.title} · {item.mode === 'append' ? '追加' : '替换'}{' '}
            · {time(item.createdAt)}
          </summary>
          <p>
            草稿 r{item.draftRevision} → {item.target.kind === 'task' ? '任务说明' : '项目资料'} r
            {item.target.beforeRevision} → r{item.target.afterRevision}
          </p>
          <h4>当时采用的片段</h4>
          <pre>{item.selectedText}</pre>
          <details>
            <summary>目标变更前后</summary>
            <h4>之前</h4>
            <pre>{item.target.beforeContent || '（空）'}</pre>
            <h4>之后</h4>
            <pre>{item.target.afterContent}</pre>
          </details>
        </details>
      ))}
      {adopted.value && !adopted.value.items.length && <p className="hint">尚无采用记录。</p>}
      <div className="draft-actions">
        {cursor && <Button onClick={() => setCursor(null)}>最新采用记录</Button>}
        {adopted.value?.nextCursor && (
          <Button onClick={() => setCursor(adopted.value!.nextCursor)}>更早采用记录</Button>
        )}
      </div>
      <h3>草稿修订</h3>
      {revisions.error && <ReadProblem read={revisions} />}
      {revisions.value?.items.map((item) => (
        <details key={item.revision} className="draft-record">
          <summary>
            r{item.revision} · {item.updatedByName} · {time(item.updatedAt)}
          </summary>
          <h4>{item.title}</h4>
          <pre>{item.content}</pre>
        </details>
      ))}
      <div className="draft-actions">
        {before && <Button onClick={() => setBefore(null)}>最新草稿修订</Button>}
        {revisions.value?.nextCursor && (
          <Button onClick={() => setBefore(revisions.value!.nextCursor)}>更早草稿修订</Button>
        )}
      </div>
    </div>
  );
}
