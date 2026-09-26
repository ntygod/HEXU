import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { TaskDetail } from '../../../packages/contracts/src/index.js';
import { isActiveRun } from '../../../packages/domain/src/index.js';
import { request } from '../../../packages/client/src/index.js';
import {
  Avatar,
  Button,
  Dialog,
  Empty,
  Icon,
  RunBadge,
  StatusBadge,
  ToolMark,
} from '../../../packages/ui/src/index.js';
import { Link, time, useApp, useLoad, canEditTask } from './state.js';
import { ContinuePanel, EditTask, ShareResult } from './forms.js';
import { MessageComposer, MessageList } from './discussion.js';
import { ContinuationStatus } from './continuations.js';
import { NodeContinuationStatus } from './node-continuations.js';
import { NativeCode, NativeEvents } from './native.js';
import { NodeRunPanel, NodeRunStatus } from './node-execution.js';
import { PromptBar } from './prompt-bar.js';
import { OrderPreview } from './preview.js';
import './task-workspace.css';

function readLayout(key: string): { width: number; hidden: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      width: Number.isFinite(value.width) ? Math.max(35, Math.min(70, value.width)) : 48,
      hidden: value.hidden === true,
    };
  } catch {
    return { width: 48, hidden: false };
  }
}

export function TaskPage({ id }: { id: string }) {
  const { value, error } = useLoad<TaskDetail>(`/tasks/${id}`);
  const { data, refresh, notice, changeStatus } = useApp();
  const [modal, setModal] = useState<'continue' | 'node-continue' | 'share' | 'edit' | null>(null),
    [drawer, setDrawer] = useState<'context' | 'runs' | null>(null),
    [rightTab, setRightTab] = useState('results'),
    [busy, setBusy] = useState(false);
  const [continuationSource, setContinuationSource] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const initialized = useRef(false);
  const [unread, setUnread] = useState(false);
  const preferenceKey = `hexu-task-layout:${data.mode}:${data.user.id}:${data.space?.id ?? 'preview'}`;
  const [layout, setLayout] = useState(() => readLayout(preferenceKey));
  useEffect(() => setLayout(readLayout(preferenceKey)), [preferenceKey]);
  function updateLayout(next: typeof layout) {
    setLayout(next);
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(next));
    } catch {}
  }
  useLayoutEffect(() => {
    if (!value || initialized.current) return;
    initialized.current = true;
    setRightTab(
      value.results.some((r) => r.kind === 'demo-preview')
        ? 'preview'
        : value.runs.some((r) => r.provider === 'native')
          ? 'code'
          : 'results',
    );
  }, [value]);
  useLayoutEffect(() => {
    if (!scroll.current) return;
    if (following.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    else setUnread(true);
  }, [value?.messages.length]);
  if (error)
    return (
      <Empty title="暂时无法打开任务" description={error}>
        <Button onClick={() => void refresh()}>重新加载</Button>
      </Empty>
    );
  if (!value)
    return (
      <div className="page">
        <span className="spinner" /> 正在打开任务…
      </div>
    );
  const { task, messages, runs, results } = value;
  const editable = canEditTask(data, task);
  const team = data.mode === 'team-local';
  const lastRun = runs.at(-1),
    active = runs.find((run) => isActiveRun(run.state));
  const preview = results.find((result) => result.kind === 'demo-preview');
  async function action(path: string, body: unknown = {}) {
    setBusy(true);
    try {
      await request(path, { method: 'POST', body });
      await refresh();
    } catch (error) {
      notice((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="task-page w1-task">
      <div className="task-header">
        <div className="task-title">
          <h1>{task.title}</h1>
          <StatusBadge status={task.status} />
          <button
            className="icon-button"
            aria-label="编辑工作说明"
            disabled={!editable}
            onClick={() => setModal('edit')}
          >
            <Icon name="file" size={16} />
          </button>
        </div>
        <div className="task-actions">
          {active ? (
            <Button
              variant="danger"
              busy={busy}
              disabled={
                !editable ||
                active.state === 'stopping' ||
                (active.provider !== 'node' && active.observation === 'unknown')
              }
              onClick={() => void action(`/runs/${active.id}/stop`)}
            >
              <Icon name="stop" />
              {active.observation === 'unknown'
                ? '连接未知'
                : active.state === 'stopping'
                  ? '正在停止'
                  : active.provider === 'node'
                    ? '停止节点执行'
                    : active.provider === 'native'
                      ? '停止原生执行'
                      : '停止模拟'}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => setModal('continue')}
              disabled={!editable || task.status === 'cancelled'}
              title={team ? '选择本人在本机明确授权的独立节点' : undefined}
            >
              <Icon name="play" />
              {task.status === 'done' ? '重新打开并继续' : team ? '在节点上执行' : '继续'}
              <Icon name="down" size={13} />
            </Button>
          )}
          {active?.provider === 'native' && (
            <Button
              onClick={() => setModal('continue')}
              disabled={!editable || task.status === 'cancelled'}
              title={team ? '选择本人在本机明确授权的独立节点' : undefined}
            >
              <Icon name="arrow-right" />
              准备接续
            </Button>
          )}
          <Button disabled={!editable} onClick={() => setModal('share')}>
            <Icon name="upload" />
            分享成果
          </Button>
          {task.status === 'done' ? (
            <Button disabled={!editable} onClick={() => void changeStatus(task, 'todo')}>
              <Icon name="back" size={16} />
              重新打开
            </Button>
          ) : (
            <Button disabled={!editable} onClick={() => void changeStatus(task, 'done')}>
              <Icon name="check" size={16} />
              标记完成
            </Button>
          )}
        </div>
        <div className="w1-task-scope">
          <span>{task.shortId}</span>
          <span>{task.visibility === 'private' ? '仅自己可见' : '项目成员可见'}</span>
          <Avatar
            user={data.members.find((member) => member.id === task.ownerUserId)}
            size="small"
          />
          <span>
            负责人：
            {data.members.find((member) => member.id === task.ownerUserId)?.name ??
              (task.ownerUserId === data.user.id ? data.user.name : '未提供')}
          </span>
          <span className="spacer" />
          <button className="text-button" onClick={() => setDrawer('context')}>
            工作说明
          </button>
        </div>
      </div>
      <div className="w1-run-bar" aria-label="当前执行">
        {lastRun ? (
          <>
            <ToolMark tool={lastRun.requestedTool} />
            <strong>{lastRun.requestedTool === 'codex' ? 'Codex' : 'Claude Code'}</strong>
            <span>
              {lastRun.provider === 'node'
                ? '独立节点'
                : lastRun.provider === 'native'
                  ? '本机原生'
                  : '模拟执行'}
            </span>
            {(lastRun.node?.model || lastRun.native?.model) && (
              <span>配置模型：{lastRun.node?.model ?? lastRun.native?.model}</span>
            )}
            <RunBadge run={lastRun} />
            <span className="w1-code-location">
              <Icon name="folder" size={14} />
              {lastRun.node
                ? `${lastRun.node.nodeName} / ${lastRun.node.workingCopyName}`
                : lastRun.native
                  ? '本机授权目录 · 实际变更见代码面板'
                  : '未连接真实代码目录'}
            </span>
          </>
        ) : (
          <>
            <Icon name="monitor" size={16} />
            <span>还没有执行 · 可以先讨论，再选择工具开始</span>
          </>
        )}
      </div>
      <div className="w1-workspace-toolbar">
        <span>
          <Icon name="message" size={15} /> 过程与讨论
        </span>
        <button className="text-button" onClick={() => setDrawer('context')}>
          上下文
        </button>
        <button className="text-button" onClick={() => setDrawer('runs')}>
          执行记录 <span className="count">{runs.length}</span>
        </button>
        <span className="spacer" />
        <details className="w1-layout-options">
          <summary>布局</summary>
          <label>
            讨论区宽度 <output>{layout.width}%</output>
            <input
              aria-label="讨论面板宽度"
              type="range"
              min="35"
              max="70"
              value={layout.width}
              onChange={(e) => updateLayout({ ...layout, width: Number(e.target.value) })}
            />
          </label>
        </details>
        <button
          className="icon-button"
          aria-label={layout.hidden ? '展开成果面板' : '收起成果面板'}
          aria-expanded={!layout.hidden}
          onClick={() => updateLayout({ ...layout, hidden: !layout.hidden })}
        >
          <Icon name="panel" size={16} />
        </button>
      </div>
      <div
        className={`task-grid w1-task-grid ${layout.hidden ? 'output-hidden' : ''}`}
        style={{ '--discussion-width': `${layout.width}%` } as CSSProperties}
      >
        <section className="collaboration-panel" aria-label="过程与讨论">
          <>
            <div
              className="messages-scroll"
              ref={scroll}
              tabIndex={0}
              aria-label="任务讨论记录"
              onScroll={() => {
                const el = scroll.current;
                if (!el) return;
                following.current = el.scrollHeight - el.clientHeight - el.scrollTop < 64;
                if (following.current) setUnread(false);
              }}
            >
              {team ? (
                <NodeContinuationStatus
                  key={id}
                  taskId={id}
                  editable={editable}
                  onConfigure={() => {
                    if (lastRun?.provider === 'node') {
                      setContinuationSource(lastRun.id);
                      setModal('node-continue');
                    }
                  }}
                />
              ) : (
                <ContinuationStatus key={id} taskId={id} onConfigure={() => setModal('continue')} />
              )}
              {lastRun?.provider === 'node' && <NodeRunStatus run={lastRun} />}
              <MessageList messages={messages} />
              {lastRun?.provider === 'native' && <NativeEvents run={lastRun} />}
              {!messages.length && (
                <Empty
                  title="从这里展开工作"
                  description="补充说明，记录想法。评论会真实保存到本地。"
                />
              )}
              {active?.state === 'waiting_input' && (
                <div className="waiting-panel">
                  <strong>
                    <Icon name="chat" size={16} />
                    模拟执行等待你的回复
                  </strong>
                  <MessageComposer taskId={id} run={active} />
                </div>
              )}
              {active?.state === 'waiting_approval' && (
                <div className="waiting-panel">
                  <strong>
                    <Icon name="warning" size={16} />
                    模拟授权请求
                  </strong>
                  <p>只演示允许与拒绝的反馈，不执行命令。</p>
                  <div className="flex-line">
                    <Button
                      busy={busy}
                      onClick={() =>
                        void action(`/runs/${active.id}/authorization`, { decision: 'deny' })
                      }
                    >
                      拒绝
                    </Button>
                    <Button
                      variant="primary"
                      busy={busy}
                      onClick={() =>
                        void action(`/runs/${active.id}/authorization`, { decision: 'allow' })
                      }
                    >
                      允许模拟
                    </Button>
                  </div>
                </div>
              )}
            </div>
            {unread && (
              <Button
                className="w1-new-messages"
                onClick={() => {
                  following.current = true;
                  if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
                  setUnread(false);
                }}
              >
                有新记录 · 回到最新
              </Button>
            )}
            <div className="task-prompt-slot">
              {task.attention && (
                <div className="context-banner">
                  <Icon name="chat" size={14} />
                  <span>{task.attention}</span>
                  <button disabled={!editable} onClick={() => setModal('edit')}>
                    编辑
                  </button>
                </div>
              )}
              <PromptBar
                task={task}
                run={lastRun}
                editable={editable}
                onConfigure={() => setModal('continue')}
                onContinue={() => {
                  if (lastRun?.provider === 'node') {
                    setContinuationSource(lastRun.id);
                    setModal('node-continue');
                  }
                }}
              />
            </div>
          </>
        </section>
        <section className="output-panel" aria-label="代码与成果" hidden={layout.hidden}>
          <div className="workspace-tabs">
            {[
              ['preview', '预览'],
              ['code', '代码变更'],
              ['results', '成果'],
            ].map(([key, label]) => (
              <button
                key={key}
                className={rightTab === key ? 'selected' : ''}
                onClick={() => setRightTab(key!)}
              >
                {label}
              </button>
            ))}
          </div>
          {rightTab === 'preview' ? (
            preview ? (
              <OrderPreview />
            ) : (
              <Empty
                title="成果会出现在这里"
                description="当前任务没有示例预览。可以先分享一份文字成果。"
              >
                <Button disabled={!editable} onClick={() => setModal('share')}>
                  分享成果
                </Button>
              </Empty>
            )
          ) : rightTab === 'code' ? (
            lastRun?.provider === 'node' ? (
              <Empty
                title="代码保留在节点目录"
                description="本轮尚未同步独立节点 diff；请在本机查看修改。模型输出位于左侧协作记录。"
              />
            ) : (
              <NativeCode run={runs.filter((run) => run.provider === 'native').at(-1)} />
            )
          ) : (
            <div className="task-results">
              {results.map((result) => (
                <article className="w1-task-result" key={result.id}>
                  <div className="eyebrow">
                    {result.kind === 'demo-preview' ? '示例预览' : '已保存成果'} · v
                    {result.revision} · {time(result.updatedAt)}
                  </div>
                  <h2>{result.title}</h2>
                  <p className="text-block">{result.body}</p>
                  <Link className="button secondary" to={`/results/${result.id}`}>
                    查看与反馈 <Icon name="arrow-right" size={14} />
                  </Link>
                </article>
              ))}
              {!results.length && (
                <Empty title="还没有分享成果">
                  <Button disabled={!editable} onClick={() => setModal('share')}>
                    写一份成果说明
                  </Button>
                </Empty>
              )}
            </div>
          )}
          <div className="output-footer">
            <div>
              <strong>{results[0]?.title ?? '把工作进展分享出来'}</strong>
              <p>
                {results[0]
                  ? '成果可以在任务进行中查看和讨论。'
                  : '没有报告，也可以按团队方式完成任务。'}
              </p>
            </div>
          </div>
        </section>
      </div>
      {drawer === 'context' && (
        <Dialog title="任务上下文" drawer onClose={() => setDrawer(null)}>
          <div className="context-view">
            <span className="eyebrow">本次工作说明</span>
            <h3>{task.title}</h3>
            <p className="text-block">{task.description || '暂无补充说明，可以直接编辑。'}</p>
            <Button disabled={!editable} onClick={() => setModal('edit')}>
              编辑说明
            </Button>
            <hr />
            <h3>当前可用上下文</h3>
            <p>任务说明、已保存的讨论，以及文字成果。</p>
            <div className="notice-box">
              <Icon name="file" />
              <p>
                原生执行使用任务说明、本次要求和最近工作记录；发送前可在继续面板查看。仓库由原生文件工具按需读取，模拟输出不会作为真实工作记录发送。
              </p>
            </div>
          </div>
        </Dialog>
      )}
      {drawer === 'runs' && (
        <Dialog title="执行记录" drawer onClose={() => setDrawer(null)}>
          <div className="runs-list">
            {runs.map((run) => (
              <div className="run-card" key={run.id}>
                <div className="flex-line">
                  <ToolMark tool={run.requestedTool} />
                  <strong>
                    {run.requestedTool === 'codex' ? 'Codex' : 'Claude Code'} ·{' '}
                    {run.provider === 'node'
                      ? '独立节点'
                      : run.provider === 'native'
                        ? '原生'
                        : '模拟'}
                  </strong>
                  <span className="spacer" />
                  <RunBadge run={run} />
                </div>
                <p>{run.prompt || '未补充要求'}</p>
                <small>
                  {time(run.createdAt)} · {run.previousRunId ? '关联此前执行' : '首次执行'}
                </small>
              </div>
            ))}
            {!runs.length && (
              <Empty
                title="还没有执行记录"
                description={
                  team
                    ? '可在本人已授权节点执行；配对本身不授予执行权限。'
                    : '可以用模拟适配器体验执行过程。'
                }
              />
            )}
          </div>
        </Dialog>
      )}
      {modal === 'continue' &&
        (team ? (
          <NodeRunPanel task={task} onClose={() => setModal(null)} />
        ) : (
          <ContinuePanel task={task} lastRun={lastRun} onClose={() => setModal(null)} />
        ))}{' '}
      {modal === 'node-continue' &&
        continuationSource &&
        runs.some((r) => r.id === continuationSource && r.provider === 'node') && (
          <NodeRunPanel
            key={continuationSource}
            task={task}
            source={runs.find((r) => r.id === continuationSource)!}
            onClose={() => setModal(null)}
          />
        )}
      {modal === 'share' && <ShareResult task={task} onClose={() => setModal(null)} />}{' '}
      {modal === 'edit' && <EditTask task={task} onClose={() => setModal(null)} />}
    </div>
  );
}
