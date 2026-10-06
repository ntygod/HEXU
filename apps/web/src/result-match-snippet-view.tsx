import type { TextMatchSnippet } from './text-match-snippet.js';
import './task-match-snippet.css';

export function ResultBodyMatch({ snippet }: { snippet: TextMatchSnippet }) {
  return (
    <p className="task-match-snippet" aria-label="成果正文匹配片段">
      {snippet.before}
      <mark>{snippet.match}</mark>
      {snippet.after}
    </p>
  );
}
