import { randomBytes } from 'node:crypto';
import { HttpError } from './http.js';

const hubs = new WeakMap();

// A ticket can only wait for a wake-up. A new signed device request is always
// required to learn (and subsequently confirm) the selected application.
export function tabletModeWatch(db) {
  if (hubs.has(db)) return hubs.get(db);
  const tickets = new Map(), byTablet = new Map();
  function remove(watch) {
    clearTimeout(watch.timer);
    tickets.delete(watch.ticket);
    const watches = byTablet.get(watch.tabletId);
    watches?.delete(watch);
    if (!watches?.size) byTablet.delete(watch.tabletId);
    watch.finish?.();
  }
  const hub = {
    issue(tabletId) {
      const watches = byTablet.get(tabletId) || new Set();
      if (watches.size >= 4) remove(watches.values().next().value);
      const ticket = randomBytes(32).toString('base64url');
      const watch = { tabletId, ticket, finish: null, changed: false };
      watch.timer = setTimeout(() => remove(watch), 15000).unref();
      tickets.set(ticket, watch);
      watches.add(watch);
      byTablet.set(tabletId, watches);
      return ticket;
    },
    wait(ticket, res) {
      const watch = typeof ticket === 'string' && tickets.get(ticket);
      if (!watch) throw new HttpError(403, 'TABLET_WATCH_EXPIRED', 'Reconnect to check the tablet setting.');
      tickets.delete(ticket);
      clearTimeout(watch.timer);
      if (watch.changed || res.destroyed) { remove(watch); return Promise.resolve(); }
      return new Promise(resolve => {
        const close = () => remove(watch);
        watch.finish = () => { res.off('close', close); resolve(); };
        res.once('close', close);
        watch.timer = setTimeout(close, 45000).unref();
      });
    },
    changed(tabletId) {
      for (const watch of byTablet.get(tabletId) || []) {
        watch.changed = true;
        if (watch.finish) remove(watch);
      }
    },
    listening(tabletId) {
      return [...(byTablet.get(tabletId) || [])].some(watch => watch.finish && !watch.changed);
    }
  };
  hubs.set(db, hub);
  return hub;
}
