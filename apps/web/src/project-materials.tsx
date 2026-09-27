import { useEffect, useMemo, useRef, useState } from 'react';
import type { Run, Task } from '../../../packages/contracts/src/index.js';
import {
  PROJECT_MATERIAL_ITEMS,
  parseProjectMaterialRefs,
  type ProjectMaterialBundle,
  type ProjectMaterialCandidate,
  type ProjectMaterialCatalog,
  type ProjectMaterialRef,
  type ProjectMaterialSelection,
  type ProjectMaterialSnapshot,
  type RunMaterialView,
} from '../../../packages/contracts/src/project-materials.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Icon } from '../../../packages/ui/src/index.js';
import { time, useApp, useLoad } from './state.js';
import './project-materials.css';

type Choice = ProjectMaterialCandidate & { maxChars: number };
export function useProjectMaterialSelection(task: Task) {
  const { version } = useApp();
  const [choices, setChoices] = useState<Choice[]>([]),
    [query, setQuery] = useState(''),
    [reload, setReload] = useState(0);
  const [catalog, setCatalog] = useState<ProjectMaterialCatalog | null>(null),
    [catalogError, setCatalogError] = useState(''),
    [catalogBusy, setCatalogBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<ProjectMaterialSnapshot | null>(null),
    [snapshotKey, setSnapshotKey] = useState(''),
    [error, setError] = useState(''),
    [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0),
    path = `/tasks/${encodeURIComponent(task.id)}/project-materials?q=${encodeURIComponent(query)}`;
  const refs = useMemo(
    () =>
      parseProjectMaterialRefs(
        choices.map((item) => ({
          kind: item.kind,
          id: item.id,
          revision: item.revision,
          contentHash: item.contentHash,
          maxChars: item.maxChars,
        })),
      ),
    [choices],
  );
  const selectionKey = JSON.stringify([task.id, task.projectId, refs]);
  const alive = useRef(true),
    latestSelection = useRef(selectionKey);
  latestSelection.current = selectionKey;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const current = ++generation.current,
      abort = new AbortController();
    setCatalogBusy(true);
    setCatalogError('');
    void request<ProjectMaterialCatalog>(path, { signal: abort.signal })
      .then((value) => {
        if (current === generation.current) setCatalog(value);
      })
      .catch((cause) => {
        if (current === generation.current) {
          setCatalog(null);
          setCatalogError(cause.message);
        }
      })
      .finally(() => {
        if (current === generation.current) setCatalogBusy(false);
      });
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [path, version, reload]);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    void request<ProjectMaterialSnapshot>(
      `/tasks/${encodeURIComponent(task.id)}/project-materials/preview`,
      { method: 'POST', body: { items: refs }, signal: abort.signal },
    )
      .then((value) => {
        if (!abort.signal.aborted) {
          setSnapshot(value);
          setSnapshotKey(selectionKey);
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted) {
          setSnapshot(null);
          setError(cause.message);
        }
      });
    return () => abort.abort();
  }, [selectionKey, version, reload]);
  async function more() {
    if (!catalog?.nextCursor || catalogBusy) return;
    const current = generation.current;
    setCatalogBusy(true);
    try {
      const page = await request<ProjectMaterialCatalog>(
        path + '&cursor=' + encodeURIComponent(catalog.nextCursor),
      );
      if (current === generation.current)
        setCatalog((old) =>
          old
            ? {
                ...page,
                items: [
                  ...old.items,
                  ...page.items.filter(
                    (item) =>
                      !old.items.some(
                        (existing) => existing.kind === item.kind && existing.id === item.id,
                      ),
                  ),
                ],
              }
            : page,
        );
    } catch (cause) {
      if (current === generation.current) {
        setCatalog(null);
        setCatalogError((cause as Error).message);
      }
    } finally {
      if (current === generation.current) setCatalogBusy(false);
    }
  }
  async function refreshChoices() {
    if (!task.projectId || refreshing) return;
    const scope = selectionKey;
    setRefreshing(true);
    setError('');
    try {
      const next = await Promise.all(
        choices.map(async (item) => {
          const current = await request<{
            id: string;
            revision: number;
            contentHash: string;
            title: string;
            content: string;
            url?: string | null;
            deletedAt?: string | null;
            state?: string;
          }>(
            `/projects/${encodeURIComponent(task.projectId!)}/${item.kind === 'source' ? 'sources' : 'agreements'}/${encodeURIComponent(item.id)}`,
          );
          if (current.deletedAt || (item.kind === 'agreement' && current.state !== 'active'))
            throw new Error(`“${item.title}”已不可用，请取消选择`);
          return {
            ...item,
            title: current.title,
            revision: current.revision,
            contentHash: current.contentHash,
            contentChars: current.content.length,
            excerpt: current.content.slice(0, 160),
            url: current.url ?? null,
          };
        }),
      );
      if (alive.current && scope === latestSelection.current) {
        setChoices(next);
        setReload((value) => value + 1);
      }
    } catch (cause) {
      if (alive.current && scope === latestSelection.current) setError((cause as Error).message);
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }
  const ready = !!snapshot && snapshotKey === selectionKey && !error && !refreshing;
  return {
    choices,
    query,
    setQuery,
    catalog,
    catalogError,
    catalogBusy,
    more,
    refreshing,
    refreshChoices,
    error,
    snapshot: ready ? snapshot : null,
    ready,
    selectionKey,
    selection: ready
      ? ({ items: refs, expectedHash: snapshot.hash } as ProjectMaterialSelection)
      : undefined,
    retry: () => setReload((value) => value + 1),
    toggle: (item: ProjectMaterialCandidate, selected: boolean) =>
      setChoices((old) =>
        selected
          ? old.length < PROJECT_MATERIAL_ITEMS &&
            !old.some((choice) => choice.kind === item.kind && choice.id === item.id)
            ? [...old, { ...item, maxChars: 8000 }]
            : old
          : old.filter((choice) => choice.kind !== item.kind || choice.id !== item.id),
      ),
    excerpt: (ref: ProjectMaterialRef, value: number) =>
      setChoices((old) =>
        old.map((item) =>
          item.kind === ref.kind && item.id === ref.id ? { ...item, maxChars: value } : item,
        ),
      ),
    clear: () => setChoices([]),
  };
}
export type ProjectMaterialPickerState = ReturnType<typeof useProjectMaterialSelection>;
export function ProjectMaterialPicker({
  state,
  disabled = false,
}: {
  state: ProjectMaterialPickerState;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { choices, catalog } = state;
  return (
    <section className="project-material-picker" aria-label="项目补充材料">
      <div className="project-material-heading">
        <div>
          <strong>项目补充材料 · 已选 {choices.length}</strong>
          <p>按本次需要选择资料与约定；任务说明、近期讨论仍按原执行规则准备。</p>
        </div>
        <Button
          type="button"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? '收起选材' : '选择项目材料'}
        </Button>
      </div>
      {open && (
        <div className="project-material-options">
          <label className="field">
            查找项目材料
            <input
              aria-label="查找项目材料"
              maxLength={160}
              disabled={disabled}
              value={state.query}
              onChange={(event) => state.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
              placeholder="标题或摘要…"
            />
          </label>
          {state.catalogError && (
            <p className="form-error" role="alert">
              {state.catalogError}
              <Button type="button" onClick={state.retry}>
                重读材料目录
              </Button>
            </p>
          )}
          {catalog && (
            <p className="hint">
              当前可选：{catalog.agreementCount} 条有效约定、{catalog.sourceCount}{' '}
              份资料。链接仅作引用，不读取网页。
            </p>
          )}
          {catalog?.items.map((item) => {
            const checked = choices.some(
              (choice) => choice.kind === item.kind && choice.id === item.id,
            );
            return (
              <label className="project-material-option" key={item.kind + ':' + item.id}>
                <input
                  type="checkbox"
                  aria-label={`选取${item.kind === 'agreement' ? '约定' : '资料'}：${item.title}`}
                  checked={checked}
                  disabled={disabled || (!checked && choices.length >= PROJECT_MATERIAL_ITEMS)}
                  onChange={(event) => state.toggle(item, event.target.checked)}
                />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.kind === 'agreement' ? '项目约定' : '项目资料'} · r{item.revision} · 正文{' '}
                    {item.contentChars} 字符
                  </small>
                  <p>{item.excerpt || item.url}</p>
                </span>
              </label>
            );
          })}
          {!state.catalogBusy && catalog && !catalog.items.length && (
            <p className="hint">
              没有可选的匹配材料。未关联项目的私有任务仍可使用任务说明开始工作。
            </p>
          )}
          {catalog?.nextCursor && (
            <Button type="button" busy={state.catalogBusy} onClick={() => void state.more()}>
              加载更多材料
            </Button>
          )}
        </div>
      )}
      {choices.length > 0 && (
        <div className="project-material-selected" aria-label="已选项目材料">
          {choices.map((item) => (
            <div className="project-material-selected-row" key={item.kind + ':' + item.id}>
              <div>
                <strong>{item.title}</strong>
                <small>
                  {item.kind === 'agreement' ? '约定' : '资料'} · 已选 r{item.revision}
                </small>
              </div>
              <select
                aria-label={`摘录范围：${item.title}`}
                value={item.maxChars}
                disabled={disabled}
                onChange={(event) => state.excerpt(item, Number(event.target.value))}
              >
                <option value={8000}>全文</option>
                <option value={3000}>前 3000 字符</option>
                <option value={1000}>前 1000 字符</option>
              </select>
              <Button
                type="button"
                disabled={disabled}
                aria-label={`移出材料：${item.title}`}
                onClick={() => state.toggle(item, false)}
              >
                <Icon name="close" size={14} />
              </Button>
            </div>
          ))}
          <div className="project-material-actions">
            <Button
              type="button"
              disabled={disabled}
              busy={state.refreshing}
              onClick={() => void state.refreshChoices()}
            >
              核对并采用所选材料最新版本
            </Button>
            <Button type="button" disabled={disabled} onClick={state.clear}>
              清空项目选材
            </Button>
          </div>
          <p className="hint">采用最新版本后仍须重新确认本次执行；不会自动开始。</p>
        </div>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {!state.ready && !state.error && (
        <p className="hint" role="status">
          正在核对项目材料…
        </p>
      )}
      {state.snapshot && (
        <details className="project-material-preview">
          <summary>
            查看固定版本预览 · {state.snapshot.totalChars}/{state.snapshot.limitChars} 字符
          </summary>
          {state.snapshot.items
            .filter((item) => item.omittedChars > 0 || item.redacted)
            .map((item) => (
              <p
                className="project-material-warning"
                key={item.reference.kind + ':' + item.reference.id}
              >
                {item.title}：{item.omittedChars > 0 ? `${item.omittedChars} 字符未包含；` : ''}
                {item.redacted ? '已隐藏已知敏感格式；' : ''}请核对实际选中内容。
              </p>
            ))}
          <pre>{state.snapshot.text || '本次没有补充项目资料或约定。'}</pre>
        </details>
      )}
    </section>
  );
}
function SnapshotDetails({ bundle }: { bundle: ProjectMaterialBundle }) {
  return (
    <>
      <p className="hint">
        固定于 {time(bundle.createdAt)} · {bundle.snapshot.items.length} 份项目材料
      </p>
      {bundle.snapshot.items.map((item) => (
        <p key={item.reference.kind + ':' + item.reference.id}>
          <strong>{item.title}</strong> · r{item.reference.revision}
          {item.omittedChars > 0 ? ` · ${item.omittedChars} 字符未包含` : ''}
        </p>
      ))}
      <details>
        <summary>查看当时固定的项目材料</summary>
        <pre>{bundle.snapshot.text || '本次没有补充项目资料或约定。'}</pre>
      </details>
      {bundle.contextText && (
        <details>
          <summary>查看这次执行固定的完整输入</summary>
          <pre>{bundle.contextText}</pre>
          <p className="hint">原生恢复另会继承节点保存的原历史，取消本次选材不清除历史。</p>
        </details>
      )}
    </>
  );
}
export function RunProjectMaterials({ run }: { run: Run }) {
  const { value, error } = useLoad<RunMaterialView>(`/runs/${run.id}/materials`);
  if (error)
    return (
      <p className="form-error" role="alert">
        项目选材记录读取失败：{error}
      </p>
    );
  if (!value?.bundle)
    return run.materialBundleId ? <p className="hint">正在读取项目选材记录…</p> : null;
  const labels = {
    unrecorded: '未记录项目选材',
    fixed: '材料已固定，尚无启动确认',
    started: '执行器已确认启动',
    uncertain: '启动状态待核对',
  };
  return (
    <section className="run-project-materials" aria-label="执行项目选材">
      <strong>{labels[value.state]}</strong>
      <p className="hint">
        启动记录不代表提供方已确认收到或理解材料。后续资料修改不会改写这里的快照。
      </p>
      <SnapshotDetails bundle={value.bundle} />
    </section>
  );
}
export function OperationProjectMaterials({
  taskId,
  bundleId,
}: {
  taskId: string;
  bundleId: string;
}) {
  const { value, error } = useLoad<ProjectMaterialBundle>(
    `/tasks/${taskId}/material-bundles/${bundleId}`,
  );
  return (
    <section className="run-project-materials" aria-label="接续项目选材">
      <strong>本次确认的项目材料已固定</strong>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : value ? (
        <SnapshotDetails bundle={value} />
      ) : (
        <p className="hint">正在读取材料快照…</p>
      )}
    </section>
  );
}
