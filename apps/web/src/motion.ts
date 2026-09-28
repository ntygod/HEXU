/** Spotlight pointer tracking: one delegated listener feeds cursor coordinates
 *  into --hx-mx/--hx-my on every element carrying .spotlight, so cards get a
 *  cursor-following glow without per-card listeners or re-renders. */
export function mountSpotlight() {
  if (matchMedia('(pointer: coarse)').matches) return () => {};
  let frame = 0;
  let last: { x: number; y: number } | null = null;
  const paint = () => {
    frame = 0;
    if (!last) return;
    const el = document.elementFromPoint(last.x, last.y)?.closest<HTMLElement>('.spotlight');
    document.querySelectorAll<HTMLElement>('.spotlight[data-lit]').forEach((node) => {
      if (node !== el) node.removeAttribute('data-lit');
    });
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--hx-mx', `${last.x - rect.left}px`);
    el.style.setProperty('--hx-my', `${last.y - rect.top}px`);
    el.setAttribute('data-lit', '');
  };
  const move = (event: PointerEvent) => {
    last = { x: event.clientX, y: event.clientY };
    if (!frame) frame = requestAnimationFrame(paint);
  };
  document.addEventListener('pointermove', move, { passive: true });
  return () => {
    document.removeEventListener('pointermove', move);
    if (frame) cancelAnimationFrame(frame);
  };
}
