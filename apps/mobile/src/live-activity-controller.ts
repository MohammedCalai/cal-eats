import { eligibleLiveOrder, isLiveActivityAuthError, LIVE_ACTIVITY_LIFETIME_MS, parseLiveActivityBindings, parseLiveOrderContent, sameLiveActivityIdentity, validActivityPushToken } from "./live-activity-model.ts";
import type { LiveActivityBinding, LiveActivityFeed, LiveActivityIdentity, LiveActivityRegistration, LiveOrderContent } from "./live-activity-model.ts";
export type LiveOrderInstance = { getId(): string; update(content: LiveOrderContent, staleDate?: Date): Promise<void>; end(policy?: "immediate", content?: LiveOrderContent, contentDate?: Date): Promise<void>; getPushToken(): Promise<string | null>; addPushTokenListener(listener: (event: { activityId: string; pushToken: string }) => void): { remove(): void } };
export type LiveOrderFactory = { getInstances(): LiveOrderInstance[]; start(content: LiveOrderContent, url: string, staleDate: Date): LiveOrderInstance };
type Dependencies = {
  factory: LiveOrderFactory;
  read: () => Promise<unknown>;
  write: (rows: LiveActivityBinding[]) => Promise<void>;
  register: (identity: LiveActivityIdentity, input: { activityId: string; orderId: string; pushToken: string }) => Promise<LiveActivityRegistration>;
  unregister: (identity: LiveActivityIdentity, activityId: string) => Promise<unknown>;
  orderState: (identity: LiveActivityIdentity, orderId: string) => Promise<{ status: string; paymentEligible?: boolean }>;
  now?: () => number;
};
export function createLiveActivityController(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  let identity: LiveActivityIdentity | null = null, generation = 0, initialized = false, rows: LiveActivityBinding[] = [], queue: Promise<unknown> = Promise.resolve();
  const handles = new Map<string, LiveOrderInstance>(), subscriptions = new Map<string, { remove(): void }>(), tokens = new Map<string, string>();
  const remoteOwned = new Set<string>();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => { const task = queue.then(job, job); queue = task.catch(() => undefined); return task; };
  const valid = (scope: LiveActivityIdentity, version: number) => generation === version && sameLiveActivityIdentity(identity, scope);
  const save = async () => { rows = rows.filter(row => row.expiresAt > now()).slice(-40); await deps.write(rows); };
  const staleDate = (row: LiveActivityBinding, content?: LiveOrderContent) => new Date(Math.min(row.expiresAt, Math.max(now() + 15 * 60_000, content?.etaUnix ? content.etaUnix * 1000 + 15 * 60_000 : 0)));
  async function initialize() { if (!initialized) { rows = parseLiveActivityBindings(await deps.read(), now()); initialized = true; } }
  async function end(row: LiveActivityBinding, scope: LiveActivityIdentity | null, content?: LiveOrderContent, retainSuppression = true) {
    const id = row.activityId;
    row.suppressed = true; row.activityId = null;
    if (!id) return;
    subscriptions.get(id)?.remove(); subscriptions.delete(id); tokens.delete(id); remoteOwned.delete(id);
    const handle = handles.get(id); handles.delete(id);
    await Promise.allSettled([handle?.end("immediate", content, content ? new Date(now()) : undefined) ?? Promise.resolve(), scope && scope.userId === row.userId ? deps.unregister(scope, id) : Promise.resolve()]);
    if (!retainSuppression) rows = rows.filter(item => item !== row);
  }
  async function endAll(scope: LiveActivityIdentity | null) {
    for (const row of rows) if (row.activityId) await end(row, scope, undefined, false);
    for (const handle of deps.factory.getInstances()) await handle.end("immediate").catch(() => undefined);
    handles.clear(); for (const sub of subscriptions.values()) sub.remove(); subscriptions.clear(); tokens.clear(); remoteOwned.clear(); await save();
  }
  async function authLost(scope: LiveActivityIdentity) { if (!sameLiveActivityIdentity(identity, scope)) return; generation++; identity = null; await endAll(scope); }
  async function register(row: LiveActivityBinding, token: string, scope: LiveActivityIdentity, version: number, force = false) {
    const id = row.activityId;
    if (!id || !valid(scope, version) || row.suppressed || !validActivityPushToken(token) || !force && tokens.get(id) === token) return;
    try {
      remoteOwned.add(id); // Even a lost HTTP response may already have bound APNs.
      const result = await deps.register(scope, { activityId: id, orderId: row.orderId, pushToken: token });
      if (!valid(scope, version)) { await deps.unregister(scope, id).catch(() => undefined); return; }
      const content = parseLiveOrderContent(result.content);
      if (!content || content.orderId !== row.orderId || result.activityId !== id || !Number.isSafeInteger(result.serverRevision)) throw Error("Invalid live order registration response");
      if (!result.registered || result.action === "end" || !result.updatesEnabled) { await end(row, scope, content); await save(); return; }
      const expiry = Date.parse(String(result.expiresAt));
      if (!Number.isFinite(expiry) || expiry <= now()) { await end(row, scope, content); await save(); return; }
      // Once APNs is bound, it owns timestamped updates. The SDK's local update
      // API has no content timestamp and could otherwise overwrite a newer push.
      row.expiresAt = Math.min(expiry, row.startedAt + LIVE_ACTIVITY_LIFETIME_MS);
      tokens.set(id, token); row.serverRevision = Math.max(row.serverRevision ?? 0, result.serverRevision);
      await save();
    } catch (error) { if (isLiveActivityAuthError(error)) await authLost(scope); }
  }
  function observe(row: LiveActivityBinding, handle: LiveOrderInstance, scope: LiveActivityIdentity, version: number) {
    const id = handle.getId(); if (subscriptions.has(id)) return;
    subscriptions.set(id, handle.addPushTokenListener(event => { if (event.activityId === id && valid(scope, version)) void enqueue(() => register(row, event.pushToken, scope, version)); }));
  }
  async function enumerate(scope: LiveActivityIdentity, version: number) {
    const instances = deps.factory.getInstances(), ids = new Set(instances.map(handle => handle.getId()));
    for (const handle of instances) {
      const id = handle.getId(), row = rows.find(item => item.activityId === id && !item.suppressed && item.userId === scope.userId && item.expiresAt > now());
      if (!row) { await handle.end("immediate").catch(() => undefined); continue; }
      if (!handles.has(id)) remoteOwned.add(id); // A restored activity may have received newer pushes while JS was closed.
      handles.set(id, handle); observe(row, handle, scope, version);
    }
    // Missing means the customer or iOS ended/dismissed it. Keep suppression so
    // the next foreground poll cannot recreate the same order's activity.
    for (const row of rows) if (row.activityId && (!ids.has(row.activityId) || row.userId !== scope.userId || row.expiresAt <= now())) await end(row, scope, undefined, row.userId === scope.userId);
    await save();
  }
  function activate(next: LiveActivityIdentity | null) {
    if (sameLiveActivityIdentity(identity, next) && initialized) return queue.then(() => undefined);
    const previous = identity, version = ++generation; identity = next;
    return enqueue(async () => {
      await initialize();
      if (previous || !next) await endAll(previous);
      if (next && valid(next, version)) await enumerate(next, version);
    });
  }
  function sync(scope: LiveActivityIdentity, feed: LiveActivityFeed) {
    const version = generation;
    return enqueue(async () => {
      if (!valid(scope, version)) return;
      await initialize(); await enumerate(scope, version); if (!valid(scope, version)) return;
      if (!feed.updatesEnabled) { await endAll(scope); return; }
      const candidates = (Array.isArray(feed.items) ? feed.items : []).map(item => eligibleLiveOrder(item, now())).filter(item => item !== null);
      const byOrder = new Map(candidates.map(item => [item.orderId, item]));
      for (const row of rows.filter(item => item.activityId && !item.suppressed && item.userId === scope.userId)) {
        if (!valid(scope, version)) return;
        const id = row.activityId!, handle = handles.get(id); if (!handle) continue;
        const candidate = byOrder.get(row.orderId);
        const changed = Boolean(candidate && candidate.serverRevision > (row.serverRevision ?? 0));
        if (candidate && changed && !remoteOwned.has(id)) await handle.update(candidate.content, staleDate(row, candidate.content));
        if (!candidate) {
          try { const order = await deps.orderState(scope, row.orderId); if (!valid(scope, version)) return; if (["completed", "rejected", "cancelled", "expired"].includes(order.status) || order.paymentEligible === false) { await end(row, scope); continue; } }
          catch (error) { if (isLiveActivityAuthError(error)) { await authLost(scope); return; } if ((error as { status?: number }).status === 404) { await end(row, scope); continue; } }
        }
        const token = await handle.getPushToken().catch(() => null); if (token) await register(row, token, scope, version, changed || !candidate);
        if (candidate && valid(scope, version)) row.serverRevision = Math.max(row.serverRevision ?? 0, candidate.serverRevision);
      }
      for (const candidate of byOrder.values()) {
        if (!valid(scope, version)) return;
        if (rows.some(row => row.orderId === candidate.orderId && row.userId === scope.userId)) continue;
        const row: LiveActivityBinding = { activityId: null, orderId: candidate.orderId, userId: scope.userId, startedAt: now(), expiresAt: now() + LIVE_ACTIVITY_LIFETIME_MS, suppressed: true, serverRevision: candidate.serverRevision };
        rows.push(row); await save(); // A permission refusal is not retried every poll.
        try {
          const handle = deps.factory.start(candidate.content, `caleats://order/${candidate.orderId}`, staleDate(row, candidate.content));
          row.activityId = handle.getId(); row.suppressed = false; handles.set(row.activityId, handle); await save();
          if (!valid(scope, version)) { await end(row, scope); continue; }
          observe(row, handle, scope, version);
          const token = await handle.getPushToken(); if (token) await register(row, token, scope, version);
        } catch { /* Permission/device limits leave ordinary order notifications available. */ }
      }
      await save();
    });
  }
  return { activate, sync, stop: () => activate(null), loseAuthorization: (scope: LiveActivityIdentity) => enqueue(() => authLost(scope)) };
}
