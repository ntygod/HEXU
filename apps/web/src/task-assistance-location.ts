import { useEffect, useState } from 'react';

/** A Task-local URL projection, not another request or workflow state. */
export function useTaskAssistanceLocation(taskId: string) {
  const read = () => {
    if (location.pathname !== `/tasks/${encodeURIComponent(taskId)}`) return null;
    return new URLSearchParams(location.search).get('assistance');
  };
  const [selected, setSelected] = useState(read);
  useEffect(() => {
    const update = () => setSelected(read());
    update();
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, [taskId]);
  function open(id: string) {
    if (read() === id) return;
    const url = new URL(location.href);
    url.searchParams.set('assistance', id);
    history.pushState({ ...history.state }, '', `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  function close() {
    const url = new URL(location.href);
    url.searchParams.delete('assistance');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  return { selected, open, close };
}
