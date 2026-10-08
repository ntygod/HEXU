export interface FeedbackTask {
  id: string;
  shortId: string;
  projectId: string | null;
  visibility: 'private' | 'project';
}
export interface FeedbackVersion {
  id: string;
  resultId: string;
  taskId: string;
  revision: number;
  title: string;
}
export interface VersionFeedback {
  id: string;
  taskId: string;
  resultId: string | null;
  resultRevisionId?: string;
  actorName: string;
  body: string;
}

/** Only explicitly versioned feedback from this visible project Task is eligible. */
export function isFollowupFeedback(
  task: FeedbackTask,
  version: FeedbackVersion,
  message: VersionFeedback,
): boolean {
  return (
    task.visibility === 'project' &&
    !!task.projectId &&
    version.taskId === task.id &&
    message.taskId === task.id &&
    message.resultId === version.resultId &&
    message.resultRevisionId === version.id
  );
}

export function feedbackFollowupDraft(
  task: FeedbackTask,
  version: FeedbackVersion,
  message: VersionFeedback,
  origin: string,
) {
  if (!isFollowupFeedback(task, version, message)) return null;
  const versionPath = `/results/${encodeURIComponent(version.resultId)}/versions/${encodeURIComponent(version.id)}`;
  // Do not cut a surrogate pair at the existing 160 UTF-16-unit title limit.
  let title = `后续：${version.title}`.slice(0, 160);
  if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0, -1);
  return {
    title,
    projectId: task.projectId!,
    description: [
      `来源任务：${task.shortId}`,
      `成果版本：v${version.revision} · ${version.title}`,
      `固定版本：${new URL(versionPath, origin).href}`,
      `反馈：${message.actorName}（${message.id}）`,
      '',
      message.body,
    ].join('\n'),
  };
}
