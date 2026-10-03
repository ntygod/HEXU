import { NativeContinue } from './native.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Result, Run, Scenario, Task, Tool } from '../../../packages/contracts/src/index.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Dialog, Icon, ToolMark } from '../../../packages/ui/src/index.js';
import { useApp, go, useTaskDraft } from './state.js';
import { canCreateTask } from './task-creation.js';
import './task-creation.css';
export function NewTask({ onClose, projectId }: { onClose: () => void; projectId?: string }) {
  const { data, taskCreation, notice } = useApp();
  const { view, open, close, detach, submit } = taskCreation;
  const [id] = useState(() => crypto.randomUUID());
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  const closeEntry = useCallback(() => closeCallback.current(), []);
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [project, setProject] = useState(projectId ?? '');
  useLayoutEffect(() => {
    open(id, closeEntry);
    return () => detach(id);
  }, [id, open, detach, closeEntry]);
  const pending = view.pending;
  const body = pending?.packet.body ?? { title, description, projectId: project || null };
  const busy = !!pending?.operationId;
  const editable = canCreateTask(data, body.projectId);
  useEffect(() => {
    if (view.blocked || !editable) {
      setTitle('');
      setDescription('');
      setProject('');
    }
    if (!editable && view.sessionId === id) {
      close(id);
      notice('项目当前不可编辑，已清除本次任务输入', true);
    }
  }, [editable, view.blocked, view.sessionId, id, close, notice]);
  useEffect(() => {
    if (view.sessionId !== id || !view.rejectedBody) return;
    setTitle(view.rejectedBody.title);
    setDescription(view.rejectedBody.description);
    setProject(view.rejectedBody.projectId ?? '');
  }, [id, view.sessionId, view.rejectedBody]);
  if (view.sessionId !== id || !editable) return null;
  if (view.blocked)
    return (
      <Dialog title="确认任务创建" onClose={() => close(id)}>
        <div className="dialog-body">
          <p role="alert">任务创建权限已失效，请重新查看后再创建</p>
        </div>
        <div className="dialog-footer">
          <Button onClick={() => close(id)}>关闭</Button>
        </div>
      </Dialog>
    );
  return (
    <Dialog title={pending ? '确认任务创建' : '开始一项工作'} onClose={() => close(id)}>
      <form
        className="task-creation-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(id, { title, description, projectId: project || null }, !!pending);
        }}
      >
        <div className="dialog-body">
          {!pending && (
            <p className="muted">
              一句话就可以开始，细节在工作中慢慢补充。创建只保存任务，不会启动执行。
            </p>
          )}
          {pending && (
            <section aria-label={pending.receipt ? '任务创建请求已确认' : '任务创建请求待确认'}>
              <p role="status">
                {pending.receipt
                  ? `原请求已确认创建任务 ${pending.receipt.shortId}。`
                  : busy
                    ? '原创建请求已提交，正在等待可核对的回执。'
                    : '尚未确认原创建请求是否成功，原标题、说明和项目已锁定。'}
              </p>
              <p>
                {pending.receipt
                  ? '刷新只读取已创建的任务，不会再次提交创建请求。'
                  : '确认将使用相同的原请求内容核对创建结果，不会换成新的创建请求。'}
              </p>
              <p>本次只创建任务，不启动执行。暂时关闭不会撤回请求，之后从任一创建入口继续确认。</p>
            </section>
          )}
          <label className="field">
            要做什么
            <input
              autoFocus={!pending}
              name="title"
              placeholder="例如：修复筛选条件变化后的分页"
              required
              maxLength={160}
              value={body.title}
              disabled={!!pending}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            放在哪里
            <select
              value={body.projectId ?? ''}
              disabled={!!pending}
              onChange={(e) => setProject(e.target.value)}
            >
              {pending ? (
                <option value={body.projectId ?? ''}>{pending.packet.projectName}</option>
              ) : (
                <>
                  <option value="">我的个人工作</option>
                  {data.projects
                    .filter((item) => canCreateTask(data, item.id))
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </>
              )}
            </select>
          </label>
          <label className="field">
            补充说明 <span>可选</span>
            <textarea
              rows={4}
              maxLength={12000}
              value={body.description}
              disabled={!!pending}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="背景、目标，或想先处理的部分…"
            />
          </label>
          {(pending?.error || view.error) && (
            <p className="form-error" role="alert">
              {pending?.error || view.error}
            </p>
          )}
          {!pending && (
            <p className="hint">
              <Icon name="people" size={15} />
              负责人自动设为你，不需要先填写验收表。
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <Button onClick={() => close(id)} type="button">
            {pending ? '暂时关闭' : '取消'}
          </Button>
          <Button variant="primary" type="submit" busy={busy} disabled={!body.title.trim()}>
            {!pending && <Icon name="plus" />}
            {pending ? (pending.receipt ? '刷新已创建任务' : '确认原创建结果') : '创建任务'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export function NewProject({ onClose }: { onClose: () => void }) {
  const { data, refresh, notice } = useApp();
  const [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog title="新建项目" onClose={() => !busy && onClose()}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            const project = await request<{ id: string }>(
              `/spaces/${data.space?.id ?? 'space-demo'}/projects`,
              {
                method: 'POST',
                body: { name, description },
              },
            );
            await refresh();
            onClose();
            go(`/projects/${project.id}`);
            notice('项目已创建');
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <label className="field">
            项目名称
            <input
              autoFocus
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            想实现什么 <span>可选</span>
            <textarea
              maxLength={2000}
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            创建项目
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export function ContinuePanel({
  task,
  lastRun,
  onClose,
}: {
  task: Task;
  lastRun?: Run;
  onClose: () => void;
}) {
  const { data, refresh, notice } = useApp();
  const [prompt, setPrompt] = useTaskDraft(task.id, 'mock-run');
  const [nativeMode, setNativeMode] = useState(lastRun?.provider === 'native');
  const [tool, setTool] = useState<Tool>(
      lastRun?.requestedTool === 'claude-code' ? 'codex' : 'claude-code',
    ),
    [scenario, setScenario] = useState<Scenario>('success'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (nativeMode)
    return (
      <NativeContinue
        task={task}
        lastRun={lastRun}
        onClose={onClose}
        onMock={() => setNativeMode(false)}
      />
    );
  return (
    <Dialog title="在同一任务中继续" drawer onClose={() => !busy && onClose()}>
      <form
        className="drawer-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await request(`/tasks/${task.id}/runs`, {
              method: 'POST',
              body: {
                provider: 'mock',
                requestedTool: tool,
                scenario,
                prompt,
                expectedRevision: task.revision,
                reopenTask: task.status === 'done',
              },
            });
            await refresh();
            onClose();
            setPrompt('');
            notice('已开始模拟执行；没有调用外部模型');
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <span className="eyebrow">
            {task.shortId} · {task.title}
          </span>
          <div className="notice-box">
            <Icon name="spark" />
            <div>
              <strong>交互演示 · 非真实模型</strong>
              <p>
                此模式只演示继续、等待和停止，不读取目录、不产生模型费用。需要实际工作，请明确选择原生执行。
              </p>
            </div>
          </div>
          <Button type="button" onClick={() => setNativeMode(true)}>
            <Icon name="monitor" />
            使用本机原生工具
          </Button>
          <p className="field-title">接下来使用</p>
          <div className="tool-options">
            {(['claude-code', 'codex'] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={`tool-option ${tool === value ? 'selected' : ''}`}
                aria-pressed={tool === value}
                onClick={() => setTool(value)}
              >
                <ToolMark tool={value} />
                <strong>{value === 'claude-code' ? 'Claude Code' : 'Codex'}</strong>
                <span>模拟配置</span>
                {tool === value && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
          <div className="context-card">
            <Icon name="file" />
            <div>
              <strong>同一个任务，保留工作记录</strong>
              <p>已有说明、讨论与成果仍然保留。当前只模拟执行，不迁移真实代码现场。</p>
            </div>
          </div>
          <label className="field">
            接下来做什么 <span>可选</span>
            <textarea
              rows={4}
              value={prompt}
              maxLength={12000}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="补充下一步要求…"
            />
          </label>
          <label className="field">
            演示场景
            <select value={scenario} onChange={(e) => setScenario(e.target.value as Scenario)}>
              <option value="success">正常结束</option>
              <option value="waiting_input">等待回复</option>
              <option value="waiting_approval">等待模拟授权</option>
              <option value="failure">执行失败</option>
            </select>
          </label>
          {task.status === 'done' && <p className="hint">开始后会明确重新打开这项任务。</p>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" type="submit" busy={busy}>
            <Icon name="arrow" />
            {task.status === 'done' ? '重新打开并模拟' : '开始模拟'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export function ShareResult({ task, onClose }: { task: Task; onClose: () => void }) {
  const { data, refresh, notice } = useApp();
  const [title, setTitle] = useState(task.title),
    [body, setBody] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog title="分享当前成果" onClose={() => !busy && onClose()}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            const result = await request<Result>(`/tasks/${task.id}/results`, {
              method: 'POST',
              body: { title, body },
            });
            await refresh();
            onClose();
            go(`/results/${result.id}`);
            notice('成果说明已保存，不会自动完成任务');
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <p className="muted">
            工作进行中也可以分享。当前支持文字成果，真实文件与预览隧道尚未接入。
          </p>
          <label className="field">
            成果标题
            <input
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            这次做了什么
            <textarea
              autoFocus
              required
              rows={7}
              maxLength={12000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="完成的部分、当前结果、希望同事关注的问题…"
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            <Icon name="upload" />
            分享成果
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
