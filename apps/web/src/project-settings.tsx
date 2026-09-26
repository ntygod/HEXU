import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../packages/contracts/src/index.js';
import type {
  ProjectPatch,
  ProjectRevision,
  ProjectRevisionPage,
} from '../../../packages/contracts/src/project.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Dialog, Icon } from '../../../packages/ui/src/index.js';
import { useApp } from './state.js';
import { ProjectLifecycle } from './project-lifecycle.js';
import './project-settings.css';

type SaveAttempt = { body: ProjectPatch; key: string };

export function ProjectSettings({ project, onClose }: { project: Project; onClose(): void }) {
  const { refresh, notice } = useApp();
  // Freeze the edit baseline; an SSE refresh must never rebase an unsent draft.
  const [base, setBase] = useState(project);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [busy, setBusy] = useState(false);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState<SaveAttempt | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const changedElsewhere = project.revision !== base.revision;
  const dirty = name.trim() !== base.name || description.trim() !== base.description;

  const save = async (attempt: SaveAttempt) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await request<Project>(`/projects/${project.id}`, {
        method: 'PATCH',
        body: attempt.body,
        key: attempt.key,
      });
      if (!alive.current) return;
      setUncertain(null);
      let refreshed = true;
      await refresh().catch(() => {
        refreshed = false;
      });
      if (!alive.current) return;
      notice(refreshed ? '项目设置已保存' : '项目设置已保存，页面刷新失败，请重新加载', !refreshed);
      onClose();
    } catch (cause) {
      if (!alive.current) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setUncertain(known ? null : attempt);
      setError(cause instanceof Error ? cause.message : '项目设置保存失败');
      // Refresh permissions/latest revision, but do not change the edit baseline or draft.
      await refresh().catch(() => {});
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <Dialog title="项目设置" drawer onClose={() => !busy && !lifecycleBusy && onClose()}>
      <form
        className="drawer-form project-settings"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || lifecyclePending || uncertain || changedElsewhere || !dirty || !name.trim())
            return;
          void save({
            body: { expectedRevision: base.revision, name, description },
            key: crypto.randomUUID(),
          });
        }}
      >
        <div className="dialog-body">
          <div className="project-settings-intro">
            <span className="eyebrow">基本信息 · 修订 {base.revision}</span>
            <p>修改项目名称与目标，已有任务、成果、成员和执行目录保持不变。</p>
          </div>
          <label className="field">
            项目名称
            <input
              required
              maxLength={100}
              value={name}
              disabled={busy || !!uncertain || lifecyclePending}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            项目说明 <span>可选</span>
            <textarea
              rows={6}
              maxLength={2000}
              value={description}
              disabled={busy || !!uncertain || lifecyclePending}
              placeholder="希望解决什么问题，这个项目的目标是什么…"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <p className="hint">项目说明不会自动发送给正在运行的模型，也不会修改已确认的接续材料。</p>
          {changedElsewhere && (
            <section className="project-conflict" aria-label="项目版本冲突">
              <h3>
                <Icon name="warning" size={16} /> 项目已有新版本 · 修订 {project.revision}
              </h3>
              <p role="status">你的草稿仍然保留。请比较最新内容，再选择如何继续；不会自动覆盖。</p>
              <dl>
                <dt>最新状态</dt>
                <dd>{project.archivedAt ? '已归档' : '未归档'}</dd>
                <dt>最新名称</dt>
                <dd>{project.name}</dd>
                <dt>最新说明</dt>
                <dd>{project.description || '未填写说明'}</dd>
              </dl>
              <div className="project-settings-actions">
                <Button
                  type="button"
                  disabled={busy || !!uncertain || lifecyclePending}
                  onClick={() => {
                    setBase(project);
                    setName(project.name);
                    setDescription(project.description);
                    setError('');
                  }}
                >
                  放弃草稿，载入最新内容
                </Button>
                <Button
                  type="button"
                  disabled={busy || !!uncertain || lifecyclePending}
                  onClick={() => {
                    setBase(project);
                    setError('');
                  }}
                >
                  保留草稿，基于最新版本编辑
                </Button>
              </div>
              <p className="hint">
                保留草稿不会立即保存；再次保存将使用上方输入框中的完整名称与说明。
              </p>
            </section>
          )}
          {uncertain && (
            <section className="project-conflict" aria-label="保存结果待确认">
              <h3>尚未确认保存结果</h3>
              <p>
                请求可能已经保存。再次确认会复用原操作标识，不重复生成修订；关闭抽屉不会撤回已发送请求。
              </p>
              <Button type="button" busy={busy} onClick={() => void save(uncertain)}>
                再次确认保存结果
              </Button>
            </section>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <section className="project-history">
            <Button
              type="button"
              variant="ghost"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <Icon name="clock" size={16} /> {historyOpen ? '收起修订记录' : '查看修订记录'}
            </Button>
            {historyOpen && <ProjectHistory id={project.id} revision={project.revision} />}
          </section>
          <ProjectLifecycle
            project={project}
            disabled={busy || dirty || changedElsewhere || !!uncertain}
            onPending={setLifecyclePending}
            onBusy={setLifecycleBusy}
            onClose={onClose}
          />
          <p className="hint">仓库引用尚未接入。</p>
        </div>
        <div className="dialog-footer">
          <Button type="button" disabled={busy || lifecycleBusy} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!dirty || !name.trim() || changedElsewhere || !!uncertain || lifecyclePending}
          >
            保存项目设置
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ProjectHistory({ id, revision }: { id: string; revision: number }) {
  const [items, setItems] = useState<ProjectRevision[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController();
    setItems([]);
    setCursor(null);
    setBusy(true);
    setError('');
    request<ProjectRevisionPage>(`/projects/${id}/revisions`, { signal: abort.signal })
      .then((page) => {
        if (generation.current !== current) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((cause) => {
        if (generation.current === current) setError((cause as Error).message);
      })
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [id, revision, reload]);
  const loadMore = async () => {
    if (busy || cursor === null) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      const page = await request<ProjectRevisionPage>(`/projects/${id}/revisions?before=${cursor}`);
      if (generation.current !== current) return;
      setItems((existing) => [...existing, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (generation.current === current) setError((cause as Error).message);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  return (
    <div aria-label="项目修订记录" aria-busy={busy}>
      {items.map((item) => (
        <details key={item.revision}>
          <summary>
            修订 {item.revision} · {item.name}
          </summary>
          <p className="hint">
            {item.actorName && item.savedAt
              ? `${item.actorName} · ${new Date(item.savedAt).toLocaleString()}`
              : '已有项目快照；历史作者和保存时间未记录'}
          </p>
          <p className="hint">项目状态：{item.archivedAt ? '已归档' : '未归档'}</p>
          <p className="text-block">{item.description || '未填写说明'}</p>
        </details>
      ))}
      {busy && (
        <p className="hint" role="status">
          正在读取修订…
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {cursor !== null && (
        <Button type="button" busy={busy} onClick={() => void loadMore()}>
          加载更早修订
        </Button>
      )}
      {error && cursor === null && (
        <Button type="button" onClick={() => setReload((value) => value + 1)}>
          重试读取修订
        </Button>
      )}
    </div>
  );
}
