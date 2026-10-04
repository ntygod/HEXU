import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import { Button, Icon } from '../../../packages/ui/src/index.js';
import { Link } from './state.js';
import { TaskRow } from './work-cards.js';
import './workbench-task-list.css';

const TASK_BATCH_SIZE = 8;

export function WorkbenchTaskList({ tasks }: { tasks: Task[] }) {
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusNewRow = useRef<number | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(TASK_BATCH_SIZE);
  const visibleTasks = tasks.slice(0, visibleLimit);
  const hasMore = visibleTasks.length < tasks.length;
  const canCollapse = visibleTasks.length > TASK_BATCH_SIZE;

  useLayoutEffect(() => {
    if (focusNewRow.current === null) return;
    const row =
      listRef.current?.querySelectorAll<HTMLAnchorElement>('a.work-task-row')[focusNewRow.current];
    (row ?? headingRef.current)?.focus();
    focusNewRow.current = null;
  }, [visibleLimit, tasks.length]);

  return (
    <section className="work-section workbench-task-section" aria-labelledby={`${id}-heading`}>
      <div className="work-section-heading">
        <h2 id={`${id}-heading`} ref={headingRef} tabIndex={-1}>
          最近任务
        </h2>
        <Link to="/projects">
          查看项目 <Icon name="chevron" size={14} />
        </Link>
      </div>
      <div className="work-task-list" id={`${id}-list`} ref={listRef}>
        {visibleTasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
        {!tasks.length && (
          <p className="work-empty-text">还没有任务。创建后，工作记录会留在这里。</p>
        )}
      </div>
      <div className="workbench-task-list-footer">
        <p id={`${id}-count`} role="status" aria-live="polite" aria-atomic="true">
          当前列表：已显示 {visibleTasks.length} / {tasks.length} 项
        </p>
        {(hasMore || canCollapse) && (
          <div className="workbench-task-list-actions">
            {hasMore && (
              <Button
                aria-controls={`${id}-list`}
                aria-describedby={`${id}-count`}
                onClick={() => {
                  focusNewRow.current = visibleTasks.length;
                  setVisibleLimit(visibleTasks.length + TASK_BATCH_SIZE);
                }}
              >
                显示更多
              </Button>
            )}
            {canCollapse && (
              <Button
                variant="ghost"
                aria-controls={`${id}-list`}
                onClick={() => {
                  headingRef.current?.focus();
                  setVisibleLimit(TASK_BATCH_SIZE);
                }}
              >
                收起
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
