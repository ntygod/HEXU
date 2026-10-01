import { useEffect, useState } from 'react';
import type { Run, Task } from '../../../packages/contracts/src/index.js';
import {
  RESULT_TASK_ACTIVITY_PAGE_SIZE,
  summarizeResultTaskActivity,
} from '../../../packages/domain/src/result-task-activity.js';
import { Button, RunBadge } from '../../../packages/ui/src/index.js';
import { time } from './state.js';
import './result-task-activity.css';

const providerLabels: Record<Run['provider'], string> = {
  mock: '模拟执行',
  native: '本机原生',
  node: '节点执行',
};

export function ResultTaskActivity({
  taskId,
  currentTask,
  runs,
  connected,
}: {
  taskId: string;
  currentTask?: Task;
  runs: readonly Run[];
  connected: boolean;
}) {
  const [requestedPage, setRequestedPage] = useState(1);
  const activity = summarizeResultTaskActivity(taskId, currentTask ? runs : [], requestedPage);
  // Clamp on the same render as a smaller snapshot, then persist that position
  // so a later refresh cannot unexpectedly jump back to a formerly valid page.
  useEffect(() => setRequestedPage(activity.page), [activity.page]);
  return (
    <section className="result-task-activity" aria-label="任务当前执行">
      <header className="result-task-activity-heading">
        <h2>任务当前执行</h2>
        <p>任务完成与执行结束分别记录；正在停止不代表已停止。</p>
      </header>
      {!connected && (
        <p className="result-task-activity-notice" role="status">
          连接未就绪 · 下面保留上次读取的任务与执行快照，可能已变化。
        </p>
      )}
      {!currentTask ? (
        <p className="result-task-activity-notice" role="status">
          当前任务状态不可用，无法确认当前执行摘要。请返回任务核对。
        </p>
      ) : (
        <>
          <p className="result-task-activity-counts">
            共 {activity.total} 项 · 连接未知 {activity.unknown} 项 · 正在停止 {activity.stopping}{' '}
            项 · 其他活动 {activity.otherActive} 项
          </p>
          <p className="result-task-activity-description">
            来自最近读取的任务快照，包含普通、方案与 AI
            协助执行，不随所查看的成果版本或来源执行切换。
          </p>
          {activity.total ? (
            <ul className="result-task-activity-list" aria-label="活动或连接未知的执行">
              {activity.rows.map((run) => (
                <li className="result-task-activity-row" data-run-id={run.id} key={run.id}>
                  <div className="result-task-activity-identity">
                    <strong>执行 {run.id}</strong>
                    <RunBadge run={run} />
                  </div>
                  <div className="result-task-activity-meta">
                    <span>{run.requestedTool === 'claude-code' ? 'Claude Code' : 'Codex'}</span>
                    <span>{providerLabels[run.provider]}</span>
                    <span>
                      {run.purpose === 'assist'
                        ? 'AI 协助'
                        : run.node?.workBranch
                          ? `方案执行 · ${run.node.workBranch.branchId}`
                          : '普通执行'}
                    </span>
                    <span>
                      创建于 <time dateTime={run.createdAt}>{time(run.createdAt)}</time>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="result-task-activity-empty">本次读取没有活动或连接未知的执行记录。</p>
          )}
          {activity.pageCount > 1 && (
            <nav className="result-task-activity-pagination" aria-label="任务执行分页">
              <Button
                disabled={activity.page === 1}
                onClick={() => setRequestedPage(activity.page - 1)}
              >
                上一页
              </Button>
              <span>
                第 {activity.page} / {activity.pageCount} 页 · 每页最多{' '}
                {RESULT_TASK_ACTIVITY_PAGE_SIZE} 项
              </span>
              <Button
                disabled={activity.page === activity.pageCount}
                onClick={() => setRequestedPage(activity.page + 1)}
              >
                下一页
              </Button>
            </nav>
          )}
          <p className="result-task-activity-description">
            这里只汇总已读取记录，不作为所有进程已停止的确认。
          </p>
        </>
      )}
    </section>
  );
}
