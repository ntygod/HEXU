/** Read-only textareas can scroll rather than move a caret in Chromium.
 * Keep the saved text immutable while providing explicit keyboard selection. */
export interface DraftTextSelection {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
}
export interface DraftSelectionKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}
export function moveDraftSelection(
  text: string,
  current: DraftTextSelection,
  key: DraftSelectionKey,
): DraftTextSelection | null {
  const horizontal = key.key === 'ArrowLeft' || key.key === 'ArrowRight';
  const edge = key.key === 'Home' || key.key === 'End';
  if (
    key.isComposing ||
    key.altKey ||
    (!horizontal && !edge) ||
    (horizontal && (key.ctrlKey || key.metaKey))
  )
    return null; // Preserve copy, select-all, Tab, Escape and browser/OS shortcuts.
  const anchor = current.direction === 'backward' ? current.end : current.start;
  const focus = current.direction === 'backward' ? current.start : current.end;
  let next: number;
  if (horizontal) {
    if (!key.shiftKey && current.start !== current.end)
      next = key.key === 'ArrowLeft' ? current.start : current.end;
    else {
      // Use grapheme boundaries, not UTF-16 +/-1: do not split emoji or combining text.
      const boundaries = [
        ...Array.from(
          new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
          (part) => part.index,
        ),
        text.length,
      ];
      next =
        key.key === 'ArrowLeft'
          ? (boundaries
              .slice()
              .reverse()
              .find((offset) => offset < focus) ?? 0)
          : (boundaries.find((offset) => offset > focus) ?? text.length);
    }
  } else if (key.ctrlKey || key.metaKey) next = key.key === 'Home' ? 0 : text.length;
  else if (key.key === 'Home') next = focus === 0 ? 0 : text.lastIndexOf('\n', focus - 1) + 1;
  else {
    const end = text.indexOf('\n', focus);
    next = end < 0 ? text.length : end;
  }
  return key.shiftKey
    ? {
        start: Math.min(anchor, next),
        end: Math.max(anchor, next),
        direction: next < anchor ? 'backward' : 'forward',
      }
    : { start: next, end: next, direction: 'none' };
}

/** HTML textarea.value normalizes CRLF/CR to LF. Adoption offsets refer to the
 * original saved revision, so map the browser's offsets without rewriting it. */
export function savedDraftRange(content: string, start: number, end: number) {
  const offset = (position: number) => {
    let source = 0;
    for (let visible = 0; visible < position && source < content.length; visible++) {
      source += content[source] === '\r' && content[source + 1] === '\n' ? 2 : 1;
    }
    return source;
  };
  return { start: offset(start), end: offset(end) };
}
