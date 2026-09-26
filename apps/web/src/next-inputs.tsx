import { useState } from 'react';
import type { Run } from '../../../packages/contracts/src/index.js';
import { nextInputLabels, type NextInput } from '../../../packages/contracts/src/next-input.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Dialog, Empty } from '../../../packages/ui/src/index.js';
import { useApp, useLoad, useTaskDraft, time } from './state.js';

export function NextInputPanel({ run, editable }: { run: Run; editable: boolean }) {
  const { data, refresh, notice } = useApp();
  const { value, error } = useLoad<{ items: NextInput[] }>(`/tasks/${run.taskId}/next-inputs`);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<NextInput | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [body, setBody] = useTaskDraft(
    run.taskId,
    editing ? `next-input:${editing.id}` : 'next-input',
    editing?.body ?? '',
  );
  const items = value?.items.filter((item) => item.taskId === run.taskId) ?? [];
  const pending = items.filter((item) => item.state === 'queued' || item.state === 'attached');
  async function save() {
    if (busy || !body.trim()) return;
    setBusy(true);
    try {
      if (editing)
        await request(`/next-inputs/${editing.id}`, {
          method: 'PATCH',
          body: { body, expectedRevision: editing.revision },
        });
      else await request(`/runs/${run.id}/inputs`, { method: 'POST', body: { body } });
      setBody('');
      setEditing(null);
      await refresh();
      notice('已保存为下一轮要求，未发送给当前执行，也不会自动启动');
    } catch (e) {
      notice((e as Error).message, true);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="next-input-panel" aria-label="下一轮工作">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {editable ? (
        <form
          className="next-input-compose"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {editing && <p className="prompt-delivery">编辑待选要求 · v{editing.revision}</p>}
          <textarea
            aria-label="下一轮要求"
            rows={3}
            maxLength={2000}
            required
            disabled={busy}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="记下下一轮要修改什么，当前执行不会收到或被打断。"
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="next-input-toolbar">
            <button type="button" className="text-button" onClick={() => setQueueOpen(true)}>
              要求与使用记录（{items.length}）
            </button>
            <span className="spacer" />
            {editing && (
              <Button disabled={busy} onClick={() => setEditing(null)}>
                取消编辑
              </Button>
            )}
            <Button variant="primary" type="submit" busy={busy} disabled={!body.trim()}>
              {editing ? '保存修改' : '保存到下一轮'}
            </Button>
          </div>
        </form>
      ) : (
        <Button onClick={() => setQueueOpen(true)}>要求与使用记录（{items.length}）</Button>
      )}
      <p className="prompt-delivery">
        {pending.length} 条待处理 · 保存后由节点所有者在接续时明确选择，不会自动执行。
      </p>
      {queueOpen && (
        <Dialog title="下一轮要求与记录" drawer onClose={() => !busy && setQueueOpen(false)}>
          <div className="next-input-queue">
            {!items.length && (
              <Empty
                title="还没有下一轮要求"
                description="这里会显示已保存的要求，以及它们关联到哪一次执行。"
              />
            )}
            {items.map((item) => (
              <article key={item.id} className="next-input-item">
                <div>
                  <strong>{item.authorName}</strong>
                  <time>{time(item.createdAt)}</time>
                  <span className={`badge ${item.state === 'queued' ? 'amber' : 'neutral'}`}>
                    {nextInputLabels[item.state]}
                  </span>
                </div>
                <p>{item.body}</p>
                {item.targetRunId && (
                  <small>
                    关联执行：{item.targetRunId}
                    {item.state === 'started'
                      ? ' · 不代表模型已理解或完成要求'
                      : ' · 尚无启动确认；状态不明时不自动重排'}
                  </small>
                )}
                {editable && item.authorId === data.user.id && item.state === 'queued' && (
                  <div className="next-input-actions">
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setEditing(item);
                        setQueueOpen(false);
                      }}
                    >
                      编辑要求
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await request(`/next-inputs/${item.id}/cancel`, {
                            method: 'POST',
                            body: { expectedRevision: item.revision },
                          });
                          await refresh();
                        } catch (e) {
                          notice((e as Error).message, true);
                          await refresh().catch(() => {});
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      撤回要求
                    </Button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </Dialog>
      )}
    </section>
  );
}
