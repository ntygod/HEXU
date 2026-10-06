import type { TaskMatchSnippet } from './task-match-snippet.js';
import './task-match-snippet.css';

export function TaskDescriptionMatch({ snippet }: { snippet: TaskMatchSnippet }) {
  return (
    <p className="task-match-snippet" aria-label="任务说明匹配片段">
      {snippet.before}
      <mark>{snippet.match}</mark>
      {snippet.after}
    </p>
  );
}
