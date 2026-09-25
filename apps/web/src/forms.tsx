import { useState } from 'react';
import type { Result, Run, Scenario, Task, Tool } from '../../../packages/contracts/src/index.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Dialog, Icon, ToolMark } from '../../../packages/ui/src/index.js';
import { useApp, go } from './state.js';
export function NewTask({ onClose, projectId }: { onClose: () => void; projectId?: string }) {
  const { data, refresh, notice } = useApp();
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [project, setProject] = useState(projectId ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog title="开始一项工作" onClose={() => !busy && onClose()}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            const task = await request<Task>('/spaces/space-demo/tasks', {
              method: 'POST',
              body: { title, description, projectId: project || null },
            });
            await refresh();
            onClose();
            go(`/tasks/${task.id}`);
            notice('任务已创建并保存');
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <p className="muted">一句话就可以开始，细节在工作中慢慢补充。</p>
          <label className="field">
            要做什么
            <input
              autoFocus
              name="title"
              placeholder="例如：修复筛选条件变化后的分页"
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            放在哪里
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">我的个人工作</option>
              {data.projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            补充说明 <span>可选</span>
            <textarea
              rows={4}
              maxLength={12000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="背景、目标，或想先处理的部分…"
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <p className="hint">
            <Icon name="people" size={15} />
            负责人自动设为你，不需要先填写验收表。
          </p>
        </div>
        <div className="dialog-footer">
          <Button onClick={onClose} type="button" disabled={busy}>
            取消
          </Button>
          <Button variant="primary" type="submit" busy={busy} disabled={!title.trim()}>
            <Icon name="plus" />
            创建任务
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export function NewProject({ onClose }: { onClose: () => void }) {
  const { refresh, notice } = useApp();
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
            const project = await request<{ id: string }>('/spaces/space-demo/projects', {
              method: 'POST',
              body: { name, description },
            });
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
  const { refresh, notice } = useApp();
  const [tool, setTool] = useState<Tool>(
      lastRun?.requestedTool === 'claude-code' ? 'codex' : 'claude-code',
    ),
    [scenario, setScenario] = useState<Scenario>('success'),
    [prompt, setPrompt] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
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
                本版本用模拟适配器展示继续、等待和停止。Claude Code 与 Codex
                尚未原生接入，不会读取你的目录或产生模型费用。
              </p>
            </div>
          </div>
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
  const { refresh, notice } = useApp();
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
export function EditTask({ task, onClose }: { task: Task; onClose: () => void }) {
  const { refresh, notice } = useApp();
  const [title, setTitle] = useState(task.title),
    [description, setDescription] = useState(task.description),
    [attention, setAttention] = useState(task.attention ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog title="编辑工作说明" onClose={() => !busy && onClose()}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await request(`/tasks/${task.id}`, {
              method: 'PATCH',
              body: {
                expectedRevision: task.revision,
                title,
                description,
                attention: attention || null,
              },
            });
            await refresh();
            onClose();
            notice('工作说明已保存');
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <label className="field">
            标题
            <input
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            说明
            <textarea
              rows={5}
              maxLength={12000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="field">
            需要关注什么 <span>可选</span>
            <input
              maxLength={300}
              value={attention}
              onChange={(e) => setAttention(e.target.value)}
              placeholder="例如：等待接口字段确认"
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
            保存修改
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
