export type ProjectTaskAttention = 'present' | 'absent';

export type ProjectTaskAttentionSelection =
  | { kind: 'default' }
  | { kind: 'attention'; attention: ProjectTaskAttention }
  | { kind: 'invalid' };

/** This UI selection only narrows Tasks already visible in the project. */
export function parseProjectTaskAttention(query: URLSearchParams): ProjectTaskAttentionSelection {
  const values = query.getAll('attention');
  if (!values.length) return { kind: 'default' };
  if (values.length !== 1) return { kind: 'invalid' };
  const attention = values[0];
  if (attention === 'present' || attention === 'absent') {
    return { kind: 'attention', attention };
  }
  return { kind: 'invalid' };
}

export function matchesProjectTaskAttention(
  task: { attention?: string | null },
  selection: ProjectTaskAttentionSelection,
): boolean {
  if (selection.kind === 'invalid') return false;
  if (selection.kind === 'default') return true;
  const present = !!task.attention?.trim();
  return selection.attention === 'present' ? present : !present;
}
