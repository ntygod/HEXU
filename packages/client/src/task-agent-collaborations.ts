/** Parent-Task projection; never use this endpoint as authority for a write. */
export const taskAgentCollaborationsPath = (taskId: string, cursor?: string | null) =>
  `/tasks/${encodeURIComponent(taskId)}/agent-collaborations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
