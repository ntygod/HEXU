import type { TextMatchSnippet } from './text-match-snippet.js';
import './task-match-snippet.css';

export function AgreementBodyMatch({ snippet }: { snippet: TextMatchSnippet }) {
  return (
    <p className="task-match-snippet" aria-label="约定正文匹配片段">
      {snippet.before}
      <mark>{snippet.match}</mark>
      {snippet.after}
    </p>
  );
}
