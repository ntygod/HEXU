import { useState } from 'react';
import type { Run } from '../../../packages/contracts/src/index.js';
import { nextInputLabels, type NextInput } from '../../../packages/contracts/src/next-input.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Icon } from '../../../packages/ui/src/index.js';
import { useApp, useLoad, time } from './state.js';

export function NextInputPanel({
  run,
  editable,
  onContinue,
}: {
  run: Run;
  editable: boolean;
  onContinue(): void;
}) {
  const { data, refresh, notice } = useApp();
  const { value, error } = useLoad<{ items: NextInput[] }>(`/tasks/${run.taskId}/next-inputs`);
  const [body, setBody] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<NextInput | null>(null);
  const items = value?.items.filter((i) => i.taskId === run.taskId) ?? [];
  const pending = items.filter((i) => i.state === 'queued' || i.state === 'attached');
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
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="next-input-panel" aria-label="下一轮工作">
      <div className="next-input-heading">
        <div>
          <h3>
            <Icon name="message" size={17} /> 下一轮工作{' '}
            <span className="badge neutral">{pending.length} 条待处理</span>
          </h3>
          <p>先记下修改要求；当前执行不会收到或被打断。由节点所有者在接续面板明确选择后使用。</p>
        </div>
        {editable && <Button onClick={onContinue}>沿原目录继续</Button>}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <>
          {editable && (
            <form
              className="next-input-compose"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="field">
                {editing ? '编辑待选要求' : '下一轮要求'}
                <textarea
                  aria-label="下一轮要求"
                  rows={2}
                  maxLength={2000}
                  required
                  disabled={busy}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="例如：下一轮补上空状态，但保留当前交互"
                />
              </label>
              <div className="form-actions">
                {editing && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      setBody('');
                    }}
                  >
                    取消编辑
                  </Button>
                )}
                <Button type="submit" busy={busy} disabled={!body.trim()}>
                  {editing ? '保存修改' : '保存到下一轮'}
                </Button>
              </div>
            </form>
          )}
          {items.length > 0 && (
            <details open className="next-input-records">
              <summary>要求与使用记录（{items.length}）</summary>
              {items.map((item) => (
                <article key={item.id} className="next-input-item">
                  <div>
                    <strong>{item.authorName}</strong>{' '}
                    <span className="muted">{time(item.createdAt)}</span>
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
                          setBody(item.body);
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
                            await refresh();
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
            </details>
          )}
        </>
      )}
    </section>
  );
}
