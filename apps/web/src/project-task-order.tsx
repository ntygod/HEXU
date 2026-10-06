import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import { Button } from '../../../packages/ui/src/index.js';
import { projectMoveAnchors } from './project-task-order-model.js';
import type { ProjectOrderBaseline, ProjectTaskOrderState } from './project-task-order-state.js';
import './project-task-order.css';

type Selection = {
  taskId: string;
  base: ProjectOrderBaseline;
  scope: string;
  anchorIds: string[];
};
type MoveFocus = {
  button: HTMLButtonElement;
  key: string;
  scope: string;
  interaction: number;
};

export function useProjectOrderControls(
  order: ProjectTaskOrderState,
  tasks: readonly Task[],
  view: string,
) {
  const [menu, setMenu] = useState<Selection | null>(null);
  const [anchorId, setAnchorId] = useState('');
  const [placement, setPlacement] = useState<'before' | 'after'>('before');
  const [drag, setDrag] = useState<Selection | null>(null);
  const dragRef = useRef<Selection | null>(null);
  const [over, setOver] = useState<{ taskId: string; placement: 'before' | 'after' } | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const moveFocus = useRef<MoveFocus | null>(null);
  const ready = order.open && order.ready && !order.pending && order.canOrder;
  useEffect(() => {
    const focusChanged = (event: FocusEvent) => {
      if (
        moveFocus.current &&
        event.target !== moveFocus.current.button &&
        event.target !== document.body &&
        event.target !== document.documentElement
      )
        moveFocus.current = null;
    };
    const pointerChanged = (event: PointerEvent) => {
      if (moveFocus.current && !moveFocus.current.button.contains(event.target as Node | null))
        moveFocus.current = null;
    };
    const tabbedAway = (event: KeyboardEvent) => {
      if (event.key === 'Tab') moveFocus.current = null;
    };
    document.addEventListener('focusin', focusChanged);
    document.addEventListener('pointerdown', pointerChanged, true);
    document.addEventListener('keydown', tabbedAway, true);
    return () => {
      document.removeEventListener('focusin', focusChanged);
      document.removeEventListener('pointerdown', pointerChanged, true);
      document.removeEventListener('keydown', tabbedAway, true);
    };
  }, []);
  useEffect(() => {
    moveFocus.current = null;
  }, [order.open, order.scope, order.interaction]);
  useLayoutEffect(() => {
    const intent = moveFocus.current;
    if (!intent || intent.key !== order.completedKey) return;
    moveFocus.current = null;
    if (
      ready &&
      intent.scope === order.scope &&
      intent.interaction === order.interaction &&
      intent.button.isConnected &&
      !intent.button.disabled &&
      (document.activeElement === document.body || document.activeElement === intent.button)
    )
      intent.button.focus({ preventScroll: true });
  }, [order.completedKey, order.scope, order.interaction, ready]);
  function move(
    task: Task,
    anchor: Task,
    placement: 'before' | 'after',
    button: HTMLButtonElement | null,
    base?: ProjectOrderBaseline,
  ) {
    const focused = button && document.activeElement === button;
    const key = order.move(task, anchor, placement, base);
    moveFocus.current =
      focused && key ? { button, key, scope: order.scope, interaction: order.interaction } : null;
  }
  function clearDrag() {
    dragRef.current = null;
    setDrag(null);
    setOver(null);
  }
  useEffect(() => {
    setMenu(null);
    clearDrag();
  }, [order.open, order.scope]);
  useEffect(() => {
    if (order.pending) {
      setMenu(null);
      clearDrag();
    }
  }, [order.pending?.key]);
  useEffect(() => {
    if (!order.canOrder) {
      setMenu(null);
      clearDrag();
    }
  }, [order.canOrder]);
  const editSignature = JSON.stringify(order.editableIds);
  useEffect(() => {
    if (menu && !order.editableIds.includes(menu.taskId)) setMenu(null);
    if (dragRef.current && !order.editableIds.includes(dragRef.current.taskId)) clearDrag();
  }, [editSignature, menu]);
  function select(task: Task): Selection | null {
    if (
      !ready ||
      !order.base ||
      !order.editableIds.includes(task.id) ||
      task.status === 'cancelled'
    )
      return null;
    const anchors = projectMoveAnchors(tasks, task, view);
    if (!anchors.length) return null;
    return {
      taskId: task.id,
      base: { ...order.base },
      scope: order.scope,
      anchorIds: anchors.map((anchor) => anchor.id),
    };
  }
  function target(task: Task) {
    function destination(event: DragEvent<HTMLElement>) {
      const selected = dragRef.current;
      if (
        !ready ||
        !selected ||
        selected.scope !== order.scope ||
        !selected.anchorIds.includes(task.id)
      )
        return null;
      const moved = tasks.find((item) => item.id === selected.taskId);
      if (!moved || !projectMoveAnchors(tasks, moved, view).some((item) => item.id === task.id))
        return null;
      const bounds = event.currentTarget.getBoundingClientRect();
      return {
        moved,
        selected,
        placement:
          event.clientY < bounds.top + bounds.height / 2 ? ('before' as const) : ('after' as const),
      };
    }
    return {
      'data-task-id': task.id,
      'data-order-drop': over?.taskId === task.id ? over.placement : undefined,
      onDragOver(event: DragEvent<HTMLElement>) {
        const next = destination(event);
        if (!next) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver({ taskId: task.id, placement: next.placement });
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        const next = destination(event);
        if (!next) return;
        event.preventDefault();
        clearDrag();
        order.move(next.moved, task, next.placement, next.selected.base);
      },
    };
  }
  return {
    order,
    tasks,
    view,
    ready,
    move,
    menu: menu?.scope === order.scope && order.open ? menu : null,
    anchorId,
    setAnchorId,
    placement,
    setPlacement,
    dragging: !!drag && drag.scope === order.scope,
    target,
    openMenu(task: Task, button: HTMLButtonElement) {
      const selected = select(task);
      if (!selected) return;
      opener.current = button;
      setMenu(selected);
      setAnchorId(selected.anchorIds[0]!);
      setPlacement('before');
    },
    closeMenu() {
      setMenu(null);
      opener.current?.focus();
    },
    applyMenu() {
      if (!menu || menu.scope !== order.scope || !ready) return;
      const task = tasks.find((item) => item.id === menu.taskId);
      const anchor = tasks.find((item) => item.id === anchorId);
      if (
        !task ||
        !anchor ||
        !menu.anchorIds.includes(anchor.id) ||
        !projectMoveAnchors(tasks, task, view).some((item) => item.id === anchor.id)
      )
        return;
      setMenu(null);
      opener.current?.focus();
      move(task, anchor, placement, opener.current, menu.base);
    },
    startDrag(task: Task, event: DragEvent<HTMLButtonElement>) {
      const selected = select(task);
      if (!selected) {
        event.preventDefault();
        return;
      }
      setMenu(null);
      dragRef.current = selected;
      setDrag(selected);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', task.id);
    },
    clearDrag,
  };
}
type Controls = ReturnType<typeof useProjectOrderControls>;

export function ProjectTaskOrderPanel({ controls }: { controls: Controls }) {
  const { order, menu } = controls;
  const select = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (menu) {
      select.current?.focus();
      select.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [menu?.taskId]);
  const task = menu ? controls.tasks.find((item) => item.id === menu.taskId) : null;
  const anchors = task ? projectMoveAnchors(controls.tasks, task, controls.view) : [];
  const pending = order.pending;
  // An ordinary read failure blocks submission, not the still-current unsent selection.
  const menuInteractive =
    !!menu &&
    !!task &&
    order.displayable &&
    order.canOrder &&
    order.editableIds.includes(task.id) &&
    task.status !== 'cancelled' &&
    !pending &&
    anchors.length === menu.anchorIds.length &&
    anchors.every((anchor) => menu.anchorIds.includes(anchor.id));
  return (
    <section className="project-task-order" aria-label="项目任务排序">
      <div className="project-task-order-heading">
        <div>
          <strong>项目任务顺序</strong>
          <span className="hint">
            {order.base ? `排序修订 ${order.base.expectedRevision}` : '正在核对当前顺序'}
          </span>
        </div>
        <Button aria-pressed={order.open} disabled={!order.canOrder} onClick={order.toggle}>
          {order.open ? '关闭排序' : '整理顺序'}
        </Button>
      </div>
      {order.loading && <p role="status">正在读取当前任务顺序…</p>}
      {order.error && (
        <div className="project-task-order-notice" role="alert">
          <p>读取任务顺序失败：{order.error}</p>
          {order.displayable && <p>显示上次已读取的顺序；恢复读取后才能继续移动。</p>}
          <Button disabled={order.loading} onClick={() => void order.load()}>
            重试读取顺序
          </Button>
        </div>
      )}
      {order.open && (
        <>
          <p className="hint">
            拖动手柄到任务的上半部或下半部，或使用上移、下移与更多排序。
            {controls.view === 'board' ? '看板仅支持同列调整。' : ''}
            筛选隐藏的任务保留彼此顺序，已取消任务只读。
          </p>
          {order.message && (
            <p className="project-task-order-notice" role="status">
              {order.message}
            </p>
          )}
          {pending && (
            <div className="project-task-order-notice" role="status">
              <strong>
                {pending.phase === 'accepted'
                  ? '上次排序已保存，等待读取最新顺序'
                  : pending.phase === 'sending'
                    ? '正在确认排序…'
                    : '上次排序结果待确认'}
              </strong>
              <p>
                {pending.taskLabel} → {pending.anchorLabel}{' '}
                {pending.body.placement === 'before' ? '之前' : '之后'}
              </p>
              <p className="hint">
                {pending.phase === 'accepted'
                  ? '只重新读取顺序，不会再次提交移动。'
                  : '结果确认前暂停其他移动；再次确认使用上次的原请求。关闭排序不会撤回操作。'}
              </p>
              {pending.phase !== 'sending' && (
                <Button disabled={order.loading} onClick={order.retry}>
                  {pending.phase === 'accepted' ? '读取最新顺序' : '确认上次排序'}
                </Button>
              )}
            </div>
          )}
          {menu && task && (
            <form
              className="project-task-order-menu"
              aria-label="移动任务"
              onSubmit={(event) => {
                event.preventDefault();
                if (menuInteractive) controls.applyMenu();
              }}
            >
              <strong>
                {task.shortId} · {task.title}
              </strong>
              <div className="project-task-order-fields">
                <div className="field">
                  <label htmlFor="project-order-anchor">移动到任务</label>
                  <select
                    ref={select}
                    id="project-order-anchor"
                    aria-label="移动到任务"
                    value={controls.anchorId}
                    disabled={!menuInteractive}
                    onChange={(event) => controls.setAnchorId(event.target.value)}
                  >
                    {anchors
                      .filter((anchor) => menu.anchorIds.includes(anchor.id))
                      .map((anchor) => (
                        <option key={anchor.id} value={anchor.id}>
                          {anchor.shortId} · {anchor.title}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="project-order-placement">相对位置</label>
                  <select
                    id="project-order-placement"
                    aria-label="相对位置"
                    value={controls.placement}
                    disabled={!menuInteractive}
                    onChange={(event) =>
                      controls.setPlacement(event.target.value as 'before' | 'after')
                    }
                  >
                    <option value="before">之前</option>
                    <option value="after">之后</option>
                  </select>
                </div>
              </div>
              <div className="project-task-order-buttons">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    !controls.ready ||
                    !menuInteractive ||
                    !anchors.some((anchor) => anchor.id === controls.anchorId)
                  }
                >
                  应用移动
                </Button>
                <Button type="button" onClick={controls.closeMenu}>
                  取消选择
                </Button>
              </div>
            </form>
          )}
          <p className="hint">
            未确认请求仅保留在当前项目页面内存中；硬刷新或离开项目后需重新核对顺序。
          </p>
        </>
      )}
    </section>
  );
}

export function ProjectTaskOrderActions({ task, controls }: { task: Task; controls: Controls }) {
  const { order, ready, tasks, view } = controls;
  if (!order.open || task.status === 'cancelled') return null;
  const group = tasks.filter(
    (item) => item.status !== 'cancelled' && (view !== 'board' || item.status === task.status),
  );
  const index = group.findIndex((item) => item.id === task.id);
  const previous = group[index - 1];
  const next = group[index + 1];
  const enabled = ready && order.editableIds.includes(task.id);
  return (
    <div className="project-task-order-actions" aria-label={`${task.shortId} 排序操作`}>
      <button
        type="button"
        className="project-task-order-handle"
        aria-label={`拖动 ${task.shortId}`}
        title="拖动排序；键盘可使用上移、下移或更多排序"
        draggable={enabled && group.length > 1}
        disabled={!enabled || group.length < 2}
        onDragStart={(event) => controls.startDrag(task, event)}
        onDragEnd={controls.clearDrag}
      >
        拖动
      </button>
      <button
        type="button"
        aria-label={`上移 ${task.shortId}`}
        disabled={!enabled || !previous}
        onClick={(event) =>
          previous && controls.move(task, previous, 'before', event.currentTarget)
        }
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={`下移 ${task.shortId}`}
        disabled={!enabled || !next}
        onClick={(event) => next && controls.move(task, next, 'after', event.currentTarget)}
      >
        ↓
      </button>
      <button
        type="button"
        aria-label={`更多排序 ${task.shortId}`}
        aria-expanded={controls.menu?.taskId === task.id}
        disabled={!enabled || group.length < 2}
        onClick={(event) => controls.openMenu(task, event.currentTarget)}
      >
        更多
      </button>
    </div>
  );
}
