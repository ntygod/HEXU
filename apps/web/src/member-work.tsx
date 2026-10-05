import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Run } from '../../../packages/contracts/src/index.js';
import { Button, Empty, Icon, RunBadge, StatusBadge } from '../../../packages/ui/src/index.js';
import { Link, useApp } from './state.js';
import { projectMemberWork, type MemberWorkTask } from './member-work-projection.js';
import './work-pages.css';
import './member-work.css';

const TASK_BATCH_SIZE = 8;

export function MemberWork({ memberId }: { memberId?: string }) {
  const { data } = useApp();
  let selectedId = memberId;
  try {
    if (memberId !== undefined) selectedId = decodeURIComponent(memberId);
  } catch {
    // A malformed URL remains an unavailable selection, never a different member.
  }
  const view = projectMemberWork(data, selectedId);
  const directoryId = useId();

  return (
    <div className="work-page member-work-page">
      <header className="work-page-heading">
        <div>
          <span className="eyebrow">{data.space?.name ?? '本地开发预览'}</span>
          <h1>成员工作</h1>
          <p>只读查看成员当前负责或明确参与的任务，从原任务打开讨论与成果。</p>
        </div>
        <Link to={memberId === undefined ? '/workbench' : '/workbench/members'} className="button">
          {memberId === undefined ? '返回工作台' : '全部成员'}
        </Link>
      </header>
      <div className="member-work-scope">
        <p>
          仅展示当前已加载且对你可见的成员与任务，不代表完整团队名册或工作记录。任务包含已完成和已取消状态。
        </p>
        {data.mode === 'local-preview' && <p>当前为本地开发预览，成员使用示例身份。</p>}
      </div>
      {view.kind === 'directory' ? (
        <section className="work-section" aria-labelledby={`${directoryId}-heading`}>
          <div className="work-section-heading">
            <h2 id={`${directoryId}-heading`}>选择成员</h2>
          </div>
          {data.members.length ? (
            <div className="member-work-directory">
              {data.members.map((member) => (
                <Link
                  key={member.id}
                  to={`/workbench/members/${encodeURIComponent(member.id)}`}
                  className="member-work-member-link"
                >
                  <span>
                    <strong>{member.name}</strong>
                    <small>{member.id}</small>
                  </span>
                  <Icon name="chevron" size={16} />
                </Link>
              ))}
            </div>
          ) : (
            <Empty title="暂无可见成员" description="当前已加载的数据中没有可选择的成员。" />
          )}
        </section>
      ) : view.kind === 'unavailable' ? (
        <Empty
          title="成员当前不可见"
          description="链接中的成员不在当前已加载的可见成员中。可返回全部成员重新选择。"
        />
      ) : (
        <>
          <div className="member-work-selected">
            <h2>{view.member.name}</h2>
            <p>{view.member.id}</p>
            <p>下列关系表示当前任务责任或参与记录；任务执行状态不表示由该成员执行。</p>
          </div>
          <MemberTaskList key={view.member.id} tasks={view.tasks} runs={data.runs} />
        </>
      )}
    </div>
  );
}

function MemberTaskList({ tasks, runs }: { tasks: MemberWorkTask[]; runs: Run[] }) {
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
      listRef.current?.querySelectorAll<HTMLAnchorElement>('a.member-work-task-row')[
        focusNewRow.current
      ];
    (row ?? headingRef.current)?.focus();
    focusNewRow.current = null;
  }, [visibleLimit, tasks.length]);

  return (
    <section className="work-section member-work-task-section" aria-labelledby={`${id}-heading`}>
      <div className="work-section-heading">
        <h2 id={`${id}-heading`} ref={headingRef} tabIndex={-1}>
          负责与参与的任务
        </h2>
      </div>
      <div id={`${id}-list`} className="member-work-task-list" ref={listRef}>
        {visibleTasks.map(({ task, responsible, participant, source }) => {
          const run = runs
            .filter((item) => item.taskId === task.id && item.purpose !== 'assist')
            .at(-1);
          return (
            <Link key={task.id} to={`/tasks/${task.id}`} className="member-work-task-row">
              <div className="member-work-task-main">
                <span className="member-work-task-id">{task.shortId}</span>
                <strong>{task.title}</strong>
                <span className="member-work-task-source">
                  {source.kind === 'personal'
                    ? '个人工作'
                    : source.kind === 'unavailable'
                      ? '项目当前不可见'
                      : source.project.name}
                  {source.kind === 'project' && source.project.archivedAt && (
                    <span className="member-work-relationship">已归档</span>
                  )}
                </span>
                {task.attention && <span className="member-work-attention">{task.attention}</span>}
              </div>
              <div className="member-work-task-labels">
                <div className="member-work-relationships" aria-label="成员与任务的关系">
                  {responsible && <span className="member-work-relationship">负责人</span>}
                  {participant && <span className="member-work-relationship">参与者</span>}
                </div>
                <StatusBadge status={task.status} />
                {run && (
                  <span className="member-work-run">
                    <span>任务最近执行</span>
                    <RunBadge run={run} />
                  </span>
                )}
              </div>
              <Icon name="chevron" size={14} />
            </Link>
          );
        })}
        {!tasks.length && (
          <p className="work-empty-text">当前可见范围内没有该成员负责或明确参与的任务。</p>
        )}
      </div>
      <div className="member-work-list-footer">
        <p id={`${id}-count`} role="status" aria-live="polite" aria-atomic="true">
          当前列表：已显示 {visibleTasks.length} / {tasks.length} 项
        </p>
        {(hasMore || canCollapse) && (
          <div className="member-work-list-actions">
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
