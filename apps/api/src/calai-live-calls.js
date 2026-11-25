import {createHash} from 'node:crypto';

const CALL_COUNT_FIELDS = ['activeCalls', 'agentsInUse', 'ringing', 'queued', 'forwarding'];
const CACHE_MS = 5_000;
const MAX_SNAPSHOT_AGE_MS = 60_000;
const LIVE_READ_TIMEOUT_MS = 1_500;
const MAX_CACHED_LINKS = 512;
const snapshotsByDatabase = new WeakMap();

export function freshCalaiLiveCalls(snapshot, now) {
  if (!snapshot) return null;
  const age = now - Date.parse(snapshot.generatedAt);
  return Number.isFinite(age) && age >= -CACHE_MS && age <= MAX_SNAPSHOT_AGE_MS ? snapshot : null;
}

function project(result, now) {
  if (result?.complete !== true || typeof result.generatedAt !== 'string') return null;
  const generatedAt = Date.parse(result.generatedAt);
  if (!Number.isFinite(generatedAt)) return null;
  const counts = CALL_COUNT_FIELDS.map(field => [field, result.summary?.[field]]);
  if (!counts.every(([, count]) => Number.isSafeInteger(count) && count >= 0)) return null;
  const snapshot = { ...Object.fromEntries(counts), generatedAt: new Date(generatedAt).toISOString() };
  return freshCalaiLiveCalls(snapshot, now);
}

async function waitForLiveCalls(read, onTimeout) {
  let timer;
  try {
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        onTimeout?.();
        resolve(null);
      }, LIVE_READ_TIMEOUT_MS);
    });
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function readLiveSnapshot(adapter, accessToken, config) {
  const controller = new AbortController();
  try {
    const read = Promise.resolve().then(() => adapter.read('live', accessToken, { signal: controller.signal }));
    const result = await waitForLiveCalls(read, () => controller.abort());
    return project(result, config.now().getTime());
  } catch {
    // The optional feed cannot fail order reads or change the linked account status.
    return null;
  }
}

export function readCalaiLiveCalls(db, config, link, adapter, accessToken) {
  let cache = snapshotsByDatabase.get(db);
  if (!cache) {
    cache = new Map();
    snapshotsByDatabase.set(db, cache);
  }
  const key = createHash('sha256').update(JSON.stringify([
    link.id, link.business_id, link.provider_origin, link.source_account_id,
    link.upstream_user_id, link.encrypted_credentials,
  ])).digest('hex');
  const now = config.now().getTime();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) return { result: waitForLiveCalls(existing.published) };

  cache.delete(key);
  if (cache.size >= MAX_CACHED_LINKS) cache.delete(cache.keys().next().value);
  // Waiters only see results published after the first request revalidates the native
  // identity and connection. They independently recheck their own scope as well.
  let publish;
  const published = new Promise(resolve => { publish = resolve; });
  const entry = { published, expiresAt: now + CACHE_MS };
  cache.set(key, entry);
  return {
    result: readLiveSnapshot(adapter, accessToken, config),
    finish(dashboard) {
      if (!dashboard && cache.get(key) === entry) cache.delete(key);
      publish(dashboard?.liveCalls ?? null);
    },
  };
}
