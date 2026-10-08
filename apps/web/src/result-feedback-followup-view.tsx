import { useState } from 'react';
import type { Message, Task } from '../../../packages/contracts/src/index.js';
import type { ResultRevision } from '../../../packages/contracts/src/results.js';
import { Button } from '../../../packages/ui/src/index.js';
import { NewTask } from './forms.js';
import { useApp, canEditTask } from './state.js';
import { canCreateTask } from './task-creation.js';
import { feedbackFollowupDraft, isFollowupFeedback } from './result-feedback-followup.js';

export function ResultFeedbackFollowup({
  task,
  version,
  messages,
}: {
  task: Task;
  version: ResultRevision;
  messages: Message[];
}) {
  const { data, taskCreation } = useApp();
  const currentTask = data.tasks.find((item) => item.id === task.id);
  const available =
    !!currentTask &&
    currentTask.visibility === 'project' &&
    currentTask.projectId === task.projectId &&
    !!currentTask.projectId &&
    canEditTask(data, currentTask) &&
    canCreateTask(data, currentTask.projectId);
  const eligible = available
    ? messages.filter((message) => isFollowupFeedback(task, version, message))
    : [];
  const [selectedId, setSelectedId] = useState('');
  const selected = eligible.find((message) => message.id === selectedId);
  const [entry, setEntry] = useState<
    | { kind: 'recover' }
    | {
        kind: 'feedback';
        message: Message;
        draft: NonNullable<ReturnType<typeof feedbackFollowupDraft>>;
      }
    | null
  >(null);
  const sourceAvailable =
    available &&
    entry?.kind === 'feedback' &&
    currentTask?.projectId === entry.draft.projectId &&
    task.id === entry.message.taskId &&
    version.id === entry.message.resultRevisionId &&
    version.resultId === entry.message.resultId &&
    eligible.some(
      (message) =>
        message.id === entry.message.id &&
        message.body === entry.message.body &&
        message.actorName === entry.message.actorName,
    );
  return (
    <section aria-label="从版本反馈建立后续任务">
      <label className="field">
        选择一条反馈继续处理
        <select
          aria-label="后续任务来源反馈"
          value={selected ? selectedId : ''}
          disabled={!available || !!entry}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          <option value="">选择此版本的反馈</option>
          {eligible.map((message) => (
            <option key={message.id} value={message.id}>
              {message.actorName}：{Array.from(message.body).slice(0, 80).join('')}
              {Array.from(message.body).length > 80 ? '…' : ''}
            </option>
          ))}
        </select>
      </label>
      <Button
        disabled={!available || !selected || !!entry}
        onClick={() => {
          if (!available || !selected || entry) return;
          // A pending ordinary create always wins. Never seed feedback into its
          // original packet or into the editable form recovered from a 4xx.
          if (taskCreation.view.pending) {
            setEntry({ kind: 'recover' });
            return;
          }
          const draft = feedbackFollowupDraft(task, version, selected, location.origin);
          if (draft) setEntry({ kind: 'feedback', message: { ...selected }, draft });
        }}
      >
        建立后续任务
      </Button>
      <p className="hint">
        {task.visibility !== 'project' || !task.projectId
          ? '当前仅支持项目可见成果；个人或私有成果暂不支持此入口。'
          : !available
            ? '需要当前项目与来源任务的编辑权限。'
            : !eligible.length
              ? '此版本还没有可转为后续任务的反馈；未指定版本的历史反馈不自动归入此版本。'
              : '将所选反馈带入同项目的新任务草稿，保留固定版本来源；确认创建后才保存。'}
      </p>
      {entry && (
        <NewTask
          onClose={() => setEntry(null)}
          source={
            entry.kind === 'feedback' ? { ...entry.draft, available: !!sourceAvailable } : undefined
          }
        />
      )}
    </section>
  );
}
