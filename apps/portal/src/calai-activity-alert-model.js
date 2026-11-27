const eventKey = /^[a-f0-9]{64}$/;
const recentMs = 120_000;

function observe(previous, snapshot) {
  const at = Date.parse(snapshot?.generatedAt);
  if (!Number.isFinite(at) || !Array.isArray(snapshot?.events) || snapshot.events.length > 30 || at < (previous?.checkedAt ?? 0)) {
    return { state: previous, fresh: 0, current: 0 };
  }
  if (at === previous?.checkedAt) return { state: previous, fresh: 0, current: previous.current };

  const seen = new Map([...(previous?.seen ?? [])].filter(([, time]) => time >= at - recentMs));
  const baseline = previous?.baseline ?? at;
  const current = new Set();
  let fresh = 0;
  for (const event of snapshot.events) {
    const time = Date.parse(event?.at), key = event?.key;
    if (typeof key !== "string" || !eventKey.test(key) || !Number.isFinite(time) || time > at + 5_000 || current.has(key)) continue;
    current.add(key);
    if (previous && !seen.has(key) && time > baseline && time >= at - recentMs) fresh++;
    if (time >= at - recentMs) seen.set(key, time);
  }
  return { state: { checkedAt: at, baseline, seen, current: current.size }, fresh, current: current.size };
}

export function observeCalaiActivity(previous, payload, businessId) {
  const scoped = payload?.businessId === businessId ? payload : null;
  const calls = observe(previous?.calls, scoped?.calls);
  const orders = observe(previous?.orders, scoped?.phoneOrders);
  return {
    state: { calls: calls.state, orders: orders.state },
    currentCalls: calls.current,
    newCalls: calls.fresh,
    newOrders: orders.fresh,
  };
}
