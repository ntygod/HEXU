import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../packages/contracts/src/index.js';
import type {
  ProjectActivity,
  ProjectLifecycleInput,
} from '../../../packages/contracts/src/project-lifecycle.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, RunBadge } from '../../../packages/ui/src/index.js';
import { Link, useApp, useLoad } from './state.js';

type Attempt = { body: ProjectLifecycleInput; key: string };
export function ProjectLifecycle({
  project,
  disabled,
  onPending,
  onBusy,
  onClose,
}: {
  project: Project;
  disabled: boolean;
  onPending(value: boolean): void;
  onBusy(value: boolean): void;
  onClose(): void;
}) {
  const { value, error: loadError } = useLoad<ProjectActivity>(`/projects/${project.id}/activity`);
  const { data, refresh, notice } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [choice, setChoice] = useState<'' | 'keep' | 'stop'>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState<Attempt | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const save = async (attempt: Attempt) => {
    if (busy) return;
    setBusy(true);
    onBusy(true);
    onPending(true);
    setError('');
    try {
      await request<Project>(`/projects/${project.id}/lifecycle`, { method: 'POST', ...attempt });
      if (!alive.current) return;
      setUncertain(null);
      let fresh = true;
      await refresh().catch(() => {
        fresh = false;
      });
      if (!alive.current) return;
      notice(
        fresh
          ? attempt.body.action === 'archive'
            ? '项目已归档；运行状态请以实际确认为准'
            : '项目已恢复；旧执行和接续安排未自动重启'
          : '项目状态已保存，页面刷新失败，请重新加载',
        !fresh,
      );
      onPending(false);
      onClose();
    } catch (cause) {
      if (!alive.current) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setUncertain(known ? null : attempt);
      onPending(!known);
      setError(cause instanceof Error ? cause.message : '项目状态保存失败');
      await refresh().catch(() => {});
    } finally {
      if (alive.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  };
  return (
    <section className="project-lifecycle" aria-label="项目归档与恢复">
      <h3>{project.archivedAt ? '项目已归档' : '归档项目'}</h3>
      <p>
        归档不是删除。任务、讨论、成果和代码保留，成员仍按原权限协作；新的执行、原生恢复和接续安排将被阻止。
      </p>
      <p className="hint">
        所有待接续安排会暂停，尚未获启动许可的派发会取消。恢复项目不会重新派发，也不会恢复已撤销的节点权限。
      </p>
      {project.archivedAt ? (
        <>
          <p className="hint">
            归档于 {new Date(project.archivedAt).toLocaleString()}
            。已有运行仍可能在执行或等待停止确认。
          </p>
          <Button
            type="button"
            disabled={disabled || !!uncertain}
            busy={busy}
            onClick={() =>
              void save({
                body: { action: 'restore', expectedRevision: project.revision },
                key: crypto.randomUUID(),
              })
            }
          >
            恢复项目
          </Button>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            disabled={busy || !!uncertain}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '收起归档选项' : '查看归档影响'}
          </Button>
          {expanded && (
            <div className="project-archive-options">
              {value && !loadError ? (
                <>
                  <p role="status">
                    当前可见：{value.activeRuns.length} 个活动执行，{value.pendingContinuations}{' '}
                    个待接续安排。
                  </p>
                  {value.activeRuns.map((run) => (
                    <div className="project-archive-run" key={run.id}>
                      <Link to={`/tasks/${run.taskId}`}>
                        {data.tasks.find((task) => task.id === run.taskId)?.title ?? '查看任务'}
                      </Link>
                      <RunBadge run={run} />
                    </div>
                  ))}
                </>
              ) : (
                <p role={loadError ? 'alert' : 'status'}>{loadError || '正在读取归档影响…'}</p>
              )}
              {loadError && (
                <Button type="button" onClick={() => void refresh().catch(() => {})}>
                  重试读取归档影响
                </Button>
              )}
              <label className="field">
                已启动执行的处理
                <select
                  aria-label="已启动执行的处理"
                  value={choice}
                  disabled={busy || !!uncertain}
                  onChange={(event) => setChoice(event.target.value as typeof choice)}
                >
                  <option value="">请选择处理方式</option>
                  <option value="keep">保留已获许可／已启动执行</option>
                  <option value="stop">同时请求停止有操作权的执行</option>
                </select>
              </label>
              <p className="hint">
                停止请求不是终止确认；离线或未知进程会继续保留占用。所选方式作用于确认时的执行，包括此期间新启动的执行，不扩大你对私有任务的权限。
              </p>
              <Button
                type="button"
                variant="danger"
                busy={busy}
                disabled={disabled || !choice || !value || !!loadError || !!uncertain}
                onClick={() => {
                  if (choice)
                    void save({
                      body: {
                        action: 'archive',
                        expectedRevision: project.revision,
                        activeRunAction: choice,
                      },
                      key: crypto.randomUUID(),
                    });
                }}
              >
                确认归档项目
              </Button>
            </div>
          )}
        </>
      )}
      {disabled && (
        <p className="hint">请先保存或取消基本信息草稿；出现版本冲突时先处理最新版本。</p>
      )}
      {uncertain && (
        <div className="project-conflict" aria-label="项目状态结果待确认">
          <p>
            请求可能已经保存。再次确认使用原请求，不重复改变项目或停止新执行；关闭抽屉不会撤销已发送的请求。
          </p>
          <Button type="button" busy={busy} onClick={() => void save(uncertain)}>
            再次确认项目状态
          </Button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
