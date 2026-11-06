// Keep scroll intent across message rendering, composer growth and phone keyboards.
export function createChatScroll({ list, latestButton, requestFrame, cancelFrame } = {}) {
  const view = list.ownerDocument?.defaultView ?? globalThis.window;
  const frame = requestFrame ?? view?.requestAnimationFrame?.bind(view) ?? (callback => setTimeout(callback, 0));
  const cancel = cancelFrame ?? view?.cancelAnimationFrame?.bind(view) ?? clearTimeout;
  let closed = false, loaded = false, following = true, settling = false, revision = 0;
  const pending = new Set(), removers = [];
  const nearLatest = () => list.scrollHeight - list.clientHeight - list.scrollTop < 70;
  const updateButton = () => { latestButton.hidden = nearLatest(); };
  const messages = () => Array.from(list.querySelectorAll?.('[data-chat-message-id]') ?? []);
  function snapshot() {
    const box = list.getBoundingClientRect?.();
    const anchor = box && messages().find(node => node.getBoundingClientRect().bottom > box.top);
    return { top: list.scrollTop, height: list.scrollHeight, follow: !loaded || following && settling || nearLatest(),
      anchor: anchor ? { id: anchor.dataset.chatMessageId, offset: anchor.getBoundingClientRect().top - box.top } : null };
  }
  function clearPending() { for (const id of pending) cancel(id); pending.clear(); }
  function afterLayout(action) {
    clearPending(); settling = true; const expectedRevision = revision;
    const schedule = remaining => {
      const id = frame(() => {
        pending.delete(id);
        if (closed || revision !== expectedRevision) return;
        action(); updateButton();
        if (remaining) schedule(remaining - 1); else settling = false;
      });
      pending.add(id);
    };
    action(); updateButton(); schedule(1);
  }
  function latest() {
    if (closed) return;
    following = true;
    afterLayout(() => { list.scrollTop = list.scrollHeight; });
  }
  function restore(before, { previous = false, forceLatest = false } = {}) {
    if (closed) return;
    loaded = true;
    if (!previous && (forceLatest || before.follow)) { latest(); return; }
    following = false;
    afterLayout(() => {
      if (before.anchor) {
        const anchor = messages().find(node => node.dataset.chatMessageId === before.anchor.id);
        if (anchor) { list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - before.anchor.offset; return; }
      }
      list.scrollTop = before.top + (previous ? list.scrollHeight - before.height : 0);
    });
  }
  function resize() { if (!closed && following) latest(); }
  function listen(target, type, callback, options) {
    target?.addEventListener?.(type, callback, options);
    removers.push(() => target?.removeEventListener?.(type, callback, options));
  }
  // Genuine user navigation cancels scheduled following before the next paint.
  function interact() { revision++; clearPending(); settling = false; following = nearLatest(); }
  listen(list, 'wheel', interact, { passive: true });
  listen(list, 'touchstart', interact, { passive: true });
  listen(list, 'pointerdown', interact, { passive: true });
  listen(list, 'keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interact(); });
  listen(list, 'scroll', () => { if (!settling) following = nearLatest(); updateButton(); }, { passive: true });
  listen(view, 'resize', resize);
  listen(view?.visualViewport, 'resize', resize);
  listen(view?.visualViewport, 'scroll', resize);
  const Observer = view?.ResizeObserver ?? globalThis.ResizeObserver;
  const observer = typeof Observer === 'function' ? new Observer(resize) : null;
  observer?.observe(list);
  return { snapshot, restore, latest, resized: resize, nearLatest, close() {
    if (closed) return; closed = true; clearPending(); observer?.disconnect(); for (const remove of removers) remove();
  } };
}
