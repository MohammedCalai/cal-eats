import {createHash} from 'node:crypto';
import {isSourceId} from './unified-business-calai.js';

const CALL_COUNT_FIELDS = ['activeCalls', 'agentsInUse', 'ringing', 'queued', 'forwarding'];
const CACHE_MS = 5_000;
const MAX_SNAPSHOT_AGE_MS = 60_000;
const LIVE_READ_TIMEOUT_MS = 1_500;
const PHONE_ORDER_CACHE_MS = 30_000;
const PHONE_ORDER_TIMEOUT_MS = 4_000;
const RECENT_ORDER_MS = 120_000;
const MAX_CACHED_LINKS = 512;
const snapshotsByDatabase = new WeakMap();
const ordersByDatabase = new WeakMap();
const activeStatuses = new Set(['in-progress', 'ringing', 'queued', 'forwarding']);

export function freshCalaiLiveCalls(snapshot, now, maxAgeMs = MAX_SNAPSHOT_AGE_MS) {
  if (!snapshot) return null;
  const age = now - Date.parse(snapshot.generatedAt);
  return Number.isFinite(age) && age >= -CACHE_MS && age <= maxAgeMs ? snapshot : null;
}

export function calaiLiveCallSummary(snapshot, now) {
  const fresh = freshCalaiLiveCalls(snapshot, now);
  return fresh ? { ...Object.fromEntries(CALL_COUNT_FIELDS.map(field => [field, fresh[field]])), generatedAt: fresh.generatedAt } : null;
}

function activityEvents(rows, link, kind, getTime, include, since, now, limit) {
  const events = new Map();
  for (const row of rows) {
    const time = Date.parse(getTime(row));
    const id = row?.id;
    if (typeof id !== 'string' || !id.length || id.length > 160 || !Number.isFinite(time) || time < since || time > now + CACHE_MS || !include(row)) continue;
    const key = createHash('sha256').update(JSON.stringify([link.id, kind, id])).digest('hex');
    events.set(key, { key, at: new Date(time).toISOString() });
  }
  return [...events.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

function project(result, now, link) {
  if (result?.complete !== true || typeof result.generatedAt !== 'string') return null;
  const generatedAt = Date.parse(result.generatedAt);
  if (!Number.isFinite(generatedAt)) return null;
  const counts = CALL_COUNT_FIELDS.map(field => [field, result.summary?.[field]]);
  if (!counts.every(([, count]) => Number.isSafeInteger(count) && count >= 0)) return null;
  const calls = Array.isArray(result.calls) && result.calls.length <= 10_000 ? result.calls : [];
  const events = activityEvents(calls, link, 'call', row => row?.startedAt,
    row => activeStatuses.has(row.status), 0, now, 30);
  const snapshot = { ...Object.fromEntries(counts), generatedAt: new Date(generatedAt).toISOString(), events };
  return freshCalaiLiveCalls(snapshot, now);
}

async function waitForSnapshot(read, timeoutMs, onTimeout) {
  let timer;
  try {
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        onTimeout?.();
        resolve(null);
      }, timeoutMs);
    });
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function readLiveSnapshot(adapter, accessToken, config, link) {
  const controller = new AbortController();
  try {
    const read = Promise.resolve().then(() => adapter.read('live', accessToken, { signal: controller.signal }));
    const result = await waitForSnapshot(read, LIVE_READ_TIMEOUT_MS, () => controller.abort());
    return project(result, config.now().getTime(), link);
  } catch {
    // The optional feed cannot fail order reads or change the linked account status.
    return null;
  }
}

function verifiedSnapshotRead(db, config, link, stores, { cacheMs, timeoutMs, read }) {
  let cache = stores.get(db);
  if (!cache) {
    cache = new Map();
    stores.set(db, cache);
  }
  const key = createHash('sha256').update(JSON.stringify([
    link.id, link.business_id, link.provider_origin, link.source_account_id,
    link.upstream_user_id, link.encrypted_credentials,
  ])).digest('hex');
  const now = config.now().getTime();
  const existing = cache.get(key);
  if (existing && (!existing.finished || existing.expiresAt > now)) return { result: waitForSnapshot(existing.published, timeoutMs) };

  cache.delete(key);
  if (cache.size >= MAX_CACHED_LINKS) cache.delete(cache.keys().next().value);
  // Waiters only see results published after the first request revalidates the native
  // identity and connection. They independently recheck their own scope as well.
  let publish;
  const published = new Promise(resolve => { publish = resolve; });
  const entry = { published, expiresAt: now + cacheMs, finished: false };
  cache.set(key, entry);
  return {
    result: read(),
    finish(snapshot, verified) {
      entry.finished = true;
      if (!verified && cache.get(key) === entry) cache.delete(key);
      publish(verified ? snapshot ?? null : null);
    },
  };
}

export function readCalaiLiveCalls(db, config, link, adapter, accessToken) {
  return verifiedSnapshotRead(db, config, link, snapshotsByDatabase, {
    cacheMs: CACHE_MS, timeoutMs: LIVE_READ_TIMEOUT_MS,
    read: () => readLiveSnapshot(adapter, accessToken, config, link),
  });
}

export function readCalaiPhoneOrderActivity(db, config, link, adapter, accessToken) {
  return verifiedSnapshotRead(db, config, link, ordersByDatabase, {
    cacheMs: PHONE_ORDER_CACHE_MS, timeoutMs: PHONE_ORDER_TIMEOUT_MS,
    async read() {
      const controller = new AbortController();
      try {
        const orders = await waitForSnapshot(Promise.resolve().then(() => adapter.read('orders', accessToken, { signal: controller.signal })),
          PHONE_ORDER_TIMEOUT_MS, () => controller.abort());
        if (!Array.isArray(orders)) return null;
        const now = config.now().getTime();
        return { generatedAt: new Date(now).toISOString(), events: activityEvents(orders, link, 'order',
          row => row?.createdAt, row => isSourceId(row.id), now - RECENT_ORDER_MS, now, 30) };
      } catch { return null; }
    },
  });
}
